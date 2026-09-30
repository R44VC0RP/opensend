# codemail

Email for AI agents at **opcd.ai**. People sign in with Google, create an organization (`acme` → `@acme.opcd.ai`), invite teammates and create agent mailboxes. Agents connect over MCP at `https://opcd.ai/mcp`. Everything runs on one Cloudflare Worker on top of the OpenSend mailbox API.

## How it works

- **Accounts:** Better Auth with Google sign-in and its organization plugin (owners, admins, members, invitations). Tables live in the `codemail` schema of the OpenSend database, reached through the same Hyperdrive config.
- **Mail domains:** creating an organization adds `<slug>.opcd.ai` as an OpenSend receiving subdomain (`POST /mailbox/v1/domains/{id}/subdomains`). It's live at once: SES receives it through the `.opcd.ai` wildcard recipient and a `*.opcd.ai` MX record, with no DNS change or verification per organization. Deleted organizations' slugs are retired and never reissued.
- **OpenSend access:** codemail holds one live OpenSend API key (manage + send) for subdomains, mailboxes, mailbox keys and invitation emails.
- **MCP sign-in:** `workers-oauth-provider` handles dynamic registration, Client ID Metadata Documents, PKCE and refresh tokens. Its consent page uses the Google session. The user picks an organization, mailboxes and permissions (read, send, organize), and codemail mints an OpenSend mailbox key with exactly that scope, stored encrypted in the grant.
- **Revocation:** every MCP call checks organization membership. Removing a member, disconnecting an agent or deleting the organization revokes the grant and its mailbox key.
- **Design:** pages use OpenSend's design system, including its `tokens.css`, `ui.css`, `app.css`, OpenTUI Mono and Inter fonts, and light/dark theme. `scripts/sync-design.mjs` copies them from `../../app` before `dev` and `deploy`, and only `public/codemail.css` is codemail's own.

## MCP tools

| Tool | What it does |
| --- | --- |
| `list_mailboxes` | Mailboxes on this connection, with unread counts |
| `check_inbox` | Conversations by folder, unread or full-text search |
| `read_conversation` | A whole conversation with reply links; optional `mark_as_read` |
| `search_mail` | Individual messages by text, direction, unread or label |
| `find_people` | The organization directory (people, agent mailboxes) and the mailbox's past contacts |
| `send_email` | New email (optionally with attachments) |
| `reply` | Threaded reply to a conversation or message; `reply_all`, `quote`, extra `cc`/`bcc` |
| `forward` | Forward with a note and the original attachments |
| `update_conversations` | Read/unread, archive, star, trash, spam, labels (up to 100) |
| `wait_for_mail` | Long-poll for new mail (up to 30s) with a cursor |
| `get_attachment` | Text inline, images as images, otherwise a signed link |
| `list_labels` | Labels in use with counts |

`mailbox` is optional when the connection has one mailbox. Results end with the next useful call.

Recipients work like Gmail's: `to`, `cc` and `bcc` take addresses or names of people in the organization (`cc: ["maya"]`). Names resolve by exact name, first name, email or local part, then partial match, preferring teammates, then agent mailboxes, then the mailbox's past contacts (OpenSend's `GET /mailbox/v1/mailboxes/{id}/contacts`). Unknown or ambiguous names fail with the candidates and send nothing, and results say who each name resolved to. A reply's `cc` is added to the `reply_all` recipients. Conversations label teammates and agent mailboxes.

## Setup

1. OpenSend: `opcd.ai` must be a verified, receiving mailbox domain. Publish `*.opcd.ai MX 10 inbound-smtp.us-east-1.amazonaws.com` once.
2. Database: apply `migrations/001_init.sql` to the OpenSend database with a role that can create schemas.
3. Google: add `https://opcd.ai/api/auth/callback/google` as an authorized redirect URI of the OAuth client.
4. KV: `npx wrangler kv namespace create codemail-oauth`, then put its ID in `wrangler.jsonc`.
5. Secrets: `npx wrangler secret put` for `OPENSEND_API_KEY` (a live OpenSend key with manage and send), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `BETTER_AUTH_SECRET` (`openssl rand -hex 32`).
6. `SIGNUP_ALLOWLIST` in `wrangler.jsonc` limits who can create organizations (emails or `@domains`; empty allows anyone). Invited people can always join.

```sh
npm install
npm run check    # type-check
npm run dev      # syncs the design system, then wrangler dev
npm run deploy   # syncs the design system, then wrangler deploy
```
