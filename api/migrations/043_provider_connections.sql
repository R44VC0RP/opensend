CREATE TABLE provider_connections (
  id text PRIMARY KEY,
  workspace_id text NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('shared', 'byo')),
  region text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  aws_account_id text CHECK (aws_account_id ~ '^[0-9]{12}$'),
  role_arn text,
  external_id uuid UNIQUE,
  platform_principal_arn text,
  template_version text,
  feedback_topic_arn text UNIQUE,
  lease_until timestamptz,
  CHECK ((kind = 'shared' AND external_id IS NULL AND role_arn IS NULL AND template_version IS NULL AND platform_principal_arn IS NULL AND feedback_topic_arn IS NULL)
      OR (kind = 'byo' AND external_id IS NOT NULL AND template_version IS NOT NULL AND platform_principal_arn IS NOT NULL AND (status <> 'ready' OR role_arn IS NOT NULL))),
  CHECK (status <> 'ready' OR aws_account_id IS NOT NULL)
);
CREATE UNIQUE INDEX provider_connections_byo_account ON provider_connections(aws_account_id) WHERE kind = 'byo';

-- Shared infrastructure and the signed confirmation allowlist outlive individual workspaces.
CREATE TABLE provider_pool_regions (
  region text PRIMARY KEY,
  aws_account_id text NOT NULL,
  feedback_topic_arn text UNIQUE,
  ready boolean NOT NULL DEFAULT false,
  lease_until timestamptz
);
