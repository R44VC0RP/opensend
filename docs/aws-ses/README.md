# OpenSend · AWS SES reference hub

**Research date: 2026-09-08.** Local preparation for a transactional and marketing AWS SES wrapper. This is a documentation hub, **not an implemented API, deployed AWS environment or verified customer integration**.

Two independent research workers covered sending/SDKs and credentials/account-region onboarding; the coordinating researcher covered events, marketing, suppression, operations and the build checklist. Existing design files are outside this documentation change.

**Current build decisions:** see the [root TODO](../../todo.md) and [decision document](implementation-decisions-and-verification.md). Initial AWS access is environment-configured; the customer connection wizard and standalone template library are deferred. OpenSend will own marketing unsubscribe, attachment controls are required, and test API keys will simulate rather than send.

## Start here

1. Read [implementation decisions](implementation-decisions-and-verification.md) for the API-shaping choices and unresolved items.
2. Use [credentials and IAM](credentials-and-iam.md) and [account-region onboarding](accounts-regions-and-onboarding.md) to design customer connections.
3. Use [sending and templates](sending-and-templates.md) for transactional/bulk payloads, limits and failure semantics.
4. Read [marketing and suppression](marketing-consent-and-suppression.md) before choosing a bulk sending strategy.
5. Use [delivery events](delivery-events-and-observability.md) and [limits/costs](limits-costs-and-operations.md) to avoid an unreliable or misleading send dashboard.

## Document map

| Reference | Questions it answers |
| --- | --- |
| [API and SDK inventory](api-and-sdk-inventory.md) | Which APIs/clients exist now? SES API v2 versus classic SES versus SMTP? Which newer fields need an up-to-date model? |
| [Sending and templates](sending-and-templates.md) | Single/bulk sending, stored/inline templates, attachments, MIME, personalization, partial failures, retries and duplicate risk |
| [Credentials and IAM](credentials-and-iam.md) | What does a customer create? AssumeRole/ExternalId versus keys, SMTP differences, scoped permissions and trust policies |
| [Accounts, regions and onboarding](accounts-regions-and-onboarding.md) | Account-region readiness, sandbox/production, quotas, identities, DNS/DKIM/MAIL FROM, tenants and multi-region routing |
| [Delivery events and observability](delivery-events-and-observability.md) | Accepted versus delivered, SNS/SQS/EventBridge, signatures, event schemas, tracking, VDM and message history |
| [Marketing, consent and suppression](marketing-consent-and-suppression.md) | Contact lists, unsubscribe, bulk tradeoffs, regional/account/tenant suppression, imports and validation |
| [Limits, costs and operations](limits-costs-and-operations.md) | Numeric quotas, current pricing plans/add-ons, rate limits, simulator caveats and operational controls |
| [Decisions and verification](implementation-decisions-and-verification.md) | What OpenSend must own, suggested records/capabilities, future acceptance matrix and unverified assumptions |

Every topic document has its own primary-source links. Its letter-and-number citation labels refer to that document's Sources section, not an external bibliography.

## Five architecture-changing findings

1. **A connection is not just an API key.** Prefer a customer cross-account IAM role with temporary credentials and a unique ExternalId. A successful STS call does not prove regional SES permission, production access, verified identity or working events. SMTP credentials cannot manage SES APIs.
2. **Bulk marketing needs an explicit consent strategy.** Current `SendBulkEmail` does not expose `ListManagementOptions`; SES-managed unsubscribe is a single-recipient `SendEmail` workflow. Bulk sends need an application-managed unsubscribe/consent path rather than imaginary parity.
3. **SES does not supply OpenSend's durable send ledger.** Acceptance is not delivery, bulk can partially fail, timeout outcomes can be ambiguous, and event transports do not give an end-to-end exactly-once guarantee. OpenSend needs its own jobs, idempotency contract and event history.
4. **Account, region and SES tenant are separate boundaries.** Quotas, identities and many resources are regional. New tenant suppression can skip the account list; application-level consent/safety must survive route changes and failover.
5. **Old SES research is materially incomplete.** Current docs include structured attachments, tenants, email validation, tenant suppression, bot-likelihood engagement fields and 2026 pricing plans. Do not assume all customers pay the historical à-la-carte sending rate.

## Recent capabilities to preserve in the design

| Capability | Why it matters | Where verified / tracked |
| --- | --- | --- |
| Structured v2 attachments and inline template content | Raw MIME is not the only attachment path; inline templates have simpler rendering than stored templates | [Sending](sending-and-templates.md) |
| Per-request `ConfigurationOverrides.Tracking` | Explicit open/click policy on single and bulk sends, with `ENABLED` / `DISABLED` strings | [Sending](sending-and-templates.md) |
| SES tenants and reputation controls | Optional provider-level isolation, not a substitute for app authorization | [Accounts/regions](accounts-regions-and-onboarding.md) |
| On-demand and automatic Email Validation | Priced, probabilistic feature; may suppress a send | [Marketing](marketing-consent-and-suppression.md) |
| Tenant suppression, June 2026 | Scope/reasons overrides and per-tenant suppression-entry operations | [AWS launch](https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-ses-tenant-level-suppression-lists), [detailed behavior](marketing-consent-and-suppression.md) |
| Essentials/Pro/Enterprise plans, July 2026 applicability | `GetAccount.PricingAttributes` reads current/next plan; plan writes change billing and do not auto-enable features | [AWS pricing](https://aws.amazon.com/ses/pricing/), [cost reference](limits-costs-and-operations.md) |
| `isBotEvent`, August 2026 | `Likely` / `Unlikely`, not a boolean or human-proof | [AWS launch](https://aws.amazon.com/about-aws/whats-new/2026/08/amazon-ses-automated-email-interactions), [events](delivery-events-and-observability.md) |
| Global Endpoints versus global deliverability | Routing/failover and analytics are different paid capabilities | [Accounts/regions](accounts-regions-and-onboarding.md), [events](delivery-events-and-observability.md) |
| Outbound archiving through Mail Manager | Separate API, retention, permissions and cost | [Events/archiving](delivery-events-and-observability.md) |
| ACM-backed S/MIME signing | Active sender certificate plus signing-enabled configuration set; not DKIM, TLS or encryption | [API inventory](api-and-sdk-inventory.md) |

This is a capability watchlist, not a claim of feature parity in every SDK version, AWS partition or region.

## Reading rules for future implementation

**AWS-documented behavior** is accompanied by official documentation/API/model links. **Recommendations/proposals** describe how OpenSend could wrap it; they are not AWS guarantees. **Unresolved** marks questions requiring a pinned SDK, customer account, runtime evidence or product decision.

Use current operation references and installed SDK types together. Context7 discovery can retrieve classic SES or unrelated similarly named services; it is not the sole authority for SESv2 request shapes. Release announcements establish availability claims at a point in time, but the operation reference and service model establish actual fields. If they disagree, preserve the discrepancy instead of silently inventing an API.

Do not treat the service API date (`2019-09-27` for SESv2) as the SDK release date or evidence that its schema is old. Likewise “AWS SDK v3” is not “SES API v3.” See the inventory for exact families and SDK guidance.

## Source entry points

| Source | Use |
| --- | --- |
| [SES v2 API reference](https://docs.aws.amazon.com/ses/latest/APIReference-V2/Welcome.html) | Exact actions, inputs, outputs and errors |
| [SES classic API reference](https://docs.aws.amazon.com/ses/latest/APIReference/Welcome.html) | Legacy surface, receiving and capabilities absent from v2 |
| [SES developer guide](https://docs.aws.amazon.com/ses/latest/dg/Welcome.html) | Operational behavior and feature setup |
| [SES v2 service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html) | IAM action/resource/condition mappings—do not infer from API operation names |
| [AWS SDK for JavaScript v3 SESv2](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sesv2/) | TypeScript client/command reference |
| [Boto3 SESv2](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/sesv2.html) | Independent service shape/operation cross-check |
| [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html) | Public limits; customer quotas still need account reads |
| [SES pricing](https://aws.amazon.com/ses/pricing/) | Current plans, add-ons and caveats |

## Refresh before building

1. Recheck the current SDK release/model and the operations required by the first API slice, especially newer members and IAM action mappings.
2. Recheck official pricing, region/partition availability, quotas and service lifecycle notices; rolling documentation and prices can change.
3. Obtain an explicitly authorized test connection and determine the actual account-region readiness without mutating it.
4. Resolve the connection model, consent authority, event transport and hosting/data-residency choices from the decision document.
5. Run the scoped acceptance matrix and record observed evidence; simulator success alone is not full production readiness.

No AWS credentials, customer mail, private screenshots, account exports, executable implementation, dependencies or new test files are part of this hub.
