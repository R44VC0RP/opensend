import { sql } from 'drizzle-orm';
import { ApiError, type Config } from './core.js';

// SES counts destinations, not API calls. Only the exact AWS simulator domain is exempt;
// a real address mixed into To/Cc/Bcc still consumes a slot.
const simulatorSuffix = '@simulator.amazonses.com';
export const hostedCost = (to: string | string[], cc: string[] = [], bcc: string[] = []) =>
  [to].flat().concat(cc, bcc).filter(address => !address.toLowerCase().endsWith(simulatorSuffix)).length;
export const realDestinations = sql`(SELECT count(*)::int FROM jsonb_array_elements_text(e.to_addresses || e.cc_addresses || e.bcc_addresses) dest WHERE lower(dest) NOT LIKE ${'%' + simulatorSuffix})`;
// A workspace may have switched providers in this window. Dispatched BYO mail has its own
// SNS topic; queued mail has no topic yet and cannot survive a connection switch.
export const hostedMail = sql`(e.feedback_topic_arn IS NULL OR e.feedback_topic_arn IN (SELECT feedback_topic_arn FROM provider_pool_regions WHERE feedback_topic_arn IS NOT NULL))`;

export type HostedAllowance = { cap: number; used: number; resetAt: string | null; pauseReason: string | null };
// Embedded in the existing post-lock capacity read, never its own round trip. Scope the
// scan to a shared connection and the existing (workspace_id, created_at) index. A queued
// acceptance reserves its destinations immediately; suppression/definitive failure frees them.
export function hostedAllowance(config: Config, wid: string, incoming: number) {
  if (!config.multiTenant) return sql<HostedAllowance | null>`NULL`;
  const { firstWeek, secondWeek, mature } = config.hostedSendCaps;
  return sql<HostedAllowance | null>`(SELECT jsonb_build_object('cap',c.cap,'used',usage.used,'resetAt',least(usage.next_expiry,c.next_tier),'pauseReason',c.pause_reason)
    FROM (SELECT workspace_id,pause_reason,CASE WHEN created_at > now()-interval '7 days' THEN ${firstWeek}::int
      WHEN created_at > now()-interval '14 days' THEN ${secondWeek}::int ELSE ${mature}::int END AS cap,
      CASE WHEN created_at > now()-interval '7 days' THEN created_at+interval '7 days' WHEN created_at > now()-interval '14 days' THEN created_at+interval '14 days' END AS next_tier
      FROM provider_connections WHERE workspace_id=${wid} AND kind='shared' FOR SHARE) c
    CROSS JOIN LATERAL (SELECT coalesce(max(running),0) AS used,
      max(created_at) FILTER (WHERE running+least(${incoming}::int,c.cap)>c.cap)+interval '24 hours' AS next_expiry FROM (
      SELECT e.created_at,sum(${realDestinations}) OVER (ORDER BY e.created_at DESC) AS running FROM sending_emails e WHERE e.workspace_id=c.workspace_id AND NOT e.simulated
        AND e.created_at > now()-interval '24 hours' AND e.status NOT IN ('suppressed','canceled','simulated')
        AND (e.provider_id IS NOT NULL OR e.status NOT IN ('rejected','rendering_failed'))
        AND ${hostedMail} AND ${incoming > 0} AND c.pause_reason IS NULL) charged) usage)`;
}
export function assertHostedAllowance(allowance: HostedAllowance | null, incoming: number) {
  if (!allowance) return;
  if (allowance.pauseReason) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', allowance.pauseReason);
  if (incoming && incoming + allowance.used > allowance.cap) {
    const resetAt = allowance.resetAt ? new Date(allowance.resetAt).toISOString() : undefined;
    throw new ApiError(429, 'SEND_LIMIT_REACHED', `Hosted sending is limited to ${allowance.cap} recipients per rolling 24 hours.${resetAt ? ` The next capacity change is at ${resetAt}.` : ''}${incoming > allowance.cap ? ' Split the submission into smaller batches.' : ''}`, undefined, incoming <= allowance.cap, resetAt);
  }
}
