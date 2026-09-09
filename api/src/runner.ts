import { setTimeout } from 'node:timers/promises';
import { nodeRuntime } from './adapters/node.js';
import { drain } from './dispatch.js';
import { cleanup } from './maintenance.js';
import { ApiError, log } from './core.js';
try {
  const { runtime, close } = nodeRuntime(process.env);
  let stopped = false; let lastCleanup = 0;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopped = true; });
  log('info', { code: 'RUNNER_READY', liveSesEnabled: runtime.config.liveEnabled });
  try {
    while (!stopped) {
      try {
        if (Date.now() - lastCleanup > 3600000) { await cleanup(runtime); lastCleanup = Date.now(); }
        const count = await drain(runtime);
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
