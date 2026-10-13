import { defineAgent } from 'eve';
import { z } from 'zod';

export default defineAgent({
  model: process.env.ROS_EXECUTIVE_MODEL || 'openai/gpt-6.1-sol',
  reasoning: z.enum(['provider-default', 'none', 'low', 'medium']).parse(process.env.ROS_EXECUTIVE_REASONING || 'low'),
  // Ask the provider for a summary of the model's reasoning so the demo can show it thinking.
  modelOptions: { providerOptions: { openai: { reasoningSummary: 'auto' } } },
  defaultTools: false,
  limits: { maxInputTokensPerSession: 600_000, maxOutputTokensPerSession: 40_000 },
});
