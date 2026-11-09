SET LOCAL lock_timeout='1s';
-- Legacy suppressions have no independent timestamp; ingest uses updated_at as a conservative upper bound.
ALTER TABLE audience_contacts ADD COLUMN suppressed_at timestamptz;
ALTER TABLE sending_emails ADD COLUMN suppression_reason text;
ALTER TABLE mail_messages ADD COLUMN suppression_reason text;
