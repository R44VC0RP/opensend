# Implementation decisions and future verification

[Hub](README.md) · Prepared 2026-09-08 · **No API has been implemented and none of the AWS integration checks below has been run.**

This turns the reference research into a later build checklist. Recommendations are provisional; the user has not selected a hosting stack, customer connection model or campaign consent authority.

## Decisions that change the API/data model

| Decision | Recommended starting point | Why / reference |
| --- | --- | --- |
| SES interface | SES API v2, current server-side SDK; classic SES only for missing legacy capabilities | [API inventory](api-and-sdk-inventory.md) |
| Customer connection | Cross-account role with unique ExternalId; separately supported explicit key fallback | [Credentials and IAM](credentials-and-iam.md) |
| Send scope | Every request resolves an authorized connection + AWS account + region + optional tenant | [Accounts/regions](accounts-regions-and-onboarding.md) |
| Marketing unsubscribe | Choose SES-managed single-recipient `SendEmail` or OpenSend-managed bulk unsubscribe explicitly | [Marketing tradeoff](marketing-consent-and-suppression.md) |
| Delivery telemetry | Required configuration set and authenticated, durable downstream event ingestion | [Delivery/events](delivery-events-and-observability.md) |
| Retry contract | Application idempotency plus explicit ambiguous provider outcomes, not “exactly once” | [Sending/templates](sending-and-templates.md) |
| Bulk contract | One recipient per job; batch as an execution detail; persist per-entry results | [Sending/templates](sending-and-templates.md) |
| Templates | App-owned immutable versions, explicit regional deployment or inline content | [Sending/templates](sending-and-templates.md) |
| Isolation | Customer AWS accounts initially; SES tenants an explicit optional capability | [Accounts/regions](accounts-regions-and-onboarding.md) |
| Costs | Selected plan + add-ons, not a fixed universal send price | [Limits/costs](limits-costs-and-operations.md) |

### Minimum logical records (proposal, not a database schema)

**Connection:** workspace owner, verified AWS account/partition, credential strategy/reference, role ARN/ExternalId reference, lifecycle, allowed regions and capabilities. No plaintext secrets in API responses.

**Regional readiness:** identity/DKIM/MAIL FROM state, production access, sending enabled, quotas/time observed, configuration set/event destination, optional tenant and routing endpoint, missing permissions and paid-feature state.

**Template version:** immutable app ID/version, content hash, render schema, optional per-region SES names/ARNs and deployment status. No mutable template-name lookup that changes queued content accidentally.

**Message/job/attempt:** application ID/idempotency key, type/purpose, region/connection, recipient, template version, expiry, campaign metadata, attempt state and provider IDs. Preserve the difference between “queued locally,” “API dispatch started,” “accepted” and “delivery observed.”

**Consent/suppression/events:** purpose-scoped consent provenance and current projection, cross-region application blocks, exact-case provider suppression entries, trusted provider envelopes, delivery/engagement history and outgoing customer webhook attempts.

These records deliberately separate the OpenSend tenant from the AWS account and the SES tenant. A resource name alone is never a tenant boundary.

## Proposed capability tiers—not a promise of initial scope

| Tier | Candidate capability | Boundary |
| --- | --- | --- |
| Connect/read | Validate identity/account/region, discover quotas/identities/templates/configuration | No sends, DNS writes, production requests or paid-feature activation |
| Transactional | Single sends, templates, attachments, idempotency, events and suppression | No uncontrolled marketing imports |
| Marketing | Campaign queues, bulk, segmentation, consent/unsubscribe, pause/cancel | Must settle consent authority and provider requirements first |
| Administrative | Identity setup, template deployment, configuration sets, event provisioning, imports | Separate permissions and explicit writes |
| Advanced | SES tenants, multi-region routing, validation, VDM, dedicated IPs, archiving | Availability, cost, IAM and acceptance checks per feature |

## Acceptance matrix for the future implementation

These are planned observable checks, **not newly created test files**. Use a customer-approved test account/region and explicit send budget. Existing test suites/runtime checks should be used where available.

### Connect and authorization

| Scenario | Required observation | Environment / caution |
| --- | --- | --- |
| Valid AssumeRole + unique ExternalId | Returned account matches expected; regional reads succeed | Authorized customer test role |
| Wrong/missing ExternalId or cross-workspace role | Connection refused; no credential fallback or workspace crossover | Controlled negative IAM case |
| Valid access key but missing SES permission | “Permission missing,” not “empty account” | No secret in logs/error body |
| Expired STS credentials | Refresh/retry works without duplicate sends | Expiry injection then real role renewal |
| Role revoked mid-campaign | Pending sends pause; no alternate account fallback | Small queued workload |
| Region not enabled/unsupported partition | Clear capability error, other regions unaffected | Read-only where possible |
| Regional sandbox versus production | Correct readiness and recipient restrictions independently | Same account, two configured regions |
| IAM condition/resource scope denies another identity | Send rejected; app never broadens role policy | Explicitly authorized negative send |
| Resource name reused in another account | No cross-account template/config/identity resolution | Separate authorized connections |

### Sending, content and retries

| Scenario | Required observation | Environment / caution |
| --- | --- | --- |
| Single transactional send | Provider acceptance correlated with delivery event | Simulator first; small real inbox follow-up |
| Stored and inline templates | Correct output/escaping and actual delivered MIME | Include Unicode and missing fields |
| Missing render variable | Failure surfaced even if initial API accepted | Rendering-failure event configured |
| Attachment and inline image | Correct filename/type/disposition/content-ID and decoded bytes | Controlled safe files, size budget |
| Near-limit encoded MIME | Valid boundary accepted; oversize rejected before dispatch where determinable | Do not infer from raw file size |
| Invalid address / unsupported international local part | Actionable input error, no silent rewriting | Use explicit contract cases |
| Multi-entry bulk partial failure | Successful entries not retried, failed entries individually reported | Controlled mix; preserve entry mapping |
| Same idempotency key, same payload | Same application result, no second dispatch | Concurrent requests too |
| Same idempotency key, different payload | Conflict, never silent reuse | Account/workspace scoped keys |
| Timeout after possible SES acceptance | Ambiguous attempt state; policy prevents automatic blind replay | Network failure injection + provider/event evidence |
| Throttling / exhausted quota | Backoff/queue pause and transactional reservation work | No unapproved load test |
| Expired OTP/cancelled campaign | Undispatched jobs stop, accepted messages not falsely “recalled” | Cancellation race check |
| Template updated after enqueue | Queued version remains stable or explicit documented alternative | Own test template only |

### Marketing and delivery safety

| Scenario | Required observation | Environment / caution |
| --- | --- | --- |
| Managed SES unsubscribe | Single-recipient headers + footer + actual preference update | Easy DKIM setup and approved recipient |
| Custom bulk unsubscribe | Correct per-recipient signed token, delivered headers, one-click POST, future suppression | No auth required to opt out; no open redirect |
| GET link scanner / repeated POST | No accidental GET unsubscribe; POST idempotent | RFC 8058 path distinct from preferences page |
| Unsubscribe after campaign enqueue | Remaining sends blocked at dispatch | Consistency/race test |
| Re-import previously unsubscribed address | Opt-out not silently erased | Explicit resubscription path separate |
| Transactional after marketing opt-out | Only genuinely transactional purpose permitted | Hard-bounce safety still applied |
| Account versus tenant suppression | Effective scope/override behavior matches AWS; app safety block still holds | Requires actual tenant-enabled account |
| Mixed-case suppression entry | Get/delete target original-case address correctly | Customer-owned test address only |
| Suppression import partial failure | Counts/failure report accurate; no blanket success | S3/KMS permissions and cleanup authorized |
| Auto Validation | Verdict direction correct; billed feature not auto-enabled; distinct suppression reason | Explicit spend approval |

### Events, analytics and optional features

| Scenario | Required observation | Environment / caution |
| --- | --- | --- |
| Simulator success/bounce/complaint | Authenticated event captured once in projection | Does not prove VDM or actual suppression insertion |
| Duplicate/out-of-order provider events | Correct lifecycle, no lost legitimate repeat opens/clicks | Replay captured redacted payloads |
| `isBotEvent` absent/Likely/Unlikely | Raw and filtered engagement remain distinct | Do not use as boolean |
| Forged SNS/unknown topic | No state mutation and no arbitrary certificate/confirmation URL fetch | Local negative request |
| Event target permission loss | Readiness degradation/alert, not imaginary delivery success | Controlled resource policy change |
| Customer webhook downtime | Backoff/replay; never resend original email | Own endpoint |
| Real single-recipient VDM send | Metrics/insights appear within documented coverage/window | Not simulator or identity-delegated send |
| Multi-region failover | Both regions ready, events correlated and opt-outs honored on both | Explicit cost/residency/route approval |
| SES tenant pause | Only authorized tenant paused; AWS enforcement not auto-bypassed | Advanced opt-in check |
| Pricing plan differs by region | Cost estimate uses correct plan or says unknown | No plan changes for verification |
| Outbound archive | Approved content searchable via correct Mail Manager API and retention | Paid feature; no unapproved deletion |
| Optional SES S/MIME signing | Active ACM certificate association + signing scheme produce a signature validated by recipient client | Separate certificate permissions/expiry; not encryption or DKIM; negative expired/mismatched sender cases |

## Known unresolved items and how to close them

| Gap | Evidence needed before shipping |
| --- | --- |
| Actual AWS account/regions and production quotas | Authorized read-only connection; no account was inspected here |
| SDK release used by implementation | Pin package versions and inspect commands/fields; reference API date alone is not a release version |
| Recent docs versus packaged model parity | Verify new tenant suppression and other newer members survive SDK serialization; see inventory caveat |
| `SendBulkEmail` practical rate and exact edge-boundaries | Target operation reference + controlled account measurement, not generic mixed-generation quota prose |
| Bulk + custom unsubscribe delivered header signatures | Real recipient MIME inspection, not just an API JSON fixture |
| Detailed IAM policy sufficiency | AWS policy validation plus actual allowed/denied calls under scoped role |
| Region/partition availability of advanced features | Current endpoint/feature docs and regional capability checks |
| Tenant suppression bulk-import parity | Exact current `ImportDestination` request shape and target-region support |
| Actual pricing/entitlement and scheduled changes | Read regional `GetAccount.PricingAttributes.CurrentPlan/NextPlan`; confirm billing/allowances. `PutAccountPricingAttributes` exists but is an explicit billing-changing admin action, not a probe |
| Complete event reliability/reconciliation | Demonstrated source→queue→consumer path; EventBridge SES events are documented best effort |
| Data residency/legal requirements | User's deployment/customer requirements and applicable-law review |
| Customer-side DNS automation | DNS provider permissions/ownership; manual records remain an acceptable initial path |

## Research verification versus runtime verification

This hub is verified by inspecting current public AWS documentation, SDK/service definitions and source links, checking its internal references, and reviewing the contributed documents. That can establish documented request fields and constraints; it cannot establish that a specific customer's IAM role, DNS, sandbox status, event pipeline or send behavior works.

The eventual handoff should record **actual** SDK version, account/region (redacted as needed), approved send recipients/budget, observed provider IDs/event evidence, passed/failed acceptance cases and any gaps. Never call the full integration verified because compilation or a simulator-only check passed.
