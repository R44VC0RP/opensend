ALTER TABLE sending_campaigns ADD COLUMN archived_at timestamptz;

CREATE INDEX sending_campaigns_archive_page
  ON sending_campaigns (workspace_id, environment, archived_at, created_at DESC, id DESC);
