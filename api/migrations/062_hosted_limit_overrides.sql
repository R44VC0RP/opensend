-- A workspace may disconnect or switch to BYO. Operator policy survives, but is
-- only consulted while the workspace has a Hosted connection.
ALTER TABLE workspaces
  ADD COLUMN send_cap_override integer CHECK (send_cap_override BETWEEN 1 AND 10000000),
  ADD COLUMN pending_cap_override integer CHECK (pending_cap_override BETWEEN 1 AND 4000000);
