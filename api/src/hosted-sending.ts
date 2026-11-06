import { sql } from 'drizzle-orm';
import { ApiError, type Config } from './core.js';

// SES counts destinations, not API calls. Only the exact AWS simulator domain is exempt;
// a real address mixed into To/Cc/Bcc still consumes a slot.
const simulatorSuffix = '@simulator.amazonses.com';
export const realDestination = (address: string) => !address.toLowerCase().endsWith(simulatorSuffix);
export const hostedCost = (to: string | string[], cc: string[] = [], bcc: string[] = []) =>
  [to].flat().concat(cc, bcc).filter(realDestination).length;

export type HostedAllowance = { cap: number; marketingCap: number; used: number; resetAt: string | null; nextChangeAt: string; pauseReason: string | null; pendingCapOverride: number | null };
// The current UTC hour plus the preceding 23 buckets. The same statement as admission,
// independent of how many envelopes or destinations were admitted in those hours.
export function hostedAllowance(config: Config, wid: string, incoming: number, marketing = 0) {
  if (!config.multiTenant) return sql<HostedAllowance | null>`NULL`;
  const { firstWeek, secondWeek, mature } = config.hostedSendCaps;
  return sql<HostedAllowance | null>`(SELECT jsonb_build_object('cap',c.cap,'marketingCap',m.cap,'used',usage.used,'resetAt',least(usage.next_expiry,c.next_tier),
    'nextChangeAt',least(c.next_tier,coalesce(usage.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours')),'pauseReason',c.pause_reason,'pendingCapOverride',c.pending_cap_override)
    FROM (SELECT pc.workspace_id,pc.pause_reason,w.pending_cap_override,coalesce(w.send_cap_override,CASE WHEN pc.created_at > now()-interval '7 days' THEN ${firstWeek}::int
      WHEN pc.created_at > now()-interval '14 days' THEN ${secondWeek}::int ELSE ${mature}::int END) AS cap,
      CASE WHEN w.send_cap_override IS NOT NULL THEN NULL WHEN pc.created_at > now()-interval '7 days' THEN pc.created_at+interval '7 days' WHEN pc.created_at > now()-interval '14 days' THEN pc.created_at+interval '14 days' END AS next_tier
      FROM provider_connections pc JOIN workspaces w ON w.id=pc.workspace_id WHERE pc.workspace_id=${wid} AND pc.kind='shared' FOR SHARE) c
    CROSS JOIN LATERAL (SELECT c.cap-ceil(c.cap*${config.dispatch.dailyHeadroomPercent}::numeric/100)::int AS cap) m
    CROSS JOIN LATERAL (SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
      max(hour) FILTER (WHERE running+least(${incoming}::int,c.cap)>c.cap OR (${marketing}::int>0 AND running+least(${marketing}::int,m.cap)>m.cap))+interval '24 hours' AS next_expiry FROM (
      SELECT hour,sum(recipients) OVER (ORDER BY hour DESC) AS running FROM hosted_usage_hourly WHERE workspace_id=c.workspace_id
        AND hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND recipients>0
        AND ${incoming > 0} AND c.pause_reason IS NULL) charged) usage)`;
}
export function assertHostedAllowance(allowance: HostedAllowance | null, incoming: number, marketing = 0) {
  if (!allowance) return;
  if (allowance.pauseReason) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', allowance.pauseReason);
  const reserved = marketing > 0 && marketing + allowance.used > allowance.marketingCap;
  if (incoming && (incoming + allowance.used > allowance.cap || reserved)) {
    const resetAt = allowance.resetAt ? new Date(allowance.resetAt).toISOString() : undefined;
    const retryable = incoming <= allowance.cap && marketing <= allowance.marketingCap;
    throw new ApiError(429, 'SEND_LIMIT_REACHED', `Hosted sending is limited to ${allowance.cap} recipients per rolling 24 hours.${reserved ? ` Marketing stops at ${allowance.marketingCap} to reserve transactional capacity.` : ''}${resetAt ? ` The next capacity change is at ${resetAt}.` : ''}${!retryable ? ' This submission exceeds the available limit.' : ''}`, undefined, retryable, resetAt);
  }
}
