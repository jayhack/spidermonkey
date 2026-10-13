import { join, resolve } from 'node:path';
import type { BlockingCall, Finding, Monitor, MonitorFactory, S1Evaluate, ToolEvent } from '../monitor.js';
import type { HarnessEvent } from '../types.js';
import { Daemon } from '../spidermonkey/daemon.js';
import type { Entity, FeedItem, Finding as MonkeyFinding, Priority } from '../spidermonkey/core.js';
import { priorities } from '../spidermonkey/core.js';

// Spidermonkey inside the harness: the executive's always-on System 1.
// - Every executive message, tool call and result is fed to Spidermonkey as the agent trace.
// - Processes the executive starts are registered with their logs, so they are watched natively.
// - Findings ride on the executive's next tool result (the controller's system1 channel); an
//   urgent finding while the executive is blocked in a command stops that command early.
// - The `spidermonkey` tool lets the executive register watches and read status.
//
// { "intervalMs": 2000, "callsPerMinute": 20, "appraiser": "system1" | "all", "home"?: state directory (default: <workspace>/.spidermonkey) }

const describe = (item: FeedItem) => item.type === 'finding' ? `${item.finding.mode === 'interrupt' ? 'INTERRUPT' : 'notify'} · ${item.finding.text}`
  : item.type === 'attention' ? `${item.to === null ? 'dropped' : priorities[item.to]} · ${item.label} — ${item.reason}`
  : item.type === 'dismissed' ? `noticed · ${item.text}` : item.type === 'declined' ? `ignored · ${item.label} — ${item.why}`
  : item.type === 'appraisal' ? `appraised ${item.events} event(s), ${item.candidates} candidate(s) in ${item.latencyMs} ms` : item.message;

export const spidermonkeyMonitor: MonitorFactory = (raw, context) => {
  const config = { intervalMs: 2000, callsPerMinute: 20, appraiser: 'system1', ...raw } as { intervalMs: number; callsPerMinute: number; appraiser: 'system1' | 'all'; home?: string };
  const root = context.workspace.root;
  // Accounting happens in the controller: every call is a System 1 frame with its cost.
  const evaluate: S1Evaluate = async (state, questions, signal) => ({ answers: await context.evaluate('spidermonkey', state, questions, signal), inputTokens: 0 });
  const daemon = new Daemon({ home: config.home ?? join(root, '.spidermonkey'), cwd: root, intervalMs: config.intervalMs, audience: 'agent', task: context.task(),
    callsPerMinute: config.callsPerMinute, appraiser: config.appraiser, evaluate });
  let blocked: BlockingCall | undefined;
  daemon.monkey.on(item => {
    context.emit(`spidermonkey:${item.type}`, describe(item), { item });
    // An urgent finding while the executive waits on a command: stop the wait, say why.
    if (item.type === 'finding' && item.finding.mode === 'interrupt' && blocked && !blocked.signal.aborted) {
      item.finding.delivered = true;
      blocked.interrupt(toFinding(item.finding, context.editRevision()));
    }
  });
  const started = daemon.start({ serve: true });
  let task = '';

  const toFinding = (finding: MonkeyFinding, editRevision: number): Finding => ({
    monitor: 'spidermonkey', key: `spidermonkey:${finding.id}`, severity: finding.severity, editRevision, probability: finding.probability,
    summary: `${finding.mode === 'interrupt' ? 'INTERRUPT · ' : ''}${finding.text}`, ...(finding.evidence ? { evidence: finding.evidence } : {}),
  });

  const register = (input: Record<string, unknown>) => {
    const priority = Math.max(1, priorities.indexOf(String(input.priority ?? 'watch') as typeof priorities[number])) as Priority;
    const reason = typeof input.reason === 'string' ? `registered by the agent: ${input.reason}` : 'registered by the agent';
    const entity: Omit<Entity, 'since' | 'source'> | undefined =
      typeof input.command === 'string' ? { id: `command:${String(input.name ?? input.command.split(/\s+/).slice(0, 2).join(' '))}`, kind: 'command', label: String(input.name ?? input.command), priority, reason,
        spec: { command: input.command, everySeconds: Math.max(5, Number(input.everySeconds ?? 20)) } }
      : typeof input.file === 'string' ? { id: `file:${resolve(root, input.file)}`, kind: 'file', label: input.file, priority, reason, spec: { path: resolve(root, input.file) } }
      : input.port !== undefined ? { id: `port:${Number(input.port)}`, kind: 'port', label: `:${Number(input.port)}`, priority, reason }
      : typeof input.app === 'string' ? { id: `app:${input.app}`, kind: 'app', label: input.app, priority, reason }
      : undefined;
    if (!entity) throw new Error('watch needs one of command, file, port or app');
    return daemon.monkey.register({ ...entity, source: 'registered' });
  };

  return {
    name: 'spidermonkey',
    observe(event: HarnessEvent) {
      if (event.lane === 'executive' && event.kind === 'prompt') {
        if (task !== event.message) { task = event.message; daemon.monkey.setTask(task); }
        daemon.monkey.ingest({ at: Date.now(), kind: 'prompt', text: event.message });
      } else if (event.lane === 'executive' && event.kind === 'message' && !event.data?.streaming && event.message) {
        daemon.monkey.ingest({ at: Date.now(), kind: 'message', text: event.message });
      } else if (event.lane === 'executive' && event.kind === 'tool') {
        const data = event.data ?? {};
        daemon.monkey.ingest({ at: Date.now(), kind: 'tool', text: `${String(data.toolName ?? event.message)}${data.path ? ` ${String(data.path)}` : ''}${data.command ? ` $ ${String(data.command)}` : ''}${data.processName ? ` (${String(data.processName)})` : ''}` });
      } else if (event.lane === 'environment' && event.kind === 'result') {
        daemon.monkey.ingest({ at: Date.now(), kind: 'result', text: event.message.slice(0, 300) });
      }
    },
    async intercept(name, input) {
      if (name !== 'spidermonkey') return undefined;
      await started;
      const action = String(input.action ?? 'status');
      if (action === 'watch') return { watching: register(input) };
      if (action === 'unwatch') return { ok: daemon.monkey.unregister(String(input.id), 'unregistered by the agent') };
      if (action === 'findings') return { findings: daemon.monkey.drain().map(finding => toFinding(finding, context.editRevision())) };
      const status = daemon.monkey.status();
      return { watching: status.entities.map(entity => ({ id: entity.id, label: entity.label, priority: priorities[entity.priority], source: entity.source, reason: entity.reason })),
        undeliveredFindings: status.undelivered };
    },
    afterTool(event: ToolEvent) {
      const output = event.output as { log?: unknown; running?: unknown } | undefined;
      // Native integration: whatever the executive starts, Spidermonkey watches.
      if (event.name === 'start_process' && typeof output?.log === 'string') daemon.readFromStart(resolve(root, output.log));
      if (event.name === 'start_process' && typeof output?.log === 'string')
        daemon.monkey.register({ id: `file:${resolve(root, output.log)}`, kind: 'file', label: output.log, priority: 2, source: 'adopted',
          reason: `log of ${String(event.input.name)}, started by the agent`, spec: { path: resolve(root, output.log) } });
      if (event.name === 'stop_process' && typeof event.input.name === 'string')
        daemon.monkey.unregister(`file:${resolve(root, `logs/${event.input.name}.log`)}`, 'process stopped by the agent');
    },
    blocking(call: BlockingCall) {
      blocked = call;
      call.signal.addEventListener('abort', () => { if (blocked === call) blocked = undefined; }, { once: true });
    },
    drain: (): Finding[] => daemon.monkey.drain().map(finding => toFinding(finding, context.editRevision())),
    async finalGate() {
      // Background programs react to the last edit with a delay: look once more before the answer stands.
      await new Promise(done => setTimeout(done, Math.min(6000, config.intervalMs * 2.5)));
      return undefined;
    },
    async stop() { await started.catch(() => {}); await daemon.stop(); },
  } satisfies Monitor;
};
