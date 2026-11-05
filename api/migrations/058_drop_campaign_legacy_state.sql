-- Contract only after the release containing 056 is serving all Worker/runner traffic.
-- Rolling back to c8a5b45 after this migration is not supported.
DROP TRIGGER sending_campaigns_sync_state ON sending_campaigns;
DROP TRIGGER sending_campaigns_project_expansion ON sending_campaigns;
DROP TRIGGER sending_campaign_expansions_sync_state ON sending_campaign_expansions;
DROP TRIGGER sending_campaign_reviews_sync_prepared ON sending_campaign_reviews;
DROP FUNCTION sending_campaigns_sync_state();
DROP FUNCTION sending_campaigns_project_expansion();
DROP FUNCTION sending_campaign_expansions_sync_state();
DROP FUNCTION sending_campaign_reviews_sync_prepared();
DROP FUNCTION sending_campaign_state_from_legacy(sending_campaigns, sending_campaign_expansions);
DROP TABLE sending_campaign_expansions;

-- The snapshot keeps only what reproduces a sent message: the frozen draft, rendered base, content hash and renderer version.
ALTER TABLE sending_campaign_reviews
  DROP COLUMN recipients, DROP COLUMN matched, DROP COLUMN eligible, DROP COLUMN suppressed, DROP COLUMN unsubscribed,
  DROP COLUMN storage_version, DROP COLUMN status, DROP COLUMN actor_key_id, DROP COLUMN processed,
  DROP COLUMN recipient_bytes, DROP COLUMN prepared_bytes, DROP COLUMN error;

-- Legacy rows: a reviewed draft had a snapshot pointer without a launch; a draft could be canceled; the previous
-- release's prepare job could leave a ready snapshot on a campaign still marked preparing; pause/cursor bookkeeping
-- followed looser rules. Every cursor is clamped so the checks below hold for every row the old release could write.
UPDATE sending_campaigns SET review_id = NULL, total = 0, prepared = 0, expanded = 0, canceled = 0 WHERE state = 'draft';
UPDATE sending_campaigns SET paused_at = NULL WHERE state <> 'paused' AND paused_at IS NOT NULL;
UPDATE sending_campaigns SET paused_at = coalesce(paused_at, updated_at) WHERE state = 'paused';
UPDATE sending_campaigns SET expanded = least(expanded, total), canceled = least(canceled, total);
UPDATE sending_campaigns SET prepared = least(total, greatest(prepared, expanded));
UPDATE sending_campaigns SET state = CASE WHEN scheduled_at > now() THEN 'scheduled' ELSE 'sending' END WHERE state = 'preparing' AND prepared >= total;
UPDATE sending_campaigns SET prepared = total, expanded = total WHERE state = 'done';
ALTER TABLE sending_campaigns DROP COLUMN status, DROP COLUMN preparing_review_id,
  -- Drafts have no snapshot; a draft could be canceled, and campaigns completed before snapshots existed are done without one.
  ADD CONSTRAINT sending_campaigns_snapshot CHECK (state IN ('draft', 'canceled', 'done') OR review_id IS NOT NULL),
  ADD CONSTRAINT sending_campaigns_cursors CHECK (expanded <= prepared AND prepared <= total AND canceled <= total),
  ADD CONSTRAINT sending_campaigns_paused CHECK ((paused_at IS NOT NULL) = (state = 'paused')),
  ADD CONSTRAINT sending_campaigns_preparing CHECK (state <> 'preparing' OR prepared < total),
  ADD CONSTRAINT sending_campaigns_done CHECK (state <> 'done' OR expanded = total);
CREATE INDEX sending_campaigns_active ON sending_campaigns (workspace_id) WHERE state IN ('preparing','scheduled','sending','paused');
