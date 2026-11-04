-- Addresses that require DMARC hold mail without a DMARC pass for a person instead of
-- announcing it with message.received. Off by default, so existing addresses are unchanged.
ALTER TABLE mailboxes ADD COLUMN require_dmarc boolean NOT NULL DEFAULT false;
