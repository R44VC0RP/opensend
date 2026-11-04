-- Contract only after the release containing 054 is serving all Worker/runner traffic.
-- Rolling back to dd4273d after this migration is not supported.
DROP TRIGGER provider_connections_sync_state ON provider_connections;
DROP FUNCTION provider_connections_sync_state();
DROP TRIGGER provider_pool_regions_sync_state ON provider_pool_regions;
DROP FUNCTION provider_pool_regions_sync_state();

DROP VIEW provider_sending_connections;
CREATE VIEW provider_sending_connections AS
SELECT c.id,c.workspace_id,c.kind,c.region,c.aws_account_id,c.role_arn,c.external_id,
       coalesce(c.feedback_topic_arn,p.feedback_topic_arn) AS feedback_topic_arn,c.tenant_state
FROM provider_connections c LEFT JOIN provider_pool_regions p ON c.kind='shared' AND p.region=c.region AND p.aws_account_id=c.aws_account_id AND p.sending_state='ready'
WHERE c.state='ready' AND coalesce(c.feedback_topic_arn,p.feedback_topic_arn) IS NOT NULL;
DROP VIEW provider_simulated_connections;
CREATE VIEW provider_simulated_connections AS
SELECT id, workspace_id, kind, region, coalesce(aws_account_id, '000000000000') AS aws_account_id,
       role_arn, external_id, feedback_topic_arn, tenant_state
FROM provider_connections WHERE state = 'ready';
DROP VIEW provider_workspace_limits;
CREATE VIEW provider_workspace_limits AS
SELECT c.workspace_id, l.aws_account_id, l.region, l.refresh_after, l.checked_at,
       CASE WHEN c.kind = 'shared' THEN l.max_send_rate / 4 ELSE l.max_send_rate END AS max_send_rate,
       l.max_24_hour_send, l.sent_last_24_hours
FROM provider_connections c JOIN provider_account_limits l USING (aws_account_id, region)
WHERE c.state = 'ready';

-- The table checks that named `status` move to `state`; the column goes with the old partial index.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='provider_connections'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE provider_connections DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
DROP INDEX provider_connections_dispatch;
ALTER TABLE provider_connections DROP COLUMN status, DROP COLUMN tenant_provisioned,
  ADD CHECK ((kind = 'shared' AND external_id IS NULL AND role_arn IS NULL AND template_version IS NULL AND platform_principal_arn IS NULL AND feedback_topic_arn IS NULL)
      OR (kind = 'byo' AND external_id IS NOT NULL AND template_version IS NOT NULL AND platform_principal_arn IS NOT NULL AND (state <> 'ready' OR role_arn IS NOT NULL))),
  ADD CHECK (kind='shared' OR state<>'ready' OR aws_account_id IS NOT NULL);
ALTER TABLE provider_pool_regions DROP COLUMN ready;
ALTER TABLE domain_claims DROP COLUMN verified, DROP COLUMN ready, DROP COLUMN readiness, DROP COLUMN receiving_name,
  DROP COLUMN receiving_eligible, DROP COLUMN txt_misses, DROP COLUMN mx_misses;

-- Same signature as before; the body no longer touches the dropped columns (detached claims are already reset).
CREATE OR REPLACE FUNCTION reserve_domain_claim(wid text, host text, requested_region text, new_id text) RETURNS TABLE
  (connection jsonb, token uuid, id text, readiness jsonb, fresh boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE pc provider_connections%ROWTYPE; claim domain_claims%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(host FROM '[^.]+\.[^.]+$'),84912));
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND c.region=requested_region AND c.state='ready' FOR SHARE OF s,c;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  connection := to_jsonb(pc);
  IF EXISTS (SELECT 1 FROM domain_claims dc WHERE dc.workspace_id<>wid AND (
    right('.'||dc.name,length(host)+1)='.'||host OR right('.'||host,length(dc.name)+1)='.'||dc.name)) THEN RETURN NEXT; RETURN; END IF;
  SELECT dc.* INTO claim FROM domain_claims dc WHERE dc.name=host FOR UPDATE;
  fresh := NOT FOUND;
  IF fresh THEN
    INSERT INTO domain_claims(name,workspace_id,connection_id) VALUES(host,wid,pc.id) RETURNING * INTO claim;
  ELSIF claim.workspace_id=wid AND claim.connection_id IS NULL THEN
    -- A disconnect retained this claim at its start states. Verify its original tag; never adopt an untagged identity.
    fresh := true;
    UPDATE domain_claims dc SET connection_id=pc.id WHERE dc.name=host RETURNING * INTO claim;
  ELSIF claim.workspace_id=wid AND claim.connection_id=pc.id THEN
    SELECT d.id INTO id FROM operation_domains d WHERE d.workspace_id=wid AND d.name=host AND d.region=requested_region;
    token := claim.token; RETURN NEXT; RETURN;
  ELSE RETURN NEXT; RETURN;
  END IF;
  token := claim.token;
  INSERT INTO operation_domains AS d(id,name,workspace_id,region) VALUES(new_id,host,wid,requested_region)
    ON CONFLICT ON CONSTRAINT operation_domain_scope DO UPDATE SET updated_at=now() RETURNING d.id INTO id;
  INSERT INTO jobs(id,workspace_id,type,payload,available_at) VALUES('domain.verify:'||claim.token,wid,'domain.verify',
    jsonb_build_object('domainId',id,'token',claim.token,'start',floor(extract(epoch FROM now())*1000)),now()+interval '5 seconds')
    ON CONFLICT ON CONSTRAINT jobs_pkey DO UPDATE SET payload=excluded.payload,available_at=excluded.available_at,status='pending',lease_until=NULL;
  RETURN NEXT;
END $$;
