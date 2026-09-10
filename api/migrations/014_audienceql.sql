CREATE TABLE IF NOT EXISTS audience_operation_plans (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('live', 'test')),
  actor_key_id text NOT NULL,
  statement text NOT NULL,
  operation jsonb NOT NULL,
  matched integer NOT NULL,
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audience_plans_scope ON audience_operation_plans(workspace_id, environment, id);
CREATE INDEX IF NOT EXISTS audience_plans_expiry ON audience_operation_plans(expires_at);
