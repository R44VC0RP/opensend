-- Expand only. Never lock, index or rewrite the mail queue/history. The backfill runs in
-- a separate transaction after these short metadata locks have been released.
SET LOCAL lock_timeout='1s';
ALTER TABLE provider_pool_regions ADD COLUMN pool_tier text CHECK (pool_tier IN ('probation','trusted')),
  ADD COLUMN legacy_names boolean NOT NULL DEFAULT true,
  ADD CHECK (legacy_names OR (pool_tier IS NOT NULL AND ((region='us-east-1' AND pool_tier='trusted') OR (region='us-east-2' AND pool_tier='probation')))) NOT VALID;
CREATE FUNCTION legacy_pool_tier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pool_tier IS NULL AND NEW.region IN ('us-east-1','us-east-2') THEN NEW.pool_tier:=CASE NEW.region WHEN 'us-east-1' THEN 'trusted' ELSE 'probation' END; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_pool_tier BEFORE INSERT ON provider_pool_regions FOR EACH ROW EXECUTE FUNCTION legacy_pool_tier();
ALTER TABLE provider_connections ADD COLUMN managed_tenant boolean NOT NULL DEFAULT false;

CREATE TABLE provider_connection_regions (
  connection_id text REFERENCES provider_connections(id) ON DELETE CASCADE, region text NOT NULL,
  PRIMARY KEY(connection_id,region), legacy boolean NOT NULL DEFAULT false, managed_tenant boolean NOT NULL DEFAULT true,
  scan_revision bigint NOT NULL DEFAULT 0, scan_state text NOT NULL DEFAULT 'awaiting_role' CHECK(scan_state IN ('awaiting_role','scanning','ready_to_import','failed')),
  sending_state text NOT NULL DEFAULT 'unprovisioned' CHECK(sending_state IN ('unprovisioned','provisioning','ready','disabled','failed')),
  receiving_state text NOT NULL DEFAULT 'off' CHECK(receiving_state IN ('off','review','provisioning','active','disabling')),
  tenant_state text NOT NULL DEFAULT 'pending' CHECK(tenant_state IN ('pending','ready','failed')),
  lease_until timestamptz, generation bigint NOT NULL DEFAULT 1 CHECK(generation>0), receiving_generation bigint NOT NULL DEFAULT 1,
  feedback_topic_arn text UNIQUE, confirmed_topic_arn text, confirmed_generation bigint, inbound_topic_arn text, ownership_journal jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX managed_connection_binding ON provider_connection_regions(connection_id) WHERE NOT legacy AND sending_state<>'unprovisioned';
-- A side table keeps self-hosted domains (where a name may exist in several regions)
-- out of this constraint and avoids building an index or rewriting operation_domains.
CREATE TABLE domain_sending_bindings (
  workspace_id text NOT NULL, name text NOT NULL, PRIMARY KEY(workspace_id,name),
  domain_id text NOT NULL UNIQUE REFERENCES operation_domains(id) ON DELETE CASCADE,
  connection_id text NOT NULL, region text NOT NULL,
  FOREIGN KEY(connection_id,region) REFERENCES provider_connection_regions(connection_id,region) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,name) REFERENCES domain_claims(workspace_id,name) ON DELETE CASCADE
);
CREATE FUNCTION immutable_sending_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Release the domain before selecting another sending binding'; END $$;
CREATE TRIGGER immutable_sending_binding BEFORE UPDATE ON domain_sending_bindings FOR EACH ROW EXECUTE FUNCTION immutable_sending_binding();
CREATE FUNCTION keep_bound_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT FROM domain_sending_bindings WHERE domain_id=OLD.id) THEN RAISE EXCEPTION 'A bound domain is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER keep_bound_domain BEFORE UPDATE OF workspace_id,name,region ON operation_domains FOR EACH ROW
  WHEN ((NEW.workspace_id,NEW.name,NEW.region) IS DISTINCT FROM (OLD.workspace_id,OLD.name,OLD.region)) EXECUTE FUNCTION keep_bound_domain();

-- Published feedback remains notification-only after disconnect/disable/rotation. There is
-- intentionally no FK back to the connection. Pending registrations never enter this table.
CREATE TABLE provider_feedback_history (topic_arn text PRIMARY KEY, region text NOT NULL, aws_account_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('byo','shared')));
CREATE FUNCTION remember_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE acct text; provider text;
BEGIN
  IF TG_TABLE_NAME='provider_pool_regions' THEN acct:=NEW.aws_account_id; provider:='shared';
  ELSE SELECT aws_account_id,kind INTO acct,provider FROM provider_connections WHERE id=NEW.connection_id; END IF;
  IF NEW.feedback_topic_arn LIKE 'arn:aws:sns:'||NEW.region||':'||acct||':%' THEN
    INSERT INTO provider_feedback_history VALUES(NEW.feedback_topic_arn,NEW.region,acct,provider) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER published_pool_feedback AFTER INSERT OR UPDATE OF sending_state,feedback_topic_arn ON provider_pool_regions
  FOR EACH ROW WHEN(NEW.sending_state='ready' AND NEW.feedback_topic_arn IS NOT NULL) EXECUTE FUNCTION remember_feedback();
CREATE TRIGGER published_connection_feedback AFTER INSERT OR UPDATE OF sending_state,feedback_topic_arn ON provider_connection_regions
  FOR EACH ROW WHEN(NEW.sending_state='ready' AND NEW.feedback_topic_arn IS NOT NULL) EXECUTE FUNCTION remember_feedback();

-- Only the singleton release writes these fields. Never project a v5 connection back over
-- a managed regional row: rescanning or enabling a sibling must not change its readiness.
CREATE FUNCTION mirror_legacy_connection(c provider_connections) RETURNS void LANGUAGE sql AS $$
  INSERT INTO provider_connection_regions AS r(connection_id,region,legacy,managed_tenant,scan_state,sending_state,tenant_state,feedback_topic_arn,lease_until)
  SELECT c.id,c.region,true,c.managed_tenant,CASE c.state WHEN 'ready' THEN 'ready_to_import' WHEN 'provisioning' THEN 'scanning' ELSE 'awaiting_role' END,
    CASE c.state WHEN 'awaiting_role' THEN 'unprovisioned' ELSE c.state END,c.tenant_state,c.feedback_topic_arn,c.lease_until
  WHERE c.kind='shared' OR c.template_version<>'v5'
  ON CONFLICT(connection_id,region) DO UPDATE SET scan_state=excluded.scan_state,sending_state=excluded.sending_state,
    tenant_state=excluded.tenant_state,feedback_topic_arn=excluded.feedback_topic_arn,lease_until=excluded.lease_until WHERE r.legacy
$$;
CREATE FUNCTION mirror_legacy_connection_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM mirror_legacy_connection(NEW); RETURN NULL; END $$;
CREATE TRIGGER mirror_legacy_connection AFTER INSERT OR UPDATE OF state,tenant_state,feedback_topic_arn,lease_until,aws_account_id ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION mirror_legacy_connection_trigger();
CREATE FUNCTION mirror_legacy_receiving() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE provider_connection_regions r SET inbound_topic_arn=NEW.topic_arn,receiving_state=CASE WHEN NEW.last_reconciled_at IS NOT NULL AND NEW.topic_arn IS NOT NULL THEN 'active'
    WHEN NEW.topic_arn IS NOT NULL THEN 'provisioning' ELSE 'off' END FROM provider_connections c
    WHERE r.connection_id=c.id AND r.legacy AND r.region=NEW.region AND c.workspace_id=NEW.workspace_id AND c.kind='byo' AND c.aws_account_id=NEW.account_id;
  RETURN NULL;
END $$;
CREATE TRIGGER mirror_legacy_receiving AFTER INSERT OR UPDATE OF topic_arn,last_reconciled_at,account_id ON mailbox_regions FOR EACH ROW EXECUTE FUNCTION mirror_legacy_receiving();
CREATE FUNCTION bind_claim_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A legacy writer may reserve a domain between the DDL commit and the backfill. Its
  -- existing connection needs its singleton projection before the regional FK can be taken.
  PERFORM mirror_legacy_connection(c) FROM domain_claims dc JOIN provider_connections c ON c.id=dc.connection_id
    WHERE dc.workspace_id=NEW.workspace_id AND dc.name=NEW.name AND NEW.region=c.region AND NOT EXISTS
    (SELECT FROM provider_connection_regions r WHERE r.connection_id=c.id AND r.region=NEW.region);
  INSERT INTO domain_sending_bindings SELECT NEW.workspace_id,NEW.name,NEW.id,dc.connection_id,NEW.region FROM domain_claims dc
    WHERE dc.workspace_id=NEW.workspace_id AND dc.name=NEW.name AND dc.connection_id IS NOT NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER bind_claim_domain AFTER INSERT ON operation_domains FOR EACH ROW EXECUTE FUNCTION bind_claim_domain();

CREATE VIEW regional_connections AS
SELECT c.id,c.workspace_id,c.kind,r.region,c.aws_account_id,c.role_arn,c.external_id,
  CASE c.kind WHEN 'shared' THEN p.feedback_topic_arn ELSE r.feedback_topic_arn END AS feedback_topic_arn,r.tenant_state,c.paused_at,c.pause_reason,r.generation,
  CASE c.kind WHEN 'shared' THEN coalesce(p.legacy_names,r.legacy) ELSE r.legacy END AS legacy_names,p.pool_tier,p.sending_state AS pool_state,
  r.managed_tenant,r.legacy,r.sending_state,r.receiving_state,c.state
FROM provider_connection_regions r JOIN provider_connections c ON c.id=r.connection_id
LEFT JOIN provider_pool_regions p ON c.kind='shared' AND p.region=r.region AND p.aws_account_id=c.aws_account_id;
CREATE VIEW regional_simulated_connections AS SELECT id,workspace_id,kind,region,coalesce(aws_account_id,'000000000000') AS aws_account_id,
  role_arn,external_id,feedback_topic_arn,tenant_state,paused_at,pause_reason,generation,legacy_names,pool_tier,pool_state,managed_tenant
  FROM regional_connections WHERE state='ready' AND sending_state='ready';
CREATE VIEW regional_sending_connections AS SELECT * FROM regional_simulated_connections
  WHERE feedback_topic_arn LIKE 'arn:aws:sns:'||region||':'||aws_account_id||':%' AND (kind='byo' OR pool_state='ready');
CREATE VIEW regional_workspace_limits AS SELECT c.workspace_id,l.aws_account_id,l.region,l.refresh_after,l.checked_at,
  CASE c.kind WHEN 'shared' THEN l.max_send_rate/4 ELSE l.max_send_rate END AS max_send_rate,l.max_24_hour_send,l.sent_last_24_hours
  FROM regional_simulated_connections c JOIN provider_account_limits l USING(aws_account_id,region);

-- Choose the closest claim BEFORE checking its binding, proof or the regional tenant. A lost
-- child must never send on a verified parent. Row locks fence disable/reclaim against claim.
CREATE FUNCTION regional_sender(wid text,host text,simulated boolean) RETURNS TABLE(region text,verified boolean,binding jsonb,connection jsonb)
LANGUAGE sql VOLATILE AS $$
  WITH closest AS MATERIALIZED (SELECT dc.workspace_id,dc.name,dc.connection_id,dc.sending_state FROM domain_claims dc WHERE dc.workspace_id=wid
    AND right('.'||host,length(dc.name)+1)='.'||dc.name ORDER BY length(dc.name) DESC LIMIT 1 FOR SHARE),
  bound AS (SELECT b.domain_id,b.region,b.connection_id,r.generation FROM closest dc JOIN domain_sending_bindings b USING(workspace_id,name,connection_id)
    JOIN provider_connection_regions r USING(connection_id,region) FOR SHARE OF b,r)
  SELECT b.region,dc.sending_state IN ('verified','lost'),jsonb_build_object('domain',b.domain_id,'connection',b.connection_id,'generation',b.generation,'account',c.aws_account_id,'topic',c.feedback_topic_arn),
    CASE WHEN c.id IS NOT NULL THEN to_jsonb(c) END FROM closest dc JOIN bound b ON true
    LEFT JOIN regional_simulated_connections c ON c.id=b.connection_id AND c.region=b.region AND
      (simulated OR (c.feedback_topic_arn LIKE 'arn:aws:sns:'||b.region||':'||c.aws_account_id||':%' AND (c.kind='byo' OR c.pool_state='ready')))
$$;
