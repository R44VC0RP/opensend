import { setTimeout } from 'node:timers/promises';
import { nodeRuntime } from './adapters/node.js';
import { drain } from './dispatch.js';
import type { GateState } from './dispatcher.js';
import { jobConcurrency } from './jobs.js';
import { cleanup } from './maintenance.js';
import { queueStartupDiscovery } from './ses-regions.js';
import { ApiError, log } from './core.js';
try {
  const { runtime, close } = nodeRuntime(process.env);
  const concurrency = jobConcurrency(process.env.JOB_CONCURRENCY);
  let stopped = false; let lastCleanup = 0;
  // In-process pacing state per environment/region. Run one runner per installation (or split
  // the quota explicitly): separate processes do not share this gate.
  const gates = new Map<string, GateState>();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopped = true; });
  log('info', { code: 'RUNNER_READY', liveSesEnabled: runtime.config.liveEnabled });
  try {
    await queueStartupDiscovery(runtime);
    while (!stopped) {
      try {
        if (Date.now() - lastCleanup > 3600000) { await cleanup(runtime); lastCleanup = Date.now(); }
        const count = await drain(runtime, concurrency * 10, concurrency, 5000, gates);
        if (!count) await setTimeout(1000);
      } catch (error) {
        log('error', { code: error instanceof ApiError ? error.code : 'RUNNER_FAILED', message: error instanceof ApiError ? error.message : 'Job polling failed. Check database connectivity and migrations.' });
        await setTimeout(5000);
      }
    }
  } finally { await close(); }
} catch (error) {
  log('error', { code: error instanceof ApiError ? error.code : 'STARTUP_FAILED', message: error instanceof ApiError ? error.message : 'Runner startup failed.' });
  process.exitCode = 1;
}
