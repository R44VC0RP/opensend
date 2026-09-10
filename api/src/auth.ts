import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ApiError, actor, digest, errors, id, IdParams, json, PageQuery, page, randomSecret, response, security, timed } from './core.js';
import type { Actor, App, AppEnv, Runtime } from './core.js';
import { apiKeys } from './db/core.js';
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
      const grant = temporary ? await getMcpGrantActor(c.env, temporary.grant) : null;
      if (!temporary || !grant || (temporary.environment === 'live' && grant.environment !== 'live') || temporary.permissions.some(permission => !grant.permissions.includes(permission))) throw new ApiError(401, 'AUTH_INVALID', 'The temporary API token is invalid, expired, or its originating approval was revoked.');
      c.set('actor', { ...grant, environment: temporary.environment, permissions: temporary.permissions, domains: temporary.domains, credential: 'agentToken' });
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
const KeyInput = z.object({ name: z.string().trim().min(1).max(100), environment: z.enum(['live', 'test']).default('test'), permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3).default(['send']), domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50).default([]) }).strict().openapi('CreateApiKey');
function manageKeys(c: Parameters<typeof actor>[0]) {
  const value = actor(c, 'manage');
  if (value.environment !== 'live' || value.domains.length) throw new ApiError(403, 'PERMISSION_DENIED', 'Key administration requires unrestricted live management access.');
  return value;
}
const keyView = (key: typeof apiKeys.$inferSelect) => { const { hash: _hash, workspaceId: _workspace, ...view } = key; return view; };
export function registerAuth(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens', operationId: 'createAgentToken', tags: ['Auth'], security, description: 'Creates a nonrefreshable, short-lived API token for temporary uncommitted scripts. Requires an MCP OAuth principal; never grants manage permission.', request: { body: json(z.object({
    permissions: z.union([z.tuple([z.literal('read')]), z.tuple([z.literal('read'), z.literal('send')])]), environment: z.enum(['live', 'test']),
    expiresInMinutes: z.number().int().min(5).max(1440), domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50).default([]),
    purpose: z.string().trim().min(1).max(200),
  }).strict()) }, responses: { 201: response(z.object({ token: z.string(), expiresAt: z.string(), permissions: z.array(z.enum(['read', 'send'])), environment: z.enum(['live', 'test']), domains: z.array(z.string()), purpose: z.string() }).openapi('AgentToken')), ...errors } }), async c => {
    const input = c.req.valid('json'); const identity = actor(c, input.permissions.length === 2 ? 'send' : 'read');
    if (identity.credential !== 'mcp' || !identity.keyId.startsWith('mcp_')) throw new ApiError(403, 'MCP_AUTHORIZATION_REQUIRED', 'Temporary agent tokens can only be delegated directly from an MCP OAuth approval.');
    if (input.environment === 'live' && identity.environment !== 'live') throw new ApiError(403, 'LIVE_SCOPE_REQUIRED', 'The MCP approval does not permit live access.');
    if (input.permissions.some(permission => !identity.permissions.includes(permission))) throw new ApiError(403, 'PERMISSION_DENIED', 'The MCP approval does not include every requested permission.');
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000).toISOString();
    const token = await createAgentToken(c.env.config, { grant: identity.keyId, environment: input.environment, permissions: input.permissions, domains: input.domains, expiresAt });
    return c.json({ token, expiresAt, permissions: input.permissions, environment: input.environment, domains: input.domains, purpose: input.purpose }, 201);
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
