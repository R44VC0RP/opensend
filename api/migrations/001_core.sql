CREATE TABLE IF NOT EXISTS api_keys (
 id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')),
 name text NOT NULL, hash text NOT NULL UNIQUE, prefix text NOT NULL,
 permissions jsonb NOT NULL, domains jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS jobs (
 id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')),
 type text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, available_at);
