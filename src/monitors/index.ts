import type { MonitorFactory } from '../monitor.js';
import { divesMonitor } from './dives.js';
import { perceptionMonitor } from './perception.js';
import { coverageMonitor } from './coverage.js';
import { spidermonkeyMonitor } from './spidermonkey.js';

// Registry of always-on System 1 monitors, keyed by the name used in a tuning
// profile's `monitors` map. Add one entry per monitor module.
export const monitorFactories: Record<string, MonitorFactory> = {
  perception: perceptionMonitor,
  coverage: coverageMonitor,
  spidermonkey: spidermonkeyMonitor,
  dives: divesMonitor,
};
