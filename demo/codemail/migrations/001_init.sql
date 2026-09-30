-- codemail (opcd.ai) accounts and organizations, in their own schema inside the OpenSend database.
CREATE SCHEMA IF NOT EXISTS codemail;

CREATE TABLE IF NOT EXISTS codemail."user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS codemail.session (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES codemail."user"(id) ON DELETE CASCADE,
  active_organization_id text,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_user_idx ON codemail.session(user_id);
CREATE TABLE IF NOT EXISTS codemail.account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES codemail."user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_user_idx ON codemail.account(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS account_provider_subject_idx ON codemail.account(provider_id, account_id);
CREATE TABLE IF NOT EXISTS codemail.verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON codemail.verification(identifier);

-- slug is the organization's mail subdomain: acme → acme.opcd.ai.
CREATE TABLE IF NOT EXISTS codemail.organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo text,
  metadata text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS codemail.member (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES codemail.organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES codemail."user"(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS member_org_user_idx ON codemail.member(organization_id, user_id);
CREATE INDEX IF NOT EXISTS member_user_idx ON codemail.member(user_id);
CREATE TABLE IF NOT EXISTS codemail.invitation (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES codemail.organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  inviter_id text NOT NULL REFERENCES codemail."user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS invitation_org_idx ON codemail.invitation(organization_id);
CREATE INDEX IF NOT EXISTS invitation_email_idx ON codemail.invitation(email);

-- Slugs of deleted organizations. Never handed out again, so no one inherits an old address.
CREATE TABLE IF NOT EXISTS codemail.retired_slug (
  slug text PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT now()
);
