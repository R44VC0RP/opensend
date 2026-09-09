CREATE TABLE sending_emails (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('live','test')),
  region text NOT NULL, actor_key_id text NOT NULL, campaign_id text, from_address text NOT NULL,
  to_addresses jsonb NOT NULL, cc_addresses jsonb NOT NULL, bcc_addresses jsonb NOT NULL, subject text NOT NULL,
  status text NOT NULL DEFAULT 'queued', provider_id text, snapshot jsonb NOT NULL, simulated boolean NOT NULL,
  attempt_started_at timestamptz, error_code text, scheduled_at timestamptz, dispatch_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sending_emails_page ON sending_emails(workspace_id, environment, id);
CREATE INDEX sending_emails_campaign ON sending_emails(workspace_id, environment, campaign_id);
CREATE UNIQUE INDEX sending_emails_provider ON sending_emails(workspace_id, environment, region, provider_id);
CREATE TABLE sending_email_events (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('live','test')),
  email_id text NOT NULL, type text NOT NULL, provider_id text, external_id text, data jsonb NOT NULL DEFAULT '{}',
  simulated boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sending_events_page ON sending_email_events(workspace_id, environment, email_id, id);
CREATE UNIQUE INDEX sending_events_external ON sending_email_events(workspace_id, environment, external_id);
CREATE TABLE sending_attachments (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('live','test')),
  filename text NOT NULL, content_type text NOT NULL, size integer NOT NULL CHECK(size > 0 AND size <= 8388608),
  disposition text NOT NULL, content_id text, storage_key text NOT NULL, checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sending_attachments_page ON sending_attachments(workspace_id, environment, id);
CREATE TABLE sending_attachment_links (
  workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('live','test')),
  attachment_id text NOT NULL REFERENCES sending_attachments(id), owner_type text NOT NULL, owner_id text NOT NULL,
  PRIMARY KEY(workspace_id,environment,attachment_id,owner_type,owner_id)
);
CREATE INDEX sending_attachment_owner ON sending_attachment_links(workspace_id,environment,owner_type,owner_id);
CREATE TABLE sending_campaigns (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('live','test')),
  revision integer NOT NULL DEFAULT 1, draft jsonb NOT NULL, status text NOT NULL DEFAULT 'draft', review_id text,
  scheduled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sending_campaigns_page ON sending_campaigns(workspace_id,environment,id);
CREATE TABLE sending_campaign_reviews (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('live','test')),
  campaign_id text NOT NULL, revision integer NOT NULL, draft jsonb NOT NULL, recipients jsonb NOT NULL,
  matched integer NOT NULL, eligible integer NOT NULL, suppressed integer NOT NULL, unsubscribed integer NOT NULL,
  content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sending_review_campaign ON sending_campaign_reviews(workspace_id,environment,campaign_id);
CREATE TABLE sending_region_limits (
  workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('live','test')), region text NOT NULL,
  max_send_rate double precision NOT NULL DEFAULT 0, max_24_hour_send double precision NOT NULL DEFAULT 0,
  sent_last_24_hours double precision NOT NULL DEFAULT 0, reserved integer NOT NULL DEFAULT 0,
  checked_at timestamptz, next_allowed_at timestamptz, PRIMARY KEY(workspace_id,environment,region)
);
CREATE TABLE sending_idempotency (
  workspace_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('live','test')), actor_key_id text NOT NULL,
  path text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,environment,actor_key_id,path,request_key)
);
