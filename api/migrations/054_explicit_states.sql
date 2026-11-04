-- Expand only: one explicit state per entity, backfilled from the booleans, counters and JSON it replaces.
-- The previous release (dd4273d) keeps running against this schema: its columns, their values and the
-- reserve_domain_claim signature are untouched, and triggers keep old and new columns consistent in both
-- directions until 055 drops the old ones.

-- Domain claims: sending_state + receiving_state + the routing host. Each side's `*lost_since` starts the grace
-- period that the miss counters used to count. `identity` holds SES/DNS facts only; readiness is derived on read.
ALTER TABLE domain_claims
  ADD COLUMN sending_state text NOT NULL DEFAULT 'pending' CHECK (sending_state IN ('pending','verified','lost','failed')),
  ADD COLUMN receiving_state text NOT NULL DEFAULT 'off' CHECK (receiving_state IN ('off','pending','active','lost')),
  ADD COLUMN receiving_host text CHECK (receiving_host IN (name,'reply.'||name)),
  ADD COLUMN lost_since timestamptz,
  ADD COLUMN receiving_lost_since timestamptz,
  ADD COLUMN identity jsonb;
UPDATE domain_claims SET
  sending_state=CASE WHEN readiness->>'verificationStatus'='FAILED' THEN 'failed' WHEN verified AND txt_misses>0 THEN 'lost' WHEN verified THEN 'verified' ELSE 'pending' END,
  receiving_state=CASE WHEN readiness->>'verificationStatus'='FAILED' THEN 'off' WHEN readiness->>'receiving'='verified' AND receiving_name IS NOT NULL AND mx_misses>0 THEN 'lost'
    WHEN readiness->>'receiving'='verified' AND receiving_name IS NOT NULL THEN 'active' WHEN receiving_eligible THEN 'pending' ELSE 'off' END,
  receiving_host=CASE WHEN readiness->>'verificationStatus'='FAILED' THEN NULL WHEN readiness->>'receiving'='verified' OR receiving_eligible THEN receiving_name END,
  lost_since=CASE WHEN verified AND txt_misses>0 AND readiness->>'verificationStatus' IS DISTINCT FROM 'FAILED' THEN now() END,
  receiving_lost_since=CASE WHEN readiness->>'receiving'='verified' AND receiving_name IS NOT NULL AND mx_misses>0 AND readiness->>'verificationStatus' IS DISTINCT FROM 'FAILED' THEN now() END,
  identity=CASE WHEN readiness IS NULL OR connection_id IS NULL THEN NULL ELSE jsonb_build_object(
    'ses',jsonb_build_object(
      -- A receive-only domain has a verified SES identity even while DKIM is pending.
      'VerificationStatus',CASE WHEN receiving_eligible OR readiness->>'receiving'='verified' OR verified THEN 'SUCCESS' WHEN readiness->>'verificationStatus'='FAILED' THEN 'PENDING' ELSE coalesce(readiness->>'verificationStatus','PENDING') END,
      'VerifiedForSendingStatus',verified,
      'DkimAttributes',jsonb_build_object('Status',readiness->>'dkimStatus','SigningEnabled',readiness->>'dkimStatus'='SUCCESS','SigningAttributesOrigin','AWS_SES',
        'SigningHostedZone',(SELECT substring(r->>'value' FROM '^[^.]+\.(.*)$') FROM jsonb_array_elements(readiness->'dns') r WHERE r->>'type'='CNAME' LIMIT 1),
        'Tokens',coalesce((SELECT jsonb_agg(split_part(r->>'name','.',1)) FROM jsonb_array_elements(readiness->'dns') r WHERE r->>'type'='CNAME'),'[]'::jsonb)),
      'MailFromAttributes',CASE WHEN readiness->>'mailFromDomain' IS NULL THEN NULL ELSE jsonb_build_object('MailFromDomain',readiness->>'mailFromDomain','MailFromDomainStatus',readiness->>'mailFromStatus') END),
    'proven',EXISTS (SELECT 1 FROM jsonb_array_elements(readiness->'dns') r WHERE r->>'type'='TXT' AND r->>'purpose'='sending' AND r->>'status'='verified'),
    'mx',(SELECT m.mx FROM mailbox_domains m WHERE m.workspace_id=domain_claims.workspace_id AND m.name=domain_claims.name AND m.parent_id IS NULL),
    'note',(SELECT r->>'note' FROM jsonb_array_elements(readiness->'dns') r WHERE r->>'purpose'='receiving' LIMIT 1)) END;
-- Detached claims (no connection) always sit at the start of both machines; the trigger below guarantees it
-- for every writer, including the previous release's disconnect.
CREATE FUNCTION domain_claims_detach_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.connection_id IS NULL THEN
    NEW.sending_state:='pending'; NEW.receiving_state:='off'; NEW.receiving_host:=NULL;
    NEW.lost_since:=NULL; NEW.receiving_lost_since:=NULL; NEW.identity:=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER domain_claims_detach_state BEFORE INSERT OR UPDATE ON domain_claims FOR EACH ROW EXECUTE FUNCTION domain_claims_detach_state();
ALTER TABLE domain_claims
  ADD CONSTRAINT domain_claims_routing_host CHECK (CASE receiving_state WHEN 'off' THEN receiving_host IS NULL WHEN 'pending' THEN true ELSE receiving_host IS NOT NULL END),
  ADD CONSTRAINT domain_claims_sending_grace CHECK ((lost_since IS NOT NULL) = (sending_state='lost')),
  ADD CONSTRAINT domain_claims_receiving_grace CHECK ((receiving_lost_since IS NOT NULL) = (receiving_state='lost')),
  ADD CONSTRAINT domain_claims_failed_off CHECK (sending_state<>'failed' OR receiving_state='off'),
  ADD CONSTRAINT domain_claims_detached CHECK (connection_id IS NOT NULL OR (sending_state='pending' AND receiving_state='off' AND receiving_host IS NULL AND lost_since IS NULL AND receiving_lost_since IS NULL AND identity IS NULL));
CREATE UNIQUE INDEX domain_claims_routing ON domain_claims(workspace_id,receiving_host) WHERE receiving_host IS NOT NULL;

-- Provider connections: `state` is the four-state connection state next to the old two-state `status`;
-- `tenant_state` replaces `tenant_provisioned`. Kept in step both ways until 055.
ALTER TABLE provider_connections
  ADD COLUMN state text NOT NULL DEFAULT 'awaiting_role' CHECK (state IN ('awaiting_role','provisioning','ready','failed')),
  ADD COLUMN tenant_state text NOT NULL DEFAULT 'pending' CHECK (tenant_state IN ('pending','ready','failed'));
UPDATE provider_connections SET state=CASE WHEN status='ready' THEN 'ready' WHEN coalesce(lease_until,'-infinity')>now() THEN 'provisioning' ELSE 'awaiting_role' END,
  tenant_state=CASE WHEN kind='byo' OR tenant_provisioned THEN 'ready' ELSE 'pending' END;
CREATE FUNCTION provider_connections_sync_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status='ready' OR NEW.state='ready' THEN NEW.status:='ready'; NEW.state:='ready'; END IF;
    IF NEW.tenant_provisioned OR NEW.tenant_state='ready' THEN NEW.tenant_provisioned:=true; NEW.tenant_state:='ready'; END IF;
  ELSE
    IF NEW.state IS DISTINCT FROM OLD.state THEN NEW.status:=CASE WHEN NEW.state='ready' THEN 'ready' ELSE 'pending' END;
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN NEW.state:=CASE WHEN NEW.status='ready' THEN 'ready' WHEN OLD.state='ready' THEN 'awaiting_role' ELSE OLD.state END;
    END IF;
    IF NEW.tenant_state IS DISTINCT FROM OLD.tenant_state THEN NEW.tenant_provisioned:=NEW.tenant_state='ready';
    ELSIF NEW.tenant_provisioned IS DISTINCT FROM OLD.tenant_provisioned THEN NEW.tenant_state:=CASE WHEN NEW.tenant_provisioned THEN 'ready' ELSE 'pending' END;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_connections_sync_state BEFORE INSERT OR UPDATE ON provider_connections FOR EACH ROW EXECUTE FUNCTION provider_connections_sync_state();
CREATE INDEX provider_connections_dispatch_state ON provider_connections(aws_account_id, region, workspace_id) WHERE state='ready';

-- Pool regions: sending and receiving readiness are separate states; inbound_bucket is a fact again.
ALTER TABLE provider_pool_regions
  ADD COLUMN sending_state text NOT NULL DEFAULT 'pending' CHECK (sending_state IN ('pending','ready')),
  ADD COLUMN receiving_state text NOT NULL DEFAULT 'pending' CHECK (receiving_state IN ('pending','ready'));
UPDATE provider_pool_regions SET sending_state=CASE WHEN ready THEN 'ready' ELSE 'pending' END, receiving_state=CASE WHEN inbound_bucket IS NOT NULL THEN 'ready' ELSE 'pending' END;
CREATE FUNCTION provider_pool_regions_sync_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ready OR NEW.sending_state='ready' THEN NEW.ready:=true; NEW.sending_state:='ready'; END IF;
  IF NEW.inbound_bucket IS NOT NULL THEN NEW.receiving_state:='ready'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_pool_regions_sync_state BEFORE INSERT OR UPDATE ON provider_pool_regions FOR EACH ROW EXECUTE FUNCTION provider_pool_regions_sync_state();

CREATE OR REPLACE VIEW provider_sending_connections AS
SELECT c.id,c.workspace_id,c.kind,c.region,c.aws_account_id,c.role_arn,c.external_id,
       coalesce(c.feedback_topic_arn,p.feedback_topic_arn) AS feedback_topic_arn,c.tenant_state='ready' AS tenant_provisioned,c.tenant_state
FROM provider_connections c LEFT JOIN provider_pool_regions p ON c.kind='shared' AND p.region=c.region AND p.aws_account_id=c.aws_account_id AND p.sending_state='ready'
WHERE c.state='ready' AND coalesce(c.feedback_topic_arn,p.feedback_topic_arn) IS NOT NULL;
CREATE OR REPLACE VIEW provider_simulated_connections AS
SELECT id, workspace_id, kind, region, coalesce(aws_account_id, '000000000000') AS aws_account_id,
       role_arn, external_id, feedback_topic_arn, tenant_state='ready' AS tenant_provisioned, tenant_state
FROM provider_connections WHERE state = 'ready';

-- Re-read every attached claim soon so the backfilled facts are replaced by a real observation.
INSERT INTO jobs(id,type,workspace_id,payload,available_at)
SELECT 'domain.verify:'||dc.token,'domain.verify',dc.workspace_id,jsonb_build_object('domainId',d.id,'token',dc.token),now()+interval '2 minutes'
FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.state='ready'
JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name AND d.region=pc.region
ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL WHERE jobs.status<>'running';
