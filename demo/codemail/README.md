# codemail

An MCP server that gives AI agents a real mailbox, built on the OpenSend mailbox API (`/mailbox/v1`). It runs as its own Cloudflare Worker at `https://mail.opcd.ai/mcp`.

## How it works

- **Sign-in:** MCP clients connect with OAuth. On the consent page the user pastes an OpenSend **mailbox key** (OpenSend → API keys → Mailbox keys). codemail checks the key against OpenSend, then stores it encrypted in the OAuth grant (`@cloudflare/workers-oauth-provider`, KV `OAUTH_KV`).
- **Access:** the key's mailbox scope and permissions (read, send, modify) limit what the agent can do.
- **Server:** a stateless MCP handler (`agents/mcp/server` with MCP SDK v2) forwards each tool call to OpenSend with that key.

## Tools

| Tool | What it does |
| --- | --- |
| `list_mailboxes` | Mailboxes on this connection, with unread counts |
| `check_inbox` | Conversations by folder, unread or full-text search |
| `read_conversation` | A whole conversation with reply links; optional `mark_as_read` |
| `search_mail` | Individual messages by text, direction, unread or label |
| `send_email` | New email (optionally with attachments) |
| `reply` | Threaded reply to a conversation or message; `reply_all`, `quote` |
| `forward` | Forward with a note and the original attachments |
| `update_conversations` | Read/unread, archive, star, trash, spam, labels (up to 100) |
| `wait_for_mail` | Long-poll for new mail (up to 30s) with a cursor |
| `get_attachment` | Text inline, images as images, otherwise a signed link |
| `list_labels` | Labels in use with counts |

`mailbox` is optional when the connection has one mailbox. Results end with the next useful call.

## Develop and deploy

```sh
npm install
npm run check          # type-check
npm run dev            # wrangler dev
npm run deploy         # wrangler deploy (needs the KV namespace ID in wrangler.jsonc)
```

Configuration lives in `wrangler.jsonc`: `PUBLIC_URL` (this Worker's origin) and `OPENSEND_URL` (the OpenSend deployment). `global_fetch_strictly_public` is required for OAuth Client ID Metadata Documents, which also means the Worker can only reach public URLs.
