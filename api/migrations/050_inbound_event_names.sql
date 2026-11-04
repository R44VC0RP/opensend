-- Even events requested through the inbound API were stored with mailbox.* names.
-- Preserve their IDs, cursors and subscription scopes without a runtime alias.
UPDATE mailbox_events SET type = replace(type, 'mailbox.', 'address.')
WHERE type IN ('mailbox.created', 'mailbox.deleted');

UPDATE mailbox_webhooks SET event_types = (
  SELECT coalesce(jsonb_agg(replace(event, 'mailbox.', 'address.') ORDER BY n) FILTER (WHERE event <> 'message.updated'), '[]'::jsonb)
  FROM jsonb_array_elements_text(event_types) WITH ORDINALITY AS types(event, n)
) WHERE event_types ?| ARRAY['mailbox.created', 'mailbox.deleted', 'message.updated'];

-- Only pending snapshots will still be signed and delivered. Keep delivered history intact.
UPDATE mailbox_webhook_deliveries SET payload = (payload - 'mailboxId') || jsonb_build_object(
  'addressId', coalesce(payload->'addressId', payload->'mailboxId'),
  'type', replace(payload->>'type', 'mailbox.', 'address.')
) WHERE status = 'pending' AND payload ? 'mailboxId';
