import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ApiError, log, SECURITY_HEADERS, timed } from './core.js';
import type { AppEnv } from './core.js';
import { authenticate, registerAuth } from './auth.js';
import { registerGoogleAuth } from './google-auth.js';
import { registerAudience } from './audience.js';
import { registerAudienceQuery } from './audience-query.js';
import { registerSending } from './sending.js';
import { registerOperations } from './operations.js';
import { registerSesRegions, resolveRegionRuntime } from './ses-regions.js';
import { registerMcp } from './mcp.js';
import { registerMcpAuth } from './mcp-auth.js';

export function createApp() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook(result) {
    if (!result.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Request fields are invalid.', result.error.issues.map(i => i.path.join('.')).filter(Boolean).join(', '));
  } });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', description: 'An OpenSend API key. Credentials never belong in URLs.' });
  app.openAPIRegistry.registerComponent('securitySchemes', 'dashboardSession', { type: 'apiKey', in: 'cookie', name: 'opensend.session_token', description: 'Google-approved HttpOnly session for local development. Unsafe requests require the canonical dashboard Origin.' });
  app.openAPIRegistry.registerComponent('securitySchemes', 'secureDashboardSession', { type: 'apiKey', in: 'cookie', name: '__Secure-opensend.session_token', description: 'Google-approved Secure HttpOnly session in production. Unsafe requests require the canonical dashboard Origin.' });
  app.use('*', async (c, next) => {
    const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
    c.set('requestId', requestId); c.set('serverTimings', []); c.header('x-request-id', requestId); c.header('cache-control', 'no-store');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
    const start = Date.now();
    await next();
    // Auth handlers return native Responses, so apply correlation/cache policy after dispatch too.
    c.header('x-request-id', requestId); c.header('cache-control', 'no-store');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(name)) c.header(name, value);
    const timings = c.get('serverTimings');
    if (timings.length) c.header('server-timing', timings.map(item => `${item.name};dur=${item.durationMs.toFixed(1)}`).join(', '));
    log(c.res.status >= 500 ? 'error' : 'info', { requestId, operation: c.req.routePath ?? 'unmatched', method: c.req.method, status: c.res.status, durationMs: Date.now() - start, timings: Object.fromEntries(timings.map(item => [item.name, Number(item.durationMs.toFixed(1))])) });
    if (c.res.status < 300 && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.env.wake) {
      try { await c.env.wake(); } catch { log('warn', { requestId, code: 'QUEUE_WAKE_FAILED', message: 'The job is durable in Postgres; scheduler will recover it.' }); }
    }
  });
  app.use('*', bodyLimit({ maxSize: 12 * 1024 * 1024, onError() { throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request exceeds the 12 MiB limit.'); } }));
  app.use('/v1/*', async (c, next) => {
    const configured = async () => {
      const globalCampaignRead = c.req.method === 'GET' && /^\/v1\/campaigns(?:\/[^/]+(?:\/(?:state|preview))?)?$/.test(c.req.path) && !new URL(c.req.url).searchParams.has('region');
      if ((!globalCampaignRead && /^\/v1\/(?:emails|campaigns|domains|templates|metrics|regions|webhooks|events\/ses)(?:\/|$)/.test(c.req.path)) || c.req.path === '/v1/settings/ses') c.env = await timed(c, 'region-db', () => resolveRegionRuntime(c.env));
      await next();
    };
    if (c.req.path === '/v1/events/ses') return configured();
    // Reject invalid credentials before accessing regional settings. Never mutate a shared Node runtime.
    return authenticate(c, configured);
  });
  app.onError((error, c) => {
    const requestId = c.get('requestId');
    const known = error instanceof ApiError;
    const invalidJson = error instanceof SyntaxError;
    const responseError = known ? error : invalidJson ? new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.') : new ApiError(500, 'INTERNAL_ERROR', 'Unexpected server failure. Use the request ID to locate the server log.');
    log('error', { requestId, operation: c.req.routePath ?? 'unmatched', code: responseError.code, status: responseError.status, message: responseError.message, errorType: known ? undefined : error.name, databaseCode: 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined, stack: known ? undefined : error.stack?.split('\n').slice(1).join('\n') });
    return c.json({ error: { code: responseError.code, message: responseError.message, requestId, retryable: responseError.retryable, ...(responseError.field ? { field: responseError.field } : {}) } }, responseError.status as ContentfulStatusCode);
  });
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: c.get('requestId'), retryable: false } }, 404));
  app.get('/health', c => c.json({ status: 'ok', service: 'opensend' }));
  registerMcpAuth(app); registerGoogleAuth(app); registerAuth(app); registerAudience(app); registerAudienceQuery(app); registerSending(app); registerOperations(app); registerSesRegions(app);
  registerMcp(app);
  app.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'OpenSend API', version: '0.1.0', description: 'Transactional and marketing email. 202 means queued, not delivered. Test keys simulate sending.' } });
  return app;
}
export const app = createApp();
