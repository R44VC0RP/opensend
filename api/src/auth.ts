import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { ApiError, actor, digest, errors, id, IdParams, json, PageQuery, page, randomSecret, response, security } from './core.js';
import type { App, AppEnv } from './core.js';
import { apiKeys } from './db/core.js';

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) throw new ApiError(401, 'AUTH_REQUIRED', 'A bearer API key is required.');
  const hash = await digest(token);
  const adminHash = await digest(c.env.config.adminToken);
  if (timingSafeEqual(new TextEncoder().encode(hash), new TextEncoder().encode(adminHash))) {
    c.set('actor', { keyId: `bootstrap_${adminHash.slice(0, 24)}`, workspaceId: c.env.config.workspaceId, environment: 'live', permissions: ['manage'], domains: [] });
  } else {
    if (!/^os_(?:test|live)_[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
    const [key] = await c.env.db.select().from(apiKeys).where(and(eq(apiKeys.hash, hash), eq(apiKeys.workspaceId, c.env.config.workspaceId), isNull(apiKeys.revokedAt))).limit(1);
    if (!key) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
    c.set('actor', { keyId: key.id, workspaceId: key.workspaceId, environment: key.environment, permissions: key.permissions, domains: key.domains });
    await c.env.db.update(apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(and(eq(apiKeys.id, key.id), or(isNull(apiKeys.lastUsedAt), sql`${apiKeys.lastUsedAt} < now() - interval '1 minute'`)));
  }
  const identity = c.get('actor');
  const maxRequests = identity.keyId.startsWith('bootstrap_') ? 2400 : identity.environment === 'test' ? 600 : 1200;
  const budget = await c.env.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
    VALUES (${identity.workspaceId}, ${identity.keyId}, date_trunc('minute', now()), 1)
    ON CONFLICT (workspace_id, key_id) DO UPDATE SET
      used = CASE WHEN api_request_budgets.window_start = excluded.window_start THEN least(api_request_budgets.used + 1, ${maxRequests + 1}) ELSE 1 END,
      window_start = excluded.window_start RETURNING used`);
  if (budget.rows[0]!.used > maxRequests) {
    c.header('Retry-After', '60');
    throw new ApiError(429, 'REQUEST_RATE_LIMITED', `This key exceeded its ${maxRequests}-request minute budget. Retry after the window resets.`, undefined, true);
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
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys', operationId: 'createApiKey', tags: ['ApiKeys'], security, request: { body: json(KeyInput) }, responses: { 201: response(KeySchema.extend({ secret: z.string() })), ...errors } }), async c => {
    const auth = manageKeys(c); const input = c.req.valid('json');
    const secret = randomSecret(`os_${input.environment}_`);
    const [key] = await c.env.db.insert(apiKeys).values({ id: id('key'), workspaceId: auth.workspaceId, ...input, hash: await digest(secret), prefix: secret.slice(0, 14) }).returning();
    return c.json({ ...keyView(key!), secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/api-keys', operationId: 'listApiKeys', tags: ['ApiKeys'], security, request: { query: PageQuery }, responses: { 200: response(page(KeySchema)), ...errors } }), async c => {
    const auth = manageKeys(c); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(apiKeys).where(and(eq(apiKeys.workspaceId, auth.workspaceId), q.cursor ? gt(apiKeys.id, q.cursor) : undefined)).orderBy(apiKeys.id).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(keyView), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys/{id}/revoke', operationId: 'revokeApiKey', tags: ['ApiKeys'], security, request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const auth = manageKeys(c); const keyId = c.req.valid('param').id;
    const [key] = await c.env.db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, auth.workspaceId))).returning({ id: apiKeys.id });
    if (!key) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
    return c.json({ id: key.id, revoked: true as const }, 200);
  });
}
