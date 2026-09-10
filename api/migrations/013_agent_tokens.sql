CREATE TABLE IF NOT EXISTS agent_tokens (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  grant_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('live', 'test')),
  permissions jsonb NOT NULL,
  domains jsonb NOT NULL,
  purpose text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_tokens_workspace_page ON agent_tokens(workspace_id, id);
CREATE INDEX IF NOT EXISTS agent_tokens_grant ON agent_tokens(workspace_id, grant_id);
CREATE INDEX IF NOT EXISTS agent_tokens_expiry ON agent_tokens(expires_at);
