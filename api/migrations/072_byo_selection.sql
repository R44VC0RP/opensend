SET LOCAL lock_timeout='1s';
-- The requested account is untrusted until STS proof. Only the existing, proven
-- aws_account_id participates in the unique account reservation.
ALTER TABLE provider_connections ADD COLUMN requested_account text CHECK(requested_account ~ '^[0-9]{12}$' AND requested_account <> '438095551154'),
  ADD COLUMN inventory_revision integer NOT NULL DEFAULT 0;
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_state_check,
  ADD CHECK (state IN ('awaiting_role','provisioning','ready','failed') OR (template_version IS NOT DISTINCT FROM 'v5' AND state IN ('scanning','ready_to_import'))) NOT VALID;
ALTER TABLE provider_connection_regions ADD COLUMN scan_facts jsonb NOT NULL DEFAULT '{}', ADD COLUMN scan_error text,
  ADD COLUMN provision_error text, ADD COLUMN ready_at timestamptz;
CREATE TABLE byo_candidates (
  connection_id text NOT NULL, region text NOT NULL, name text NOT NULL, revision integer NOT NULL, identity jsonb NOT NULL,
  PRIMARY KEY(connection_id,region,name), FOREIGN KEY(connection_id,region) REFERENCES provider_connection_regions ON DELETE CASCADE
);
-- An accepted selection is neither a claim nor a sending binding. A region may
-- publish it only after the signed feedback handshake and a fresh SES check.
CREATE TABLE byo_domain_intents (
  connection_id text NOT NULL, region text NOT NULL, name text NOT NULL, importing boolean NOT NULL, id text NOT NULL UNIQUE,
  PRIMARY KEY(connection_id,name), FOREIGN KEY(connection_id,region) REFERENCES provider_connection_regions ON DELETE CASCADE
);
CREATE TABLE byo_operation_receipts (
  connection_id text REFERENCES provider_connections ON DELETE CASCADE, operation text NOT NULL, key_hash text NOT NULL, request_hash text NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(connection_id,operation,key_hash)
);
