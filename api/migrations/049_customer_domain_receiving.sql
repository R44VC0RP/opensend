-- Publish the bucket as the regional readiness marker only after the catch-all rule is installed.
UPDATE provider_pool_regions SET inbound_bucket=NULL WHERE inbound_domain IS NULL;
ALTER TABLE provider_pool_regions DROP COLUMN inbound_domain, DROP COLUMN inbound_dns;
ALTER TABLE domain_claims ADD COLUMN receiving_name text CHECK (receiving_name IN (name,'reply.'||name)),
  ADD COLUMN receiving_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN txt_misses smallint NOT NULL DEFAULT 0, ADD COLUMN mx_misses smallint NOT NULL DEFAULT 0;
-- name remains the claimed domain. One row owns the policy and addresses for its receiving host.
ALTER TABLE mailbox_domains ADD COLUMN receiving_host text, ADD COLUMN mx_misses smallint NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX mailbox_domains_receiving_host ON mailbox_domains(workspace_id,environment,receiving_host)
  WHERE receiving_host IS NOT NULL AND status IN ('active','provisioning');

-- Do not discard mail or historical addresses. Old routing was based on sending readiness alone.
UPDATE mailbox_domains m SET status='disabled' WHERE domain_id LIKE 'instant:%' OR EXISTS (
  SELECT 1 FROM operation_domains d JOIN domain_claims dc ON dc.name=d.name AND dc.workspace_id=d.workspace_id
  WHERE d.id=m.domain_id AND d.workspace_id=m.workspace_id AND d.environment='live');

-- Fold 048's implicit reply child back into its parent without deleting an address or message.
CREATE TEMP TABLE mx_reply_children ON COMMIT DROP AS
SELECT child.id,parent.id AS parent FROM mailbox_domains child JOIN mailbox_domains parent ON parent.id=child.parent_id
JOIN operation_domains d ON d.id=parent.domain_id AND d.workspace_id=parent.workspace_id AND d.environment='live'
JOIN domain_claims dc ON dc.name=d.name AND dc.workspace_id=d.workspace_id
WHERE child.name='reply.'||d.name AND child.domain_id=d.id AND child.workspace_id=dc.workspace_id;
UPDATE mailboxes m SET domain_id=r.parent FROM mx_reply_children r WHERE m.domain_id=r.id;
UPDATE mail_messages m SET domain_id=r.parent FROM mx_reply_children r WHERE m.domain_id=r.id;
UPDATE mailbox_domains m SET parent_id=r.parent FROM mx_reply_children r WHERE m.parent_id=r.id;
DELETE FROM mailbox_domains m USING mx_reply_children r WHERE m.id=r.id;

-- Keep sending records available while the first exact-host MX check is pending.
UPDATE domain_claims dc SET readiness=readiness || jsonb_build_object(
  'sending',CASE WHEN ready THEN 'verified' ELSE 'pending' END,'receiving','pending',
  'dns',coalesce((SELECT jsonb_agg(r || jsonb_build_object(
    'purpose',CASE WHEN r->>'purpose'='mail_from' THEN 'mail_from' ELSE 'sending' END,
    'status',CASE WHEN (r->>'purpose'='dkim' AND readiness->>'dkimStatus'='SUCCESS') OR (r->>'purpose'='ownership' AND verified)
      OR (r->>'purpose'='mail_from' AND readiness->>'mailFromStatus'='SUCCESS') THEN 'verified' ELSE 'pending' END) ORDER BY n)
    FROM jsonb_array_elements(readiness->'dns') WITH ORDINALITY a(r,n) WHERE r->>'purpose' IS DISTINCT FROM 'inbound'),'[]'::jsonb)
    || jsonb_build_array(jsonb_build_object('purpose','receiving','type','MX','priority',10,'name',dc.name,'value','inbound-smtp.'||(readiness->>'region')||'.amazonaws.com','status','pending'))
) WHERE readiness IS NOT NULL;

INSERT INTO jobs(id,type,workspace_id,environment,payload,available_at)
SELECT 'domain.verify:'||dc.token,'domain.verify',dc.workspace_id,'live',jsonb_build_object('domainId',d.id,'token',dc.token),now()+interval '2 minutes'
FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.status='ready'
JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.environment='live' AND d.name=dc.name AND d.region=pc.region
ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,lease_until=NULL WHERE jobs.status<>'running';

-- Retire legacy BYO wildcard/rules even if none of their domains prove MX after the upgrade.
INSERT INTO jobs(id,type,workspace_id,environment,payload,available_at)
SELECT 'mailbox.claims:'||c.id,'mailbox.reconcile',c.workspace_id,'live',jsonb_build_object('region',c.region),now()+interval '2 minutes'
FROM provider_connections c JOIN mailbox_regions r ON r.workspace_id=c.workspace_id AND r.region=c.region AND r.account_id=c.aws_account_id
WHERE c.kind='byo' AND c.status='ready' AND r.rule_set_name IS NOT NULL ON CONFLICT DO NOTHING;
