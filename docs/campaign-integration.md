# Campaign execution and audience migration

Migration `014_campaign_runs.sql` adds asynchronous immutable recipient preparation, bounded expansion, compact shared email content, and durable campaign counters. Migration `015_audience_sync.sql` adds resumable CSV imports and one-way CRM synchronization. Apply them after `013_template_library.sql` using the installation's normal migration process. Do not migrate a live database or deploy without operator approval.

## Campaign lifecycle

Select a published template or use the existing block editor, choose the sender and audience, and review. `POST /v1/campaigns/:id/prepare` freezes up to 250,000 matching contacts and validates eligible recipients in batches of 100. Poll `/preparation` until `ready`; send or schedule with that review ID and campaign revision. Edits invalidate the review. Frozen membership and profile values do not change during expansion; current suppression, consent, credentials, and sending eligibility are checked again by the existing dispatch guards.

Expansion queues 100 live recipients per transaction (20 in test), within the existing pending-send limits. Each recipient records its email ID atomically with queue admission, so worker retries do not create another send. HTML/text are stored once per run and personalized from immutable recipient snapshots when read or dispatched. Scheduled work stays durable in PostgreSQL. A failed preparation can be prepared again; a failed expansion can be resumed through `/resume-expansion`, which only queues recipients without an email record. It does not retry rejected messages or ambiguous provider acceptance. Cancellation stops queued work and future expansion; in-flight or accepted sends cannot be recalled.

The original synchronous review endpoint remains available for existing small-audience clients. New dashboard reviews use asynchronous preparation. SDK and MCP expose the same API contract.

## Dashboard performance

The campaign screen shows validated recipients, processed/remaining counts, rate and estimated time, recipient status pages, and distinct-message delivery, bounce, complaint, open, click and unsubscribe outcomes. Sending completion is independent of delivery feedback. Delivery/bounce/complaint rates use accepted messages; open/click/unsubscribe rates use delivered messages. Opens and clicks are observed activity and may include privacy proxies and automated scanners. No sales attribution is implemented.

Counters and UTC daily outcomes survive the existing 30-day email/event log retention. Recipient detail and compact source content for completed/canceled runs expire once the run is over 30 days old and no retained email references it. Raw committed CSV rows and CRM error details also expire after 30 days. Historical pre-migration totals can only be backfilled from logs still present at migration time. SES configuration-set feedback/tracking must already be enabled through the installation's regional setup for live delivery and engagement data.

`WORKER_CONCURRENCY` defaults to 8 (1–32). The Node runner drains concurrently; Cloudflare background invocations also drain a bounded parallel group. PostgreSQL remains the durable queue and existing regional SES pacing still applies. Start with 8 and measure on the actual database/hosting setup.

The target of 250,000 recipients in four hours requires more than 17.36 accepted messages/second, enough SES daily quota for the full audience and other traffic, and appropriate regional rate headroom. The synthetic benchmark below validates 250,000-recipient preparation and a bounded simulated-dispatch sample; it is not a guarantee of real SES throughput or delivery time. Run a separately approved live canary and quota review before retiring the old sender.

## CSV migration

Use **Audience sync** to upload a CSV (maximum 32 MiB, 250,000 records), select a list, and explicitly map email/name columns. Other columns become contact properties; first-name aliases are retained for legacy templates. Browser parsing handles quoted fields, ordered chunks carry checksums, and the server deduplicates normalized emails across the entire import. Re-selecting the same file and mapping resumes the recorded local import. Review row errors before committing.

Importing contacts does not invent subscription evidence or clear opt-outs/suppression. Existing contacts retain their consent. New profiles are unknown until consent is recorded through the normal API or verified CRM evidence. The import API supports ordered chunks of up to 1,000 mapped JSON rows and checkpointed commits; it does not require a new sender CLI.

## CRM read-only mapping

Configure `CRM_DATABASE_URL`, `CRM_LIST_ID`, `CRM_CONTACTS_VIEW` (default `public.opensend_contacts`) and optionally `CRM_SYNC_MINUTES` (default 15; minimum 5). Remote PostgreSQL requires `sslmode=verify-full`. Grant that credential only `CONNECT`, schema `USAGE`, and `SELECT` on the operator-owned canonical view. The sync opens a read-only transaction and never writes to CRM. It runs only in OpenSend's live environment; use synthetic CSV imports for test.

The source `crm_contacts` schema was not supplied. Create a view that explicitly maps the real columns to this contract; do not run guessed SQL against production:

| Canonical column | PostgreSQL type and meaning |
| --- | --- |
| `source_id` | Non-null unique stable text ID |
| `email`, `name` | Email text and nullable name text |
| `properties` | JSONB object, at most 50 supported scalar properties |
| `updated_at` | Non-null `timestamptz`, updated on every profile/consent/deletion change |
| `deleted` | Boolean tombstone; removes the mapped list membership |
| `consent_status` | `unknown`, `subscribed`, or `unsubscribed` |
| `consent_source`, `policy_version`, `evidence` | Nullable text proof of subscription |
| `consent_at` | Nullable `timestamptz` of consent, never in the future |

Use stable text ordering for `(updated_at, source_id)` and an index supporting it on the underlying data. Retain tombstones: hard-deleted source rows cannot be detected by incremental queries. Timestamp values must advance when records change; backdated updates or changes that become visible after the checkpoint has passed can be missed. For sources without these guarantees, provide a CDC-backed canonical view before enabling recurring sync.

Each pass takes a cutoff and reads 500 rows per page. Invalid rows are reported by source ID/code; they must receive a newer `updated_at` after correction to be revisited. Subscription requires all evidence fields and can only move a locally unknown contact to subscribed. A CRM unsubscribe is respected; an OpenSend unsubscribe or suppression is never cleared. Email changes update the source mapping and remove old membership. Tombstones preserve the local contact and its consent audit. Avoid mapping multiple source IDs to the same email if they have independent membership lifecycles.

The dashboard exposes last success, progress and failures; `/v1/audience-sync/errors` supplies paginated error details. **Refresh now** retries from the checkpoint after connection/view issues are resolved. Scheduled polling recovers missing queue wakeups. Changing the source or destination list requires a deliberate checkpoint/membership migration; it is not an automatic historical resync.

## Verification and rollout

From `api/`, run `npm run test:isolated` for disposable Docker PostgreSQL and memory object storage. It never reads `.env`, uses no production database or AWS credentials, and sends no real email. `npm run benchmark:isolated` additionally prepares 250,000 synthetic recipients and measures a 1,000-message simulated sample with progress-read latency and memory reporting.

Review/merge template authoring first, then this campaign/CRM change. Configure authoring/storage, audit and import legacy drafts, verify automation fields and legacy SES names, map the CRM view, and run test campaigns before explicitly approving deployment, publication and a live canary. Keep the Python mailer available during validation; retire its scheduling only after equivalent campaigns and consent behavior are verified in OpenSend.

Local verification on 2026-09-10: 250,000 recipients prepared in 343.233 seconds; a 1,023-message simulated sample took 23.352 seconds (43.81/s), with maximum progress-read latency 43 ms and fixture peak RSS about 288 MiB. The dispatch-rate projection is 1.59 hours for 250,000 messages, excluding preparation, live SES/network latency and other workload. This is a bounded sample, not a full 250,000-message dispatch soak.
