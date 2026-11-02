# OpenSend TypeScript SDK

TypeScript client for the self-hosted [OpenSend email API](https://github.com/R44VC0RP/opensend). Includes generated request and response types, with no runtime dependencies.

## Install

```sh
npm install opensend-js
```

This package uses ESM and the Fetch API. Use it on your server; never ship an OpenSend API key in a browser bundle.

## Send an email

Set `OPENSEND_API_KEY` to a key from your OpenSend installation. Replace the example base URL with your deployment's public URL.

```ts
import { createClient } from 'opensend-js/client';
import { sendEmail, getEmail } from 'opensend-js';

const client = createClient({
  baseUrl: 'https://mail.example.com',
  auth: scheme => scheme.scheme === 'bearer' ? process.env.OPENSEND_API_KEY : undefined,
});

const result = await sendEmail({
  client,
  headers: { 'Idempotency-Key': 'order-4821-receipt' },
  body: {
    region: 'us-east-1',
    from: 'receipts@example.com',
    to: ['recipient@example.com'],
    subject: 'Your receipt',
    text: 'Thank you for your order.',
  },
  throwOnError: true,
});

const message = await getEmail({
  client,
  path: { id: result.data.id },
  throwOnError: true,
});
```

The auth callback supplies the API key only to the bearer scheme; dashboard cookie authentication is not needed for SDK calls. Pass a client instance rather than mutating global client configuration in a multi-tenant server. Keep API keys out of browser bundles. This client submits requests; it does not turn `202 queued` into a delivery guarantee or automatically replay sends. Reuse a stable idempotency key for deliberate retries.

## A support inbox with tracked replies

1. Enable receiving on a verified domain, then create `support@example.com` using `POST /mailbox/v1/mailboxes` with `{"address":"support@example.com"}`. For a disposable mailbox, use a fresh address and add `ttlSeconds`, for example `3600`. Expiry stops new sends and routing; it is not a history purge. If the domain already receives mail elsewhere, **do not replace its MX just for one address**. Use a receiving subdomain and arrange forwarding for the support address instead.
2. Register `POST /mailbox/v1/webhooks` with `{"url":"https://example.com/support-hook","eventTypes":["message.received"],"mailboxIds":["mbx_…"]}`. The webhook host must be allowlisted. Verify the signature over the raw request body, check the timestamp, and deduplicate the event `id` before acting. The event contains `mailboxId`, `threadId` and `messageId` (`msg_…`). Fetch the full message with `GET /mailbox/v1/mailboxes/{mailboxId}/messages/{messageId}` if needed.
3. Reply with `POST /mailbox/v1/mailboxes/{mailboxId}/messages/{messageId}/reply`, an `Idempotency-Key` based on the event or operator action, and `{"text":"Happy to help."}`. A scoped mailbox key with `read` and `send` can read and answer only its configured mailboxes. OpenSend picks the recipient and sets the RFC threading headers; the next customer reply carries the same OpenSend `threadId` when their mail client preserves the chain.

To **start** a tracked conversation, send from the mailbox API, or add `replyMailboxId` to an explicit-body transactional `POST /v1/emails/send` with an unrestricted live manage credential. `from` and any `replyTo` must belong to that mailbox. The latter returns `{ id: "email_…", mailboxMessageId: "msg_…", threadId: "thr_…", status: "queued", ... }`. Store `threadId` with your ticket. The mailbox reply endpoint accepts either `msg_…` or its linked `email_…`; for an outbound parent, wait for provider acceptance (a premature follow-up returns `409 REPLY_TARGET_NOT_ACCEPTED`). Neither ID is a wire `Message-ID`. Ordinary transactional sends without `replyMailboxId` are not copied into anyone’s mailbox.

## Upload local and generated attachments

Use a short-lived `createAgentToken` token to upload a local file without putting its bytes in model context:

```sh
npx --yes opensend-js upload ./invite.ics \
  --api https://mail.example.com \
  --token 'os_agent_…' \
  --content-type 'text/calendar; method=REQUEST; charset=utf-8'
```

Add `--inline --content-id logo` for PNG, JPEG, GIF or WebP images referenced as `cid:logo`. Other supported files are regular attachments. The command prints attachment metadata as JSON and never prints the token.

Generated per-recipient content can use the same raw upload path without writing a temporary file:

```ts
import { uploadAttachmentBytes } from 'opensend-js/upload';

const attachment = await uploadAttachmentBytes({
  apiUrl: 'https://mail.example.com',
  token: temporaryAgentToken,
  filename: 'invite.ics',
  contentType: 'text/calendar; method=REQUEST; charset=utf-8',
  bytes: new TextEncoder().encode(calendarText),
});
```

The API verifies extension, MIME declaration and file signature/content, stores the object privately, and retains the 8 MiB attachment limit. Batch scripts can upload personalized files, reference each returned attachment ID, and submit emails in groups of 100.

The generated exports include contacts, lists, segments, campaigns, attachments, keys, webhooks, settings and message logs. Cursor responses use `nextCursor`. Error bodies include a stable `error.code` and `error.requestId`. Read-level responses redact app unsubscribe capabilities from content/events/delivery payloads and withhold raw MIME; management access is required for unredacted content. A key revoked before dispatch no longer authorizes its queued sends. Request/resource limits return explicit 429/413 errors; do not retry permanent configuration errors blindly.

Stored-template data follows SES rendering semantics: nested JSON is supported, but SES does not escape HTML substitutions. Escape untrusted data for its HTML context before submission. Test keys never invoke the real SES renderer.

Webhook payloads use Standard Webhooks-style headers: `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`). The signed string is `id.timestamp.rawBody`; decode the base64 bytes after `whsec_` before verifying HMAC-SHA256. Verify the raw request bytes, bound timestamp skew, and deduplicate event IDs. Signature verification is not generated by OpenAPI and is not a helper in this package.
