-- Mailbox service: inbound receiving per domain, stored messages, conversation threads,
-- mailboxes as address-based views with per-mailbox state, scoped keys, events and webhooks.

-- AWS receiving resources OpenSend owns in one region (bucket, SNS topic, receipt rule set).
CREATE TABLE IF NOT EXISTS mailbox_regions (
  workspace_id text NOT NULL,
  region text NOT NULL,
  account_id text,
  bucket text,
  topic_arn text,
  rule_set_name text,
  reconcile_lease_until timestamptz,
  last_reconciled_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, region)
);

-- Inbound state for one verified sending domain. The receipt rule accepts every address (catch-all).
CREATE TABLE IF NOT EXISTS mailbox_domains (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  domain_id text NOT NULL,
  name text NOT NULL,
  region text NOT NULL,
  status text NOT NULL,
  catch_all text NOT NULL DEFAULT 'create_mailbox',
  mx jsonb,
  last_error text,
  enabled_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_domains_status CHECK (status IN ('provisioning', 'waiting_for_mx', 'active', 'disabling', 'disabled', 'failed')),
  CONSTRAINT mailbox_domains_catch_all CHECK (catch_all IN ('create_mailbox', 'store'))
);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_domains_name ON mailbox_domains(workspace_id, environment, name);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_domains_domain ON mailbox_domains(workspace_id, environment, domain_id);
CREATE INDEX IF NOT EXISTS mailbox_domains_region ON mailbox_domains(workspace_id, region, status);

CREATE TABLE IF NOT EXISTS mailboxes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  domain_id text NOT NULL REFERENCES mailbox_domains(id),
  address text NOT NULL,
  display_name text,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  origin text NOT NULL DEFAULT 'api',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailboxes_origin CHECK (origin IN ('api', 'auto'))
);
CREATE INDEX IF NOT EXISTS mailboxes_page ON mailboxes(workspace_id, environment, id);
CREATE INDEX IF NOT EXISTS mailboxes_domain ON mailboxes(workspace_id, environment, domain_id);

-- Every address a mailbox owns (primary and aliases). An address belongs to at most one mailbox.
CREATE TABLE IF NOT EXISTS mailbox_addresses (
  workspace_id text NOT NULL,
  environment text NOT NULL,
  address text NOT NULL,
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, environment, address),
  CONSTRAINT mailbox_addresses_kind CHECK (kind IN ('primary', 'alias'))
);
CREATE INDEX IF NOT EXISTS mailbox_addresses_mailbox ON mailbox_addresses(mailbox_id);

-- One conversation across all mailboxes, built from Message-ID / In-Reply-To / References.
CREATE TABLE IF NOT EXISTS mail_threads (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  subject text NOT NULL DEFAULT '',
  message_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per stored message in either direction. Bodies live here; attachments and raw MIME in S3.
CREATE TABLE IF NOT EXISTS mail_messages (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  direction text NOT NULL,
  thread_id text NOT NULL REFERENCES mail_threads(id),
  region text,
  domain_id text,
  ses_message_id text,
  sending_email_id text,
  message_id text,
  in_reply_to text,
  "references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NOT NULL DEFAULT '',
  from_address text NOT NULL DEFAULT '',
  from_name text,
  "to" jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc jsonb NOT NULL DEFAULT '[]'::jsonb,
  reply_to jsonb NOT NULL DEFAULT '[]'::jsonb,
  envelope_from text,
  envelope_to jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  text text,
  html text,
  body_truncated boolean NOT NULL DEFAULT false,
  snippet text NOT NULL DEFAULT '',
  headers jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachment_count integer NOT NULL DEFAULT 0,
  size_bytes integer,
  raw_bucket text,
  raw_key text,
  verdicts jsonb NOT NULL DEFAULT '{}'::jsonb,
  spam boolean NOT NULL DEFAULT false,
  automated boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'received',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(from_name, '') || ' ' || coalesce(from_address, '') || ' ' || left(coalesce(text, ''), 200000))
  ) STORED,
  CONSTRAINT mail_messages_direction CHECK (direction IN ('inbound', 'outbound'))
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_ses ON mail_messages(workspace_id, environment, ses_message_id) WHERE ses_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_sending ON mail_messages(workspace_id, environment, sending_email_id) WHERE sending_email_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS mail_messages_search ON mail_messages USING gin(search);

-- Message-ID lookup for threading, including SES-assigned IDs of outbound mail.
CREATE TABLE IF NOT EXISTS mail_message_ids (
  workspace_id text NOT NULL,
  environment text NOT NULL,
  message_id text NOT NULL,
  mail_message_id text NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  PRIMARY KEY (workspace_id, environment, message_id)
);

-- Envelope/header recipients at receiving domains that matched no mailbox (catch-all "store").
CREATE TABLE IF NOT EXISTS mail_unrouted (
  workspace_id text NOT NULL,
  environment text NOT NULL,
  message_id text NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, environment, address, message_id)
);

-- A mailbox's view of a message: membership plus read state.
CREATE TABLE IF NOT EXISTS mailbox_messages (
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  thread_id text NOT NULL,
  direction text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (mailbox_id, message_id)
);
CREATE INDEX IF NOT EXISTS mailbox_messages_page ON mailbox_messages(mailbox_id, received_at DESC, message_id DESC);
CREATE INDEX IF NOT EXISTS mailbox_messages_thread ON mailbox_messages(mailbox_id, thread_id);

-- A mailbox's view of a thread: summary plus archive/star/trash/label state.
CREATE TABLE IF NOT EXISTS mailbox_threads (
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id text NOT NULL REFERENCES mail_threads(id),
  workspace_id text NOT NULL,
  environment text NOT NULL,
  subject text NOT NULL DEFAULT '',
  snippet text NOT NULL DEFAULT '',
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_count integer NOT NULL DEFAULT 0,
  unread_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz NOT NULL,
  last_inbound_at timestamptz,
  archived boolean NOT NULL DEFAULT false,
  starred boolean NOT NULL DEFAULT false,
  spam boolean NOT NULL DEFAULT false,
  trashed_at timestamptz,
  labels text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, thread_id)
);
CREATE INDEX IF NOT EXISTS mailbox_threads_page ON mailbox_threads(mailbox_id, last_message_at DESC, thread_id DESC);
CREATE INDEX IF NOT EXISTS mailbox_threads_labels ON mailbox_threads USING gin(labels);

CREATE TABLE IF NOT EXISTS mail_attachments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  message_id text NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  content_id text,
  disposition text NOT NULL,
  sha256 text NOT NULL,
  bucket text NOT NULL,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_attachments_message ON mail_attachments(message_id);

-- Verified SES receipt notifications; the durable hand-off from SNS to the ingest job.
CREATE TABLE IF NOT EXISTS mail_receipts (
  workspace_id text NOT NULL,
  ses_message_id text NOT NULL,
  environment text NOT NULL,
  region text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  recipients jsonb NOT NULL,
  notification jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (workspace_id, ses_message_id)
);
CREATE INDEX IF NOT EXISTS mail_receipts_status ON mail_receipts(workspace_id, status, created_at);

-- Keys for agents, scoped to specific mailboxes (null mailbox_ids = every mailbox).
CREATE TABLE IF NOT EXISTS mailbox_keys (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  name text NOT NULL,
  hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  mailbox_ids jsonb,
  permissions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS mailbox_keys_page ON mailbox_keys(workspace_id, id);

-- Ordered event log. Writers serialize on an advisory lock so seq order equals commit order,
-- which makes "after=<seq>" long-poll and webhook cursors gap-free.
CREATE TABLE IF NOT EXISTS mailbox_events (
  seq bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  type text NOT NULL,
  mailbox_id text,
  thread_id text,
  message_id text,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mailbox_events_mailbox ON mailbox_events(workspace_id, environment, mailbox_id, seq);
CREATE INDEX IF NOT EXISTS mailbox_events_created ON mailbox_events(created_at);

CREATE TABLE IF NOT EXISTS mailbox_webhooks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  url text NOT NULL,
  description text NOT NULL DEFAULT '',
  event_types jsonb NOT NULL,
  mailbox_ids jsonb,
  paused boolean NOT NULL DEFAULT false,
  encrypted_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mailbox_webhooks_page ON mailbox_webhooks(workspace_id, environment, id);

CREATE TABLE IF NOT EXISTS mailbox_webhook_deliveries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL,
  webhook_id text NOT NULL REFERENCES mailbox_webhooks(id) ON DELETE CASCADE,
  event_seq bigint NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  last_status_code integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_webhook_deliveries_event ON mailbox_webhook_deliveries(webhook_id, event_seq);
CREATE INDEX IF NOT EXISTS mailbox_webhook_deliveries_page ON mailbox_webhook_deliveries(webhook_id, id);
