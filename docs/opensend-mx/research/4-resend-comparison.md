# OpenSend MX vs Resend: feature comparison (as of Nov 3, 2026)

**Summary:** Resend now covers almost every area. It has also added **Inboxes**: threads, labels, drafts, assignment, search and a built-in triage agent ([docs](https://resend.com/docs/dashboard/inboxes/introduction.md), [agent](https://resend.com/docs/dashboard/inboxes/agent.md)). So "we have inbound threads" no longer sets OpenSend apart on its own. OpenSend's real lead is in four areas: safety for AI agents, finer-grained permissions, campaign control and where data lives. Its biggest gaps are in hosted-product basics: teams, onboarding, SMTP, SDKs in other languages, automations and a preference center.

## 1. Comparison table

| Capability | Resend | OpenSend today | Gap / advantage |
|---|---|---|---|
| Send, batch, idempotency | Send and batch of 100; idempotency keys kept 24h; tags; custom headers ([idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [llms.txt](https://resend.com/docs/llms.txt)) | Send and batch (100 messages, 50 recipients each). An `Idempotency-Key` sent with a different payload returns `IDEMPOTENCY_CONFLICT`. **No custom headers, no tags** (`api/README.md` §Sending boundaries; `SendEmailInput` in `api/openapi.json`) | Gap: headers and tags |
| Scheduled transactional email | `scheduled_at` up to 30 days ahead, accepts phrases like "in 1 hour", can be rescheduled or canceled ([docs](https://resend.com/docs/dashboard/emails/schedule-email.md)) | Only campaigns can be scheduled (`/v1/campaigns/{id}/schedule`). `SendEmailInput` has no `scheduledAt` | Gap |
| SMTP relay | Yes, on every plan ([pricing](https://resend.com/pricing.md)) | None | Gap |
| SDKs | Node, PHP, Laravel, Python, Ruby, Go, Java, Rust, .NET, plus community SDKs ([sdks](https://resend.com/docs/sdks)) | TypeScript only (`sdk/README.md`) | Gap |
| Templates / React Email | Templates with typed variables, version history, folders and React Email upload ([templates](https://resend.com/docs/api-reference/templates)) | Block-HTML templates with publish, preview and preview image (`/v1/templates`). Transactional email uses SES stored templates, and callers must escape values themselves (`api/README.md`) | Gap |
| Broadcasts / campaigns | Broadcasts API: cancel, duplicate, recipients, clicked links ([changelog](https://resend.com/changelog.md)) | Versioned revisions; durable audience reviews up to 1M contacts; test send; **pause, resume and pacing**; stats (`api/README.md` §Large campaigns) | OpenSend ahead on control (I found no pause in Resend's docs) |
| Contacts / segments | Contacts, typed properties, segments, CSV import | Contacts, lists, CSV import (50k rows), AudienceQL query/plan/apply. Segment rules cover only email, firstName, plan, country and open/click recency (`SegmentRule`) | Mixed: segment fields are thin |
| Topics / preference center | Topics plus a custom unsubscribe page ([topics](https://resend.com/docs/dashboard/contacts/manage-topics)) | One "unsubscribe from all marketing" switch; "No preference-center UI" (`api/README.md`; listed as deferred in `todo.md`) | Gap |
| Automations | Triggers, custom events, delays, wait-for-event, branching ([docs](https://resend.com/docs/dashboard/automations/introduction)) | None | Large gap |
| Webhooks | About 35 event types (email, domain, contact, suppression, topic, inbox); replay; attempt history ([llms.txt](https://resend.com/docs/llms.txt)) | 10 sending events and 13 inbound events; Standard Webhooks signatures; secret rotation; test sends; delivery logs; manual retry (`CreateWebhook`, `CreateInboundWebhook`) | Gap: no domain, contact or suppression events |
| Inbound | Receiving, plus Inboxes: threads, labels, drafts, assignment, search, AI triage (drafts only), forwarding of an existing address | Addresses, threads, labels, replies with an `expectedRecipients` guard, forwarded public addresses, catch-all auto-create, temporary addresses with a TTL, per-address keys, cursor-based event feed, unrouted mail (`sdk/README.md`, `mcp/README.md`) | About even. Resend leads on team-inbox UX; OpenSend leads on agent safety and scoping |
| Domains / DNS | One-click DNS setup via Domain Connect (e.g. Cloudflare), Vercel Marketplace, domain claim, custom return path, TLS settings ([cloudflare](https://resend.com/docs/guides/dns/cloudflare.md)) | SES DKIM records and custom MAIL FROM; "neither creates AWS connections nor replaces DNS records" (`api/README.md`) | Gap |
| Dedicated IPs | Managed pools with automatic warmup, $30/mo ([pricing](https://resend.com/pricing.md)) | Not exposed | Gap (later) |
| Multi-region / data residency | 4 sending regions, but **all account data is stored in the US** ([regions](https://resend.com/docs/dashboard/domains/regions.md)) | Any SES region; data stays wherever the installation is deployed (`/v1/regions*`) | **OpenSend advantage** |
| Logs and search | Email list, API request logs plus a Logs API, share-email links, 30-day retention | Email logs and events kept 30 days. Request logs exist only as server JSON (`api/README.md` §Errors, logs) | Gap: no request-log API or UI |
| Analytics / deliverability | Per-email deliverability insights, metrics API, link checker, compatibility checker | `/v1/metrics`, campaign stats, SES reputation page with Slack alerts (`app/src/features/settings/reputation.tsx`) | Mixed |
| Test mode | Test addresses: `delivered@`, `bounced@`, `complained@`, `suppressed@` resend.dev ([docs](https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing.md)) | `os_test_` keys run the full pipeline in simulation, but only emit sent and delivered events (`api/README.md` §benchmarks) | Better isolation, but no way to simulate a bounce or complaint |
| First email | Send from `onboarding@resend.dev` before verifying a domain; managed `*.resend.app` address for receiving | Self-host setup, Google allowlist, then SES sandbox and verification | Gap |
| Team / roles / SSO / MFA | Admin and Member roles, SSO add-on, MFA, Google or GitHub login ([team](https://resend.com/docs/dashboard/settings/team.md), [sso](https://resend.com/changelog/sso)) | Google sign-in only; every approved user is an admin; no teams (`api/README.md`) | Gap |
| Audit logs | Not found in Resend's public docs (unsure) | No user-facing audit log | Opportunity |
| API key permissions | `full_access` or `sending_access`, optional domain restriction ([docs](https://resend.com/docs/api-reference/api-keys/create-api-key.md)) | Read / send / manage, combined with live / test and domain restrictions; per-address inbound keys; short-lived agent tokens (`CreateApiKey`, `mcp/README.md`) | **OpenSend advantage** |
| MCP / AI agents | Remote MCP with OAuth covering the full platform; skills; plugins for Claude, Cursor and Codex; CLI with an agent mode ([mcp](https://resend.com/docs/mcp-server.md)) | Hosted MCP with OAuth; test-mode read access by default; `confirm: true` on writes; idempotent thread sends; recipient guard (`mcp/README.md`) | OpenSend is safer; Resend is broader and easier to find |
| CLI | Full CLI via brew, npm or curl ([cli](https://resend.com/docs/cli.md)) | Only `npx opensend-js upload` | Gap |
| Status page | [resend-status.com](https://resend-status.com) shows each component, including MCP | None | Gap |
| Compliance | SOC 2 Type II, GDPR DPA, Data Privacy Framework ([security](https://resend.com/security)) | None | Gap |
| Suppression API | Full CRUD plus batch operations | Only a `suppressed` field on each contact; no endpoints | Gap |
| Docs | `llms.txt`, quickstarts per framework, in-app docs, AI assistant | READMEs plus in-app `/docs` and `/developer` pages | Gap |

**Other providers, only where they beat Resend:**
- **Postmark:** Free weekly DMARC digests ([dmarc.postmarkapp.com](https://dmarc.postmarkapp.com/)); Resend only has an open-source DMARC analyzer. Postmark also offers multi-region routing over SMTP and separate message streams ([pricing](https://postmarkapp.com/pricing)).
- **Loops:** Unlimited sends billed per contact. Resend's marketing plans now match this, so it's no longer an edge.
- **Plunk:** As far as I know it's open source and self-hostable, which OpenSend matches. I did not verify this.

## 2. Where OpenSend is already better

1. **Data residency.** Resend sends from four regions but stores all data in the US. OpenSend runs in any SES region, and the data lives there too.
2. **Permission granularity.** Keys combine read/send/manage with live/test and domain restrictions. On top of that come per-address inbound keys and short-lived (`os_agent_`) delegated tokens. Resend offers two permission levels.
3. **Agent safety.** MCP defaults to test-mode read access. Every write needs `confirm: true`. Replies can carry `expectedRecipients`, and the send is rejected if the actual recipients differ. MCP thread sends must carry an idempotency key. AudienceQL bulk changes are planned first and then applied, with up to 10k contacts frozen during the plan (`mcp/README.md`).
4. **Campaign control.** Audiences are snapshotted before sending. Campaigns can be paused, resumed and paced. Consent is rechecked at the moment each email is dispatched.
5. **Inbound edge cases.** Temporary addresses with a TTL, catch-all auto-create, forwarded public addresses, an unrouted-mail store and a cursor-based event feed you can catch up from.
6. **A real test environment.** Test keys use separate data and run the full pipeline in simulation, rather than relying on special recipient addresses.

## 3. Gaps that matter most, by priority

**Must**
- **Teams, roles, invites, and email/GitHub sign-in plus MFA.** A hosted multi-tenant service can't be Google-only with everyone as admin.
- **First email in a minute.** A shared sandbox sender, a managed receiving subdomain, and bounce/complaint/suppressed test addresses. This is Resend's signature onboarding.
- **One-click DNS setup** (Domain Connect or the Cloudflare API). Domain verification is where new users drop off most.
- **SMTP relay.** Required for Supabase Auth, WordPress, Rails and other no-code tools.
- **Transactional scheduling, update and cancel, plus tags and custom headers.** These are basics that people expect when migrating from Resend.
- **SDKs for Python, Go, PHP and Ruby,** generated from `openapi.json`. This is cheap to do and widely expected.

**Should**
- **Automations** (event triggers, delays, branches). Resend and Loops both sell lifecycle email.
- **Topics and a preference center.** "Unsubscribe from everything" loses subscribers who only wanted fewer emails.
- **Suppression API, plus contact and domain webhook events.** Users expect parity here when integrating.
- **CLI with JSON / agent mode.** Agents and CI pipelines use it.
- **API request logs (UI and API) and per-email deliverability insights.** Debugging tools are part of what people mean by Resend's good developer experience.
- **Transactional templates with typed variables** in OpenSend itself (instead of SES stored templates), plus React Email upload.
- **Inbox team features:** assignment, drafts, and AI triage that only writes drafts. This closes the gap with Resend Inboxes.
- **Public status page.**

**Later**
- **Managed dedicated IPs** (SES can provide them). Only high-volume senders need them.
- **SSO, audit logs, SOC 2 and a DPA.** Needed to close enterprise deals, not to get started.
- **Platform integrations** (Vercel, Supabase, Auth0, Stripe Projects) and plugins for Claude, Cursor and Codex. These drive distribution once the core is solid.
- **Per-framework quickstarts and `llms.txt`.**

## 4. Differentiators to lead with

1. **Your region, your data, optionally your own AWS.** Data stays in the EU (or anywhere SES runs), which Resend can't offer. Later, add bring-your-own SES so customers keep their own reputation and pay SES prices. The AWS connection wizard is already listed as deferred in `todo.md`.
2. **Email that's safe for agents.** Test by default, explicit confirmation, a recipient guard, idempotent thread sends, short-lived delegated tokens, per-address keys and plan/apply audience changes. Resend's message is "agents can do everything"; OpenSend's can be "agents can't do the wrong thing".
3. **Disposable and forwarded inboxes for agents.** Temporary addresses with a TTL, catch-all auto-create, replying as your public `support@` address while another provider keeps the root domain, and a catch-up event feed.
4. **Campaigns you can stop.** Snapshot review, pacing, pause and resume, and a consent check at dispatch.
5. **Open source with a way out.** The same code can be self-hosted, so customers aren't locked in. Resend open-sources its SDKs and MCP server but not the platform.
