# OpenSend setup and operations

One Hono/TypeScript API for Node/Docker and Cloudflare Workers. The dashboard and generated SDK use that same public API; MCP discovers its OpenAPI contract. PostgreSQL is the source of truth, a Postgres outbox drives sending/webhooks, and private R2/S3 stores attachments. No Redis, D1, Durable Objects, passwords, teams, or production admin bypass.

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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Your installation's real Google OAuth **Web application** client credentials. See below. |
| `AUTH_ALLOWED_EMAILS` | Comma-separated exact Google email addresses. Use this for personal Gmail accounts. |
| `AUTH_ALLOWED_DOMAINS` | Optional comma-separated exact Google Workspace hosted domains, checked against Google's verified `hd` claim—not an email suffix. Either allowlist can approve a user; missing/empty lists deny everyone. All approved users are admins. |
| `PUBLIC_URL` | Canonical external **origin**, without path, query, fragment, or credentials. HTTPS is required except for `localhost` and `127.0.0.1`. Docker default: `http://127.0.0.1:8793`. |
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

`wrangler.jsonc` is a deployment template, **not a provisioned deployment**. Provision the named R2 bucket, Queue, and Hyperdrive connection in your own account, then replace all placeholder IDs/origins. Use separate resources/configuration for each environment. The dashboard build is served from `app/dist` as Workers assets on the API's origin.

**Disable Hyperdrive query caching** with `--caching-disabled`; a shorter TTL is not equivalent. Authentication, consent, idempotency, and job state need fresh reads. Hyperdrive still provides pooling. See [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

Supply `BETTER_AUTH_SECRET` and `GOOGLE_CLIENT_SECRET` using Worker secrets; configure your real `GOOGLE_CLIENT_ID`, allowlists, and HTTPS `PUBLIC_URL` for this deployment. When deliberately enabling live SES, also supply `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN` securely. Use interactive `wrangler secret put`, not secrets in config or command arguments. Pasted temporary credentials are not automatically renewed.

Build `app/` with `npm ci` and `npm run build` before `npm run cf:check` in `api/`. `cf:check` is a deployment **dry run**, not a deployment or remote-resource check. For local Workers, keep an ignored `api/.dev.vars` containing only the required Worker settings and secrets, including both Google credentials, allowlists, `BETTER_AUTH_SECRET`, and the local `PUBLIC_URL`. This avoids loading unrelated Docker/storage credentials from `.env`. Securely set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, then use `npm run cf:dev -- --port 8794` and a matching `PUBLIC_URL`/Google callback. Local Hyperdrive cannot certify production pooling/caching; see [local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

HTTP, Queue, and scheduled handlers share the outbox. Queue messages are wakeups; committed jobs survive a lost wakeup. Cron recovers due work and performs hourly retention. Each invocation processes one leased job. Scheduling prefers live/test work 3:1 with fallback; within an environment, SES feedback precedes sending and callbacks. PostgreSQL transactions/leases, not process-local state, control dispatch.

## SDK and MCP

- `/openapi.json` comes from the actual Zod route schemas; stable operation IDs define generated SDK methods. `npm run sdk` exports the contract, generates `../sdk/src`, and compiles it. Do not edit generated code. See [SDK usage](../sdk/README.md).
- The dashboard uses the same public API as integrations; Google establishes an administrator session, not a separate dashboard business API. API keys are hashed at rest and scoped to live/test environments. Give integrations only necessary grants; sending-domain restrictions are not a general data-isolation boundary.
- [MCP setup](../mcp/README.md) uses `OPENSEND_API_URL` and a scoped `OPENSEND_API_KEY` over local stdio. It discovers tools from the running public spec, defaults to read-only, and requires both `OPENSEND_MCP_ALLOW_WRITES=true` and `confirm: true` on **every write**. It does not reuse browser Google sessions or read database/AWS credentials.
- Collections return `{ data, nextCursor }`. HTTP `202` means queued, not delivered. Read stored message/event state to find the outcome.
- Use `Idempotency-Key` for retriable writes: exact repeats return the recorded result; conflicting payloads return `IDEMPOTENCY_CONFLICT`. Without a key, requests do not create permanent idempotency records.

## SES and production release gates

Leave `ENABLE_LIVE_SES=false` until real sending is deliberately configured. Test keys simulate sends without SES calls, production suppression effects, or production engagement; they do not certify real MIME rendering/delivery.

1. Configure your AWS connection with least privilege. This implementation reads SES credentials explicitly from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`; it does not automatically resolve or renew instance/task-role credentials. Supply them securely and arrange renewal if using temporary credentials. Set `SES_REGIONS` to the regions you actually use. This is not a customer-connection enrollment service.
2. Verify regional SES identities and publish the DKIM records **returned by SES**, never guessed records. Configure the transactional/marketing configuration sets named in `.env`, and review SES sandbox/production access and quotas. See [SES verified identities](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html) and [configuration sets](https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets.html).
3. Configure SNS event destinations, restrictive publisher policies, and exact trusted `SNS_TOPIC_ARNS`. Set `AWS_ACCOUNT_ID` to the actual SES sending account whenever topics are configured. Keep the signed SNS envelope (disable Raw Message Delivery); OpenSend verifies signatures, pinned AWS certificate URLs, topic membership, and sending-account identity at ingestion/processing. Prefer SignatureVersion 2. See [SNS delivery verification](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).
4. Verify public HTTPS, private buckets, verified database TLS, disabled Hyperdrive caching where used, proxy/log-export redaction, and least-privilege database/IAM/SNS policies. Set `WEBHOOK_ALLOWED_HOSTS` only to exact trusted public hosts before enabling outbound webhooks. An empty list denies outbound webhook destinations.
5. With explicitly authorized credentials and recipients, test a **real Google consent/callback**, a live SES send and received message, authentic SNS feedback, and public signed webhook delivery. Only then enable intended live workloads. Local mocks and dry runs cannot certify these integrations; no Cloudflare deployment or real Google/SES verification is implied here.

OpenSend does not silently provision paid AWS features, change your DNS, or request mailbox access.

## Sending and operational boundaries

| Capability | Current boundary |
| --- | --- |
| Single / batch sends | Durable per-message jobs, at most 50 recipients/message and 100 messages/submission. Plain ASCII addresses (punycode domains supported), with an optional validated `fromName` for the sender display name; no arbitrary message headers. Each result has a message ID, not a separate batch-status resource. SES sends are individual, not `SendBulkEmail`. |
| Campaigns | Versioned drafts/reviews, previews, scheduling, and cancellation before dispatch. Initial review/import limit is 1,000 contacts/rows; larger input fails rather than truncates. Revocation cannot recall accepted or in-flight mail. |
| Templates | SES Get/TestRender/Get snapshots; callers must HTML-escape template data. The campaign editor escapes its own simple substitutions. Local test rendering is not proof of a real SES render. |
| Attachments | JSON/base64 upload and authenticated `/v1/attachments/{id}/content` download with private object IDs and ownership/reference checks. At most 8 MiB decoded attachments, 16 MiB estimated encoded message size, and 512 KiB per direct body part. Conservative file-extension allowlist; no arbitrary URL fetching. SES-rendered raw templates cannot add structured attachments. |
| Retries / rate | Shared regional quota reservations. Six bounded transient attempts, delayed 15s, 1m, 4m, 16m, and 1h; ambiguous provider acceptance is not automatically replayed. Failed jobs remain inspectable. |
| Webhooks | Ten event types, seven operational defaults, signed deliveries, encrypted per-endpoint secrets, pause/resume, and manual retries. Exact administrator-managed host allowlist. Paused local fixtures do not prove public delivery. |
| Unsubscribe | Immediate hosted GET and provider one-click POST; persistent opaque capabilities opt out of all installation marketing. Repeated clicks are idempotent. Link scanners can trigger footer opt-outs intentionally; HEAD returns 405 without changing consent. No preference-center UI. |
| Domain readiness | SES-returned DKIM zone is authoritative. Missing DNS is explicit; lists are capped at ten with paced control-plane reads. OpenSend neither creates AWS connections nor replaces DNS records. |

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

For a dedicated local test installation, the suite needs the server's matching `BETTER_AUTH_SECRET`, `API_BASE_URL`, and paired `DATABASE_URL`. Allow its default fixture email `operator@example.com` in `AUTH_ALLOWED_EMAILS` and fixture domain `example.com` in `AUTH_ALLOWED_DOMAINS` (or use matching `AUTH_TEST_EMAIL` / `AUTH_TEST_GOOGLE_DOMAIN` values). Reserve `operator@example.com` for the fixture; it must not collide with an existing user. Set `WEBHOOK_ALLOWED_HOSTS=example.com` for paused webhook fixtures. Restart the API/worker after changing configuration. These are **test-only** identities/permissions, not production onboarding, and fake OAuth credentials alone are not an alternate login path.

The dashboard is desktop-first. At a 390-pixel viewport its controls remain reachable, but the persistent sidebar leaves a cramped main pane; small-screen layout polish remains a follow-up, not a verified mobile-ready claim.

Useful checks, from their respective packages:

- `api/`: `npm run check`, `npm test`, `npm run sdk`, and `npm run cf:check` (after the dashboard build).
- `app/`: `npm run build`.
- `mcp/`: `npm run check` and `npm run build`; exercise the stdio client against the local API with a scoped test key.

Live acceptance is opt-in with `LIVE_SES_TEST=1`, `SES_TEST_RECIPIENT`, and `SES_TEST_FROM` for explicitly authorized real sending. The commands above describe checks, not a claim that they have passed on your installation. Docker/Workers builds, local simulation, Google mocks, and source review do not replace the [external release gates](#ses-and-production-release-gates).
