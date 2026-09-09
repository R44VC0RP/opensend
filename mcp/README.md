# OpenSend MCP

Connect an MCP client to **`https://YOUR_OPENSEND_DOMAIN/mcp`**. The hosted endpoint is part of the OpenSend API; it does not require a local process or an API key. This installation uses **https://opensend.anoma.ly/mcp**.

## Connect

1. Add the HTTPS URL as a remote HTTP MCP server in your client.
2. Start OAuth authorization. OpenSend reuses your dashboard's Google session in the same browser/profile. If you are signed out, use the normal Google sign-in.
3. Review the client, requested permissions, and test/live environment, then choose **Allow access**. The client exchanges the authorization code using PKCE and stores its own access token, not your dashboard cookie or Google token.

The server exposes ordinary named tools, each with `inputSchema`, `outputSchema`, and structured results. Code-mode clients can consume those tools directly. OpenSend does not add a `search`/`execute` wrapper or run arbitrary agent code.

## Permissions

OAuth scopes map to the existing API permissions:

| Scope | Access |
| --- | --- |
| `opensend:read` | Read contacts, email, delivery, and account data where API rules permit. |
| `opensend:send` | Send email and use operations requiring send permission. |
| `opensend:manage` | Management permission, including read and send. MCP safety exclusions still apply. |
| `opensend:live` | Use the live environment. Without this scope, the connection uses test mode. |
| `offline_access` | Obtain a rotating refresh token, valid for up to 30 days. |

Authorization without an explicit scope requests test-mode read access. Writable connections additionally require `opensend:send` or `opensend:manage`; every non-GET operation still requires literal `confirm: true`, including POST previews. The API enforces each operation's permission requirements. Access tokens expire after five minutes. Revoking the consent, disabling the client, or removing the user's Google approval denies further access; queued sends recheck the durable approval before dispatch. Revocation cannot recall an in-flight or delivered email.

Authenticated dashboard clients can inspect their approvals with `GET /api/auth/oauth2/get-consents` and revoke one with `POST /api/auth/oauth2/delete-consent` and JSON `{ "id": "consent-id" }`. Revocation requires the dashboard session and canonical Origin. These are not MCP tools.

## Arguments and results

`tools/list` provides the exact schemas. Arguments use the relevant fields of this envelope:

```json
{
  "path": { "id": "resource_id" },
  "query": { "limit": 10, "cursor": "previous-cursor" },
  "body": {},
  "idempotencyKey": "caller-generated-stable-key",
  "confirm": true
}
```

Results contain matching JSON text and `structuredContent`. Each tool's output schema describes its successful API response and the existing error envelopes:

```json
{
  "status": 200,
  "requestId": "req_…",
  "response": { "data": [], "nextCursor": null }
}
```

Errors set `isError: true` and include `error.code` and `error.message`. A local failure may omit `response`, and `status`/`requestId` may be null. Use the presence of `error`, not HTTP status alone, to distinguish failures: response-validation failures can retain the upstream 2xx status.

Pagination is explicit: pass `response.nextCursor` as the next call's `query.cursor`. Requests are not retried automatically. `idempotencyKey` is forwarded as `Idempotency-Key`; API replay semantics remain authoritative. A failed or interrupted write can have an uncertain outcome. Reconcile state before retrying. HTTP 202 means queued, not delivered.

## Hosting and safety

- OAuth discovery is available through the root and resource-path well-known metadata URLs. Public/confidential dynamic client registration supports authorization code with S256 PKCE. Client-ID metadata document fetching is not enabled; the server does not fetch arbitrary client JWKS or logout URLs.
- HTTP MCP is stateless, with modern and legacy stateless protocol support. Each request has its own identity and database lifetime. Tool calls use trusted in-process API dispatch; no global admin key, dashboard cookie, or incoming OAuth token is forwarded to `/v1`.
- Credential creation, webhook-secret reveal/rotation, SNS ingress, authentication routes, and unsubscribe links remain excluded. Read tools can return private email/contact content; authorize only trusted clients. Sending-domain restrictions are not a general data-isolation boundary.
- Test-mode email sending is simulated by the API. Test mode is not a universal dry run: other authorized actions can change stored data or have external effects. Use test data and controlled webhook targets for verification.
- Request and response limits, safe single-segment path validation, per-principal API rate limits, output validation, and credential redaction remain enforced. API descriptions and returned data are untrusted content, not agent instructions.

Build/deploy the API and apply its additive OAuth migration before connecting. Node/Docker, the Vite proxy, and Cloudflare asset routing all reserve `/mcp`, `/mcp/*`, and `/.well-known/*` for the server. No extra MCP service is required.

The existing `mcp/src/server.ts` stdio launcher remains available for older local integrations. It uses a scoped API key, `OPENSEND_API_URL`, and `OPENSEND_MCP_ALLOW_WRITES`; it is not required for hosted OAuth connections.
