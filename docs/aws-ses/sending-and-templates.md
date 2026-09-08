# SES sending, bulk delivery requests, and templates

[Hub](README.md)

Research date: **2026-09-08**. Scope: public AWS documentation and the current public botocore service model; no account inspection, sending, or AWS mutation occurred. **Verified** statements describe those sources, not a live account test. **Recommendation** identifies OpenSend design guidance. **Unknown / caveat** identifies behavior not established by the sources.

See [API and SDK inventory](api-and-sdk-inventory.md) for exact operation names, SDK distinctions, model provenance, and newer capabilities.

## 1. Choose the correct sending surface

| Surface | Sending operations | Content and operational tradeoff |
| --- | --- | --- |
| SES API v2 (`sesv2`, API version `2019-09-27`) | `SendEmail`, `SendBulkEmail` | Preferred modern API: simple, raw, stored or inline templates; structured attachments/custom headers; tenants, global endpoints, per-request tracking overrides. |
| Classic SES API (`ses`, API version `2010-12-01`) | `SendEmail`, `SendRawEmail`, `SendTemplatedEmail`, `SendBulkTemplatedEmail` | Still documented, not established as retired. Different request names, shapes and limits. Classic receiving/identity-notification controls also remain here. |
| SES SMTP | SMTP submission of MIME | Useful for existing SMTP software; application constructs/render messages. No SES template or bulk JSON invocation, and no Global endpoints support. |

API v2 uses HTTPS REST/JSON and AWS SigV4. Classic uses the AWS Query protocol; SMTP uses its own regional SMTP credentials. **SDK major version is independent of SES API version**: JavaScript SDK v3 offers both `@aws-sdk/client-sesv2` and `@aws-sdk/client-ses`. Python uses `boto3.client('sesv2')` or `boto3.client('ses')`. [S1][S2][S3][S16]

**Recommendation:** build the primary sending adapter against SES v2. Keep raw MIME as an explicit capability, not the default requirement for every attachment. Keep SMTP compatibility separate from the API contract; do not imply feature parity.

## 2. Limits and encoding boundaries

The numbers below are AWS documented limits, not proposed OpenSend plan limits. AWS quotas can be regional and account-specific; a request fitting these structural limits can still be throttled. [S4][S5]

| Item | Verified documented value | Interpretation |
| --- | --- | --- |
| SES v2 / SMTP maximum message size | 40 MB, including attachments, **after base64 encoding** | Budget for encoded content and MIME overhead, not just source file bytes. |
| Classic SES maximum message size | 10 MB, including attachments, after base64 encoding | Do not carry the v1 limit into v2, or vice versa. |
| Recipients per message | 50 across To/Cc/Bcc | A message addressed to multiple people is not independently personalized for each person. |
| v2 bulk request | Up to 50 `Destination` objects | Each entry produces one personalized message for its destination's recipients. |
| Stored templates | 20,000 per AWS Region | Inline content does not consume stored-template count. |
| Stored template size | 500 KB, including text and HTML parts | Distinct from a rendered message's 40 MB limit. |
| Inline template input | Guide says each input JSON file up to 1 MB, including text and HTML parts | Do not mistake this wording for a separately established universal 1 MB limit on attachment-bearing API requests. |
| Template substitution data | String length maximum 262,144 | Model constraint on `TemplateData` and `ReplacementTemplateData`; it is JSON serialized **inside a string**. |
| Replacement variables | No limit on number | Still subject to template/data/message size limits. |
| MIME parts | Maximum 500 | Applies to the constructed message, not a promise of 500 attachments. |
| Raw MIME line length | At most 1,000 characters | Use RFC-compatible CRLF lines and appropriate folding/encoding. |
| Structured custom headers | Maximum 15 per message | Apply to the effective merged headers in bulk; validate conservatively. |
| Header name | At most 126 characters; printable ASCII 33–126 except `:` | Do not accept CR/LF injection. |
| Header value | At most 995 characters; printable ASCII | Name plus value must not exceed 996 characters. |

**Bulk quota wording caveat:** the personalized-email guide expressly says 50 destination **objects**, each possibly containing multiple recipients, while the general template quota table calls a destination an email address and says 50 destinations. The per-message cap remains 50 recipients. Do not market a guaranteed 2,500-recipient request based on multiplying the two numbers; runtime boundaries with multi-recipient entries were not exercised. **Recommendation:** one To recipient per bulk entry and at most 50 entries per call, further reduced for account rate limits. This also avoids exposing recipients and simplifies per-person outcomes. [S4][S5][S6]

The quotas page says messages larger than 10 MB can be bandwidth-throttled as low as 40 MB/s, depending on sending rate. Sending quotas count **recipients**, not HTTP requests. Sandbox defaults are 200 recipients per 24 hours and one recipient per second; production quotas vary. Bulk is not a quota bypass. [S4]

The general quotas page's API throttle wording still names classic operations and says other actions are limited to one request/second. Do not infer a universal high-throughput bulk/control-plane allowance from SDK availability. `TestRenderEmailTemplate` explicitly documents at most one request/second; consult operation-specific limits and actual account behavior. [S4][S11]

## 3. `SendEmail`: current v2 request contract

`POST /v2/email/outbound-emails` accepts `Content` (required in the model), selecting **one** of `Simple`, `Raw`, or `Template`. Other structural fields are optional in the model because raw messages can contain relevant envelope/header information; that does not mean a sender and recipients are unnecessary. [S1][S16]

| Field | Meaning / constraint |
| --- | --- |
| `FromEmailAddress` | Sender; verified identity rules apply. |
| `FromEmailAddressIdentityArn` | Sending-authorization identity ARN, not a generic template ARN or assumed-role ARN. With raw email it overrides `X-SES-SOURCE-ARN` / `X-SES-FROM-ARN`. |
| `Destination` | `ToAddresses`, `CcAddresses`, `BccAddresses` arrays. |
| `ReplyToAddresses` | Reply routing, independent of bounce handling. |
| `FeedbackForwardingEmailAddress` | Feedback forwarding address. |
| `FeedbackForwardingEmailAddressIdentityArn` | Sending-authorization ARN for that feedback address. |
| `EmailTags` | Name/value metadata for sending events; not MIME headers or template variables. |
| `ConfigurationSetName` | Sending configuration/event-publishing association. |
| `EndpointId` | Optional Global endpoint identifier; not a region name. |
| `TenantName` | Optional SES tenant; referenced identities, configuration sets, and templates must be associated with it. |
| `ListManagementOptions` | `{ ContactListName, TopicName? }` for SES list/topic unsubscribe handling. |
| `ConfigurationOverrides` | Current model supports request-local tracking overrides; see below. |

### Simple content

`Content.Simple` contains required `Subject: { Data, Charset? }` and `Body: { Text?: { Data, Charset? }, Html?: { Data, Charset? } }`. It can also contain `Headers` and `Attachments`. Prefer explicit UTF-8 when supplying international text; raw address/header encoding rules remain distinct from body character sets. [S1][S7][S8]

Illustrative JSON only; not a send instruction or production-ready campaign payload:

```json
{
  "FromEmailAddress": "receipts@example.com",
  "Destination": { "ToAddresses": ["recipient@example.net"] },
  "Content": {
    "Simple": {
      "Subject": { "Data": "Your receipt", "Charset": "UTF-8" },
      "Body": {
        "Text": { "Data": "Thank you for your order.", "Charset": "UTF-8" },
        "Html": { "Data": "<p>Thank you for your order.</p>", "Charset": "UTF-8" }
      },
      "Headers": [{ "Name": "X-OpenSend-Reference", "Value": "example-reference" }]
    }
  },
  "ConfigurationSetName": "transactional",
  "ConfigurationOverrides": {
    "Tracking": { "OpenTrackingEnabled": "DISABLED", "ClickTrackingEnabled": "DISABLED" }
  }
}
```

**Verified newer shape:** `ConfigurationOverrides.Tracking.OpenTrackingEnabled` and `.ClickTrackingEnabled` accept strings `ENABLED` or `DISABLED`, not booleans. Omitted values retain settings otherwise applicable to the message. Overrides do not change the account or configuration set. Enabling tracking does not create an event destination: the model says resulting events are recorded in VDM, and a configured event destination publishing OPEN/CLICK is needed to receive them at your destination. Bulk overrides apply to every message in that request. [S16][S21]

**Recommendation:** do not silently alter transactional tracking based only on account defaults; make the policy explicit and verify installed SDK support. This field was present in the fetched live model/API reference but absent from the Context7 SDK example retrieved during this research.

### Raw content

`Content.Raw.Data` contains the complete RFC/MIME message as a blob. SDK callers supply bytes (`Uint8Array` / `Buffer` in JS; bytes in Python); the SDK handles the HTTP base64 serialization. A direct JSON HTTPS client must base64-encode it. Do not base64-encode the entire message twice. [S8][S16]

### Templated content

`Content.Template` selects an existing template by `TemplateName` or `TemplateArn`, **or** supplies inline `TemplateContent: { Subject, Text, Html }`. `TemplateData` is the string containing JSON substitutions. `Headers` and `Attachments` are siblings inside this object, not fields of `TemplateContent`. Avoid combining multiple template selectors and relying on undocumented precedence. [S5][S9]

## 4. `SendBulkEmail`: personalization and partial results

`POST /v2/email/outbound-bulk-emails` requires `DefaultContent` and `BulkEmailEntries`. Current `DefaultContent` supports **only `Template`**. It is not an array of arbitrary `SendEmail` requests and does not accept per-entry raw/simple messages. [S2][S16]

Request-level fields mirror the sender, reply, feedback, authorization, configuration set, endpoint, tenant, and tracking-override fields above. Differences:

- Tags at request level are `DefaultEmailTags`, not `EmailTags`.
- Every entry requires a `Destination`.
- `ReplacementEmailContent.ReplacementTemplate.ReplacementTemplateData` contains entry-specific substitution JSON as a string.
- `ReplacementTags` carries event metadata; `ReplacementHeaders` adds/overrides custom headers.
- **There is no `ListManagementOptions` member on `SendBulkEmail` in the current service model or API reference.** Do not promise that the single-send SES contact-list unsubscribe mechanism can simply be included in a bulk request. [S2][S6][S16]

Illustrative request; the unsubscribe value is deliberately omitted because OpenSend's verified consent/preference workflow belongs in a separate contract:

```json
{
  "FromEmailAddress": "news@example.com",
  "ConfigurationSetName": "marketing",
  "DefaultContent": {
    "Template": {
      "TemplateContent": {
        "Subject": "Hello {{name}}",
        "Text": "Hello {{name}}, your update is ready.",
        "Html": "<p>Hello {{name}}, your update is ready.</p>"
      },
      "TemplateData": "{\"name\":\"reader\"}",
      "Headers": [{ "Name": "X-OpenSend-Campaign", "Value": "example-campaign" }]
    }
  },
  "BulkEmailEntries": [
    {
      "Destination": { "ToAddresses": ["one@example.net"] },
      "ReplacementEmailContent": {
        "ReplacementTemplate": { "ReplacementTemplateData": "{\"name\":\"Alex\"}" }
      },
      "ReplacementTags": [{ "Name": "recipient_ref", "Value": "example-one" }]
    },
    {
      "Destination": { "ToAddresses": ["two@example.net"] },
      "ReplacementEmailContent": {
        "ReplacementTemplate": { "ReplacementTemplateData": "{\"name\":\"Sam\"}" }
      },
      "ReplacementHeaders": [{ "Name": "X-OpenSend-Reference", "Value": "example-two" }]
    }
  ]
}
```

The template's default data provides fallback content. **Caveat:** do not assume a deep merge of incomplete replacement JSON with default data. The classic API explicitly describes fallback when destination replacement data is absent; v2 descriptions do not establish deep-merge semantics. **Recommendation:** construct a complete substitution map per personalized entry, including safe defaults. [S5][S6][S20]

Header precedence **is documented**: a template header not specified on an entry is inherited; an entry header with the same name replaces the template value; a new entry header is added. Do not extrapolate this rule to substitution JSON or tag merge semantics. [S6]

Attachments live in `DefaultContent.Template.Attachments` and **all recipients receive the same attachments**. There is no per-entry replacement attachment or alternate template body/name member. Personalized invoices/files therefore need separate `SendEmail` calls or batches grouped by identical attachment/content requirements. [S7][S9][S16]

### Results and errors

HTTP 200 returns `BulkEmailEntryResults`, with `Status`, optional `Error`, and optional `MessageId` per entry. **HTTP 200 is not whole-batch success.** The entry-result type says it corresponds to each specified `BulkEmailEntry`; retain original entry ordering and correlation metadata. The classic API explicitly guarantees response order matches destinations; the v2 page is less explicit about ordering. Verify this integration behavior before using multi-recipient entries or discarding input context. [S2][S10][S20]

| v2 wire status | Handling recommendation |
| --- | --- |
| `SUCCESS` | Accepted for attempted delivery; do not resend just because no delivery event has arrived. |
| `TRANSIENT_FAILURE` | Retry only that failed entry with bounded backoff/jitter. |
| `ACCOUNT_THROTTLED` | Slow/pause recipient-weighted traffic before retrying. |
| `ACCOUNT_DAILY_QUOTA_EXCEEDED` | Defer until quota permits; tight retries cannot repair it. |
| `MAIL_FROM_DOMAIN_NOT_VERIFIED`, `CONFIGURATION_SET_NOT_FOUND`, `TEMPLATE_NOT_FOUND`, `INVALID_SENDING_POOL_NAME` | Repair identity/configuration/resource problem first. |
| `ACCOUNT_SUSPENDED`, `ACCOUNT_SENDING_PAUSED`, `CONFIGURATION_SET_SENDING_PAUSED` | Stop relevant workload and escalate; not a transient retry loop. |
| `MESSAGE_REJECTED`, `INVALID_PARAMETER` | Inspect error and fix content/input; do not blindly retry. |
| `FAILED` or an unfamiliar future value | Preserve error/status; investigate before deciding retryability. |

**Documentation inconsistency:** explanatory prose for `BulkEmailEntryResult` still mentions classic `SendBulkTemplatedEmail` and legacy-style labels `CONFIGURATION_SET_DOES_NOT_EXIST`, `TEMPLATE_DOES_NOT_EXIST`, `INVALID_PARAMETER_VALUE`. The v2 **Valid Values** list and current model instead contain `CONFIGURATION_SET_NOT_FOUND`, `TEMPLATE_NOT_FOUND`, `INVALID_PARAMETER`. Use the actual v2 enum strings and handle unknown future strings safely. [S10][S16]

Both v2 send operations also have whole-request errors: `TooManyRequestsException`, `LimitExceededException`, `AccountSuspendedException`, `SendingPausedException`, `MessageRejected`, `MailFromDomainNotVerifiedException`, `NotFoundException`, and `BadRequestException`, plus common auth/network errors. Distinguish these from HTTP-200 entry statuses. [S1][S2]

## 5. Template storage, rendering, and safety

Stored v2 template operations are `CreateEmailTemplate`, `GetEmailTemplate`, `ListEmailTemplates`, `UpdateEmailTemplate`, `DeleteEmailTemplate`, and `TestRenderEmailTemplate`. A stored template holds `Subject`, `Html`, and `Text`; attachments/header overrides are send-time fields. There is no native immutable version/publish operation in this operation set. [S9][S11][S16]

**Recommendation:** maintain OpenSend-owned template versions, a content hash, selected AWS region, and published template name. Updating an in-use SES template changes what later sends reference; don't pretend it snapshots a campaign at scheduling time. Use immutable application revisions or inline content when deterministic scheduled content is required.

**Verified rendering capabilities:** stored templates support documented Handlebars features including nested attributes, array iteration, basic conditionals, and inline partials. Inline `TemplateContent` supports **simple substitutions only**; do not assume feature-equivalence to the stored template engine. No guarantee of arbitrary custom helpers was established. [S9][S12]

**Critical safety detail:** AWS says SES **does not escape HTML content when rendering the HTML template**. Treat recipient/customer substitution data as untrusted. Escape text for the destination context, validate URL schemes/hosts, and distinguish intentionally trusted HTML from text. Do not assume a normal Handlebars escaping policy protects SES HTML. [S12]

`TestRenderEmailTemplate` accepts a stored `TemplateName` and `TemplateData` string, returns `RenderedTemplate` MIME, and is limited to one invocation/second. It is a preview operation, not delivery or inbox-rendering proof. It has no inline-template-content input. A local renderer may be useful but is not automatically identical to SES's renderer. [S11]

**Rendering failure happens after acceptance:** `SendEmail` can return a `MessageId` and still not send, including invalid personalization content; malware is another documented example. Subscribe to rendering-failure events and preserve the exact template version/data keys needed to diagnose failures without logging secrets or unnecessary recipient data. Missing variables, malformed data, and unsupported expressions deserve preview checks before scheduling. [S1][S5]

**Recommendation:** preview representative and edge-case records, reject missing required application variables before enqueueing, and use the actual SES stored-template preview during publication rather than for every recipient at send time. No new tests or AWS calls were performed in this research.

## 6. Attachments, inline images, and calendar MIME

Structured v2 `Attachment` fields are: required `RawContent` and `FileName`; optional `ContentDisposition`, `ContentDescription`, `ContentId`, `ContentTransferEncoding`, and `ContentType`. `ContentDisposition` accepts `ATTACHMENT` or `INLINE`; HTML can reference an inline attachment through `cid:` matching its `ContentId`. SES can infer content type from extension. [S7]

There are **two distinct encodings**: [S7][S8]

1. API transport: JSON represents attachment/raw-message blobs as base64. Official SDKs serialize bytes automatically; direct HTTP callers must encode them.
2. MIME content-transfer encoding: `ContentTransferEncoding` selects `BASE64`, `QUOTED_PRINTABLE`, or `SEVEN_BIT` (documented default). For binary content, explicitly prefer `BASE64`; transport base64 does not itself select the outgoing MIME encoding.

The attachment guide allows multiple attachments within the 40 MB total-message limit and maintains a list of disallowed file extensions. Do not copy a small extension allowlist and claim it represents every SES rule. Virus rejection, recipient provider limits, and content-type/filename correctness still matter. [S7]

**Calendar recommendation, not an SES scheduling feature:** an `.ics` attachment can be represented as a file with an appropriate `text/calendar` content type, but SES does not generate calendar events or guarantee Outlook/Gmail invitation behavior. For an actual invitation with controlled MIME placement and `method=REQUEST`/`CANCEL`, stable iCalendar `UID`, organizer/attendee fields, sequencing, and recurrence behavior, use a standards-compliant MIME/calendar generator and raw content. Test in target clients. Structured `Attachment` has no dedicated calendar-method/event schema; successful send is not proof of correct RSVP behavior. [S7][S8][S16]

Raw messages need a header/body blank line, complete required headers, correctly nested multipart boundaries, and supported attachment types. Encode non-ASCII bodies with quoted-printable or base64. SES does not support SMTPUTF8: Unicode domains can use Punycode, but local parts must remain 7-bit ASCII; international display names/headers require MIME encoded-word encoding as appropriate. [S8][S16]

SES overrides supplied `Date` and `Message-ID`. A custom Message-ID is therefore **not** a deduplication control. The received Return-Path can differ from the requested feedback address. Do not include SES sending-authorization `X-SES-*` headers in a caller-provided DKIM signature, because SES removes the authorization headers. [S13][S19]

For simple/templated structured headers, AWS disallows overriding SES-owned `BCC`, `CC`, `Content-Disposition`, `Content-Type`, `Date`, `From`, `Message-ID`, `MIME-Version`, `Reply-To`, `Return-Path`, `Subject`, and `To`; use the corresponding API fields. `List-Unsubscribe` and `List-Unsubscribe-Post` are not on that disallowed list, but their mere presence does not implement an unsubscribe endpoint or establish consent. [S13]

## 7. Acceptance, delivery, retries, and idempotency

**Verified:** `MessageId` means SES accepted the message; it is not confirmation of remote delivery, inbox placement, reading, or successful template rendering. `SUCCESS` in bulk means accepted for attempted delivery. SMTP's `250 Ok MessageID` likewise acknowledges SES submission, not a recipient inbox read. [S1][S10][S14]

**Verified schema finding:** neither current v2 send request has a `ClientToken`, idempotency token, or documented deduplication key. SDK automatic retries do not create an exactly-once send guarantee. A timeout after transmission can leave the caller uncertain whether SES accepted the message. Repeating that request can send a duplicate; application tags only correlate events and are not deduplication instructions. [S1][S2][S16]

**OpenSend recommendations:**

- Assign a stable application message ID/idempotency key before enqueueing, with a tenant-scoped uniqueness rule and payload fingerprint. Keep this separate from each provider attempt/SES MessageId.
- Persist attempt start and result. Distinguish not-attempted, accepted, definitively rejected, and **acceptance unknown**; do not label a timeout as definitively failed.
- On known partial bulk success, retry only eligible failed entries, never the whole successful batch. On whole-request ambiguity, require an explicit retry/duplicate-risk policy.
- Coordinate SDK retry settings with queue retry settings so retries do not multiply invisibly. Use backoff/jitter for retryable throttles/transient failures; configuration/consent errors need repair, not retries.
- Do not retry merely because a delivery notification is delayed. Match asynchronous provider events to stored attempts, and retain the distinction between accepted and delivered.

SMTP uses 4xx for temporary errors and 5xx for errors requiring correction; these are **SMTP reply classes**, not interchangeable with HTTP 4xx/5xx interpretation. SES's SMTP guide supplies backoff examples and notes AWS SDK retries use HTTPS rather than SMTP. A connection loss after SMTP DATA acceptance has the same fundamental ambiguity risk. [S14]

## 8. Regions, tenant associations, and Global endpoints

Stored templates and their names/counts are regional. Sender identity verification, sandbox/production state, quotas, feedback configuration, SMTP credentials, and sending-authorization policies must be correct in each sending region. A template ARN's region is not a mechanism that makes an arbitrary cross-region template usable. These documents do not establish an unrestricted cross-account template-sharing feature. [S5][S15]

**Recommendation:** key mappings by AWS account + region + template name + OpenSend revision. Independently read/compare the deployed template content in each region; a matching name alone is insufficient.

Global endpoints accept `EndpointId` on both v2 send operations and route across a configured pair of regions. They do not support SMTP or VPC endpoint access. **Do not assume continuous automatic replication of every dependency.** The high-level guide says setup synchronizes key artifacts, but its detailed preparation section requires consistent identities, configuration sets, templates and sending limits, with console-assisted duplication and explicit manual exceptions. Event destinations, reputation/archiving options and various identity settings require attention; the guide recommends regularly synchronizing changes. [S17]

For `TenantName` sends, AWS explicitly requires referenced identities, configuration sets, and templates to be associated with the tenant. An OpenSend application tenant ID is not automatically an SES tenant, and adding a `TenantName` string is not authorization isolation by itself. Deep IAM/tenant controls belong in the account/credentials reference. [S1][S2][S16]

**Unknown / not validated here:** supported region combinations for every newest feature, provisioning timings, exact delivery behavior during endpoint failover, cross-region tenant readiness, hard bulk limits for many multi-recipient entries, and rendering behavior against actual customer templates. Source-model presence is not a claim of universal regional availability.

## Sources inspected

All links below were consulted directly or through official-documentation excerpts on 2026-09-08; mutable `latest` pages can change. The model source is pinned for reproducibility.

- [S1] [SES v2 SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html).
- [S2] [SES v2 SendBulkEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendBulkEmail.html).
- [S3] [AWS SDK v3 SendBulkEmailCommand](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sesv2/command/SendBulkEmailCommand), queried through Context7; also [SendEmailCommand](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sesv2/command/SendEmailCommand).
- [S4] [SES service quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html).
- [S5] [Using templates to send personalized email](https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-api.html).
- [S6] [BulkEmailEntry](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_BulkEmailEntry.html), verified against the model; [CLI v2 send-bulk-email](https://docs.aws.amazon.com/cli/latest/reference/sesv2/send-bulk-email.html).
- [S7] [Working with email attachments](https://docs.aws.amazon.com/ses/latest/dg/attachments.html).
- [S8] [Sending raw email using SES v2](https://docs.aws.amazon.com/ses/latest/dg/send-email-raw.html).
- [S9] [Template shape](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Template.html), verified against the model.
- [S10] [BulkEmailEntryResult](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_BulkEmailEntryResult.html).
- [S11] [TestRenderEmailTemplate](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_TestRenderEmailTemplate.html).
- [S12] [Advanced email personalization](https://docs.aws.amazon.com/ses/latest/dg/send-personalized-email-advanced.html).
- [S13] [SES header fields](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html).
- [S14] [SMTP issues and response codes](https://docs.aws.amazon.com/ses/latest/dg/troubleshoot-smtp.html).
- [S15] [Regions and SES](https://docs.aws.amazon.com/ses/latest/dg/regions.html).
- [S16] [Pinned botocore SES v2 service model](https://github.com/boto/botocore/blob/52ed7af8cb2183fb7fe6e34861924e74fbd952ad/botocore/data/sesv2/2019-09-27/service-2.json).
- [S17] [Using Global endpoints](https://docs.aws.amazon.com/ses/latest/dg/global-endpoints.html).
- [S19] [Classic SendRawEmail](https://docs.aws.amazon.com/ses/latest/APIReference/API_SendRawEmail.html), also available in the pinned classic model cited by the inventory.
- [S20] [Classic SendBulkTemplatedEmail](https://docs.aws.amazon.com/ses/latest/APIReference/API_SendBulkTemplatedEmail.html).
- [S21] [TrackingConfigurationOverrides](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_TrackingConfigurationOverrides.html), verified against the pinned model.
