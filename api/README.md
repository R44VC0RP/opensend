# OpenSend setup and operations

One Hono/TypeScript API for Node/Docker and Cloudflare Workers. The dashboard and generated SDK use that same public API; MCP discovers its OpenAPI contract. PostgreSQL is the source of truth: queued mail rows are the dispatch queue, a Postgres outbox drives campaign orchestration and webhooks, and private R2/S3 stores attachments. On Cloudflare a Durable Object per account/region hosts the long-lived dispatcher and a queue carries verified provider feedback; no Redis, D1, passwords, teams, or production admin bypass.

## Large campaigns

Send and schedule need only the current `revision`. The request freezes the audience and content into one snapshot, reserves the recipients and moves the campaign to `preparing`; the `202` response means that background workflow was accepted, not that validation or SES delivery has finished. `GET /v1/campaigns/{id}/audience` counts the saved audience (matched, eligible, suppressed, unsubscribed) before a send is confirmed; it is a live read and freezes nothing. MCP exposes the same count as `previewCampaignAudience` and `deliverCampaign` takes only the revision.

A campaign has one `state`, written only by `src/states.ts`: `draft` → `preparing` (every message validated in the background; `delivery.prepared` is the cursor) → `scheduled` (waiting for `scheduledAt`) or `sending` (recipients released into the dispatch queue; `delivery.expanded`) → `done`, set by the dispatcher once the queue drains for the campaigns it moved rows for (one statement per draining batch, campaign rows only; the minute sweep finishes any it missed). `paused` is entered by the user or the health check and resumes to wherever the cursors say. `failed` keeps `delivery.error`: if nothing was released yet it can be edited (back to `draft`) or sent again from a fresh snapshot; once recipients were released it can only be resumed (continuing from `delivery.expanded` on the same snapshot, so nobody receives the message twice) or canceled, and it keeps its reservation until then. `canceled` is terminal. One job row per campaign (`campaign.run:<id>`) does all of the work and waits in place for the schedule, the dispatch buffer, pacing or the SES quota, so a campaign can never be left `sending` with nothing queued or `preparing` after its job exhausted its retries: the last retry or a definitive error leaves `failed`.

Only referenced personalization properties are copied into immutable recipient rows; the rendered base email is shared. Email rows are materialized progressively rather than all existing immediately; future schedules reserve capacity without filling the active dispatch buffer. `delivery` reports the cursors, pacing, pause and hold reasons; its `canceled` count is unmaterialized cancellations, separate from canceled email rows. Final personalized audit snapshots are saved at dispatch. Never manually replay an uncertain SES send.

| Bound | Current implementation |
| --- | --- |
| Matching contacts per campaign | 2,000,000, before consent/suppression filtering |
| Concurrent campaign runs | Bounded by worker/runner job concurrency; other campaigns remain durable queue work |
| Referenced personalization snapshot | 1 GiB per campaign, 1 MiB per recipient |
| Preparation/release chunk | Up to 20,000 / 2,000 recipients respectively; preparation is also bounded to 4 MiB and ten seconds per step |
| Active campaign dispatch buffer | Ten seconds of the cached regional send rate per campaign (400 floor, 20,000 cap) and twenty seconds per workspace (1,000 floor, 50,000 cap). On MX, each shared workspace plans against 25% of the pool rate; BYO uses its full account rate. The daily quota and dispatcher gate remain account-wide. |
| Outstanding campaign intents | 2,000,000 per originating credential; 4,000,000 per workspace |
| Orchestration jobs per process/invocation | `JOB_CONCURRENCY`: default 2, maximum 8 for Node and 6 for Cloudflare (campaign runs, webhooks, maintenance; never mail) |
| Dispatcher shards | `DISPATCH_SHARDS` Durable Objects per account/region on Cloudflare (configured to 4; one per BYO account/region), each pacing 1/N of the regional quota with up to six provider calls in flight. Sending up to six emails wakes one shard per target region; larger bursts wake all shards. The Node runner dispatches in-process. |

These are application bounds, not a guaranteed SES send rate. Mail is dispatched by long-lived batch dispatchers (`src/dispatcher.ts`): one statement leases up to twenty due rows, one transaction elects the batch (origin authorization, consent locks, campaign cancellation, unsubscribe tokens, attempt events), provider calls run six-wide behind an in-memory pacing gate, and one statement records every outcome. `sending_region_limits` is the shared one-minute quota cache; only a shard that finds it stale calls `GetAccount`. No SES request holds a database transaction, and a row is sent at most once because the claim flips it `queued → attempting` under its dispatch version. Direct sends retain their separate pending limits. Node runners hold one in-process gate each, so run one runner per installation or split the quota explicitly.

Apply migrations through `019_batch_dispatcher.sql` before deploying this backend; pre-migration `email.dispatch` job rows complete as no-ops once the dispatcher owns queued rows. For Docker, stop old runners and upgrade API/runner images together; the new runner continues a previous release's `campaign.prepare/expand/finish` rows as runs of the same campaign, but old runners do not recognize `campaign.run`. Do not roll back to an older backend while campaigns are active.

## Configuration

**Upgrading from the live/test split:** release `052_prepare_drop_environment.sql` with the backend that stops using environment columns. Migration 052 permanently discards test data and test-only OAuth approvals, but keeps the columns, defaults and conflict targets needed by the previous single-mode backend (`2f350fa`). Release `053_drop_environment.sql` separately, only after all API instances, runners and dispatchers use the new backend and old invocations have drained. After 053, do not roll back to a backend that names those columns. Fresh installations can apply both migrations together.

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
| `DISPATCH_RATE_FACTOR` | Optional pacing target as a multiple of the SES `MaxSendRate` (default `1`; production uses `1.1`, i.e. 22/s at a 20/s quota). Slots are spaced evenly at the target and the target follows quota changes automatically; any throttled response brakes back to the raw quota for ten seconds, so a modest overshoot cannot spiral into retries. |
| `DISPATCH_TARGET_RATE` | Optional absolute SES sending target in recipients per second; replaces the quota-derived rate (the brake still applies). Leave unset unless the SES quota is known to be stale. |
| `DISPATCH_DAILY_HEADROOM_PERCENT` | Percent of the rolling SES 24-hour quota kept for transactional recipients (default `10`; `0` disables the reserve). Marketing stays queued until quota becomes available. This does not split the per-second rate or change Hosted tenant caps. |
| `DISPATCH_SHARDS` | Cloudflare only: number of shards for self-hosted sending or the MX shared pool (configured to 4). Each paces 1/N of the regional target and holds up to six provider calls in flight. MX BYO accounts use one shard. |
| `JOB_CONCURRENCY` | Optional active orchestration jobs (campaign runs, webhooks, maintenance) per process/invocation. Defaults to 2; capped at 8 for Docker/Node and 6 for Cloudflare. Mail dispatch is separate: the runner's in-process dispatcher, or `DISPATCH_SHARDS` Durable Objects on Cloudflare. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Your installation's real Google OAuth **Web application** client credentials. See below. |
| `AUTH_ALLOWED_EMAILS` | Comma-separated exact Google email addresses. Use this for personal Gmail accounts. |
| `DEFAULT_WORKSPACE_OWNERS` | Approved Google users with no memberships become owners of `default` on dashboard access only if their verified email is listed. Use comma-separated exact addresses, an empty value for none, or `*` (the default) for all approved users. |
| `AUTH_ALLOWED_DOMAINS` | Optional comma-separated exact Google Workspace hosted domains, checked against Google's verified `hd` claim—not an email suffix. Either allowlist can approve a user; missing/empty lists deny everyone. All approved users are admins. |
| `PUBLIC_URL` | Canonical external **origin**, without path, query, fragment, or credentials. HTTPS is required except for local sign-in/development at `localhost` and `127.0.0.1`. Docker default: `http://127.0.0.1:8793`; AWS provisioning requires a public HTTPS origin. |
| `DEFAULT_SES_REGION` | Initial region, default `us-east-1`. Migration seeds the database once and also imports already-used regions to avoid stranding existing work. Subsequent region/default changes use the API, not this environment value. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Explicit server-only IAM credentials for SES discovery, provisioning, and live sending; the session token is optional for temporary credentials. No automatic role lookup or token renewal. |
| `REPUTATION_ALERT_SLACK_URL` | Optional Slack incoming webhook (`https://hooks.slack.com/...`) for hourly SES reputation alerts. Posts when an enabled region's bounce or complaint rate crosses 80% of the warning threshold, the warning threshold (5% bounce, 0.1% complaint), 80% of the at-risk threshold, or the at-risk threshold (10%, 0.5%), and when it falls back. Escalations send immediately; other changes wait six hours after the previous message, a level is not repeated within 24 hours, and dropping a level needs a 10% margin. Requires live SES and `cloudwatch:GetMetricData`. Store it as a secret (`wrangler secret put` on Cloudflare). |
| `TYPESAFE_API_KEY` | Optional TypeSafe AI key that enables the Jev content screen for transactional sends with `screen: true`. Without it, screened sends go out unscreened and log `CONTENT_SCREEN_SKIPPED` (at most once a minute). Store it as a secret (`wrangler secret put` on Cloudflare). |
| `JEV_MODEL` | Optional Jev model for the content screen (default `jev-latest`). |
| `JEV_SCREEN_MODE` | `reject` (default) rejects screened live transactional mail at or above the threshold before it reaches SES: status `rejected`, error code `CONTENT_REJECTED_SPAM`, and a `reject` event with `providerCalled: false` and the score. `flag` only logs `CONTENT_SPAM_SUSPECTED` and sends. A classifier outage fails open and logs `CONTENT_SCREEN_UNAVAILABLE`. |
| `JEV_SCREEN_THRESHOLD` | Optional spam probability, 0–1, at which the screen acts (default `0.7`). |
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

5. Create a scoped API key for SDK/MCP calls. Check `GET /v1/me`: `simulated: true` means this deployment will not send through SES. Simulation still writes local data and delivers configured webhooks.

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

`wrangler.jsonc` contains the production bindings for **https://opensend.anoma.ly**. To self-host in another account, replace `account_id`, the custom-domain route and `PUBLIC_URL`, the Hyperdrive ID, and the R2/Queue names with your own resources; create both queues (`wrangler queues create opensend-work` and `wrangler queues create opensend-feedback`) before the first deploy. The `DispatcherShard` Durable Object migration is applied by `wrangler deploy`; `DISPATCH_SHARDS` sets how many shards share each region's quota. Do not reuse production bindings for staging or preview builds. The dashboard build is served from `app/dist` as Workers assets on the API's origin.

Use a read/write database role for Hyperdrive and a separate schema-owner credential for direct Node migrations. Configure Hyperdrive origin TLS as `verify-full`; Cloudflare requires an uploaded CA certificate ID for that mode. The deployed connection uses the validated ISRG Root X1 trust anchor. Node migration connections accept PlanetScale's `sslrootcert=system` URI parameter without treating it as a filesystem path, while retaining certificate and hostname verification.

**Disable Hyperdrive query caching** with `--caching-disabled`; a shorter TTL is not equivalent. Authentication, consent, idempotency, and job state need fresh reads. Hyperdrive still provides pooling. See [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

Supply `BETTER_AUTH_SECRET` and `GOOGLE_CLIENT_SECRET` using Worker secrets; configure your real `GOOGLE_CLIENT_ID`, allowlists, and HTTPS `PUBLIC_URL` for this deployment. This deployment also stores `GOOGLE_CLIENT_ID` and the allowlists as Worker secrets rather than committing those installation values. For AWS discovery, explicit provisioning, or live SES sending, also supply `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN` securely. Use interactive `wrangler secret put`, not secrets in config or command arguments. Pasted temporary credentials are not automatically renewed.

Build `app/` with `npm ci` and `npm run build` before `npm run cf:check` in `api/`. `cf:check` is a deployment **dry run**, not a deployment or remote-resource check. For local Workers, keep an ignored `api/.dev.vars` containing only the required Worker settings and secrets, including both Google credentials, allowlists, `BETTER_AUTH_SECRET`, and the local `PUBLIC_URL`. This avoids loading unrelated Docker/storage credentials from `.env`. Securely set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, then use `npm run cf:dev -- --port 8794 --local-upstream 127.0.0.1:8794 --upstream-protocol http` and a matching `PUBLIC_URL`/Google callback. The explicit local upstream prevents Wrangler from rewriting same-origin authorization headers to the production custom domain. Local Hyperdrive cannot certify production pooling/caching; see [local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

HTTP, Queue, and scheduled handlers share the outbox. Queue messages are wakeups; committed jobs survive a lost wakeup. Workers consume one wake signal per queue invocation and stop claiming new jobs after a two-second turn, while allowing every in-flight job to finish. Database claims lease only as many jobs as there are free local lanes; lanes refill individually as jobs finish, without waiting for the slowest job in a group. At most one feedback-first reservation is active per invocation, with feedback-only fallback when no send work exists. Invocation-local rotation provides job-class fairness without writing a shared scheduler row on every claim. The `job_schedule` row remains for admission locking and wake coalescing. A campaign launch asks for an uncoalesced wake so its run starts at once. Cron recovers due work and performs hourly retention. PostgreSQL transactions/leases, not wake messages or process-local state, control dispatch.

Apply migration `018_wake_coalescing.sql` before deploying this Worker; singleton wake coalescing requires its nullable `job_schedule.wake_not_before` column. Singleton notifications share a one-second window per workspace and are delayed one second; larger bursts and queue/scheduled continuations remain ungated.

### Automatic deployments

**Inbound rollout:** use `/v1/inbound` for addresses, threads, events and webhooks. For Node/Docker, stop old API and runner processes and apply migrations before starting this version. Migration `050_inbound_event_names.sql` preserves event cursors, normalizes lifecycle names and pending deliveries, and removes `message.updated` from subscriptions. Existing addresses and keys do not change. A merge does not create an SES receiving rule, change MX, verify a forwarding destination, allowlist a webhook hostname, or register a webhook. Configure those separately using the [support inbox setup](../sdk/README.md#a-support-inbox-with-tracked-replies). Before directing customer traffic to it, use an authorized external inbox to check a signed webhook, a reply, and the public From and thread in the recipient’s mail client.

Pushes to `main` deploy through [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml): it installs both packages, type-checks the API, builds the dashboard, and runs `wrangler deploy` from `api/`. It needs a `CLOUDFLARE_API_TOKEN` repository secret created from the **Edit Cloudflare Workers** token template, scoped to this account. Other branches do not deploy; give them separate database, bucket, queue, and credentials before enabling that. Schema migrations remain an explicit step using the migration role, not an automatic side effect of deploying code.

The XML-builder alias in Wrangler selects the AWS SDK's non-browser parser: Workers do not provide `DOMParser`. Outbound certificate, confirmation, and webhook requests use manual redirect handling and reject non-success responses without following redirects.

### Live E2E

From `api/` on Node 24, run `npm ci` then `npm run e2e` with `OPENSEND_E2E_API_KEY` in the environment. With a local env file, run `node --env-file="$HOME/.config/opensend-mx/e2e.env" --import tsx scripts/e2e.ts`. `OPENSEND_E2E_URL` defaults to `https://opensend.mx`. The full suite uses the dedicated unrestricted read/send/manage workspace key; it checks the Hosted connection, region and exact test domain ID before writing. Deploy MX (push or manual dispatch on `opensend-mx`) runs the same gate after `/health`, using the `mx` environment’s `MX_E2E_API_KEY`. No periodic runs or notifications.

Each run sends to [run-tagged SES simulator addresses](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html#send-email-simulator-considerations) and its own two temporary MX addresses. A second one-recipient campaign is scheduled 24 hours ahead, paused, paced, resumed and canceled before dispatch. The paused outbound webhook sends only a synthetic probe to `https://httpbin.org/status/204`; the inbound webhook sends only thread-state metadata from a run-owned address there. Neither subscribes to customer mail. The API records HTTP attempts, not request headers: this does not independently verify receiver-side HMAC. Cleanup targets only returned IDs. MX retains immutable mail, idempotency, consent/suppression and one-row import records; terminal campaigns are archived, not deleted.

`e2e-report.json` contains the commit, timings, failures with request IDs, and every OpenAPI operation either attempted, explicitly skipped with a reason, or not reached. Failed steps, cleanup errors and unaccounted operations fail the check. CI uploads the report even on failure and lists each step in the Actions summary. Domain-restricted denials on required flows are reported as failures, not skips. Budget: about four minutes including cleanup.

## SDK and MCP

- `/openapi.json` comes from the actual Zod route schemas; stable operation IDs define generated SDK methods. `npm run sdk` exports the contract, generates `../sdk/src`, and compiles it. Do not edit generated code. See [SDK usage](../sdk/README.md).
- The dashboard uses the same public API as integrations; Google establishes an administrator session, not a separate dashboard business API. API keys are hashed at rest and scoped to a workspace. New keys use `os_<64 hex digits>`; legacy `os_live_` keys remain valid and `os_test_` keys are rejected. Requests explicitly selecting the obsolete test environment fail with `400 ENVIRONMENT_REMOVED` rather than sending real mail. A sending-domain restriction authorizes that domain and its subdomains, matching SES identity inheritance; a subdomain restriction does not authorize its parent or siblings. Give integrations only necessary grants; sending-domain restrictions are not a general data-isolation boundary.
- [Hosted MCP](../mcp/README.md) is served at `/mcp` on this API's origin. OAuth authorization reuses the dashboard's approved Google session, then grants the MCP client its own scoped access. Ordinary named tools include both input and output schemas; no local process, pasted API key, or server-side code-mode wrapper is required. Read access is the default; writes require the corresponding OAuth scope and `confirm: true`. Apply `009_mcp_oauth.sql` before deployment and grant the API database role access to its new tables, following the existing migration-role separation.
- Collections return `{ data, nextCursor }`. HTTP `202` means queued, not delivered. Read stored message/event state to find the outcome.
- Use `Idempotency-Key` for retriable writes: exact repeats return the recorded result; conflicting payloads return `IDEMPOTENCY_CONFLICT`. Without a key, requests do not create permanent idempotency records.

## Isolated sending benchmarks

**Simulated** mail always uses the full dispatch path and the real SES SDK with an in-process transport instead of AWS networking. Live mail never selects this transport. Defaults: `SIMULATED_SES_LATENCY_MS=100`, `SIMULATED_SES_RATE=1000`, and `SIMULATED_SES_DELIVERY_DELAY_MS=250`. Override the latency when modeling a different observed provider call; zero latency measures application overhead only.

Simulated dispatch verifies attachment bytes, constructs MIME, paces against the cached regional quota, claims consent/authorization, and stores acceptance atomically. It then emits two synthetic Send/Delivery callbacks that substitute for incoming SNS requests: on Cloudflare they travel the same feedback queue as verified live callbacks; on Node and in the acceptance fixture they are durable `operation.simulatedFeedback` jobs. Both paths run the same routine-ingestion statement, creating receipts when they arrive. Statuses progress through accepted/sent/delivered, but all records remain `simulated: true` and provider IDs start with `sim_`; they are not evidence of actual delivery. The public SNS endpoint still requires real signature/account verification. AWS-stored templates are explicitly rejected on simulated deployments; template discovery/rendering and AWS-side validation are not emulated. Simulated feedback uses the same receipt, status, and fan-out logic, but does not certify SNS signature verification or real mailbox delivery.

`api/scripts/benchmark-sending.ts` requires a dedicated local `opensend_perf_*` database, all migrations, explicit `ENABLE_LIVE_SES=false`, and no AWS credentials. Run via `node --import tsx scripts/benchmark-sending.ts` with that isolated configuration. `BENCHMARK_RECIPIENTS` is capped at 1,000; `BENCHMARK_REPLICAS`, `BENCHMARK_LANES`, and `BENCHMARK_CONNECTIONS` control local load. Optional `BENCHMARK_REPORT` saves JSON metrics. Fixtures remain in the isolated database for inspection. Do not run it concurrently with an independent job runner. It measures the shared Node/database pipeline, not Cloudflare Queue startup or Hyperdrive latency; short high-rate runs do not establish sustained capacity.

Verified SNS callbacks never touch the sending jobs table. On Cloudflare the `/v1/events/ses` handler checks the SNS signature and account binding, enqueues the callback on the `opensend-feedback` queue and returns 202; a separate consumer ingests batches of up to 100 within two seconds. Routine Delivery (and any remaining Send) callbacks are persisted by one set-based statement per batch: receipt, matched event, monotonic status (the highest-ranked new event wins when several share a batch), public event and matching webhook deliveries. Bounce, complaint, engagement and subscription callbacks are processed inline with their receipt, and messages are acknowledged or retried individually. If a callback arrives before provider acceptance is recorded, its receipt and a deferred recovery job commit together. The configuration set no longer subscribes to `SEND` events—acceptance is recorded from the `SendEmail` response—so re-run provisioning after upgrading to update the event destination. The admission rate limiter does not apply to this endpoint. On Node the handler ingests routine callbacks inline and queues non-routine ones as jobs. With no matching subscribers, no webhook job is created.

## Hosted one-click DNS (Domain Connect)

MX offers the [OpenSend mail template](../domain-connect/opensend.mx.mail.json) only when the domain’s discovered provider advertises support. `GET /v1/domains/{id}/dns-setup` is owner/admin dashboard only. It reads the domain once, then checks up to five DNS labels with a three-second total network budget. Each isolate caches up to 256 public results for five minutes; timeouts, rate limits and provider outages are cached for 30 seconds. Manual DNS stays available. Configure **both** `DOMAIN_CONNECT_PRIVATE_KEY` and `DOMAIN_CONNECT_KEY_ID` or neither: without them, provider information is returned without an apply URL. Incomplete settings or a non-RSA-2048 PEM fail configuration loading.

1. Outside the repository, generate an RSA-2048 PEM (`umask 077; openssl genrsa -out domain-connect.pem 2048`). Set the full PEM including its original newlines as the `DOMAIN_CONNECT_PRIVATE_KEY` Worker secret, and set `DOMAIN_CONNECT_KEY_ID=_dck1`. Do not use the private PEM as DNS data.
2. Publish **two separate TXT records at the same owner**, `_dck1.domainconnect.opensend.mx.` (relative name `_dck1.domainconnect` in the `opensend.mx` zone). Take the base64 of the DER **SubjectPublicKeyInfo**, not the PEM text, PKCS#1 public key or a certificate. With 200-character chunks the values are `p=1,a=RS256,d=<first 200 base64 characters>` and `p=2,a=RS256,d=<remaining characters>`. No whitespace or line breaks inside a value. This prints the exact public values for OpenTofu (one record per output line):

   ```sh
   openssl pkey -in domain-connect.pem -pubout -outform DER | openssl base64 -A | fold -w 200 | awk '{print "p=" NR ",a=RS256,d=" $0}'
   ```

3. Submit the template to [Domain-Connect/Templates](https://github.com/Domain-Connect/Templates) and onboard it with each DNS provider. [Cloudflare](https://developers.cloudflare.com/dns/reference/domain-connect/): **domain-connect@cloudflare.com**, with the template link, full key TXT name, SVG logo and **DNS-only** proxy setting for DKIM CNAMEs. [Vercel](https://vercel.com/docs/domains/domain-connect): **domainconnect@vercel.com**, with the template link and a short in-product demo video. [IONOS](https://www.domainconnect.org/dns-providers/): **domain_connect_admin@domain.ionos.com**, with the template link and signing-key hostname.

The [synchronous protocol](https://github.com/Domain-Connect/spec/blob/master/Domain%20Connect%20Spec%20Draft.adoc#digitally-sign-requests) uses `groupId` (comma-separated; [unselected groups stay in place](https://www.ietf.org/archive/id/draft-ietf-dconn-domainconnect-01.html#section-10.3.1)). OpenSend sorts and signs the encoded query, **excluding `key` and `sig`**, then appends those two parameters in that order. A ten-minute signed return token is also in `redirect_uri` because Cloudflare ignores `state`. The callback checks the Google session, the original workspace’s current role and domain ownership before restoring that workspace and redirecting to `${PUBLIC_URL}/domains/<id>`. A successful return or replay only queues the same throttled DNS/SES verification; neither grants ownership. For rotation, publish the new selector’s TXT records before switching the key pair and leave the old records through the outstanding flows’ lifetime and DNS TTL.

## SES and production release gates

With `ENABLE_LIVE_SES=false` or missing AWS credentials, all keys use the simulator. SES discovery and provisioning return `503 SES_NOT_CONFIGURED`. A campaign records its launch mode. If the worker mode changes before its run finishes, the run stops and the campaign fails with `SES_MODE_CHANGED`. Use a separate deployment for simulation: workspace data, consent and webhooks are real.

1. Supply the explicit server-side AWS credentials above for a least-privilege IAM principal, never root or administrator keys. Set `DEFAULT_SES_REGION` before the first migration; region selection is persisted in PostgreSQL afterward. STS verifies the AWS account; provisioning records trusted account/topic identifiers in the database. `SES_REGIONS`, `AWS_ACCOUNT_ID`, `SNS_TOPIC_ARNS`, and `SES_*_CONFIGURATION_SET` are not normal installation inputs.
2. Set `ENABLE_LIVE_SES=true`, read regional discovery, then explicitly request provisioning through the public API below. Provisioning creates two installation-scoped configuration sets (transactional/marketing), one SNS topic, their event destinations, and a signed HTTPS feedback subscription. Names are generated automatically. The feedback callback must be public HTTPS before provisioning. For local Docker, keep `PUBLIC_URL=http://127.0.0.1:8793` for Google login and set `SES_FEEDBACK_URL=https://YOUR-TUNNEL/v1/events/ses`. Route that path to the local API; Google’s localhost callback does not change. Recipient unsubscribe links still use `PUBLIC_URL`, so a local-only dashboard URL is not suitable for real marketing campaigns. For a fully public installation, omit the override and use a public HTTPS `PUBLIC_URL` with its matching Google callback.
3. Verify regional SES identities and publish the DKIM records **returned by SES**, never guessed records. Review SES sandbox/production access and quotas separately; successful setup is not approval to send. See [SES verified identities](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html) and [configuration sets](https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets.html).
4. Verify public HTTPS, private buckets, verified database TLS, disabled Hyperdrive caching where used, proxy/log-export redaction, and least-privilege database/IAM/SNS policies. Webhook endpoints must be public HTTPS DNS names: credentials, IP literals, internal TLDs and this installation's own hosts (`PUBLIC_URL`, `SES_FEEDBACK_URL`) are rejected, and Node/Docker delivery resolves each host itself and refuses private, loopback, link-local, CGNAT and ULA answers at connect time (Cloudflare Workers cannot reach those ranges).
5. With explicitly authorized credentials and recipients, test a **real Google consent/callback**, a live SES send and received message, authentic SNS feedback, and public signed webhook delivery. Only then enable intended live workloads. Local mocks and dry runs cannot certify these integrations; no Cloudflare deployment or real Google/SES verification is implied here.

### Region discovery and explicit setup API

These are authenticated public API operations, not separate dashboard-only endpoints. Region access requires an unrestricted principal (no sending-domain restriction); AWS reads require `read` access, and configuration/provisioning require `manage` access.

| Operation | Behavior |
| --- | --- |
| `GET /v1/regions` | `read` access: database catalog of default/enabled regions, cached discovery status, and provision job status/errors. Never calls AWS. |
| `PUT /v1/regions/{region}` | Body `{ "enabled": true }` and/or `{ "makeDefault": true }`. Disabling the default, a region with queued/in-flight/uncertain mail or scheduled/sending campaigns, or active provisioning is blocked. Disabling deletes no AWS resources and preserves trusted feedback for historical mail. |
| `GET /v1/regions/{region}/discovery` | Enable the region first. Automatically discovers on the first uncached read, including for the default region; caches for 15 minutes. `?refresh=true` forces AWS reads. Credential, `PUBLIC_URL`, or `SES_FEEDBACK_URL` changes invalidate the cache. AWS operations are read-only; reports and discovered **DOMAIN** identity names are saved in the local catalog. |
| `POST /v1/regions/{region}/provision` | Body `{ "confirm": true }`. Returns `202 { jobId, status }`, reusing an active job. The durable worker performs setup with a 90-second attempt budget and normal bounded retries. Read the catalog for job completion and refresh discovery afterward; a pending SNS confirmation is **not ready**, even if the job completed. |

Setup manages only resources tagged with this installation's `opensend:installation-id` and `opensend:purpose=ses-feedback`; it never automatically adopts manually created resources. Name/ownership collisions and missing permissions produce coded blockers, not permission escalation. SNS publishing is scoped to the verified account and the two configuration-set ARNs. The subscription uses signed SNS JSON with `RawMessageDelivery=false`; only the existing signature-verified callback confirms subscriptions for trusted topics. There is no public `SubscribeURL` trust override. See [SNS delivery verification](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).

The managed destinations enable `SEND`, `DELIVERY`, `BOUNCE`, `COMPLAINT`, `REJECT`, `RENDERING_FAILURE`, `DELIVERY_DELAY`, `OPEN`, and `CLICK`. Open/click tracking still follows each message’s explicit tracking override; `tracking: false` disables it. `SUBSCRIPTION` is not enabled because OpenSend owns consent. Setup does not change DNS, obtain SES production/sandbox approval, mutate IAM, delete unrelated resources, add SQS/Lambda, or request mailbox access. Unrelated event destinations/subscriptions remain unchanged.

### Copyable IAM policy

Use [`iam-policy.json`](iam-policy.json) for the dedicated OpenSend IAM user. Replace every `YOUR_AWS_ACCOUNT_ID` with your 12-digit AWS account ID, create a customer-managed policy in IAM, and attach it to that user. It covers discovery, provisioning, identity verification, custom MAIL FROM configuration, stored-template reads/rendering, and sending; it grants no IAM administration or resource deletion. The only storage access is to OpenSend's own `opensend-*-mail-*` mailbox buckets.

Generate a personalized, gitignored copy with `npm run iam-policy:personal -- YOUR_12_DIGIT_ACCOUNT_ID`. This writes `iam-policy-personal.json` beside the canonical template for pasting into IAM.

Per-message open/click tracking overrides require `ses:ApplyTrackingConfigurationOverrides` in addition to `ses:SendEmail`. A live SES denial confirmed this permission on September 10, 2026, although AWS’s published service authorization reference did not list it. Keep the separate tracking statement in the generated policy. The subscription statement permits HTTPS callbacks at `/v1/events/ses`; you can replace its host wildcard with your exact public callback URL. Validate sending with an authorized recipient after applying the policy—read-only discovery cannot prove send authorization.

### Setup IAM action groups

Review resource scopes and tag conditions for your account and generated regional names. The current commands in [`src/ses-setup.ts`](src/ses-setup.ts) require these groups; this is an action inventory, **not a complete verified deployment policy** or the separate permissions needed for sending/identity management:

- Identity: STS `GetCallerIdentity` verifies the caller/account.
- SES reads (`ses:`): `GetAccount`, `ListEmailIdentities`, `GetConfigurationSet`, `GetConfigurationSetEventDestinations`.
- Reputation (`cloudwatch:`): `GetMetricData` reads the account-level `AWS/SES` `Reputation.BounceRate` and `Reputation.ComplaintRate` metrics. It does not support resource scoping. Without it, discovery still succeeds and the dashboard shows reputation rates as unavailable.
- SNS reads (`sns:`): `GetTopicAttributes`, `ListTagsForResource`, `ListSubscriptionsByTopic`, `GetSubscriptionAttributes`.
- SES provisioning (`ses:`): `CreateConfigurationSet`, `CreateConfigurationSetEventDestination`, `UpdateConfigurationSetEventDestination`, plus `TagResource` permission for creation tags.
- SNS provisioning (`sns:`): `CreateTopic`, `SetTopicAttributes`, `Subscribe`, `SetSubscriptionAttributes`, plus `TagResource` permission for creation tags.
- Inbound (`ses:`, `s3:`): enabling receiving on a domain ([`src/mailbox-setup.ts`](src/mailbox-setup.ts)) uses SES receipt-rule actions `DescribeActiveReceiptRuleSet`, `DescribeReceiptRuleSet`, `CreateReceiptRuleSet`, `SetActiveReceiptRuleSet` (only when no rule set is active), `CreateReceiptRule`, `UpdateReceiptRule` and `DeleteReceiptRule`, which do not support resource scoping. It creates an `opensend-*-mail-<region>` bucket (`CreateBucket`, `ListBucket`, `PutBucketOwnershipControls`, `PutBucketTagging`, `PutBucketPublicAccessBlock`, `PutBucketPolicy`, `PutLifecycleConfiguration`) and reads/writes raw messages and attachments in it (`GetObject`, `PutObject`, `DeleteObject`). It reuses the SNS statements above for its `opensend-*-inbound` topic and the `/v1/events/ses` subscription.

When the Docker job worker starts with AWS credentials, it queues read-only discovery for enabled regions with missing or stale reports. Repeated starts reuse pending discovery jobs. This never queues provisioning. The dashboard shows discovery progress and polls for its results.

Registered SNS feedback trust is bound to the provisioned AWS account and topic, not to short-lived API credentials: rotating access keys or session tokens does not drop feedback. Discovery observations are refreshed for changed credentials. Do not switch AWS accounts on an existing provisioned installation; use a separate installation instead.

Use the route schemas in [`src/ses-regions.ts`](src/ses-regions.ts) for the exact API contract. The [historical AWS reference](../docs/aws-ses/credentials-and-iam.md) provides background; its broader manual-configuration guidance is not an exact policy for this setup flow.

## Sending and operational boundaries

| Capability | Current boundary |
| --- | --- |
| Single / batch sends | Durable per-message jobs, at most 50 recipients/message and 100 messages/submission. Plain ASCII addresses (punycode domains supported), with an optional validated `fromName` for the sender display name; no arbitrary message headers. Each result has a message ID, not a separate batch-status resource. SES sends are individual, not `SendBulkEmail`. |
| Campaigns | Versioned drafts, previews, a live audience count, scheduling, pause/resume/pacing and cancellation before dispatch. Draft `html` is block HTML (`GET /v1/campaign-content-guide`); the server validates it on save and renders the styled email plus a plain-text part at test/send, so the dashboard composer, SDK and MCP share one content document. Send and schedule freeze up to 2,000,000 matching contacts and validate every message in durable, bounded steps; poll the campaign's `state`. CSV imports are capped at 50,000 rows and 5 MiB per import. Larger input fails rather than truncates. Revocation cannot recall accepted or in-flight mail. |
| Templates | SES Get/TestRender/Get snapshots; callers must HTML-escape template data. The campaign editor escapes its own simple substitutions. Local test rendering is not proof of a real SES render. |
| Attachments | JSON/base64 upload plus raw-byte `POST /v1/attachments/upload` for the SDK/CLI, and authenticated `/v1/attachments/{id}/content` download with private object IDs and ownership/reference checks. One shared validator for every upload path (`/v1/attachments`, template assets, inbound replies): any file type Amazon SES delivers (its banned executable/script extensions are refused), base64 with or without line breaks or padding, and no MIME-type or file-signature second-guessing. At most 8 MiB decoded attachments, 16 MiB estimated encoded message size, and 512 KiB per direct body part. No arbitrary URL fetching. SES-rendered raw templates cannot add structured attachments. |
| Inbound | Messages up to 6 MiB and 30,000 lines are parsed for text/HTML bodies (capped at 1 MB each), up to 100 attachments, and threading headers. Larger or line-heavy messages up to the 40 MiB SES receiving limit are stored raw (`status: unparsed`, `bodyTruncated: true`) with SES envelope/common headers (`From`, `Subject`, `Message-ID`, verdicts) and remain downloadable as `.eml`. |
| Retries / rate | In-memory pacing per dispatcher shard from the cached regional quota. Provider throttling requeues the row with 2s, 4s, 8s, 16s, 32s backoff (five attempts); transient preflight failures retry after 15s; ambiguous provider acceptance is never automatically replayed. Orchestration jobs keep six bounded attempts delayed 15s, 1m, 4m, 16m, and 1h and remain inspectable. |
| Webhooks | Ten event types, seven operational defaults, signed deliveries, encrypted per-endpoint secrets, pause/resume, and manual retries. Any public HTTPS endpoint; IP literals, internal names, the installation's own hosts and (on Node) hosts resolving to non-global addresses are rejected. Paused local fixtures do not prove public delivery. |
| Unsubscribe | Immediate hosted GET and provider one-click POST; persistent opaque capabilities opt out of all installation marketing. Repeated clicks are idempotent. Link scanners can trigger footer opt-outs intentionally; HEAD returns 405 without changing consent. No preference-center UI. |
| Domain readiness | SES-returned DKIM zone is authoritative. Missing DNS is explicit; lists are capped at ten with paced control-plane reads. `region` is optional on creation (the workspace connection's region on MX, the default region when self-hosted). MX verification never gives up: paced checks back off to hourly for about three days, then every six hours, then daily; `FAILED` only means the SES identity is unavailable to this claim. Domain detail can configure a custom MAIL FROM subdomain with SES default-value fallback and then shows its MX/SPF records. OpenSend neither creates AWS connections nor replaces DNS records. |
| MX states | One explicit state per entity, written only by `src/states.ts`: domain claims carry `sending_state` (pending, verified, lost, failed) and `receiving_state` (off, pending, active, lost) plus the routing host; `lost` is a two-hour grace after proof goes missing. Connections carry `state` (awaiting_role, provisioning, ready, failed) and `tenant` (pending, ready, failed); Hosted is ready instantly, a background job creates the SES tenant, and until it is ready every send path (API, mailbox replies, campaigns) answers `TENANT_NOT_READY` and domain verification waits. Campaigns carry `state` (draft, preparing, scheduled, sending, paused, done, failed, canceled) with their delivery cursors as columns; see Large campaigns above. |

### Errors, logs, and retention

Errors use `{ error: { code, message, requestId, retryable, field? } }` and an `x-request-id` header. Search JSON logs by that ID; dispatch carries it through the outbox. Logs include operation/job/attempt/error codes, not request bodies, credentials, or unsubscribe tokens. Unexpected stack traces remain server-side. API-key last-use timestamps update at most once per minute.

Detailed email/event/webhook logs expire after 30 days. Active jobs, campaign drafts, engagement, consent/suppression, idempotency results, and valid unsubscribe links have separate lifecycles. Unreferenced old attachment metadata is removed transactionally; object deletion is queued durably. Failed deletion jobs retain object keys for recovery. Contact deletion is **not** a promise to purge all audit/safety records, imported copies, or campaign revisions.

### Security boundaries

Hosted connections admit 100 real recipients per rolling 24 hours in week one, 1,000 in week two, then 10,000 (`HOSTED_SEND_CAP_FIRST_WEEK`, `HOSTED_SEND_CAP_SECOND_WEEK`, `HOSTED_SEND_CAP_MATURE`). Suppressed/simulated sends and SES mailbox-simulator recipients do not consume the cap. A cap pauses campaign release; resume the campaign after capacity returns.
Hourly Hosted reputation checks count the last 24 hours of hard bounces and complaints per destination against 48 hours of accepted recipient volume to allow for delayed feedback. Below 200 recipients, ≥10 hard bounces or ≥2 complaints pause admission and dispatch; otherwise the thresholds are >3% and >0.05%. Inspect `HOSTED_SENDING_AUTO_PAUSED` and `connection.sendingPause` on `GET /v1/me`.
After reviewing the cause, an operator with `DATABASE_URL` set can run `node --import tsx scripts/resume-hosted-sending.ts WORKSPACE_ID` from `api/`. Queued mail can dispatch again, and only events after the resume count toward another pause.

To change a workspace’s Hosted limits, run `node --import tsx scripts/set-hosted-limits.ts WORKSPACE_ID --send-cap 100000 --pending-cap 25000` with the same operator access after migration 062. The first cap is real recipients per rolling 24 hours (1–10,000,000); the second is outstanding direct emails (1–4,000,000). Use `default` for either value to restore the age tier or the 10,000-message floor, respectively. `HOSTED_LIMITS_CHANGED` prints the old and new overrides (`null` means default). Overrides survive reconnects and do not apply to BYO.

Drain mail writers before applying 062: it backfills recent mail and feedback while holding write locks. Hosted windows use UTC hour buckets (the current hour and the preceding 23 or 47); an admission expires at its hour start plus 24 hours, up to 59 minutes earlier than an exact rolling cutoff. Suppression and definitive pre-acceptance failure refund the original hour. Reputation resumes still exclude everything through the exact review timestamp.

Non-manage readers receive app unsubscribe capabilities redacted from content and nested event/webhook payloads; raw MIME is withheld. This does not sanitize arbitrary third-party password-reset links—content-read grants belong only with trusted integrations. Campaign substitutions reject executable, unquoted, comment, and foreign-markup contexts and validate completed URLs. SES templates retain their caller-escaping contract.

Postgres request/resource budgets bound major amplification paths. Authenticated credentials default to 1,200 requests/minute. Outstanding (queued or attempting) direct email is capped per workspace at the account's SES 24-hour quota, between 10,000 and 200,000 (shared-pool workspaces default to 10,000); there is no per-key cap. Stored attachments are limited to 1 GiB per workspace and expanded batch content to 128 MiB. These are implementation limits, not plan entitlements or full isolation from shared infrastructure costs.

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

Use an isolated database with synthetic identities, never real user data, for local acceptance. For that dedicated local test installation, the suite needs the server's matching `BETTER_AUTH_SECRET`, `API_BASE_URL`, and paired `DATABASE_URL`. Allow its default fixture email `operator@example.com` in `AUTH_ALLOWED_EMAILS` and fixture domain `example.com` in `AUTH_ALLOWED_DOMAINS` (or use matching `AUTH_TEST_EMAIL` / `AUTH_TEST_GOOGLE_DOMAIN` values). Reserve `operator@example.com` for the fixture; it must not collide with an existing user. Restart the API/worker after changing configuration. These are **test-only** identities/permissions, not production onboarding, and fake OAuth credentials alone are not an alternate login path.

The dashboard is desktop-first. At a 390-pixel viewport its controls remain reachable, but the persistent sidebar leaves a cramped main pane; small-screen layout polish remains a follow-up, not a verified mobile-ready claim.

Useful checks, from their respective packages:

- `api/`: `npm run check`, `npm test`, `npm run sdk`, and `npm run cf:check` (after the dashboard build).
- `app/`: `npm run build`.
- `mcp/`: `npm run check` and `npm run build`; exercise the stdio client against the local API with a scoped key on a simulated deployment.

Live acceptance is opt-in with `LIVE_SES_TEST=1`, `SES_TEST_RECIPIENT`, and `SES_TEST_FROM` for explicitly authorized real sending. The commands above describe checks, not a claim that they have passed on your installation. Docker/Workers builds, local simulation, Google mocks, and source review do not replace the [external release gates](#ses-and-production-release-gates).
