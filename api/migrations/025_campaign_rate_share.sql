-- Paced campaigns may use only a share of the SES per-second send rate, leaving the rest for transactional
-- mail and other campaigns. NULL means the full rate (campaigns sent without pacing).
ALTER TABLE sending_campaign_expansions ADD COLUMN IF NOT EXISTS rate_share double precision
  CHECK (rate_share IS NULL OR (rate_share >= 0.05 AND rate_share <= 1));
