SET LOCAL lock_timeout='1s';
-- 072 installed an unnamed multi-column check. Replace just that constraint,
-- not the independent role/account invariants on this table.
DO $$ DECLARE old_check name; BEGIN
  SELECT conname INTO STRICT old_check FROM pg_constraint WHERE conrelid='provider_connections'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%ready_to_import%';
  EXECUTE format('ALTER TABLE provider_connections DROP CONSTRAINT %I',old_check);
END $$;
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_state_check CHECK (
  state IN ('awaiting_role','provisioning','ready','failed') OR (template_version IS NOT DISTINCT FROM 'v5' AND state IN ('scanning','ready_to_import','disconnecting'))) NOT VALID,
  ADD COLUMN disconnect_error jsonb;
