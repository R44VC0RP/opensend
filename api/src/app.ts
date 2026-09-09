import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ApiError, log } from './core.js';
import type { AppEnv } from './core.js';
import { authenticate, registerAuth } from './auth.js';
import { registerGoogleAuth } from './google-auth.js';
import { registerAudience } from './audience.js';
import { registerSending } from './sending.js';
import { registerOperations } from './operations.js';

export function createApp() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook(result) {
    if (!result.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Request fields are invalid.', result.error.issues.map(i => i.path.join('.')).filter(Boolean).join(', '));
  } });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', description: 'An OpenSend API key. Credentials never belong in URLs.' });
  app.openAPIRegistry.registerComponent('securitySchemes', 'dashboardSession', { type: 'apiKey', in: 'cookie', name: 'opensend.session_token', description: 'Google-approved HttpOnly session for local development. Unsafe requests require the canonical dashboard Origin.' });
  app.openAPIRegistry.registerComponent('securitySchemes', 'secureDashboardSession', { type: 'apiKey', in: 'cookie', name: '__Secure-opensend.session_token', description: 'Google-approved Secure HttpOnly session in production. Unsafe requests require the canonical dashboard Origin.' });
  app.use('*', async (c, next) => {
    const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
    c.set('requestId', requestId); c.header('x-request-id', requestId); c.header('cache-control', 'no-store');
    const start = Date.now();
    await next();
    // Auth handlers return native Responses, so apply correlation/cache policy after dispatch too.
    c.header('x-request-id', requestId); c.header('cache-control', 'no-store');
    log(c.res.status >= 500 ? 'error' : 'info', { requestId, operation: c.req.routePath ?? 'unmatched', method: c.req.method, status: c.res.status, durationMs: Date.now() - start });
    if (c.res.status < 300 && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.env.wake) {
      try { await c.env.wake(); } catch { log('warn', { requestId, code: 'QUEUE_WAKE_FAILED', message: 'The job is durable in Postgres; scheduler will recover it.' }); }
    }
  });
  app.use('*', bodyLimit({ maxSize: 12 * 1024 * 1024, onError() { throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request exceeds the 12 MiB limit.'); } }));
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/events/ses') return next();
    return authenticate(c, next);
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
  registerGoogleAuth(app); registerAuth(app); registerAudience(app); registerSending(app); registerOperations(app);
  app.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'OpenSend API', version: '0.1.0', description: 'Transactional and marketing email. 202 means queued, not delivered. Test keys simulate sending.' } });
  return app;
}
export const app = createApp();
