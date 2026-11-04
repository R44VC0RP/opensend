import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ApiError, actor, digest, errors, id, IdParams, json, PageQuery, page, randomSecret, response, security, senderDomainAllowed, timed } from './core.js';
import type { Actor, App, AppEnv, Ctx, Runtime } from './core.js';
import { agentTokens, apiKeys } from './db/core.js';
import { mailboxKeys } from './db/mailbox.js';
import { getDashboardActor, requireDashboardOrigin } from './google-auth.js';
import { createAgentToken, verifyAgentToken } from './agent-token.js';
import { getMcpGrantActor } from './mcp-auth.js';

// A private symbol carries server-authorized identity through request-cloning middleware.
// HTTP headers/cookies cannot supply it, and every internal dispatch gets a fresh runtime.
const delegatedActor = Symbol('mcpActor');
type DelegatedRuntime = Runtime & { [delegatedActor]?: Actor };
export async function dispatchAsActor(app: App, request: Request, runtime: Runtime, identity: Actor): Promise<Response> {
  if (identity.credential !== 'mcp' || !identity.keyId.startsWith('mcp_')) throw new ApiError(403, 'PERMISSION_DENIED', 'Invalid delegated API principal.');
  const delegatedRuntime: DelegatedRuntime = { ...runtime, [delegatedActor]: identity };
  return await app.fetch(request, delegatedRuntime);
}

// `credential` returns at most one authorized row. Charge the originating principal
// (the grant for agent tokens), but touch only the credential actually presented.
export async function chargeCredential<T extends Record<string, unknown>>(c: Ctx, table: typeof agentTokens | typeof apiKeys | typeof mailboxKeys, credential: SQL) {
  const result = await c.env.db.execute<T & { used: number; max_requests: number }>(sql`
    WITH credential AS (${credential}), budget AS (
      INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
      SELECT workspace_id, key_id, date_trunc('minute', now()), 1 FROM credential
      ON CONFLICT (workspace_id, key_id) DO UPDATE SET
        used = CASE WHEN api_request_budgets.window_start = excluded.window_start THEN least(api_request_budgets.used + 1, (SELECT max_requests + 1 FROM credential)) ELSE 1 END,
        window_start = excluded.window_start RETURNING used
    ), touched AS (
      UPDATE ${table} k SET last_used_at = ${new Date().toISOString()}::timestamptz FROM credential, budget WHERE k.id = credential.id
        AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute')
        ${table === mailboxKeys ? sql`AND budget.used <= credential.max_requests` : sql``}
    ) SELECT credential.*, budget.used FROM credential, budget`);
  const row = result.rows[0];
  if (row) checkBudget(c, row.used, row.max_requests);
  return row;
}
function checkBudget(c: Ctx, used: number, maxRequests: number) {
  if (used <= maxRequests) return;
  c.header('Retry-After', '60');
  throw new ApiError(429, 'REQUEST_RATE_LIMITED', `This key exceeded its ${maxRequests}-request minute budget. Retry after the window resets.`, undefined, true);
}

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const delegated = (c.env as DelegatedRuntime)[delegatedActor];
  const authorization = c.req.header('authorization');
  if (delegated) {
    c.set('actor', delegated);
    const maxRequests = c.env.config.apiRateLimitPerMinute;
    const budget = await timed(c, 'budget-db', () => c.env.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
      VALUES (${delegated.workspaceId}, ${delegated.keyId}, date_trunc('minute', now()), 1)
      ON CONFLICT (workspace_id, key_id) DO UPDATE SET
        used = CASE WHEN api_request_budgets.window_start = excluded.window_start THEN least(api_request_budgets.used + 1, ${maxRequests + 1}) ELSE 1 END,
        window_start = excluded.window_start RETURNING used`));
    checkBudget(c, budget.rows[0]!.used, maxRequests);
  } else if (authorization !== undefined) {
    const token = authorization.match(/^Bearer (.+)$/i)?.[1];
    if (!token || token.length > 16 * 1024) throw new ApiError(401, 'AUTH_INVALID', 'The API token is invalid or has been revoked.');
    if (token.startsWith('os_agent_')) {
      const temporary = await verifyAgentToken(c.env.config, token);
      const grant = temporary && await getMcpGrantActor(c.env, temporary.grant);
      const invalid = () => new ApiError(401, 'AUTH_INVALID', 'The temporary API token is invalid, expired, or its originating approval was revoked.');
      if (!temporary || !grant || temporary.permissions.some(permission => !grant.permissions.includes('manage') && !grant.permissions.includes(permission))) throw invalid();
      const limit = c.env.config.apiRateLimitPerMinute;
      const tracked = await timed(c, 'budget-db', () => chargeCredential(c, agentTokens, sql`
        SELECT id, workspace_id, grant_id AS key_id, ${limit}::int AS max_requests FROM agent_tokens
        WHERE id = ${temporary.id} AND revoked_at IS NULL AND workspace_id = ${grant.workspaceId} AND grant_id = ${temporary.grant}
          AND environment = 'live' AND date_trunc('milliseconds', expires_at) = ${new Date(temporary.exp).toISOString()}::timestamptz
          AND permissions = ${JSON.stringify(temporary.permissions)}::jsonb AND domains = ${JSON.stringify(temporary.domains)}::jsonb`));
      if (!tracked) throw invalid();
      c.set('actor', { ...grant, permissions: temporary.permissions, domains: temporary.domains, credential: 'agentToken' });
    } else {
      if (!/^os_(?:live_)?[0-9a-f]{64}$/i.test(token)) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
      const hash = await digest(token);
      const limit = c.env.config.apiRateLimitPerMinute;
      const key = await timed(c, 'budget-db', () => chargeCredential<Pick<Actor, 'permissions' | 'domains'> & { id: string; workspace_id: string }>(c, apiKeys, sql`
        SELECT id, workspace_id, id AS key_id, permissions, domains,
          ${limit}::int AS max_requests
        FROM api_keys WHERE hash = ${hash} AND environment = 'live' AND revoked_at IS NULL`));
      if (!key) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
      c.set('actor', { keyId: key.id, workspaceId: key.workspace_id, environment: 'live', permissions: key.permissions, domains: key.domains, credential: 'apiKey' });
    }
  } else {
    const dashboard = await getDashboardActor(c.env, c.req.raw.headers, async (name, work) => timed(c, name, work), headers => {
      for (const cookie of headers.getSetCookie()) c.header('set-cookie', cookie, { append: true });
    });
    if (!dashboard) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in with an approved Google account or supply a bearer API key.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireDashboardOrigin(c.env, c.req.raw.headers);
    c.set('actor', dashboard);
  }
  await next();
};
const KeySchema = z.object({ id: z.string(), name: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), prefix: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('ApiKey');
const AgentTokenRecord = z.object({ id: z.string(), grantId: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), purpose: z.string(), expiresAt: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('AgentTokenRecord');
const KeyInput = z.object({ name: z.string().trim().min(1).max(100), permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3).default(['send']), domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50).default([]) }).strict().openapi('CreateApiKey');
function manageKeys(c: Parameters<typeof actor>[0]) {
  const value = actor(c, 'manage');
  if (value.credential === 'agentToken') throw new ApiError(403, 'CREDENTIAL_DELEGATION_FORBIDDEN', 'Temporary agent tokens cannot create, list, or revoke API keys.');
  if (value.domains.length) throw new ApiError(403, 'PERMISSION_DENIED', 'Key administration requires unrestricted management access.');
  return value;
}
const keyView = (key: typeof apiKeys.$inferSelect) => { const { hash: _hash, workspaceId: _workspace, environment: _environment, ...view } = key; return view; };
export function registerAuth(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens', operationId: 'createAgentToken', tags: ['Auth'], security, description: 'Creates a nonrefreshable, short-lived API token for temporary uncommitted scripts. Requires an MCP OAuth principal and cannot delegate permissions beyond that originating approval. Manage tokens cannot administer credentials.', request: { body: json(z.object({
    permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3).refine(value => value[0] === 'read' && new Set(value).size === value.length, 'Start with read and do not repeat permissions.'),
    expiresInSeconds: z.number().int().min(30).max(86400), domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50).default([]),
    purpose: z.string().trim().min(1).max(200),
  }).strict()) }, responses: { 201: response(z.object({ id: z.string(), token: z.string(), expiresAt: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), purpose: z.string() }).openapi('AgentToken')), ...errors } }), async c => {
    const input = c.req.valid('json'); const identity = actor(c, input.permissions.includes('manage') ? 'manage' : input.permissions.includes('send') ? 'send' : 'read');
    if (identity.credential !== 'mcp' || !identity.keyId.startsWith('mcp_')) throw new ApiError(403, 'MCP_AUTHORIZATION_REQUIRED', 'Temporary agent tokens can only be delegated directly from an MCP OAuth approval.');
    if (input.permissions.some(permission => !identity.permissions.includes('manage') && !identity.permissions.includes(permission))) throw new ApiError(403, 'PERMISSION_DENIED', 'The MCP approval does not include every requested permission.');
    if (identity.domains.length && (!input.domains.length || input.domains.some(domain => !senderDomainAllowed(identity.domains, domain)))) throw new ApiError(403, 'SENDER_DOMAIN_FORBIDDEN', 'The temporary token must remain restricted to the approved sender domains or their subdomains.', 'domains');
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000).toISOString();
    const tokenId = id('agt');
    const token = await createAgentToken(c.env.config, { id: tokenId, grant: identity.keyId, permissions: input.permissions, domains: input.domains, expiresAt });
    await c.env.db.insert(agentTokens).values({ id: tokenId, workspaceId: identity.workspaceId, grantId: identity.keyId, environment: 'live', permissions: input.permissions, domains: input.domains, purpose: input.purpose, expiresAt });
    return c.json({ id: tokenId, token, expiresAt, permissions: input.permissions, domains: input.domains, purpose: input.purpose }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/agent-tokens', operationId: 'listAgentTokens', tags: ['Auth'], security, request: { query: PageQuery.extend({ includeInactive: z.enum(['true', 'false']).default('false') }) }, responses: { 200: response(page(AgentTokenRecord)), ...errors } }), async c => {
    const identity = manageKeys(c); const query = c.req.valid('query');
    const rows = await c.env.db.select().from(agentTokens).where(and(eq(agentTokens.workspaceId, identity.workspaceId), eq(agentTokens.environment, 'live'), query.includeInactive === 'false' ? and(isNull(agentTokens.revokedAt), gt(agentTokens.expiresAt, new Date().toISOString())) : undefined, query.cursor ? gt(agentTokens.id, query.cursor) : undefined)).orderBy(agentTokens.id).limit(query.limit + 1);
    const data = rows.slice(0, query.limit).map(({ workspaceId: _workspace, environment: _environment, ...row }) => row);
    return c.json({ data, nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens/{id}/revoke', operationId: 'revokeAgentToken', tags: ['Auth'], security, request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const identity = manageKeys(c), tokenId = c.req.valid('param').id;
    const [row] = await c.env.db.update(agentTokens).set({ revokedAt: new Date().toISOString() }).where(and(eq(agentTokens.workspaceId, identity.workspaceId), eq(agentTokens.environment, 'live'), eq(agentTokens.id, tokenId), isNull(agentTokens.revokedAt))).returning({ id: agentTokens.id });
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Agent token was not found or is already revoked.');
    return c.json({ id: row.id, revoked: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys', operationId: 'createApiKey', tags: ['ApiKeys'], security, request: { body: json(KeyInput) }, responses: { 201: response(KeySchema.extend({ secret: z.string() })), ...errors } }), async c => {
    const auth = manageKeys(c); const input = c.req.valid('json');
    const secret = randomSecret('os_');
    const [key] = await c.env.db.insert(apiKeys).values({ id: id('key'), workspaceId: auth.workspaceId, ...input, environment: 'live', hash: await digest(secret), prefix: secret.slice(0, 14) }).returning();
    return c.json({ ...keyView(key!), secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/api-keys', operationId: 'listApiKeys', tags: ['ApiKeys'], security, request: { query: PageQuery.extend({ includeRevoked: z.enum(['true', 'false']).default('true') }) }, responses: { 200: response(page(KeySchema)), ...errors } }), async c => {
    const auth = manageKeys(c); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(apiKeys).where(and(eq(apiKeys.workspaceId, auth.workspaceId), eq(apiKeys.environment, 'live'), q.includeRevoked === 'false' ? isNull(apiKeys.revokedAt) : undefined, q.cursor ? gt(apiKeys.id, q.cursor) : undefined)).orderBy(apiKeys.id).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(keyView), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys/{id}/revoke', operationId: 'revokeApiKey', tags: ['ApiKeys'], security, request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const auth = manageKeys(c); const keyId = c.req.valid('param').id;
    const [key] = await c.env.db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, auth.workspaceId), eq(apiKeys.environment, 'live'))).returning({ id: apiKeys.id });
    if (!key) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
    return c.json({ id: key.id, revoked: true as const }, 200);
  });
}
