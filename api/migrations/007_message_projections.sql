-- Message/editor additions live in existing immutable snapshot and draft JSON.
-- Stable newest-first public collection reads use creation time plus ID.
CREATE INDEX sending_emails_created_page
  ON sending_emails (workspace_id, environment, created_at DESC, id DESC);
CREATE INDEX sending_campaigns_created_page
  ON sending_campaigns (workspace_id, environment, created_at DESC, id DESC);
