-- Mailbox sending, reply safety limits, and per-message labels.

-- Per-message labels (tags) in a mailbox's view, alongside the existing thread labels.
ALTER TABLE mailbox_messages ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS mailbox_messages_labels ON mailbox_messages USING gin(labels);

-- Outbound limits per mailbox; null values fall back to the service defaults.
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS send_limits jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Outbound messages: which mailbox sent them and why delivery failed.
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS sender_mailbox_id text;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS error_code text;
CREATE INDEX IF NOT EXISTS mail_messages_sender_recent ON mail_messages(sender_mailbox_id, created_at) WHERE direction = 'outbound';
CREATE INDEX IF NOT EXISTS mail_messages_outbound_pending ON mail_messages(workspace_id, created_at)
  WHERE direction = 'outbound' AND status IN ('queued', 'attempting', 'accepted', 'sent', 'delayed', 'acceptance_unknown');
