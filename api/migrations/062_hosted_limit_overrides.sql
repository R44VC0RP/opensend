ALTER TABLE provider_connections
  ADD COLUMN send_cap_override integer CHECK (send_cap_override BETWEEN 1 AND 10000000),
  ADD COLUMN pending_cap_override integer CHECK (pending_cap_override BETWEEN 1 AND 4000000),
  ADD CHECK (kind = 'shared' OR (send_cap_override IS NULL AND pending_cap_override IS NULL));
