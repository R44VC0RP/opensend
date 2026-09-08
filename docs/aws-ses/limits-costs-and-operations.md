# Limits, costs and operational safeguards

[Hub](README.md) · Researched 2026-09-08 · Numbers are a dated documentation snapshot, not a customer quota or price quote.

## Quotas to model explicitly

SES quotas are scoped to AWS account and region. The daily quota is a **rolling 24-hour recipient count**, not a midnight-reset message or API-call count. To/Cc/Bcc recipients all consume quota. Customer production quotas vary; obtain `GetAccount.SendQuota` rather than substituting a public default. [L1][L2]

| Limit | Current documented value | Consequence |
| --- | --- | --- |
| Sandbox daily / rate | 200 recipients per rolling 24 hours / 1 recipient per second | Restricted test environment; production access is regional |
| Production daily / rate | Customer-specific | Cache with timestamps, refresh, and handle live throttling |
| SES v2 / SMTP message size | 40 MB including attachments, after encoding | Raw attachment byte size is not final message size |
| Classic SES v1 message size | 10 MB after encoding | API v1 and SDK language versions are different concepts |
| Recipients per message | 50 total To/Cc/Bcc | Prefer one recipient for marketing/privacy/VDM |
| MIME parts | 500 | Validate raw multipart structure |
| Stored templates | 20,000 per region; 500 KB each | Count and size checks; immutable versions consume resources |
| Verified identities | 10,000 per region | Not one unrestricted identity per end user |
| Configuration sets | 10,000 | Plan allocation rather than one per campaign forever |
| Configuration-set name | 64 alphanumeric, hyphen/underscore | Validate instead of silently rewriting identifiers |
| Event destinations per configuration set | 10 | Reuse and preserve customer-owned destinations |
| CloudWatch dimensions per destination | 10 | Avoid high-cardinality recipient/message dimensions |
| Dedicated IP pools | 50 inclusive of managed and standard | Optional feature, not needed for basic sending |
| Tenants | 10,000 default | Adjustable; tenant guide describes qualifying increases |
| Concurrent import/export jobs | 20 each | Separate asynchronous job schedulers |

Source: [L1]. Bulk request limits and content-specific caveats belong in [sending and templates](sending-and-templates.md); never confuse 50 recipients per message with a blanket license to exceed the total request/account send rate.

For messages larger than 10 MB, SES documents bandwidth throttling potentially as low as **40 MB/s**, depending on send rate. A high recipient-per-second quota does not guarantee that throughput for large attachments. Recipient servers can impose smaller limits than SES. [L1][L2]

### API throttling: known documentation ambiguity

The general SES quota page says all actions except `SendEmail`, `SendRawEmail`, `SendTemplatedEmail` are throttled at one request per second. That prose mixes classic operation names with a broader service that includes v2 bulk and analytics APIs. It is not sufficient to infer every v2 endpoint's concurrency or bulk throughput. Keep the statement as a source constraint, not a fabricated measured rate. Check per-operation docs and target-account behavior before tuning. [L1]

**Recommended:** independent control-plane limiters, recipient-aware send limiters per account-region, conservative startup, jittered backoff, and bounded fair queues. Reserve transactional capacity so a marketing campaign cannot starve password resets. Treat throttling as a live condition, not a fatal credential error. Never send in another region merely to evade a safety pause or suppression.

## A quota counter is not a billing counter

Simulator mail does not consume daily quota or affect bounce/complaint reputation, but is limited by the sending rate and is billable. Account/tenant-suppressed sends consume daily quota. Auto Validation-suppressed sends can still incur sending charges. VDM excludes several categories. Do not derive billing from a single delivery event count. [L3][L4][L5]

**Recommended persisted dimensions:** AWS account, region, connection, optional tenant, selected pricing plan and effective time, endpoint route, attempted recipients, provider-accepted attempts, known outcomes, attachment/message bytes, validation usage and add-on state. Label app cost displays as estimates unless reconciled against AWS billing data.

## Important 2026 pricing change

AWS's live pricing page now lists **Essentials, Pro, Enterprise and à-la-carte**. It says new SES accounts and account-region combinations without metered SES activity since **June 1, 2025** start on **Essentials beginning July 21, 2026**, and may switch to à-la-carte. Do not promise every customer `$0.10 per 1,000 emails`. [L3]

### Plans (USD public snapshot)

| Monthly marginal volume tier | Essentials | Pro | Enterprise |
| --- | --- | --- | --- |
| 0–10M | $0.16 / 1,000 | $0.22 / 1,000 | $0.23 / 1,000 |
| 10–100M | $0.14 / 1,000 | $0.17 / 1,000 | $0.18 / 1,000 |
| Above 100M | $0.11 / 1,000 | $0.12 / 1,000 | $0.13 / 1,000 |
| Fixed per account-region-month | None listed | $105 | $500 |

Tiers are **marginal**, not a discount applied retroactively to all volume. Outbound sending and Mail Manager inbound processing have independent volume tiers. AWS says outbound charging is per recipient. Attachment data and other AWS services can add charges. [L3]

All three plans include SES deliverability/VDM in their pricing, but **choosing a plan does not automatically enable any feature**. Features must be enabled individually. Pro/Enterprise include additional capabilities subject to allowances; do not infer unlimited validation, monitored domains, tenants or inbox-placement tests from a checkmark. The current comparison table's footnote numbering is awkward (for example the managed-IP/global-deliverability rows): verify exact entitlement in the customer account or with AWS before calculating a bundle. [L3][L6]

### Read and change a regional plan

`GetAccount.PricingAttributes` exposes `CurrentPlan` and `NextPlan`, with modeled values `NONE`, `ESSENTIALS`, `PRO`, `ENTERPRISE`. The guide describes no plan as à-la-carte, consistent with `NONE`; do not treat a missing pricing attribute as proof of `NONE`. `NextPlan` indicates a scheduled change and is documented as empty when none is scheduled. [L6][L7]

`PutAccountPricingAttributes` takes required `Plan` using those enum values and returns an empty HTTP 200 response. It is a **billing-changing write**, not a readiness probe. The API documents 400 bad request, 429 throttling and 409 conflict; the conflict prose refers to an ongoing account-details review, so preserve the actual error instead of inventing a plan-lock meaning. There is no quote, dry run, idempotency token or effective-date timestamp in this request/response shape. [L7]

Plans apply per account-region. Upgrades take effect immediately. For customers implicitly defaulted to Essentials, the first downgrade/cancellation to à-la-carte is also immediate; other downgrades/cancellations take effect at the next billing cycle. Re-read `CurrentPlan` and `NextPlan` after an approved change and retain the observation time. Never call the write automatically to standardize customer pricing. [L6]

### Selected à-la-carte charges

| Capability | Public price shown | Qualification |
| --- | --- | --- |
| Outbound sending | $0.10 / 1,000 recipients | Not universal across plans |
| Attachment data | $0.12 / GB | Extra to sending; validate billing byte interpretation |
| Global Endpoints | $0.03 / 1,000 emails | Added when sending through multi-region endpoint ID |
| On-demand Email Validation | $0.01 / address validation | Not $0.01 per thousand |
| Auto Validation | $0.01 / 1,000 validations | Sending fees still apply when validation suppresses |
| Tenants | $0.005 / tenant-month + $0.005 / 1,000 emails | Regional/account model and plan allowances matter |
| Standard dedicated IP | $24.95 / IP-month | Not required for ordinary SES sending |
| Managed dedicated IP | $15 / account-month + tiered sending fee | First tier $0.08 / 1,000 in AWS worked example; table has a `1,1000` typo—verify before implementing a calculator |
| VDM SES deliverability | $0.07 / 1,000 at 0–10M; lower later tiers | Query fee $0.0005 / 1,000, first 5,000 queries/month free, as listed |
| VDM global deliverability | $1,250 / account-region-month | Includes specified domain/IP/test allowances; overages extra |
| Archiving | $2 / GB ingested; $0.19 / GB-month stored/searched | Optional content retention, separate from event history |

Source: [L3]. Do not enable any paid add-on as an invisible connection-validation step. The SDK's ability to call a feature does not mean the customer has chosen to pay for it.

Free-tier rules are also evolving: the current pricing page describes up to $200 AWS credits for new customers, a 6-month free plan and 12-month credit expiry. Do not reuse old SES “62,000 EC2 sends” or “3,000 messages” promotions as a current universal entitlement. Check the customer's actual account program. [L3]

### Other cost buckets

Budget SNS/SQS/EventBridge/Firehose, CloudWatch custom metrics/alarms/logs, S3 imports/exports/archives, KMS, queue/database/worker compute, data transfer, and billing-query access separately. Keep one-time provisioning permissions apart from routine send permissions. CloudWatch recipient-level dimensions can turn a low-cost transport into an expensive analytics system. [L3]

## Simulator and verification caveats

| Address | Expected scenario |
| --- | --- |
| `success@simulator.amazonses.com` | Recipient server acceptance / delivery event |
| `bounce@simulator.amazonses.com` | Hard bounce (`550 5.1.1`), not actually inserted into the suppression list |
| `complaint@simulator.amazonses.com` | Complaint feedback |
| `suppressionlist@simulator.amazonses.com` | Global-suppression-like bounce, not proof of tenant/account suppression behavior |
| `ooto@simulator.amazonses.com` | Out-of-office response to return path/envelope sender |

Simulator is usable in sandbox; charges and rate limit apply, daily quota/reputation/VDM metric effects do not. Address labeling (`bounce+label@...`) helps correlation. A multi-recipient bounce can produce a combined notification. There is no simulator address for a Reject event; AWS documents an EICAR procedure, but this research did not execute it or create such an attachment. Do not use real malware. [L4]

A simulator-only pass cannot prove real inbox placement, single-recipient VDM coverage, all recipient-provider quirks, DKIM/DMARC alignment or marketing unsubscribe behavior. The future integration needs a small explicitly authorized real-recipient check as well.

## Operational policy proposals

### Queues and retries

- Immutable per-recipient jobs with a unique OpenSend request key; separate campaign job ID, application message ID, provider message ID and provider attempt ID.
- Retry known transient failures within a time budget. Do not replay successful bulk entries. A timeout after dispatch is an **ambiguous outcome**, not proof the provider rejected the send.
- Standard SES send requests do not provide an application idempotency token guaranteeing exactly-once delivery. See the sending reference for SDK retry implications.
- Time-critical transactional mail needs an expiry time; stop retrying an expired OTP/password-reset message. Marketing jobs need campaign cancellation/expiry and fresh consent checks.
- Reserve capacity and implement per-customer fairness. Persist pause reasons for quota, credentials, identity, configuration, tenant and AWS safety enforcement separately.

### Configuration safety

- Store discovered account-region readiness with timestamps, permission gaps and ownership. Do not assume a 403 means “feature absent.”
- Cache SDK clients by credential provider + account + region + endpoint strategy; never leak one customer's default credential chain into another customer's request.
- Version template/configuration references and avoid deleting resources used by queued sends. Drift detection is read-only unless the customer authorizes repair.
- Identity/tenant/config-set/resource deletion and suppression removal are destructive administrative actions, not connection-health repair.
- Alarm on provider throttling, ingestion lag/dead letters, elevated bounces/complaints, tenant/account pauses and credential expiration. Do not auto-resume enforcement without resolving its cause.

### Data lifecycle

Recipient addresses, bodies, subject lines, template data, tracking URLs and failure reports are personal or sensitive data. Set explicit retention and encryption; use opaque nonsecret tags for correlation. Separately document AWS-region processing, event storage, application data residency and cross-region failover. A regional send endpoint does not alone establish a full data-residency guarantee.

## Sources

All inspected on 2026-09-08.

- [L1] [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html)
- [L2] [Managing sending limits](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/manage-sending-quotas.html)
- [L3] [SES pricing](https://aws.amazon.com/ses/pricing/)
- [L4] [SES mailbox simulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html)
- [L5] [Account suppression](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html) and [tenant suppression](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list-tenant-level.html)
- [L6] [Pricing plans, feature activation and change timing](https://docs.aws.amazon.com/ses/latest/dg/pricing-plans.html)
- [L7] [GetAccount](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html), [PricingAttributes](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PricingAttributes.html), [PutAccountPricingAttributes](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PutAccountPricingAttributes.html)
