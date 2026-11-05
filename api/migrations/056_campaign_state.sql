-- Expand only: one explicit campaign state, with the delivery cursors and settings as columns of the campaign,
-- next to the status, review and expansion columns it replaces. Everything is backfilled from the old columns
-- and kept in step in both directions by triggers until 057 drops them. The previous release (c8a5b45) keeps
-- running against this schema: its columns, their values and the sending_campaign_expansions table are untouched.

ALTER TABLE sending_campaigns
  ADD COLUMN state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','preparing','scheduled','sending','paused','done','failed','canceled')),
  ADD COLUMN actor_key_id text,
  ADD COLUMN simulated boolean NOT NULL DEFAULT false,
  ADD COLUMN request_id text,
  ADD COLUMN total integer NOT NULL DEFAULT 0 CHECK (total >= 0 AND total <= 2000000),
  ADD COLUMN prepared integer NOT NULL DEFAULT 0 CHECK (prepared >= 0),
  ADD COLUMN expanded integer NOT NULL DEFAULT 0 CHECK (expanded >= 0),
  ADD COLUMN canceled integer NOT NULL DEFAULT 0 CHECK (canceled >= 0),
  ADD COLUMN error jsonb,
  ADD COLUMN pace_per_day integer,
  ADD COLUMN auto_pause boolean NOT NULL DEFAULT true,
  ADD COLUMN rate_share double precision,
  ADD COLUMN window_started_at timestamptz,
  ADD COLUMN window_expanded integer NOT NULL DEFAULT 0,
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN pause_reason jsonb,
  ADD COLUMN health_checked_at timestamptz,
  ADD COLUMN waiting_reason text CHECK (waiting_reason IN ('pacing_window','ses_daily_quota')),
  ADD COLUMN waiting_until timestamptz;
-- The snapshot row no longer carries counts or a status of its own; this release inserts only what it keeps.
ALTER TABLE sending_campaign_reviews
  ALTER COLUMN recipients SET DEFAULT '[]'::jsonb, ALTER COLUMN matched SET DEFAULT 0, ALTER COLUMN eligible SET DEFAULT 0,
  ALTER COLUMN suppressed SET DEFAULT 0, ALTER COLUMN unsubscribed SET DEFAULT 0, ALTER COLUMN storage_version SET DEFAULT 2;

-- The one state the previous release's columns describe. A failed launch (expansion failed, campaign back in draft
-- or still sending) is `failed`; a review in progress is `preparing`; `reviewed` is a draft.
CREATE FUNCTION sending_campaign_state_from_legacy(c sending_campaigns, x sending_campaign_expansions) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN c.status = 'canceled' THEN 'canceled'
    WHEN c.status = 'completed' THEN 'done'
    WHEN x.status = 'failed' THEN 'failed'
    WHEN c.status IN ('scheduled','sending') THEN CASE
      WHEN x.status = 'paused' THEN 'paused' WHEN x.status = 'canceled' THEN 'canceled'
      WHEN c.preparing_review_id IS NOT NULL THEN 'preparing'
      WHEN c.status = 'scheduled' THEN 'scheduled' ELSE 'sending' END
    ELSE 'draft' END $$;
UPDATE sending_campaigns c SET state = sending_campaign_state_from_legacy(c, x),
  -- A failed preparation left the campaign's review_id NULL while its expansion still names the snapshot.
  review_id = coalesce(c.review_id, x.review_id),
  actor_key_id = x.actor_key_id, simulated = x.simulated, total = x.total, expanded = x.expanded, canceled = x.canceled, error = x.error, request_id = x.request_id,
  pace_per_day = x.pace_per_day, auto_pause = x.auto_pause, rate_share = x.rate_share, window_started_at = x.window_started_at, window_expanded = x.window_expanded,
  paused_at = x.paused_at, pause_reason = x.pause_reason, health_checked_at = x.health_checked_at, waiting_reason = x.waiting_reason, waiting_until = x.waiting_until,
  prepared = coalesce((SELECT CASE WHEN v.status = 'ready' THEN x.total ELSE least(v.processed, x.total) END FROM sending_campaign_reviews v WHERE v.id = x.review_id), 0)
FROM sending_campaign_expansions x WHERE x.campaign_id = c.id;
UPDATE sending_campaigns c SET state = sending_campaign_state_from_legacy(c, NULL::sending_campaign_expansions) WHERE NOT EXISTS (SELECT 1 FROM sending_campaign_expansions x WHERE x.campaign_id = c.id);

-- Campaign row: when this release moves `state`, project the old status columns; when the previous release writes
-- them, derive the state. Nested writes (from the expansion trigger below) carry explicit new columns and are left alone.
CREATE FUNCTION sending_campaigns_sync_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x sending_campaign_expansions;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.status := CASE NEW.state WHEN 'done' THEN 'completed' WHEN 'canceled' THEN 'canceled' WHEN 'draft' THEN 'draft' WHEN 'failed' THEN 'draft'
      WHEN 'scheduled' THEN 'scheduled'
      ELSE CASE WHEN NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at > now() THEN 'scheduled' ELSE 'sending' END END;
    NEW.preparing_review_id := CASE WHEN NEW.state = 'preparing' THEN NEW.review_id END;
  ELSIF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.preparing_review_id IS DISTINCT FROM OLD.preparing_review_id THEN
    SELECT * INTO x FROM sending_campaign_expansions WHERE campaign_id = NEW.id;
    NEW.state := sending_campaign_state_from_legacy(NEW, x);
    IF NEW.state = 'failed' THEN NEW.review_id := coalesce(NEW.review_id, x.review_id); END IF;
  ELSIF NEW.review_id IS NULL AND OLD.review_id IS NOT NULL AND NEW.state = 'failed' AND NEW.expanded = 0 THEN
    -- The previous release editing a failed launch that released nothing: a new revision starts over as a draft.
    NEW.state := 'draft'; NEW.total := 0; NEW.prepared := 0; NEW.canceled := 0; NEW.error := NULL; NEW.scheduled_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sending_campaigns_sync_state BEFORE INSERT OR UPDATE ON sending_campaigns FOR EACH ROW EXECUTE FUNCTION sending_campaigns_sync_state();
-- Campaign row -> expansion row, so the previous release's readers (and its legacy campaign finisher) see every launch.
-- A campaign reset to a draft (no snapshot) drops its expansion row, so the previous release's launch can insert again.
CREATE FUNCTION sending_campaigns_project_expansion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF NEW.review_id IS NULL THEN DELETE FROM sending_campaign_expansions WHERE campaign_id = NEW.id; RETURN NULL; END IF;
  IF NEW.total = 0 THEN RETURN NULL; END IF;
  INSERT INTO sending_campaign_expansions AS x (campaign_id, review_id, workspace_id, actor_key_id, simulated, total, expanded, canceled, status, error, request_id,
      pace_per_day, auto_pause, rate_share, window_started_at, window_expanded, paused_at, pause_reason, health_checked_at, waiting_reason, waiting_until, updated_at)
    VALUES (NEW.id, NEW.review_id, NEW.workspace_id, coalesce(NEW.actor_key_id, 'worker'), NEW.simulated, NEW.total, NEW.expanded, NEW.canceled,
      CASE NEW.state WHEN 'paused' THEN 'paused' WHEN 'failed' THEN 'failed' WHEN 'canceled' THEN 'canceled' WHEN 'done' THEN 'completed'
        WHEN 'sending' THEN CASE WHEN NEW.expanded >= NEW.total THEN 'completed' WHEN NEW.expanded > 0 THEN 'expanding' ELSE 'pending' END ELSE 'pending' END,
      NEW.error, NEW.request_id, NEW.pace_per_day, NEW.auto_pause, NEW.rate_share, NEW.window_started_at, NEW.window_expanded, NEW.paused_at, NEW.pause_reason,
      NEW.health_checked_at, NEW.waiting_reason, NEW.waiting_until, now())
  ON CONFLICT (campaign_id) DO UPDATE SET review_id = excluded.review_id, actor_key_id = excluded.actor_key_id, simulated = excluded.simulated, total = excluded.total,
    expanded = excluded.expanded, canceled = excluded.canceled, status = excluded.status, error = excluded.error, request_id = excluded.request_id,
    pace_per_day = excluded.pace_per_day, auto_pause = excluded.auto_pause, rate_share = excluded.rate_share, window_started_at = excluded.window_started_at,
    window_expanded = excluded.window_expanded, paused_at = excluded.paused_at, pause_reason = excluded.pause_reason, health_checked_at = excluded.health_checked_at,
    waiting_reason = excluded.waiting_reason, waiting_until = excluded.waiting_until, updated_at = now();
  RETURN NULL;
END $$;
CREATE TRIGGER sending_campaigns_project_expansion AFTER INSERT OR UPDATE ON sending_campaigns FOR EACH ROW EXECUTE FUNCTION sending_campaigns_project_expansion();
-- Expansion row (previous release) -> campaign row.
CREATE FUNCTION sending_campaign_expansions_sync_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  UPDATE sending_campaigns c SET state = sending_campaign_state_from_legacy(c, NEW),
    review_id = CASE WHEN sending_campaign_state_from_legacy(c, NEW) = 'failed' THEN coalesce(c.review_id, NEW.review_id) ELSE c.review_id END,
    actor_key_id = NEW.actor_key_id, simulated = NEW.simulated, total = NEW.total, expanded = NEW.expanded, canceled = NEW.canceled, error = NEW.error, request_id = NEW.request_id,
    pace_per_day = NEW.pace_per_day, auto_pause = NEW.auto_pause, rate_share = NEW.rate_share, window_started_at = NEW.window_started_at, window_expanded = NEW.window_expanded,
    paused_at = NEW.paused_at, pause_reason = NEW.pause_reason, health_checked_at = NEW.health_checked_at, waiting_reason = NEW.waiting_reason, waiting_until = NEW.waiting_until,
    prepared = coalesce((SELECT CASE WHEN v.status = 'ready' THEN NEW.total ELSE least(v.processed, NEW.total) END FROM sending_campaign_reviews v WHERE v.id = NEW.review_id), c.prepared)
  WHERE c.id = NEW.campaign_id;
  RETURN NULL;
END $$;
CREATE TRIGGER sending_campaign_expansions_sync_state AFTER INSERT OR UPDATE ON sending_campaign_expansions FOR EACH ROW EXECUTE FUNCTION sending_campaign_expansions_sync_state();
-- Review progress (previous release's prepare job) -> the campaign's prepared cursor.
CREATE FUNCTION sending_campaign_reviews_sync_prepared() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR (NEW.processed IS NOT DISTINCT FROM OLD.processed AND NEW.status IS NOT DISTINCT FROM OLD.status) THEN RETURN NULL; END IF;
  UPDATE sending_campaigns c SET prepared = CASE WHEN NEW.status = 'ready' THEN c.total ELSE least(NEW.processed, c.total) END WHERE c.review_id = NEW.id AND c.total > 0;
  RETURN NULL;
END $$;
CREATE TRIGGER sending_campaign_reviews_sync_prepared AFTER UPDATE ON sending_campaign_reviews FOR EACH ROW EXECUTE FUNCTION sending_campaign_reviews_sync_prepared();
