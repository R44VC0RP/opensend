# Marketing, consent and suppression

[Hub](README.md) · Researched 2026-09-08 · AWS facts below are sourced; OpenSend recommendations are design proposals, not implemented behavior.

## SES is transport plus some list management—not a campaign platform

SES provides contact lists, topics, contact preferences, list imports and managed subscription handling. It does not turn a contact list into a scheduled campaign by itself. `ListContacts` can retrieve topic subscribers; the application submits send requests. [M1]

**OpenSend should own:** campaign scheduling, immutable audience snapshots, per-recipient jobs, template versions, consent evidence, segmentation, deduplication, pause/cancel, suppression across connected regions, campaign attribution and customer webhooks. Those are proposed responsibilities, not additional AWS API capabilities.

Keep marketing permission separate from delivery safety. Unsubscribing from product news must not necessarily suppress a requested password reset; a hard bounce may justify blocking both. Deleting an SES suppression entry does not confer marketing consent.

## Critical API tradeoff: bulk versus SES-managed unsubscribe

`SendEmail` exposes `ListManagementOptions` (`ContactListName`, optional `TopicName`). The current `SendBulkEmail` request shape does **not** expose that field. Do not promise that the automatic SES contact-list unsubscribe behavior works in bulk merely because both calls accept templates. [M2][M3]

| Approach | Benefit | Responsibility / limitation |
| --- | --- | --- |
| One recipient per `SendEmail` + `ListManagementOptions` | SES manages preference page and future topic/list blocking | More individual requests; configure list/topic, DKIM and event handling |
| `SendBulkEmail` + OpenSend-managed consent/unsubscribe | Batching and recipient personalization | OpenSend must create RFC-compliant headers/footer links, process unsubscribe, recheck consent and prevent future sends |
| One recipient per `SendEmail`, all consent owned by OpenSend | Consistent custom preference model across providers/regions | OpenSend handles the same consent responsibilities without SES list management |

**Recommendation:** explicitly select one consent authority per sending workflow. Avoid a silently divergent SES list plus OpenSend list. If syncing both, define conflict resolution with opt-out winning, authenticated re-subscription, periodic reconciliation and event replay.

The AWS one-click guide describes compliant custom `List-Unsubscribe` and `List-Unsubscribe-Post` headers as an alternative to managed subscription handling. Validate actual delivered headers/signatures before launch. [M4]

## SES contact and topic model

Operations include `Create/Get/Update/Delete/ListContactList(s)`, `Create/Get/Update/DeleteContact`, `ListContacts`, and `CreateImportJob` + status/list APIs. Names above are grouped shorthand; see the exact [API inventory](api-and-sdk-inventory.md) before coding.

- Topics have defaults `OPT_IN` / `OPT_OUT`; a contact can override topic preferences and has `UnsubscribeAll`.
- `UnsubscribeAll=false` is not proof of explicit consent to every topic. Defaults and individual preferences still matter.
- A list must exist before importing contacts. The developer guide permits up to **1 million contacts per contact-list import job**; this is not the suppression-import limit.
- Imports require S3 input and service access, are asynchronous, and can fail per record. Preserve a job record and failure report; do not mark all rows imported when the API accepts the job.
- Creating or updating a contact record does not establish legal proof of permission. Store provenance separately.

AWS behavior and examples: [M1]. Do not infer an undocumented unlimited total number of contact lists/topics/contacts from a missing constraint in the API model; verify service limits for the target region before imposing or advertising a ceiling.

## Managed subscription details that affect rendering

AWS's current guide says: [M2]

- Specify `ListManagementOptions` on `SendEmail` (or the documented SMTP list-management header).
- Include `{{amazonSESUnsubscribeUrl}}` in HTML/text where footer links belong. At most the first **two** occurrences are replaced; other content types are not supported for placeholder substitution.
- SES adds list-unsubscribe headers/footer links only for **single-recipient** messages. Do not send a whole list via To/Cc/Bcc.
- With both list and topic, the header unsubscribe applies to that topic; without a topic it unsubscribes from all topics in the list. Footer links take the recipient to a preferences page.
- SES-managed subscription is documented for **Easy DKIM**. It cannot add links for messages the sender has already signed before submitting to SES. Do not extend this statement to every DKIM variant without a focused check.

SES overrides existing `List-Unsubscribe` / `List-Unsubscribe-Post` headers when its managed subscription handling is used. Omitting `ListManagementOptions` for a transactional message bypasses this subscription feature—it is not a general bypass of delivery suppression. AWS issues a bounce event if sending to an unsubscribed contact with list management, so do not assume an immediate API validation error. [M1][M2]

**Recommended implementation details:** preview reserved SES placeholders without consuming them in OpenSend's renderer; send one recipient; distinguish template render errors from missing consent; recheck consent immediately before dispatch, including after retries and queue delays.

## Suppression has multiple scopes

| Mechanism | Owner and scope | What it is not |
| --- | --- | --- |
| Global suppression | SES-managed shared protection | Not customer-queryable/editable; no global-list removal API |
| Account suppression | Customer AWS account + region | Not automatically global across regions/accounts |
| Tenant suppression | One SES tenant + region | Not enabled merely by creating an OpenSend workspace |
| Configuration-set suppression | Override of effective scope/reasons | Not a separately stored third list of addresses |
| Contact/topic unsubscribe | Marketing preferences in a contact list | Not the account bounce/complaint suppression list |
| Auto Validation | Delivery-likelihood filtering | Not an unsubscribe or proof of consent |
| OpenSend policy | Recommended application-level safety/consent checks | Must not silently weaken provider protections |

Sources: [M5][M6][M7][M8][M9].

### Account suppression

The API supports `PutSuppressedDestination`, `GetSuppressedDestination`, `ListSuppressedDestinations`, `DeleteSuppressedDestination`, and account/configuration-set suppression settings. Reasons are `BOUNCE` and `COMPLAINT`, not an arbitrary marketing reason enum. Only hard bounces are automatically added. The enabled reasons determine checking and recording behavior. [M5]

Account suppression entries preserve case. **Management calls require exact case matching**, even though SES sending treats case variants as the same address. Preserve the AWS-returned spelling for delete/get; keep any normalized application lookup key separately. Do not lowercase the stored provider address and lose the ability to delete it. [M5]

Entries normally remain until removed, but if account sending is paused SES can delete the account list after **90 days**. Account-suppressed sends still consume daily quota but do not count in `Reputation.BounceRate`/`Reputation.ComplaintRate` in the same way as attempted delivery failures; AWS says the Bounce/Complaint metrics can still count them. [M5]

Gmail does not provide individual complaint data to SES, so “no SES complaints” is not proof of a healthy or consensual list. [M5]

### Tenant-level suppression: newer behavior

Current docs and the June 2026 launch introduce `PutTenantSuppressionAttributes`, `CreateTenant.SuppressionAttributes`, configuration-set `SuppressionScope`, and optional `TenantName` on the four suppression-entry CRUD/list operations. Omit `TenantName` and those operations target the **account** list. [M6][M7]

Effective precedence is **configuration set → tenant → account**. Configuration-set scope and reasons can override independently; do not implement this as wholesale replacement of one settings object.

| Effective scope | Send-time check | Automatic recording |
| --- | --- | --- |
| `ACCOUNT` | Account list only, matching enabled reasons | Account list |
| `TENANT` | Tenant list only, matching enabled reasons; **skips account list** | Tenant list; hard bounces also enter SES global suppression |
| Either scope, empty reasons | No suppression-list checking | No suppression-list recording |

Existing and new tenants default to `ACCOUNT`. Tenant settings require scope and reasons together, or both null to clear settings. A tenant-scoped account-list entry does **not** act as a universal block. OpenSend must keep its own safety policy if it promises organization-wide suppression. [M6]

Additional details from [M6]:

- One list per tenant; regional and not shared across AWS accounts.
- `Permanent` / `OnTenantSuppressionList` bounce subtype; VDM reason `ON_TENANT_SUPPRESSION_LIST`; events include `ses:tenant-name`.
- Tenant suppression consumes daily quota; management preserves exact address case.
- Not-spam feedback can remove tenant `COMPLAINT` entries automatically. This is not renewed marketing consent.
- Deleting a tenant also deletes its suppression entries. Never use tenant deletion as a harmless reset.
- Production access is required for manually adding suppression entries; do not expect full sandbox write capability.

**Recommendation:** suppression overrides, empty reasons, removals and scope switches require explicit permissions, an audit reason and confirmation. Do not automatically switch to tenant scope to get around account suppression or retry in another account/region to evade a suppression.

### Global suppression

SES owns the global list; it cannot be queried, populated or disabled by a customer. Current docs describe account suppression as superseding its customer-facing management: if an address is not on the customer's account list, delivery can still be attempted under documented account-list behavior even when the address is globally suppressed. Such a real bounce can affect reputation. Do not promise an API to import/export or remove entries from the global list. [M8]

## Import/export and destructive operations

Account suppression bulk import uses S3 CSV or newline-delimited JSON and `CreateImportJob`. Current documented limits differ by operation: **100,000 additions per S3 object/API call**, **10,000 removals**, **20 concurrent imports**. The contact import limit is separately **1 million**. Do not pass a JSON array when AWS requires NDJSON. Production access, S3 permissions and sometimes KMS access are separate requirements. [M1][M5]

Do not infer that account suppression bulk-import support extends to tenants just because individual operations accept `TenantName`; verify `ImportDestination` and target support against the installed SDK/API model. The parent research did not establish tenant bulk import parity.

OpenSend should snapshot scope, original-case addresses and reason before approved removals; paginate every list endpoint; handle missing/expired cursors and concurrent updates; never run a bulk unsuppress just to improve a send-completion percentage.

## Email Validation: explicitly priced, probabilistic

`GetEmailAddressInsights` performs on-demand validation, including syntax, DNS, mailbox-existence, role-address, disposable-address and random-input assessments. Verdicts are `HIGH`, `MEDIUM`, `LOW`. `HIGH` for `IsValid` is favorable; `HIGH` for `IsDisposable` or `IsRandomInput` is unfavorable. Do not implement one blanket “HIGH = valid” rule. [M9]

Auto Validation can filter at account/configuration-set level using SES-managed/high/medium thresholds through suppression settings. A filtered send can emit `Permanent` / `EmailValidationSuppressed`. Validation does not prove inbox delivery or consent; a strict threshold can suppress legitimate recipients. Enabling it changes sending behavior and can add charges. [M10][M11]

## Consent and safety policy to decide before building

Recommended—not a claim that SES enforces legal compliance:

| Decision | Safe initial direction |
| --- | --- |
| Evidence | Record email, purpose/topic, source, timestamp, policy version and opt-in/opt-out changes; minimize personal data |
| Re-subscription | Explicit verifiable action; imports, retries, contact updates and not-spam events must not silently erase an opt-out |
| Unsubscribe endpoint | RFC 8058 one-click POST, idempotent processing, signed opaque scoped token, no login; separate safe preference-page GET from a state-changing POST |
| Queued campaigns | Re-evaluate consent/suppression at dispatch, not just audience creation |
| Transactional carve-out | Narrow documented categories; never reclassify a marketing campaign to bypass consent |
| Cross-region consistency | Maintain application-level opt-outs and safety blocks across all routes; define fail-closed behavior when preference storage is unavailable |
| Cancellation | Stop unsubmitted jobs; cannot recall messages already accepted by SES |
| Imports/exports | Explicit authorization, encryption, retention and access-controlled failure reports |
| Tracking | Customer controls and lawful notice; no tracking required to unsubscribe |

Mailbox-provider sender requirements and applicable law need their own launch review. The AWS one-click guide is an engineering source, not a complete legal compliance determination. [M4]

## Sources

All inspected on 2026-09-08.

- [M1] [SES list management](https://docs.aws.amazon.com/ses/latest/dg/sending-email-list-management.html)
- [M2] [SES subscription management](https://docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html)
- [M3] [SendBulkEmail request](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendBulkEmail.html) and [SendEmail request](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)
- [M4] [AWS one-click unsubscribe guide](https://aws.amazon.com/blogs/messaging-and-targeting/using-one-click-unsubscribe-with-amazon-ses/)
- [M5] [Account suppression lists](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)
- [M6] [Tenant-level suppression lists](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list-tenant-level.html)
- [M7] [June 2026 tenant suppression launch](https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-ses-tenant-level-suppression-lists)
- [M8] [Global suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-global-suppression-list.html)
- [M9] [Email Validation API](https://docs.aws.amazon.com/ses/latest/dg/email-validation-api.html)
- [M10] [Auto Validation](https://docs.aws.amazon.com/ses/latest/dg/email-validation-auto.html)
- [M11] [Event payload and bounce subtypes](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)
