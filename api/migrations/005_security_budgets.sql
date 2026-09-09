CREATE TABLE IF NOT EXISTS api_request_budgets (
  workspace_id text NOT NULL,
  key_id text NOT NULL,
  window_start timestamptz NOT NULL,
  used integer NOT NULL,
  PRIMARY KEY (workspace_id, key_id)
);
CREATE INDEX IF NOT EXISTS api_request_budgets_expiry ON api_request_budgets(window_start);
CREATE TABLE IF NOT EXISTS job_schedule (
  workspace_id text PRIMARY KEY,
  turn integer NOT NULL DEFAULT 0 CHECK (turn BETWEEN 0 AND 3)
);
CREATE INDEX IF NOT EXISTS jobs_workspace_due_idx ON jobs(workspace_id, environment, status, available_at);
