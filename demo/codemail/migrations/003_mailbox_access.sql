-- Who may read each mailbox (OpenSend mailbox IDs). Personal mailboxes have one owner row; shared
-- mailboxes have managers (who can add people) and members. No row means no access.
CREATE TABLE IF NOT EXISTS codemail.mailbox_access (
  mailbox_id text NOT NULL,
  organization_id text NOT NULL REFERENCES codemail.organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES codemail."user"(id) ON DELETE CASCADE,
  role text NOT NULL,
  added_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, user_id),
  CONSTRAINT mailbox_access_role CHECK (role IN ('owner', 'manager', 'member'))
);
CREATE INDEX IF NOT EXISTS mailbox_access_user ON codemail.mailbox_access(user_id, organization_id);
CREATE INDEX IF NOT EXISTS mailbox_access_org ON codemail.mailbox_access(organization_id, mailbox_id);
