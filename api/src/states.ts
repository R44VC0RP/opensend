import { sql, type SQL } from 'drizzle-orm';
import type { GetEmailIdentityCommandOutput } from '@aws-sdk/client-sesv2';
import { ApiError, id, type DbExecutor } from './core.js';
import type { MxReport } from './db/mailbox.js';

// Every MX entity has one explicit state column, and this module is the only writer of those columns.
// Readers use the predicates below instead of spelling out state names; transitions are pure
// functions applied by the statements at the bottom, so a state can never be half-written.

export const SENDING_STATES = ['pending', 'verified', 'lost', 'failed'] as const;
export const RECEIVING_STATES = ['off', 'pending', 'active', 'lost'] as const;
export const CONNECTION_STATES = ['awaiting_role', 'provisioning', 'ready', 'failed'] as const;
export const TENANT_STATES = ['pending', 'ready', 'failed'] as const;
export const POOL_STATES = ['pending', 'ready'] as const;
export type SendingState = typeof SENDING_STATES[number];
export type ReceivingState = typeof RECEIVING_STATES[number];
export type ConnectionState = typeof CONNECTION_STATES[number];
export type TenantState = typeof TENANT_STATES[number];
export type PoolState = typeof POOL_STATES[number];

/** `lost` is a grace period: proof went missing, the claim keeps working, and a later check either restores it or expires it. */
export const LOST_GRACE_MS = 2 * 3_600_000;

/** Facts from the last SES read and DNS observation. Never a state: every boolean the API shows is derived from the state columns. */
export type IdentityFacts = {
  ses: Pick<GetEmailIdentityCommandOutput, 'VerificationStatus' | 'VerifiedForSendingStatus' | 'DkimAttributes' | 'MailFromAttributes'>;
  proven: boolean; mx: MxReport | null; note: string | null;
  /** Verified by the exclusive BYO account, not an identity managed by the claim's ownership tag. */
  imported?: true;
};
export type ClaimState = { sending_state: SendingState; receiving_state: ReceivingState; receiving_host: string | null; lost_since: string | null; receiving_lost_since: string | null };
export type ClaimEvidence = {
  /** DKIM signed, ownership proven and SES verified for sending; undefined when SES was not read (MX-only upkeep). */
  sending: boolean | undefined;
  /** SES directly revoked an imported domain's sending/DKIM capability (no ownership grace on that evidence). */
  sendingRevoked?: boolean;
  /** The SES identity exists but is not this claim's: terminal until the domain is added again. */
  unavailable?: boolean;
  /** The SES identity itself is gone: no grace, nothing to hold on to. */
  definitive?: boolean;
  /** SES VerificationStatus SUCCESS (receiving needs the identity, not DKIM). */
  identityVerified: boolean;
  /** The `_opensend` TXT proof (or, for BYO, the identity verification) was observed. */
  proven: boolean;
  /** The region can receive at all: the pool's catch-all is ready, or the connection is BYO. */
  regionReceives: boolean;
  /** Receiving host with our MX; null when none; undefined when MX was not checked this time. */
  observedHost: string | null | undefined;
  byo: boolean;
};

// Predicates. `dc`/`pc`/`p` are the aliases used by the surrounding statement.
export const claimSends = (dc: SQL = sql`dc`) => sql`${dc}.sending_state IN ('verified','lost')`;
export const claimReceives = (dc: SQL = sql`dc`) => sql`${dc}.receiving_state IN ('active','lost')`;
export const claimReceivable = (dc: SQL = sql`dc`) => sql`${dc}.receiving_state<>'off'`;
export const connectionReady = (pc: SQL = sql`pc`) => sql`${pc}.state='ready'`;
/** Hosted sends (and anything that queues one) stop here until the SES tenant exists; BYO connections are always ready. */
export function assertTenantReady(connection: { kind: 'shared' | 'byo'; tenant_state: TenantState } | null | undefined, simulated: boolean) {
  if (simulated || connection?.kind !== 'shared' || connection.tenant_state === 'ready') return;
  throw new ApiError(409, 'TENANT_NOT_READY', connection.tenant_state === 'failed' ? 'Hosted sending setup failed and is being retried. Check the connection status before sending again.' : 'Hosted sending is still being set up for this workspace. Retry shortly.', undefined, true);
}
export const poolSends = (p: SQL = sql`p`) => sql`${p}.sending_state='ready'`;
export const poolReceives = (p: SQL = sql`p`) => sql`${p}.receiving_state='ready'`;

/** Pure transition for one domain claim. The caller holds the claim row lock and supplies what it observed. */
export function transitionClaim(current: ClaimState, e: ClaimEvidence, now = Date.now()): ClaimState {
  const expired = (since: string | null) => since !== null && now - new Date(since).getTime() >= LOST_GRACE_MS;
  const wasHeld = current.sending_state === 'verified' || current.sending_state === 'lost';
  let sending: SendingState;
  if (e.unavailable) sending = 'failed';
  else if (e.sending) sending = 'verified';
  else if (e.sending === undefined) sending = current.sending_state === 'lost' && expired(current.lost_since) ? 'pending' : current.sending_state;
  else if (e.definitive || e.sendingRevoked || !wasHeld) sending = 'pending';
  else if (current.sending_state === 'verified') sending = 'lost';
  else sending = expired(current.lost_since) ? 'pending' : 'lost';
  // Ownership counts while it is observed or while sending still holds it through its grace.
  const owned = e.proven || sending === 'lost';
  const routing = current.receiving_state === 'active' || current.receiving_state === 'lost';
  const receivingHeld = routing && !expired(current.receiving_lost_since);
  let receiving: ReceivingState, host = current.receiving_host;
  if (sending === 'failed' || e.definitive || !e.identityVerified || !e.regionReceives) { receiving = 'off'; host = null; }
  else if (!owned) {
    // A receive-only claim (identity verified, DKIM pending) gets the same grace when its TXT proof goes missing;
    // a claim whose sending grace just expired has already had it.
    if (receivingHeld && !(current.sending_state === 'lost' && sending === 'pending')) receiving = 'lost'; else { receiving = 'off'; host = null; }
  } else if (e.observedHost === undefined) receiving = current.receiving_state === 'off' ? 'pending' : current.receiving_state;
  else if (e.observedHost) {
    // BYO activates only after its receipt rule lists the host; the shared catch-all already covers it.
    receiving = e.byo && !(routing && e.observedHost === host) ? 'pending' : 'active';
    host = e.observedHost;
  } else if (receivingHeld) receiving = 'lost';
  else { receiving = 'pending'; host = null; }
  const since = (next: boolean, was: boolean, before: string | null) => next ? (was ? before : new Date(now).toISOString()) : null;
  return { sending_state: sending, receiving_state: receiving, receiving_host: host,
    lost_since: since(sending === 'lost', current.sending_state === 'lost', current.lost_since),
    receiving_lost_since: since(receiving === 'lost', current.receiving_state === 'lost', current.receiving_lost_since) };
}

/** The self-hosted `mailbox_domains.status` vocabulary, projected from the claim for the shared mailbox code. Written only here, in the claim's own statement. */
const projectedMailboxStatus = (s: ClaimState) => s.receiving_state === 'active' || s.receiving_state === 'lost' ? 'active' : s.receiving_state === 'pending' && s.receiving_host ? 'provisioning' : 'waiting_for_mx';

type ClaimRef = { name: string; token: string; connectionId: string; workspaceId: string; domainId: string; region: string };
/**
 * Applies a transition and the facts it was derived from in one statement, fenced on the token and connection
 * so a stale verifier never overwrites a reclaimed or disconnected row. `suggestedHost` is where the MX should be
 * published (the receiving record shown to the user); addresses can be created on it before it routes.
 */
export async function applyClaim(db: DbExecutor, claim: ClaimRef, next: ClaimState, facts: IdentityFacts, suggestedHost: string) {
  const mx = facts.mx;
  const status = projectedMailboxStatus(next);
  await db.execute(sql`WITH claim AS (UPDATE domain_claims SET sending_state=${next.sending_state},receiving_state=${next.receiving_state},receiving_host=${next.receiving_host},
      lost_since=${next.lost_since}::timestamptz,receiving_lost_since=${next.receiving_lost_since}::timestamptz,identity=${JSON.stringify(facts)}::jsonb
      WHERE name=${claim.name} AND token=${claim.token} AND connection_id=${claim.connectionId} RETURNING workspace_id,claim_scope)
    INSERT INTO mailbox_domains AS m(id,workspace_id,domain_id,name,region,receiving_host,status,enabled_at,mx,checked_at)
    SELECT ${id('mdom')},workspace_id,${claim.domainId},${claim.name},${claim.region},${suggestedHost},${status},CASE WHEN ${!!next.receiving_host} THEN now() END,${mx ? JSON.stringify(mx) : null}::jsonb,${mx?.checkedAt ?? null}::timestamptz FROM claim WHERE claim_scope<>'account'
    ON CONFLICT ON CONSTRAINT mailbox_domains_name DO UPDATE SET domain_id=excluded.domain_id,parent_id=NULL,region=excluded.region,receiving_host=excluded.receiving_host,status=excluded.status,last_error=NULL,
      enabled_at=CASE WHEN excluded.enabled_at IS NOT NULL AND m.enabled_at IS NOT NULL AND m.status='active' THEN m.enabled_at ELSE excluded.enabled_at END,
      mx=coalesce(excluded.mx,m.mx),checked_at=coalesce(excluded.checked_at,m.checked_at),updated_at=now()`);
}
/** Records SES facts without touching state: the creating request and MAIL FROM changes. */
export const identityOnly = (ses: IdentityFacts['ses']): IdentityFacts => ({ ses, proven: false, mx: null, note: null });
/** The importer only passes domains just verified by GetEmailIdentity. Leave receiving off: importing sending
 * identities is not permission to provision receipt rules for the account's existing domains. */
export const verifyImportedClaims = (connection: string, domains: {name: string; ses: IdentityFacts['ses']}[]) => sql`UPDATE domain_claims dc SET sending_state=CASE WHEN d.ses->'DkimAttributes' @> '{"SigningEnabled":true,"Status":"SUCCESS"}' THEN 'verified' ELSE 'pending' END,
  identity=jsonb_build_object('ses',d.ses,'proven',true,'imported',true,'mx',NULL,'note',NULL)
  FROM jsonb_to_recordset(${JSON.stringify(domains)}::jsonb) d(name text,ses jsonb) WHERE dc.connection_id=${connection} AND dc.name=d.name`;
/** BYO only: the receipt rule now lists these hosts, so claims waiting on it start routing. */
export async function activateReceiving(db: DbExecutor, workspaceId: string, connectionId: string, region: string, hosts: string[]) {
  await db.execute(sql`WITH activated AS (UPDATE domain_claims dc SET receiving_state='active' FROM operation_domains d
      WHERE dc.connection_id=${connectionId} AND dc.workspace_id=${workspaceId} AND d.workspace_id=dc.workspace_id AND d.name=dc.name AND d.region=${region}
        AND dc.receiving_state='pending' AND dc.receiving_host IN (SELECT jsonb_array_elements_text(${JSON.stringify(hosts)}::jsonb)) RETURNING d.id)
    UPDATE mailbox_domains m SET status='active',last_error=NULL,enabled_at=now(),updated_at=now() FROM activated a WHERE m.workspace_id=${workspaceId} AND m.domain_id=a.id AND m.parent_id IS NULL`);
}
/** Disconnecting keeps the claim (other workspaces still cannot take the name) but every state returns to its start. */
export const detachedClaim = sql`connection_id=NULL,sending_state='pending',receiving_state='off',receiving_host=NULL,lost_since=NULL,receiving_lost_since=NULL,identity=NULL`;
/** MX: a failed BYO reconcile is recorded on the projection without inventing a receiving state (the claim stays pending and the job retries). */
export const noteReconcileFailure = (workspaceId: string, region: string, message: string) => sql`UPDATE mailbox_domains SET last_error=${message},updated_at=now() WHERE workspace_id=${workspaceId} AND region=${region} AND parent_id IS NULL AND status='provisioning'`;

// Provider connections: `state` is the connection state; the tenant has its own.
// provisioning -> provisioning is a retry taking over an expired lease; startProvisioning enforces the lease.
export const connectionTransitions: Record<ConnectionState, ConnectionState[]> = { awaiting_role: ['provisioning'], provisioning: ['provisioning', 'ready', 'failed', 'awaiting_role'], failed: ['provisioning'], ready: [] };
export function assertConnectionTransition(from: ConnectionState, to: ConnectionState) {
  if (!connectionTransitions[from].includes(to)) throw new Error(`Invalid connection transition ${from} -> ${to}`);
}
/** BYO: start provisioning with a fenced lease; the fence lets a crashed attempt be retried after the lease. */
export const startProvisioning = (id: string, account: string, roleArn: string, lease: string) => sql`UPDATE provider_connections SET state='provisioning',lease_until=${lease},aws_account_id=${account},role_arn=${roleArn}
  WHERE id=${id} AND ((state IN ('awaiting_role','failed')) OR (state='provisioning' AND coalesce(lease_until,'-infinity')<=now())) AND (aws_account_id IS NULL OR aws_account_id=${account})`;
export const finishProvisioning = (fence: SQL, to: 'ready' | 'failed' | 'awaiting_role') => sql`UPDATE provider_connections SET state=${to},lease_until=NULL WHERE state='provisioning' AND ${fence}`;
export const notProvisioning = (pc: SQL = sql`pc`) => sql`NOT (${pc}.state='provisioning' AND coalesce(${pc}.lease_until,'-infinity')>now())`;
/** Queues the one tenant job (retry-safe by id). The request never calls AWS: Hosted is instant and the job owns CreateTenant. */
export const queueTenantJob = (source: SQL) => sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'tenant.provision:'||id,'tenant.provision',workspace_id,jsonb_build_object('connectionId',id) FROM (${source}) c
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL WHERE jobs.status<>'running'`;
export const setTenantState = (id: string, to: TenantState, account?: string) => sql`UPDATE provider_connections SET tenant_state=${to}${account ? sql`,aws_account_id=${account}` : sql``} WHERE id=${id} AND tenant_state<>'ready'`;
export const setPoolState = (fence: SQL, column: 'sending_state' | 'receiving_state', extra: SQL = sql``) => sql`UPDATE provider_pool_regions SET ${sql.identifier(column)}='ready'${extra} WHERE ${fence}`;

// Campaigns: one state for the draft, its frozen snapshot (sending_campaign_reviews, no status of its own) and its
// delivery. `total`, `prepared` and `expanded` are cursors into the frozen recipient list, `canceled` counts
// recipients released from the reservation; none of them is a second status. A launch snapshots the audience and
// moves draft/failed -> preparing; the one `campaign.run` job validates recipients (preparing), waits for the
// schedule (scheduled), releases rows into the dispatch queue (sending) and the dispatcher marks the campaign done
// inline when its last row leaves queued/attempting. paused is entered by the user or the health check and leaves
// to wherever the cursors say (runningState). failed keeps its error: with nothing released yet it can be edited (-> draft)
// or launched again from a fresh snapshot; once recipients were released it can only resume from `expanded` on the same
// snapshot (never a second snapshot, which would send to the released recipients again) or be canceled.
export const CAMPAIGN_STATES = ['draft', 'preparing', 'scheduled', 'sending', 'paused', 'done', 'failed', 'canceled'] as const;
export type CampaignState = typeof CAMPAIGN_STATES[number];
export type RunningState = 'preparing' | 'scheduled' | 'sending';
export const campaignTransitions: Record<CampaignState, CampaignState[]> = {
  draft: ['preparing'], failed: ['preparing', 'draft', 'scheduled', 'sending', 'canceled'],
  preparing: ['scheduled', 'sending', 'paused', 'failed', 'canceled'], scheduled: ['sending', 'paused', 'failed', 'canceled'],
  sending: ['paused', 'done', 'failed', 'canceled'], paused: ['preparing', 'scheduled', 'sending', 'canceled'], done: [], canceled: [],
};
export function assertCampaignTransition(from: CampaignState, to: CampaignState) {
  if (!campaignTransitions[from].includes(to)) throw new Error(`Invalid campaign transition ${from} -> ${to}`);
}
/** States with an outstanding recipient reservation (and a run job that may still act). */
export const CAMPAIGN_ACTIVE = ['preparing', 'scheduled', 'sending', 'paused'] as const satisfies readonly CampaignState[];
/** States the run job acts in; paused and the terminal states make it a no-op. */
export const CAMPAIGN_RUNNING = ['preparing', 'scheduled', 'sending'] as const satisfies readonly RunningState[];
/** Editable, deletable and launchable from scratch: a draft, or a failed launch that released nothing. */
export const campaignEditable = (row: { state: CampaignState; expanded: number }) => row.state === 'draft' || (row.state === 'failed' && row.expanded === 0);
/** A failed launch that already released recipients can only continue from its cursor or be canceled. */
export const campaignResumable = (row: { state: CampaignState; expanded: number }) => row.state === 'paused' || (row.state === 'failed' && row.expanded > 0);
export const campaignActive = (c: SQL = sql`c`) => sql`${c}.state IN ('preparing','scheduled','sending','paused')`;
/** Holds a recipient reservation: active, or failed after releasing some recipients (resumable, so still counted). */
export const campaignReserved = (c: SQL = sql`c`) => sql`(${campaignActive(c)} OR (${c}.state='failed' AND ${c}.expanded>0))`;
const editableRow = sql`(state='draft' OR (state='failed' AND expanded=0))`;
/** Where a launched campaign continues from its cursors: preparing until every recipient is validated, then its schedule, then sending. */
export function runningState(row: { prepared: number; total: number; scheduledAt: string | null }, now = Date.now()): RunningState {
  if (row.prepared < row.total) return 'preparing';
  return row.scheduledAt && Date.parse(row.scheduledAt) > now ? 'scheduled' : 'sending';
}
type CampaignRef = { workspaceId: string; id: string };
const campaignRow = (ref: CampaignRef) => sql`workspace_id=${ref.workspaceId} AND id=${ref.id}`;
const states = (list: readonly CampaignState[]) => sql.join(list.map(state => sql`${state}`), sql`,`);
/** One fenced statement: the row moves to `to` only from one of `from`, with `set` as the only other change. Returns the row's id when it moved. */
export function moveCampaign(ref: CampaignRef, from: readonly CampaignState[], to: CampaignState, set: SQL = sql``, guard: SQL = sql`true`) {
  for (const state of from) assertCampaignTransition(state, to);
  return sql`UPDATE sending_campaigns SET state=${to},updated_at=now()${set} WHERE ${campaignRow(ref)} AND state IN (${states(from)}) AND ${guard} RETURNING id`;
}
/** Cursor or setting changes that keep the state; fenced on it so a paused or canceled campaign is never advanced. */
export const progressCampaign = (ref: CampaignRef, state: CampaignState, set: SQL) => sql`UPDATE sending_campaigns SET updated_at=now()${set} WHERE ${campaignRow(ref)} AND state=${state} RETURNING id`;
export type CampaignLaunch = { reviewId: string; actorKeyId: string; simulated: boolean; total: number; requestId: string | null; scheduledAt: string | null; pacePerDay: number | null; autoPause: boolean; rateShare: number | null };
/** draft, or failed with nothing released -> preparing with a fresh snapshot: every cursor and setting starts over; the error of a failed launch is cleared. */
export const launchCampaign = (ref: CampaignRef, l: CampaignLaunch) => moveCampaign(ref, ['draft', 'failed'], 'preparing', sql`,review_id=${l.reviewId},actor_key_id=${l.actorKeyId},simulated=${l.simulated},total=${l.total},prepared=0,expanded=0,canceled=0,error=NULL,request_id=${l.requestId},
  scheduled_at=${l.scheduledAt}::timestamptz,pace_per_day=${l.pacePerDay},auto_pause=${l.autoPause},rate_share=${l.rateShare},window_started_at=NULL,window_expanded=0,paused_at=NULL,pause_reason=NULL,health_checked_at=NULL,waiting_reason=NULL,waiting_until=NULL`, editableRow);
/** A new revision: draft, or failed with nothing released -> draft with no snapshot; a failed launch's counters and error go with it. */
export const reviseCampaign = (ref: CampaignRef, set: SQL) => sql`UPDATE sending_campaigns SET state='draft',updated_at=now(),review_id=NULL,error=NULL,total=0,prepared=0,expanded=0,canceled=0,scheduled_at=NULL${set} WHERE ${campaignRow(ref)} AND ${editableRow} RETURNING *`;
export const pauseCampaign = (ref: CampaignRef, reason: { code: string; message: string }) => moveCampaign(ref, CAMPAIGN_RUNNING, 'paused', sql`,paused_at=now(),pause_reason=${JSON.stringify(reason)}::jsonb,waiting_reason=NULL,waiting_until=NULL,health_checked_at=now()`);
/** paused, or failed after releasing some recipients, continues from its cursors on the same snapshot; the failure is cleared. */
export const resumeCampaign = (ref: CampaignRef, to: RunningState) => moveCampaign(ref, ['paused', 'failed'], to, sql`,paused_at=NULL,pause_reason=NULL,error=NULL,health_checked_at=now()`, sql`(state='paused' OR expanded>0)`);
export const cancelCampaign = (ref: CampaignRef, error: { code: string; message: string } | null) => moveCampaign(ref, [...CAMPAIGN_ACTIVE, 'failed'], 'canceled', sql`,canceled=canceled+(total-expanded),waiting_reason=NULL,waiting_until=NULL${error ? sql`,error=${JSON.stringify(error)}::jsonb` : sql``}`);
export const failCampaign = (ref: CampaignRef, error: { code: string; message: string }) => moveCampaign(ref, CAMPAIGN_RUNNING, 'failed', sql`,error=${JSON.stringify(error)}::jsonb,scheduled_at=NULL,waiting_reason=NULL,waiting_until=NULL`);
/** Preparation advanced to `prepared`; when the whole list is validated the campaign moves to its schedule or straight to sending. */
export const recordPrepared = (ref: CampaignRef, prepared: number, next: RunningState) => next === 'preparing' ? progressCampaign(ref, 'preparing', sql`,prepared=${prepared}`) : moveCampaign(ref, ['preparing'], next, sql`,prepared=${prepared}`);
export const startSending = (ref: CampaignRef) => moveCampaign(ref, ['scheduled'], 'sending');
export const recordExpanded = (ref: CampaignRef, expanded: number, windowStartedAt: string | null, windowExpanded: number) => progressCampaign(ref, 'sending', sql`,expanded=${expanded},window_started_at=${windowStartedAt}::timestamptz,window_expanded=${windowExpanded},waiting_reason=NULL,waiting_until=NULL`);
export const holdCampaign = (ref: CampaignRef, reason: 'pacing_window' | 'ses_daily_quota', until: string) => progressCampaign(ref, 'sending', sql`,waiting_reason=${reason},waiting_until=${until}::timestamptz`);
export const noteHealthChecked = (ref: CampaignRef) => progressCampaign(ref, 'sending', sql`,health_checked_at=now()`);
export const setCampaignPacing = (ref: CampaignRef, pacing: { pacePerDay: number | null; autoPause: boolean; rateShare: number | null }) => sql`UPDATE sending_campaigns SET updated_at=now(),pace_per_day=${pacing.pacePerDay},auto_pause=${pacing.autoPause},rate_share=${pacing.rateShare},waiting_reason=NULL,waiting_until=NULL WHERE ${campaignRow(ref)} AND ${campaignActive(sql`sending_campaigns`)} RETURNING id`;
/**
 * sending -> done once every recipient is released and no row is queued or attempting. The dispatcher runs it once
 * per draining batch over the campaigns it moved rows for (locking only campaign rows, after the row statements, so it
 * never serializes concurrent shards nor deadlocks with cancel or the run job); the interrupted-attempt sweep appends
 * it over every sending campaign so a missed edge can never leave one sending with nothing queued. `refs` yields
 * (workspace_id, campaign_id); `leaving` the ids the same statement is finishing, which its own subqueries cannot see yet.
 */
export const finishCampaigns = (refs: SQL, leaving: SQL = sql`SELECT NULL::text AS id WHERE false`) => sql`UPDATE sending_campaigns c SET state='done',updated_at=clock_timestamp()
  FROM (${refs}) x WHERE c.workspace_id=x.workspace_id AND c.id=x.campaign_id AND c.state='sending' AND c.expanded=c.total
    AND NOT EXISTS (SELECT 1 FROM sending_emails e WHERE e.workspace_id=c.workspace_id AND e.campaign_id=c.id AND e.status IN ('queued','attempting') AND NOT EXISTS (SELECT 1 FROM (${leaving}) l WHERE l.id=e.id))`;
/**
 * The campaign's one job: keyed by campaign so launch, resume and pacing changes requeue the same row instead of adding
 * one per step. Every (re)queue carries a fresh `run` token in the payload and the job runner fences its completion on it,
 * so a worker still holding the retired run of a pause -> resume cannot complete or requeue the new run's row.
 */
export const campaignRunJobId = (campaignId: string) => `campaign.run:${campaignId}`;
export const queueCampaignRun = (ref: CampaignRef, payload: Record<string, unknown>, availableAt: string | null = null) => sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at) VALUES (${campaignRunJobId(ref.id)},'campaign.run',${ref.workspaceId},${JSON.stringify({ campaignId: ref.id, ...payload, run: id('run') })}::jsonb,coalesce(${availableAt}::timestamptz,now()))
  ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL,last_error=NULL`;
/** Pause and cancel retire a waiting run; a run in flight sees the new state at its next fenced statement and stops by itself. */
export const retireCampaignRun = (ref: CampaignRef, reason: string) => sql`UPDATE jobs SET status='completed',lease_until=NULL,last_error=${reason} WHERE id=${campaignRunJobId(ref.id)} AND status='pending'`;
export const wakeCampaignRun = (ref: CampaignRef) => sql`UPDATE jobs SET available_at=now() WHERE id=${campaignRunJobId(ref.id)} AND status='pending'`;
