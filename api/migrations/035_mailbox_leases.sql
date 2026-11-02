-- Expiry stops new delivery and sending, not ownership of the address or access to history.
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS expires_at timestamptz;
