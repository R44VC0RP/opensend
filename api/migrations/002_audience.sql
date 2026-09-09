CREATE TABLE IF NOT EXISTS audience_contacts (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')), email text NOT NULL, name text,
  properties jsonb NOT NULL DEFAULT '{}', marketing_consent text NOT NULL DEFAULT 'unknown' CHECK (marketing_consent IN ('unknown','subscribed','unsubscribed')),
  suppressed boolean NOT NULL DEFAULT false, suppression_reason text,
  last_open_at timestamptz, last_click_at timestamptz, observed_since timestamptz, open_observed_since timestamptz, click_observed_since timestamptz,
  deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS audience_contacts_email_scope ON audience_contacts(workspace_id,environment,email);
CREATE INDEX IF NOT EXISTS audience_contacts_page ON audience_contacts(workspace_id,environment,id);
CREATE TABLE IF NOT EXISTS audience_lists (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')), name text NOT NULL, description text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audience_lists_page ON audience_lists(workspace_id,environment,id);
CREATE TABLE IF NOT EXISTS audience_list_members (
  workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')), list_id text NOT NULL, contact_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,environment,list_id,contact_id)
);
CREATE INDEX IF NOT EXISTS audience_members_contact ON audience_list_members(workspace_id,environment,contact_id);
CREATE TABLE IF NOT EXISTS audience_segments (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')), name text NOT NULL, rule jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audience_segments_page ON audience_segments(workspace_id,environment,id);
CREATE TABLE IF NOT EXISTS audience_imports (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')), list_id text, status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','committed')), rows jsonb NOT NULL, errors jsonb NOT NULL, imported integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audience_imports_page ON audience_imports(workspace_id,environment,id);
CREATE TABLE IF NOT EXISTS audience_consent_audit (
  id text PRIMARY KEY, workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')), contact_id text NOT NULL, email text NOT NULL, status text NOT NULL CHECK(status IN ('subscribed','unsubscribed')), source text NOT NULL, policy_version text, evidence text, actor_key_id text, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audience_consent_page ON audience_consent_audit(workspace_id,environment,contact_id,id);
