# SES API and SDK inventory for OpenSend

[Hub](README.md)

Research date: **2026-09-08**. This is a public-reference snapshot, not an account capability scan, authorization policy, or implementation. No AWS mutations, dependencies, or tests were introduced. Source-model presence does not prove availability in every region or entitlement in a particular account.

## Provenance and how to read this inventory

**Verified:** the live public botocore `develop` model was retrieved, parsed, and matched byte-for-byte to a pinned repository commit. SES v2 contains **116 operations** and classic SES contains **71 operations**. API model version strings (`2019-09-27` and `2010-12-01`) identify protocol/service versions, **not last feature-release dates**. [I1][I2]

| Artifact | Reproducible value |
| --- | --- |
| Snapshot repository commit | `52ed7af8cb2183fb7fe6e34861924e74fbd952ad` |
| Snapshot commit timestamp returned by GitHub | `2026-09-08T18:07:19Z` |
| Latest SES v2 model-changing commit returned by GitHub | `9067ff80e720babd5d1c0f7bf4ce259cedb277e5`, `2026-09-01T18:08:32Z` |
| v2 path | `botocore/data/sesv2/2019-09-27/service-2.json` |
| v2 SHA-256 | `787ca192fc67eba762e028746eef275538dba238497584d7e43f6e8145fbf61b` |
| Classic path | `botocore/data/ses/2010-12-01/service-2.json` |
| Classic SHA-256 | `78f98dc6c5f4b83a60ba84091f5b76dd14b01a8a37be52cad384430b2a08b862` |

The model's operation names, member names, required fields, enums, protocol metadata, and explicit constraints are primary evidence for shape details. Developer guides provide behavior/quotas missing from model validation. Generated examples and prose can lag the model; disagreement is recorded rather than silently resolved by invention. The fetched JSON scratch files were kept outside the repository. [I1][I2]

**Security boundary:** this is a capability inventory, **not a list of permissions to grant**. API operation names are not always sufficient to derive IAM actions, supported resource types, or condition keys. Consult the service-authorization reference and the separate account/credentials research. In particular, do not replace the v2 `ses:SendBulkEmail` action with the classic `ses:SendBulkTemplatedEmail` action. [I13]

## API generation and transport

| Property | SES v2 | Classic SES |
| --- | --- | --- |
| SDK service identifier | `SESv2` | `SES` |
| SDK / CLI selector | `sesv2` | `ses` |
| API version | `2019-09-27` | `2010-12-01` |
| Wire protocol | REST JSON (`rest-json`) | AWS Query (`query`, XML responses) |
| Signing name | `ses` | `ses` |
| Signature | AWS Signature Version 4 | AWS Signature Version 4 |
| Modern application send | `SendEmail`, `SendBulkEmail` | Separate simple/raw/template/bulk operations |
| Current message-size ceiling | 40 MB after base64 encoding | 10 MB after base64 encoding |

SMTP is a third interface, not “SES API v1 over SMTP.” It submits MIME over TLS with regional SMTP credentials and supports 40 MB messages. SES Global endpoints do not support SMTP or VPC endpoint access. [I1][I2][I4][I10]

**Recommendation:** use v2 for new OpenSend sending. Retain classic only for explicitly needed classic-only operations or an intentional compatibility adapter. No reviewed source established retirement of the classic **SES API**; do not confuse retired SDK major versions with API retirement.

## Current SDK support and naming

The live `SendEmail` / `SendBulkEmail` API references link AWS CLI v2, .NET v4, C++, Go v2, Java v2, JavaScript v3, Kotlin, PHP v3, Python, and Ruby v3. That verifies published SDK reference surfaces, not that every previously installed release understands every new member. [I3]

| Environment | SES v2 selection | Classic selection / caveat |
| --- | --- | --- |
| JavaScript / TypeScript SDK v3 | `@aws-sdk/client-sesv2`, `SESv2Client`, `SendEmailCommand`, `SendBulkEmailCommand` | `@aws-sdk/client-ses`, `SESClient`; both packages belong to SDK **v3**. |
| Python Boto3 | `boto3.client('sesv2')`; `send_email`, `send_bulk_email` | `boto3.client('ses')`; Boto3/botocore installed version controls recognized operations/fields. |
| AWS CLI v2 | `aws sesv2 ...` | `aws ses ...`; CLI version and service API generation are different axes. |
| Java SDK 2.x | `software.amazon.awssdk.services.sesv2` / `SesV2Client` | `software.amazon.awssdk.services.ses` / `SesClient`. |
| Go SDK v2 | `github.com/aws/aws-sdk-go-v2/service/sesv2` | `.../service/ses`; SDK module versions evolve independently. |
| .NET | `AWSSDK.SimpleEmailV2`, `Amazon.SimpleEmailV2` | Live API docs link .NET V4; do not infer a .NET V3 retirement date here. |
| Ruby v3 / PHP v3 / C++ / Kotlin | Published v2 service references linked by send APIs | Verify exact installed version and runtime constraints before selecting new features. |

The Python, Java, Go, and .NET v2-service selections were cross-checked against their published SDK references. [I14]

JS v3 examples retrieved through Context7 correctly expose attachments, custom/replacement headers, inline `TemplateContent`, `EndpointId`, and `TenantName`. They **did not include `ConfigurationOverrides`**, although that field is present in the current live API/model. Do not use an old generated sample as a complete current schema. [I1][I3][I5]

**Verified SDK retirements:**

- AWS SDK for JavaScript **v2** reached end of support **2025-09-08**; AWS says no further updates/releases and recommends v3. [I6]
- AWS SDK for Go **v1** reached end of support **2025-07-31**; use Go SDK v2 for new work. [I7]
- AWS SDK for Java **1.x** reached end of support **2025-12-31**; AWS recommends Java 2.x. [I8]

End of support is not an automatic service shutdown: already installed clients may continue to send, but won't gain new modeled features or fixes. No unsupported exact npm/Boto3 package version or invented release date is asserted here. **Recommendation:** record/pin selected SDK versions during implementation, check required shapes, and explicitly configure retry behavior rather than assuming runtime-bundled SDK freshness.

## Complete SES v2 operation inventory — 116 operations

Every operation in the pinned v2 model appears once below. Grouping is editorial; it does not establish a shared IAM scope or availability level. [I1]

### Sending — 2

`SendEmail`, `SendBulkEmail`.

`SendEmail` handles Simple, Raw, and Template content. `SendBulkEmail` handles a shared template with per-entry data/headers/tags and per-entry results. Neither request has a modeled idempotency token. See [sending and templates](sending-and-templates.md) for payloads, caveats and retry semantics.

### Stored content and verification email templates — 12

`CreateEmailTemplate`, `GetEmailTemplate`, `ListEmailTemplates`, `UpdateEmailTemplate`, `DeleteEmailTemplate`, `TestRenderEmailTemplate`.

`CreateCustomVerificationEmailTemplate`, `GetCustomVerificationEmailTemplate`, `ListCustomVerificationEmailTemplates`, `UpdateCustomVerificationEmailTemplate`, `DeleteCustomVerificationEmailTemplate`, `SendCustomVerificationEmail`.

Custom verification-email templates support identity verification workflows; they are not interchangeable with transactional/marketing message templates.

### Sending identities, policies, DKIM, MAIL FROM and certificates — 16

`CreateEmailIdentity`, `GetEmailIdentity`, `ListEmailIdentities`, `DeleteEmailIdentity`.

`CreateEmailIdentityPolicy`, `GetEmailIdentityPolicies`, `UpdateEmailIdentityPolicy`, `DeleteEmailIdentityPolicy`.

`PutEmailIdentityConfigurationSetAttributes`, `PutEmailIdentityDkimAttributes`, `PutEmailIdentityDkimSigningAttributes`, `PutEmailIdentityFeedbackAttributes`, `PutEmailIdentityMailFromAttributes`.

`AssociateEmailIdentityCertificate`, `DisassociateEmailIdentityCertificate`, `ListEmailIdentityCertificates`.

**Verified purpose: S/MIME message signing, not DKIM, transport TLS, or message encryption.** Associate takes required `EmailIdentity` and an ACM X.509 `CertificateArn`. For a domain identity, `FromAddress` is required and must belong to that domain/subdomain; for an email identity it is optional but must match exactly if supplied. One association per sender address is allowed; an existing association errors unless it is `DEPROVISIONING`. Creation returns HTTP 200 but starts in `PROVISIONING`; signing requires `ACTIVE` **and** an S/MIME-enabled sending configuration set. [I15]

Disassociate takes `EmailIdentity` and, for a domain, `FromAddress`; after removal SES stops S/MIME-signing that address. It is explicitly idempotent when the identity exists but no association matches; `NotFoundException` applies when the identity does not exist. List takes `EmailIdentity`, optional `PageSize`/`NextToken`, and returns `Certificates[{FromAddress,CertificateArn,CertificateExpiryTime,Status}]` plus `NextToken`. States include `PROVISIONING`, `ACTIVE`, `INACTIVE`, `DEPROVISIONING`, `FAILED`; expired certificates are returned as `FAILED`. All three document invalid input (400), missing resource (404), and throttling (429); Associate additionally documents `AlreadyExistsException` (400). Certificate creation/import, ACM permissions, regional eligibility and client verification are separate concerns, not established by these association calls. [I15]

### Configuration sets and event destinations — 16

`CreateConfigurationSet`, `GetConfigurationSet`, `ListConfigurationSets`, `UpdateConfigurationSet`, `DeleteConfigurationSet`.

`CreateConfigurationSetEventDestination`, `GetConfigurationSetEventDestinations`, `UpdateConfigurationSetEventDestination`, `DeleteConfigurationSetEventDestination`.

`PutConfigurationSetArchivingOptions`, `PutConfigurationSetDeliveryOptions`, `PutConfigurationSetReputationOptions`, `PutConfigurationSetSendingOptions`, `PutConfigurationSetSuppressionOptions`, `PutConfigurationSetTrackingOptions`, `PutConfigurationSetVdmOptions`.

These operations configure behavior around sending; event-destination management is not the event-consumer/webhook delivery interface. Archiving can introduce dependencies on the separate Mail Manager service.

**`UpdateConfigurationSet` is currently a message-security partial update**, not a replacement for every `PutConfigurationSet*` operation: `POST /v2/email/update-configuration-sets` requires `ConfigurationSetName` and optionally `MessageSecurityOptions.SigningScheme`; omitted attributes stay unchanged. `SigningScheme` is a union: choose exactly one of `DefaultScheme: {}` (no SES-added S/MIME signature) or `SmimeScheme: {SignatureFormat?: "DETACHED"}` (requires an active sender certificate association). `DETACHED` is the only modeled signature-format value; no other default is asserted. Success is HTTP 200 with empty body; errors are `BadRequestException` (400), `NotFoundException` (404), and `TooManyRequestsException` (429). Changes affect messages using the configuration set; they are not per-send overrides or a claim of retroactive signing. [I16]

### Account-level attributes — 7

`GetAccount`, `PutAccountDedicatedIpWarmupAttributes`, `PutAccountDetails`, `PutAccountPricingAttributes`, `PutAccountSendingAttributes`, `PutAccountSuppressionAttributes`, `PutAccountVdmAttributes`.

`GetAccount` combines readiness/quota/settings information; account mutation operations should not be included in the permissions of a send-only runtime merely because they are listed here.

**Pricing plans are both readable and changeable through SES v2.** `GetAccount` (`GET /v2/email/account`, no body) returns `PricingAttributes.CurrentPlan` and `PricingAttributes.NextPlan`, each modeled as `NONE | ESSENTIALS | PRO | ENTERPRISE`. `CurrentPlan` is active now; `NextPlan` is empty when no change is pending, otherwise it becomes active at the next monthly cycle. The attributes are optional: absence is not evidence of `NONE`. The API lists NONE without explaining it; the pricing guide calls having no plan à-la-carte pricing, so interpreting NONE as no-plan is a cross-source interpretation, not a quoted API definition. [I17]

`PutAccountPricingAttributes` (`PUT /v2/email/account/pricing-attributes`) requires only `Plan` with the same enum and returns HTTP 200 with an empty body. Documented errors: `BadRequestException` (400), `TooManyRequestsException` (429), `ConflictException` (409; AWS wording: an ongoing account details update is under review). `GetAccount` documents 400/429 plus common errors. Neither pricing request nor response supplies a price quote, proration amount, explicit effective timestamp, scheduling-date input, `DryRun`, or idempotency token. [I17]

**Scope/timing:** plans apply separately to each account and AWS Region. The SES pricing-plan guide says upgrades apply immediately; the first downgrade/cancellation for an account implicitly defaulted to Essentials also applies immediately; all other downgrades/cancellations apply at the next billing cycle. Selecting a plan **does not automatically enable features**—feature toggles remain separate. The published pricing page states that new accounts and account×region combinations with no metered SES activity since 2025-06-01 start on Essentials beginning **2026-07-21**; this is an AWS-stated effective date, not inferred from a model commit. Exact eligibility in an account was not inspected. [I18]

**Recommendation:** detect plans with `GetAccount` during read-only onboarding; reserve Put for an explicit billing-change workflow, not a readiness probe. Show the selected account/region and fee implications, obtain approval, then re-read both CurrentPlan and NextPlan rather than treating HTTP 200 as proof of immediate activation. Do not infer sandbox removal, feature activation, cross-region propagation, universal region support, or exact proration from a plan update. [I17][I18]

### Contacts, lists, and import jobs — 13

`CreateContact`, `GetContact`, `ListContacts`, `UpdateContact`, `DeleteContact`.

`CreateContactList`, `GetContactList`, `ListContactLists`, `UpdateContactList`, `DeleteContactList`.

`CreateImportJob`, `GetImportJob`, `ListImportJobs`.

Import jobs are asynchronous data ingestion, not an operation to enqueue a scheduled email campaign. SES contact/list APIs are not a complete campaign lifecycle API.

### Suppression and email-address validation — 5

`PutSuppressedDestination`, `GetSuppressedDestination`, `ListSuppressedDestinations`, `DeleteSuppressedDestination`, `GetEmailAddressInsights`.

Current suppression CRUD/list requests have optional `TenantName`; omission targets account-level suppression. `GetEmailAddressInsights` accepts `EmailAddress` and returns `MailboxValidation` with `IsValid` and `Evaluations`. An email-validation assessment is not consent, guaranteed delivery, or a future guarantee of mailbox existence.

### Tenant resources, associations, suppression and reputation — 13

`CreateTenant`, `GetTenant`, `ListTenants`, `DeleteTenant`.

`CreateTenantResourceAssociation`, `DeleteTenantResourceAssociation`, `ListTenantResources`, `ListResourceTenants`.

`PutTenantSuppressionAttributes`, `GetReputationEntity`, `ListReputationEntities`, `UpdateReputationEntityCustomerManagedStatus`, `UpdateReputationEntityPolicy`.

There is no `UpdateTenant` operation in this snapshot. Tenant-related controls are spread across tenant, association, reputation, suppression, and send request shapes rather than a single mutable tenant endpoint.

### Multi-region / Global endpoints — 4

`CreateMultiRegionEndpoint`, `GetMultiRegionEndpoint`, `ListMultiRegionEndpoints`, `DeleteMultiRegionEndpoint`.

No `UpdateMultiRegionEndpoint` operation appears in the snapshot. Create takes `EndpointName` and `Details`; sends take the returned/configured **EndpointId**, not EndpointName. Consult the operation shape rather than copying high-level CLI examples without validation. [I10]

### Dedicated IPs and pools — 9

`CreateDedicatedIpPool`, `GetDedicatedIpPool`, `ListDedicatedIpPools`, `DeleteDedicatedIpPool`, `GetDedicatedIp`, `GetDedicatedIps`, `PutDedicatedIpInPool`, `PutDedicatedIpPoolScalingAttributes`, `PutDedicatedIpWarmupAttributes`.

These are delivery infrastructure controls; standard versus managed pool behavior, billing and region support require separate checks.

### Deliverability, metrics, message insights, recommendations and exports — 16

`BatchGetMetricData`, `GetMessageInsights`, `ListRecommendations`.

`CreateExportJob`, `GetExportJob`, `ListExportJobs`, `CancelExportJob`.

`CreateDeliverabilityTestReport`, `GetDeliverabilityTestReport`, `ListDeliverabilityTestReports`.

`GetDeliverabilityDashboardOptions`, `PutDeliverabilityDashboardOption`, `GetBlacklistReports`, `GetDomainDeliverabilityCampaign`, `ListDomainDeliverabilityCampaigns`, `GetDomainStatisticsReport`.

Deliverability test reports and message insights are not substitutes for receiving every event. Feature enrollment/charges may apply.

### Resource tagging — 3

`TagResource`, `UntagResource`, `ListTagsForResource`.

Resource tags are distinct from message `EmailTags`, bulk `DefaultEmailTags` / `ReplacementTags`, and template replacement variables.

## Classic SES inventory — 71 operations

The classic model remains relevant when investigating older integrations and receiving. These names are **not v2 aliases**; request/response formats differ. [I2]

| Capability | Operations |
| --- | --- |
| Sending / delivery bounce response (5) | `SendEmail`, `SendRawEmail`, `SendTemplatedEmail`, `SendBulkTemplatedEmail`, `SendBounce` |
| Stored templates (6) | `CreateTemplate`, `GetTemplate`, `ListTemplates`, `UpdateTemplate`, `DeleteTemplate`, `TestRenderTemplate` |
| Custom verification email templates (6) | `CreateCustomVerificationEmailTemplate`, `GetCustomVerificationEmailTemplate`, `ListCustomVerificationEmailTemplates`, `UpdateCustomVerificationEmailTemplate`, `DeleteCustomVerificationEmailTemplate`, `SendCustomVerificationEmail` |
| Identity and verification (11) | `VerifyDomainIdentity`, `VerifyDomainDkim`, `VerifyEmailIdentity`, `VerifyEmailAddress`, `ListIdentities`, `ListVerifiedEmailAddresses`, `GetIdentityVerificationAttributes`, `GetIdentityDkimAttributes`, `SetIdentityDkimEnabled`, `DeleteIdentity`, `DeleteVerifiedEmailAddress` |
| Identity policies (4) | `GetIdentityPolicies`, `ListIdentityPolicies`, `PutIdentityPolicy`, `DeleteIdentityPolicy` |
| Identity feedback / MAIL FROM (6) | `GetIdentityMailFromDomainAttributes`, `GetIdentityNotificationAttributes`, `SetIdentityMailFromDomain`, `SetIdentityFeedbackForwardingEnabled`, `SetIdentityHeadersInNotificationsEnabled`, `SetIdentityNotificationTopic` |
| Configuration sets (13) | `CreateConfigurationSet`, `DescribeConfigurationSet`, `ListConfigurationSets`, `DeleteConfigurationSet`, `CreateConfigurationSetEventDestination`, `UpdateConfigurationSetEventDestination`, `DeleteConfigurationSetEventDestination`, `CreateConfigurationSetTrackingOptions`, `UpdateConfigurationSetTrackingOptions`, `DeleteConfigurationSetTrackingOptions`, `PutConfigurationSetDeliveryOptions`, `UpdateConfigurationSetReputationMetricsEnabled`, `UpdateConfigurationSetSendingEnabled` |
| Account sending (4) | `GetAccountSendingEnabled`, `UpdateAccountSendingEnabled`, `GetSendQuota`, `GetSendStatistics` |
| Receiving rule sets / rules / filters (16) | `CloneReceiptRuleSet`, `CreateReceiptRuleSet`, `DeleteReceiptRuleSet`, `DescribeActiveReceiptRuleSet`, `DescribeReceiptRuleSet`, `ListReceiptRuleSets`, `SetActiveReceiptRuleSet`, `CreateReceiptRule`, `DeleteReceiptRule`, `DescribeReceiptRule`, `UpdateReceiptRule`, `ReorderReceiptRuleSet`, `SetReceiptRulePosition`, `CreateReceiptFilter`, `DeleteReceiptFilter`, `ListReceiptFilters` |

`VerifyEmailAddress` and `ListVerifiedEmailAddresses` are legacy APIs; their model documentation directs callers toward the identity-oriented alternatives. Do not use that fact to declare the whole classic SES API deprecated. [I2]

## Newer exposed capabilities and important shape details

“Newer” below means likely absent from older integrations, not a claim that every feature launched on the research date. Exact launch dates are intentionally not invented.

| Capability | Current verified model exposure | OpenSend implication |
| --- | --- | --- |
| Structured attachments | `Message.Attachments`, `Template.Attachments`; required `RawContent`/`FileName` | Raw MIME no longer required for all ordinary attachments. Bulk shares attachments across entries. |
| Inline template content | `Template.TemplateContent.{Subject,Text,Html}` | No stored-template lifecycle required, but simple substitutions only. |
| Structured custom headers | `Message.Headers`, `Template.Headers`, `BulkEmailEntry.ReplacementHeaders` | Per-recipient unsubscribe/correlation headers can be represented; header constraints still apply. |
| Request-local engagement policy | `ConfigurationOverrides.Tracking.{OpenTrackingEnabled,ClickTrackingEnabled}` on both sends | `ENABLED`/`DISABLED` strings; bulk-wide, not per-entry. Doesn't create an event destination. |
| Global endpoint routing | `EndpointId` on both sends; four endpoint operations | Region dependency readiness is still required; not arbitrary cross-region resource access. |
| SES tenants | `TenantName` on both sends; tenant associations and reputation controls | Resources used for sends must be associated; application tenancy/IAM isolation still requires explicit design. |
| Tenant suppression | Optional `TenantName` on suppression operations; `CreateTenant.SuppressionAttributes`; `PutTenantSuppressionAttributes` | Account-scoped assumptions in older suppression code are no longer complete. |
| Suppression scope | `TenantSuppressionAttributes.SuppressionScope`, `SuppressionOptions.SuppressionScope` | `ACCOUNT` / `TENANT`; tenant defaults to ACCOUNT if omitted. Config-set scope can override tenant/account scope. |
| Email-address validation | `GetEmailAddressInsights`; account `ValidationAttributes`, configuration-set `ValidationOptions` | A configurable suppression/validation layer exists; inspect thresholds and charges before exposing UI promises. |
| Identity certificate associations | ACM-backed S/MIME sender-certificate association/list/removal | Active certificate plus signing-enabled configuration set required; not DKIM/TLS/encryption. |
| Configuration-set mutation | `UpdateConfigurationSet.MessageSecurityOptions.SigningScheme` | Partial update for S/MIME signing; separate Put operations still manage other settings. |
| Account-region pricing plans | `GetAccount.PricingAttributes.{CurrentPlan,NextPlan}`; `PutAccountPricingAttributes.Plan` | Read-only plan detection exists; plan changes affect billing and may be scheduled rather than immediate. |

All rows are verified against the pinned model, and send shapes were compared with current API references. [I1][I3]

**Marketing shape gap:** only `SendEmail` exposes `ListManagementOptions`. `SendBulkEmail` does **not**. A bulk API abstraction must explicitly design unsubscribe processing rather than copying a single-send payload and assuming SES-managed list/topic handling still applies. [I1][I3]

**Not provided by these send APIs:** scheduled send time, campaign launch/pause lifecycle, exactly-once idempotency token, attachment retrieval from arbitrary URL, per-entry bulk attachment replacement, or an arbitrary list/segment expansion operation. These are application responsibilities or separate capabilities, not fields to invent in SES payloads.

**Outside this inventory:** AWS IAM/STS, SNS/SQS/EventBridge/CloudWatch, S3, Service Quotas, KMS, SES Mail Manager, and AWS End User Messaging are separate service models. Their absence from `sesv2` is not proof that an end-to-end email system cannot use them. Inbound classic receipt rules are not a transactional/marketing campaign API.

## Known documentation mismatches and unresolved behavior

- `BulkEmailEntryResult` explanatory text contains stale classic operation names and status spellings; its v2 Valid Values and model have `CONFIGURATION_SET_NOT_FOUND`, `TEMPLATE_NOT_FOUND`, `INVALID_PARAMETER`. [I9]
- General send descriptions still emphasize raw MIME for attachments, but the specific attachment guide and current model support attachments on Simple/Template content. [I3][I11]
- Global endpoint overview wording sounds like automatic synchronization; its detailed guide requires preparing both regions and manually configuring exceptions. Do not promise perpetual automatic replication. [I10]
- Generic quotas and personalized-email pages use “destination” inconsistently. The sending reference preserves the 50-entry versus 50-recipient-per-message distinction and recommends one person per entry. [I4][I12]
- Minimum SDK package releases for every new field, regional availability of every new action, exact v1/v2 stored-template interoperability, and actual tenant/global-endpoint behavior were not tested. Check before implementation rather than guessing.

## Sources inspected

- [I1] [Pinned botocore SES v2 model](https://github.com/boto/botocore/blob/52ed7af8cb2183fb7fe6e34861924e74fbd952ad/botocore/data/sesv2/2019-09-27/service-2.json); [latest model-changing commit](https://github.com/boto/botocore/commit/9067ff80e720babd5d1c0f7bf4ce259cedb277e5).
- [I2] [Pinned botocore classic SES model](https://github.com/boto/botocore/blob/52ed7af8cb2183fb7fe6e34861924e74fbd952ad/botocore/data/ses/2010-12-01/service-2.json).
- [I3] [SES v2 SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html) and [SendBulkEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendBulkEmail.html), including official SDK links.
- [I4] [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html).
- [I5] Context7 library `/websites/aws_amazon_awsjavascriptsdk_v3`, queried for SESv2 send/attachment/header shapes; source [SendBulkEmailCommand](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sesv2/command/SendBulkEmailCommand) and [SendEmailCommand](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sesv2/command/SendEmailCommand).
- [I6] [AWS JS SDK README end-of-support notice](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/) and [AWS announcement](https://aws.amazon.com/blogs/developer/announcing-end-of-support-for-aws-sdk-for-javascript-v2/).
- [I7] [AWS Go v1 end-of-support announcement](https://aws.amazon.com/blogs/developer/announcing-end-of-support-for-aws-sdk-for-go-v1-on-july-31-2025/).
- [I8] [AWS Java 1.x developer guide](https://docs.aws.amazon.com/sdk-for-java/v1/developer-guide/getting-started.html) and [official SDK repository](https://github.com/aws/aws-sdk-java).
- [I9] [BulkEmailEntryResult](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_BulkEmailEntryResult.html).
- [I10] [Global endpoints guide](https://docs.aws.amazon.com/ses/latest/dg/global-endpoints.html).
- [I11] [Working with attachments](https://docs.aws.amazon.com/ses/latest/dg/attachments.html).
- [I12] [Personalized email guide](https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-api.html).
- [I13] [SES v2 service-authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html).
- [I14] [Boto3 SESv2](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/sesv2.html), [Java SesV2Client](https://sdk.amazonaws.com/java/api/latest/software/amazon/awssdk/services/sesv2/SesV2Client.html), [Go SESv2 module](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/service/sesv2), and [.NET SimpleEmailV2 namespace](https://docs.aws.amazon.com/sdkfornet/v4/apidocs/items/SimpleEmailV2/NSimpleEmailV2.html).
- [I15] [AssociateEmailIdentityCertificate](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_AssociateEmailIdentityCertificate.html), [DisassociateEmailIdentityCertificate](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_DisassociateEmailIdentityCertificate.html), and [ListEmailIdentityCertificates](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_ListEmailIdentityCertificates.html).
- [I16] [UpdateConfigurationSet](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_UpdateConfigurationSet.html), [SigningScheme](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SigningScheme.html), and [SmimeSigningScheme](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SmimeSigningScheme.html).
- [I17] [GetAccount](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html), [PricingAttributes](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PricingAttributes.html), and [PutAccountPricingAttributes](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PutAccountPricingAttributes.html).
- [I18] [SES pricing-plan management and timing](https://docs.aws.amazon.com/ses/latest/dg/pricing-plans.html) and [SES pricing](https://aws.amazon.com/ses/pricing/).
