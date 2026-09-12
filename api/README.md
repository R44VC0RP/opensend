# OpenSend setup and operations

One Hono/TypeScript API for Node/Docker and Cloudflare Workers. The dashboard and generated SDK use that same public API; MCP discovers its OpenAPI contract. PostgreSQL is the source of truth, a Postgres outbox drives sending/webhooks, and private R2/S3 stores attachments. No Redis, D1, Durable Objects, passwords, teams, or production admin bypass.

## Large campaigns

Existing `POST /v1/campaigns/{id}/review` clients retain their completed-only `200` response and existing limits. The normal send/schedule request needs only the current `revision`: when `reviewId` is omitted, OpenSend snapshots and validates the audience durably, then begins delivery automatically. The `202` response means the complete background workflow was accepted, not that validation or SES delivery has finished. Existing callers may still pass a completed `reviewId` unchanged.

To inspect counts before committing to delivery, call `POST /v1/campaigns/{id}/reviews` with `{ "revision": ... }`, then poll `GET /v1/campaigns/{id}/reviews/{reviewId}`. `pending` and `processing` are not completed reviews; only `ready` can be passed to send/schedule after user confirmation. The dashboard and generated SDK can use this explicit preview flow. MCP intentionally hides preparation IDs: `deliverCampaign` accepts only the campaign revision and runs preparation automatically.

An audience is captured with one database snapshot. Only referenced personalization properties are copied into immutable recipient rows; the rendered base email is shared. Preparation validates every message before `ready`. Send/schedule returns the unchanged `202` receipt with the number of durable recipient intents; email rows are materialized progressively rather than all existing immediately. Future schedules reserve capacity without filling the active dispatch buffer. Optional campaign `expansion` metadata reports progress and errors; its `canceled` count is unmaterialized cancellations, separate from canceled email rows. Final personalized audit snapshots are saved at dispatch. Failed expansion is visible and cancelable; never manually replay an uncertain SES send.

| Bound | Current implementation |
| --- | --- |
| Matching contacts per background review | 1,000,000, before consent/suppression filtering |
| Concurrent review execution | Bounded by worker/runner job concurrency; additional reviews remain durable queue work |
| Referenced personalization snapshot | 1 GiB per review, 1 MiB per recipient |
| Estimated final content | 64 GiB per campaign; attachments remain shared references |
| Preparation/expansion chunk | Up to 100 recipients; byte-bounded processing |
| Active campaign dispatch buffer | 200 emails per campaign, 1,000 per environment |
| Outstanding campaign intents | 1,000,000 per originating credential; 2,000,000 per environment |
| Active jobs per process/invocation | `JOB_CONCURRENCY`: default 2, maximum 8 for Node and 4 for Cloudflare |

These are application bounds, not a guaranteed SES send rate. All workers share regional permits, respect provider throttling, and use short database leases; no SES request holds a database transaction. Rate utilization depends on provider latency, database latency, available connections, and total worker concurrency. Direct/legacy sends retain their separate existing pending limits. Use a staged load test before increasing consumer/replica counts, especially with a small Hyperdrive origin pool. The included Cloudflare configuration allows eight concurrent queue invocations with four active jobs each; `JOB_CONCURRENCY` controls parallel work inside each invocation. Node runners can be replicated against the same database.

Apply migration `017_scalable_campaigns.sql` before deploying this backend. For Docker, stop old runners and upgrade API/runner images together before accepting background preparations; old runners do not recognize the new job types. Do not roll back to an older backend while new-format reviews or campaigns are active. Existing reviews and emails use the legacy storage path without a content backfill. This release adds public API operations; it does not change the old review response or require existing integrations to adopt asynchronous preparation.

## Configuration

Use Node.js **24** and Docker Compose for the local quickstart. All commands below run from `api/` unless stated otherwise.

```sh
npm ci
cp .env.example .env
```

Fill `.env` locally; never commit it or paste credentials into the dashboard. Generate each secret independently with:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

| Setting | What to enter |
| --- | --- |
| `BETTER_AUTH_SECRET` | At least 32 random bytes, such as the 64-character hex output above. This is the installation root secret for authentication and domain-separated webhook encryption. |
| `JOB_CONCURRENCY` | Optional active background jobs per process/invocation. Defaults to 2; capped at 8 for Docker/Node and 4 for Cloudflare. Increase only after measuring database and SES latency; the shared regional permit gate still enforces SES send rate. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Your installation's real Google OAuth **Web application** client credentials. See below. |
| `AUTH_ALLOWED_EMAILS` | Comma-separated exact Google email addresses. Use this for personal Gmail accounts. |
| `AUTH_ALLOWED_DOMAINS` | Optional comma-separated exact Google Workspace hosted domains, checked against Google's verified `hd` claim—not an email suffix. Either allowlist can approve a user; missing/empty lists deny everyone. All approved users are admins. |
| `PUBLIC_URL` | Canonical external **origin**, without path, query, fragment, or credentials. HTTPS is required except for local sign-in/development at `localhost` and `127.0.0.1`. Docker default: `http://127.0.0.1:8793`; AWS provisioning requires a public HTTPS origin. |
| `DEFAULT_SES_REGION` | Initial region, default `us-east-1`. Migration seeds the database once and also imports already-used regions to avoid stranding existing work. Subsequent region/default changes use the API, not this environment value. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Explicit server-only IAM credentials for SES discovery, provisioning, and live sending; the session token is optional for temporary credentials. No automatic role lookup or token renewal. |
| `POSTGRES_PASSWORD`, `DATABASE_URL` | Generate a password and substitute the same value into the local database URL. Compose supplies its internal database hostname automatically. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Local MinIO credentials; use a nonempty access ID and a strong generated secret. The local bucket is created separately below. |

Keep `ENABLE_LIVE_SES=false` initially. `ADMIN_API_KEY`, public `WORKSPACE_ID`, and a separate `ENCRYPTION_KEY` are **not fresh-install settings**. There is no seeded production administrator: access comes only from an approved Google identity. See [upgrade restrictions](#secret-rotation-and-upgrades) before reusing an older database.

## Google sign-in

Each installation needs its own Google OAuth client. See Google's [OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect) and [OAuth production readiness guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).

1. Configure the consent screen in your Google Cloud project. For personal Gmail or mixed users, choose an **External** audience. While the app is in **Testing**, add every intended account as a test user; publish to production when appropriate and complete any Google-required review. For a Workspace-only installation, an **Internal** audience can restrict access to that organization.
2. Create an OAuth client with application type **Web application**. Add your exact `PUBLIC_URL` as an authorized JavaScript origin and `PUBLIC_URL/api/auth/callback/google` as an authorized redirect URI. For default Docker setup these are `http://127.0.0.1:8793` and `http://127.0.0.1:8793/api/auth/callback/google`.
3. Copy the client ID and secret into the server's configuration. The login requests only `openid`, `email`, and `profile`; it does not request Gmail/mailbox access.
4. Allow your intended identities with `AUTH_ALLOWED_EMAILS` or `AUTH_ALLOWED_DOMAINS`. Personal Gmail must be allowed by exact email; setting `AUTH_ALLOWED_DOMAINS=gmail.com` is not a substitute. Domain approval requires Google's Workspace `hd` claim. Never use wildcards.
5. Start the app and sign in through its dashboard. Google consent audience/test-user approval and OpenSend's allowlist must **both** permit the account. Check the exact scheme, hostname, and port if Google reports a redirect mismatch.

Changing from Docker to Vite, or to a public HTTPS origin, requires matching `PUBLIC_URL` **and** Google origin/redirect entries. Fake Google client credentials are only useful for controlled mocked acceptance checks; they cannot complete normal browser login. A real Google login has not been verified by the local acceptance suite.

## Docker quickstart

The image bundles the dashboard with the API on one origin, **http://127.0.0.1:8793**. The API and background worker are separate services using the same image and database. Stop any host API using port 8793 first.

1. Start the local infrastructure after completing `.env`:

   ```sh
   docker compose -p opensend-api-local up -d postgres storage
   ```

   Postgres is exposed on `127.0.0.1:55432`; MinIO on `127.0.0.1:59000`. Wait until both services are ready before provisioning the bucket.

2. Create the private local bucket **once on a fresh installation**:

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

   Do not recreate an existing bucket or make it public. Managed storage can instead be provisioned through its provider.

3. Build and apply migrations to the intended database:

   ```sh
   docker compose -p opensend-api-local build api
   docker compose -p opensend-api-local run --rm api node dist/migrate.js
   ```

   Migrations are explicit, serialized, and checksum-checked. HTTP startup does not run them automatically.

4. Start both processes:

   ```sh
   docker compose -p opensend-api-local up -d api worker
   ```

   Open `http://127.0.0.1:8793` and sign in using your approved Google account. The image runs as the unprivileged `node` user and excludes local secrets/test files.

5. In the dashboard's **API keys** page, create a scoped **test** key (`os_test_…`). Choose test in the key-creation environment selector; key creation uses the live administrator context. Use the key for simulated SDK/MCP calls, not the Google client secret or a session cookie. Test mode still writes real local data and consumes infrastructure.

For managed infrastructure, run the same image with your actual database/private storage settings rather than the local Compose overrides. API command: `node dist/server.js`; background worker: `node dist/runner.js`. Multiple workers use Postgres row locks and leases to claim jobs safely. Put public deployments behind HTTPS, with `PUBLIC_URL` set to the browser-visible origin.

## Local development

Use the same local Postgres/MinIO and bucket as above, but stop Docker's `api`/`worker` before running host processes. Keep Node.js 24 active in each terminal.

1. Set `PUBLIC_URL=http://127.0.0.1:5173` in `api/.env`. Configure the Google client origin `http://127.0.0.1:5173` and redirect `http://127.0.0.1:5173/api/auth/callback/google`. Keep `PORT=8793`, `API_BASE_URL=http://127.0.0.1:8793`, and host-local Postgres/S3 URLs.
2. From `api/`, run `npm run migrate`, then `npm run dev`. The API listens on **8793**.
3. From `api/` in a second terminal, run `npm run worker`.
4. From `app/` in a third terminal, run `npm ci`, then `npm run dev`. Open **http://127.0.0.1:5173**; Vite proxies the API/auth requests to 8793, keeping browser authentication on one origin.
5. Sign in with your real approved Google account. No browser API URL/secret configuration is required. Fake Google credentials do not unlock the dashboard.

Use `npm start` instead of `npm run dev` for a non-watching host API. Both API and worker load `api/.env` when run from `api/`.

## Database and storage

Use ordinary PostgreSQL, including managed providers such as PlanetScale Postgres. For remote Node/migration connections, require `sslmode=verify-full` and a verifiable certificate; do not disable certificate validation. Only localhost and the local Compose `postgres` hostname may omit TLS. Use your provider's actual **Postgres** connection URL, with URL-encoded credentials. For PlanetScale pooled URLs, follow its current pooler restrictions and use a supported direct connection for migrations if the pooler cannot support migration locking/session behavior. Do not substitute a MySQL connection string. See [PlanetScale Postgres connections](https://planetscale.com/docs/postgres/connecting).

Attachments belong in a **private** S3/R2 bucket. Set the bucket, region, endpoint, and storage credentials for your provider; never put them in client-side environment variables. Local MinIO root credentials are development-only—not a recommended production access policy. Keep database and object-storage backups together. Object keys belong to the installation's data namespace; do not rename/move them casually during upgrades.

## Cloudflare

`wrangler.jsonc` contains the production bindings for **https://opensend.anoma.ly**. To self-host in another account, replace `account_id`, the custom-domain route and `PUBLIC_URL`, the Hyperdrive ID, and the R2/Queue names with your own resources. Do not reuse production bindings for staging or preview builds. The dashboard build is served from `app/dist` as Workers assets on the API's origin.

Use a read/write database role for Hyperdrive and a separate schema-owner credential for direct Node migrations. Configure Hyperdrive origin TLS as `verify-full`; Cloudflare requires an uploaded CA certificate ID for that mode. The deployed connection uses the validated ISRG Root X1 trust anchor. Node migration connections accept PlanetScale's `sslrootcert=system` URI parameter without treating it as a filesystem path, while retaining certificate and hostname verification.

**Disable Hyperdrive query caching** with `--caching-disabled`; a shorter TTL is not equivalent. Authentication, consent, idempotency, and job state need fresh reads. Hyperdrive still provides pooling. See [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

Supply `BETTER_AUTH_SECRET` and `GOOGLE_CLIENT_SECRET` using Worker secrets; configure your real `GOOGLE_CLIENT_ID`, allowlists, and HTTPS `PUBLIC_URL` for this deployment. This deployment also stores `GOOGLE_CLIENT_ID` and the allowlists as Worker secrets rather than committing those installation values. For AWS discovery, explicit provisioning, or live SES sending, also supply `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN` securely. Use interactive `wrangler secret put`, not secrets in config or command arguments. Pasted temporary credentials are not automatically renewed.

Build `app/` with `npm ci` and `npm run build` before `npm run cf:check` in `api/`. `cf:check` is a deployment **dry run**, not a deployment or remote-resource check. For local Workers, keep an ignored `api/.dev.vars` containing only the required Worker settings and secrets, including both Google credentials, allowlists, `BETTER_AUTH_SECRET`, and the local `PUBLIC_URL`. This avoids loading unrelated Docker/storage credentials from `.env`. Securely set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, then use `npm run cf:dev -- --port 8794 --local-upstream 127.0.0.1:8794 --upstream-protocol http` and a matching `PUBLIC_URL`/Google callback. The explicit local upstream prevents Wrangler from rewriting same-origin authorization headers to the production custom domain. Local Hyperdrive cannot certify production pooling/caching; see [local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

HTTP, Queue, and scheduled handlers share the outbox. Queue messages are wakeups; committed jobs survive a lost wakeup. Workers consume one wake signal per queue invocation and stop claiming new jobs after a two-second turn, while allowing every in-flight job to finish. Campaign expansion emits one signal per configured local claim-lane group, capped at 100, after committing new email jobs so Queues can observe enough backlog to scale out. Cron recovers due work and performs hourly retention. Scheduling prefers live/test work 3:1 with fallback and reserves one feedback-first lane when concurrency exceeds one. PostgreSQL transactions/leases, not wake messages or process-local state, control dispatch.

Apply migration `018_wake_coalescing.sql` before deploying this Worker; singleton wake coalescing requires its nullable `job_schedule.wake_not_before` column. Singleton notifications share a one-second window per workspace and are delayed one second; larger bursts and queue/scheduled continuations remain ungated.

### Automatic deployments

Pushes to `main` deploy through [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): it installs both packages, type-checks the API, builds the dashboard, and runs `wrangler deploy` from `api/`. It needs a `CLOUDFLARE_API_TOKEN` repository secret created from the **Edit Cloudflare Workers** token template, scoped to this account. Other branches do not deploy; give them separate database, bucket, queue, and credentials before enabling that. Schema migrations remain an explicit step using the migration role, not an automatic side effect of deploying code.

The XML-builder alias in Wrangler selects the AWS SDK's non-browser parser: Workers do not provide `DOMParser`. Outbound certificate, confirmation, and webhook requests use manual redirect handling and reject non-success responses without following redirects.

## SDK and MCP

- `/openapi.json` comes from the actual Zod route schemas; stable operation IDs define generated SDK methods. `npm run sdk` exports the contract, generates `../sdk/src`, and compiles it. Do not edit generated code. See [SDK usage](../sdk/README.md).
- The dashboard uses the same public API as integrations; Google establishes an administrator session, not a separate dashboard business API. API keys are hashed at rest and scoped to live/test environments. A sending-domain restriction authorizes that domain and its subdomains, matching SES identity inheritance; a subdomain restriction does not authorize its parent or siblings. Give integrations only necessary grants; sending-domain restrictions are not a general data-isolation boundary.
- [Hosted MCP](../mcp/README.md) is served at `/mcp` on this API's origin. OAuth authorization reuses the dashboard's approved Google session, then grants the MCP client its own scoped access. Ordinary named tools include both input and output schemas; no local process, pasted API key, or server-side code-mode wrapper is required. Test/read access is the default; writes require the corresponding OAuth scope and `confirm: true`. Apply `009_mcp_oauth.sql` before deployment and grant the API database role access to its new tables, following the existing migration-role separation.
- Collections return `{ data, nextCursor }`. HTTP `202` means queued, not delivered. Read stored message/event state to find the outcome.
- Use `Idempotency-Key` for retriable writes: exact repeats return the recorded result; conflicting payloads return `IDEMPOTENCY_CONFLICT`. Without a key, requests do not create permanent idempotency records.

## SES and production release gates

Leave `ENABLE_LIVE_SES=false` until real sending is deliberately configured. It prevents live mail, **not read-only AWS discovery or explicitly confirmed provisioning**. Test keys simulate sends without AWS calls, production suppression effects, or production engagement; they do not certify real MIME rendering/delivery.

1. Supply the explicit server-side AWS credentials above for a least-privilege IAM principal, never root or administrator keys. Set `DEFAULT_SES_REGION` before the first migration; region selection is persisted in PostgreSQL afterward. STS verifies the AWS account; provisioning records trusted account/topic identifiers in the database. `SES_REGIONS`, `AWS_ACCOUNT_ID`, `SNS_TOPIC_ARNS`, and `SES_*_CONFIGURATION_SET` are not normal installation inputs.
2. Read regional discovery, then explicitly request provisioning through the public API below. Provisioning creates two installation-scoped configuration sets (transactional/marketing), one SNS topic, their event destinations, and a signed HTTPS feedback subscription. Names are generated automatically. The feedback callback must be public HTTPS before provisioning. For local Docker, keep `PUBLIC_URL=http://127.0.0.1:8793` for Google login and set `SES_FEEDBACK_URL=https://YOUR-TUNNEL/v1/events/ses`. Route that path to the local API; Google’s localhost callback does not change. Recipient unsubscribe links still use `PUBLIC_URL`, so a local-only dashboard URL is not suitable for real marketing campaigns. For a fully public installation, omit the override and use a public HTTPS `PUBLIC_URL` with its matching Google callback.
3. Verify regional SES identities and publish the DKIM records **returned by SES**, never guessed records. Review SES sandbox/production access and quotas separately; successful setup is not approval to send. See [SES verified identities](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html) and [configuration sets](https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets.html).
4. Verify public HTTPS, private buckets, verified database TLS, disabled Hyperdrive caching where used, proxy/log-export redaction, and least-privilege database/IAM/SNS policies. Set `WEBHOOK_ALLOWED_HOSTS` only to exact trusted public hosts before enabling outbound webhooks. An empty list denies outbound webhook destinations.
5. With explicitly authorized credentials and recipients, test a **real Google consent/callback**, a live SES send and received message, authentic SNS feedback, and public signed webhook delivery. Only then enable intended live workloads. Local mocks and dry runs cannot certify these integrations; no Cloudflare deployment or real Google/SES verification is implied here.

### Region discovery and explicit setup API

These are authenticated public API operations, not separate dashboard-only endpoints. Region access requires an unrestricted principal (no sending-domain restriction); AWS reads require live `read` access, and configuration/provisioning require live `manage` access.

| Operation | Behavior |
| --- | --- |
| `GET /v1/regions` | Both live and test `read` access: database catalog of default/enabled regions, cached discovery status, and provision job status/errors. Never calls AWS. |
| `PUT /v1/regions/{region}` | Body `{ "enabled": true }` and/or `{ "makeDefault": true }`. Shared database settings for live/test. Disabling the default, a region with queued/in-flight/uncertain mail or scheduled/sending campaigns, or active provisioning is blocked. Disabling deletes no AWS resources and preserves trusted feedback for historical mail. |
| `GET /v1/regions/{region}/discovery` | Enable the region first. Automatically discovers on the first uncached read, including for the default region; caches for 15 minutes. `?refresh=true` forces AWS reads. Credential, `PUBLIC_URL`, or `SES_FEEDBACK_URL` changes invalidate the cache. AWS operations are read-only; reports and discovered **DOMAIN** identity names are saved in the local catalog. |
| `POST /v1/regions/{region}/provision` | Body `{ "confirm": true }`. Returns `202 { jobId, status }`, reusing an active job. The durable worker performs setup with a 90-second attempt budget and normal bounded retries. Read the catalog for job completion and refresh discovery afterward; a pending SNS confirmation is **not ready**, even if the job completed. |

Setup manages only resources tagged with this installation's `opensend:installation-id` and `opensend:purpose=ses-feedback`; it never automatically adopts manually created resources. Name/ownership collisions and missing permissions produce coded blockers, not permission escalation. SNS publishing is scoped to the verified account and the two configuration-set ARNs. The subscription uses signed SNS JSON with `RawMessageDelivery=false`; only the existing signature-verified callback confirms subscriptions for trusted topics. There is no public `SubscribeURL` trust override. See [SNS delivery verification](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).

The managed destinations enable `SEND`, `DELIVERY`, `BOUNCE`, `COMPLAINT`, `REJECT`, `RENDERING_FAILURE`, `DELIVERY_DELAY`, `OPEN`, and `CLICK`. Open/click tracking still follows each message’s explicit tracking override; `tracking: false` disables it. `SUBSCRIPTION` is not enabled because OpenSend owns consent. Setup does not change DNS, obtain SES production/sandbox approval, mutate IAM, delete unrelated resources, add SQS/Lambda, or request mailbox access. Unrelated event destinations/subscriptions remain unchanged.

### Copyable IAM policy

Use [`iam-policy.json`](iam-policy.json) for the dedicated OpenSend IAM user. Replace every `YOUR_AWS_ACCOUNT_ID` with your 12-digit AWS account ID, create a customer-managed policy in IAM, and attach it to that user. It covers discovery, provisioning, identity verification, custom MAIL FROM configuration, stored-template reads/rendering, and sending; it grants no IAM administration, resource deletion, or attachment-storage access.

Generate a personalized, gitignored copy with `npm run iam-policy:personal -- YOUR_12_DIGIT_ACCOUNT_ID`. This writes `iam-policy-personal.json` beside the canonical template for pasting into IAM.

Per-message open/click tracking overrides require `ses:ApplyTrackingConfigurationOverrides` in addition to `ses:SendEmail`. A live SES denial confirmed this permission on September 10, 2026, although AWS’s published service authorization reference did not list it. Keep the separate tracking statement in the generated policy. The subscription statement permits HTTPS callbacks at `/v1/events/ses`; you can replace its host wildcard with your exact public callback URL. Validate sending with an authorized recipient after applying the policy—read-only discovery cannot prove send authorization.

### Setup IAM action groups

Review resource scopes and tag conditions for your account and generated regional names. The current commands in [`src/ses-setup.ts`](src/ses-setup.ts) require these groups; this is an action inventory, **not a complete verified deployment policy** or the separate permissions needed for sending/identity management:

- Identity: STS `GetCallerIdentity` verifies the caller/account.
- SES reads (`ses:`): `GetAccount`, `ListEmailIdentities`, `GetConfigurationSet`, `GetConfigurationSetEventDestinations`.
- SNS reads (`sns:`): `GetTopicAttributes`, `ListTagsForResource`, `ListSubscriptionsByTopic`, `GetSubscriptionAttributes`.
- SES provisioning (`ses:`): `CreateConfigurationSet`, `CreateConfigurationSetEventDestination`, `UpdateConfigurationSetEventDestination`, plus `TagResource` permission for creation tags.
- SNS provisioning (`sns:`): `CreateTopic`, `SetTopicAttributes`, `Subscribe`, `SetSubscriptionAttributes`, plus `TagResource` permission for creation tags.

When the Docker job worker starts with AWS credentials, it queues read-only discovery for enabled regions with missing or stale reports. Repeated starts reuse pending discovery jobs. This never queues provisioning. The dashboard shows discovery progress and polls for its results.

Registered SNS feedback trust is bound to the provisioned AWS account and topic, not to short-lived API credentials: rotating access keys or session tokens does not drop feedback. Discovery observations are refreshed for changed credentials. Do not switch AWS accounts on an existing provisioned installation; use a separate installation instead.

Use the route schemas in [`src/ses-regions.ts`](src/ses-regions.ts) for the exact API contract. The [historical AWS reference](../docs/aws-ses/credentials-and-iam.md) provides background; its broader manual-configuration guidance is not an exact policy for this setup flow.

## Sending and operational boundaries

| Capability | Current boundary |
| --- | --- |
| Single / batch sends | Durable per-message jobs, at most 50 recipients/message and 100 messages/submission. Plain ASCII addresses (punycode domains supported), with an optional validated `fromName` for the sender display name; no arbitrary message headers. Each result has a message ID, not a separate batch-status resource. SES sends are individual, not `SendBulkEmail`. |
| Campaigns | Versioned drafts/reviews, previews, scheduling, and cancellation before dispatch. Draft `html` is block HTML (`GET /v1/campaign-content-guide`); the server validates it on save and renders the styled email plus a plain-text part at review/test/send, so the dashboard composer, SDK and MCP share one content document. The original synchronous `/review` remains capped at 1,000 matching contacts. The additive `/v1/campaigns/{id}/reviews` preparation flow supports up to 1,000,000 matching contacts in durable, bounded batches; poll its returned review ID until `ready`. CSV imports remain capped at 1,000 rows per import. Larger input fails rather than truncates. Revocation cannot recall accepted or in-flight mail. |
| Templates | SES Get/TestRender/Get snapshots; callers must HTML-escape template data. The campaign editor escapes its own simple substitutions. Local test rendering is not proof of a real SES render. |
| Attachments | JSON/base64 upload plus raw-byte `POST /v1/attachments/upload` for the SDK/CLI, and authenticated `/v1/attachments/{id}/content` download with private object IDs and ownership/reference checks. Extension, MIME declaration and file signature/content are checked. At most 8 MiB decoded attachments, 16 MiB estimated encoded message size, and 512 KiB per direct body part. No arbitrary URL fetching. SES-rendered raw templates cannot add structured attachments. |
| Retries / rate | Shared regional quota reservations. Six bounded transient attempts, delayed 15s, 1m, 4m, 16m, and 1h; ambiguous provider acceptance is not automatically replayed. Failed jobs remain inspectable. |
| Webhooks | Ten event types, seven operational defaults, signed deliveries, encrypted per-endpoint secrets, pause/resume, and manual retries. Exact administrator-managed host allowlist. Paused local fixtures do not prove public delivery. |
| Unsubscribe | Immediate hosted GET and provider one-click POST; persistent opaque capabilities opt out of all installation marketing. Repeated clicks are idempotent. Link scanners can trigger footer opt-outs intentionally; HEAD returns 405 without changing consent. No preference-center UI. |
| Domain readiness | SES-returned DKIM zone is authoritative. Missing DNS is explicit; lists are capped at ten with paced control-plane reads. Domain detail can configure a custom MAIL FROM subdomain with SES default-value fallback and then shows its MX/SPF records. OpenSend neither creates AWS connections nor replaces DNS records. |

### Errors, logs, and retention

Errors use `{ error: { code, message, requestId, retryable, field? } }` and an `x-request-id` header. Search JSON logs by that ID; dispatch carries it through the outbox. Logs include operation/job/attempt/error codes, not request bodies, credentials, or unsubscribe tokens. Unexpected stack traces remain server-side. API-key last-use timestamps update at most once per minute.

Detailed email/event/webhook logs expire after 30 days. Active jobs, campaign drafts, engagement, consent/suppression, idempotency results, and valid unsubscribe links have separate lifecycles. Unreferenced old attachment metadata is removed transactionally; object deletion is queued durably. Failed deletion jobs retain object keys for recovery. Contact deletion is **not** a promise to purge all audit/safety records, imported copies, or campaign revisions.

### Security boundaries

Non-manage readers receive app unsubscribe capabilities redacted from content and nested event/webhook payloads; raw MIME is withheld. This does not sanitize arbitrary third-party password-reset links—content-read grants belong only with trusted integrations. Campaign substitutions reject executable, unquoted, comment, and foreign-markup contexts and validate completed URLs. SES templates retain their caller-escaping contract.

Postgres request/resource budgets bound major amplification paths. Per-key authenticated limits are 600/minute in test and 1,200/minute in live; administrator sessions have a separate higher budget. Outstanding email limits are 100/test key and 2,000/live key, with 500/test environment and 10,000/live environment. Stored attachments are limited to 64 MiB/test and 1 GiB/live; expanded campaign/batch content to 16 MiB/test and 128 MiB/live. These are implementation limits, not plan entitlements or full isolation from shared infrastructure costs.

Coarse admission runs before DB access: 6,000 requests/minute per connection peer/process on Node, or per Cloudflare IP/location using its approximate limiter. Node does not trust forwarded-IP headers. Use correctly configured proxy/WAF controls for distributed abuse. Cloudflare invocation URL logs/traces are disabled; review every external log sink independently.

## Secret rotation and upgrades

`BETTER_AUTH_SECRET` is the root for authentication and HKDF-derived, domain-separated webhook encryption keys. Webhook ciphertext carries a version/key identifier. **Back up the old secret securely before rotation**; losing a needed decryption key can make stored signing secrets unrecoverable.

1. Generate a new root secret. Set the old root as `PREVIOUS_BETTER_AUTH_SECRET` and the new root as `BETTER_AUTH_SECRET` in every API/worker environment. Restart the services with the same configuration.
2. Run `npm run migrate` against the intended database (Docker: `docker compose -p opensend-api-local run --rm api node dist/migrate.js`). Migration re-encrypts stored webhook secrets with the new root. Resolve any failure before retiring old key material.
3. Keep the previous root until migration is complete and all services use the new configuration. Then remove `PREVIOUS_BETTER_AUTH_SECRET` and restart all services. Root rotation logs out existing sessions: the previous-root setting is **not** an authentication fallback.

For an **older `ENCRYPTION_KEY` installation**, retain that old key only as upgrade-time decryption input while configuring a new `BETTER_AUTH_SECRET`. Do **not** set both legacy `ENCRYPTION_KEY` and `PREVIOUS_BETTER_AUTH_SECRET`. Run migration to re-encrypt secrets, verify completion, then remove `ENCRYPTION_KEY` and restart. Do not copy obsolete admin-key/bootstrap settings into a new deployment. Old credentials do not create a Google administrator.

**Stop before migration if the old installation used a custom `WORKSPACE_ID` or contains non-default namespace data.** The new installation uses a fixed default namespace, with no public workspace setting. It needs an explicit manual namespace plan covering database rows, queued work, and stored object keys; simply removing the old variable can make existing data inaccessible. Do not silently rename data or discard storage. Resolve any older in-progress encryption-key transition before this upgrade as well.

## Verification

The only acceptance-test file is `api/api.acceptance.test.ts`. `npm test` uses the local API/job worker and a paired local database; its Google identities are synthetic and its OAuth transport is mocked. It does **not** prove normal Google login with a real client. Do not run it against production or unrelated data: synthetic contacts/campaigns and audit records are created.

Use an isolated database with synthetic identities, never real user data, for local acceptance. For that dedicated local test installation, the suite needs the server's matching `BETTER_AUTH_SECRET`, `API_BASE_URL`, and paired `DATABASE_URL`. Allow its default fixture email `operator@example.com` in `AUTH_ALLOWED_EMAILS` and fixture domain `example.com` in `AUTH_ALLOWED_DOMAINS` (or use matching `AUTH_TEST_EMAIL` / `AUTH_TEST_GOOGLE_DOMAIN` values). Reserve `operator@example.com` for the fixture; it must not collide with an existing user. Set `WEBHOOK_ALLOWED_HOSTS=example.com` for paused webhook fixtures. Restart the API/worker after changing configuration. These are **test-only** identities/permissions, not production onboarding, and fake OAuth credentials alone are not an alternate login path.

The dashboard is desktop-first. At a 390-pixel viewport its controls remain reachable, but the persistent sidebar leaves a cramped main pane; small-screen layout polish remains a follow-up, not a verified mobile-ready claim.

Useful checks, from their respective packages:

- `api/`: `npm run check`, `npm test`, `npm run sdk`, and `npm run cf:check` (after the dashboard build).
- `app/`: `npm run build`.
- `mcp/`: `npm run check` and `npm run build`; exercise the stdio client against the local API with a scoped test key.

Live acceptance is opt-in with `LIVE_SES_TEST=1`, `SES_TEST_RECIPIENT`, and `SES_TEST_FROM` for explicitly authorized real sending. The commands above describe checks, not a claim that they have passed on your installation. Docker/Workers builds, local simulation, Google mocks, and source review do not replace the [external release gates](#ses-and-production-release-gates).
