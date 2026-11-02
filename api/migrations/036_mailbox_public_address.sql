-- A public address reserves an outbound sender, not an inbound alias. The existing
-- address primary key prevents another mailbox from owning the same sender.
ALTER TABLE mailbox_addresses DROP CONSTRAINT mailbox_addresses_kind,
  ADD CONSTRAINT mailbox_addresses_kind CHECK (kind IN ('primary', 'alias', 'public'));
CREATE UNIQUE INDEX mailbox_addresses_one_public ON mailbox_addresses(mailbox_id) WHERE kind = 'public';
