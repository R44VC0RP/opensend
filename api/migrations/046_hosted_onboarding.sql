-- Customer readiness is independent of the platform's first regional bootstrap.
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_check1,
  ADD CHECK (kind='shared' OR status<>'ready' OR aws_account_id IS NOT NULL),
  ADD COLUMN tenant_provisioned boolean NOT NULL DEFAULT false;
UPDATE provider_connections SET tenant_provisioned=true WHERE kind='shared' AND status='ready';
WITH promoted AS (UPDATE provider_connections SET status='ready' WHERE kind='shared' AND status='pending' RETURNING workspace_id,region)
UPDATE ses_installation_settings s SET default_region=p.region,enabled_regions=jsonb_build_array(p.region) FROM promoted p WHERE s.workspace_id=p.workspace_id;

CREATE OR REPLACE VIEW provider_sending_connections AS
SELECT c.id,c.workspace_id,c.kind,c.region,c.aws_account_id,c.role_arn,c.external_id,
       coalesce(c.feedback_topic_arn,p.feedback_topic_arn) AS feedback_topic_arn,c.tenant_provisioned
FROM provider_connections c LEFT JOIN provider_pool_regions p ON c.kind='shared' AND p.region=c.region AND p.aws_account_id=c.aws_account_id AND p.ready
WHERE c.status='ready' AND coalesce(c.feedback_topic_arn,p.feedback_topic_arn) IS NOT NULL;
-- Simulation needs neither a real account nor a feedback subscription. The cold shard never sends live mail.
CREATE VIEW provider_test_connections AS
SELECT id,workspace_id,kind,region,coalesce(aws_account_id,'000000000000') AS aws_account_id,role_arn,external_id,feedback_topic_arn,tenant_provisioned
FROM provider_connections WHERE status='ready';

ALTER TABLE domain_claims ADD COLUMN readiness jsonb;
-- Old BYO discovery imported identities without provenance; never authorize those based on discovery alone.
UPDATE domain_claims dc SET verified=false, ready=false FROM provider_connections c WHERE dc.connection_id=c.id AND c.kind='byo';
INSERT INTO jobs(id,type,workspace_id,environment,payload)
SELECT 'domain.verify:'||dc.token,'domain.verify',d.workspace_id,'live',jsonb_build_object('domainId',d.id,'token',dc.token)
FROM domain_claims dc JOIN provider_connections c ON c.id=dc.connection_id
JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name AND d.region=c.region AND d.environment='live';

-- A single network round trip, but distinct READ COMMITTED snapshots before/after waiting for the
-- namespace lock. Every overlapping pair shares its last two labels. No lock spans identity creation.
CREATE FUNCTION reserve_domain_claim(wid text, host text, requested_region text, new_id text) RETURNS TABLE
  (connection jsonb, token uuid, id text, readiness jsonb, fresh boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE pc provider_connections%ROWTYPE; claim domain_claims%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(host FROM '[^.]+\.[^.]+$'),84912));
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND c.region=requested_region AND c.status='ready' FOR SHARE OF s,c;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  connection := to_jsonb(pc);
  IF EXISTS (SELECT 1 FROM domain_claims dc WHERE dc.workspace_id<>wid AND (
    right('.'||dc.name,length(host)+1)='.'||host OR right('.'||host,length(dc.name)+1)='.'||dc.name)) THEN RETURN NEXT; RETURN; END IF;
  SELECT dc.* INTO claim FROM domain_claims dc WHERE dc.name=host FOR UPDATE;
  fresh := NOT FOUND;
  IF fresh THEN
    INSERT INTO domain_claims(name,workspace_id,connection_id) VALUES(host,wid,pc.id) RETURNING * INTO claim;
  ELSIF claim.workspace_id=wid AND claim.connection_id IS NULL THEN
    -- A pre-upgrade disconnect retained this claim. Verify its original tag; never adopt an untagged identity.
    fresh := true;
    UPDATE domain_claims dc SET connection_id=pc.id,verified=false,ready=false,readiness=NULL WHERE dc.name=host RETURNING * INTO claim;
  ELSIF claim.workspace_id=wid AND claim.connection_id=pc.id THEN
    SELECT d.id INTO id FROM operation_domains d WHERE d.workspace_id=wid AND d.name=host AND d.environment='live' AND d.region=requested_region;
    token := claim.token; readiness := claim.readiness; RETURN NEXT; RETURN;
  ELSE RETURN NEXT; RETURN;
  END IF;
  token := claim.token;
  INSERT INTO operation_domains AS d(id,name,workspace_id,environment,region) VALUES(new_id,host,wid,'live',requested_region)
    ON CONFLICT(workspace_id,environment,name,region) DO UPDATE SET updated_at=now() RETURNING d.id INTO id;
  INSERT INTO jobs(id,workspace_id,environment,type,payload,available_at) VALUES('domain.verify:'||claim.token,wid,'live','domain.verify',
    jsonb_build_object('domainId',id,'token',claim.token,'start',floor(extract(epoch FROM now())*1000)),now()+interval '5 seconds')
    ON CONFLICT ON CONSTRAINT jobs_pkey DO UPDATE SET payload=excluded.payload,available_at=excluded.available_at,status='pending',lease_until=NULL;
  RETURN NEXT;
END $$;
