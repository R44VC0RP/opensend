-- Can be prebuilt CONCURRENTLY on a busy installation. The existing direct index covers the total.
CREATE INDEX IF NOT EXISTS sending_emails_direct_marketing_pending ON sending_emails(workspace_id)
  WHERE review_id IS NULL AND status IN ('queued','attempting') AND snapshot->>'kind'='marketing';

-- Hosted direct streams have independent queue limits, including simulated messages. Daily
-- recipient headroom remains separate. Unknown legacy kinds count as transactional. Keep total
-- for older Workers during rollout; the new path compares the largest submitted stream to its cap.
CREATE FUNCTION direct_pending_load(wid text, incoming integer, marketing integer)
RETURNS TABLE(total integer, projected integer) LANGUAGE sql STABLE AS $$
  SELECT n, CASE WHEN m IS NULL THEN n+incoming ELSE greatest(
    CASE WHEN incoming>marketing THEN n-m+incoming-marketing END, CASE WHEN marketing>0 THEN m+marketing END) END
  FROM (SELECT (SELECT count(*)::int FROM sending_emails WHERE workspace_id=wid AND review_id IS NULL AND status IN ('queued','attempting')) n,
    CASE WHEN EXISTS(SELECT FROM provider_connections WHERE workspace_id=wid AND kind='shared') THEN
      (SELECT count(*)::int FROM sending_emails WHERE workspace_id=wid AND review_id IS NULL AND status IN ('queued','attempting') AND snapshot->>'kind'='marketing') END m) counts
$$;

CREATE OR REPLACE FUNCTION direct_admission_state(wid text,actor_id text,route text,idem_key text,body_hash text,receipt jsonb,
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
  SELECT (SELECT to_jsonb(p) FROM direct_pending_load(wid,jsonb_array_length(wanted),jsonb_array_length(jsonb_path_query_array(wanted,'$[*] ? (@.kind == "marketing")'))) p) || jsonb_build_object(
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
