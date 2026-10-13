-- Metrics and email lists filter by stream with snapshot->>'kind'. The snapshot holds the full message and is
-- stored out of line (TOAST), so that filter detoasted every email in the window: a 30-day marketing count read
-- ~774k buffers (691 ms) instead of ~8.5k (48 ms), and each stream-filtered /v1/metrics call took ~6 s.
-- This index answers the stream filter without reading snapshots. On a large live table create it first with
-- CREATE INDEX CONCURRENTLY (same name and definition) so this transactional migration is a no-op.
CREATE INDEX IF NOT EXISTS sending_emails_kind_created ON sending_emails (workspace_id, environment, (snapshot->>'kind'), created_at);
