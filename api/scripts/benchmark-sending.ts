import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { digest, id, type Runtime } from '../src/core.js';
import { drain } from '../src/dispatch.js';

// Deliberately refuses production, existing development databases and real AWS.
const url = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname.startsWith('/opensend_perf_'), 'Use a dedicated local opensend_perf_ database.');
assert(String(process.env.ENABLE_LIVE_SES) === 'false' && !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_SECRET_ACCESS_KEY, 'Disable live SES and remove AWS credentials.');
const count = Number(process.env.BENCHMARK_RECIPIENTS ?? 1000);
const replicas = Number(process.env.BENCHMARK_REPLICAS ?? 4);
const lanes = Number(process.env.BENCHMARK_LANES ?? 6);
assert(Number.isInteger(count) && count >= 1 && count <= 1000, 'Benchmark count must be 1–1,000.');
assert(Number.isInteger(replicas) && replicas >= 1 && replicas <= 64);
assert(Number.isInteger(lanes) && lanes >= 1 && lanes <= 8);
const pool = new Pool({ connectionString: url.href, max: Number(process.env.BENCHMARK_CONNECTIONS ?? 24) });
const db = drizzle(pool);
const config = loadConfig(process.env);
const runId = id('benchmark');
let queries = 0, queryMs = 0;
// Count driver calls including transactional clients; never collect SQL values.
const measured = new WeakSet<object>();
pool.on('connect', client => {
  if (measured.has(client)) return;
  measured.add(client);
  const original = client.query.bind(client);
  client.query = ((...args: any[]) => {
    const start = performance.now(); queries++;
    const last = args.at(-1);
    if (typeof last === 'function') {
      args[args.length - 1] = (...values: any[]) => { queryMs += performance.now() - start; return last(...values); };
      return (original as any)(...args);
    }
    const result = (original as any)(...args);
    if (result?.finally) return result.finally(() => { queryMs += performance.now() - start; });
    return result;
  }) as typeof client.query;
});
const runtime: Runtime = { db, config, storage: {
  async get() { throw new Error('This benchmark uses no attachments.'); },
  async put() { throw new Error('Unexpected attachment write.'); },
  async delete() { throw new Error('Unexpected attachment delete.'); },
} };
const app = createApp();
const stats: Record<string, { count: number; totalMs: number }> = {};
const phases: Record<string, number[]> = {};
const log = console.info;
console.info = (...args) => {
  try {
    const record = JSON.parse(String(args[0]));
    if (record.code === 'DISPATCH_TIMINGS') {
      for (const [name, value] of Object.entries(record.timings ?? {})) if (typeof value === 'number') (phases[name] ??= []).push(value);
    }
    if (record.code === 'JOB_COMPLETED') {
      const stat = stats[record.operation] ??= { count: 0, totalMs: 0 };
      stat.count++; stat.totalMs += record.jobMs ?? 0;
    }
  } catch { /* Do not persist arbitrary logs or message content. */ }
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let stop = false;
let pumpError: unknown;
const pumps: Promise<void>[] = [];
try {
  const active = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE status IN ('pending','running')");
  assert.equal(active.rows[0].n, 0, 'Previous workload must drain before measuring.');
  // No active work exists; discard this isolated run's cached simulated quota.
  await pool.query("DELETE FROM sending_region_limits WHERE workspace_id='default' AND environment='test'");
  const keyId = id('key'), secret = `os_test_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  await pool.query("INSERT INTO api_keys(id,workspace_id,environment,name,hash,prefix,permissions,domains) VALUES($1,'default','test',$2,$3,'os_test_', '[\"read\",\"send\",\"manage\"]','[]')", [keyId, runId, await digest(secret)]);
  const listId = id('lst');
  await pool.query("INSERT INTO audience_lists(id,workspace_id,environment,name) VALUES($1,'default','test',$2)", [listId, runId]);
  await pool.query(`WITH inserted AS (
    INSERT INTO audience_contacts(id,workspace_id,environment,email,marketing_consent,properties)
    SELECT $1 || '-' || n, 'default','test',$1 || '-' || n || '@example.invalid','subscribed','{}'::jsonb FROM generate_series(1,$2::int) n RETURNING id
  ) INSERT INTO audience_list_members(workspace_id,environment,list_id,contact_id) SELECT 'default','test',$3,id FROM inserted`, [runId, count, listId]);
  const call = async (path: string, body: unknown) => {
    const response = await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, runtime);
    const value = await response.json() as any;
    assert(response.ok, `API ${path}: ${value.error?.code ?? response.status}`);
    return value;
  };
  const campaign = await call('/v1/campaigns', { name: runId, from: 'sender@example.invalid', region: config.regions[0], subject: 'Synthetic benchmark', html: '<p>Synthetic performance benchmark.</p>', audience: { listId }, tracking: false });
  queries = 0; queryMs = 0;
  const start = performance.now();
  const receipt = await call(`/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision });
  assert.equal(receipt.queued, count);
  const requestMs = performance.now() - start;
  for (let replica = 0; replica < replicas; replica++) pumps.push((async () => {
    try {
      while (!stop) {
        const n = await drain(runtime, 100, lanes);
        if (!n) await sleep(250);
      }
    } catch (error) { pumpError = error; stop = true; }
  })());
  let allAcceptedMs: number | null = null, completedMs: number | null = null;
  const deadline = performance.now() + 180_000;
  while (performance.now() < deadline) {
    if (pumpError) throw pumpError;
    const progress = await pool.query(`SELECT count(*) FILTER (WHERE provider_id IS NOT NULL)::int AS accepted,
      count(*) FILTER (WHERE status='delivered')::int AS delivered,
      count(*) FILTER (WHERE status IN ('rejected','acceptance_unknown','canceled','suppressed'))::int AS failed
      FROM sending_emails WHERE campaign_id=$1`, [campaign.id]);
    assert.equal(progress.rows[0].failed, 0, 'Benchmark has a terminal send failure.');
    if (progress.rows[0].accepted === count && allAcceptedMs === null) allAcceptedMs = performance.now() - start;
    if (progress.rows[0].delivered === count) {
      const pending = await pool.query("SELECT count(*)::int AS n FROM jobs WHERE status IN ('pending','running')");
      if (pending.rows[0].n === 0) { completedMs = performance.now() - start; break; }
    }
    await sleep(100);
  }
  assert(allAcceptedMs !== null && completedMs !== null, 'Timed out before acceptance, simulated feedback, and publication drained.');
  stop = true;
  await Promise.all(pumps);
  const acceptance = await pool.query(`SELECT extract(epoch FROM ev.created_at)*1000 AS at FROM sending_email_events ev JOIN sending_emails e ON e.id=ev.email_id
    WHERE e.campaign_id=$1 AND ev.type='accepted' ORDER BY ev.created_at`, [campaign.id]);
  const times = acceptance.rows.map(row => Number(row.at));
  assert.equal(times.length, count);
  const windows = [];
  for (let t = times[0]!; t + 1000 <= times.at(-1)!; t += 1000) windows.push(times.filter(at => at >= t && at < t + 1000).length);
  const materialized = await pool.query('SELECT extract(epoch FROM created_at)*1000 AS at,count(*)::int AS n FROM sending_emails WHERE campaign_id=$1 GROUP BY created_at ORDER BY created_at', [campaign.id]);
  const timeline = [...materialized.rows.map(row => ({ at: Number(row.at), delta: Number(row.n) })), ...times.map(at => ({ at, delta: -1 }))].sort((a,b) => a.at-b.at || b.delta-a.delta);
  let pending = 0, emptyMs = 0, lastAt = timeline[0]!.at;
  for (const point of timeline) { if (pending === 0) emptyMs += point.at-lastAt; pending += point.delta; lastAt=point.at; }
  const result = { runId, campaignId: campaign.id, simulated: true, count, replicas, lanes,
    pendingBufferEmptyMs: emptyMs, materializationBatches: materialized.rows.map(row => ({ at: Number(row.at), count: row.n })),
    rate: config.simulatedSes.maxSendRate, latencyMs: config.simulatedSes.latencyMs,
    requestMs, allAcceptedMs, feedbackAndPublicationDrainedMs: completedMs,
    overallAcceptedPerSecond: count * 1000 / allAcceptedMs,
    activeAcceptedPerSecond: (count - 1) * 1000 / (times.at(-1)! - times[0]!),
    completeOneSecondWindows: windows, driverQueries: queries, aggregateDriverMs: queryMs, jobStats: stats,
    phases: Object.fromEntries(Object.entries(phases).map(([name, values]) => {
      values.sort((a,b) => a-b);
      return [name, { count: values.length, mean: values.reduce((a,b) => a+b,0)/values.length, p50: values[Math.floor(values.length*0.5)], p95: values[Math.min(values.length-1,Math.floor(values.length*0.95))] }];
    })),
    limitations: ['Node local database, not Cloudflare/Hyperdrive.', '1000-recipient runs at high rates are short capacity probes, not sustained throughput certification.', 'Real SDK/dispatch/feedback storage; synthetic provider does not validate content like AWS or verify SNS signatures.'] };
  if (process.env.BENCHMARK_REPORT) await writeFile(process.env.BENCHMARK_REPORT, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} finally {
  stop = true;
  await Promise.allSettled(pumps);
  console.info = log;
  await pool.end();
}
