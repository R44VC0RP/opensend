CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo text,
  metadata text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspace_members_workspace_user_idx ON workspace_members(workspace_id, user_id);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE workspace_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  inviter_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_invitations_workspace_idx ON workspace_invitations(workspace_id);
CREATE INDEX workspace_invitations_email_idx ON workspace_invitations(email);

INSERT INTO workspaces (id, name, slug) VALUES ('default', 'Default', 'default')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_members (id, workspace_id, user_id, role)
SELECT gen_random_uuid()::text, 'default', id, 'owner' FROM auth_user
ON CONFLICT (workspace_id, user_id) DO NOTHING;
