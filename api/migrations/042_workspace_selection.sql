-- A preference, never an authorization: selection always joins current membership.
ALTER TABLE auth_user ADD COLUMN selected_workspace_id text;
CREATE UNIQUE INDEX workspace_invitations_pending_idx ON workspace_invitations(workspace_id, email) WHERE status = 'pending';
