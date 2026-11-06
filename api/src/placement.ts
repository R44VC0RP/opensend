import { sql } from 'drizzle-orm';
import { log, type JobHandler, type Runtime } from './core.js';
import { placementRoot, publicSignals } from './placement-probes.js';

const policyVersion=1, budgetMs=2_000;
type History={accepted:number;bounces:number;complaints:number;spanDays:number};

// The per-envelope health credits are deliberately short-lived. Use the retained
// 30-day Hosted mail and feedback, scoped to this workspace and exact From host.
// Count accepted destinations once per envelope and deduplicate feedback recipients
// the same way as 062 (one for an otherwise anonymous bounce/complaint).
async function domainHistory(runtime:Runtime,wid:string,host:string,deadline:number):Promise<History|null> {
  try {
    return await runtime.db.transaction(async tx=>{
      const left=deadline-Date.now(); if(left<=0) return null;
      await tx.execute(sql`SELECT set_config('statement_timeout',${String(Math.min(left,1200))},true)`);
      const {rows:[row]}=await tx.execute<History>(sql`WITH envelopes AS (
        SELECT e.id,h.cost FROM sending_emails e JOIN hosted_real_envelopes h ON h.workspace_id=e.workspace_id AND h.id=e.id
        WHERE e.workspace_id=${wid} AND e.created_at>=now()-interval '30 days' AND lower(split_part(e.from_address,'@',2))=${host}
          AND e.status<>'suppressed' AND h.cost>0
      ), credits AS (
        SELECT e.id,e.cost,min(v.created_at) FILTER(WHERE v.type IN ('accepted','send')) AS accepted_at,
          greatest(count(DISTINCT dest) FILTER(WHERE v.type='bounce'),coalesce(max((dest IS NULL)::int) FILTER(WHERE v.type='bounce'),0)) AS bounces,
          greatest(count(DISTINCT dest) FILTER(WHERE v.type='complaint'),coalesce(max((dest IS NULL)::int) FILTER(WHERE v.type='complaint'),0)) AS complaints
        FROM envelopes e JOIN sending_email_events v ON v.workspace_id=${wid} AND v.email_id=e.id
        LEFT JOIN LATERAL unnest(v.recipient_hashes) h(dest) ON v.type IN ('bounce','complaint')
        WHERE NOT v.simulated AND v.created_at>=now()-interval '30 days' AND (v.type IN ('accepted','send','complaint') OR (v.type='bounce' AND v.data->>'bounceType'='Permanent'))
          AND (v.recipient_hashes IS NULL OR cardinality(v.recipient_hashes)>0)
        GROUP BY e.id,e.cost
      ) SELECT coalesce(sum(cost) FILTER(WHERE accepted_at IS NOT NULL),0)::float8 AS accepted,
        coalesce(sum(bounces),0)::float8 AS bounces,coalesce(sum(complaints),0)::float8 AS complaints,
        coalesce(floor(extract(epoch FROM max(accepted_at)-min(accepted_at))/86400),0)::int AS "spanDays" FROM credits`);
      return row;
    });
  } catch(e) {
    // PostgreSQL query_canceled: a large history is unknown, not a clean history.
    if([e,(e as Error)?.cause].some(err=>(err as {code?:string})?.code==='57014')) return null;
    throw e;
  }
}

type Workspace={name:string;ageDays:number;verifiedDomain:string|null;held:boolean;cleanDays:number|null};
type Network=Awaited<ReturnType<typeof publicSignals>>;
function scorePlacement(net:Network,w:Workspace,history:History|null) {
  const reasons:string[]=[]; let score=0;
  const points=(n:number,why:string)=>{score+=n;reasons.push(why);};
  if(net.ageDays!==null && net.ageDays>=365) points(3,'rdap_established');
  else if(net.ageDays!==null && net.ageDays<30) points(-4,'rdap_new');
  if(net.exact.mx) points(1,'non_null_mx');
  if(net.exact.spf) points(1,'valid_spf');
  if(net.exact.dmarc==='valid' || (net.exact.dmarc==='absent' && net.parent?.dmarc==='valid')) points(1,'valid_dmarc');
  if(net.site==='live') points(1,'live_site');
  const verified=!!w.verifiedDomain && [w.name,net.root].includes(w.verifiedDomain);
  const clean=w.ageDays>=30 && w.cleanDays!==null && w.cleanDays>=30;
  if(verified || clean) points(2,verified?'verified_signup':'clean_workspace');
  const track=!!history && history.accepted>=1000 && history.spanDays>=14 && history.bounces*100<history.accepted && history.complaints*5000<history.accepted;
  if(track) points(3,'clean_domain_history');
  if(net.dbl==='listed') reasons.push('blocklisted');
  if(w.held) reasons.push('active_abuse_hold');
  if(net.lookalike) reasons.push('brand_lookalike');
  const hold=net.dbl==='listed' || w.held || net.lookalike;
  if(net.dbl==='unknown' || net.dbl==='unconfigured') reasons.push('dbl_'+net.dbl);
  if(!verified && !clean && !track) reasons.push('no_anchor');
  if(score<7) reasons.push('below_threshold');
  if(history===null) reasons.push('domain_history_unknown');
  return {score,reasons,decision:hold?'hold':score>=7 && (verified || clean || track) && net.dbl==='clear'?'virginia':'ohio',
    signals:{...net,workspaceAgeDays:w.ageDays,verifiedSignup:verified,cleanWorkspaceDays:w.cleanDays,activeHold:w.held,domainHistory:history}};
}

export const shadowPlacement:JobHandler=async(runtime,payload,{workspaceId:wid})=>{
  if(!runtime.config.multiTenant || !runtime.config.placementShadow || typeof payload.domainId!=='string') return;
  const id=payload.domainId, started=Date.now(), deadline=started+budgetMs;
  // A completed observation is immutable. Deleted, reconnected, and BYO domains
  // never profile via a stale job. No transaction or claim lock across probes.
  const target=sql`FROM domain_sending_bindings b JOIN provider_connections pc ON pc.id=b.connection_id AND pc.workspace_id=b.workspace_id
    WHERE b.domain_id=${id} AND b.workspace_id=${wid} AND pc.kind='shared'`;
  const {rows:[w]}=await runtime.db.execute<Workspace>(sql`SELECT b.name,pc.paused_at IS NOT NULL AS held,
    (SELECT floor(extract(epoch FROM now()-w.created_at)/86400)::int FROM workspaces w WHERE w.id=b.workspace_id) AS "ageDays",
    (SELECT u.google_hosted_domain FROM workspace_members m JOIN auth_user u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.workspace_id=b.workspace_id AND m.created_at=w.created_at AND m.role='owner' AND u.email_verified AND u.google_hosted_domain IS NOT NULL
      ORDER BY m.id LIMIT 1) AS "verifiedDomain",
    (SELECT CASE WHEN sum(h.bounces)=0 AND sum(h.complaints)=0 AND max(h.hour) FILTER(WHERE h.accepted>0)>=now()-interval '2 days'
      THEN floor(extract(epoch FROM max(h.hour) FILTER(WHERE h.accepted>0)-min(h.hour) FILTER(WHERE h.accepted>0))/86400)::int END
      FROM hosted_health_hourly h WHERE h.workspace_id=b.workspace_id AND h.epoch=coalesce(pc.resumed_at,'-infinity') AND h.hour>=now()-interval '32 days') AS "cleanDays"
    ${target} AND NOT EXISTS(SELECT FROM domain_placement_shadow WHERE domain_id=b.domain_id)`);
  if(!w) return;
  const {root,shared}=placementRoot(w.name),signal=AbortSignal.timeout(Math.max(1,deadline-Date.now()));
  const [net,history]=await Promise.all([publicSignals(w.name,root,shared,runtime.config.placementDblZone,signal),domainHistory(runtime,wid,w.name,deadline)]);
  const {decision,score,reasons,signals}=scorePlacement(net,w,history);
  const stored=await runtime.db.execute(sql`INSERT INTO domain_placement_shadow(domain_id,policy_version,started_at,decision,score,reasons,signals)
    SELECT b.domain_id,${policyVersion},${new Date(started).toISOString()}::timestamptz,${decision},${score},${JSON.stringify(reasons)}::jsonb,${JSON.stringify(signals)}::jsonb
    ${target} ON CONFLICT(domain_id) DO NOTHING RETURNING domain_id`);
  if(stored.rowCount) log('info',{code:'DOMAIN_PLACEMENT_SHADOW',domain:w.name,policyVersion,decision,score,reasons});
};
