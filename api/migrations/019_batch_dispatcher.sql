-- Long-lived batch dispatcher: queued mail is claimed directly from sending_emails
-- instead of one email.dispatch job row per recipient.
ALTER TABLE sending_emails ADD COLUMN IF NOT EXISTS lease_until timestamptz;
-- Due-mail claim order: transactional (no campaign) before campaign mail, then oldest first.
CREATE INDEX IF NOT EXISTS sending_emails_dispatch_due ON sending_emails(workspace_id, environment, region, (campaign_id IS NULL), created_at, id) WHERE status = 'queued';
-- Interrupted provider attempts are recovered by attempt age.
CREATE INDEX IF NOT EXISTS sending_emails_attempting ON sending_emails(workspace_id, environment, attempt_started_at) WHERE status = 'attempting';
