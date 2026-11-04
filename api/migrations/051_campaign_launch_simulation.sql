-- Existing live expansions were launched against real SES. Old test expansions never dispatch.
ALTER TABLE sending_campaign_expansions ADD COLUMN simulated boolean NOT NULL DEFAULT false;
UPDATE sending_campaign_expansions SET simulated = true WHERE environment = 'test';
