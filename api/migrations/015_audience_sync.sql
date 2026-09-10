CREATE TABLE audience_bulk_imports (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL, list_id text NOT NULL,
  name text NOT NULL, status text NOT NULL DEFAULT 'uploading', next_chunk integer NOT NULL DEFAULT 0,
  received integer NOT NULL DEFAULT 0, valid integer NOT NULL DEFAULT 0, errors integer NOT NULL DEFAULT 0, imported integer NOT NULL DEFAULT 0,
  cursor integer NOT NULL DEFAULT 0, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audience_bulk_scope ON audience_bulk_imports(workspace_id,environment,id);
CREATE TABLE audience_bulk_rows (
  import_id text NOT NULL REFERENCES audience_bulk_imports(id), row_number integer NOT NULL, email text, name text, properties jsonb,
  error text, PRIMARY KEY(import_id,row_number)
);
CREATE UNIQUE INDEX audience_bulk_email ON audience_bulk_rows(import_id,email) WHERE error IS NULL;
CREATE TABLE audience_bulk_chunks(import_id text NOT NULL REFERENCES audience_bulk_imports(id), chunk integer NOT NULL, checksum text NOT NULL, PRIMARY KEY(import_id,chunk));
CREATE TABLE crm_sync_state (
  workspace_id text NOT NULL, environment text NOT NULL, status text NOT NULL DEFAULT 'idle',
  checkpoint_at timestamptz NOT NULL DEFAULT '1970-01-01', checkpoint_id text NOT NULL DEFAULT '', cutoff_at timestamptz,
  scanned integer NOT NULL DEFAULT 0, imported integer NOT NULL DEFAULT 0, errors integer NOT NULL DEFAULT 0,
  error_code text, last_success_at timestamptz, next_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,environment)
);
CREATE TABLE crm_sync_errors (
  id bigserial PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL, source_id text, code text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_errors_page ON crm_sync_errors(workspace_id,environment,id);
CREATE TABLE crm_contact_links (
  workspace_id text NOT NULL, environment text NOT NULL, source_id text NOT NULL, contact_id text NOT NULL,
  PRIMARY KEY(workspace_id,environment,source_id)
);
