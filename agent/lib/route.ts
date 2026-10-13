import type { ModelMessage } from 'ai';
import { callBridge } from './bridge.js';

// Compact view of the conversation for System 1's routing decision: roles, text,
// tool calls and bounded tool results. The harness decides; this only transports.
function compact(messages: readonly ModelMessage[]) {
  return messages.slice(-10).map(message => {
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content as Array<Record<string, unknown>>;
    return { role: message.role, parts: parts.map(part => {
      if (part.type === 'text') return { text: String(part.text ?? '').slice(0, 800) };
      if (part.type === 'tool-call') return { call: part.toolName, input: JSON.stringify(part.input ?? {}).slice(0, 300) };
      if (part.type === 'tool-result') return { result: part.toolName, output: JSON.stringify(part.output ?? {}).slice(0, 600) };
      return { type: part.type };
    }) };
  });
}

export async function routeStep(messages: readonly ModelMessage[], signal?: AbortSignal) {
  const decision = await callBridge('route', { step: messages.filter(message => message.role === 'assistant').length + 1, messages: compact(messages) }, signal) as { model: string };
  return decision.model;
}
