CREATE OR REPLACE FUNCTION hosted_charge_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO hosted_usage_hourly AS u SELECT n.workspace_id,date_trunc('hour',n.created_at,'UTC'),sum(hosted_real_cost(n.to_addresses || n.cc_addresses || n.bcc_addresses))
    FROM new_mail n LEFT JOIN provider_connections pc USING (workspace_id) WHERE NOT n.simulated AND hosted_charged(n.status,n.provider_id)
    AND ((n.feedback_topic_arn IS NULL AND pc.kind='shared') OR n.feedback_topic_arn IN (SELECT feedback_topic_arn FROM provider_pool_regions))
    GROUP BY 1,2 HAVING sum(hosted_real_cost(n.to_addresses || n.cc_addresses || n.bcc_addresses)) > 0
    ORDER BY 1,2 ON CONFLICT (workspace_id,hour) DO UPDATE SET recipients=u.recipients+excluded.recipients;
  RETURN NULL;
END $$;

-- Shared by campaign release, mailbox admission and the direct send. Keep the 24-bucket
-- calculation inlinable; lock policy rows before applying operator overrides.
CREATE VIEW hosted_admission_policy AS
  SELECT pc.workspace_id,pc.created_at,pc.pause_reason,w.send_cap_override,w.pending_cap_override
  FROM provider_connections pc JOIN workspaces w ON w.id=pc.workspace_id WHERE pc.kind='shared' FOR SHARE OF pc,w;

CREATE VIEW verified_sending_domains AS
  SELECT dc.workspace_id,pc.region,dc.name FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id
  WHERE pc.state='ready' AND dc.sending_state IN ('verified','lost') FOR SHARE OF dc,pc;

CREATE FUNCTION hosted_allowance(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE (allowance jsonb) LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('cap',c.cap,'marketingCap',m.cap,'used',usage.used,'resetAt',least(usage.next_expiry,c.next_tier),
    'nextChangeAt',least(c.next_tier,coalesce(usage.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours')),'pauseReason',c.pause_reason,'pendingCapOverride',c.pending_cap_override)
  FROM (SELECT p.*,coalesce(send_cap_override,CASE WHEN created_at>now()-interval '7 days' THEN first_week WHEN created_at>now()-interval '14 days' THEN second_week ELSE mature END) AS cap,
    CASE WHEN send_cap_override IS NOT NULL THEN NULL WHEN created_at>now()-interval '7 days' THEN created_at+interval '7 days' WHEN created_at>now()-interval '14 days' THEN created_at+interval '14 days' END AS next_tier
    FROM hosted_admission_policy p WHERE p.workspace_id=wid) c
  CROSS JOIN LATERAL (SELECT c.cap-ceil(c.cap*headroom::numeric/100)::int AS cap) m
  CROSS JOIN LATERAL (SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
    max(hour) FILTER (WHERE running+least(incoming,c.cap)>c.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS next_expiry FROM (
    SELECT hour,sum(recipients) OVER (ORDER BY hour DESC) AS running FROM hosted_usage_hourly WHERE workspace_id=c.workspace_id
      AND hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND recipients>0
      AND incoming>0 AND c.pause_reason IS NULL) charged) usage
$$;

-- A VOLATILE function's statements take new READ COMMITTED snapshots. A lock and a
-- count in two CTEs of one ordinary statement would miss the previous winner's commit.
CREATE FUNCTION direct_admission_state(wid text,actor_id text,route text,idem_key text,body_hash text,receipt jsonb,
  wanted jsonb,asset_ids jsonb,simulated boolean,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE previous jsonb; state jsonb;
BEGIN
  IF idem_key IS NOT NULL THEN
    INSERT INTO sending_idempotency(workspace_id,actor_key_id,path,request_key,request_hash,result)
    VALUES(wid,actor_id,route,idem_key,body_hash,receipt) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN
      SELECT jsonb_build_object('previous',result,'hash',request_hash) INTO STRICT previous FROM sending_idempotency
        WHERE workspace_id=wid AND actor_key_id=actor_id AND path=route AND request_key=idem_key;
      RETURN previous;
    END IF;
  END IF;
  INSERT INTO job_schedule(workspace_id) VALUES(wid) ON CONFLICT(workspace_id) DO UPDATE SET turn=job_schedule.turn WHERE false;
  WITH settings AS (SELECT default_region,enabled_regions FROM ses_installation_settings WHERE workspace_id=wid FOR SHARE),
  connection AS (SELECT region,kind,aws_account_id,tenant_state FROM provider_simulated_connections WHERE simulated AND workspace_id=wid
    UNION ALL SELECT region,kind,aws_account_id,tenant_state FROM provider_sending_connections WHERE NOT simulated AND workspace_id=wid)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM sending_emails WHERE workspace_id=wid AND review_id IS NULL AND status IN ('queued','attempting')),
    'hosted',(SELECT allowance FROM hosted_allowance(wid,incoming,marketing,first_week,second_week,mature,headroom)),
    'quota',(SELECT max(l.max_24_hour_send) FROM provider_workspace_limits l JOIN provider_connections pc USING(workspace_id,region) WHERE l.workspace_id=wid AND pc.kind='byo'),
    'default_region',s.default_region,'enabled_regions',s.enabled_regions,'connection',to_jsonb(c),
    'assets',CASE WHEN jsonb_array_length(asset_ids)>0 THEN (SELECT jsonb_agg(asset) FROM (
      SELECT id,size,content_id AS "contentId" FROM sending_attachments WHERE workspace_id=wid AND id IN (SELECT jsonb_array_elements_text(asset_ids))
      ORDER BY id FOR UPDATE) asset) END,
    'verified',ARRAY(SELECT m.host||':'||coalesce(m.region,s.default_region) FROM jsonb_to_recordset(wanted) m(host text,region text)
      WHERE EXISTS(SELECT FROM verified_sending_domains d WHERE d.workspace_id=wid AND d.region=coalesce(m.region,s.default_region)
          AND right('.'||m.host,length(d.name)+1)='.'||d.name))) INTO state
  FROM (VALUES(1)) anchor(i) LEFT JOIN settings s ON true LEFT JOIN connection c ON c.region=coalesce(wanted->0->>'region',s.default_region);
  RETURN state;
END $$;
