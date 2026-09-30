-- Former members of a deleted organization may recreate it; everyone else still can't take the name.
ALTER TABLE codemail.retired_slug ADD COLUMN IF NOT EXISTS former_member_emails text[] NOT NULL DEFAULT '{}';
ALTER TABLE codemail.retired_slug ADD COLUMN IF NOT EXISTS subdomain_id text;
