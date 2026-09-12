import { DurableObject } from 'cloudflare:workers';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadConfig } from './config.js';
import { r2Storage } from './adapters/storage.js';
import { resolveRegionRuntime } from './ses-region-state.js';
import { initialGate, runDispatcher, type GateState } from './dispatcher.js';
import { ApiError, log, type Mode, type Runtime } from './core.js';
import { feedbackSink } from './adapters/feedback-queue.js';

// One Durable Object per environment/region/shard hosts the dispatcher loop. The object
// keeps its database pool and pacing state across alarms, so a busy region never pays the
// per-invocation setup the queue consumer did, and an evicted object resumes from storage
// without bursting past its quota share. PostgreSQL rows remain the only queue.

type Identity = { environment: Mode; region: string; shard: { index: number; count: number } };
const RUN_MS = 45000;      // Re-arm well inside the alarm wall-clock and default CPU budgets.
const RETRY_MS = 15000;    // Dependency failure (database, quota) backoff.

export function dispatcherName(identity: Identity) { return `dispatcher:${identity.environment}:${identity.region}:${identity.shard.index}/${identity.shard.count}`; }
export function shardCount(value: unknown) { const n = Number(value); return Number.isInteger(n) && n >= 1 ? Math.min(n, 256) : 1; }

export class DispatcherShard extends DurableObject<Env> {
  private pool?: Pool;
  private running = false;
  private gate?: GateState;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/wake') return new Response('Not found', { status: 404 });
    const identity: Identity = {
      environment: url.searchParams.get('environment') === 'live' ? 'live' : 'test',
      region: url.searchParams.get('region') ?? '',
      shard: { index: Number(url.searchParams.get('shard') ?? 0), count: Math.max(1, Number(url.searchParams.get('count') ?? 1)) },
    };
    if (!identity.region) return new Response('region required', { status: 400 });
    await this.ctx.storage.put('identity', identity);
    // An alarm during a run is harmless: it re-checks for work after the current run returns.
    if (!this.running && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return Response.json({ ok: true, running: this.running });
  }

  async alarm(): Promise<void> {
    const identity = await this.ctx.storage.get<Identity>('identity');
    if (!identity) return;
    if (this.running) { await this.ctx.storage.setAlarm(Date.now() + 1000); return; }
    this.running = true;
    const started = Date.now();
    try {
      this.gate ??= (await this.ctx.storage.get<GateState>('gate')) ?? initialGate();
      const runtime = await this.runtime();
      const report = await runDispatcher(runtime, {
        environment: identity.environment, region: identity.region, shard: identity.shard, gate: this.gate,
        until: started + RUN_MS, lanes: 2, batchSize: 24, sendConcurrency: 6,
        onGate: async state => { await this.ctx.storage.put('gate', state); },
      });
      // Work remained when the run budget ended: continue immediately. Otherwise sleep until the
      // next API nudge or the scheduler's minute ping; queued mail never depends on this alarm alone.
      if (!report.idle) await this.ctx.storage.setAlarm(Date.now());
    } catch (error) {
      log('error', { code: error instanceof ApiError ? error.code : 'DISPATCHER_RUN_FAILED', shard: dispatcherName(identity), message: error instanceof ApiError ? error.message : 'Dispatcher run failed; retrying.', stack: error instanceof Error && !(error instanceof ApiError) ? error.stack?.split('\n').slice(1, 4).join('\n') : undefined });
      await this.closePool();
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    } finally {
      this.running = false;
    }
  }

  private async runtime(): Promise<Runtime> {
    const config = loadConfig({ ...this.env });
    // A small persistent pool: claims are sequential per lane and provider calls do not hold connections.
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max: 4, idleTimeoutMillis: 30000 });
      this.pool.on('error', () => { /* Idle client errors surface on the next query; the run loop then recreates the pool. */ });
    }
    const base: Runtime = { db: drizzle(this.pool), storage: r2Storage(this.env.ATTACHMENTS), config, feedback: feedbackSink(this.env.FEEDBACK_QUEUE) };
    return resolveRegionRuntime(base);
  }

  private async closePool() {
    const pool = this.pool; this.pool = undefined;
    try { await pool?.end(); } catch { /* already closed */ }
  }
}
