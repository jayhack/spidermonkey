import { basename } from 'node:path';
import type { Action, DashboardState, HarnessEvent, System1Decision } from './types.js';
import { terminalTheme as ansi } from './theme.js';

type Row = { text: string; color?: string; cursor?: number; /** Further text on the same line, in its own color. */ tail?: Array<{ text: string; color: string }> };

// All external text is rendered as inert, single-line terminal content.
function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(char) || code === 0xfe0f) return 0;
  if (/\p{Emoji_Presentation}/u.test(char)) return 2;
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) || code >= 0x20000
  ) ? 2 : 1;
}

function widthOf(text: string): number {
  return Array.from(text).reduce((sum, char) => sum + charWidth(char), 0);
}

function clip(text: string, width: number): string {
  if (width <= 0) return '';
  if (widthOf(text) <= width) return text;
  let result = '';
  let used = 0;
  for (const char of text) {
    const size = charWidth(char);
    if (used + size > width - 1) break;
    result += char;
    used += size;
  }
  return result + '…';
}

function padded(text: string, width: number): string {
  const fitted = clip(text, width);
  return fitted + ' '.repeat(Math.max(0, width - widthOf(fitted)));
}

function painted(row: Row, width: number): string {
  if (row.tail?.length) {
    let used = 0;
    let output = '';
    for (const segment of [{ text: row.text, color: row.color ?? ansi.body }, ...row.tail]) {
      const fitted = clip(segment.text, width - used);
      output += segment.color + fitted;
      used += widthOf(fitted);
      if (used >= width) break;
    }
    return output + ' '.repeat(Math.max(0, width - used)) + ansi.reset;
  }
  let text = padded(row.text, width);
  if (row.cursor !== undefined) {
    const characters = Array.from(text);
    if (row.cursor < characters.length) characters[row.cursor] = `\x1b[7m${characters[row.cursor]}\x1b[27m`;
    text = characters.join('');
  }
  return (row.color ?? ansi.body) + text + ansi.reset;
}

function number(value: number): string {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)).toLocaleString('en-US') : '—';
}

function modeNote(mode: string): string {
  const value = clean(mode);
  if (/replay/i.test(value)) return `${value} · deterministic replay`;
  if (/live/i.test(value)) return `${value} · live model calls`;
  return value || 'mode unspecified';
}

function timestamp(event: Pick<HarnessEvent, 'at'>): string {
  const text = clean(event.at);
  // ISO timestamps keep time-of-day; unknown timestamp formats stay visible.
  const match = text.match(/T(\d{2}:\d{2}:\d{2})/);
  return match?.[1] ?? clip(text, 8);
}

function eventRows(events: HarnessEvent[], limit: number): Row[] {
  if (limit <= 0) return [];
  if (!events.length) return [{ text: 'Waiting for events…', color: ansi.dim }];
  return events.slice(-limit).map(event => ({
    text: `${timestamp(event)}  ${clean(event.kind)}  ${clean(event.message)}`,
    color: event.kind.includes('error') ? ansi.warning : event.lane === 'harness' ||
      event.lane === 'system1' && !['reflex', 'escalation'].includes(event.kind) ? ansi.dim : undefined,
  }));
}

function probabilityRow(state: DashboardState, action: Action, label: string, width: number): Row {
  const raw = state.probabilities[action];
  const valid = typeof raw === 'number' && Number.isFinite(raw);
  const probability = valid ? Math.max(0, Math.min(1, raw)) : 0;
  const percent = valid ? `${Math.round(probability * 100).toString().padStart(3)}%` : '  — ';
  const labelWidth = Math.min(17, Math.max(7, width - 14));
  const barWidth = Math.max(0, width - labelWidth - 6);
  const filled = Math.round(probability * barWidth);
  return {
    text: `${padded(label, labelWidth)} ${'━'.repeat(filled)}${'·'.repeat(barWidth - filled)} ${percent}`,
    color: action === 'wait' || probability < (state.latestDecision?.threshold ?? 0.85) ? ansi.dim : action === 'escalate' ? ansi.warning : ansi.signal,
  };
}

function executiveRows(state: DashboardState, width: number, height: number): Row[] {
  if (height <= 0) return [];
  const hasPrompt = state.events.some(event => event.lane === 'executive' && event.kind === 'prompt');
  const footer = state.composer ? composerRows(state, width) : undefined;
  const spent = state.events.filter(event => event.lane === 'executive' && event.kind === 'usage')
    .reduce((sum, event) => sum + Number(record(event.data?.usage).costUsd ?? 0), 0);
  const header: Row[] = [
    { text: 'Executive', color: ansi.bright, tail: [{ text: ' • ', color: ansi.dim }, { text: clean(state.executiveModel), color: ansi.executive },
      { text: ` • $${spent.toFixed(4)}`, color: ansi.dim }] },
    { text: '' },
    ...(!hasPrompt ? [...wrapRows(state.task, width, '› ', '  ').slice(0, 4), { text: '' }] : []),
  ].slice(0, Math.max(0, height - (footer?.length ?? 2) - 3));
  const blocks = transcriptBlocks(state, width);
  const available = Math.max(0, height - header.length - (footer?.length ?? 2));
  const body: Row[] = [];
  const all = blocks.flat();
  const scroll = state.scroll;
  if (scroll) {
    scroll.max = Math.max(0, all.length - available);
    if (scroll.top !== undefined) scroll.top = Math.min(scroll.top, scroll.max);
  }
  const top = scroll?.top;
  if (top !== undefined) body.push(...all.slice(top, top + available));
  // Following the end: keep complete recent blocks instead of cutting through a tool header.
  else for (const block of blocks.slice().reverse()) {
    if (body.length + block.length > available) {
      if (!body.length && available) body.unshift(...block.slice(0, Math.max(0, available - 1)), { text: '  …', color: ansi.dim });
      break;
    }
    body.unshift(...block);
  }
  const latest = [...state.events].reverse().find(event => event.lane === 'executive' || event.lane === 'environment');
  const done = /^done/i.test(state.status);
  const activity = done ? `✓ ${clean(state.status)}` : latest?.kind === 'tool' ? '◌ Running tool…' : latest?.data?.streaming ? (latest.kind === 'reasoning' ? '◌ Thinking…' : '◌ Responding…') : '◌ Working…';
  const rows = [...header, ...body];
  while (rows.length < height - (footer?.length ?? 2)) rows.push({ text: '' });
  const below = top === undefined ? 0 : all.length - top - body.length;
  const hint = !scroll ? [] : top === undefined ? [{ text: '  ·  ↑↓ PgUp PgDn scroll', color: ansi.dim }]
    : [{ text: `  ·  ↓ ${below} more line${below === 1 ? '' : 's'} · End follows`, color: ansi.muted }];
  rows.push(...footer ?? [{ text: '' }, { text: activity, color: done ? ansi.success : ansi.dim, tail: hint }]);
  return rows.slice(0, height);
}

function composerRows(state: DashboardState, width: number): Row[] {
  const input = state.composer!;
  const lines: Row[] = [];
  let row: Row = { text: '› ', color: ansi.bright };
  let cursorLine = 0;
  const characters = Array.from(input.text);
  for (let index = 0; index <= characters.length; index++) {
    const char = characters[index];
    if (char !== '\n' && char && widthOf(row.text) + charWidth(char) >= width) { lines.push(row); row = { text: '  ', color: ansi.bright }; }
    if (index === input.cursor) { row.cursor = Array.from(row.text).length; cursorLine = lines.length; }
    if (char === '\n') { lines.push(row); row = { text: '  ', color: ansi.bright }; }
    else if (char) row.text += clean(char) || (char === ' ' ? ' ' : '');
  }
  lines.push(row);
  const visible = lines.slice(Math.max(0, cursorLine - 2), Math.max(0, cursorLine - 2) + 3);
  const hint = input.queued ? `${input.queued} queued · Enter queues another` : input.busy ? 'Working · Enter queues a follow-up' : 'Enter send · Alt+Enter newline · ↑ history';
  return [{ text: '─'.repeat(width), color: ansi.border }, ...visible, { text: hint, color: ansi.dim }];
}

function wrapRows(value: unknown, width: number, first = '  ', rest = first, color?: string): Row[] {
  const result: Row[] = [];
  for (const raw of String(value ?? '').split(/\r?\n/)) {
    let text = clean(raw);
    let prefix = result.length ? rest : first;
    if (!text) { result.push({ text: prefix.trimEnd(), color }); continue; }
    while (text) {
      const budget = Math.max(1, width - widthOf(prefix));
      let line = '';
      for (const char of text) {
        if (widthOf(line) + charWidth(char) > budget) break;
        line += char;
      }
      if (!line) line = Array.from(text)[0] ?? '';
      if (line.length < text.length && line.lastIndexOf(' ') > line.length / 2) line = line.slice(0, line.lastIndexOf(' '));
      result.push({ text: prefix + line, color });
      text = text.slice(line.length).trimStart();
      prefix = rest;
    }
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function transcriptBlocks(state: DashboardState, width: number): Row[][] {
  const blocks: Row[][] = [];
  let injection: { delivery: unknown; block: Row[]; count: number } | undefined;
  let pending: { name: string; rows: Row[] } | undefined;
  const label = (text: string): Row => ({ text: `  ${text}`, color: ansi.dim });
  for (const event of state.events) {
    if (event.lane === 'executive' && event.kind === 'prompt' && typeof event.data?.source === 'string' && event.data.source.startsWith('system1')) {
      // System 1 started this turn: a wake after the executive finished, or a final-gate follow-up.
      const label = event.data.source === 'system1-wake' ? 'SYSTEM 1 → woke the executive (new turn)' : 'SYSTEM 1 → follow-up after the answer';
      blocks.push([{ text: `  ${label}`, color: ansi.bright + ansi.accent }, ...wrapRows(event.message, width, '  ▌    ', '  ▌    ', ansi.accent).slice(0, 8), { text: '' }]);
    } else if (event.lane === 'executive' && event.kind === 'prompt') {
      blocks.push([{ text: '  YOU', color: ansi.dim }, ...wrapRows(event.message, width, '› ', '  '), { text: '' }]);
    } else if (event.lane === 'executive' && event.kind === 'tool') {
      const name = typeof event.data?.toolName === 'string' ? event.data.toolName : event.message.split(' ')[0];
      const path = clean(event.data?.path ?? event.message.slice(name.length).trim());
      const command = clean(event.data?.command ?? '');
      const tool = {
        list_files: ['EXPLORE', 'List workspace files'], read_file: ['READ', `Read ${path}`], search: ['SEARCH', clean(event.message)],
        write_file: ['WRITE', `Write ${path}`], replace_text: ['EDIT', `Edit ${path}`], run_checks: ['CHECK', `$ ${command || 'run checks'}`],
        run_command: ['RUN', `$ ${command}`], start_process: ['START', `${clean(event.data?.processName ?? '')}: ${command}`],
        stop_process: ['STOP', clean(event.data?.processName ?? path)], spidermonkey: ['SPIDERMONKEY', `${clean(event.data?.action ?? 'status')}`],
        perception: ['SYSTEM 1', 'Review perception findings'],
      }[name] ?? ['TOOL', clean(event.message)];
      const rows: Row[] = [label(tool[0]), { text: `• ${tool[1]}`, color: ansi.bright }, { text: '' }];
      blocks.push(rows);
      pending = { name, rows };
    } else if (event.lane === 'environment' && event.kind === 'result' && pending) {
      const name = typeof event.data?.toolName === 'string' ? event.data.toolName : event.message.split(':')[0];
      if (pending.name !== name) continue;
      pending.rows.pop();
      const output = record(event.data?.output);
      if (typeof output.error === 'string') pending.rows.push(...wrapRows(output.error, width, '  └ ', '    ', ansi.danger).slice(0, 3));
      else if (name === 'list_files' && Array.isArray(output.files)) {
        pending.rows.push({ text: `  └ ${output.files.length} files`, color: ansi.dim });
        pending.rows.push(...wrapRows(output.files.map(clean).join(' · '), width, '    ', '    ', ansi.dim).slice(0, 2));
      } else if (name === 'read_file' && typeof output.content === 'string') {
        pending.rows.push({ text: `  └ ${output.content.split('\n').length - (output.content.endsWith('\n') ? 1 : 0)} lines`, color: ansi.dim });
      } else if (name === 'write_file') {
        const edit = record(event.data?.edit);
        if (Array.isArray(edit.removed) && Array.isArray(edit.added)) {
          pending.rows.push({ text: `  └ +${edit.addedCount} −${edit.removedCount} · line ${edit.line}`, color: ansi.dim });
          for (const line of edit.removed) pending.rows.push({ text: `    - ${clean(line)}`, color: ansi.danger });
          for (const line of edit.added) pending.rows.push({ text: `    + ${clean(line)}`, color: ansi.success });
          if (Number(edit.removedCount) > 4 || Number(edit.addedCount) > 4) pending.rows.push({ text: '    …', color: ansi.dim });
        } else pending.rows.push({ text: '  └ File updated', color: ansi.success });
      } else if (name === 'run_checks') {
        const passed = output.exitCode === 0;
        pending.rows.push({ text: `  └ ${passed ? '✓ Passed' : '✗ Failed'} · exit ${clean(output.exitCode)}`, color: passed ? ansi.success : ansi.danger });
        const lines = String(output.output ?? '').split(/\r?\n/).map(clean).filter(Boolean);
        const summaries = lines.filter(line => /^(?:[✔✖]|(?:ok|not ok)\s|# (?:tests|pass|fail)\b|ℹ (?:tests|pass|fail)\b|(?:PASS|FAIL)\b)/.test(line));
        const preview = summaries.length ? summaries : lines;
        for (const line of preview.slice(0, 3)) pending.rows.push({ text: `    ${line}`, color: /[✖]|^not ok|^FAIL/.test(line) ? ansi.danger : ansi.dim });
      } else if (name === 'run_command') {
        const passed = output.exitCode === 0;
        pending.rows.push({ text: `  └ ${output.interrupted ? '⚡ Stopped by System 1' : passed ? '✓ exit 0' : `✗ exit ${clean(output.exitCode)}`} · ${clean(output.durationMs)} ms`, color: output.interrupted ? ansi.accent : passed ? ansi.success : ansi.danger });
        const lines = String(output.output ?? '').split(/\r?\n/).map(clean).filter(Boolean);
        for (const line of lines.slice(-3)) pending.rows.push({ text: `    ${line}`, color: /fail|error|✖|not ok/i.test(line) ? ansi.danger : ansi.dim });
      } else if (name === 'start_process') {
        pending.rows.push({ text: `  └ ${output.running ? `● running · pid ${clean(output.pid)}` : `✗ exited ${clean(output.exitCode)}`} · ${clean(output.log)}`, color: output.running ? ansi.success : ansi.danger });
      } else if (name === 'spidermonkey') {
        const watching = Array.isArray(output.watching) ? output.watching.length : output.watching ? 1 : 0;
        pending.rows.push({ text: `  └ ${output.watching && !Array.isArray(output.watching) ? `watching ${clean(record(output.watching).label)}` : `${watching} watched · ${clean(output.undeliveredFindings ?? 0)} pending`}`, color: ansi.accent });
      } else if (name === 'perception') {
        const reads = Array.isArray(output.observations) ? output.observations.length : 0;
        const findings = Array.isArray(output.findings) ? output.findings.length : 0;
        pending.rows.push({ text: `  └ ${reads} file observations · ${findings} findings`, color: ansi.dim });
      }
      pending.rows.push({ text: '' });
      pending = undefined;
    } else if (event.lane === 'system1' && ['escalation', 'finding'].includes(event.kind) && event.data?.monitor === 'spidermonkey') {
      // What System 1 put into the executive's context, in its own color.
      // Wakes and final checks show as the prompt they became; tool deliveries show here.
      const via = String(event.data?.via ?? 'tool');
      if (via === 'wake' || via === 'final check') continue;
      const summary = clean(event.data?.summary ?? event.message);
      const urgent = summary.startsWith('INTERRUPT');
      const rows = wrapRows(`${urgent ? 'INTERRUPT · ' : ''}${summary.replace(/^INTERRUPT · /, '')}`, width, `  ▌  ${urgent ? '⚡' : '⚑'} `, '  ▌    ', ansi.accent).slice(0, 3);
      const evidence = String(event.data?.evidence ?? '').split(/\r?\n/).map(clean).filter(Boolean).slice(-2);
      for (const line of evidence) rows.push(...wrapRows(line, width, '  ▌      ', '  ▌      ', ansi.accent).slice(0, 2));
      // Findings handed over together form one block under one title.
      if (injection && event.data?.delivery !== undefined && injection.delivery === event.data.delivery) {
        injection.block.splice(injection.block.length - 1, 0, ...rows);
        injection.count++;
        injection.block[0]!.text = `  SYSTEM 1 → ${injection.count} findings injected into the ${via} result`;
      } else {
        const block = [{ text: `  SYSTEM 1 → injected into the ${via} result`, color: ansi.bright + ansi.accent }, ...rows, { text: '' }];
        injection = { delivery: event.data?.delivery, block, count: 1 };
        blocks.push(block);
      }
      continue;
    } else if (event.lane === 'system1' && event.kind === 'interrupt') {
      blocks.push([{ text: '  SYSTEM 1 → stopped the blocked command', color: ansi.bright + ansi.accent }, ...wrapRows(event.message, width, '  ▌  ⚡ ', '  ▌    ', ansi.accent).slice(0, 3), { text: '' }]);
    } else if (event.lane === 'executive' && event.kind === 'reasoning') {
      // The provider's summary of the model's reasoning, as streamed: not its raw chain of thought.
      const rows: Row[] = [];
      for (const line of event.message.replace(/\n{2,}/g, '\n').trim().split('\n')) {
        const heading = /^\*\*(.+)\*\*$/.exec(line.trim());
        rows.push(...wrapRows(heading ? heading[1] : line.replace(/\*\*/g, ''), width, '┊ ', '┊ ', heading ? ansi.body : '\x1b[3m' + ansi.muted));
      }
      if (rows.length) blocks.push([label('THINKING · reasoning summary'), ...(rows.length > 10 ? [...rows.slice(0, 9), { text: '┊ …', color: ansi.dim }] : rows), { text: '' }]);
    } else if (event.lane === 'executive' && ['message', 'plan', 'decision'].includes(event.kind)) {
      blocks.push([label('ASSISTANT'), ...wrapRows(event.message, width, '• ', '  '), { text: '' }]);
    } else if (event.lane === 'executive' && ['error', 'cancelled'].includes(event.kind)) {
      blocks.push([label('ATTENTION'), ...wrapRows(event.message, width, '• ', '  ', ansi.warning).slice(0, 4), { text: '' }]);
    }
  }
  return blocks;
}

function percent(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` : '—';
}

function decisionSubject(decision: System1Decision): string {
  if (decision.action === 'read_related_file') return `Read ${decision.target ?? '(no file selected)'}`;
  if (decision.action === 'escalate') return `Flag ${decision.tool ?? '(no tool result)'}`;
  return 'Wait';
}

function decisionStyle(decision: System1Decision): { badge: string; color: string } {
  if (decision.outcome === 'read') return { badge: 'READ', color: ansi.bright };
  if (decision.outcome === 'escalated') return { badge: 'ESCALATED', color: ansi.bright };
  if (decision.outcome === 'error') return { badge: 'FAILED', color: ansi.danger };
  if (decision.outcome === 'duplicate') return { badge: 'NO CHANGE', color: ansi.dim };
  if (decision.outcome === 'stale') return { badge: 'STALE', color: ansi.dim };
  if (decision.outcome === 'waiting') return { badge: 'WAIT', color: ansi.dim };
  return { badge: 'HELD', color: ansi.dim };
}

function decisionResult(decision: System1Decision): string {
  if (decision.outcome === 'held') return decision.action === 'read_related_file'
    ? `No read: ${decision.target ?? '(no file selected)'}` : `No flag: ${decision.tool ?? '(no tool result)'}`;
  if (decision.outcome === 'duplicate') return `No new flag: ${decision.tool ?? '(no tool result)'}`;
  return decisionSubject(decision);
}

function decisionRows(state: DashboardState, width: number): Row[] {
  const latest = state.latestDecision;
  const rows: Row[] = [];
  if (!latest) rows.push({ text: 'Waiting for a classification…', color: ansi.dim });
  else if (latest.action === 'wait') rows.push({ text: `○ Waiting · ${percent(latest.probability)} · no tool called`, color: ansi.dim });
  const proposal = state.lastProposal;
  if (!proposal) return [...rows, { text: '' }];
  if (rows.length) rows.push({ text: '' });
  const style = decisionStyle(proposal);
  rows.push({ text: `LAST RESULT · ${timestamp(proposal)}`, color: ansi.dim });
  rows.push(...wrapRows(`[${style.badge}] ${decisionResult(proposal)}`, width, '', '', style.color).slice(0, 3));
  const confidence = `Action ${percent(proposal.probability)}${proposal.action === 'read_related_file' ? ` · File ${percent(proposal.targetProbability)}` : ''} · Required ${percent(proposal.threshold)}`;
  rows.push(...wrapRows(confidence, width, '', '', ansi.dim).slice(0, 2));
  rows.push(...wrapRows(proposal.detail, width, '→ ', '  ', style.color).slice(0, 3));
  rows.push(...wrapRows(`Observed: ${proposal.observed}`, width, '', '', ansi.muted).slice(0, 3));
  const trigger = proposal.cause === 'timer' ? 'Timer snapshot' : proposal.cause === 'startup' ? 'Startup snapshot' :
    proposal.cause.startsWith('after:') ? `After ${proposal.cause.slice(6)}` : proposal.cause;
  rows.push({ text: `${clean(trigger)} · revision ${proposal.revision}`, color: ansi.dim }, { text: '' });
  return rows;
}

function activityColumns(time: string, result: string, detail: string, width: number, color: string, limit = 2): Row[] {
  const timeWidth = width >= 36 ? 8 : width >= 28 ? 5 : 0;
  const resultWidth = width >= 36 ? 9 : 7;
  const detailWidth = Math.max(1, width - timeWidth - resultWidth - (timeWidth ? 4 : 2));
  const label = resultWidth < 9 && result === 'ESCALATED' ? 'FLAGGED' : resultWidth < 9 && result === 'NO CHANGE' ? 'NO CHG' : result;
  const details = wrapRows(detail, detailWidth, '', '', color);
  const rows = details.slice(0, limit);
  if (details.length > limit) rows[limit - 1].text = clip(rows[limit - 1].text + '…', detailWidth);
  return rows.map((row, index) => ({
    text: `${timeWidth ? padded(index ? '' : time.slice(-timeWidth), timeWidth) + '  ' : ''}${padded(index ? '' : label, resultWidth)}  ${padded(row.text, detailWidth)}`,
    color,
  }));
}

function activityDetail(decision: System1Decision): string {
  if (decision.outcome === 'read') {
    const lines = decision.detail.match(/^Read (\d+) lines into the perception board\.$/)?.[1];
    return lines ? `${decision.target} · ${lines} lines → context` : `${decision.target} · ${decision.detail}`;
  }
  if (decision.outcome === 'escalated') return `${decision.tool} → executive · new finding`;
  if (decision.outcome === 'held' && decision.action === 'read_related_file') {
    const reason = decision.detail.startsWith('Action confidence is below ') ? `action ${percent(decision.probability)} < ${percent(decision.threshold)}` :
      decision.detail.startsWith('File confidence is below ') ? `file ${percent(decision.targetProbability)} < ${percent(decision.threshold)}` : decision.detail;
    return `${decisionResult(decision)} · ${reason}`;
  }
  return `${decisionResult(decision)} · ${decision.detail}`;
}

function system1ActivityRows(state: DashboardState, width: number, height: number): Row[] {
  if (height <= 0) return [];
  const structured = state.events.some(event => event.lane === 'system1' && event.kind === 'decision' && event.data?.outcome);
  const groups: Array<{ event: HarnessEvent; key: string; count: number }> = [];
  for (const event of state.events) {
    if (event.lane !== 'system1' && event.lane !== 'harness') continue;
    if (['done', 'uncertain', 'usage'].includes(event.kind) || structured && ['reflex', 'escalation'].includes(event.kind)) continue;
    const data = event.data;
    const key = event.kind === 'decision' && data?.action === 'wait' ? 'wait' : event.kind === 'decision' ?
      JSON.stringify([data?.action, data?.target, data?.outcome, data?.detail, data?.observed]) : event.at;
    const previous = groups.at(-1);
    if (previous?.key === key) { previous.event = event; previous.count++; }
    else groups.push({ event, key, count: 1 });
  }
  const blocks = groups.map(({ event, count }) => {
    const repeated = count > 1 ? ` · ×${count} frames` : '';
    if (event.kind === 'decision' && event.data?.action === 'wait') {
      return activityColumns(timestamp(event), 'WAIT', `No tool called · ${percent(event.data.probability as number)} wait${repeated}`, width, ansi.dim);
    }
    if (event.kind === 'decision' && event.data?.outcome) {
      const decision = event.data as unknown as System1Decision;
      const style = decisionStyle(decision);
      return activityColumns(timestamp(event), style.badge, activityDetail(decision) + repeated, width, style.color);
    }
    const color = event.kind.includes('error') ? ansi.danger : ['reflex', 'escalation'].includes(event.kind) ? ansi.bright : ansi.dim;
    return activityColumns(timestamp(event), clean(event.kind).toUpperCase(), clean(event.message), width, color);
  });
  const rows: Row[] = [];
  for (const block of blocks.reverse()) {
    if (rows.length + block.length > height - 1) break;
    rows.unshift(...block);
  }
  return [...activityColumns('TIME', 'RESULT', 'WHAT HAPPENED', width, ansi.dim, 1), ...rows];
}

function system1Rows(state: DashboardState, width: number, height: number, compact = false): Row[] {
  const hz = Number.isFinite(state.hz) ? state.hz.toFixed(1).replace(/\.0$/, '') : '—';
  const rows: Row[] = [
    { text: 'SYSTEM 1', color: ansi.bright + ansi.accent },
    ...(!compact ? [{ text: clean(state.system1Model), color: ansi.dim }] : []),
    { text: `${hz} Hz · ${number(state.lastLatencyMs)} ms · Frame ${number(state.frames)}`, color: ansi.dim },
    { text: `Reads ${number(state.reflexes)} · Escalations ${number(state.escalations)}`, color: ansi.dim },
    ...(!compact ? [{ text: `Input ${number(state.inputTokens)} tokens · Skipped ${number(state.skipped)}`, color: ansi.dim }] : []),
    { text: '' },
    ...decisionRows(state, width),
    { text: 'PROPOSED ACTION SCORES', color: ansi.dim },
    probabilityRow(state, 'wait', 'Wait', width),
    probabilityRow(state, 'read_related_file', 'Read related file', width),
    probabilityRow(state, 'escalate', 'Escalate', width),
    { text: '' },
    { text: 'RECENT ACTIVITY', color: ansi.dim },
    { text: 'White = acted · gray = no action', color: ansi.dim },
  ];
  rows.push(...system1ActivityRows(state, width, height - rows.length));
  return rows.slice(0, height);
}

const priorityNames = ['ignore', 'background', 'watch', 'focus'];

/** Spidermonkey's watch list and feed, rebuilt from its events. */
function spidermonkeyRows(state: DashboardState, width: number, height: number): Row[] {
  const watching = new Map<string, { label: string; priority: number }>();
  const feed: Row[][] = [];
  let cost = 0;
  for (const event of state.events) {
    if (event.lane === 'system1' && event.kind === 'usage' && event.data?.purpose === 'spidermonkey') cost += Number(event.data?.costUsd ?? 0);
    if (event.lane !== 'system1' || !event.kind.startsWith('spidermonkey:')) continue;
    const item = record(event.data?.item);
    const time = timestamp(event);
    if (item.type === 'appraisal') continue;
    if (item.type === 'attention') {
      const to = item.to === null ? null : Number(item.to);
      if (to === null || to === 0) watching.delete(String(item.entity)); else watching.set(String(item.entity), { label: clean(item.label), priority: to });
      const arrow = item.from === null || item.from === undefined ? '+' : to === null ? '−' : to > Number(item.from) ? '↑' : '↓';
      feed.push(wrapRows(`${time} ${arrow} ${to === null ? 'dropped' : priorityNames[to]} ${clean(item.label)}`, width, '', '   ', to === null ? ansi.dim : to >= 3 ? ansi.bright : to === 2 ? ansi.signal : ansi.muted).slice(0, 2));
    } else if (item.type === 'finding') {
      const finding = record(item.finding);
      const urgent = finding.mode === 'interrupt';
      const color = urgent ? ansi.danger : finding.severity === 'warn' ? ansi.warning : finding.severity === 'error' ? ansi.danger : ansi.body;
      const rows = wrapRows(`${time} ${urgent ? '⚡ INTERRUPT' : '⚑ notify'} ${clean(finding.text)}`, width, '', '   ', color).slice(0, 3);
      const evidence = String(finding.evidence ?? '').split(/\r?\n/).map(clean).filter(Boolean).slice(-1);
      for (const line of evidence) rows.push({ text: `   │ ${line}`, color: ansi.dim });
      feed.push(rows);
    } else if (item.type === 'dismissed') {
      feed.push(wrapRows(`${time} · noticed ${clean(item.text)}`, width, '', '   ', ansi.dim).slice(0, 2));
    } else if (item.type === 'declined') {
      feed.push(wrapRows(`${time} · ignored ${clean(item.label)}`, width, '', '   ', ansi.dim).slice(0, 1));
    } else if (item.type === 'error') {
      feed.push(wrapRows(`${time} error ${clean(item.message)}`, width, '', '   ', ansi.danger).slice(0, 2));
    }
  }
  const header: Row[] = [
    { text: 'SPIDERMONKEY', color: ansi.bright + ansi.accent, tail: [{ text: `  $${cost.toFixed(4)}`, color: ansi.dim }] },
    { text: '' },
    { text: 'WATCHING', color: ansi.dim },
  ];
  const watched = [...watching.values()].sort((a, b) => b.priority - a.priority);
  const list: Row[] = watched.slice(0, 9).map(entry => ({ text: `${padded(priorityNames[entry.priority]!, 10)} ${entry.label}`,
    color: entry.priority >= 3 ? ansi.bright : entry.priority === 2 ? ansi.signal : ansi.muted }));
  if (watched.length > 9) list.push({ text: `… ${watched.length - 9} more in background`, color: ansi.dim });
  if (!list.length) list.push({ text: 'Booting: sampling the machine…', color: ansi.dim });
  const rows: Row[] = [...header, ...list, { text: '' }, { text: 'FEED', color: ansi.dim }];
  const room = Math.max(0, height - rows.length);
  const tail: Row[] = [];
  for (const block of feed.reverse()) {
    if (tail.length + block.length > room) break;
    tail.unshift(...block);
  }
  return [...rows, ...tail].slice(0, height);
}

/** A terminal-sized frame. The only ANSI sequences come from this renderer. */
export function renderDashboard(state: DashboardState, requestedWidth: number, requestedHeight: number): string {
  const width = Math.max(1, Math.floor(requestedWidth) || 100);
  const height = Math.max(1, Math.floor(requestedHeight) || 30);
  const title: Row = { text: state.view === 'spidermonkey' ? 'ROS / AGENT HARNESS · SPIDERMONKEY' : 'ROS / AGENT HARNESS', color: ansi.bright };
  const subtitle: Row = { text: modeNote(state.mode), color: ansi.dim };
  if (height < 6 || width < 40) {
    const compact = [title, subtitle,
      { text: `${clean(state.status)} · Frame ${number(state.frames)}` },
      { text: `S1 ${number(state.lastLatencyMs)} ms · ↑ ${number(state.escalations)}` },
      ...eventRows(state.events, height - 4),
    ];
    if (state.composer && height >= 3) compact.splice(Math.max(0, height - 2), compact.length, ...composerRows(state, width).slice(-2));
    return compact.slice(0, height).map(row => painted(row, width)).join('\n');
  }

  const output = [painted(title, width), painted(subtitle, width)];
  const bodyHeight = height - 5;
  if (width < 86) {
    // A narrow terminal keeps the classification visible beside a compact goal.
    const leftWidth = Math.floor((width - 7) * 0.43);
    const rightWidth = width - leftWidth - 7;
    const left = executiveRows(state, leftWidth, bodyHeight);
    const right = state.view === 'spidermonkey' ? spidermonkeyRows(state, rightWidth, bodyHeight) : system1Rows(state, rightWidth, bodyHeight, true);
    appendPanels(output, left, right, leftWidth, rightWidth, bodyHeight);
  } else {
    const share = state.view === 'spidermonkey' ? 0.55 : 0.62;
    const leftWidth = Math.min(width - 43, Math.floor((width - 7) * share));
    const rightWidth = width - leftWidth - 7;
    const right = state.view === 'spidermonkey' ? spidermonkeyRows(state, rightWidth, bodyHeight) : system1Rows(state, rightWidth, bodyHeight);
    appendPanels(output, executiveRows(state, leftWidth, bodyHeight), right, leftWidth, rightWidth, bodyHeight);
  }
  output.push(painted({ text: state.view === 'spidermonkey' ? 'Left: the executive · orange = injected by System 1 · Right: Spidermonkey · Ctrl+C to stop' : 'Observed events and classifier scores · Ctrl+C to stop', color: ansi.dim }, width));
  return output.slice(0, height).join('\n');
}

function appendPanels(output: string[], left: Row[], right: Row[], leftWidth: number, rightWidth: number, height: number): void {
  const border = ansi.border;
  output.push(`${border}┌${'─'.repeat(leftWidth + 2)}┬${'─'.repeat(rightWidth + 2)}┐${ansi.reset}`);
  for (let index = 0; index < height; index++) {
    output.push(`${border}│${ansi.reset} ${painted(left[index] ?? { text: '' }, leftWidth)} ${border}│${ansi.reset} ${painted(right[index] ?? { text: '' }, rightWidth)} ${border}│${ansi.reset}`);
  }
  output.push(`${border}└${'─'.repeat(leftWidth + 2)}┴${'─'.repeat(rightWidth + 2)}┘${ansi.reset}`);
}

export class Dashboard {
  private readonly plain: boolean;
  private readonly seen = new WeakSet<HarnessEvent>();
  private started = false;
  private previousLines: string[] = [];
  private previousWidth = 0;
  private readonly resize = (): void => { this.render(); };
  private readonly exit = (): void => { this.restore(); };

  constructor(private readonly state: DashboardState, options: { plain?: boolean } = {}) {
    this.plain = Boolean(options.plain) || !process.stdout.isTTY || process.env.TERM === 'dumb';
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.plain) {
      process.stdout.write(`ROS / AGENT HARNESS · ${modeNote(this.state.mode)}\n`);
    } else {
      process.stdout.write('\x1b[?1049h' + ansi.reset + '\x1b[?25l\x1b[2J\x1b[H');
      process.stdout.on('resize', this.resize);
      process.on('exit', this.exit);
    }
    this.render();
  }

  render(): void {
    if (!this.started) return;
    if (this.plain) {
      const additions: string[] = [];
      for (const event of this.state.events) {
        if (this.seen.has(event)) continue;
        if (event.data?.streaming) continue;
        this.seen.add(event);
        additions.push(`[${timestamp(event)}] [${clean(event.lane)}] ${clean(event.kind)}: ${clean(event.message)}`);
      }
      if (additions.length) process.stdout.write(additions.join('\n') + '\n');
      return;
    }

    const width = process.stdout.columns || 100;
    // Keep one row free so writing a frame cannot scroll the alternate screen.
    const height = Math.max(1, (process.stdout.rows || 30) - 1);
    const lines = renderDashboard(this.state, width, height).split('\n');
    const resized = width !== this.previousWidth || lines.length !== this.previousLines.length;
    let output = resized ? ansi.reset + '\x1b[2J' : '';
    for (let index = 0; index < lines.length; index++) {
      if (resized || lines[index] !== this.previousLines[index]) {
        output += `\x1b[${index + 1};1H${lines[index]}${ansi.reset}\x1b[K`;
      }
    }
    if (output) process.stdout.write(output);
    this.previousLines = lines;
    this.previousWidth = width;
  }

  stop(): void {
    if (!this.started) return;
    // Flush any events added since the last plain-mode render.
    if (this.plain) this.render();
    this.restore();
    this.started = false;
    this.previousLines = [];
    process.stdout.off('resize', this.resize);
    process.off('exit', this.exit);
  }

  private restore(): void {
    if (this.started && !this.plain) process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }
}
