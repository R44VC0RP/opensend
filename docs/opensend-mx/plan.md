# OpenSend MX plan

OpenSend MX is a hosted, multi-tenant OpenSend at `https://opensend.mx`. Users either bring their own AWS account or send through OpenSend's shared infrastructure. The goal is to be better than Resend everywhere. Billing, quotas and abuse prevention are out of scope for now.

This plan combines the five research reports in [`research/`](research/). They were written on Nov 3, 2026 by reading the code (nothing was provisioned or deployed). Every claim there cites a `file:line` or a source URL.

| Report | Question |
|---|---|
| [1. Multi-tenancy audit](research/1-multi-tenancy-audit.md) | What in the code assumes one workspace? |
| [2. AWS tenant isolation](research/2-aws-tenant-isolation.md) | How do bring-your-own AWS and shared sending work, and how is each tenant isolated? |
| [3. Teams, roles, auth](research/3-teams-roles-auth.md) | Sign-up, workspaces, roles, invites, audit log |
| [4. Resend comparison](research/4-resend-comparison.md) | Where are we behind Resend, and where are we ahead? |
| [5. Deployment](research/5-deployment.md) | How to run opensend.mx without touching opensend.anoma.ly |

## Architecture decisions

1. **The tenant is a workspace.** One person can belong to several workspaces with a different role in each. Workspaces use Better Auth's organization plugin for membership and invitations; the OpenSend API enforces the permissions for sessions, API keys and agent tokens alike. The existing `default` workspace stays as it is.
2. **Bring your own AWS uses a cross-account IAM role, not pasted keys.** The user creates the role with a CloudFormation quick-create link. OpenSend assumes it using a unique external ID per connection. No long-lived customer secret is stored, and the customer can revoke access by deleting the role. The least-privilege policy is in report 2.
3. **Shared sending uses SES tenants.** These launched in August 2025. Each workspace gets an SES tenant with its identities and configuration sets associated, a suppression list for that tenant only, and the Strict reputation policy, so a tenant with a problem is paused on its own. AWS warns that tenants still share the account's overall reputation. Full isolation needs one AWS member account per workspace, which can be offered later as an upgrade.
4. **Domains are claimed exclusively.** A domain needs DNS proof before a workspace can use it, and two workspaces can never claim the same domain or overlapping parent and subdomains. Automatically importing identities that already exist in the SES account is turned off for shared accounts.
5. **Separate deployment, same codebase.** MX gets its own Worker (`opensend-mx-api`), queues, R2 bucket, Postgres database, Google OAuth client, auth secret and AWS account. Production keeps deploying only from `main`. MX deploys only from the `opensend-mx` branch, and the SDK is never published from it.

## Phases

Each phase is a series of small PRs. Phases 0–4 must be done before strangers can sign up.

| Phase | What ships | Gate |
|---|---|---|
| **0. Deploy plumbing** | Read the feedback queue name from config (`api/src/worker.ts:117–137`; any other name is silently treated as wake jobs today). Add `wrangler.mx.jsonc` and an MX deploy workflow. Restrict production deploy and SDK publish to `main`. Make the doc examples origin-neutral. | Simulated send reaches `delivered` on MX. Needs approval to provision Cloudflare, Postgres, the Google client and AWS. |
| **1. Workspaces** | `workspaces`, `memberships` and `domain_claims` tables, with `default` seeded. Resolve the workspace from the session or key, never from a hardcoded value. Fix the three known cross-tenant leaks: listing and revoking MCP grants (`mcp-auth.ts:353`), unrestricted senders using another tenant's domain (`sending.ts:241`), and feedback batches taking the first item's workspace (`operations.ts:563`). Creating new workspaces stays disabled. | Production still works unchanged on `default`. |
| **2. Accounts and roles** | Organization plugin, the roles Owner/Admin/Developer/Campaign editor/Viewer, inbox-operator and live-release grants, invitations sent through OpenSend, sign-in with Google, GitHub and email OTP, passkeys or TOTP required for owners and admins, and an audit log. | Every route checks membership and role. |
| **3. Provider connections** | Bring-your-own-role connections and SES tenants for shared sending. Per-connection SNS topics, with the workspace carried through queues, jobs and the dispatcher. Inbound mail is split by the envelope recipient's owner. Dispatcher pacing works per AWS account and region. | Disposable-account test of sending, provisioning, signed feedback and mixed-workspace receiving. |
| **4. Isolation gate** | Two-workspace cases in `api/api.acceptance.test.ts`: MCP grants, overlapping domains, mixed feedback and receipts, BCC and attachments, event cursors, identical idempotency keys, webhooks, and dashboard caches. | All pass on the isolated test database, then open sign-up. |
| **5. Beat Resend (Must)** | A shared sandbox sender and receiving subdomain, so a new user can send their first email in a minute. One-click DNS through Cloudflare or Domain Connect. SMTP relay. Scheduled, updatable and cancelable transactional email. Tags and custom headers. Python, Go, PHP and Ruby SDKs generated from `openapi.json`. Test addresses that simulate a bounce, complaint or suppression. | |
| **6. Should** | Automations, topics and a preference center, a suppression API, domain and contact webhook events, a CLI, request logs, transactional templates with typed variables and React Email, inbox assignment and drafts, a status page. | |

## What we lead with

1. **Your region, your data, optionally your AWS.** Resend stores all account data in the US. MX keeps data in the chosen SES region, and bring-your-own AWS keeps the customer's reputation and SES pricing theirs.
2. **Email that's safe for agents.** Keys default to test mode, writes need `confirm: true`, replies can carry `expectedRecipients`, and delegated tokens are short-lived. MX can also grant an agent reply access to a single inbox address.
3. **Finer-grained access.** Read/send/manage combined with live/test, domain-scoped and address-scoped keys, an enforced MFA policy and a true metadata-only viewer role. Resend has Admin and Member.
4. **Campaigns you can stop.** Snapshot review, pacing, pause and resume, and a consent check at dispatch.
5. **Open source with an exit.** The same code can be self-hosted.

## Open decisions

| Question | Recommendation |
|---|---|
| Accept pasted access keys for bring-your-own AWS? | No at launch. Use the IAM role only, and add keys later if users ask. |
| Isolation on shared infrastructure | SES tenants on one account first; one member account per workspace as a later option. |
| Where multi-tenancy code lives | Build on `opensend-mx`, but merge phases 1–2 into `main` once they're backward compatible, so the two deployments don't drift apart. |
| Cloudflare account for `opensend.mx` | One the production deploy token can't edit. |
| Import production data into MX? | No. MX starts empty. |
