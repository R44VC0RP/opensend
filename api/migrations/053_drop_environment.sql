-- Contract only after the release containing 052 is serving all Worker/runner traffic.
-- Rolling back to 2f350fa after this migration is not supported.
DROP VIEW provider_test_connections;
DROP VIEW provider_workspace_limits;
CREATE VIEW provider_workspace_limits AS
SELECT c.workspace_id, l.aws_account_id, l.region, l.refresh_after, l.checked_at,
       CASE WHEN c.kind = 'shared' THEN l.max_send_rate / 4 ELSE l.max_send_rate END AS max_send_rate,
       l.max_24_hour_send, l.sent_last_24_hours
FROM provider_connections c JOIN provider_account_limits l USING (aws_account_id, region)
WHERE c.status = 'ready';

ALTER TABLE mail_attachments DROP COLUMN environment;
ALTER TABLE mail_message_ids DROP COLUMN environment;
ALTER TABLE mail_unrouted DROP COLUMN environment;
ALTER TABLE mailbox_messages DROP COLUMN environment;
ALTER TABLE mailbox_threads DROP COLUMN environment;
ALTER TABLE mailbox_addresses DROP COLUMN environment;
ALTER TABLE mailbox_webhook_deliveries DROP COLUMN environment;
ALTER TABLE mail_messages DROP COLUMN environment;
ALTER TABLE mailboxes DROP COLUMN environment;
ALTER TABLE mail_threads DROP COLUMN environment;
ALTER TABLE mailbox_domains DROP COLUMN environment;
ALTER TABLE mailbox_webhooks DROP COLUMN environment;
ALTER TABLE sending_attachment_links DROP COLUMN environment;
ALTER TABLE sending_campaign_expansions DROP COLUMN environment;
ALTER TABLE sending_campaign_reviews DROP COLUMN environment;
ALTER TABLE sending_email_events DROP COLUMN environment;
ALTER TABLE operation_delivery_attempts DROP COLUMN environment;
ALTER TABLE operation_deliveries DROP COLUMN environment;
ALTER TABLE audience_list_members DROP COLUMN environment;
ALTER TABLE audience_consent_audit DROP COLUMN environment;
ALTER TABLE agent_tokens DROP COLUMN environment;
ALTER TABLE api_keys DROP COLUMN environment;
ALTER TABLE audience_contacts DROP COLUMN environment;
ALTER TABLE audience_imports DROP COLUMN environment;
ALTER TABLE audience_lists DROP COLUMN environment;
ALTER TABLE audience_operation_plans DROP COLUMN environment;
ALTER TABLE audience_segments DROP COLUMN environment;
ALTER TABLE jobs DROP COLUMN environment;
ALTER TABLE mail_receipts DROP COLUMN environment;
ALTER TABLE mailbox_events DROP COLUMN environment;
ALTER TABLE mailbox_keys DROP COLUMN environment;
ALTER TABLE operation_domains DROP COLUMN environment;
ALTER TABLE operation_events DROP COLUMN environment;
ALTER TABLE operation_settings DROP COLUMN environment;
ALTER TABLE operation_sns_receipts DROP COLUMN environment;
ALTER TABLE operation_unsubscribe_tokens DROP COLUMN environment;
ALTER TABLE operation_webhooks DROP COLUMN environment;
ALTER TABLE provider_account_limits DROP COLUMN environment;
ALTER TABLE sending_attachments DROP COLUMN environment;
ALTER TABLE sending_campaigns DROP COLUMN environment;
ALTER TABLE sending_emails DROP COLUMN environment;
ALTER TABLE sending_idempotency DROP COLUMN environment;
ALTER TABLE sending_region_limits DROP COLUMN environment;

-- Dropping the column removed its dependent keys. Restore the same names atomically.
ALTER TABLE audience_contacts ADD CONSTRAINT audience_contacts_email_scope UNIQUE (workspace_id, email);
ALTER TABLE audience_list_members ADD CONSTRAINT audience_list_members_pkey PRIMARY KEY (workspace_id, list_id, contact_id);
ALTER TABLE mail_message_ids ADD CONSTRAINT mail_message_ids_pkey PRIMARY KEY (workspace_id, message_id);
CREATE UNIQUE INDEX mail_messages_sending ON mail_messages (workspace_id, sending_email_id) WHERE (sending_email_id IS NOT NULL);
CREATE UNIQUE INDEX mail_messages_ses ON mail_messages (workspace_id, ses_message_id) WHERE (ses_message_id IS NOT NULL);
ALTER TABLE mail_unrouted ADD CONSTRAINT mail_unrouted_pkey PRIMARY KEY (workspace_id, address, message_id);
ALTER TABLE mailbox_addresses ADD CONSTRAINT mailbox_addresses_pkey PRIMARY KEY (workspace_id, address);
CREATE UNIQUE INDEX mailbox_domains_domain ON mailbox_domains (workspace_id, domain_id) WHERE (parent_id IS NULL);
ALTER TABLE mailbox_domains ADD CONSTRAINT mailbox_domains_name UNIQUE (workspace_id, name);
CREATE UNIQUE INDEX mailbox_domains_receiving_host ON mailbox_domains (workspace_id, receiving_host) WHERE ((receiving_host IS NOT NULL) AND (status IN ('active', 'provisioning')));
CREATE UNIQUE INDEX operation_delivery_event ON operation_deliveries (workspace_id, webhook_id, event_id);
ALTER TABLE operation_domains ADD CONSTRAINT operation_domain_scope UNIQUE (workspace_id, name, region);
ALTER TABLE operation_events ADD CONSTRAINT operation_events_pkey PRIMARY KEY (workspace_id, id);
ALTER TABLE operation_settings ADD CONSTRAINT operation_settings_pkey PRIMARY KEY (workspace_id);
ALTER TABLE provider_account_limits ADD CONSTRAINT provider_account_limits_pkey PRIMARY KEY (aws_account_id, region);
ALTER TABLE sending_attachment_links ADD CONSTRAINT sending_attachment_links_pkey PRIMARY KEY (workspace_id, attachment_id, owner_type, owner_id);
CREATE UNIQUE INDEX sending_events_external ON sending_email_events (workspace_id, external_id);
CREATE UNIQUE INDEX sending_emails_provider ON sending_emails (workspace_id, region, provider_id);
ALTER TABLE sending_idempotency ADD CONSTRAINT sending_idempotency_pkey PRIMARY KEY (workspace_id, actor_key_id, path, request_key);
ALTER TABLE sending_region_limits ADD CONSTRAINT sending_region_limits_pkey PRIMARY KEY (workspace_id, region);
