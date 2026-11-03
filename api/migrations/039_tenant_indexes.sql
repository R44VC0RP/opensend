CREATE INDEX IF NOT EXISTS mail_messages_tenant_page ON mail_messages(workspace_id, environment, direction, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mailbox_messages_message_mailbox ON mailbox_messages(message_id, mailbox_id);
CREATE INDEX IF NOT EXISTS mailbox_messages_tenant_thread_page ON mailbox_messages(workspace_id, environment, thread_id, received_at DESC, message_id DESC);
CREATE INDEX IF NOT EXISTS mail_unrouted_message ON mail_unrouted(message_id);
