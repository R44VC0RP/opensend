-- Campaign lists count each listed campaign's emails by status. The (workspace, environment, campaign) index
-- had to read every email row for its status: 235 ms for the newsletter at 163k emails, growing to seconds at
-- 1.9M. With status in the key the counts are answered from the index (index-only on all-visible pages). It
-- also serves every lookup the old index did, which is dropped. On a large live table create it first with
-- CREATE INDEX CONCURRENTLY (same name and definition) and drop the old one CONCURRENTLY, so this transactional
-- migration is a no-op.
CREATE INDEX IF NOT EXISTS sending_emails_campaign_status ON sending_emails (workspace_id, environment, campaign_id, status);
DROP INDEX IF EXISTS sending_emails_campaign;
