SET LOCAL lock_timeout='1s';
ALTER TABLE provider_pool_regions ADD COLUMN generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN confirmed_generation bigint, ADD COLUMN ownership_journal jsonb NOT NULL DEFAULT '[]';
-- Persist v8 names, never derive a new tenant name for an existing Ohio connection.
ALTER TABLE provider_connections ADD COLUMN pool_tenant_name text;
ALTER TABLE provider_connection_regions ADD COLUMN pool_tenant_name text;
CREATE OR REPLACE VIEW regional_connections AS
SELECT c.id,c.workspace_id,c.kind,r.region,c.aws_account_id,c.role_arn,c.external_id,
  CASE c.kind WHEN 'shared' THEN p.feedback_topic_arn ELSE r.feedback_topic_arn END AS feedback_topic_arn,r.tenant_state,c.paused_at,c.pause_reason,r.generation,
  CASE c.kind WHEN 'shared' THEN coalesce(p.legacy_names,r.legacy) ELSE r.legacy END AS legacy_names,p.pool_tier,p.sending_state AS pool_state,
  r.managed_tenant,r.legacy,r.sending_state,r.receiving_state,c.state,c.template_version,
  CASE WHEN r.legacy THEN c.pool_tenant_name ELSE r.pool_tenant_name END AS pool_tenant_name
FROM provider_connection_regions r JOIN provider_connections c ON c.id=r.connection_id
LEFT JOIN provider_pool_regions p ON c.kind='shared' AND p.region=r.region AND p.aws_account_id=c.aws_account_id;
CREATE OR REPLACE VIEW regional_simulated_connections AS SELECT id,workspace_id,kind,region,coalesce(aws_account_id,'000000000000') AS aws_account_id,
  role_arn,external_id,feedback_topic_arn,tenant_state,paused_at,pause_reason,generation,legacy_names,pool_tier,pool_state,managed_tenant,template_version,pool_tenant_name
  FROM regional_connections WHERE state='ready' AND sending_state='ready';
CREATE OR REPLACE VIEW regional_sending_connections AS SELECT * FROM regional_simulated_connections
  WHERE feedback_topic_arn LIKE 'arn:aws:sns:'||region||':'||aws_account_id||':%' AND (kind='byo' OR pool_state='ready');

CREATE TABLE hosted_domain_tiers(connection_id text REFERENCES provider_connections ON DELETE CASCADE,name text NOT NULL,
  tier text NOT NULL CHECK(tier IN ('trusted','probation')),PRIMARY KEY(connection_id,name));
CREATE TABLE hosted_operator_audit(at timestamptz NOT NULL DEFAULT clock_timestamp(), db_actor text NOT NULL DEFAULT session_user,
  workspace_id text NOT NULL,action text NOT NULL,details jsonb NOT NULL);
-- SES tenants outlive connection disconnect. Reuse only the recorded ARN, never a name collision.
CREATE TABLE hosted_tenant_ownership(workspace_id text NOT NULL,region text NOT NULL,arn text NOT NULL UNIQUE,PRIMARY KEY(workspace_id,region));
-- Retain provenance through domain delete/disconnect (including an interrupted adoption).
CREATE TABLE hosted_adoptions(name text PRIMARY KEY,arn text UNIQUE NOT NULL,workspace_id text NOT NULL,
  manifest_hash text NOT NULL,tenant_arn text NOT NULL,associated boolean NOT NULL DEFAULT false);
CREATE FUNCTION protect_adopted_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.region='us-east-1' AND EXISTS(SELECT FROM hosted_adoptions a JOIN domain_claims dc ON dc.name=a.name AND dc.workspace_id=NEW.workspace_id
    JOIN provider_connections c ON c.id=dc.connection_id WHERE a.name=NEW.name AND c.kind='shared' AND
    (a.workspace_id<>NEW.workspace_id OR dc.identity->'adopted'->>'arn' IS DISTINCT FROM a.arn)) THEN
    RAISE EXCEPTION 'An adopted identity may only be rebound by its operator';
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER protect_adopted_binding BEFORE INSERT ON operation_domains FOR EACH ROW EXECUTE FUNCTION protect_adopted_binding();

-- Take the same workspace lock as reservations and the operator. Never trust a region from a caller
-- as a placement decision. Published bindings are immutable (including on idempotent POST).
CREATE FUNCTION reserve_placed_claim(wid text,host text,requested text,new_id text)
RETURNS TABLE(connection jsonb,token uuid,id text,readiness jsonb,fresh boolean,error_code text)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE pc provider_connections%ROWTYPE; selected text;
BEGIN
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND c.kind='shared' FOR NO KEY UPDATE OF s FOR SHARE OF c;
  IF NOT FOUND THEN RETURN QUERY SELECT * FROM reserve_regional_claim(wid,host,requested,new_id); RETURN; END IF;
  SELECT coalesce((SELECT b.region FROM domain_sending_bindings b WHERE b.workspace_id=wid AND b.name=host),
    (SELECT CASE t.tier WHEN 'trusted' THEN 'us-east-1' ELSE 'us-east-2' END FROM hosted_domain_tiers t WHERE t.connection_id=pc.id AND t.name=host),pc.region) INTO selected;
  IF requested IS NOT NULL AND requested<>selected THEN connection:=to_jsonb(pc);error_code:='POOL_PLACEMENT_MANAGED';RETURN NEXT;RETURN;END IF;
  IF selected='us-east-1' AND EXISTS(SELECT FROM hosted_adoptions a WHERE a.name=host) AND NOT EXISTS(
    SELECT FROM domain_sending_bindings b JOIN domain_claims dc USING(workspace_id,name,connection_id) JOIN hosted_adoptions a ON a.name=b.name
    WHERE b.workspace_id=wid AND b.connection_id=pc.id AND b.region=selected AND b.name=host AND dc.identity->'adopted'->>'arn'=a.arn) THEN
    connection:=to_jsonb(pc);error_code:='OPERATOR_ADOPTION_REQUIRED';RETURN NEXT;RETURN;
  END IF;
  RETURN QUERY SELECT * FROM reserve_regional_claim(wid,host,selected,new_id,NULL,true);
END $$;
