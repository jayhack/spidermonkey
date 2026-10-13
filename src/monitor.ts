import { execFile } from 'node:child_process';
import type { Workspace } from './workspace.js';
import type { HarnessEvent } from './types.js';

// Always-on System 1 monitors. Each monitor watches some part of the environment
// (tool results, edits, background commands, processes), asks the decision model
// typed questions about what it observes, and hands findings to the controller.
// The controller delivers findings on the executive's next tool result; Eve cannot
// accept text in the middle of a model call. Monitors never edit workspace files.

export type Severity = 'info' | 'warn' | 'error';

export interface Finding {
  monitor: string;
  /** Dedup key: a finding with a key already delivered is dropped. */
  key: string;
  severity: Severity;
  /** One line the executive reads first. Observed facts, never invented reasoning. */
  summary: string;
  /** Bounded observed evidence: command output, source lines, diff hunks. */
  evidence?: string;
  /** Edit revision the finding describes, so the executive can ignore stale reports. */
  editRevision: number;
  /** Native decision-model probability behind the finding, when one gated it. */
  probability?: number;
}

export type Question =
  | { type: 'boolean'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type Answer = { type: string; probability?: number; choice?: string; probabilities?: Record<string, number>; score?: number };

/** Raw decision-model call: one shared state, independent typed questions. */
export type S1Evaluate = (state: unknown, questions: Record<string, Question>, signal: AbortSignal) =>
  Promise<{ answers: Record<string, Answer>; inputTokens: number; costUsd?: number }>;

export interface ToolEvent {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  /** Edit revision after this tool ran. */
  editRevision: number;
  /** Workspace paths the executive wrote in this call. */
  edited: string[];
}

export interface CommandResult { exitCode: number; output: string; durationMs: number; timedOut: boolean }

/**
 * A tool call the executive is blocked on (today: `run_checks`). Eve cannot take input
 * mid-call, so while it runs only System 1 is watching. A monitor may interrupt it: the
 * harness stops the command's process group and returns the partial output together
 * with the finding that justified stopping it. Interrupts are recorded as events.
 */
export interface BlockingCall {
  name: string;
  command: string;
  startedAt: number;
  editRevision: number;
  pid(): number | undefined;
  /** Bounded tail of the call's live output. */
  output(): string;
  lastOutputAt(): number;
  /** Aborted when the call ends, however it ends. */
  readonly signal: AbortSignal;
  /** Stop the call now; the finding is delivered with its result. No-op once ended. */
  interrupt(finding: Finding): void;
}

export interface MonitorContext {
  workspace: Workspace;
  task(): string;
  editRevision(): number;
  /** Wall-clock time of the executive's latest edit, or 0 before any edit. */
  lastEditAt(): number;
  /** Accounted decision-model call; `purpose` labels usage events. */
  evaluate(purpose: string, state: unknown, questions: Record<string, Question>, signal?: AbortSignal): Promise<Record<string, Answer>>;
  /** Harness command runner: workspace cwd, scrubbed credentials, bounded output. */
  run(command: string, options?: { timeoutMs?: number; signal?: AbortSignal; maxOutput?: number }): Promise<CommandResult>;
  /** Read a workspace file through the confined reader, authorizing a later edit. */
  read(path: string): Promise<{ path: string; content: string; version: string }>;
  emit(kind: string, message: string, data?: Record<string, unknown>): void;
  signal: AbortSignal;
}

export interface Monitor {
  readonly name: string;
  /** Answer a tool call without running it, e.g. a check already run for this revision. */
  intercept?(name: string, input: Record<string, unknown>): Promise<unknown | undefined>;
  /** Rewrite a tool result before the executive sees it (attention, automatic dives). */
  transform?(event: ToolEvent): Promise<unknown | undefined>;
  /** Observe every executive tool call; may start background work. */
  afterTool?(event: ToolEvent): void | Promise<void>;
  /** The executive is now blocked on this call; watch it and interrupt if warranted. */
  blocking?(call: BlockingCall): void;
  /** Periodic observation while the executive works. */
  tick?(): void | Promise<void>;
  /** Resolve when in-flight work that could produce a finding has settled. */
  settle?(): Promise<void>;
  /** Findings ready for delivery. */
  drain(): Finding[];
  /** The executive's observable conversation: prompts, messages, tool calls and results. */
  observe?(event: HarnessEvent): void;
  /** At turn end: a follow-up prompt for the executive if an unresolved problem remains. */
  finalGate?(answer: string): Promise<string | undefined>;
  stop?(): Promise<void>;
}

export type MonitorFactory = (config: Record<string, unknown>, context: MonitorContext) => Monitor;

export function runCommand(root: string, command: string, options: { timeoutMs?: number; signal?: AbortSignal; maxOutput?: number } = {}) {
  const started = performance.now();
  return new Promise<CommandResult>(done => {
    const child = execFile('/bin/sh', ['-c', command], {
      cwd: root, timeout: options.timeoutMs ?? 120_000, maxBuffer: 2_000_000, signal: options.signal, killSignal: 'SIGKILL',
      // Monitors do not need model credentials or the tool bridge token.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|API_KEY|PASSWORD|ROS_BRIDGE/.test(key))),
    }, (error, stdout, stderr) => {
      const timedOut = Boolean(error && (error as { killed?: boolean }).killed);
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      done({ exitCode: code, output: (stdout + stderr).slice(-(options.maxOutput ?? 12_000)), durationMs: Math.round(performance.now() - started), timedOut });
    });
    child.stdin?.end();
  });
}

/** Deliverable text for findings: compact, newest first, observed evidence only. */
export function formatFindings(findings: Finding[]) {
  return findings.map(finding => ({
    monitor: finding.monitor, severity: finding.severity, editRevision: finding.editRevision,
    summary: finding.summary, ...(finding.probability === undefined ? {} : { probability: Number(finding.probability.toFixed(2)) }),
    ...(finding.evidence ? { evidence: finding.evidence } : {}),
  }));
}
