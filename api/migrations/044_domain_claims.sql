-- Hosted ownership is installation-wide. A connection change invalidates the regional
-- verification, but not the workspace's claim or its tag on a retained SES identity.
CREATE TABLE domain_claims (
  name text PRIMARY KEY CHECK (name = lower(name)),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id text REFERENCES provider_connections(id) ON DELETE SET NULL,
  verified boolean NOT NULL DEFAULT false,
  ready boolean NOT NULL DEFAULT false
);
CREATE INDEX domain_claims_connection ON domain_claims(connection_id);
