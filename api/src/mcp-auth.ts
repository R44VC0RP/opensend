import { mcp } from '@better-auth/mcp';
import { createResourceServerChallenge } from '@better-auth/oauth-provider';
import { APIError } from 'better-auth/api';
import { createDpopReplayStore, enforceDpopBinding, isDpopBindingError, parseAccessTokenAuthorization, verifyJwsAccessToken } from 'better-auth/oauth2';
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, like } from 'drizzle-orm';
import { actor, ApiError, errors, IdParams, log, page as pageSchema, PageQuery, response, security } from './core.js';
import type { Actor, App, DbExecutor, Permission, Runtime } from './core.js';
import { createAuth, isApprovedUser, requireDashboardOrigin } from './google-auth.js';
import { agentTokens } from './db/core.js';
import { authUser } from './db/google-auth.js';
import { oauthAccessToken, oauthClient, oauthClientResource, oauthConsent, oauthRefreshToken, oauthResource } from './db/mcp-auth.js';

const scopes = ['opensend:read', 'opensend:send', 'opensend:manage', 'opensend:live', 'offline_access'];
const permissions: Permission[] = ['read', 'send', 'manage'];
const originOf = (runtime: Runtime) => new URL(runtime.config.publicUrl).origin;
const resourceOf = (runtime: Runtime) => `${originOf(runtime)}/mcp`;
const issuerOf = (runtime: Runtime) => `${originOf(runtime)}/api/auth`;

function originalScopes(reference: string | null) {
  const match = reference?.match(/^mcp_[0-9a-f-]{36}\|(.+)$/);
  const values = match?.[1]?.split(' ') ?? [];
  return values.length && values.every(value => scopes.includes(value)) ? values : [];
}
function grantPermissions(values: readonly string[]): Permission[] {
  return permissions.filter(permission => values.includes(`opensend:${permission}`));
}
function invalidGrant(): never {
  throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'This OpenSend approval is no longer valid.' });
}

// Each auth instance belongs to one request. One reference is reused when the
// consent endpoint internally resumes authorize, then persists through refresh.
// It also captures the original scope ceiling: later consent edits can only
// reduce an existing identity, never elevate an already queued job.
export function createMcpPlugin(runtime: Runtime) {
  const authorizationId = crypto.randomUUID();
  const resource = resourceOf(runtime);
  return mcp({
    resource, loginPage: '/mcp/login', consentPage: '/mcp/consent', scopes,
    resources: [{ identifier: resource, name: 'OpenSend MCP', allowedScopes: scopes, accessTokenTtl: 300 }],
    grantTypes: ['authorization_code', 'refresh_token'], accessTokenExpiresIn: 300,
    refreshTokenExpiresIn: 30 * 24 * 60 * 60, refreshTokenReuseInterval: 0, codeExpiresIn: 600,
    allowDynamicClientRegistration: true, allowUnauthenticatedClientRegistration: true,
    allowPublicClientPrelogin: true, clientRegistrationRequirePKCE: true,
    clientRegistrationDefaultScopes: ['opensend:read'], clientRegistrationAllowedScopes: scopes,
    enforcePerClientResources: true, storeTokens: 'hashed', storeClientSecret: 'hashed',
    clientPrivileges: () => false, resourcePrivileges: () => false,
    postLogin: {
      page: '/mcp/consent', shouldRedirect: () => false,
      consentReferenceId: async ({ user, scopes: requested }) => {
        if (!user || !await isApprovedUser(runtime, user.id) || !requested.every(scope => scopes.includes(scope)) || !grantPermissions(requested).length) invalidGrant();
        return `mcp_${authorizationId}|${[...new Set(requested)].sort().join(' ')}`;
      },
    },
    extensions: [{ claims: { accessToken: async ({ user, client, referenceId, scopes: requested, resources }) => {
      if (!user || !referenceId || resources?.length !== 1 || resources[0] !== resource) invalidGrant();
      const [consent] = await runtime.db.select({ id: oauthConsent.id }).from(oauthConsent)
        .where(and(eq(oauthConsent.userId, user.id), eq(oauthConsent.clientId, client.clientId), eq(oauthConsent.referenceId, referenceId))).limit(1);
      if (!consent) invalidGrant();
      const grant = await loadGrant(runtime, `mcp_${consent.id}`);
      if (!grant || !requested.every(scope => grant.scopes.includes(scope))) invalidGrant();
      return { opensend_grant: grant.actor.keyId };
    } } }],
  });
}

async function loadGrant(runtime: Runtime, keyId: string, db: DbExecutor = runtime.db) {
  if (!/^mcp_[A-Za-z0-9_-]{1,128}$/.test(keyId)) return null;
  const [row] = await db.select({
    id: oauthConsent.id, userId: oauthConsent.userId, clientId: oauthConsent.clientId,
    scopes: oauthConsent.scopes, referenceId: oauthConsent.referenceId, resources: oauthConsent.resources,
    clientDisabled: oauthClient.disabled, clientScopes: oauthClient.scopes,
    resourceDisabled: oauthResource.disabled, resourceScopes: oauthResource.allowedScopes,
  }).from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthConsent.clientId, oauthClient.clientId))
    .innerJoin(oauthClientResource, eq(oauthClientResource.clientId, oauthClient.clientId))
    .innerJoin(oauthResource, and(eq(oauthResource.identifier, oauthClientResource.resourceId), eq(oauthResource.identifier, resourceOf(runtime))))
    .where(eq(oauthConsent.id, keyId.slice(4))).limit(1).for('share');
  // SHARE locks retain consent/client/resource policy through the caller's
  // dispatch transaction. Google approval takes its own user/account locks.
  if (!row?.userId || row.clientDisabled || row.resourceDisabled || row.resources?.length !== 1 || row.resources[0] !== resourceOf(runtime) ||
    !await isApprovedUser(runtime, row.userId, db)) return null;
  const allowed = originalScopes(row.referenceId).filter(scope => row.scopes.includes(scope) && (row.clientScopes ?? scopes).includes(scope) && (row.resourceScopes ?? scopes).includes(scope));
  const granted = grantPermissions(allowed);
  if (!granted.length) return null;
  const actor: Actor = { keyId, workspaceId: runtime.config.workspaceId, environment: allowed.includes('opensend:live') ? 'live' : 'test', permissions: granted, domains: [], credential: 'mcp' };
  return { actor, scopes: allowed, userId: row.userId, clientId: row.clientId };
}

export async function getMcpGrantActor(runtime: Runtime, keyId: string, db: DbExecutor = runtime.db): Promise<Actor | null> {
  return (await loadGrant(runtime, keyId, db))?.actor ?? null;
}
function deniedToken(runtime: Runtime) {
  return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'OpenSend authorization is required.' }, id: null }, {
    status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${originOf(runtime)}/.well-known/oauth-protected-resource/mcp", scope="opensend:read"` },
  });
}
export async function withMcpAuthorization(runtime: Runtime, request: Request, handler: (actor: Actor) => Promise<Response>): Promise<Response> {
  const authorization = parseAccessTokenAuthorization(request.headers.get('authorization'));
  if (!authorization?.token || authorization.scheme === 'Unknown' || authorization.token.length > 16 * 1024) return deniedToken(runtime);
  let actor: Actor;
  try {
    const auth = createAuth(runtime);
    // The MCP convenience wrapper fetches its own public JWKS URL. Avoid a
    // Worker self-fetch (and an unnecessary network hop) using the same exported
    // verifier with request-local keys. Never cache a Workers adapter globally.
    const jwks = await auth.api.getJwks();
    const claims = await verifyJwsAccessToken(authorization.token, { jwksFetch: async () => jwks,
      verifyOptions: { issuer: issuerOf(runtime), audience: resourceOf(runtime), algorithms: ['ES256'], typ: 'at+jwt', requiredClaims: ['sub', 'exp', 'iat', 'client_id'] },
    }).catch(() => null);
    if (!claims) return deniedToken(runtime);
    try {
      await enforceDpopBinding({ payload: claims, authorization, proofJwt: request.headers.get('dpop'), method: request.method, url: request.url,
        replayStore: createDpopReplayStore((await auth.$context).internalAdapter),
      });
    } catch (error) {
      if (!isDpopBindingError(error)) throw error;
      const challenge = createResourceServerChallenge(new APIError('UNAUTHORIZED', { error: error.code, message: error.message, error_description: error.message }), resourceOf(runtime), { challengeScopes: ['opensend:read'] });
      if (!challenge) return deniedToken(runtime);
      const headers = new Headers(challenge.headers); headers.set('Cache-Control', 'no-store');
      return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: challenge.message }, id: null }, { status: challenge.statusCode, headers });
    }
    const audience = claims.aud;
    if (audience !== resourceOf(runtime) && !(Array.isArray(audience) && audience.length === 1 && audience[0] === resourceOf(runtime))) return deniedToken(runtime);
    if (typeof claims.opensend_grant !== 'string' || typeof claims.scope !== 'string' || !claims.scope || claims.scope.split(' ').some(scope => !scopes.includes(scope))) return deniedToken(runtime);
    const grant = await loadGrant(runtime, claims.opensend_grant);
    if (!grant || claims.sub !== grant.userId || claims.client_id !== grant.clientId) return deniedToken(runtime);
    const tokenScopes = claims.scope.split(' ').filter(scope => grant.scopes.includes(scope));
    const granted = grantPermissions(tokenScopes);
    if (!granted.length) return deniedToken(runtime);
    actor = { ...grant.actor, permissions: granted, environment: tokenScopes.includes('opensend:live') ? 'live' : 'test' };
  } catch {
    log('warn', { operation: 'mcp-authorization', code: 'AUTH_UNAVAILABLE' });
    return oauthError(503, 'temporarily_unavailable', 'OpenSend authorization is temporarily unavailable.');
  }
  return handler(actor);
}

function oauthError(status: number, error: string, description: string) {
  return Response.json({ error, error_description: description }, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function boundedBody(request: Request, limit = 64 * 1024): Promise<string> {
  if (Number(request.headers.get('content-length')) > limit) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'OAuth request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new ApiError(413, 'REQUEST_TOO_LARGE', 'OAuth request is too large.'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
const machineEndpoints = new Set(['/oauth2/token', '/oauth2/register', '/oauth2/introspect', '/oauth2/revoke']);
const sessionReads = new Set(['/oauth2/get-consents', '/oauth2/get-consent']);
const sessionWrites = new Set(['/oauth2/consent', '/oauth2/delete-consent']);
export function isMcpAuthPath(path: string) {
  return path === '/jwks' || path === '/oauth2/authorize' || machineEndpoints.has(path) || sessionReads.has(path) || sessionWrites.has(path);
}
function publicCors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, DPoP');
  headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, DPoP-Nonce');
  headers.delete('Access-Control-Allow-Credentials');
  return new Response(response.body, { status: response.status, headers });
}
async function protocolRequest(runtime: Runtime, request: Request): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname.slice('/api/auth'.length);
  const machine = machineEndpoints.has(path); const cors = machine || path === '/jwks';
  if (request.method === 'OPTIONS' && cors) return publicCors(new Response(null, { status: 204 }));
  const expected = machine || sessionWrites.has(path) ? 'POST' : 'GET';
  if (request.method !== expected) return oauthError(405, 'invalid_request', 'Unsupported HTTP method.');
  try {
    if (url.search.length > 16 * 1024) return oauthError(400, 'invalid_request', 'OAuth request is too large.');
    if (sessionWrites.has(path)) requireDashboardOrigin(runtime, request.headers);
    const auth = createAuth(runtime);
    // Init starts immediately (including resource seeding). Observe its failure
    // before any validation branch can return and leave a rejected promise.
    await auth.$context;
    if (sessionWrites.has(path) || sessionReads.has(path)) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session || !await isApprovedUser(runtime, session.user.id)) return oauthError(401, 'access_denied', 'An approved Google session is required.');
    }
    const headers = new Headers(request.headers);
    if (machine) headers.delete('cookie'); // Protocol clients never inherit browser/session authority.
    let body: string | undefined;
    if (request.method === 'POST') body = await boundedBody(request);
    if (path === '/oauth2/register') {
      const input: unknown = JSON.parse(body ?? '');
      if (!input || typeof input !== 'object' || Array.isArray(input)) return publicCors(oauthError(400, 'invalid_client_metadata', 'Invalid client metadata.'));
      const metadata = input as Record<string, unknown>;
      // No attacker-selected network fetches in Workers: CIMD, remote JWKS,
      // request objects, and back-channel logout are deliberately not enabled.
      if (metadata.jwks_uri !== undefined || metadata.backchannel_logout_uri !== undefined || metadata.request_uris !== undefined ||
        (metadata.subject_type !== undefined && metadata.subject_type !== 'public') ||
        (metadata.token_endpoint_auth_method !== undefined && !['none', 'client_secret_basic', 'client_secret_post'].includes(String(metadata.token_endpoint_auth_method)))) {
        return publicCors(oauthError(400, 'invalid_client_metadata', 'Use authorization code with PKCE and a public or client-secret client.'));
      }
      // Legacy desktop clients omit application_type. Infer native only for
      // exact loopback hosts; keep the provider's remaining URI checks intact.
      if (metadata.application_type === undefined && Array.isArray(metadata.redirect_uris) && metadata.redirect_uris.length > 0 &&
        metadata.redirect_uris.every(uri => {
          if (typeof uri !== 'string' || uri.includes('#') || !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d*)?(?:[/?]|$)/i.test(uri)) return false;
          try {
            const redirect = new URL(uri);
            return ['http:', 'https:'].includes(redirect.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) &&
              !redirect.username && !redirect.password;
          } catch { return false; }
        })) metadata.application_type = 'native';
      body = JSON.stringify(metadata);
      headers.delete('content-length');
    }
    if (path === '/oauth2/authorize') {
      if (!url.searchParams.has('scope')) url.searchParams.set('scope', 'opensend:read');
      if (!url.searchParams.has('resource')) url.searchParams.set('resource', resourceOf(runtime));
      const resources = url.searchParams.getAll('resource');
      if (resources.length !== 1 || resources[0] !== resourceOf(runtime)) return oauthError(400, 'invalid_target', 'Request the canonical OpenSend MCP resource.');
    }
    const result = await auth.handler(new Request(url, { method: request.method, headers, body }));
    // OAuth errors and redirect state belong to the protocol, not the Google
    // dashboard error page. Do not rewrite them into OpenSend API envelopes.
    return cors ? publicCors(result) : result;
  } catch (error) {
    const result = error instanceof ApiError ? oauthError(error.status, 'invalid_request', error.message) :
      error instanceof SyntaxError ? oauthError(400, 'invalid_request', 'Invalid request body.') :
        oauthError(503, 'temporarily_unavailable', 'OpenSend authorization is temporarily unavailable.');
    if (!(error instanceof ApiError) && !(error instanceof SyntaxError)) log('warn', { operation: 'mcp-oauth', code: 'AUTH_UNAVAILABLE' });
    return cors ? publicCors(result) : result;
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function page(title: string, content: string) {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · OpenSend</title><style nonce="${nonce}">@font-face{font-family:Inter;src:url("/fonts/inter-variable.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}*{box-sizing:border-box;letter-spacing:-0.01em}body{margin:0;background:#fafafa;color:#202020;font:16px/1.5 Inter,Arial,sans-serif;letter-spacing:-0.01em}main{max-width:520px;margin:12vh auto;padding:24px}h1{font-size:22px;line-height:1.25;margin:0 0 24px;font-weight:600}p{margin:16px 0}ul{padding-left:22px;margin:20px 0}li{margin:8px 0}.identity{color:#555;overflow-wrap:anywhere}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}button{font:inherit;letter-spacing:inherit;padding:10px 18px;border:1px solid #bbb;border-radius:6px;background:transparent;color:inherit;cursor:pointer}button[value=approve],button[value=signin]{background:#202020;color:white;border-color:#202020}button:focus-visible{outline:2px solid #345ad4;outline-offset:3px}small{font-size:14px}a{color:inherit}strong{font-weight:600}</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'` },
  });
}
const scopeLabels: Record<string, string> = {
  'opensend:read': 'Read email, audience, delivery, and account data',
  'opensend:send': 'Send email and manage campaigns',
  'opensend:manage': 'Full account access, including sending and managing credentials',
  'offline_access': 'Stay connected for up to 30 days without signing in again',
};
const McpConnection = z.object({ id: z.string(), clientId: z.string(), name: z.string().nullable(), userEmail: z.string(), scopes: z.array(z.string()), createdAt: z.string(), updatedAt: z.string() }).openapi('McpConnection');
function dashboardOwner(c: Parameters<typeof actor>[0]) {
  const identity = actor(c, 'manage');
  if (identity.credential !== 'dashboard' || !identity.keyId.startsWith('user_')) throw new ApiError(403, 'DASHBOARD_AUTH_REQUIRED', 'MCP connections can only be managed from an approved dashboard session.');
  return identity;
}
async function consentPage(runtime: Runtime, request: Request) {
  try {
    if (request.method === 'POST') requireDashboardOrigin(runtime, request.headers);
    const form = request.method === 'POST' ? new URLSearchParams(await boundedBody(request, 20 * 1024)) : null;
    const query = form?.get('oauth_query') ?? new URL(request.url).search.slice(1);
    if (query.length > 16 * 1024 || !query) return page('Connection expired', '<p>Restart the connection from your MCP client.</p>');
    const params = new URLSearchParams(query); const clientId = params.get('client_id');
    if (!clientId) return page('Connection expired', '<p>Restart the connection from your MCP client.</p>');
    const auth = createAuth(runtime);
    // This server-only call verifies Better Auth's signed/expiring OAuth query
    // before any client name, scope, redirect, or approval is displayed or used.
    await auth.api.getOAuthClientPublicPrelogin({ body: { client_id: clientId, oauth_query: query } });
    const requested = (params.get('scope') ?? '').split(' ').filter(Boolean);
    if (!requested.every(scope => scopes.includes(scope)) || !grantPermissions(requested).length || params.getAll('resource').length !== 1 || params.get('resource') !== resourceOf(runtime)) {
      return page('Invalid connection request', '<p>Restart the connection from your MCP client.</p>');
    }
    const session = await auth.api.getSession({ headers: request.headers });
    const approvedSession = session && await isApprovedUser(runtime, session.user.id) ? session : null;
    const action = form?.get('action');
    if (action === 'signin') {
      const headers = new Headers(request.headers); headers.set('Content-Type', 'application/json');
      const result = await auth.handler(new Request(`${issuerOf(runtime)}/sign-in/social`, { method: 'POST', headers,
        body: JSON.stringify({ provider: 'google', callbackURL: `${originOf(runtime)}/mcp/consent?${query}`, errorCallbackURL: `${originOf(runtime)}/?auth=error` }),
      }));
      return redirectResult(result);
    }
    if (form && action !== 'approve' && action !== 'deny') return oauthError(400, 'invalid_request', 'Choose an approval action.');
    if (form && approvedSession) {
      const headers = new Headers(request.headers); headers.set('Content-Type', 'application/json');
      return redirectResult(await auth.handler(new Request(`${issuerOf(runtime)}/oauth2/consent`, { method: 'POST', headers, body: JSON.stringify({ accept: action === 'approve', oauth_query: query }) })));
    }
    const hidden = `<input type="hidden" name="oauth_query" value="${escapeHtml(query)}">`;
    if (!approvedSession || (new URL(request.url).pathname === '/mcp/login' && (params.get('prompt') ?? '').split(' ').includes('login'))) {
      return page('Connect OpenSend', `<form method="post" action="/mcp/login">${hidden}<p>Use your approved Google account to connect this client.</p><div class="actions"><button name="action" value="signin">Continue with Google</button></div></form>`);
    }
    const [client] = await runtime.db.select({ name: oauthClient.name, disabled: oauthClient.disabled }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
    if (!client || client.disabled) return page('Client unavailable', '<p>This client can no longer connect to OpenSend.</p>');
    const name = client.name?.slice(0, 160) || 'This MCP client';
    const live = requested.includes('opensend:live');
    const labels = requested.filter(scope => scope !== 'opensend:live' && !(requested.includes('opensend:manage') && ['opensend:read', 'opensend:send'].includes(scope))).map(scope => `<li>${escapeHtml(scopeLabels[scope]!)}</li>`).join('');
    return page(`Allow ${name}?`, `<p class="identity">${escapeHtml(approvedSession.user.email)}</p><p><strong>${live ? 'Live environment — email can reach real recipients.' : 'Test environment — no real email is sent.'}</strong></p><ul>${labels}</ul><form method="post" action="/mcp/consent">${hidden}<div class="actions"><button name="action" value="approve">Allow access</button><button name="action" value="deny">Cancel</button></div></form>`);
  } catch (error) {
    if (error instanceof ApiError) return oauthError(error.status, 'access_denied', error.message);
    return page('Connection expired', '<p>Restart the connection from your MCP client.</p>');
  }
}
async function redirectResult(result: Response) {
  if (!result.ok) return result;
  const payload: unknown = await result.json();
  if (!payload || typeof payload !== 'object' || !('url' in payload) || typeof payload.url !== 'string') return oauthError(503, 'temporarily_unavailable', 'Unable to continue this connection.');
  // Only Better Auth's validated/generated redirects reach this function.
  const headers = new Headers(result.headers); headers.delete('Content-Type'); headers.set('Location', payload.url); headers.set('Referrer-Policy', 'no-referrer'); headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 303, headers });
}
export function registerMcpAuth(app: App): void {
  app.openapi(createRoute({ method: 'get', path: '/v1/mcp-connections', operationId: 'listMcpConnections', tags: ['Auth'], security, request: { query: PageQuery }, responses: { 200: response(pageSchema(McpConnection)), ...errors } }), async c => {
    dashboardOwner(c); const query = c.req.valid('query');
    const rows = await c.env.db.select({ id: oauthConsent.id, clientId: oauthConsent.clientId, name: oauthClient.name, userEmail: authUser.email, scopes: oauthConsent.scopes, createdAt: oauthConsent.createdAt, updatedAt: oauthConsent.updatedAt }).from(oauthConsent)
      .innerJoin(oauthClient, eq(oauthConsent.clientId, oauthClient.clientId)).innerJoin(authUser, eq(oauthConsent.userId, authUser.id))
      .where(and(like(oauthConsent.referenceId, 'mcp\_%'), query.cursor ? gt(oauthConsent.id, query.cursor) : undefined)).orderBy(oauthConsent.id).limit(query.limit + 1);
    return c.json({ data: rows.slice(0, query.limit).map(row => ({ ...row, id: `mcp_${row.id}`, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })), nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/mcp-connections/{id}/revoke', operationId: 'revokeMcpConnection', tags: ['Auth'], security, request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const identity = dashboardOwner(c); const connectionId = c.req.valid('param').id; const consentId = connectionId.startsWith('mcp_') ? connectionId.slice(4) : '';
    const revoked = await c.env.db.transaction(async tx => {
      const [connection] = await tx.select().from(oauthConsent).where(and(eq(oauthConsent.id, consentId), like(oauthConsent.referenceId, 'mcp\_%'))).limit(1).for('update');
      if (!connection?.userId) return false;
      const revokedAt = new Date().toISOString();
      if (connection.referenceId) {
        await tx.update(oauthAccessToken).set({ revoked: new Date(revokedAt) }).where(and(eq(oauthAccessToken.clientId, connection.clientId), eq(oauthAccessToken.userId, connection.userId), eq(oauthAccessToken.referenceId, connection.referenceId)));
        await tx.update(oauthRefreshToken).set({ revoked: new Date(revokedAt) }).where(and(eq(oauthRefreshToken.clientId, connection.clientId), eq(oauthRefreshToken.userId, connection.userId), eq(oauthRefreshToken.referenceId, connection.referenceId)));
      }
      await tx.update(agentTokens).set({ revokedAt }).where(and(eq(agentTokens.workspaceId, identity.workspaceId), eq(agentTokens.grantId, connectionId)));
      await tx.delete(oauthConsent).where(eq(oauthConsent.id, consentId));
      return true;
    });
    if (!revoked) throw new ApiError(404, 'NOT_FOUND', 'MCP connection was not found.');
    return c.json({ id: connectionId, revoked: true as const }, 200);
  });
  for (const path of ['/jwks', '/oauth2/authorize', ...machineEndpoints, ...sessionReads, ...sessionWrites]) {
    app.on(['GET', 'POST', 'OPTIONS'], `/api/auth${path}`, c => protocolRequest(c.env, c.req.raw));
  }
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api/auth']) {
    app.on(['GET', 'HEAD', 'OPTIONS'], path, async c => {
      if (c.req.method === 'OPTIONS') return publicCors(new Response(null, { status: 204 }));
      try {
        const url = new URL(c.req.raw.url);
        if (path === '/.well-known/oauth-authorization-server') url.pathname = '/.well-known/oauth-authorization-server/api/auth';
        return publicCors(await createAuth(c.env).handler(new Request(url, c.req.raw)));
      } catch {
        log('warn', { operation: 'mcp-discovery', code: 'AUTH_UNAVAILABLE' });
        return publicCors(oauthError(503, 'temporarily_unavailable', 'OpenSend authorization is temporarily unavailable.'));
      }
    });
  }
  app.on(['GET', 'POST'], '/mcp/login', c => consentPage(c.env, c.req.raw));
  app.on(['GET', 'POST'], '/mcp/consent', c => consentPage(c.env, c.req.raw));
}
