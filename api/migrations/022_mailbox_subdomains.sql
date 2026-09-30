-- Receiving subdomains: acme.example.com under a verified, receiving example.com.
-- A subdomain is a mailbox_domains row with parent_id set. SES receives it through the parent's
-- wildcard recipient (.example.com) and a *.example.com MX record, so it needs no SES identity,
-- DNS change or verification of its own.

ALTER TABLE mailbox_domains ADD COLUMN IF NOT EXISTS parent_id text REFERENCES mailbox_domains(id);
-- On a parent: whether its receipt rule also matches every subdomain (.example.com).
ALTER TABLE mailbox_domains ADD COLUMN IF NOT EXISTS accept_subdomains boolean NOT NULL DEFAULT false;
ALTER TABLE mailbox_domains ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Subdomains share their parent's SES domain, so only top-level rows are unique per domain.
DROP INDEX IF EXISTS mailbox_domains_domain;
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_domains_domain ON mailbox_domains(workspace_id, environment, domain_id) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS mailbox_domains_parent ON mailbox_domains(parent_id, name) WHERE parent_id IS NOT NULL;
