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
  return sql<HostedAllowance | null>`(SELECT allowance FROM hosted_allowance(${wid},${incoming},${marketing},${firstWeek},${secondWeek},${mature},${config.dispatch.dailyHeadroomPercent}))`;
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
