# Delivery events and observability

[Hub](README.md) · Researched 2026-09-08 · Documentation research, not a tested AWS integration.

## Core distinction: accepted is not delivered

A successful send response means SES accepted a message for processing, not that it reached a mailbox. Template rendering, virus scanning, suppression, remote SMTP rejection, retries and complaints can happen afterwards. A delivery event means acceptance by the recipient's mail server, not inbox placement or human reading. [E1][E2]

**Recommended OpenSend model:** store immutable send attempts and an append-only event history, with separate delivery, engagement and consent projections. Do not implement one strictly linear status enum: a complaint may arrive after delivery, a delivery delay may precede eventual success, and an open may come from automation. Associate the provider message ID with the exact account, region, connection and optional SES tenant. A missing event is `unknown`, not proof of failure or success.

## Choose an event ingestion path

| AWS mechanism | What it supplies | OpenSend implication |
| --- | --- | --- |
| Configuration-set event destination | Sends, rendering failures, rejects, deliveries, bounces, complaints, delays, subscriptions, opens and clicks | Preferred message lifecycle feed; attach the intended configuration set on every send or explicitly verify the identity default |
| Identity SNS feedback notifications | Bounce, complaint and delivery feedback per identity/region | Useful for existing customer infrastructure; format differs from event publishing |
| CloudWatch destination / account metrics | Aggregates and dimensions | Not an individual-message audit log; watch cardinality and cost |
| Data Firehose destination | Streamed event data for downstream storage/analytics | Optional analytics/archive path; needs separate permissions and storage design |
| EventBridge destination | Routing to rules/targets, plus SES operational events | AWS labels SES service-to-EventBridge delivery **best effort**; target retries do not repair events that never reached the bus |
| Pinpoint destination | Still listed in SES destination docs | Do not choose for a new dependency: AWS ends Pinpoint support October 30, 2026 [E12] |

Sources: destination types and matching event types [E1]; identity feedback [E3]; EventBridge service delivery semantics [E4]. The list of events a destination supports is not identical for every destination: SES documents that Pinpoint excludes delivery delays and subscriptions. Do not infer a subscription EventBridge `detail-type` from the API enum without checking that destination's schema.

**Recommended default:** customer-owned regional SNS topic → SQS standard queue → OpenSend consumer, or verified SNS HTTPS delivery when operating outside AWS. Choose one first rather than maintaining several independently authoritative streams. Durable queueing, retries and dead-letter handling improve downstream reliability; do not advertise end-to-end exactly-once or lossless SES telemetry. Existing customer event destinations must not be overwritten.

## Event types and meaning

| Configuration API enum | Event payload meaning | Required handling |
| --- | --- | --- |
| `SEND` | SES accepted the request and attempts processing | Accepted only; not delivery proof |
| `RENDERING_FAILURE` | Template could not render | Persist template/version and error; do not blindly retry same data |
| `REJECT` | SES accepted but refused further processing, e.g. virus detection | Distinguish from synchronous API rejection |
| `DELIVERY` | Recipient mail server accepted | Save recipients, processing time, remote response where provided |
| `DELIVERY_DELAY` | Temporary delivery issue | SES may still retry; do not immediately resubmit from OpenSend |
| `BOUNCE` | Permanent/transient/undetermined outcomes with subtypes | Apply policy to affected recipients, not every address in the original request |
| `COMPLAINT` | Feedback or suppression-related complaint subtype | Suppress appropriately and preserve raw classification |
| `OPEN` | Tracking pixel request | Engagement signal, not a reliable unique-human count |
| `CLICK` | Tracked link request | May be repeated, bot-generated or security-scanner generated |
| `SUBSCRIPTION` | Contact list/topic preference change | Update consent projection, preserving old/new preferences |

API enum spelling is not the payload spelling. SNS configuration-set payloads use values such as `Delivery` and `Rendering Failure` in `eventType`; identity notifications use `notificationType`; EventBridge uses an outer `detail-type` and `detail`. Build explicit adapters and preserve unknown future fields/types. [E1][E2][E3][E4]

### Payload fields worth preserving

- Mail metadata: provider `messageId`, timestamp, source/source ARN, `sendingAccountId`, destination addresses and SES tags. Sending authorization can make the source identity owner different from the sending account. Headers and common headers can be present, and headers may be truncated. [E2]
- Recipient detail: bounced/complained recipients, status and diagnostic codes, bounce type/subtype, remote MTA details where available. A complaint does not necessarily identify every original recipient as a complainant. [E2]
- Template rendering error and template name; subscription contact list, old/new topic preferences and unsubscribe-all changes. [E2]
- Tracking metadata: timestamp, link, IP address, user agent, link tags and optional `isBotEvent`. These can be personal data. [E2]
- Transport identity: topic ARN + SNS message ID, queue ID, or EventBridge event ID/account/region. Do not confuse a transport message ID with SES `mail.messageId`.

**New in August 2026:** Open and Click notifications have `isBotEvent` values **`Likely` / `Unlikely`**, not a boolean. It is a likelihood signal, not a guarantee. Existing historical events may lack it. Store raw and bot-filtered engagement separately; never translate missing to `Unlikely`. [E5]

## Secure ingestion and deduplication (OpenSend recommendations)

1. Authenticate the source before processing. For SNS HTTPS, verify signatures and allowlist the expected topic ARN; validate HTTPS signing-certificate URLs and their origin/chain, not an arbitrary URL supplied in the body. Verify confirmation messages too. Do not blindly follow `SubscribeURL` from an untrusted POST. AWS supports SNS signature versions 1 and 2 and recommends SHA-256 version 2. [E6]
2. Persist the incoming envelope before acknowledging it. Apply body-size limits, schema validation, encryption and retention. With SNS→SQS, choose and document whether raw message delivery is enabled; this changes the envelope. Lock down topic/queue/KMS resource policies.
3. Deduplicate transport redelivery by trusted transport ID + source. Semantic duplicates can arrive via overlapping destinations: correlate event type, provider message, recipient, time and feedback identifiers. Do not deduplicate all opens/clicks by just message ID; real repeat interactions exist.
4. Update projections idempotently and tolerate out-of-order arrival. Route only to the tenant/connection established by trusted infrastructure and provider metadata. A user-supplied tag alone is not authorization.
5. Retry transient consumer failures, quarantine poison messages, monitor lag and replay dead letters explicitly. Customer webhooks need a separate signed payload, event ID, retry schedule and replay mechanism—not an unauthenticated forward of AWS payloads.

No signature-verification library or implementation has been selected or tested by this research. Check the chosen SDK/library's exact SNS validation support before coding; installing `@aws-sdk/client-sns` does not by itself prove inbound validation exists.

## Feedback coverage is a sending prerequisite

AWS requires a way to receive bounce/complaint notifications. If feedback forwarding is disabled but the expected event configuration is omitted, SES can still forward feedback to Return-Path/Source. Identity feedback topics are regional. If an identity's bounce/complaint SNS topic is deleted or loses publish permission, SES can remove that configuration and re-enable email feedback. [E3][E7]

**Recommended readiness check:** configuration set exists, destination is enabled, required event types are selected, target resource policies permit SES delivery, subscription/consumer is active, and a controlled simulator message is observed end to end. Reading destination configuration alone proves no delivery path. Recheck after credential rotation, customer edits, and region changes.

## Quota counters, aggregates and message history are different products

| Question | Source | Caveat |
| --- | --- | --- |
| How much can this account-region send now? | `GetAccount.SendQuota` | Regional rolling recipient quota, not a campaign dashboard |
| How much did OpenSend enqueue/attempt/accept? | OpenSend send ledger | Does not automatically include sends outside OpenSend |
| What happened to a particular message? | Event ledger; optionally `GetMessageInsights` | Event collection must be configured; VDM has coverage/history limits |
| How healthy is sending? | CloudWatch, SES reputation, VDM | Aggregation windows and denominators differ |
| Did it land in the inbox? | Optional placement testing/global deliverability | SMTP delivery alone cannot answer |
| What did AWS charge? | AWS billing/cost data and selected SES plan | SES send counters are not a billing API |

VDM dashboard metrics only include single-recipient messages, exclude mailbox simulator traffic and exclude mail sent through a delegate sender's account (sending authorization). Do not generalize that exclusion to AssumeRole: assuming a customer role sends as that account, unlike identity delegation. Dashboard metrics can use ranges up to 60 days; the message search UI searches messages sent in the last 30 days. Treat these as documented product windows, not an unlimited archival promise for `GetMessageInsights`. Metrics are near-real-time; message details appear within minutes, not synchronously with the send response. [E8]

`BatchGetMetricData`, `CreateExportJob`, `GetExportJob`, `ListExportJobs` and `GetMessageInsights` supply analytics/export capabilities; they do not replace an owned campaign database. Export jobs are asynchronous; handle progress, failure and expiring/downloadable outputs carefully. [E8]

## Tracking, privacy and rendering effects

Configuration-set open/click tracking is separate from VDM engagement tracking: disabling one does not disable the other. Tracking can rewrite links and alter content; validate DKIM and raw MIME behavior with actual recipients. Custom tracking domains are an explicit configuration/DNS concern. [E1][E9]

The current send model also exposes **per-request `ConfigurationOverrides.Tracking`** with `OpenTrackingEnabled` / `ClickTrackingEnabled` string values `ENABLED` or `DISABLED`. These overrides do not create an event destination and apply to the whole request, including all bulk entries. See [sending and templates](sending-and-templates.md) for the exact model and precedence caveats; do not rely only on old examples that omit this field.

**Recommended product controls:** transactional tracking off by default; customer-configurable marketing tracking; no secrets in tags or tracking URLs; short retention for IP/user-agent data; distinguish total/unique/bot-filtered counts and missing telemetry. Tracking pixels, prefetch, blocked images and scanners mean engagement metrics are approximate even with `isBotEvent`.

## Optional archiving and deliverability products

SES supports outbound archiving through a configuration set referencing a Mail Manager archive. It is **not** enabled by basic sending. Archive management uses the Mail Manager service/API and can involve KMS. The documented default retention is 180 days; deletion is delayed 30 days. Treat archiving, content retention and deletion as separate paid, customer-approved capabilities. [E10]

Global deliverability can monitor domains across providers/accounts/regions and provide campaign analytics, inbox placement and blocklist information. This is not the same feature as SES Global Endpoints routing. The feature is enabled regionally and has distinct pricing. [E11]

## Future integration verification checklist (not executed)

| Scenario | Evidence required |
| --- | --- |
| Simulator success/bounce/complaint | SDK response correlated with received, authenticated provider event |
| Rendering failure after send acceptance | Accepted attempt later classified failed, no duplicate send |
| Destination disabled, permission lost or config omitted | Readiness warning and missing-telemetry distinction |
| Duplicate/out-of-order event | One correct projection, preserved legitimate repeat engagement |
| Fake SNS POST / unexpected topic / invalid certificate URL | Rejected before state mutation or arbitrary URL fetch |
| Global endpoint routes to secondary region | Correct source region, account, tenant and message correlation |
| Customer webhook times out | Independent retry without resending the email |
| SES suppression / unsubscribe / auto-validation | Distinct reasons; not all presented as invalid mailbox |

See [verification matrix](implementation-decisions-and-verification.md) for the broader plan.

## Sources

All inspected on 2026-09-08; URLs are rolling AWS docs unless dated.

- [E1] [Creating SES event destinations](https://docs.aws.amazon.com/ses/latest/dg/event-destinations-manage.html)
- [E2] [SNS event publishing payload contents](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)
- [E3] [Setting up SES event notifications](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications.html)
- [E4] [SES EventBridge events and delivery type](https://docs.aws.amazon.com/eventbridge/latest/ref/events-ref-ses.html) and [delivery levels](https://docs.aws.amazon.com/eventbridge/latest/ref/event-delivery-level.html)
- [E5] [August 2026 automated open/click identification announcement](https://aws.amazon.com/about-aws/whats-new/2026/08/amazon-ses-automated-email-interactions)
- [E6] [Verifying SNS signatures](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)
- [E7] [Configuring SNS notifications for SES](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html)
- [E8] [VDM dashboard and metric/message APIs](https://docs.aws.amazon.com/ses/latest/dg/vdm-dashboard.html)
- [E9] [Monitoring SES activity](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity.html)
- [E10] [Email archiving](https://docs.aws.amazon.com/ses/latest/dg/eb-archiving.html)
- [E11] [Global deliverability](https://docs.aws.amazon.com/ses/latest/dg/vdm-global-deliverability.html)
- [E12] [Pinpoint end of support: October 30, 2026; new customers stopped May 20, 2025](https://docs.aws.amazon.com/pinpoint/latest/userguide/migrate.html). AWS End User Messaging SMS/voice/push/OTP/phone validation APIs are not part of this retirement.
