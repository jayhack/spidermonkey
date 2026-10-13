// The explainer's script: chapters and captions on one clock, in seconds.

export const DURATION = 33;

export const chapters = [
  { at: 0, title: 'The agent' },
  { at: 4.8, title: 'Watching' },
  { at: 9.4, title: 'A busy machine' },
  { at: 13.6, title: 'Two systems' },
  { at: 18.8, title: 'A decision model' },
  { at: 23.4, title: 'Escalation' },
  { at: 28.4, title: 'Result' },
] as const;

export const captions = [
  { from: 0.3, to: 4.6, text: 'A coding agent works one step at a time.' },
  { from: 4.8, to: 9.2, text: 'It also has to keep watching many things: the server, the tests, the logs.' },
  { from: 9.4, to: 13.4, text: 'But a computer is a busy place, and hard to keep track of.' },
  { from: 13.6, to: 18.6, text: 'Humans split the work: one system for executive function, another that perceives and makes snap judgments.' },
  { from: 18.8, to: 23.2, text: 'A computer is awash with signals too. Put a fast decision model on top.' },
  { from: 23.4, to: 28.2, text: 'It extracts what matters and escalates it to the agent.' },
  { from: 28.4, to: 33, text: 'The result: more efficient agentic action.' },
] as const;

/** The caption on screen at t, if any. */
export function captionAt(t: number) {
  return captions.find(caption => t >= caption.from && t < caption.to)?.text ?? '';
}

export function chapterAt(t: number) {
  let current: (typeof chapters)[number] = chapters[0];
  for (const chapter of chapters) if (t >= chapter.at) current = chapter;
  return current;
}
