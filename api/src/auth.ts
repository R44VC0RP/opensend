import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ApiError, actor, digest, errors, id, IdParams, json, PageQuery, page, randomSecret, response, security, timed } from './core.js';
import type { Actor, App, AppEnv, Runtime } from './core.js';
import { agentTokens, apiKeys } from './db/core.js';
import { getDashboardActor, requireDashboardOrigin } from './google-auth.js';
import { createAgentToken, verifyAgentToken } from './agent-token.js';
import { getMcpGrantActor } from './mcp-auth.js';

// A private symbol carries server-authorized identity through request-cloning middleware.
// HTTP headers/cookies cannot supply it, and every internal dispatch gets a fresh runtime.
const delegatedActor = Symbol('mcpActor');
type DelegatedRuntime = Runtime & { [delegatedActor]?: Actor };
export async function dispatchAsActor(app: App, request: Request, runtime: Runtime, identity: Actor): Promise<Response> {
  if (!identity.keyId.startsWith('mcp_') || identity.workspaceId !== runtime.config.workspaceId) throw new ApiError(403, 'PERMISSION_DENIED', 'Invalid delegated API principal.');
  const delegatedRuntime: DelegatedRuntime = { ...runtime, [delegatedActor]: identity };
  return await app.fetch(request, delegatedRuntime);
}

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const delegated = (c.env as DelegatedRuntime)[delegatedActor];
  const authorization = c.req.header('authorization');
  if (delegated) {
    c.set('actor', delegated);
  } else if (authorization !== undefined) {
    const token = authorization.match(/^Bearer (.+)$/i)?.[1];
    if (!token || token.length > 16 * 1024) throw new ApiError(401, 'AUTH_INVALID', 'The API token is invalid or has been revoked.');
    if (token.startsWith('os_agent_')) {
      const temporary = await verifyAgentToken(c.env.config, token);
      const [tracked] = temporary?.v === 2 ? await c.env.db.select().from(agentTokens).where(and(eq(agentTokens.id, temporary.id), eq(agentTokens.workspaceId, c.env.config.workspaceId))).limit(1) : [];
      const grant = temporary ? await getMcpGrantActor(c.env, temporary.grant) : null;
      if (!temporary || temporary.v === 2 && (!tracked || tracked.revokedAt || Date.parse(tracked.expiresAt) !== temporary.exp || tracked.grantId !== temporary.grant || tracked.environment !== temporary.environment || JSON.stringify(tracked.permissions) !== JSON.stringify(temporary.permissions) || JSON.stringify(tracked.domains) !== JSON.stringify(temporary.domains)) || !grant || (temporary.environment === 'live' && grant.environment !== 'live') || temporary.permissions.some(permission => !grant.permissions.includes(permission))) throw new ApiError(401, 'AUTH_INVALID', 'The temporary API token is invalid, expired, or its originating approval was revoked.');
      c.set('actor', { ...grant, environment: temporary.environment, permissions: temporary.permissions, domains: temporary.domains, credential: 'agentToken' });
      if (tracked) await c.env.db.update(agentTokens).set({ lastUsedAt: new Date().toISOString() }).where(and(eq(agentTokens.id, tracked.id), or(isNull(agentTokens.lastUsedAt), sql`${agentTokens.lastUsedAt} < now() - interval '1 minute'`)));
    } else {
      if (!/^os_(?:test|live)_[0-9a-f]{64}$/i.test(token)) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
      const hash = await digest(token);
      const [key] = await c.env.db.select().from(apiKeys).where(and(eq(apiKeys.hash, hash), eq(apiKeys.workspaceId, c.env.config.workspaceId), isNull(apiKeys.revokedAt))).limit(1);
      if (!key) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
      // API-key credentials always define the environment, regardless of cookies or headers.
      c.set('actor', { keyId: key.id, workspaceId: key.workspaceId, environment: key.environment, permissions: key.permissions, domains: key.domains, credential: 'apiKey' });
      await c.env.db.update(apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(and(eq(apiKeys.id, key.id), or(isNull(apiKeys.lastUsedAt), sql`${apiKeys.lastUsedAt} < now() - interval '1 minute'`)));
    }
  } else {
    const dashboard = await getDashboardActor(c.env, c.req.raw.headers, undefined, async (name, work) => timed(c, name, work), headers => {
      const cookie = headers.get('set-cookie');
      if (cookie) c.header('set-cookie', cookie, { append: true });
    });
    if (!dashboard) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in with an approved Google account or supply a bearer API key.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireDashboardOrigin(c.env, c.req.raw.headers);
    c.set('actor', dashboard);
  }
  const identity = c.get('actor');
  if (!identity.keyId.startsWith('user_')) {
    const maxRequests = identity.environment === 'test' ? 600 : 1200;
    const budget = await timed(c, 'budget-db', () => c.env.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
      VALUES (${identity.workspaceId}, ${identity.keyId}, date_trunc('minute', now()), 1)
      ON CONFLICT (workspace_id, key_id) DO UPDATE SET
        used = CASE WHEN api_request_budgets.window_start = excluded.window_start THEN least(api_request_budgets.used + 1, ${maxRequests + 1}) ELSE 1 END,
        window_start = excluded.window_start RETURNING used`));
    if (budget.rows[0]!.used > maxRequests) {
      c.header('Retry-After', '60');
      throw new ApiError(429, 'REQUEST_RATE_LIMITED', `This key exceeded its ${maxRequests}-request minute budget. Retry after the window resets.`, undefined, true);
    }
  }
  await next();
};
const KeySchema = z.object({ id: z.string(), name: z.string(), environment: z.enum(['live', 'test']), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), prefix: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('ApiKey');
const AgentTokenRecord = z.object({ id: z.string(), grantId: z.string(), environment: z.enum(['live', 'test']), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), purpose: z.string(), expiresAt: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('AgentTokenRecord');
const KeyInput = z.object({ name: z.string().trim().min(1).max(100), environment: z.enum(['live', 'test']).default('test'), permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3).default(['send']), domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50).default([]) }).strict().openapi('CreateApiKey');
function manageKeys(c: Parameters<typeof actor>[0]) {
  const value = actor(c, 'manage');
  if (value.credential === 'agentToken') throw new ApiError(403, 'CREDENTIAL_DELEGATION_FORBIDDEN', 'Temporary agent tokens cannot create, list, or revoke API keys.');
  if (value.environment !== 'live' || value.domains.length) throw new ApiError(403, 'PERMISSION_DENIED', 'Key administration requires unrestricted live management access.');
  return value;
}
const keyView = (key: typeof apiKeys.$inferSelect) => { const { hash: _hash, workspaceId: _workspace, ...view } = key; return view; };
export function registerAuth(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens', operationId: 'createAgentToken', tags: ['Auth'], security, description: 'Creates a nonrefreshable, short-lived API token for temporary uncommitted scripts. Requires an MCP OAuth principal and cannot delegate permissions beyond that originating approval. Manage tokens cannot administer credentials.', request: { body: json(z.object({
    permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3).refine(value => value[0] === 'read' && new Set(value).size === value.length, 'Start with read and do not repeat permissions.'), environment: z.enum(['live', 'test']),
    expiresInSeconds: z.number().int().min(30).max(86400), domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50).default([]),
    purpose: z.string().trim().min(1).max(200),
  }).strict()) }, responses: { 201: response(z.object({ id: z.string(), token: z.string(), expiresAt: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), environment: z.enum(['live', 'test']), domains: z.array(z.string()), purpose: z.string() }).openapi('AgentToken')), ...errors } }), async c => {
    const input = c.req.valid('json'); const identity = actor(c, input.permissions.includes('manage') ? 'manage' : input.permissions.includes('send') ? 'send' : 'read');
    if (identity.credential !== 'mcp' || !identity.keyId.startsWith('mcp_')) throw new ApiError(403, 'MCP_AUTHORIZATION_REQUIRED', 'Temporary agent tokens can only be delegated directly from an MCP OAuth approval.');
    if (input.environment === 'live' && identity.environment !== 'live') throw new ApiError(403, 'LIVE_SCOPE_REQUIRED', 'The MCP approval does not permit live access.');
    if (input.permissions.some(permission => !identity.permissions.includes(permission))) throw new ApiError(403, 'PERMISSION_DENIED', 'The MCP approval does not include every requested permission.');
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000).toISOString();
    const tokenId = id('agt');
    const token = await createAgentToken(c.env.config, { id: tokenId, grant: identity.keyId, environment: input.environment, permissions: input.permissions, domains: input.domains, expiresAt });
    await c.env.db.insert(agentTokens).values({ id: tokenId, workspaceId: identity.workspaceId, grantId: identity.keyId, environment: input.environment, permissions: input.permissions, domains: input.domains, purpose: input.purpose, expiresAt });
    return c.json({ id: tokenId, token, expiresAt, permissions: input.permissions, environment: input.environment, domains: input.domains, purpose: input.purpose }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/agent-tokens', operationId: 'listAgentTokens', tags: ['Auth'], security, request: { query: PageQuery.extend({ includeInactive: z.enum(['true', 'false']).default('false') }) }, responses: { 200: response(page(AgentTokenRecord)), ...errors } }), async c => {
    const identity = manageKeys(c); const query = c.req.valid('query');
    const rows = await c.env.db.select().from(agentTokens).where(and(eq(agentTokens.workspaceId, identity.workspaceId), query.includeInactive === 'false' ? and(isNull(agentTokens.revokedAt), gt(agentTokens.expiresAt, new Date().toISOString())) : undefined, query.cursor ? gt(agentTokens.id, query.cursor) : undefined)).orderBy(agentTokens.id).limit(query.limit + 1);
    const data = rows.slice(0, query.limit).map(({ workspaceId: _workspace, ...row }) => row);
    return c.json({ data, nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens/{id}/revoke', operationId: 'revokeAgentToken', tags: ['Auth'], security, request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const identity = manageKeys(c), tokenId = c.req.valid('param').id;
    const [row] = await c.env.db.update(agentTokens).set({ revokedAt: new Date().toISOString() }).where(and(eq(agentTokens.workspaceId, identity.workspaceId), eq(agentTokens.id, tokenId), isNull(agentTokens.revokedAt))).returning({ id: agentTokens.id });
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Agent token was not found or is already revoked.');
    return c.json({ id: row.id, revoked: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys', operationId: 'createApiKey', tags: ['ApiKeys'], security, request: { body: json(KeyInput) }, responses: { 201: response(KeySchema.extend({ secret: z.string() })), ...errors } }), async c => {
    const auth = manageKeys(c); const input = c.req.valid('json');
    const secret = randomSecret(`os_${input.environment}_`);
    const [key] = await c.env.db.insert(apiKeys).values({ id: id('key'), workspaceId: auth.workspaceId, ...input, hash: await digest(secret), prefix: secret.slice(0, 14) }).returning();
    return c.json({ ...keyView(key!), secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/api-keys', operationId: 'listApiKeys', tags: ['ApiKeys'], security, request: { query: PageQuery.extend({ includeRevoked: z.enum(['true', 'false']).default('true') }) }, responses: { 200: response(page(KeySchema)), ...errors } }), async c => {
    const auth = manageKeys(c); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(apiKeys).where(and(eq(apiKeys.workspaceId, auth.workspaceId), q.includeRevoked === 'false' ? isNull(apiKeys.revokedAt) : undefined, q.cursor ? gt(apiKeys.id, q.cursor) : undefined)).orderBy(apiKeys.id).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(keyView), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys/{id}/revoke', operationId: 'revokeApiKey', tags: ['ApiKeys'], security, request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const auth = manageKeys(c); const keyId = c.req.valid('param').id;
    const [key] = await c.env.db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, auth.workspaceId))).returning({ id: apiKeys.id });
    if (!key) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
    return c.json({ id: key.id, revoked: true as const }, 200);
  });
}
