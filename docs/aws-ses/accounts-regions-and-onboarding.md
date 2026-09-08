# Accounts, Regions, and sender onboarding

[Hub](README.md)

Research date: **2026-09-08**. This document describes AWS SES facts and a proposed OpenSend onboarding model; it does not describe a completed AWS integration.
See [credentials and IAM](credentials-and-iam.md) for trust, credentials, scoped policies, and security controls.

**Verified facts** are supported by official AWS sources cited inline. **Recommended design** is an OpenSend proposal. **Unverified constraints** are release gates, not claims of functionality. Context7 and live official AWS references were consulted; no customer AWS account was connected, changed, or sent mail during this research.

## 1. Choose whose AWS account sends the mail

| Model | AWS principal used for SES | Quota, billing, and reputation boundary | Recommended OpenSend treatment |
| --- | --- | --- | --- |
| Platform-owned SES account | OpenSend's execution role | Platform account/Region | Managed sending product; OpenSend owns abuse prevention, production approval, spend, and account risk |
| Customer-owned SES account through AssumeRole | Assumed role in customer account | Customer account/Region | Preferred bring-your-own-SES connection; isolate queues, credentials, resources, and feedback by customer connection |
| Customer-owned SES account through IAM user keys | Dedicated customer IAM user | Customer account/Region | Explicit fallback, with additional secret-storage/rotation risk |
| Platform sends using customer's SES identity authorization | Platform delegate principal plus customer's identity ARN | Delegate/platform account quotas, billing, and bounce/complaint reputation; identity remains owned by customer | Separate advanced delegation mode, not a synonym for AssumeRole |

AWS sending authorization attributes quotas, billing, and bounce/complaint events to the **delegate sender**. The identity owner attaches the sending authorization policy; the delegate uses their own account credentials. The delegate must send in the Region where the owner's identity is verified, with the policy attached to that regional identity. [A1]

**Recommended design:** make the account model explicit at connection creation and immutable without a migration. Do not silently fall back from an unavailable customer account to a platform account: that changes billing, reputation, permission, consent, and potentially residency boundaries.

### Connection identity and isolation

Use a logical key resembling `(workspace_id, connection_id, partition, aws_account_id, region)`. The role is not regional, but SES resources and state generally are. Store the verified STS account/principal, permitted Regions, credential reference, capability grants, and each Region's last successful observation separately. [A2, A3]

Recommended associated records:

- **Regional account state:** production/sandbox status, sending enabled, enforcement status, quota/rate snapshot, observation time, last error, and available features.
- **Regional resources:** identity ARN and verification/DKIM/MAIL FROM state, configuration-set names/ARNs and event destinations, templates, contact lists, and optional SES tenant ARN.
- **Runtime boundaries:** rate limiter and outstanding recipient reservations, transactional/marketing queues, idempotency scope, suppression/consent policy, and circuit-breaker state per account/Region.
- **Feedback routing:** authenticated event source, actual sending account/Region, configuration set, optional tenant, SES message ID, and OpenSend message/campaign correlation.
- **Audit metadata:** who connected or changed a capability, the approved policy version, connection suspension reason, and credential refresh/revocation status; never full credentials or private message content.

Resources with the same name in two accounts or Regions are different resources. An STS success must not mark all Regions ready; a successful send in one Region must not mark another production-enabled. Avoid caches keyed only by domain or configuration-set name. [A2, A3]

## 2. Readiness is a state machine, not a green “connected” badge

**Verified facts.** `GetAccount` reports the SES account in the **current AWS Region**. Important fields include `ProductionAccessEnabled`, `SendingEnabled`, `EnforcementStatus`, `SendQuota`, suppression preferences, optional feature settings, and `PricingAttributes.CurrentPlan/NextPlan`. Read current and scheduled pricing plans without changing them; choosing a plan does not itself enable its features. See [pricing and change timing](limits-costs-and-operations.md). `GetEmailIdentity` provides per-identity readiness/authentication settings. [A3, A4]

| Check | What success establishes | What it does not establish |
| --- | --- | --- |
| AssumeRole / credential validation | Credentials can be obtained | SES permissions or production access |
| STS `GetCallerIdentity` | Actual caller account and principal | Authority over a claimed domain |
| SES `GetAccount` | Read permission and regional account state | Sender identity verified, send permission, or event delivery |
| Identity verification and DKIM success | SES recognizes the regional identity/authentication configuration | DMARC alignment for every message or recipient inbox placement |
| Configuration-set/event inspection | Intended telemetry configuration exists | Successful event ingestion; an end-to-end feedback check is still required |
| Authorized controlled test send | That specific send was accepted | Delivery, inbox placement, permission for other send modes, or future availability |

**Recommended design:** expose distinct states such as `credentials_invalid`, `permission_missing`, `sandbox`, `identity_pending`, `sending_paused`, `feedback_incomplete`, and `ready`. Show time and Region for observations. Do not convert every AWS 403 into “bad API key,” or every sending failure into a quota error.

### Sandbox and production access

New SES accounts start in the sandbox **per Region**. In the sandbox, sending is limited to verified recipients/domains or the SES mailbox simulator, with a default 200 recipients per rolling 24 hours and 1 recipient per second. Account-level suppression bulk/API management is disabled in sandbox. After production access, recipients no longer need verification, but sending identities still do. Quotas remain finite and use-case-specific unless AWS explicitly reports otherwise. [A5, A6]

A production request requires the customer to describe their use case, website, and whether most mail is marketing or transactional. It is not a switch OpenSend can guarantee will be approved. `PutAccountDetails` is a separate administrative permission and workflow, not a requirement for reading an existing connection. AWS can request additional information. Domain verification and truthful consent/feedback handling should precede the request. [A5]

**Recommended design:** allow setup and simulator-based checks while sandboxed; block real marketing campaigns. Display the exact Region requiring approval. A customer's existing approval in another Region is not sufficient. Never imply that paying OpenSend automatically removes SES sandbox restrictions.

### Sending quota versus monitoring

`GetAccount.SendQuota` contains `Max24HourSend`, `MaxSendRate`, and `SentLast24Hours`. The API defines `Max24HourSend = -1` as unlimited; do not display a negative remaining allowance or divide by it. These are regional account sending capabilities/counters, not delivery analytics, billing totals, recipient engagement, or a durable message ledger. [A3, A7]

Quotas count **recipients**, not API calls: To, Cc, and Bcc recipients all matter. The 24-hour quota is a rolling window, not a reset at local midnight. AWS can accept short rate bursts, but the advertised sending rate is not a promise of sustained application throughput. Other applications using the same SES account share its quota. [A6, A8]

**Recommended design:** compute a labeled snapshot estimate, maintain a central recipient-based rate limiter for each account/Region, and reserve headroom for transactional traffic. Refresh counters, but rely on AWS quota/throttling errors as authoritative. Keep usage history and send outcomes in OpenSend; use SES event publishing and optional CloudWatch/VDM metrics for monitoring. Never treat `SentLast24Hours` as an exact synchronous concurrency counter.

`SendingEnabled = false`, account enforcement, configuration-set sending disablement, and tenant pause are distinct blockers. Increasing IAM permissions or quota cannot fix a reputation suspension. Do not automatically re-enable sending after AWS or a customer paused it; surface the reason and require the appropriate remediation/approval. [A3, A9, A10]

## 3. Domain and DNS onboarding

### Verified identities are regional

SES identities can be domains or individual email addresses. Domain verification supports sending from addresses/subdomains under the domain, while advanced settings or overrides can require explicit child identities. Verify the exact identity used for the intended flow and inspect more-specific identities rather than assuming inherited configuration always wins. Every sending Region needs the appropriate identity; DNS records are public and global, but SES verification state is not. [A2, A4]

**Recommended default:** customer-controlled sending domain/subdomain plus Easy DKIM. Prefer a dedicated sending subdomain when the customer wants operational separation, while recognizing it does not guarantee independent mailbox-provider reputation. Domain verification is not recipient consent, trademark ownership, or authorization for another OpenSend workspace to use the domain.

### Recommended bounded onboarding sequence

1. **Register the intended domain and account/Region.** Confirm customer authorization; normalize the domain carefully and retain exact SES identity/ARN. Never auto-adopt a domain just because another workspace already verified it.
2. **Create or select the identity with the requested capability.** Read existing state first. Do not switch an existing identity from BYODKIM to Easy DKIM or change its defaults without approval.
3. **Present the exact DNS records returned or prescribed by SES.** Show record type, fully qualified name, value, Region, and purpose; provide copy/export. Customer publishes them, or explicitly authorizes a narrowly scoped DNS integration.
4. **Observe DNS and SES independently.** Verify public DNS resolution and poll SES status with backoff. DNS visibility is diagnostic; SES verification/DKIM state is the sending gate. Allow for AWS's documented propagation/verification window of up to 72 hours.
5. **Complete authentication and feedback checks.** Inspect DKIM, custom MAIL FROM if requested, DMARC policy/alignment, configuration-set selection, and event route before approving production campaigns.

The creation API is not permission to edit DNS. Route 53 requires separate permissions; external DNS requires a separate integration or customer action. Preserve existing records and show a diff before replacement. Do not change the domain's inbound-mail MX records to onboard outbound SES. [A4, A11]

### DKIM choices

| Mode | Verified AWS behavior | OpenSend recommendation / constraint |
| --- | --- | --- |
| Easy DKIM | SES manages signing keys and gives DNS CNAME records; the usual setup publishes three records | Default for new onboarding; use exact returned hosted-zone targets rather than hardcoding `dkim.amazonses.com` |
| BYODKIM | Customer supplies private signing key/selector; publishes public key in DNS; SES signs | Advanced opt-in. Handle private key as a secret and preserve existing configuration; not a prerequisite for OpenSend |
| Deterministic Easy DKIM (DEED) | Replica identity inherits Easy DKIM configuration from same-named parent in another Region and reuses parent's DNS records | Optional multi-region setup; still create/observe each regional identity and get replication permission |

DEED requires an Easy DKIM parent, not BYODKIM or a manually signed parent. A replica cannot itself be a parent. Parent key rotations/length changes propagate; the parent cannot be deleted while replicas remain. DEED does **not** automatically confer production approval or mirror every identity/configuration setting. Required permissions include replica creation and `ses:ReplicateEmailIdentityDKIMSigningKey` on the parent with an approved `ses:ReplicaRegion` scope. [A12, A13]

The creation guide now explicitly says the DKIM hosted-zone suffix can vary by Region and identity and can be retrieved from the API response. Do not generate CNAME values from tokens using one universal suffix. Preserve every record exactly, accounting for DNS providers that automatically append the zone name. [A4]

### MAIL FROM, SPF, and DMARC are different checks

**Verified facts.** SES's default envelope MAIL FROM uses a subdomain of `amazonses.com`; SPF passes for that envelope domain. This does not mean SPF aligns with the visible customer From domain. A custom MAIL FROM uses an eligible subdomain and requires the SES-provided MX plus an SPF TXT record. Its MX is for SES feedback handling, not for moving the customer's inbox. [A11, A14]

For commercial `us-east-1`, AWS's documented pattern resembles MX preference `10` to `feedback-smtp.us-east-1.amazonses.com`, and TXT `v=spf1 include:amazonses.com ~all`, **on the selected MAIL FROM subdomain**. These are illustrative, not universal generated records: use current regional instructions and actual identity output. SES requires exactly one MX for the custom MAIL FROM domain; choose a dedicated subdomain rather than conflicting with normal inbound mail. [A11]

MAIL FROM failure behavior is explicit: `USE_DEFAULT_VALUE` falls back to the SES domain, while `REJECT_MESSAGE` rejects when SES cannot use the custom MAIL FROM configuration. Track `MailFromDomainStatus` separately from identity and DKIM verification. Fallback can change SPF alignment even when sending continues. [A4, A11]

DMARC requires a passing **aligned** SPF or DKIM result; both mechanisms are desirable, but both are not required for DMARC pass. The visible From domain must align with the authenticated domain according to relaxed/strict policy. Custom MAIL FROM commonly relies on relaxed SPF alignment; strict alignment and subdomain DKIM inheritance need deliberate review. Do not tell a customer to weaken an existing DMARC policy just to make onboarding green; prefer correct aligned DKIM or an approved domain configuration. [A15]

**Recommended design:** distinguish “record detected,” “SES verified,” “DKIM signing enabled,” “MAIL FROM successful,” and “DMARC alignment checked.” A DMARC TXT record alone is not proof that a particular message passes DMARC. Use an authorized delivered-message authentication-header check before making that claim. Do not overwrite an existing SPF TXT record with a second independent SPF policy or replace a DMARC policy automatically.

### DNS delegation option

Customer-managed record publication is the lowest-privilege default. If offering delegated DNS, use a dedicated customer-approved subdomain/zone and a separate credential boundary with explicit record permissions and a revocation plan. Delegating a zone grants control of names beneath it and is broader than adding three DKIM CNAMEs; explain the distinction. Do not represent a CNAME record as an IAM role or an identity sending-authorization policy.

DNS removal, delegation withdrawal, or key rotation can break future authentication without invalidating OpenSend login sessions. Recheck SES state and alert on regressions; do not quietly restore customer-removed records.

## 4. Feedback is an onboarding requirement

SES event publishing associates an event destination with a configuration set; sends must select that set or inherit an appropriate identity default. Supported publishing paths include CloudWatch, Data Firehose, SNS, and EventBridge, with additional product-specific integrations described in AWS's current guide. A successful send response means acceptance, not final delivery or inbox placement. [A16]

**Recommended design:** separate configuration sets for transactional and marketing streams; attach events for deliveries, bounces, complaints, rejects, rendering failures, and other explicitly used analytics. Route feedback to a verified durable ingestion path, deduplicate events, and process suppression before future sends. Open/click tracking is optional and not proof a human read the message.

Keep feedback authorization separate from SES sending: SNS topic policies, queue subscriptions/policies, Firehose service roles, customer-managed encryption, and cross-account routes each need their own narrow grants. Do not disable feedback forwarding until a replacement has been deliberately configured and verified. Request a controlled simulator/end-to-end feedback check with authorization; a configuration screenshot is insufficient evidence.

For identity delegation, the current guide no longer supports creating new legacy cross-account notifications. Use configuration-set event publishing or the currently supported identity/SNS approach; do not build onboarding around classic cross-account notification creation. [A17]

## 5. Multi-region and SES tenants

### Global endpoints are an explicit advanced connection mode

AWS SES Global endpoints distribute outbound traffic across **two Regions**, normally splitting traffic and shifting away from impairment. API requests carry an `EndpointId`; both current v2 `SendEmail` and `SendBulkEmail` references include this parameter. Treat a Global endpoint as an additional routing resource, not as a global replacement for every regional SES resource. [A18, A19]

The guide's overview says setup synchronizes key artifacts and limits, but its detailed instructions require preparing the secondary Region and maintaining consistency. The console's duplication helpers are not a promise of permanent replication of all resources. In particular, identity MAIL FROM attributes, policies, feedback forwarding/notifications require manual secondary-region configuration; templates, configuration sets/destinations, production approval, and sending limits must be checked. Changes must continue to be synchronized. [A18]

**Recommended design:** initially expose ordinary regional connections. Enable Global endpoints only after both Regions independently pass readiness checks, endpoint/service-linked-role prerequisites are satisfied, IAM allows intended resources, and feedback records the actual processing Region. Each Region needs capacity for the full failover volume, not just its normal half. Obtain customer approval for both Regions and any additional charges/data-processing implications.

Do not infer API/SMTP/receiving/feature parity from the presence of a Region in the SES service list. The AWS General Reference publishes separate endpoint tables; as researched, several SES API Regions do not offer SMTP endpoints. GovCloud, China, newly launched Regions, opt-in Regions, and advanced features require explicit compatibility review. Keep a dated capability matrix rather than a hardcoded “all AWS Regions supported” claim. [A2, A20]

### SES tenant resources are not AWS accounts

AWS SES tenants are regional, flat resources inside one AWS account; they cannot span accounts and are not automatically replicated across Regions. They group associated identities, configuration sets, and templates and provide tenant reputation visibility and targeted sending enforcement. An SES tenant is not the same thing as an OpenSend workspace, an IAM role, or a separate account quota/billing boundary. [A10]

A tenant send must specify a configuration set associated with that tenant, or use an identity whose default configuration set is associated with it. Manage resource associations explicitly and inspect defaults. The full tenant ARN format in the current SAR is `arn:aws:ses:REGION:ACCOUNT:tenant/TENANT_NAME/TENANT_ID`; do not fabricate it from the name alone. `ses:TenantName` can constrain sending; tenant ARNs scope tenant administration, not the send action's identity resource. [A10, A21]

**New behavior to preserve:** by default, tenants share the account suppression list, but the current guide supports **tenant-level suppression** with `SuppressionScope = TENANT` and selected suppressed reasons. Do not document shared suppression as an unavoidable limitation. Configuration-set suppression settings take precedence over tenant settings, then account defaults; configuration sets can override scope and reasons independently. With effective `TENANT` scope, SES checks only the tenant list and **skips the account suppression list**. Inspect effective scope and retain application-level consent/unsubscribe controls rather than assuming account suppression still protects every send. [A10, A22]

Setting tenant suppression attributes requires scope and reasons together, or both null to return to the default. Deleting a tenant also deletes its suppression entries. These are safety-significant changes requiring explicit approval, not cleanup side effects. [A22]

Default tenant count in the current guide is 10,000 per account, with quota-increase paths; this is not a hard product promise. Standard/Strict/None reputation policies affect automatic tenant pausing, and EventBridge exposes tenant status/reputation events. Tenants reduce some blast radius but do not justify claiming absolute isolation from account-level limits or AWS enforcement. [A10]

**Recommended design:** store optional SES tenant identifiers on each regional connection and deliberately map them to OpenSend workspaces/streams. Do not enable tenants, change reputation policy, switch suppression scope, or re-enable a paused tenant as a side effect of sending. Multi-region tenants require separate provisioning and monitoring per Region.

## 6. Cross-account identity ARN constraints

For v2 delegate sends, `FromEmailAddressIdentityArn` identifies the owner's authorized identity; `FeedbackForwardingEmailAddressIdentityArn` applies when that feedback address uses delegated authorization. These are not credentials and do not change the caller account returned by STS. The From/feedback addresses still must be covered by the owner's policy, and the send must use the identity's Region. For Raw content, the v2 From identity ARN overrides the legacy `X-SES-SOURCE-ARN` and `X-SES-FROM-ARN` headers. [A1, A19]

**Recommended design:** register and allow-list identity ARNs on the server. Do not accept arbitrary cross-account identity ARNs, configuration sets, templates, endpoint IDs, or tenant names from an untrusted API request. Having authorization to use an identity does not imply cross-account permission to edit it or to use every other resource in its account. Do not infer cross-account template sharing merely from the presence of a `TemplateArn` field.

Production-access wording differs between the overview (delegate must be out of sandbox) and sandbox guide (neither owner nor delegate can send to unverified recipients while sandbox restrictions apply). Onboard conservatively: inspect/document the owner and delegate regional sandbox state and perform an authorized real delegation check before promising production readiness. [A1, A5]

## Verification status and remaining release gates

No live account, DNS zone, IAM role, production request, sending API, or feedback route was exercised. Verified here means documented by the cited sources, not observed in a customer account. Policies and lifecycle choices are recommendations until implemented and tested with explicit authorization.

Before a supported-region claim, verify the exact partition/Region's API and feature availability, quotas, STS activation, Global endpoint pairing, DEED behavior, and tenant-suppression rollout. Before a ready-to-send claim, verify actual identity defaults, policy permissions, controlled send mode, feedback ingestion, and negative authorization cases. Cross-account bulk templates and inline-template IAM resource evaluation remain specific source/behavior gaps; do not work around them with unbounded IAM grants.

## Sources

Official sources consulted on the research date; mutable AWS pages can change after this reference is written.

- **A1:** [Sending authorization overview: Region, quota, reputation, and billing attribution](https://docs.aws.amazon.com/ses/latest/dg/sending-authorization-overview.html).
- **A2:** [Regions and SES](https://docs.aws.amazon.com/ses/latest/dg/regions.html).
- **A3:** [SES v2 GetAccount](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html).
- **A4:** [Creating and verifying identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html); [GetEmailIdentity](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetEmailIdentity.html).
- **A5:** [Production access and sandbox restrictions](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
- **A6:** [SES service quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html).
- **A7:** [SendQuota fields and unlimited sentinel](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendQuota.html).
- **A8:** [Sending limits and recipient-based accounting](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html).
- **A9:** [PutConfigurationSetSendingOptions](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PutConfigurationSetSendingOptions.html).
- **A10:** [Tenants: scope, associations, reputation, suppression, and limits](https://docs.aws.amazon.com/ses/latest/dg/tenants.html).
- **A11:** [Custom MAIL FROM domain](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html).
- **A12:** [DKIM mechanisms and inheritance](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim.html).
- **A13:** [DEED](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-deed.html).
- **A14:** [SPF in SES](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-spf.html).
- **A15:** [DMARC alignment](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html).
- **A16:** [SES event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html).
- **A17:** [Sending authorization and legacy notification changes](https://docs.aws.amazon.com/ses/latest/dg/sending-authorization.html).
- **A18:** [Global endpoints, prerequisites, and secondary-region preparation](https://docs.aws.amazon.com/ses/latest/dg/global-endpoints.html).
- **A19:** [SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html); [SendBulkEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendBulkEmail.html).
- **A20:** [SES API, SMTP, and receiving endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html).
- **A21:** [SES v2 service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html).
- **A22:** [Tenant-level suppression lists](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list-tenant-level.html).
