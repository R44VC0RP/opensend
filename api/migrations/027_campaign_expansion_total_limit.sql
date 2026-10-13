-- Campaign reviews and outstanding intents were raised to 2,000,000 recipients (paced delivery), but the
-- expansion row kept migration 017's total <= 1,000,000 check, so launching a 1.9M-recipient campaign failed
-- on the expansion insert after its audience snapshot and rolled back. Match the application limit.
ALTER TABLE sending_campaign_expansions DROP CONSTRAINT IF EXISTS sending_campaign_expansions_total_check;
ALTER TABLE sending_campaign_expansions ADD CONSTRAINT sending_campaign_expansions_total_check CHECK (total > 0 AND total <= 2000000);
