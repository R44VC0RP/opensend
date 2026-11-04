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

An **address** routes mail and authorizes a sender. A **message** is one email; a **thread** is the conversation you read and reply to. Unrelated emails to the same address start separate threads. Adding an address to a later message does not reveal earlier messages to its key.

1. Enable receiving on a verified domain (`POST /v1/inbound/domains/{id}/enable`), publish the returned MX, then `POST /v1/inbound/addresses` with `{"address":"support@example.com"}`. Enable with `{"catchAll":"create_address"}` to create an address automatically when mail arrives for a new one; `store` keeps it as unrouted. If another provider already receives your root domain, see [Forward a public address](#forward-a-public-address-into-opensend).
2. Subscribe with `POST /v1/inbound/webhooks`, for example `{"url":"https://example.com/support-hook","eventTypes":["message.received"],"addressIds":["mbx_…"]}`. Allowlist the exact HTTPS host, verify the raw-body signature and timestamp, and deduplicate the event `id`. Store `threadId` with the ticket; `messageId` identifies the individual message. Issue a scoped `read`/`send` key with `POST /v1/inbound/keys` and the relevant `addressIds`.
3. Read `GET /v1/inbound/threads/{threadId}` and reply with `POST /v1/inbound/threads/{threadId}/reply`, `{"text":"Happy to help."}` and a stable `Idempotency-Key`. By default this answers the newest **visible** message; after your own send it follows up with the original recipients. Use `replyToMessageId` to answer an older message, `addressId` to disambiguate the sender, and `expectedRecipients` (`{to, cc, bcc}`) to reject the send if the computed recipients differ from what you reviewed. `from` defaults to the address's public sender, otherwise its receiving address; an administrator can set it to any address on a domain registered in OpenSend for the receiving region, while address keys may only use their own addresses. OpenSend sets `In-Reply-To` and `References`. `202` means queued, not delivered.

```ts
import { getInboundThread, replyToInboundThread } from 'opensend-js';

// event is a verified message.received webhook; no address lookup is required.
const { data: thread } = await getInboundThread({ client, path: { threadId: event.threadId }, throwOnError: true });
await replyToInboundThread({
  client, path: { threadId: thread.id }, headers: { 'Idempotency-Key': operatorActionId },
  body: { text: approvedReply, addressId: event.addressId, replyToMessageId: event.messageId },
  throwOnError: true,
});
```

### Forward a public address into OpenSend

Keep your existing mail provider for the root domain and let OpenSend receive one forwarded address. This is the flow used for `testing@opencode.ai`:

1. Add and verify `inbox.example.com` in OpenSend, then enable receiving on it. Publish its SES MX record **only** on `inbox.example.com`; never add an SES MX to `example.com`, which would outrank your provider and take all its mail.
2. In your provider (for example Cloudflare Email Routing), forward `support@example.com` to `support@inbox.example.com` and verify that destination. Automatic forwarding keeps `From`, `To`, `Subject`, `Message-ID`, `In-Reply-To` and `References`; it rewrites the envelope sender and adds authentication headers.
3. Reply as the public address. Either create the address with `"publicAddress": "support@example.com"` (same local part, parent domain verified with DKIM), or pass `from` per reply when the address already exists, for example because the catch-all created it:

```ts
await replyToInboundThread({
  client, path: { threadId }, headers: { 'Idempotency-Key': `reply-${messageId}` },
  body: {
    addressId, replyToMessageId: messageId, from: 'support@example.com',
    text: 'Thanks, we are on it.',
    expectedRecipients: { to: ['customer@example.net'], cc: [], bcc: [] },
  },
  throwOnError: true,
});
```

The customer sees only `support@example.com`. When they reply, their client references your message's SES `Message-ID`, the provider forwards it to `inbox.example.com`, and OpenSend files it in the same thread. Test one round trip with a real external inbox before sending customer traffic.

**Only act on verified senders:** set `"requireDmarc": true` when creating the address (or `PATCH` it later). Mail without a DMARC pass for its `From` domain is still stored, labelled `unverified` for a person to review, but does not emit `message.received`, so every `message.received` comes from a sender that passed DMARC. The event's `data.dmarc` carries the verdict. SES checks DMARC against the original `From` domain, so it works through forwarding as long as the sender's DKIM signature survives.

**Browse or start conversations:** `GET /v1/inbound/threads?q=invoice` returns one row per visible conversation, newest activity first. Filter by `addressId` or page using `nextCursor`. Detail pages read oldest first within the most recent page; follow their cursor for earlier messages. `GET /v1/inbound/messages/{messageId}` returns the full stored body and attachment metadata. `POST /v1/inbound/threads` with `{addressId, to, subject, text}` starts a conversation. Alternatively, add `replyAddressId` to a single explicit-body transactional `/v1/emails/send` with live manage permission; the receipt includes `threadId` and `inboundMessageId`.

**Every inbound message, including unrouted mail:** admins can subscribe to `message.stored` without an address filter. Search `GET /v1/inbound/messages?direction=inbound&q=widget` or catch up with `GET /v1/inbound/events?types=message.stored&after={cursor}` within the 30-day event retention period. Address keys cannot read unassigned mail; an unrouted message needs to be claimed by an address before replying. Choose one event type per automation to avoid handling both storage and delivery.

**Temporary addresses:** set `ttlSeconds` when creating a fresh address. Expiry stops routing and new sends without purging history. Temporary addresses cannot claim a permanent public sender identity.

**Existing integrations:** `/mailbox/v1`, `replyMailboxId`, issued keys, opaque `mbx_…` IDs, and old dashboard links remain compatible. No data migration or address recreation is required.

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
