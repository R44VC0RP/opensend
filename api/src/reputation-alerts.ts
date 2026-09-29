import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ApiError, log, type JobHandler, type Runtime } from './core.js';
import { jobs } from './db/core.js';
import { enqueue } from './jobs.js';
import { resolveRegionRuntime } from './ses-region-state.js';
import { readReputation } from './ses-setup.js';

// SES console thresholds. "Near" alerts fire at 80% of a threshold.
const THRESHOLDS = { bounceRate: { warning: 0.05, risk: 0.1 }, complaintRate: { warning: 0.001, risk: 0.005 } } as const;
const NEAR = 0.8;
const LEVELS = ['ok', 'near_warning', 'warning', 'near_risk', 'at_risk'] as const;
type Metric = keyof typeof THRESHOLDS;
type Level = typeof LEVELS[number];
const JOB = 'reputation.alert';

// Boundaries for each level above ok, lowest first.
function boundaries(metric: Metric) {
  const { warning, risk } = THRESHOLDS[metric];
  return [warning * NEAR, warning, risk * NEAR, risk];
}
function levelFor(metric: Metric, value: number): Level {
  return LEVELS[boundaries(metric).filter(boundary => value >= boundary).length]!;
}
// Anti-flapping: dropping a level requires falling 10% below that level's boundary.
const HYSTERESIS = 0.9;
function nextLevel(metric: Metric, value: number, previous: Level): Level {
  const raw = levelFor(metric, value), from = LEVELS.indexOf(previous);
  if (LEVELS.indexOf(raw) >= from) return raw;
  const bounds = boundaries(metric);
  let index = from;
  while (index > 0 && value < bounds[index - 1]! * HYSTERESIS) index--;
  return LEVELS[index]!;
}
// Escalations past the highest level alerted in the last 24 hours send immediately. Anything
// else waits 6 hours after the previous message and never repeats a level sent in the last day.
const COOLDOWN_MS = 6 * 3600_000;
const DAY_MS = 24 * 3600_000;

/**
 * Hourly: compares each region's latest SES reputation rates with the last alerted level and
 * queues one Slack alert per change. The alert jobs are the dedupe ledger; completed jobs expire
 * after 30 days, so a sustained elevated level re-alerts at most monthly. A per-metric advisory
 * lock keeps overlapping checks from queueing the same alert twice.
 */
export async function checkReputationAlerts(runtime: Runtime): Promise<number> {
  if (!runtime.config.reputationAlertUrl || !runtime.config.aws || !runtime.config.liveEnabled) return 0;
  const resolved = await resolveRegionRuntime(runtime);
  let queued = 0;
  for (const region of resolved.config.regions) {
    const cw = new CloudWatchClient({ region, credentials: runtime.config.aws, maxAttempts: 1, requestHandler: new FetchHttpHandler({ requestTimeout: 10000 }) });
    try {
      const reputation = await readReputation(cw, AbortSignal.timeout(20000));
      if (!reputation.available) { log('warn', { code: 'REPUTATION_ALERT_SKIPPED', region, message: reputation.reason }); continue; }
      for (const metric of Object.keys(THRESHOLDS) as Metric[]) {
        const value = reputation[metric];
        if (value == null) continue;
        if (await queueIfChanged(runtime, region, metric, value)) queued++;
      }
    } finally { cw.destroy(); }
  }
  return queued;
}

/** Pure alert decision. `history` is newest first. Returns null when no message should be sent. */
export function decideAlert(metric: Metric, value: number, history: { level: Level; at: number }[], now: number): { level: Level; previous: Level } | null {
  const previous = history[0]?.level ?? 'ok';
  const next = nextLevel(metric, value, previous);
  if (next === previous) return null;
  const lastDay = history.filter(entry => now - entry.at < DAY_MS)
  // Escalating past anything alerted in the last day always sends.
  if (LEVELS.indexOf(next) > Math.max(-1, ...lastDay.map(entry => LEVELS.indexOf(entry.level)))) return { level: next, previous };
  // Otherwise wait out the cooldown, and never repeat a level already sent in the last day.
  if (history[0] && now - history[0].at < COOLDOWN_MS) return null;
  if (lastDay.some(entry => entry.level === next)) return null;
  return { level: next, previous };
}

async function queueIfChanged(runtime: Runtime, region: string, metric: Metric, value: number) {
  const workspaceId = runtime.config.workspaceId;
  return runtime.db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${JOB}:${workspaceId}:${region}:${metric}`}))`);
    const recent = await tx.select({ payload: jobs.payload, createdAt: jobs.createdAt }).from(jobs)
      .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, JOB), sql`${jobs.payload}->>'region' = ${region}`, sql`${jobs.payload}->>'metric' = ${metric}`))
      .orderBy(desc(jobs.createdAt)).limit(24);
    const history = recent.map(row => ({ level: (LEVELS as readonly string[]).includes(String(row.payload.level)) ? row.payload.level as Level : 'ok' as Level, at: Date.parse(row.createdAt) }));
    const decision = decideAlert(metric, value, history, Date.now());
    if (!decision) return false;
    await enqueue(tx, { type: JOB, workspaceId, environment: 'live', payload: { region, metric, ...decision, value } });
    return true;
  });
}

const names: Record<Metric, string> = { bounceRate: 'Bounce rate', complaintRate: 'Complaint rate' };
const risingText: Record<Level, string> = { ok: 'back to normal', near_warning: 'nearing warning', warning: 'at warning', near_risk: 'nearing at-risk', at_risk: 'at risk' };
const fallingText: Record<Level, string> = { ok: 'back to normal', near_warning: 'below warning, still close', warning: 'below at-risk, still at warning', near_risk: 'below at-risk, still close', at_risk: 'at risk' };
const emoji: Record<Level, string> = { ok: ':white_check_mark:', near_warning: ':large_yellow_circle:', warning: ':warning:', near_risk: ':red_circle:', at_risk: ':rotating_light:' };
const percent = (value: number) => `${Number((value * 100).toFixed(2))}%`;

export function reputationAlertText(input: { region: string; metric: Metric; level: Level; previous: Level; value: number; publicUrl: string }) {
  const { warning, risk } = THRESHOLDS[input.metric];
  const rising = LEVELS.indexOf(input.level) > LEVELS.indexOf(input.previous);
  const title = `${emoji[input.level]} *${names[input.metric]} ${(rising ? risingText : fallingText)[input.level]}* · ${input.region}`;
  return `${title}\n${percent(input.value)} now  ·  warning ${percent(warning)}  ·  at risk ${percent(risk)}\n<${input.publicUrl}/settings?region=${encodeURIComponent(input.region)}|View in OpenSend>`;
}

const deliver: JobHandler = async (runtime, payload) => {
  const url = runtime.config.reputationAlertUrl;
  if (!url) return;
  const { region, metric, level, previous, value } = payload;
  if (typeof region !== 'string' || !(metric === 'bounceRate' || metric === 'complaintRate') || !LEVELS.includes(level as Level) || !LEVELS.includes(previous as Level) || typeof value !== 'number') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid reputation alert job.');
  const text = reputationAlertText({ region, metric, level: level as Level, previous: previous as Level, value, publicUrl: runtime.config.publicUrl });
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new ApiError(503, 'REPUTATION_ALERT_FAILED', `Slack rejected the reputation alert with HTTP ${response.status}.`, undefined, true);
};
export const reputationAlertJobs = { [JOB]: deliver };
