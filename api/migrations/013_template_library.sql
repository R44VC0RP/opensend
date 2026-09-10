CREATE TABLE template_library (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL,
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('marketing','automation')),
  revision integer NOT NULL DEFAULT 0, published_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX template_library_page ON template_library(workspace_id, environment, id);
CREATE TABLE template_versions (
  id text PRIMARY KEY, template_id text NOT NULL REFERENCES template_library(id),
  workspace_id text NOT NULL, environment text NOT NULL, revision integer NOT NULL,
  artifact_key text NOT NULL, checksum text NOT NULL, subject text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','publishing','published','failed')),
  region text, ses_name text, legacy_ses_name text, error_code text,
  validation jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  UNIQUE(template_id, revision)
);
CREATE INDEX template_versions_page ON template_versions(workspace_id, environment, template_id, revision);
CREATE TABLE template_sessions (
  template_id text PRIMARY KEY REFERENCES template_library(id), workspace_id text NOT NULL, environment text NOT NULL,
  session_id text NOT NULL, token_hash text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE template_author_inputs (
  id text PRIMARY KEY, template_id text NOT NULL REFERENCES template_library(id),
  prompt text NOT NULL, checksum text NOT NULL, status text NOT NULL DEFAULT 'pending', error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE template_assets(id text PRIMARY KEY,template_id text NOT NULL REFERENCES template_library(id),storage_key text NOT NULL,content_type text NOT NULL,size integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE template_publication_locks (id text PRIMARY KEY);
