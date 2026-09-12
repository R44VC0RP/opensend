ALTER TABLE job_schedule ADD COLUMN IF NOT EXISTS wake_not_before timestamptz;
