-- Paced campaign delivery: an optional per-24-hour cap, pause/resume, automatic pause on high bounce or
-- complaint rates, and the reason expansion is currently waiting. All columns are nullable or have
-- constant defaults, so adding them does not rewrite sending_campaign_expansions.
ALTER TABLE sending_campaign_expansions
  ADD COLUMN IF NOT EXISTS pace_per_day integer,
  ADD COLUMN IF NOT EXISTS auto_pause boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS window_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS window_expanded integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS pause_reason jsonb,
  ADD COLUMN IF NOT EXISTS health_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS waiting_reason text,
  ADD COLUMN IF NOT EXISTS waiting_until timestamptz;
ALTER TABLE sending_campaign_expansions DROP CONSTRAINT IF EXISTS sending_campaign_expansions_status_check;
ALTER TABLE sending_campaign_expansions ADD CONSTRAINT sending_campaign_expansions_status_check
  CHECK (status IN ('pending','expanding','paused','completed','failed','canceled'));
