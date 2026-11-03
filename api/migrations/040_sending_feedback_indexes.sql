-- Callbacks know the region and provider ID before they know the workspace.
CREATE INDEX IF NOT EXISTS sending_emails_feedback_provider ON sending_emails (environment, region, provider_id) WHERE provider_id IS NOT NULL;

-- The hourly bounded deletes run once per table across all workspaces.
CREATE INDEX IF NOT EXISTS sending_emails_retire ON sending_emails (created_at) WHERE status NOT IN ('queued','attempting');
CREATE INDEX IF NOT EXISTS sending_email_events_retire ON sending_email_events (created_at);
CREATE INDEX IF NOT EXISTS operation_events_retire ON operation_events (created_at);
CREATE INDEX IF NOT EXISTS operation_deliveries_retire ON operation_deliveries (created_at) WHERE status NOT IN ('pending','paused');
CREATE INDEX IF NOT EXISTS operation_delivery_attempts_retire ON operation_delivery_attempts (created_at);
CREATE INDEX IF NOT EXISTS operation_sns_receipts_retire ON operation_sns_receipts (created_at);
CREATE INDEX IF NOT EXISTS jobs_retire ON jobs (created_at) WHERE status IN ('completed','failed');
