export type Lane = 'executive' | 'system1' | 'environment' | 'harness';
export type Action = 'wait' | 'read_related_file' | 'escalate';

export interface HarnessEvent {
  at: string;
  lane: Lane;
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface System1Decision {
  at: string;
  action: Action;
  target?: string;
  tool?: string;
  probability: number;
  targetProbability?: number;
  threshold: number;
  revision: number;
  cause: string;
  observed: string;
  outcome: 'waiting' | 'held' | 'read' | 'escalated' | 'duplicate' | 'error' | 'stale';
  detail: string;
}

export interface DashboardState {
  mode: string;
  task: string;
  workspace: string;
  status: string;
  executiveModel: string;
  system1Model: string;
  hz: number;
  frames: number;
  skipped: number;
  reflexes: number;
  escalations: number;
  inputTokens: number;
  lastLatencyMs: number;
  probabilities: Partial<Record<Action, number>>;
  events: HarnessEvent[];
  answer: string;
  latestDecision?: System1Decision;
  lastProposal?: System1Decision;
  composer?: { text: string; cursor: number; busy: boolean; queued: number };
  /** 'spidermonkey': the right pane shows Spidermonkey's watch list and feed. */
  view?: 'system1' | 'spidermonkey';
  /** Transcript scrollback, present when keys can scroll it: the top row while scrolled (undefined follows the end); the renderer sets max. */
  scroll?: { top?: number; max: number };
}
