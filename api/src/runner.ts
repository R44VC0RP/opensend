import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';
import { nodeRuntime, postgresConnection } from './adapters/node.js';
import { drain } from './dispatch.js';
import type { GateState } from './dispatcher.js';
import { jobConcurrency } from './jobs.js';
import { cleanup } from './maintenance.js';
import { checkReputationAlerts } from './reputation-alerts.js';
import { reconcileSharedConnections } from './provider-connections.js';
import { mailboxHourly } from './mailbox-ingest.js';
import { syncOutboundMessages } from './mailbox-send.js';
import { queueStartupDiscovery } from './ses-regions.js';
import { ApiError, log } from './core.js';
try {
  const { runtime, close } = nodeRuntime(process.env);
  const concurrency = jobConcurrency(process.env.JOB_CONCURRENCY);
  let stopped = false; let lastCleanup = 0; let lastOutboundSync = 0; let lastRecovery = 0;
  let sharedSetup: Promise<void> | undefined, lastSharedSetup = 0;
  // In-process pacing state per account/region. Run one runner per installation (or split
  // the quota explicitly): separate processes do not share this gate.
  const gates = new Map<string, GateState>();
  // LISTEN requires a session connection, not a checked-out query/transaction connection. Losing
  // this best-effort nudge only costs latency: ordinary leases still discover every due row.
  const priorityWake = new EventTarget();
  let listener: Client | undefined, lastListen = 0;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopped = true; });
  log('info', { code: 'RUNNER_READY', liveSesEnabled: runtime.config.liveEnabled });
  try {
    await queueStartupDiscovery(runtime);
    while (!stopped) {
      try {
        if (!listener && Date.now() - lastListen >= 15000) {
          lastListen = Date.now();
          const client = new Client(postgresConnection(process.env.DATABASE_URL));
          client.on('notification', msg => { if (msg.payload) priorityWake.dispatchEvent(new Event(msg.payload)); });
          client.on('error', () => log('warn', { code: 'DISPATCH_LISTENER_FAILED', message: 'Priority wakes disconnected; ordinary leases continue.' }));
          client.on('end', () => { if (listener === client) listener = undefined; });
          try { await client.connect(); await client.query('LISTEN opensend_priority'); listener = client; }
          catch { await client.end(); }
        }
        // Don't stall mail dispatch while waiting for a platform pool to come online.
        if (runtime.config.multiTenant && !sharedSetup && Date.now() - lastSharedSetup >= 60_000) {
          lastSharedSetup = Date.now();
          sharedSetup = reconcileSharedConnections(runtime).catch(() => log('warn', { code: 'SHARED_SETUP_FAILED' })).finally(() => { sharedSetup = undefined; });
        }
        if (Date.now() - lastCleanup > 3600000) {
          await cleanup(runtime); lastCleanup = Date.now();
          try { await checkReputationAlerts(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'REPUTATION_ALERT_CHECK_FAILED' }); }
          await mailboxHourly(runtime);
        }
        if (Date.now() - lastOutboundSync > 15000) {
          lastOutboundSync = Date.now();
          try { await syncOutboundMessages(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'MAILBOX_OUTBOUND_SYNC_FAILED' }); }
        }
        const recover = Date.now() - lastRecovery >= 60_000;
        const count = await drain(runtime, concurrency * 10, concurrency, 5000, gates, recover, priorityWake);
        if (recover) lastRecovery = Date.now();
        if (!count) await setTimeout(1000);
      } catch (error) {
        log('error', { code: error instanceof ApiError ? error.code : 'RUNNER_FAILED', message: error instanceof ApiError ? error.message : 'Job polling failed. Check database connectivity and migrations.' });
        await setTimeout(5000);
      }
    }
  } finally { await sharedSetup; await listener?.end(); await close(); }
} catch (error) {
  log('error', { code: error instanceof ApiError ? error.code : 'STARTUP_FAILED', message: error instanceof ApiError ? error.message : 'Runner startup failed.' });
  process.exitCode = 1;
}
