import type { AttemptResult, TaskSpec } from './lib.js';

// Markdown summary of a dynamic-world run. Every number is derived from results.jsonl.

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
const median = (values: number[]) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const fixed = (value: number, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '–';
const money = (values: Array<number | null>) => values.some(value => value === null) ? 'unknown' : `$${values.reduce<number>((sum, value) => sum + value!, 0).toFixed(4)}`;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function summarize(rows: AttemptResult[]) {
  return {
    n: rows.length,
    success: rows.filter(row => row.success).length,
    elapsed: mean(rows.map(row => row.elapsedSeconds)),
    medianElapsed: median(rows.map(row => row.elapsedSeconds)),
    steps: mean(rows.map(row => row.executiveSteps)),
    inputTokens: mean(rows.map(row => row.executiveInputTokens)),
    executiveCost: money(rows.map(row => row.executiveCostUsd)),
    jevCost: money(rows.map(row => row.jevCostUsd)),
    jevCalls: mean(rows.map(row => row.jevCalls)),
    blocked: sum(rows.map(row => row.blockedSeconds)),
    meanBlocked: mean(rows.map(row => row.blockedSeconds)),
    checkSeconds: mean(rows.map(row => row.checkSeconds)),
    interrupts: sum(rows.map(row => row.interrupts)),
    falseInterrupts: sum(rows.map(row => row.falseInterrupts)),
    followUps: sum(rows.map(row => row.followUps)),
    falseFollowUps: sum(rows.map(row => row.falseFollowUps)),
    delivered: mean(rows.map(row => row.delivered)),
    relevant: mean(rows.map(row => row.relevantDelivered)),
    events: rows.filter(row => row.eventAt !== undefined).length,
    detected: rows.filter(row => row.detectionSeconds !== undefined).length,
    detection: median(rows.flatMap(row => row.detectionSeconds === undefined ? [] : [row.detectionSeconds])),
    brokenAtEnd: rows.filter(row => row.brokenAtEnd).length,
    errors: rows.filter(row => row.status !== 'completed').length,
  };
}

export function report(results: AttemptResult[], tasks: TaskSpec[], manifest: Record<string, unknown>) {
  const arms = [...new Set(results.map(row => row.arm))];
  const order = (manifest.arms as string[] | undefined) ?? arms;
  const sortedArms = order.filter(arm => arms.includes(arm));
  const lines: string[] = [];
  lines.push(`# Dynamic-world run ${String(manifest.name)}`, '');
  lines.push(`Mode: ${String(manifest.mode)} · executive ${String(manifest.executiveModel)} (${String(manifest.executiveReasoning)}) · System 1 ${String(manifest.system1Model)} · ${results.length} attempts`, '');
  if (String(manifest.mode).startsWith('scripted')) lines.push('**Scripted run: the executive is a fixed tool-call script, not a model. These rows validate sensors and graders; they are not executive results.**', '');

  lines.push('## All tasks, by arm', '');
  lines.push('| Arm | Solved | Mean task s | Mean exec steps | Exec $ | Jev $ | Jev calls/attempt | Blocked s (total) | Interrupts (false) | Follow-ups (false) | Findings/attempt | Hazards detected | Median detection s |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of sortedArms) {
    const s = summarize(results.filter(row => row.arm === arm));
    lines.push(`| ${arm} | ${s.success}/${s.n} | ${fixed(s.elapsed)} | ${fixed(s.steps)} | ${s.executiveCost} | ${s.jevCost} | ${fixed(s.jevCalls)} | ${fixed(s.blocked, 0)} | ${s.interrupts} (${s.falseInterrupts}) | ${s.followUps} (${s.falseFollowUps}) | ${fixed(s.delivered)} | ${s.detected}/${s.events} | ${fixed(s.detection)} |`);
  }
  lines.push('');
  lines.push('Blocked s: time the executive spent inside checks that ended by timeout or interrupt. False interrupts: interrupts on the healthy slow suite. False follow-ups: final-gate follow-ups on distractor tasks. Detection: environment event to the executive having the evidence (delivered finding, reading the log/queue itself, or regaining control from a hung check).', '');

  // By hazard family: what each capability buys, and what it costs on distractors.
  const family = (hazards: string[]) => (arm: string) => results.filter(row => row.arm === arm && hazards.includes(tasks.find(task => task.id === row.task)?.hazard ?? ''));
  const escalate = family(['escalate']);
  const interrupt = family(['interrupt']);
  const distract = family(['no-interrupt', 'no-escalate']);
  lines.push('## By hazard family', '');
  lines.push('| Arm | Escalation tasks solved | Median detection s | Hang tasks solved | Mean task s (hangs) | Blocked s/attempt (hangs) | Distractors solved | False alarms on distractors | Findings/attempt on distractors | Exec $/attempt (all) |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of sortedArms) {
    const e = summarize(escalate(arm)), h = summarize(interrupt(arm)), d = summarize(distract(arm));
    const all = results.filter(row => row.arm === arm);
    const perAttempt = all.some(row => row.executiveCostUsd === null) ? 'unknown' : `$${(sum(all.map(row => row.executiveCostUsd!)) / Math.max(1, all.length)).toFixed(4)}`;
    lines.push(`| ${arm} | ${e.n ? `${e.success}/${e.n}` : '–'} | ${fixed(e.detection)} | ${h.n ? `${h.success}/${h.n}` : '–'} | ${fixed(h.elapsed)} | ${fixed(h.meanBlocked)} | ${d.n ? `${d.success}/${d.n}` : '–'} | ${d.n ? d.falseFollowUps + d.falseInterrupts : '–'} | ${fixed(d.delivered)} | ${perAttempt} |`);
  }
  lines.push('');

  for (const task of tasks) {
    const rows = results.filter(row => row.task === task.id);
    if (!rows.length) continue;
    lines.push(`## ${task.id} (${task.hazard})`, '', task.summary, '');
    lines.push('| Arm | Solved | Median task s | Mean steps | Exec $ | Jev calls | Blocked s | Check s | Interrupts | Follow-ups | Findings (relevant) | Detected | Median detection s | Broken at end |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const arm of sortedArms) {
      const armRows = rows.filter(row => row.arm === arm);
      if (!armRows.length) continue;
      const s = summarize(armRows);
      lines.push(`| ${arm} | ${s.success}/${s.n} | ${fixed(s.medianElapsed)} | ${fixed(s.steps)} | ${s.executiveCost} | ${fixed(s.jevCalls)} | ${fixed(s.meanBlocked)} | ${fixed(s.checkSeconds)} | ${s.interrupts} | ${s.followUps} | ${fixed(s.delivered)} (${fixed(s.relevant)}) | ${s.detected}/${s.events} | ${fixed(s.detection)} | ${task.hazard === 'escalate' ? `${s.brokenAtEnd}/${s.events}` : '–'} |`);
    }
    const failures = rows.filter(row => !row.success);
    if (failures.length) {
      lines.push('', 'Failed checks:');
      for (const row of failures) lines.push(`- ${row.arm}/r${row.repeat}: ${row.status !== 'completed' ? `${row.status} (${String(row.error ?? '').slice(0, 120)}); ` : ''}${row.gradeChecks.filter(check => !check.pass).map(check => check.name).join('; ') || 'no grade'}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
