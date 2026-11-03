-- Seek each regional owner, then read that owner's oldest direct mail before campaign mail.
CREATE INDEX IF NOT EXISTS sending_emails_region_owner_due ON sending_emails
  (environment, region, workspace_id, (campaign_id IS NULL) DESC, created_at, id) WHERE status = 'queued';
