import { DurableObject } from 'cloudflare:workers';
import type { Pool } from 'pg';
import type { GateState } from './dispatcher.js';
import type { Runtime } from './core.js';

function initDeps() {
  return Promise.all([
    import('pg'), import('drizzle-orm/node-postgres'), import('drizzle-orm/sql'),
    import('./config.js'), import('./adapters/storage.js'), import('./dispatcher.js'),
    import('./core.js'), import('./adapters/feedback-queue.js'),
  ]).then(([{ Pool }, { drizzle }, { sql }, { loadConfig }, { r2Storage }, { initialGate, runDispatcher, dispatchWakeKey }, { ApiError, log }, { feedbackSink, workWake }]) => ({
    Pool, drizzle, sql, loadConfig, r2Storage, initialGate, runDispatcher, dispatchWakeKey, ApiError, log, feedbackSink, workWake,
  }));
}
let depsPromise: ReturnType<typeof initDeps> | undefined;
function loadDeps() {
  return depsPromise ??= initDeps().catch(error => { depsPromise = undefined; throw error; });
}

// One Durable Object per account/region/shard hosts the dispatcher loop. The object
// keeps its database pool and pacing state across alarms, so a busy region never pays the
// per-invocation setup the queue consumer did, and an evicted object resumes from storage
// without bursting past its quota share. PostgreSQL rows remain the only queue.

type Identity = { region: string; accountId?: string; shard: { index: number; count: number } };
const RUN_MS = 45000;      // Re-arm well inside the alarm wall-clock and default CPU budgets.
const RETRY_MS = 15000;    // Dependency failure (database, quota) backoff.

export function dispatcherName(identity: Identity) { return `dispatcher:${identity.accountId ? `${identity.accountId}:` : ''}${identity.region}:${identity.shard.index}/${identity.shard.count}`; }
export function shardCount(value: unknown) { const n = Number(value); return Number.isInteger(n) && n >= 1 ? Math.min(n, 256) : 1; }

export class DispatcherShard extends DurableObject<Env> {
  private pool?: Pool;
  private running = false;
  private priorityWake = new EventTarget();
  private gate?: GateState;
  private identity?: Identity;
  private placementLogged = false;

  // Once per persisted shard, after its first dispatch: where it runs and the cost of one DB round trip.
  // The location hint is only honored at creation, so this is the record of where the object actually landed.
  private async logPlacement(identity: Identity, runtime: Runtime) {
    try {
      if (await this.ctx.storage.get('placementLogged')) return;
      const { sql, log } = await loadDeps();
      const trace = await (await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(2000) })).text();
      const colo = trace.match(/^colo=(\w+)/m)?.[1] ?? 'unknown';
      const timed = async (work: () => Promise<unknown>) => { const at = Date.now(); await work(); return Date.now() - at; };
      const dbPingMs = await timed(() => runtime.db.execute(sql`SELECT 1`));
      const dbPingAgainMs = await timed(() => runtime.db.execute(sql`SELECT 1`));
      // The dispatcher's statements carry ~20 KB JSON parameters; measure that shape separately from a bare round trip.
      const payload = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ id: `probe_${i}`, snapshot: 'x'.repeat(3000) })));
      const dbPayloadMs = await timed(() => runtime.db.execute(sql`SELECT count(*) FROM jsonb_to_recordset(${payload}::jsonb) AS x(id text, snapshot text)`));
      const dbPayloadAgainMs = await timed(() => runtime.db.execute(sql`SELECT count(*) FROM jsonb_to_recordset(${payload}::jsonb) AS x(id text, snapshot text)`));
      log('info', { code: 'DISPATCHER_PLACEMENT', shard: dispatcherName(identity), colo, dbPingMs, dbPingAgainMs, dbPayloadMs, dbPayloadAgainMs, payloadBytes: payload.length });
      await this.ctx.storage.put('placementLogged', true);
    } catch { /* diagnostics only */ }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/wake' || url.searchParams.has('environment')) return new Response('Not found', { status: 404 });
    const identity: Identity = {
      region: url.searchParams.get('region') ?? '',
      accountId: url.searchParams.get('account') ?? undefined,
      shard: { index: Number(url.searchParams.get('shard') ?? 0), count: Math.max(1, Number(url.searchParams.get('count') ?? 1)) },
    };
    if (!identity.region) return new Response('region required', { status: 400 });
    if (!this.identity || dispatcherName(this.identity) !== dispatcherName(identity)) {
      await this.ctx.storage.put('identity', identity);
      this.identity = identity;
    }
    if (!this.running) {
      this.ctx.waitUntil(this.alarm());
    } else {
      if (url.searchParams.get('priority') === '1') {
        const { dispatchWakeKey } = await loadDeps();
        this.priorityWake.dispatchEvent(new Event(dispatchWakeKey(identity.region, identity.accountId)));
      }
      // The running loop may already have taken its last lease. Keep a durable follow-up.
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > Date.now()) await this.ctx.storage.setAlarm(Date.now());
    }
    return Response.json({ ok: true, running: this.running });
  }

  async alarm(): Promise<void> {
    const identity = this.identity ??= await this.ctx.storage.get<Identity>('identity');
    if (!identity || 'environment' in identity) return; // Retire alarms from the old shard names.
    if (this.running) { await this.ctx.storage.setAlarm(Date.now() + 1000); return; }
    this.running = true;
    const started = Date.now();
    let deps: Awaited<ReturnType<typeof loadDeps>> | undefined;
    try {
      deps = await loadDeps();
      const { initialGate, runDispatcher } = deps;
      this.gate ??= (await this.ctx.storage.get<GateState>('gate')) ?? initialGate();
      const runtime = await this.runtime();
      // An alarm persisted by an older MX deployment must not drain an unpartitioned region.
      if (runtime.config.multiTenant && !identity.accountId) return;
      const report = await runDispatcher(runtime, {
        ...identity, gate: this.gate, priorityWake: this.priorityWake,
        until: started + RUN_MS, lanes: 2, batchSize: 24, sendConcurrency: 6,
        onGate: async state => { await this.ctx.storage.put('gate', state); },
      });
      if (!this.placementLogged) { this.placementLogged = true; this.ctx.waitUntil(this.logPlacement(identity, runtime)); }
      // Work remained when the run budget ended: continue immediately. Otherwise sleep until the
      // next API nudge or the scheduler's minute ping; queued mail never depends on this alarm alone.
      if (!report.idle) await this.ctx.storage.setAlarm(Date.now());
      else {
        const retry = Math.min(report.quotaRetryAt ?? Infinity, report.paceRetryAt ?? Infinity);
        if ((await this.ctx.storage.getAlarm() ?? Infinity) > retry) await this.ctx.storage.setAlarm(retry);
      }
    } catch (error) {
      // Module loading itself can fail; still log, close and retry so the shard never wedges.
      if (!deps) console.error('DISPATCHER_DEPS_FAILED', error);
      else { const { ApiError, log } = deps;
      log('error', { code: error instanceof ApiError ? error.code : 'DISPATCHER_RUN_FAILED', shard: dispatcherName(identity), message: error instanceof ApiError ? error.message : 'Dispatcher run failed; retrying.', stack: error instanceof Error && !(error instanceof ApiError) ? error.stack?.split('\n').slice(1, 4).join('\n') : undefined }); }
      await this.closePool();
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    } finally {
      this.running = false;
    }
  }

  private async runtime(): Promise<Runtime> {
    const { Pool, drizzle, loadConfig, r2Storage, feedbackSink, workWake } = await loadDeps();
    const config = loadConfig({ ...this.env });
    // A small persistent pool: claims are sequential per lane and provider calls do not hold connections.
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max: 2, idleTimeoutMillis: 30000 });
      this.pool.on('error', () => { /* Idle client errors surface on the next query; the run loop then recreates the pool. */ });
    }
    return { db: drizzle(this.pool), storage: r2Storage(this.env.ATTACHMENTS), config, feedback: feedbackSink(this.env.FEEDBACK_QUEUE), wake: workWake(this.env.WAKE_QUEUE, 6) };
  }

  private async closePool() {
    const pool = this.pool; this.pool = undefined;
    try { await pool?.end(); } catch { /* already closed */ }
  }
}
