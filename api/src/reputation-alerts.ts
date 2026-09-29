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

function levelFor(metric: Metric, value: number): Level {
  const { warning, risk } = THRESHOLDS[metric];
  if (value >= risk) return 'at_risk';
  if (value >= risk * NEAR) return 'near_risk';
  if (value >= warning) return 'warning';
  if (value >= warning * NEAR) return 'near_warning';
  return 'ok';
}

/**
 * Hourly: compares each region's latest SES reputation rates with the last alerted level and
 * queues one Slack alert per change. The alert jobs double as the dedupe ledger; completed
 * jobs expire after 30 days, so a sustained elevated level re-alerts at most monthly.
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
        const level = levelFor(metric, value);
        const [last] = await runtime.db.select({ payload: jobs.payload }).from(jobs)
          .where(and(eq(jobs.workspaceId, runtime.config.workspaceId), eq(jobs.type, JOB), sql`${jobs.payload}->>'region' = ${region}`, sql`${jobs.payload}->>'metric' = ${metric}`))
          .orderBy(desc(jobs.availableAt)).limit(1);
        const previous = (LEVELS as readonly string[]).includes(String(last?.payload.level)) ? last!.payload.level as Level : 'ok';
        if (level === previous) continue;
        await enqueue(runtime.db, { type: JOB, workspaceId: runtime.config.workspaceId, environment: 'live', payload: { region, metric, level, previous, value } });
        queued++;
      }
    } finally { cw.destroy(); }
  }
  return queued;
}

const names: Record<Metric, string> = { bounceRate: 'bounce rate', complaintRate: 'complaint rate' };
const risingText: Record<Level, string> = { ok: 'is back to normal', near_warning: 'is nearing the warning threshold', warning: 'reached the warning threshold', near_risk: 'is nearing the at-risk threshold', at_risk: 'reached the at-risk threshold' };
const fallingText: Record<Level, string> = { ok: 'is back to normal', near_warning: 'dropped below the warning threshold but is still close', warning: 'dropped below the at-risk range but is still past warning', near_risk: 'dropped below the at-risk threshold but is still close', at_risk: 'reached the at-risk threshold' };
const emoji: Record<Level, string> = { ok: ':white_check_mark:', near_warning: ':large_yellow_circle:', warning: ':warning:', near_risk: ':red_circle:', at_risk: ':rotating_light:' };
const percent = (value: number) => `${Number((value * 100).toFixed(3))}%`;

export function reputationAlertText(input: { region: string; metric: Metric; level: Level; previous: Level; value: number; publicUrl: string }) {
  const { warning, risk } = THRESHOLDS[input.metric];
  const rising = LEVELS.indexOf(input.level) > LEVELS.indexOf(input.previous);
  const phrase = (rising ? risingText : fallingText)[input.level];
  return `${emoji[input.level]} SES ${names[input.metric]} in ${input.region} ${phrase}: *${percent(input.value)}* (warning ${percent(warning)}, at risk ${percent(risk)}). <${input.publicUrl}/settings?region=${encodeURIComponent(input.region)}|View in OpenSend>`;
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
