-- Sent campaign emails no longer store their rendered body; it is rebuilt from the frozen review on read.
-- The renderer version says which per-recipient renderer reproduces a review. Constant default: no rewrite.
ALTER TABLE sending_campaign_reviews ADD COLUMN IF NOT EXISTS renderer_version integer NOT NULL DEFAULT 1;
