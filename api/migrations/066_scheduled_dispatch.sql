-- Build CONCURRENTLY ahead of a large live upgrade. The old ordered queue index is
-- still usable by Workers from the previous release during the rollout.
CREATE INDEX IF NOT EXISTS sending_emails_immediate_due ON sending_emails
  (region,workspace_id,((snapshot->>'kind')='transactional') DESC,created_at,id) WHERE status='queued' AND scheduled_at IS NULL;
CREATE INDEX IF NOT EXISTS sending_emails_scheduled_due ON sending_emails
  (region,workspace_id,scheduled_at) WHERE status='queued' AND scheduled_at IS NOT NULL;
