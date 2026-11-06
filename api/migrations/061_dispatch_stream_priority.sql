-- The runner wraps migrations in a transaction. On large live queues build this exact index first
-- with CREATE INDEX CONCURRENTLY and drop the replaced index CONCURRENTLY, as in migration 032.
CREATE INDEX IF NOT EXISTS sending_emails_region_owner_stream_due ON sending_emails
  (region, workspace_id, ((snapshot->>'kind') = 'transactional') DESC, created_at, id) WHERE status = 'queued';
DROP INDEX IF EXISTS sending_emails_region_owner_due;
