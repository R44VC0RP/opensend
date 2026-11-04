ALTER TABLE provider_pool_regions ADD COLUMN inbound_topic_arn text UNIQUE,
  ADD COLUMN inbound_bucket text, ADD COLUMN inbound_domain text, ADD COLUMN inbound_dns jsonb;
-- Existing signup slugs include the immutable 32-character workspace suffix. Keep that unique suffix.
UPDATE workspaces SET slug=left(slug,30)||'-'||right(slug,32) WHERE length(slug)>63 AND right(slug,32)=substring(id from 4);
ALTER TABLE mailbox_write_lanes ADD COLUMN workspace_id text NOT NULL DEFAULT 'default', DROP CONSTRAINT mailbox_write_lanes_pkey;
ALTER TABLE mailbox_write_lanes ADD PRIMARY KEY(workspace_id,lane);
-- A pending outbound archive retains its immutable sending upload until the S3 copy succeeds.
ALTER TABLE mail_attachments ADD COLUMN source_attachment_id text REFERENCES sending_attachments(id);
-- Existing self-hosted receiving needs the staging prefix and scoped-object lifecycle, too.
INSERT INTO jobs(id,type,workspace_id,environment,payload) SELECT 'mailbox.prefix:'||workspace_id||':'||region,'mailbox.reconcile',workspace_id,'live',jsonb_build_object('region',region)
  FROM mailbox_regions WHERE topic_arn IS NOT NULL ON CONFLICT DO NOTHING;
-- Re-read existing Hosted identities in the usual fenced verifier so they also get DNS and receiving state.
INSERT INTO jobs(id,type,workspace_id,environment,payload)
 SELECT 'domain.verify:'||dc.token,'domain.verify',dc.workspace_id,'live',jsonb_build_object('domainId',d.id,'token',dc.token)
 FROM domain_claims dc JOIN provider_connections c ON c.id=dc.connection_id AND c.kind='shared'
 JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.environment='live' AND d.name=dc.name AND d.region=c.region
 WHERE dc.ready ON CONFLICT(id) DO UPDATE SET status='pending',available_at=now(),attempts=0 WHERE jobs.status NOT IN ('pending','running');
