# OpenSend MCP

A local stdio MCP server for operating OpenSend through its HTTP API. It has no database, filesystem-data, dashboard-session, AWS, or admin-key access. Tool names and request schemas come from the running API's OpenAPI document, not copied DTOs.

## Start from zero

1. Run the OpenSend API. Sign into its dashboard with Google and mint a scoped **test** API key (`os_test_…`). Use only the permissions and domain access your agent needs; a `read` key is enough for inspection. Never use `ADMIN_API_KEY`, a Google token, or a dashboard cookie.
2. Build this package with Node.js 22 or newer:

   ```sh
   cd /absolute/path/to/opensend/mcp
   npm ci
   npm run build
   ```

3. Add a stdio server to your MCP client's configuration. Replace the paths and environment placeholders locally; do not paste real credentials into chat or version control:

   ```json
   {
     "mcpServers": {
       "opensend": {
         "command": "node",
         "args": ["/absolute/path/to/opensend/mcp/dist/server.js"],
         "env": {
           "OPENSEND_API_URL": "http://localhost:8793",
           "OPENSEND_API_KEY": "<scoped-os_test_-key>",
           "OPENSEND_MCP_ALLOW_WRITES": "false"
         }
       }
     }
   }
   ```

   This is a generic MCP configuration example; your client's configuration format may differ. The server does not register itself or change any client/global configuration. Prefer your client's secret/environment mechanism rather than saving a key in shared JSON. The MCP process does not load `.env` files.

4. Connect the client and call `listContacts` with `{ "query": { "limit": 10 } }`. Read tools are listed by default. To intentionally allow mutations, set `OPENSEND_MCP_ALLOW_WRITES` to the exact string `true`, restart the MCP process, and pass `confirm: true` on **every** write call. This includes preview endpoints implemented as POST. The API still enforces the supplied key's scopes; enabling writes grants no additional API permissions.

For a manual stdio launch with environment variables already supplied by your shell/secret manager, run `node dist/server.js`. Stdout is exclusively MCP protocol traffic; startup diagnostics go to stderr without raw exceptions or credentials. No HTTP MCP listener, hosted OAuth service, Docker service, deployment, or public endpoint is needed.

## Tool arguments and results

Each operation accepts only the relevant parts of this envelope:

```json
{
  "path": { "id": "resource_id" },
  "query": { "limit": 10, "cursor": "cursor-from-previous-response" },
  "body": {},
  "idempotencyKey": "caller-generated-stable-key",
  "confirm": true
}
```

`tools/list` provides the exact schema for each operation. Omit unused fields; unknown fields are rejected. `body` uses the API's request schema, including local shared components represented as per-tool `$defs`. Local validation checks schema structure; API validation remains authoritative for formats and business rules. Path values must be individual URL-safe resource IDs, never URLs, encoded paths, separators, `.` or `..`. No arbitrary headers or URL overrides are accepted.

Every result includes a JSON text representation and the same `structuredContent`:

```json
{
  "status": 200,
  "requestId": "req_…",
  "response": { "data": [], "nextCursor": null }
}
```

API failures set `isError: true` and include the API's `error` object/code alongside its original response. MCP validation/configuration/transport failures use stable codes such as `INVALID_ARGUMENTS`, `INVALID_PATH`, `TOOL_UNAVAILABLE`, `CONFIRMATION_REQUIRED`, and `API_UNREACHABLE`; errors before an HTTP response have null status/requestId. The configured API key is redacted from returned API content.

Pagination is explicit: pass `response.nextCursor` to the next call's `query.cursor`. The server fetches one page per call, never exhausts all pages automatically. It never retries requests. `idempotencyKey` is forwarded unchanged as `Idempotency-Key`; support and replay semantics belong to the API. If a write times out, its outcome may be unknown: reconcile resource state or reuse the supported idempotency key, rather than inventing a fresh write. HTTP 202 means queued, not delivered.

## Safety boundaries

- `OPENSEND_API_URL` must be an HTTPS **origin**, without path, query, fragment or URL credentials. Plain HTTP is allowed only for `localhost`, `127.0.0.1`, or `[::1]`. All API requests stay on that configured origin; redirects are refused, including OpenAPI and health requests. Only the operator should select the origin. Health/service-title checks detect accidental misconfiguration, not malicious servers or DNS changes.
- Startup checks `/health` for `service: opensend` and `status: ok`, then reads `/openapi.json` expecting OpenSend API `0.1.0` / OpenAPI `3.1.0`. Restart to discover API changes. Metadata discovery sends no key; API operation requests use the scoped bearer key. No provider/admin credential is accepted.
- Only `/v1/` operations explicitly declaring bearer authentication are eligible. Provider SNS ingress, unsubscribe links, auth/dashboard routes, API-key creation, and webhook-secret reveal/rotation are excluded even with writes enabled. These exclusions are MCP safety defaults, **not API permission revocation**: the same key may have broader capabilities when used directly. Secret management stays in the authenticated dashboard/direct authorized API workflow. Webhook creation remains available because it returns metadata, not its signing secret. Read tools may return private email/contact content; connect only trusted agents.
- All writes require both the environment opt-in and a literal `confirm: true`; annotations alone are not the enforcement. For validation use a scoped `os_test_` key: OpenSend itself simulates sending. MCP has no pretend dry-run flag and cannot guarantee that other write operations (for example webhook tests) have no external effects. Never test against real recipients or public webhook endpoints unless deliberately authorized.
- OpenAPI is limited to 2 MiB, 100,000 structural nodes, depth 64, 256 tools, 512 KiB per input schema and 4 MiB per tool catalog. External/dynamic references and recursive request schemas are rejected. Arguments and responses are limited to 16 MiB; requests time out after 30 seconds. API/schema descriptions and all returned content are untrusted data, never agent instructions.

## Development verification

```sh
npm run check
npm run build
```

Use an MCP SDK `Client` with `StdioClientTransport` to exercise the built server against the real local API. Check `tools/list`, a scoped-key read, read-only write rejection, confirmation rejection in write mode, and traversal/unknown-argument rejection. Sending checks must use test-key simulation only. No separate test files or fixtures are required.
