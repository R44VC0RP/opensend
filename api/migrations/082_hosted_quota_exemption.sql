SET LOCAL lock_timeout='1s';
ALTER TABLE workspaces ADD COLUMN exempt_hosted_quotas boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW hosted_admission_policy AS
  SELECT pc.workspace_id,pc.created_at,pc.pause_reason,w.send_cap_override,w.pending_cap_override,w.exempt_hosted_quotas
  FROM provider_connections pc JOIN workspaces w ON w.id=pc.workspace_id WHERE pc.kind='shared' FOR SHARE OF pc,w;

-- direct_admission_state (064), mailbox admission and campaign release all read this policy.
-- An uncapped Hosted connection still has a policy row, including its reputation hold.
CREATE OR REPLACE FUNCTION hosted_allowance(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE (allowance jsonb) LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('cap',c.cap,'marketingCap',m.cap,'used',usage.used,'resetAt',least(usage.next_expiry,c.next_tier),
    'nextChangeAt',least(c.next_tier,coalesce(usage.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours')),
    'pauseReason',c.pause_reason,'pendingCapOverride',c.pending_cap_override,'exemptHostedQuotas',c.exempt_hosted_quotas)
  FROM (SELECT p.*,coalesce(send_cap_override,CASE WHEN exempt_hosted_quotas THEN NULL WHEN created_at>now()-interval '7 days' THEN first_week WHEN created_at>now()-interval '14 days' THEN second_week ELSE mature END) AS cap,
    CASE WHEN send_cap_override IS NOT NULL OR exempt_hosted_quotas THEN NULL WHEN created_at>now()-interval '7 days' THEN created_at+interval '7 days' WHEN created_at>now()-interval '14 days' THEN created_at+interval '14 days' END AS next_tier
    FROM hosted_admission_policy p WHERE p.workspace_id=wid) c
  CROSS JOIN LATERAL (SELECT c.cap-ceil(c.cap*headroom::numeric/100)::int AS cap) m
  CROSS JOIN LATERAL (SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
    max(hour) FILTER (WHERE running+least(incoming,c.cap)>c.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS next_expiry FROM (
    SELECT hour,sum(recipients) OVER (ORDER BY hour DESC) AS running FROM hosted_usage_hourly WHERE workspace_id=c.workspace_id
      AND hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND recipients>0
      AND incoming>0 AND c.pause_reason IS NULL) charged) usage
$$;
