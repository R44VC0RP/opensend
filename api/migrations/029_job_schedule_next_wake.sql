-- One reserved time for the next delayed queue wake, so concurrent queue invocations schedule a single follow-up
-- instead of one each (which multiplied wake chains and starved paced campaign releases). Nullable, no rewrite.
ALTER TABLE job_schedule ADD COLUMN IF NOT EXISTS next_wake_at timestamptz;
