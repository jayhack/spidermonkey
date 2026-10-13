import { defineAgent } from 'eve';
import { mockModel, type MockModelToolCall } from 'eve/evals';

const fixedCart = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
`;
const repairReply = 'Deterministic Eve fixture: updated src/cart.js to multiply each price by quantity. The verification command exited with code 0.';

// This is a scripted fixture, not a model-generated coding strategy. Eve still
// owns the session, model/tool loop, streamed events, and durable tool execution.
const steps: readonly MockModelToolCall[] = [
  { name: 'list_files', input: {} },
  { name: 'run_checks', input: {} },
  { name: 'read_file', input: { path: 'cart.test.js' } },
  { name: 'read_file', input: { path: 'src/cart.js' } },
  { name: 'write_file', input: { path: 'src/cart.js', content: fixedCart } },
  { name: 'run_checks', input: {} },
  { name: 'perception', input: {} },
];

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)); } catch { return undefined; }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function bridgeResult(output: unknown): Record<string, unknown> | undefined {
  return object(object(output)?.result);
}

export default defineAgent({
  defaultTools: false,
  // The fixture model has no AI Gateway metadata to infer a context window.
  modelContextWindowTokens: 200_000,
  compaction: { modelContextWindowTokens: 200_000 },
  model: mockModel({
    provider: 'ros-fixture',
    modelId: 'cart-repair-replay',
    async respond({ toolResults, messages, lastUserMessage }) {
      // Give the independently ticking System 1 lane time to sample each state.
      await new Promise<void>(resolve => setTimeout(resolve, 600));
      // Eve adds user-role context messages. A completed repair reply identifies
      // follow-ups without treating that framework context as another prompt.
      const promptIndex = messages.findLastIndex(message => message.role === 'user' && message.text === lastUserMessage);
      const isFollowUp = messages.slice(0, promptIndex).some(message => message.role === 'assistant' && message.text === repairReply);
      if (isFollowUp) {
        if (!messages.slice(promptIndex + 1).some(message => message.role === 'tool')) {
          return { toolCalls: [{ name: 'read_file', input: { path: 'src/cart.js' } }] };
        }
        const source = bridgeResult(toolResults.at(-1)?.output);
        if (typeof source?.content !== 'string') throw new Error('Replay follow-up could not read the current source');
        return { text: `Replay follow-up: ${lastUserMessage}\n\nThe current cart code is:\n${source.content}\nThis replay uses scripted replies. Live mode uses the executive model for open-ended conversations.` };
      }
      if (toolResults.length > steps.length) throw new Error('Replay fixture received unexpected extra tool results');
      for (const [index, result] of toolResults.entries()) {
        if (result.name !== steps[index]?.name) throw new Error(`Replay fixture expected ${steps[index]?.name}, received ${result.name}`);
        const error = bridgeResult(result.output)?.error;
        if (result.isError || error) throw new Error(`Replay fixture tool ${result.name} failed: ${String(error ?? result.output)}`);
      }

      if (toolResults.length >= 2) {
        const exitCode = bridgeResult(toolResults[1]?.output)?.exitCode;
        if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode === 0) {
          throw new Error('Replay fixture did not reproduce the expected failing cart test');
        }
      }
      if (toolResults.length >= 6) {
        const exitCode = bridgeResult(toolResults[5]?.output)?.exitCode;
        if (exitCode !== 0) throw new Error(`Replay verification failed (exit code ${String(exitCode)})`);
      }

      const next = steps[toolResults.length];
      if (next) return { toolCalls: [next] };
      return { text: repairReply };
    },
  }),
  limits: { maxInputTokensPerSession: 150_000, maxOutputTokensPerSession: 12_000 },
});
