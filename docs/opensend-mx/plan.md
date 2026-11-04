# OpenSend MX plan

OpenSend MX is the hosted, multi-tenant OpenSend at `https://opensend.mx`. It behaves like the real customer product from day one; a sign-up allowlist (`anoma.ly` for now) is the only gate. Billing is out of scope. The research behind this plan is in [`research/`](research/) (Nov 3, 2026); this file is the current decision record and wins where they disagree.

## Principles

- **Customer product, not our install.** Nothing Anomaly-specific in code; deployment settings live in the GitHub `mx` environment.
- **Few moving parts and few database round trips.** Prefer one set-based statement over caches or new services.
- **The product manages AWS.** Shared sending runs on one IAM key that OpenSend uses to provision and monitor everything itself. Bring-your-own AWS uses a CloudFormation role OpenSend assumes. No IaC or console work for either.
- **Self-hosting keeps working.** The `default` workspace, `DEFAULT_WORKSPACE_OWNERS` and the single AWS key in env remain the single-tenant path; MX bypasses the first two.

## Customer flow

1. **Sign up** with Google (allowlisted domains only for now). Invitees join the inviting workspace; everyone else gets a new workspace named after them ("Ryan Vogel's Organization", editable) and is its owner.
2. **"How do you want to send?"**
   - **Bring your own AWS:** one-click CloudFormation role with a per-connection external ID. You pay AWS directly.
   - **OpenSend shared sending:** $0.11 per 1,000 emails (displayed only; no billing yet). us-east-2 now, eu-west-1 later.
3. **Add a domain:** DKIM, MAIL FROM and an `_opensend` TXT ownership record, checked automatically.
4. **Create an API key and send.** Test mode works immediately.
5. **Invite teammates** as owner, admin or member.

## Later ideas

- Onboarding variant (Ryan, Nov 4): after sign-up, go straight to "Add your first domain" on Hosted mail, with "Want to use your own AWS account? Connect it" at the bottom, instead of the split choice. Keep the split for now.

## Build order

| # | Step | Done when |
|---|---|---|
| 1 | **Real sign-up and workspaces.** The allowlist gates only uninvited sign-up; requests and sends are authorized by membership. New workspace per sign-up; invites; Better Auth's owner/admin/member roles enforced in the API, MCP and dispatch; workspace switcher. | Two allowlisted users get isolated workspaces; an invited teammate joins as admin or member. |
| 2 | **Onboarding choice.** `provider_connections` (shared or bring-your-own). Shared: two shared configuration sets per region and a lazily created SES tenant per workspace (Strict policy, tenant suppression). Bring-your-own: CloudFormation quick-create, `sts:AssumeRole` check, unique AWS account, then the existing provisioning. | A new workspace reaches "ready" either way. |
| 3 | **Connection-aware sending.** Exclusive `domain_claims` (no parent/child overlap, TXT proof, no adopting existing identities or importing the account's identities), `TenantName` on shared sends, no SES stored templates on the shared account, dispatcher shards and SNS trust keyed by AWS account and region. | Shared and bring-your-own workspaces both send live and get feedback without interfering. |
| 4 | **Inbound and webhooks across workspaces.** Remove the remaining hardcoded workspace reads; split shared receipts by recipient domain owner; per-workspace webhook destinations with a self-origin denylist. | Inbound and webhooks work across two workspaces. |
| 5 | **Shared-pool guardrails.** 100/day cap for a new workspace's first week; one auto-pause rule (>= 10 hard bounces or >= 2 complaints in 24 h at low volume, otherwise > 3% bounce or > 0.05% complaints), applied across regions; hourly `GetAccount` and `GetTenant` sync; two-workspace acceptance cases. | Isolation tests pass; the allowlist can be cleared. |

Later, only on demand: eu-west-1, more roles and SSO, Resend-parity features (SMTP, more SDKs, one-click DNS, automations), remaining performance work.

## Built so far (branch `opensend-mx`)

- Deployment: Worker `opensend-mx` at `opensend.mx`, PlanetScale `opensend-public` (us-east-2), Cloudflare resources via `infra/` and `Infra MX`, deploys via `Deploy MX`.
- Workspace tables; credentials resolve their own workspace; sending pipeline, dispatcher (fair across workspaces) and SES feedback run per row's workspace.
- Round trips: send 13 -> 7, batch of 100 309 -> 7, dispatcher across 100 workspaces 705 -> 47 statements, feedback for 100 deliveries 62 -> 1.
- Shared AWS bootstrap policy: [`infra/aws-shared/`](../../infra/aws-shared/).
