-- NULL means no custom headers, including for endpoints created before this migration.
ALTER TABLE operation_webhooks ADD COLUMN encrypted_headers text;
ALTER TABLE mailbox_webhooks ADD COLUMN encrypted_headers text;
