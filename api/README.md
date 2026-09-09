# OpenSend API

One Hono/TypeScript API for Node/Docker and Cloudflare Workers. PostgreSQL is the source of truth; Drizzle defines typed tables, SQL migrations establish them, and a Postgres outbox drives sending and webhooks. R2/S3 holds private attachments. No Redis, D1, or Durable Objects.

The existing frontend is unchanged and is **not wired to this API yet**. The initial deployment serves one configured workspace/AWS connection. Customer connection enrollment and a template-library UI remain deferred.

## Run locally

The current experiment already has an ignored `.env` with generated local credentials, a local Postgres database and a private MinIO bucket. Live SES is disabled. The API uses port **8793**, because another experiment owns 8787.

For a fresh checkout:

1. Run `npm ci` in `api/`. Use Node.js 24 or newer. Copy `.env.example` to `.env`, fill `ADMIN_API_KEY` with at least 32 random characters, `ENCRYPTION_KEY` with 64 hexadecimal characters, and fill Postgres/S3 credentials. Keep `.env` private. `DATABASE_URL` can point at PlanetScale Postgres or any supported Postgres; use verified TLS for remote databases.
2. Start infrastructure with `docker compose -p opensend-api-local up -d postgres storage`, or supply your own Postgres/private S3 bucket. Create the bucket named by `S3_BUCKET` once through your storage provider. The local MinIO bucket can be created with the command below.
3. Run `npm run migrate` against the intended database. Migrations are explicit, serialized, and checksum-checked; they do not run automatically on HTTP startup.
4. Run `npm start` and `npm run worker` in separate terminals. Both load `.env`. For editing, `npm run dev` watches the API.
5. Run `npm test`. This is the **only acceptance-test file**, using the actual HTTP API and running job worker. Set `API_BASE_URL` and matching `ADMIN_API_KEY` to target a different deployment.

Create the local bucket, with credentials loaded from the ignored configuration:

```sh
node --env-file=.env --input-type=module - <<'JS'
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
const e = process.env;
const client = new S3Client({
  endpoint: e.S3_ENDPOINT, region: e.S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
});
await client.send(new CreateBucketCommand({ Bucket: e.S3_BUCKET }));
JS
```

Do not recreate an existing bucket; that command is fresh-install provisioning only. Do not run acceptance tests against unrelated production data: they create synthetic contacts/campaigns and retain audit records. The suite checks the server identity before sending credentials.

## Docker

```sh
docker compose -p opensend-api-local build api
docker compose -p opensend-api-local run --rm api node dist/migrate.js
docker compose -p opensend-api-local up -d api worker
```

Stop a host Node server on port 8793 first. The image runs as the unprivileged `node` user, contains compiled JavaScript and production dependencies, and excludes local secrets/test files. For managed Postgres/S3, run the same image with your environment configuration instead of the local Compose database/storage services. API command: `node dist/server.js`; worker command: `node dist/runner.js`. Multiple worker processes can claim jobs safely with row locks and leases.

## Cloudflare

`wrangler.jsonc` is a deployment template, **not a provisioned deployment**. Replace the placeholder Hyperdrive ID and public URL; provision the named R2 bucket and Queue in the intended Cloudflare account. Use a separate config/resource set for each deployment environment.

**Disable Hyperdrive query caching.** Authentication, consent, idempotency and job state require fresh reads. Configure the Hyperdrive connection with `--caching-disabled`; reducing TTL is not equivalent. Hyperdrive still provides connection pooling. See [Cloudflare query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

Required Worker secrets: `ADMIN_API_KEY`, `ENCRYPTION_KEY`. When deliberately enabling live SES, also supply `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and optional `AWS_SESSION_TOKEN` through Worker secrets. Use `wrangler secret put` interactively, never embed secrets in Wrangler config or command arguments. The environment-configured connection does not renew pasted temporary credentials automatically.

`npm run cf:check` bundles a deployment dry run without deploying. For local Workers, set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` securely to the local database URL, then run `npm run cf:dev -- --port 8794`. Match `PUBLIC_URL` to the runtime you are exercising. Local Hyperdrive does not test production pooling/caching; see [local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

The Worker has HTTP, Queue and scheduled handlers. Queue messages are wakeups only; committed jobs survive a lost wakeup. Cron recovers due jobs and performs hourly retention. Each invocation processes one leased job. A Postgres rotation gives live/test work a 3:1 preference with fallback when one environment is empty; within that environment, SES feedback precedes email dispatch and callbacks. Workers use a request-local lazy pool, so health/OpenAPI and missing/malformed-auth requests open no database connection. PostgreSQL transactions/leases—not process-local state—control dispatch.

## Contract and SDK

- `/openapi.json` is generated from the actual Zod route schemas. Stable operation IDs give the SDK readable method names.
- `npm run sdk` exports the specification, generates `../sdk/src`, and compiles the SDK. Never edit generated files.
- TypeScript is pinned to major 6: Hey API 0.99 uses the compiler API that TypeScript 7 no longer exposes. Dependency overrides pin patched `js-yaml` and `sharp` versions in the development toolchain.
- Collections return `{ data, nextCursor }`. A `202` response means queued, not delivered. Stored message/event state provides the outcome.
- Supply `Idempotency-Key` for retriable write submissions. Exact repeats return the recorded result; conflicting payloads return `IDEMPOTENCY_CONFLICT`. Requests without a key do not create permanent idempotency records.
- API keys are hashed at rest and partitioned into live/test environments. Test keys simulate sends without SES calls, real suppression effects or production engagement. Keep bootstrap management credentials server-side; dashboard session authentication is not implemented. Read/manage grants are workspace-level capabilities: sending-domain restrictions are not a general data-isolation boundary. Give integrations only the permissions they need.

See [SDK usage](../sdk/README.md). The generated contract is authoritative for exact field names; earlier research/chat examples are proposals, not compatibility aliases.

## Sending and operational boundaries

| Capability | Current behavior |
| --- | --- |
| Single / batch sending | Durable per-message jobs, up to 50 recipients per message and 100 messages per submission. Addresses are plain ASCII email strings (punycode domains supported); display-name address headers and arbitrary message metadata are not exposed yet. Batch results expose each message ID; no separate batch-status resource. Provider execution currently uses individual SES sends, not a native `SendBulkEmail` optimization. |
| Campaigns | Versioned drafts/reviews, recipient previews, scheduled sending and cancellation before dispatch. Initial review/import limits are 1,000 contacts/rows; larger audiences fail explicitly rather than truncate. |
| Templates | Stored SES templates use Get/TestRender/Get snapshots. Nested JSON data passes unchanged to SES; SES does not HTML-escape it. Callers own HTML-context escaping. The campaign editor's simple substitutions escape HTML independently. Test keys never claim their local placeholder result is a real SES render. |
| Attachments | JSON/base64 upload, private object IDs, inline image metadata, ownership/reference checks. Maximum 8 MiB total decoded attachments, 16 MiB estimated encoded message size, 512 KiB per direct body part, and a conservative file-extension allowlist. Stored SES-rendered raw templates cannot currently add structured attachments. No arbitrary attachment URL fetching. |
| Rate and retry | Shared regional quota reservations; no automatic replay of ambiguous provider acceptance. Six bounded transient attempts, with delays 15s, 1m, 4m, 16m and 1h. Failed jobs remain inspectable in Postgres/logs. |
| Webhooks | Ten selectable event types, seven operational defaults, signed deliveries, per-endpoint encrypted secrets, pause/resume and manual retries. `WEBHOOK_ALLOWED_HOSTS` is an exact, administrator-managed public-host allowlist. The normal suite uses paused `example.com` fixtures and never calls them. |
| SES feedback | Trusted regional SNS topics only, pinned AWS certificate URLs, RSA signature verification, deduplication and a durable ingestion outbox. Set `SNS_TOPIC_ARNS`; keep raw SNS envelope delivery enabled, not an unauthenticated raw-message bypass. |
| Unsubscribe | Immediate hosted GET and provider one-click POST; opaque persistent capabilities opt out of all marketing in the workspace. Repeated clicks are idempotent. Link scanners can trigger footer opt-outs by design. No preference-center UI yet. |
| Domain readiness | Returned SES DKIM zone is authoritative; missing DNS information is explicit, never guessed. Domain lists are capped at ten and use paced control-plane reads. The API does not create an AWS connection or replace your DNS records. |

Configure existing regional SES identities and configuration sets before enabling `ENABLE_LIVE_SES=true`. Live AWS IAM, real recipient MIME/delivery, authentic SNS delivery and public webhook delivery remain integration gates requiring explicit credentials/recipients. The API does not silently provision or enable paid AWS features.

## Errors, logs and retention

Errors have `{ error: { code, message, requestId, retryable, field? } }` and an `x-request-id` header. Search JSON logs by that ID. Dispatch records carry the originating request ID through the outbox. Logs record operation, job ID, attempt and error code—not request bodies, credentials or unsubscribe tokens. Unexpected failures retain stack frames server-side. API-key last-use timestamps are updated at most once a minute.

Examples: `AUTH_INVALID`, `PERMISSION_DENIED`, `VALIDATION_FAILED`, `CAMPAIGN_RECIPIENT_INVALID`, `STALE_CAMPAIGN_REVIEW`, `ATTACHMENT_LIMIT_EXCEEDED`, `SES_NOT_CONFIGURED`, `WEBHOOK_HOST_NOT_ALLOWED` and `SNS_TOPIC_NOT_ALLOWED`. Campaign validation errors identify the contact ID without exposing its address.

Detailed email/event/webhook logs expire after 30 days. Active jobs, campaign drafts, contact engagement timestamps, consent/suppression, idempotency results and valid unsubscribe links are separate. Unreferenced old attachment metadata is removed transactionally and storage deletion is queued durably. Failed storage-deletion jobs retain their object keys for recovery. Imported contact copies and retained campaign revisions require a later explicit data-lifecycle policy; do not claim that deleting a profile purges every audit/safety record.

## Security hardening

Run migration `005_security_budgets.sql` with `npm run migrate` before starting this version. It adds request budgets and the persistent live/test scheduler rotation; it does not delete application data.

- Campaign update/delete/cancel checks the **existing** sender scope. Dispatch rechecks the originating key under a row lock before committing an attempt. Revocation or permission loss cancels queued work with `ORIGIN_KEY_REVOKED`; it cannot recall in-flight or accepted mail. Bootstrap jobs are bound to the current admin-key fingerprint, so admin-key rotation also contains queued work. Legacy unbound `bootstrap` jobs fail closed after upgrade.
- Non-manage readers receive app unsubscribe capabilities redacted from message content, event data and webhook-delivery payloads, including nested fields/property names. Encoded raw MIME is withheld. This is not a general sanitizer for arbitrary third-party password-reset links: grant content-read access only to trusted integrations. HEAD unsubscribe returns 405 without changing consent. Audit sources distinguish `footer-get`, `rfc8058-post` and `ses-subscription`.
- Campaign placeholders are parsed with parse5 and limited to text nodes and explicitly supported quoted attributes. Unquoted attributes, comments, executable contexts and foreign markup are rejected. Complete URL values are validated **after** interpolation. Stored SES templates retain their separate, documented caller-escaping contract. Imports reject merged property maps above 50 properties atomically.
- Request and resource budgets are enforced in Postgres, with transactional admission locks for pending email and attachment quotas. These bound the primary amplification paths; test mode still consumes real infrastructure and is not a billing sandbox. Read/write database access and general test-management activity still require trusted credentials and operational monitoring.
- Cloudflare invocation URL logs and traces are disabled; sanitized application logs remain enabled. Coarse admission limits run before DB access: 6,000 requests/minute per connection peer/process on Node, or per Cloudflare IP/location using its approximate limiter. Node does not trust forwarded-IP headers. Use properly configured proxy/WAF limits for distributed abuse and validate every external log sink. Remote Node/migration Postgres URLs require `sslmode=verify-full`; only localhost and the local Compose `postgres` host may omit TLS.

| Budget | Test | Live |
| --- | --- | --- |
| Authenticated requests per key/minute | 600 | 1,200 (bootstrap: 2,400) |
| Outstanding emails per key | 100 | 2,000 |
| Outstanding emails per environment | 500 | 10,000 |
| Stored attachment bytes per environment | 64 MiB | 1 GiB |
| Expanded content per campaign/batch | 16 MiB | 128 MiB |

Budgets are initial code constants, not paid-plan entitlements. Cancellation releases pending capacity; attachment deletion releases stored-byte capacity. They do not promise unlimited throughput or total isolation of shared database CPU/storage.

### Encryption and notification setup

New webhook ciphertext includes a version and key identifier. To transition encryption keys, retain the old key as `PREVIOUS_ENCRYPTION_KEY` while setting the new `ENCRYPTION_KEY`. Both are 64 hex characters. Existing legacy ciphertext and prior-key records remain readable during the transition. Rotate endpoint signing secrets and update their consumers before retiring the previous encryption key; do not discard it while old ciphertext remains. Lost/unavailable keys produce `KEY_ROTATION_REQUIRED`, and permanent configuration errors terminate webhook jobs rather than repeatedly retrying them.

When `SNS_TOPIC_ARNS` is nonempty, `AWS_ACCOUNT_ID` is required. SES notifications must include that sending account ID at ingestion and processing; cross-account topic ownership is not mistaken for sender identity. This supplements, but does not replace, a restrictive topic publish policy. Prefer SNS SignatureVersion 2. SignatureVersion 1 remains compatible; an arbitrary short freshness cutoff was not added because it can discard legitimate delayed feedback. Validate genuine SNS retries and publisher permissions in the deployment environment.

**Release gates:** verify disabled Hyperdrive query caching in the actual provisioned connection, public HTTPS, private buckets, proxy/log-export redaction, least-privilege IAM/database/SNS policies, and authentic SES/SNS/webhook delivery. Local checks cannot certify these remote settings. Immediate footer GET unsubscribe and scanner-triggered opt-outs remain intentional.

## Verification performed

- Single acceptance file: 23 local HTTP/security scenarios passed; the one live-SES scenario is explicitly skipped unless `LIVE_SES_TEST=1`, `SES_TEST_RECIPIENT` and `SES_TEST_FROM` authorize it. Two historical-source fixtures arrange only exact HTTP-created test records in the matching local DB, then assert behavior over HTTP; remote runs require `API_FIXTURE_DATABASE_URL` or explicitly skip those fixtures.
- Strict API type check, OpenAPI/SDK generation and SDK compilation passed.
- Docker image built; generated SDK exercised authentication, Postgres, attachment storage and simulated submission against Node, Docker and local Workers. Docker and local Workers job execution also verified.
- Wrangler deployment dry run passed. No Cloudflare deployment, remote database migration, real SES send or public webhook test was performed.
- Two Fable 5.1 reviewers inspected the initial implementation; subsequent independent general/Fable blue-team findings drove the hardening above. A focused follow-up review found validation-order/fixture issues that were corrected. No additional test files were introduced.
- Security runtime probes verified current/previous/legacy encryption transitions, terminal webhook configuration failure with zero outbound calls, live/live/live/test dispatch preference, storage-budget rejection before object writes, and queued bootstrap-job cancellation after admin-key rotation. Workers health/OpenAPI and missing/malformed-auth responses succeeded against an intentionally unavailable database. The hardened Docker image passed SDK/Postgres and HEAD-admission smoke checks.
