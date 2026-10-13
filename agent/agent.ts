import { defineAgent, defineDynamic } from 'eve';
import { defaultExecutiveModel } from '../src/models.js';
import { z } from 'zod';
import { routeStep } from './lib/route.js';

const reasoning = z.enum(['provider-default', 'none', 'low']).parse(process.env.ROS_EXECUTIVE_REASONING || 'provider-default');
const shared = { reasoning, defaultTools: false, limits: { maxInputTokensPerSession: 400_000, maxOutputTokensPerSession: 12_000 } } as const;

// With ROS_ROUTER, System 1 chooses the model for every step (fast or strong).
export default process.env.ROS_ROUTER === '1'
  ? defineAgent({ ...shared, model: defineDynamic({ events: { 'step.started': async (_event, ctx) => ({ model: await routeStep(ctx.messages), reasoning }) } }) })
  : defineAgent({ ...shared, model: process.env.ROS_EXECUTIVE_MODEL || defaultExecutiveModel });
