import { after, before, describe, test, type TestContext } from 'node:test';
import { makeSignature } from 'better-auth/crypto';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, hkdfSync, randomUUID, sign, verify as verifySignature } from 'node:crypto';
import pg from 'pg';

// Run against the actual server and normal background-job runner with npm test.
// Requires its BETTER_AUTH_SECRET and paired DATABASE_URL (localhost only) or
// explicit API_FIXTURE_DATABASE_URL. Allow AUTH_TEST_EMAIL (operator@example.com)
// and AUTH_TEST_GOOGLE_DOMAIN (example.com) in that server's Google access policy.
// Synthetic DB identities exercise session authorization, NOT real Google OAuth.
// HTTP scenarios use the actual server. Explicitly labeled Google callback and SES
// setup integrations use the normal app with mocked providers; no auth bypasses.
const BASE = (process.env.API_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
if (!AUTH_SECRET) throw new Error('Acceptance tests require the running API’s BETTER_AUTH_SECRET to sign synthetic local session fixtures; no scenarios were run.');
const MANAGER = 'acceptance-dashboard-session'; // Internal sentinel, never an HTTP credential.
const PUBLIC_ORIGIN = new URL(process.env.PUBLIC_URL ?? BASE).origin;
const COOKIE_NAME = PUBLIC_ORIGIN.startsWith('https:') ? '__Secure-opensend.session_token' : 'opensend.session_token';
const AUTH_EMAIL = process.env.AUTH_TEST_EMAIL ?? 'operator@example.com';
const AUTH_DOMAIN = process.env.AUTH_TEST_GOOGLE_DOMAIN ?? 'example.com';
// Do not send credentials to an unrelated service occupying the configured port.
const probe = await fetch(`${BASE}/health`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
const identity = await probe.json().catch(() => null) as { service?: string } | null;
if (!probe.ok || identity?.service !== 'opensend' || !probe.headers.get('x-request-id')) throw new Error('API_TARGET_MISMATCH: API_BASE_URL is not an OpenSend API. No authenticated scenarios were run.');
const secrets = new Set<string>([AUTH_SECRET]);
const unique = (prefix: string) => `${prefix}-${randomUUID().replaceAll('-', '')}`;
const address = () => `${unique('acceptance')}@example.com`;
const REGION = process.env.API_TEST_REGION ?? 'us-east-1';
// npm test loads .env. Remote APIs require an explicitly paired fixture database;
// never silently arrange a remote API's fixtures in the developer's default DB.
const LOCAL_API = ['localhost', '127.0.0.1'].includes(new URL(BASE).hostname);
const FIXTURE_DATABASE_URL = process.env.API_FIXTURE_DATABASE_URL || (LOCAL_API ? process.env.DATABASE_URL : undefined);
if (!FIXTURE_DATABASE_URL) throw new Error('Session fixture bootstrap requires DATABASE_URL for localhost, or API_FIXTURE_DATABASE_URL explicitly paired with a remote API. No authenticated scenarios were run.');
const DATABASE_FIXTURE_SKIP = false; // Bootstrap already requires an explicitly safe fixture database.
const mail = (extra: Json = {}): Json => ({ from: 'sender@example.com', to: address(), region: REGION, subject: unique('Acceptance'), text: 'Synthetic acceptance message; no SES send is authorized.', ...extra });
type Json = Record<string, any>;
type Reply = { status: number; body: any; headers: Headers };
type Key = { id: string; secret: string };
const cleanups = new WeakMap<TestContext, Array<() => Promise<void>>>();
function cleanup(t: TestContext, action: () => Promise<void>) {
  let stack = cleanups.get(t);
  if (!stack) {
    stack = [];
    cleanups.set(t, stack);
    t.after(async () => {
      const failures: unknown[] = [];
      for (const undo of stack!.reverse()) { try { await undo(); } catch (cause) { failures.push(cause); } }
      if (failures.length) throw new AggregateError(failures, 'Acceptance fixture cleanup failed.');
    });
  }
  stack.push(action);
}
async function fixtureDatabase(t: TestContext): Promise<pg.Client> {
  assert.ok(FIXTURE_DATABASE_URL, 'Scoped database fixtures require DATABASE_URL for a local API or an explicit API_FIXTURE_DATABASE_URL.');
  const db = new pg.Client({ connectionString: FIXTURE_DATABASE_URL, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
  await db.connect();
  cleanup(t, async () => { await db.end(); });
  return db;
}
type SessionFixture = { userId: string; sessionId: string; token: string; cookie: string; email: string };
let authDb: pg.Client | undefined;
let manager: SessionFixture | undefined;
async function seedSession(db: pg.Client, options: { email?: string; hostedDomain?: string | null; verified?: boolean; googleAccount?: boolean } = {}): Promise<SessionFixture> {
  const userId = unique('acceptance-user');
  const sessionId = unique('acceptance-session');
  const token = unique('acceptance-token');
  const email = options.email ?? `${unique('acceptance-google')}@${AUTH_DOMAIN}`;
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(`${token}.${await makeSignature(token, AUTH_SECRET!)}`)}`;
  secrets.add(token);
  secrets.add(cookie);
  await db.query('BEGIN');
  try {
    // Never overwrite/reuse an existing user's email or credentials. A collision
    // fails the fixture; choose a dedicated AUTH_TEST_EMAIL rather than deleting it.
    await db.query(`INSERT INTO auth_user (id, name, email, email_verified, google_hosted_domain)
      VALUES ($1, $2, $3, $4, $5)`, [userId, 'Synthetic acceptance operator', email, options.verified ?? true, options.hostedDomain === undefined ? AUTH_DOMAIN : options.hostedDomain]);
    if (options.googleAccount !== false) await db.query(`INSERT INTO auth_account (id, provider_id, account_id, user_id)
      VALUES ($1, 'google', $2, $3)`, [unique('acceptance-account'), unique('acceptance-google-sub'), userId]);
    await db.query(`INSERT INTO auth_session (id, token, expires_at, user_id)
      VALUES ($1, $2, $3, $4)`, [sessionId, token, new Date(Date.now() + 3_600_000), userId]);
    await db.query('COMMIT');
  } catch (cause) {
    await db.query('ROLLBACK');
    throw cause;
  }
  return { userId, sessionId, token, cookie, email };
}
async function sessionFixture(t: TestContext, options: Parameters<typeof seedSession>[1] = {}): Promise<SessionFixture> {
  assert.ok(authDb, 'Synthetic session database must be bootstrapped first.');
  const fixture = await seedSession(authDb, options);
  cleanup(t, async () => { await authDb!.query('DELETE FROM auth_user WHERE id = $1', [fixture.userId]); });
  return fixture;
}
before(async () => {
  authDb = new pg.Client({ connectionString: FIXTURE_DATABASE_URL, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
  await authDb.connect();
  manager = await seedSession(authDb, { email: AUTH_EMAIL, hostedDomain: null });
  const identity = ok(await http('GET', '/v1/me', MANAGER));
  assert.equal(identity.id, manager.userId, 'Fixture DB, session secret and API must match; no machine keys may be provisioned otherwise.');
  assert.equal(identity.email, AUTH_EMAIL);
  if (!identity.simulated) assert.ok(process.env.LIVE_SES_TEST === '1' && process.execArgv.includes('--test-name-pattern=^LIVE SES:'), 'Synthetic scenarios require a simulated deployment. An explicitly authorized live check must run alone with --test-name-pattern=^LIVE SES:.');
});
after(async () => {
  if (authDb) {
    try { if (manager) await authDb.query('DELETE FROM auth_user WHERE id = $1', [manager.userId]); }
    finally { await authDb.end(); }
  }
});
async function resource(t: TestContext, key: string, path: string, body: Json): Promise<Json> {
  const created = ok(await http('POST', path, key, body), 201);
  assert.equal(typeof created.id, 'string');
  cleanup(t, async () => { ok(await http('DELETE', `${path}/${created.id}`, key), [200, 204, 404]); });
  return created;
}
async function campaignFixture(t: TestContext, key: string, audience: Json, extra: Json = {}): Promise<Json> {
  const created = ok(await http('POST', '/v1/campaigns', key, {
    name: unique('campaign'), from: 'sender@example.com', region: REGION,
    subject: 'Hello {{firstName}}', html: '<p>Hello {{firstName}}</p>',
    audience, defaults: { firstName: 'there' }, ...extra,
  }), 201);
  cleanup(t, async () => {
    const current = await http('GET', `/v1/campaigns/${created.id}`, key);
    if (current.status === 404) return;
    const state = ok(current);
    if (['draft', 'failed'].includes(state.state)) ok(await http('DELETE', `/v1/campaigns/${created.id}`, key));
    else if (['preparing', 'scheduled', 'sending', 'paused'].includes(state.state)) ok(await http('POST', `/v1/campaigns/${created.id}/cancel`, key));
    // Canceled/done campaigns and immutable email logs have no deletion API;
    // their retained records are evidence, not mutable fixtures we can erase.
  });
  return created;
}
async function consent(key: string, id: string, status: 'subscribed' | 'unsubscribed', extra: Json = {}): Promise<Reply> {
  return http('POST', `/v1/contacts/${id}/consent`, key, {
    status, source: 'acceptance-fixture', policyVersion: 'acceptance-v1',
    evidence: 'Synthetic consent on a reserved example.com fixture, not real subscriber evidence.',
    occurredAt: new Date().toISOString(), ...extra,
  });
}
async function allPages(path: string, key: string): Promise<Json[]> {
  const rows: Json[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const reply = await http('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, key);
    rows.push(...page(reply));
    cursor = reply.body.nextCursor;
    if (cursor) {
      assert.ok(!seen.has(cursor), `Pagination repeated cursor for ${path}.`);
      seen.add(cursor);
      assert.ok(seen.size < 100, `Pagination exceeded the acceptance safety bound for ${path}.`);
    }
  } while (cursor);
  return rows;
}

function redact(value: unknown): string {
  let text = JSON.stringify(value, (key, item) => /^(secret|token|authorization|signingSecret|signingKey|unsubscribeUrl|unsubscribeToken)$/i.test(key) ? '[REDACTED]' : item) ?? String(value);
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/os_(?:(?:test|live)_)?[0-9a-f]{64}/g, '[REDACTED_API_KEY]')
    .replace(/(\/unsubscribe\/)[^\s"<>?]+/g, '$1[REDACTED]');
}
function diagnostic(reply: Reply): string {
  return `HTTP ${reply.status}; x-request-id=${reply.headers.get('x-request-id') ?? '(missing)'}; body=${redact(reply.body)}`;
}
async function http(method: string, path: string, key?: string, body?: unknown, headers: Record<string, string> = {}, timeout = 5_000, base = BASE, transport: (request: Request) => Response | Promise<Response> = fetch): Promise<Reply> {
  if (key === MANAGER) assert.ok(manager, 'Synthetic dashboard session has not been bootstrapped.');
  const credentials: Record<string, string> = key === MANAGER
    ? { cookie: manager!.cookie, origin: PUBLIC_ORIGIN }
    : key ? { authorization: `Bearer ${key}` } : {};
  const response = await transport(new Request(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...credentials, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : headers['content-type'] === 'application/x-www-form-urlencoded' ? String(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  }));
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* Hosted pages intentionally return HTML. */ }
  if (parsed && typeof parsed === 'object' && 'secret' in parsed && typeof parsed.secret === 'string') secrets.add(parsed.secret);
  return { status: response.status, body: parsed, headers: response.headers };
}
function ok(reply: Reply, status: number | number[] = 200): any {
  assert.ok((Array.isArray(status) ? status : [status]).includes(reply.status), diagnostic(reply));
  assert.ok(reply.headers.get('x-request-id'), diagnostic(reply));
  return reply.body;
}
function error(reply: Reply, status: number, code?: string): Json {
  assert.equal(reply.status, status, diagnostic(reply));
  const body = reply.body?.error;
  assert.ok(body && typeof body === 'object', diagnostic(reply));
  assert.equal(typeof body.code, 'string', diagnostic(reply));
  assert.ok(body.code.length > 0, diagnostic(reply));
  if (code) assert.equal(body.code, code, diagnostic(reply));
  assert.equal(typeof body.message, 'string', diagnostic(reply));
  assert.ok(body.message.length > 0, diagnostic(reply));
  assert.equal(typeof body.retryable, 'boolean', diagnostic(reply));
  assert.equal(body.requestId, reply.headers.get('x-request-id'), diagnostic(reply));
  assert.ok(body.requestId, diagnostic(reply));
  return body;
}
function page(reply: Reply): Json[] {
  const body = ok(reply);
  assert.ok(Array.isArray(body.data), diagnostic(reply));
  assert.ok(body.nextCursor === null || typeof body.nextCursor === 'string', diagnostic(reply));
  return body.data;
}
async function keyFixture(t: TestContext, options: { permissions?: string[]; domains?: string[] } = {}): Promise<Key> {
  const body = ok(await http('POST', '/v1/api-keys', MANAGER, {
    name: unique('acceptance'),
    permissions: options.permissions ?? ['read', 'send', 'manage'], domains: options.domains ?? [],
  }), 201);
  assert.equal(typeof body.id, 'string');
  assert.equal(typeof body.secret, 'string', 'API-key creation must return the secret exactly once.');
  assert.match(body.secret, /^os_[0-9a-f]{64}$/);
  secrets.add(body.secret);
  cleanup(t, async () => { ok(await http('POST', `/v1/api-keys/${body.id}/revoke`, MANAGER), [200, 204]); });
  return body;
}
async function poll(path: string, key: string, predicate: (body: Json) => boolean): Promise<Json> {
  const deadline = Date.now() + 10_000;
  let latest: Reply | undefined;
  do {
    latest = await http('GET', path, key, undefined, {}, Math.max(1, Math.min(2_000, deadline - Date.now())));
    const body = ok(latest);
    if (predicate(body)) return body;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  assert.fail(`Normal job runner did not produce the expected HTTP-visible state within 10s. ${latest ? diagnostic(latest) : path}`);
}

// Each top-level scenario owns its own randomly named fixtures. Operations inside
// a scenario are sequential; no shared ordering dependency exists between scenarios.
describe('Public contract and authentication', () => {
  test('health and OpenAPI are public, protected routes require credentials', async () => {
    const healthReply = await http('GET', '/health');
    const health = ok(healthReply);
    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'opensend');
    assert.match(healthReply.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(healthReply.headers.get('x-frame-options'), 'DENY');
    assert.equal(healthReply.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthReply.headers.get('referrer-policy'), 'no-referrer');
    assert.match(healthReply.headers.get('permissions-policy') ?? '', /camera=\(\)/);
    const { publicFailureBucket } = await import('./src/core.js');
    assert.equal(publicFailureBucket('/v1/me', 401), 'auth');
    assert.equal(publicFailureBucket('/v1/me', 200), null);
    assert.equal(publicFailureBucket('/unsubscribe/invalid', 404), 'unsubscribe');
    assert.equal(publicFailureBucket('/v1/events/ses', 403), null);
    assert.equal(publicFailureBucket('/v1/events/ses', 401, new Headers({ authorization: 'invalid' })), null);
    const document = ok(await http('GET', '/openapi.json'));
    assert.match(document.openapi, /^3\./);
    assert.ok(document.info?.title);
    assert.ok(document.paths && Object.keys(document.paths).length > 0);
    const contract: Record<string, string[]> = {
      '/v1/api-keys': ['get', 'post'], '/v1/api-keys/{id}/revoke': ['post'],
      '/v1/regions': ['get'], '/v1/regions/{region}': ['put'],
      '/v1/regions/{region}/discovery': ['get'], '/v1/regions/{region}/provision': ['post'],
      '/v1/contacts': ['get', 'post'], '/v1/contacts/{id}': ['get', 'patch', 'delete'],
      '/v1/contacts/{id}/consent': ['get', 'post'],
      '/v1/contact-imports': ['get', 'post'], '/v1/contact-imports/{id}/commit': ['post'],
      '/v1/audience-query/query': ['post'], '/v1/audience-query/plan': ['post'], '/v1/audience-query/apply': ['post'],
      '/v1/lists': ['get', 'post'], '/v1/lists/{id}/members': ['get', 'post'],
      '/v1/segments': ['get', 'post'], '/v1/segments/{id}/preview': ['post'],
      '/v1/emails/send': ['post'], '/v1/emails/batch': ['post'], '/v1/emails': ['get'],
      '/v1/emails/{id}': ['get'], '/v1/emails/{id}/content': ['get'], '/v1/emails/{id}/events': ['get'],
      '/v1/attachments': ['post'], '/v1/attachments/{id}': ['get', 'delete'],
      '/v1/campaigns': ['get', 'post'], '/v1/campaigns/{id}': ['get', 'patch', 'delete'],
      '/v1/campaigns/{id}/state': ['get'], '/v1/campaigns/{id}/archive': ['patch'], '/v1/campaigns/{id}/audience': ['get'], '/v1/campaigns/{id}/send': ['post'], '/v1/campaigns/{id}/schedule': ['post'], '/v1/campaigns/{id}/cancel': ['post'],
    };
    for (const [path, methods] of Object.entries(contract)) for (const method of methods) {
      const operation = document.paths[path]?.[method];
      assert.ok(operation, `OpenAPI must document ${method.toUpperCase()} ${path}.`);
      assert.ok(Object.keys(operation.responses ?? {}).some(status => /^2\d\d$/.test(status)), `OpenAPI ${method} ${path} needs a successful response contract.`);
      assert.ok(operation.responses?.['401'] && operation.responses?.['422'], `OpenAPI ${method} ${path} must document authentication/validation errors.`);
    }
    assert.equal(document.paths['/v1/campaigns/{id}/review'], undefined);
    assert.equal(document.paths['/v1/campaigns/{id}/audience-preview'], undefined);
    const resolve = (schema: Json): Json => schema?.$ref ? schema.$ref.slice(2).split('/').reduce((value: Json, part: string) => value?.[part], document) : schema;
    const sendSchema = resolve(document.paths['/v1/emails/send'].post.requestBody.content['application/json'].schema);
    assert.ok(sendSchema.properties?.from && sendSchema.properties?.to && sendSchema.properties?.region, 'Generated send schema needs usable typed fields, not an empty object.');
    assert.ok(sendSchema.required?.includes('from') && sendSchema.required?.includes('to'));
    const contactSchema = resolve(document.paths['/v1/contacts'].post.requestBody.content['application/json'].schema);
    assert.equal(contactSchema.properties?.email?.format, 'email');
    const queuedSchema = resolve(document.paths['/v1/emails/send'].post.responses['202'].content['application/json'].schema);
    assert.ok(queuedSchema.properties?.id && queuedSchema.properties?.simulated && !queuedSchema.properties?.environment);
    error(await http('GET', '/v1/api-keys'), 401);
  });

  test('an approved dashboard session creates scoped keys, listing never discloses secrets, revocation blocks reuse', async t => {
    const key = await keyFixture(t, { permissions: ['read'] });
    const db = await fixtureDatabase(t);
    // Even with a matching stored hash, the retired test key format cannot authenticate.
    for (const mode of ['live', 'test']) {
      const old = `os_${mode}_${key.secret.slice(3)}`, id = unique('legacy-key');
      await db.query(`INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES($1,'default','fixture',$2,$3,'["read"]','[]')`, [id, createHash('sha256').update(old).digest('hex'), old.slice(0,14)]);
      cleanup(t, async () => { await db.query('DELETE FROM api_keys WHERE id=$1', [id]); });
      const me = await http('GET','/v1/me',old);
      if (mode === 'live') assert.equal(ok(me).id,id); else {
        error(me,401,'AUTH_INVALID');
      }
    }
    const rows = await allPages('/v1/api-keys', MANAGER);
    const saved = rows.find(row => row.id === key.id);
    assert.ok(saved, 'Newly created API key must be visible in the key list.');
    for (const row of rows) {
      assert.equal(row.secret, undefined, 'API-key listing must never return a secret.');
      assert.equal(row.hash, undefined, 'API-key listing must never return credential hashes.');
      assert.equal(row.secretHash, undefined, 'API-key listing must never return credential hashes.');
    }
    page(await http('GET', '/v1/contacts', key.secret));
    error(await http('POST', '/v1/api-keys', key.secret, { name: unique('forbidden'), permissions: ['manage'], domains: [] }), 403);
    error(await http('GET', '/v1/api-keys?includeRevoked=false', key.secret), 403);
    ok(await http('POST', `/v1/api-keys/${key.id}/revoke`, MANAGER), [200, 204]);
    error(await http('GET', '/v1/contacts', key.secret), 401);

    const fixtures = [await keyFixture(t, { permissions: ['read'] }), await keyFixture(t, { permissions: ['read'] }), await keyFixture(t, { permissions: ['read'] })].sort((a, b) => a.id.localeCompare(b.id));
    const revoked = fixtures[0]!;
    ok(await http('POST', `/v1/api-keys/${revoked.id}/revoke`, MANAGER), [200, 204]);
    const history = await allPages('/v1/api-keys?includeRevoked=true', MANAGER);
    assert.deepEqual((await allPages('/v1/api-keys', MANAGER)).map(row => row.id), history.map(row => row.id), 'Omitting includeRevoked must preserve the public API’s full-history default.');
    assert.ok(history.find(row => row.id === key.id)?.revokedAt);
    assert.ok(history.find(row => row.id === revoked.id)?.revokedAt);
    const active = await allPages('/v1/api-keys?includeRevoked=false', MANAGER);
    assert.deepEqual(active.map(row => row.id), history.filter(row => row.revokedAt === null).map(row => row.id), 'Active-only listing must exclude revoked keys and retain every active key.');
    for (const fixture of fixtures.slice(1)) assert.ok(active.some(row => row.id === fixture.id));

    const revokedIndex = history.findIndex(row => row.id === revoked.id);
    const cursor = history[revokedIndex - 1]?.id;
    const expected = history.slice(revokedIndex).filter(row => row.revokedAt === null);
    assert.ok(expected.length >= 2, 'The revoked row must sort before at least two active fixture keys.');
    const first = await http('GET', `/v1/api-keys?includeRevoked=false&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, MANAGER);
    assert.deepEqual(page(first).map(row => row.id), [expected[0]!.id], 'Revoked rows must be filtered before the page limit, not removed from an already limited page.');
    assert.equal(first.body.nextCursor, expected[0]!.id);
    const second = await http('GET', `/v1/api-keys?includeRevoked=false&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, MANAGER);
    assert.deepEqual(page(second).map(row => row.id), [expected[1]!.id]);
    assert.equal(second.body.nextCursor, expected.length > 2 ? expected[1]!.id : null);
    error(await http('GET', '/v1/api-keys?includeRevoked=invalid', MANAGER), 422);
  });
});

describe('Google dashboard sessions and current-policy authorization', () => {
  test('approved synthetic Google sessions identify the operator and reject obsolete test-mode requests without exposing credentials', async t => {
    const me = ok(await http('GET', '/v1/me', MANAGER));
    assert.equal(me.id, manager!.userId);
    assert.equal(me.email, AUTH_EMAIL);
    assert.equal(me.name, 'Synthetic acceptance operator');
    assert.equal(me.environment, undefined);
    assert.ok(me.permissions.includes('manage'));
    assert.equal(ok(await http('GET', '/v1/me', MANAGER, undefined, { 'x-opensend-environment': 'live' })).environment, undefined);
    error(await http('POST', '/v1/emails/send', MANAGER, mail(), { 'x-opensend-environment': 'test' }), 400, 'ENVIRONMENT_REMOVED');
    const inspected = ok(await http('GET', '/api/auth/get-session', MANAGER));
    assert.equal(inspected.user.id, manager!.userId);
    assert.equal(inspected.user.emailVerified, true);
    assert.equal(inspected.user.googleHostedDomain, undefined, 'Google hd is protected server-side identity data.');
    assert.equal(ok(await http('GET', '/api/auth/get-session')), null);
    const machine = await keyFixture(t, { permissions: ['read'] });
    const machineMe = ok(await http('GET', '/v1/me', machine.secret, undefined, { 'x-opensend-environment': 'live' }));
    assert.equal(machineMe.id, machine.id);
    assert.equal(machineMe.email, null);
    assert.equal(machineMe.name, null);
    assert.equal(machineMe.environment, undefined, 'Dashboard headers cannot elevate an API key into live scope.');
    assert.deepEqual(machineMe.permissions, ['read']);
    for (const field of ['token', 'secret', 'cookie', 'accessToken', 'refreshToken']) assert.equal(me[field], undefined);
  });

  test('dashboard activity renews old sessions in both the browser and database, but not on every request', async t => {
    for (const path of ['/v1/me', '/api/auth/get-session']) {
      const fixture = await sessionFixture(t);
      const headers = { cookie: fixture.cookie, origin: PUBLIC_ORIGIN };
      // This includes sessions issued before the rolling policy: still valid but near the old cutoff.
      await authDb!.query("UPDATE auth_session SET expires_at = now() + interval '30 minutes' WHERE id = $1", [fixture.sessionId]);
      const expiry = async () => Number((await authDb!.query('SELECT extract(epoch FROM expires_at) * 1000 AS ms FROM auth_session WHERE id = $1', [fixture.sessionId])).rows[0].ms);
      const old = await expiry();
      await authDb!.query("UPDATE auth_account SET provider_id = 'detached' WHERE user_id = $1", [fixture.userId]);
      const denied = await http('GET', path, undefined, undefined, headers);
      if (path === '/v1/me') error(denied, 401, 'AUTH_REQUIRED'); else assert.equal(ok(denied), null);
      assert.equal(await expiry(), old, 'A removed Google link cannot extend a session.');
      await authDb!.query("UPDATE auth_account SET provider_id = 'google' WHERE user_id = $1", [fixture.userId]);
      const renewed = await http('GET', path, undefined, undefined, headers); ok(renewed);
      const cookies = renewed.headers.getSetCookie();
      const token = cookies.find(value => value.startsWith(`${COOKIE_NAME}=`));
      assert.ok(token && /;\s*Max-Age=604800(?:;|$)/i.test(token), 'The browser must receive a full seven-day session cookie.');
      assert.ok(cookies.some(value => value.split('=')[0].endsWith('.session_data')), 'The short cache cookie is a separate Set-Cookie header.');
      const active = await expiry();
      assert.ok(Math.abs(active - Date.now() - 7 * 86400_000) < 60_000, 'Cookie and database expiry must agree.');
      assert.equal(ok(await http('GET', '/v1/me', undefined, undefined, { ...headers, cookie: token.split(';')[0] })).id, fixture.userId);
      assert.equal(await expiry(), active, 'A fresh session should not be rewritten on every dashboard request.');
    }
  });

  test('invalid Bearer credentials never fall back to a valid dashboard cookie; machine writes need no Origin', async t => {
    const headers = { cookie: manager!.cookie, origin: PUBLIC_ORIGIN };
    error(await http('GET', '/v1/me', 'not-a-valid-key', undefined, headers), 401, 'AUTH_INVALID');
    error(await http('GET', '/v1/me', undefined, undefined, { ...headers, authorization: 'Basic invalid' }), 401, 'AUTH_INVALID');
    const key = await keyFixture(t);
    const contact = ok(await http('POST', '/v1/contacts', key.secret, { email: address() }), 201);
    cleanup(t, async () => { ok(await http('DELETE', `/v1/contacts/${contact.id}`, MANAGER), [200, 404]); });
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret)).id, contact.id);
    ok(await http('POST', `/v1/api-keys/${key.id}/revoke`, MANAGER), [200, 204]);
    error(await http('GET', '/v1/me', key.secret, undefined, headers), 401, 'AUTH_INVALID');
  });

  test('cookie-authenticated unsafe requests require the canonical Origin and leave no rejected writes', async () => {
    for (const origin of [undefined, 'https://attacker.invalid', `${PUBLIC_ORIGIN}.attacker.invalid`]) {
      const email = address();
      const headers: Record<string, string> = { cookie: manager!.cookie };
      if (origin) headers.origin = origin;
      error(await http('POST', '/v1/contacts', undefined, { email }, headers), 403, 'CSRF_ORIGIN_INVALID');
      assert.equal((await authDb!.query('SELECT id FROM audience_contacts WHERE email = $1', [email])).rowCount, 0, 'Rejected CSRF writes must never create a contact.');
      error(await http('POST', '/api/auth/sign-out', undefined, {}, headers), 403, 'CSRF_ORIGIN_INVALID');
      error(await http('POST', '/api/auth/sign-in/social', undefined, { provider: 'google' }, headers), 403, 'CSRF_ORIGIN_INVALID');
      assert.equal(ok(await http('GET', '/v1/me', MANAGER)).id, manager!.userId, 'Rejected sign-out cannot revoke the valid session.');
    }
  });

  test('each request rechecks verified Google identity and exact allowlists, not cached session inspection', async t => {
    const fixture = await sessionFixture(t);
    const headers = { cookie: fixture.cookie, origin: PUBLIC_ORIGIN };
    const initial = await http('GET', '/v1/me', undefined, undefined, headers);
    assert.equal(ok(initial).id, fixture.userId, 'An exact approved hd must authorize a verified Google account.');
    // Replay the same credentials as a browser, including its signed session-data cache.
    const sessionData = initial.headers.getSetCookie().map(value => value.split(';')[0]!).filter(value => value.includes('session_data='));
    assert.ok(sessionData.length);
    for (const cookie of sessionData) secrets.add(cookie);
    headers.cookie = [fixture.cookie, ...sessionData].join('; ');
    const cases = [
      { email: fixture.email, verified: false, hd: AUTH_DOMAIN, account: true, reason: 'Unverified email' },
      { email: fixture.email, verified: true, hd: AUTH_DOMAIN, account: false, reason: 'Missing Google account' },
      { email: `${unique('unapproved')}@unapproved.invalid`, verified: true, hd: null, account: true, reason: 'Unapproved identity' },
      { email: fixture.email, verified: true, hd: null, account: true, reason: 'Email suffix alone is not Google hd' },
      { email: `${unique('suffix')}@unapproved.invalid`, verified: true, hd: `${AUTH_DOMAIN}.evil.invalid`, account: true, reason: 'Allowed-domain suffix attack' },
      { email: `${unique('prefix')}@unapproved.invalid`, verified: true, hd: `evil${AUTH_DOMAIN}`, account: true, reason: 'Allowed-domain prefix attack' },
    ];
    for (const state of cases) {
      await authDb!.query('UPDATE auth_user SET email = $2, email_verified = $3, google_hosted_domain = $4 WHERE id = $1', [fixture.userId, state.email, state.verified, state.hd]);
      await authDb!.query('UPDATE auth_account SET provider_id = $2 WHERE user_id = $1', [fixture.userId, state.account ? 'google' : 'not-google']);
      error(await http('GET', '/v1/me', undefined, undefined, headers), 401, 'AUTH_REQUIRED');
      if (!state.account) error(await http('GET', '/v1/inbound/threads', undefined, undefined, { ...headers, 'x-opensend-environment': 'live' }), 401, 'AUTH_REQUIRED');
      assert.equal(ok(await http('GET', '/api/auth/get-session', undefined, undefined, headers)), null, state.reason);
      const email = address();
      error(await http('POST', '/v1/contacts', undefined, { email }, headers), 401, 'AUTH_REQUIRED');
      assert.equal((await authDb!.query('SELECT id FROM audience_contacts WHERE email = $1', [email])).rowCount, 0, `${state.reason} must prevent all API writes.`);
    }
    await authDb!.query('UPDATE auth_user SET email = $2, email_verified = true, google_hosted_domain = $3 WHERE id = $1', [fixture.userId, fixture.email, AUTH_DOMAIN]);
    assert.equal(ok(await http('GET', '/v1/me', undefined, undefined, headers)).id, fixture.userId, 'Restoring this fixture’s current Google policy evidence must restore access without replacing its cookie.');
    await authDb!.query('DELETE FROM auth_session WHERE id = $1', [fixture.sessionId]);
    error(await http('GET', '/v1/me', undefined, undefined, headers), 401, 'AUTH_REQUIRED');
    assert.equal(ok(await http('GET', '/api/auth/get-session', undefined, undefined, headers)), null);
  });

  test('profile forgery, password login, non-Google providers and account linking are not public authentication paths', async t => {
    const fixture = await sessionFixture(t, { email: `${unique('unapproved')}@unapproved.invalid`, hostedDomain: null });
    const headers = { cookie: fixture.cookie, origin: PUBLIC_ORIGIN };
    for (const path of ['/update-user', '/sign-in/email', '/sign-up/email', '/link-social', '/change-email', '/get-access-token', '/callback/github']) {
      error(await http(path.startsWith('/callback/') ? 'GET' : 'POST', `/api/auth${path}`, undefined,
        path.startsWith('/callback/') ? undefined : { email: AUTH_EMAIL, googleHostedDomain: AUTH_DOMAIN, provider: 'google', password: 'synthetic-never-valid' }, headers), 404, 'NOT_FOUND');
    }
    for (const body of [
      { provider: 'github' }, { provider: 'google', googleHostedDomain: AUTH_DOMAIN },
      { provider: 'google', idToken: { token: 'forged' } }, { provider: 'google', scopes: ['openid', 'email'] },
      { provider: 'google', profile: { email: AUTH_EMAIL, email_verified: true, hd: AUTH_DOMAIN } },
    ]) error(await http('POST', '/api/auth/sign-in/social', undefined, body, headers), 422, 'AUTH_INPUT_INVALID');
    const stored = (await authDb!.query('SELECT email, google_hosted_domain FROM auth_user WHERE id = $1', [fixture.userId])).rows[0];
    assert.equal(stored.email, fixture.email);
    assert.equal(stored.google_hosted_domain, null, 'Client-provided hd must never become verified Google evidence.');
    error(await http('GET', '/v1/me', undefined, undefined, headers), 401, 'AUTH_REQUIRED');
  });

  test('expired, revoked, deleted and tampered sessions deny API access; sign-out revokes its persisted session', async t => {
    for (const state of ['expired', 'revoked', 'deleted', 'tampered', 'sign-out']) {
      const fixture = await sessionFixture(t);
      const headers = { cookie: fixture.cookie, origin: PUBLIC_ORIGIN };
      assert.equal(ok(await http('GET', '/v1/me', undefined, undefined, headers)).id, fixture.userId);
      if (state === 'expired') await authDb!.query('UPDATE auth_session SET expires_at = $2 WHERE id = $1', [fixture.sessionId, new Date(Date.now() - 60_000)]);
      if (state === 'revoked') await authDb!.query('DELETE FROM auth_session WHERE id = $1', [fixture.sessionId]);
      if (state === 'deleted') await authDb!.query('DELETE FROM auth_user WHERE id = $1', [fixture.userId]);
      if (state === 'tampered') headers.cookie = `${COOKIE_NAME}=${encodeURIComponent(`${fixture.token}.forged-signature`)}`;
      if (state === 'sign-out') {
        const signedOut = await http('POST', '/api/auth/sign-out', undefined, {}, headers);
        assert.equal(ok(signedOut).success, true);
        assert.match(signedOut.headers.get('set-cookie') ?? '', /opensend\.session_token=/);
        assert.equal((await authDb!.query('SELECT id FROM auth_session WHERE id = $1', [fixture.sessionId])).rowCount, 0);
      }
      error(await http('GET', '/v1/me', undefined, undefined, headers), 401, 'AUTH_REQUIRED');
      const email = address();
      error(await http('POST', '/v1/contacts', undefined, { email }, headers), 401, 'AUTH_REQUIRED');
      assert.equal((await authDb!.query('SELECT id FROM audience_contacts WHERE email = $1', [email])).rowCount, 0, `${state} sessions must not write.`);
    }
  });

  test('forged OAuth callback state and code cannot create an identity or session', async () => {
    const before = (await authDb!.query('SELECT (SELECT count(*) FROM auth_user) AS users, (SELECT count(*) FROM auth_session) AS sessions')).rows[0];
    // Never create a valid state or call Google's authorization/token endpoints.
    // Invalid state must fail locally before exchanging the deliberately fake code.
    const reply = await http('GET', `/api/auth/callback/google?state=${unique('never-issued')}&code=${unique('forged-code')}`);
    assert.equal(reply.status, 302, diagnostic(reply));
    assert.equal(reply.headers.get('location'), `${PUBLIC_ORIGIN}/?auth=error`);
    assert.ok(!reply.headers.get('set-cookie')?.includes(`${COOKIE_NAME}=`), 'An invalid callback must not issue a session cookie.');
    assert.deepEqual((await authDb!.query('SELECT (SELECT count(*) FROM auth_user) AS users, (SELECT count(*) FROM auth_session) AS sessions')).rows[0], before);
  });

  test('MOCK GOOGLE TRANSPORT: real OAuth state/callback lifecycle persists trusted claims, rejects denied profiles, and fails closed on configuration', async t => {
    const [{ createApp }, { drizzle }] = await Promise.all([import('./src/app.js'), import('drizzle-orm/node-postgres')]);
    const app = createApp();
    const origin = 'https://mock-oauth.opensend.dev';
    const emailAllowed = `${unique('mock-email-approved')}@unapproved.invalid`;
    const runtime: import('./src/core.js').Runtime = {
      db: drizzle(authDb!),
      storage: { async put() { throw new Error('Unexpected storage access'); }, async get() { throw new Error('Unexpected storage access'); }, async delete() { throw new Error('Unexpected storage access'); } },
      config: { multiTenant: false, hostedSendCaps: {firstWeek:100,secondWeek:1000,mature:10000}, workspaceId: unique('mock-oauth-workspace'), authSecret: unique('mock-oauth-root-secret'), googleClientId: 'acceptance-client.apps.googleusercontent.com', googleClientSecret: 'synthetic-client-secret',
        allowedEmails: [emailAllowed], allowedDomains: ['example.com', 'second.example.com'], defaultWorkspaceOwners: '*', publicUrl: origin, regions: [REGION], liveEnabled: false, apiRateLimitPerMinute: 1200, simulatedSes: { latencyMs: 100, maxSendRate: 1000, deliveryDelayMs: 250 }, dispatch: { rateFactor: 1, dailyHeadroomPercent: 10 }, encryptionKey: '0'.repeat(64), snsTopicArns: [], configurationSets: { transactional: '', marketing: '' } },
    };
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = unique('mock-google-signing-key');
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
    let profile: Json = {};
    let jwtFault = '';
    let expectedCode = '';
    let expectedNonce: string | null = null;
    let tokenCalls = 0;
    let certCalls = 0;
    const transport = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === 'https://oauth2.googleapis.com/token') {
        tokenCalls++;
        const form = new URLSearchParams(await request.text());
        assert.equal(form.get('code'), expectedCode, 'Only the current synthetic callback may exchange a code.');
        assert.equal(form.get('redirect_uri'), `${origin}/api/auth/callback/google`);
        assert.ok(form.get('code_verifier'), 'The actual OAuth callback must retain its generated PKCE verifier.');
        const now = Math.floor(Date.now() / 1000);
        const head = Buffer.from(JSON.stringify({ alg: jwtFault === 'unsigned' ? 'none' : 'RS256', kid, typ: 'JWT' })).toString('base64url');
        const payload: Json = { iss: 'https://accounts.google.com', aud: runtime.config.googleClientId, iat: now, exp: now + 300, ...profile, ...(expectedNonce ? { nonce: expectedNonce } : {}) };
        if (jwtFault === 'audience') payload.aud = 'wrong-client.apps.googleusercontent.com';
        if (jwtFault === 'issuer') payload.iss = 'https://attacker.invalid';
        if (jwtFault === 'expired') { payload.iat = now - 120; payload.exp = now - 60; }
        if (jwtFault === 'missing-exp') delete payload.exp;
        const claims = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const input = `${head}.${claims}`;
        const signature = Buffer.from(sign('RSA-SHA256', Buffer.from(input), privateKey));
        if (jwtFault === 'signature') signature[0] = signature[0]! ^ 1;
        const idToken = `${input}.${jwtFault === 'unsigned' ? '' : signature.toString('base64url')}`;
        return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', id_token: idToken, token_type: 'Bearer', expires_in: 300, scope: 'openid email profile' });
      }
      if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        certCalls++;
        return Response.json({ keys: [jwk] });
      }
      throw new Error(`Unexpected network request in mocked Google transport: ${new URL(request.url).origin}`);
    });
    async function local(method: string, path: string, body?: Json, cookie?: string, headers: Record<string, string> = {}): Promise<Reply> {
      const response = await app.fetch(new Request(`${origin}${path}`, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), runtime);
      const text = await response.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* Redirects intentionally have no JSON body. */ }
      return { status: response.status, body: parsed, headers: response.headers };
    }
    const fixtureEmails: string[] = [];
    const states: string[] = [];
    cleanup(t, async () => {
      await authDb!.query('DELETE FROM api_request_budgets WHERE workspace_id = $1', [runtime.config.workspaceId]);
      for (const email of fixtureEmails) await authDb!.query('DELETE FROM auth_user WHERE email = $1', [email]);
      for (const state of states) await authDb!.query('DELETE FROM auth_verification WHERE identifier = $1', [state]);
    });
    let approvedCookie = '';
    const returningSub = unique('mock-returning-sub');
    const returningEmail = `${unique('mock-returning')}@example.com`;
    const scenarios: Array<{ allowed: boolean; email: string; hd?: string; verified: boolean; sub?: string; jwtFault?: string }> = [
      { allowed: true, email: emailAllowed, hd: undefined, verified: true },
      { allowed: true, email: `${unique('mock-domain')}@example.com`, hd: 'example.com', verified: true },
      { allowed: false, email: `${unique('mock-unverified')}@example.com`, hd: 'example.com', verified: false },
      { allowed: false, email: `${unique('mock-denied')}@unapproved.invalid`, hd: undefined, verified: true },
      { allowed: false, email: `${unique('mock-suffix')}@unapproved.invalid`, hd: 'example.com.evil.invalid', verified: true },
      { allowed: false, email: `${unique('mock-email-suffix')}@example.com`, hd: undefined, verified: true },
      ...['signature', 'audience', 'issuer', 'expired', 'missing-exp', 'unsigned'].map(jwtFault => ({ allowed: false, email: `${unique(`mock-jwt-${jwtFault}`)}@example.com`, hd: 'example.com', verified: true, jwtFault })),
      { allowed: true, email: returningEmail, hd: 'example.com', verified: true, sub: returningSub },
      { allowed: true, email: returningEmail, hd: 'second.example.com', verified: true, sub: returningSub },
      { allowed: false, email: returningEmail, hd: 'revoked.invalid', verified: true, sub: returningSub },
      { allowed: false, email: `${unique('mock-returning-revoked')}@unapproved.invalid`, hd: undefined, verified: true, sub: returningSub },
    ];
    async function login(scenario: typeof scenarios[number], callbackURL = `${origin}/`) {
      fixtureEmails.push(scenario.email);
      jwtFault = scenario.jwtFault ?? '';
      profile = { sub: scenario.sub ?? unique('mock-google-sub'), name: 'Mock provider identity', email: scenario.email, email_verified: scenario.verified, ...(scenario.hd ? { hd: scenario.hd } : {}) };
      const userBefore = (await authDb!.query('SELECT * FROM auth_user WHERE email = $1', [scenario.email])).rows;
      const subjectBefore = (await authDb!.query('SELECT u.*, a.account_id FROM auth_user u JOIN auth_account a ON a.user_id = u.id WHERE a.provider_id = $1 AND a.account_id = $2', ['google', profile.sub])).rows;
      const sessionsBefore = (await authDb!.query('SELECT s.* FROM auth_session s JOIN auth_account a ON a.user_id = s.user_id WHERE a.provider_id = $1 AND a.account_id = $2 ORDER BY s.id', ['google', profile.sub])).rows;
      const start = await local('POST', '/api/auth/sign-in/social', { provider: 'google', callbackURL, disableRedirect: true });
      const authorization = new URL(ok(start).url);
      assert.equal(authorization.origin, 'https://accounts.google.com');
      assert.deepEqual(authorization.searchParams.get('scope')!.split(' ').sort(), ['email', 'openid', 'profile']);
      assert.equal(authorization.searchParams.get('access_type'), 'online');
      assert.equal(authorization.searchParams.get('include_granted_scopes'), null);
      const state = authorization.searchParams.get('state');
      assert.ok(state);
      states.push(state);
      expectedNonce = authorization.searchParams.get('nonce');
      const stateCookie = start.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      assert.ok(stateCookie, 'The real sign-in endpoint must issue a state-binding cookie.');
      expectedCode = unique('mock-authorization-code');
      const previousCalls = tokenCalls;
      const callback = await local('GET', `/api/auth/callback/google?state=${encodeURIComponent(state)}&code=${expectedCode}`, undefined, stateCookie);
      assert.equal(tokenCalls, previousCalls + 1, 'The real callback must exchange this code exactly once through the mocked transport.');
      assert.equal(callback.status, 302, diagnostic(callback));
      const users = await authDb!.query('SELECT id, email_verified, google_hosted_domain FROM auth_user WHERE email = $1', [scenario.email]);
      if (scenario.allowed) {
        assert.equal(callback.headers.get('location'), callbackURL);
        assert.equal(users.rowCount, 1, 'An approved real callback must create its user through the normal Better Auth lifecycle.');
        assert.equal(users.rows[0].email_verified, true);
        assert.equal(users.rows[0].google_hosted_domain, scenario.hd ?? null);
        if (subjectBefore.length) assert.equal(users.rows[0].id, subjectBefore[0].id, 'Returning Google sub must refresh the same user, never swap identities.');
        const account = (await authDb!.query('SELECT * FROM auth_account WHERE user_id = $1', [users.rows[0].id])).rows[0];
        assert.ok(account);
        assert.equal(account.provider_id, 'google');
        assert.equal(account.account_id, profile.sub);
        for (const field of ['access_token', 'refresh_token', 'id_token', 'password', 'scope']) assert.equal(account[field], null, 'Google token material must not remain in the account row.');
        const sessionCookie = callback.headers.getSetCookie().find(value => value.startsWith('__Secure-opensend.session_token='));
        assert.ok(sessionCookie, 'A successful callback must issue the secure prefixed session cookie.');
        assert.match(sessionCookie, /;\s*HttpOnly/i);
        assert.match(sessionCookie, /;\s*Secure/i);
        assert.match(sessionCookie, /;\s*SameSite=Lax/i);
        assert.ok(/;\s*Max-Age=604800(?:;|$)/i.test(sessionCookie), 'A new Google login must last seven days in the browser.');
        approvedCookie = sessionCookie.split(';')[0];
        secrets.add(approvedCookie);
        const me = ok(await local('GET', '/v1/me', undefined, approvedCookie));
        assert.equal(me.id, users.rows[0].id);
        assert.equal(me.email, scenario.email);
      } else {
        assert.equal(callback.headers.get('location'), `${origin}/?auth=error`);
        assert.equal(users.rowCount, userBefore.length, 'Denied profile/JWT must not provision another identity.');
        assert.deepEqual((await authDb!.query('SELECT * FROM auth_user WHERE email = $1', [scenario.email])).rows, userBefore);
        assert.deepEqual((await authDb!.query('SELECT u.*, a.account_id FROM auth_user u JOIN auth_account a ON a.user_id = u.id WHERE a.provider_id = $1 AND a.account_id = $2', ['google', profile.sub])).rows, subjectBefore, 'A denied returning profile must not replace the established identity or overwrite its last trusted hd.');
        assert.deepEqual((await authDb!.query('SELECT s.* FROM auth_session s JOIN auth_account a ON a.user_id = s.user_id WHERE a.provider_id = $1 AND a.account_id = $2 ORDER BY s.id', ['google', profile.sub])).rows, sessionsBefore, 'Denied profile/JWT must not create any session.');
        assert.ok(!callback.headers.getSetCookie().some(value => value.startsWith('__Secure-opensend.session_token=')));
      }
      const replay = await local('GET', `/api/auth/callback/google?state=${encodeURIComponent(state)}&code=${expectedCode}`, undefined, stateCookie);
      assert.equal(replay.headers.get('location'), `${origin}/?auth=error`);
      assert.equal(tokenCalls, previousCalls + 1, 'Consumed OAuth state cannot exchange a code twice.');
      return approvedCookie;
    }
    for (const scenario of scenarios) await login(scenario);
    assert.ok(certCalls > 0, 'The normal provider path must verify the mocked JWT against mocked Google JWKS, not merely decode claims.');
    assert.ok(approvedCookie);
    runtime.config.allowedEmails = [];
    runtime.config.allowedDomains = [];
    error(await local('GET', '/v1/me', undefined, approvedCookie), 401, 'AUTH_REQUIRED');
    const blockedEmail = address();
    error(await local('POST', '/v1/contacts', { email: blockedEmail }, approvedCookie), 401, 'AUTH_REQUIRED');
    runtime.config.googleClientSecret = undefined;
    error(await local('GET', '/v1/me', undefined, approvedCookie), 503, 'AUTH_NOT_CONFIGURED');
    error(await local('POST', '/v1/contacts', { email: blockedEmail }, approvedCookie), 503, 'AUTH_NOT_CONFIGURED');
    error(await local('POST', '/api/auth/sign-in/social', { provider: 'google' }), 503, 'AUTH_NOT_CONFIGURED');
    assert.equal((await authDb!.query('SELECT id FROM audience_contacts WHERE email = $1', [blockedEmail])).rowCount, 0);
    await t.test('MX: atomic Google signup, invited roles, workspace selection and isolation', async mx => {
      const pool = new pg.Pool({ connectionString: FIXTURE_DATABASE_URL, max: 5 });
      cleanup(t, () => pool.end());
      runtime.db = drizzle(pool);
      Object.assign(runtime.config, { multiTenant: true, googleClientSecret: 'synthetic-client-secret', allowedDomains: ['example.com'], defaultWorkspaceOwners: [] });
      const base = '/v1/workspaces/current', workspaces: string[] = [];
      cleanup(t, async () => {
        for (const wid of workspaces) {
          await pool.query('DELETE FROM audience_contacts WHERE workspace_id = $1', [wid]);
          await pool.query('DELETE FROM ses_installation_settings WHERE workspace_id = $1', [wid]);
          await pool.query('DELETE FROM workspaces WHERE id = $1', [wid]);
        }
      });
      const ownerEmail = `${unique('mx-owner')}@example.com`, otherEmail = `${unique('mx-owner')}@example.com`, guestEmail = `${unique('mx-guest')}@outside.invalid`;
      const newOwner = async (email: string) => {
        const cookie = await login({ allowed: true, email, verified: true, hd: 'example.com' });
        const [first, simultaneous] = await Promise.all([local('GET', '/v1/workspaces', undefined, cookie), local('GET', '/v1/workspaces', undefined, cookie)]);
        const memberships = ok(first).data; assert.deepEqual(ok(simultaneous).data, memberships);
        assert.equal(memberships.length, 1); const [org] = memberships; workspaces.push(org.id);
        assert.equal(org.role, 'owner'); assert.equal(org.name, "Mock provider identity's Organization"); assert.notEqual(org.id, 'default');
        return { cookie, org };
      };
      const a = await newOwner(ownerEmail);
      const unsolicited = ok(await local('POST', `${base}/invitations`, { email: otherEmail, role: 'member' }, a.cookie), 201);
      const b = await newOwner(otherEmail); // No link: exactly one personal workspace, despite the pending invitation.
      assert.notEqual(a.org.id, b.org.id); assert.notEqual(a.org.slug, b.org.slug);
      const acceptedPath = `/v1/workspaces/invitations/${unsolicited.id}/accept`;
      assert.equal(ok(await local('POST', acceptedPath, undefined, b.cookie)).workspaceId, a.org.id);
      const invitedMember = ok(await local('GET', `${base}/members`, undefined, a.cookie)).data.find((row: Json) => row.email === otherEmail);
      ok(await local('DELETE', `${base}/members/${invitedMember.id}`, undefined, a.cookie));
      const select = (id: string) => ({ 'x-opensend-workspace': id });
      error(await local('GET', '/v1/me', undefined, a.cookie, select(b.org.id)), 403, 'WORKSPACE_ACCESS_DENIED');
      const invitedEmail = `${unique('mx-invited-owner')}@example.com`;
      const linked = ok(await local('POST', `${base}/invitations`, {email:invitedEmail,role:'member'}, b.cookie),201);
      const invitedCookie = await login({allowed:true,email:invitedEmail,verified:true,hd:'example.com'},linked.acceptUrl);
      const joined = ok(await local('GET','/v1/workspaces',undefined,invitedCookie)).data;
      assert.equal(joined.length,2,'OAuth accepted the link before any dashboard POST, without skipping the personal workspace.');
      const personal = joined.find((w:Json)=>w.role==='owner');assert.ok(personal && personal.id!==b.org.id);workspaces.push(personal.id);
      assert.equal(joined.find((w:Json)=>w.id===b.org.id)?.role,'member');
      assert.equal(ok(await local('GET','/v1/me',undefined,invitedCookie)).workspaceId,b.org.id);
      assert.equal(ok(await local('POST',`/v1/workspaces/invitations/${linked.id}/accept`,undefined,invitedCookie)).workspaceId,b.org.id);
      const extra = ok(await local('POST', '/v1/workspaces', { name: ' Automated ' }, b.cookie), 201); workspaces.push(extra.id);
      assert.equal(extra.name, 'Automated'); assert.equal(extra.role, 'owner'); assert.notEqual(extra.id, b.org.id);
      const extraMe = ok(await local('GET', '/v1/me', undefined, b.cookie, select(extra.id)));
      assert.equal(extraMe.workspaceId, extra.id); assert.equal(extraMe.role, 'owner'); assert.notEqual(extraMe.connection?.state, 'ready');
      assert.equal((await pool.query('SELECT default_region FROM ses_installation_settings WHERE workspace_id = $1', [extra.id])).rows[0]?.default_region, runtime.config.regions[0]);
      const burst = await Promise.all(Array.from({ length: 9 }, (_, i) => local('POST', '/v1/workspaces', { name: `Burst ${i}` }, b.cookie)));
      for (const reply of burst) if (reply.status === 201) workspaces.push(reply.body.id);
      assert.deepEqual(burst.map(reply => reply.status).sort(), [...Array(8).fill(201), 409], 'Concurrent creates stop at ten owned workspaces.');
      error(await local('POST', '/v1/workspaces', { name: 'Eleventh' }, b.cookie), 409, 'WORKSPACE_LIMIT');
      // Later steps use b's original workspace: reselect it and drop the extras.
      ok(await local('GET', '/v1/me', undefined, b.cookie, select(b.org.id)));
      for (const wid of workspaces.splice(workspaces.indexOf(extra.id))) {
        await pool.query('DELETE FROM ses_installation_settings WHERE workspace_id = $1', [wid]);
        await pool.query('DELETE FROM workspaces WHERE id = $1', [wid]);
      }
      runtime.config.allowedDomains = []; // A real callback still admits the invitee, not an arbitrary verified address.
      await login({ allowed: false, email: `${unique('mx-denied')}@outside.invalid`, verified: true });
      const invitation = ok(await local('POST', `${base}/invitations`, { email: guestEmail, role: 'member' }, a.cookie), 201);
      assert.equal(new URL(invitation.acceptUrl).searchParams.get('invitation'), invitation.id);
      const guestSub = unique('guest-sub');
      await login({ allowed: false, email: guestEmail, verified: true, sub: guestSub });
      await login({ allowed: false, email: guestEmail, verified: true, sub: guestSub }, unsolicited.acceptUrl);
      const guest = await login({ allowed: true, email: guestEmail, verified: true, sub: guestSub }, invitation.acceptUrl);
      const me = ok(await local('GET', '/v1/me', undefined, guest));
      assert.equal(me.workspaceId, a.org.id); assert.equal(me.role, 'member'); assert.deepEqual(me.permissions, ['read','send']);
      error(await local('POST', '/v1/workspaces', { name: 'Guest workspace' }, guest), 403, 'SIGNUP_NOT_APPROVED');
      await mx.test('MX connections: shared provisioning is regional; BYO verifies and uniquely claims an account with an external ID', async providerTest => {
        const [{ STSClient }, { SESv2Client }, { SNSClient }, { getSes }] = await Promise.all([import('@aws-sdk/client-sts'), import('@aws-sdk/client-sesv2'), import('@aws-sdk/client-sns'), import('./src/core.js')]);
        const path = '/v1/connection', region = 'us-east-2', platform = '111111111111', customer = '222222222222';
        const platformKey = { accessKeyId: 'synthetic-platform', secretAccessKey: 'synthetic-platform-secret' };
        const callerArn = `arn:aws:iam::${platform}:user/synthetic-platform`;
        let externalIds: string[] = [], assumptions = 0, identityChecks = 0, ohioConfirmationPending = true, laxTrust = false;
        let holdAssume: (()=>Promise<void>)|undefined;
        let failImportRead=false, wrongArn=false;
        providerTest.mock.method(STSClient.prototype, 'send', async function(this: InstanceType<typeof STSClient>, command: any) {
          const key = (await this.config.credentials()).accessKeyId;
          if (command.constructor.name === 'GetCallerIdentityCommand') { identityChecks++; return key === platformKey.accessKeyId ? { Account: platform, Arn: callerArn } : { Account: customer, Arn: `arn:aws:sts::${customer}:assumed-role/OpenSendMX/synthetic` }; }
          assert.equal(command.constructor.name, 'AssumeRoleCommand'); assert.equal(key, platformKey.accessKeyId);
          if (!command.input.ExternalId || (!laxTrust && !externalIds.includes(command.input.ExternalId)) || !command.input.RoleArn.startsWith(`arn:aws:iam::${customer}:`)) throw Object.assign(new Error('Synthetic trust policy denial'), { name: 'AccessDenied' });
          assert.match(command.input.RoleArn, /^arn:aws:iam::222222222222:role\/OpenSendMX-[a-f0-9]{20}$/);
          const wait=holdAssume;holdAssume=undefined;if(wait) await wait();
          assumptions++; return { AssumedRoleUser:{Arn:`arn:aws:sts::${wrongArn?platform:customer}:assumed-role/${command.input.RoleArn.split('/')[1]}/${command.input.RoleSessionName}`}, Credentials: { AccessKeyId: 'synthetic-customer', SecretAccessKey: 'synthetic-secret', SessionToken: 'synthetic-temporary', Expiration: new Date(Date.now() + 3600_000) } };
        });
        const calls: string[] = [], sets = new Map<string, Json>(), topics = new Map<string, Json>();
        const identities = new Map<string, Json>(), associations = new Set<string>();
        const {S3Client}=await import('@aws-sdk/client-s3'),{SESClient}=await import('@aws-sdk/client-ses');
        const objects=new Map<string,Buffer>(),rules=new Map<string,Json>();let failNextArchive=false;
        providerTest.mock.method(SESClient.prototype,'send',async function(this:InstanceType<typeof SESClient>,cmd:any){
          const region=await this.config.region(),i=cmd.input;
          if(cmd.constructor.name==='DescribeActiveReceiptRuleSetCommand') return {Metadata:{Name:'existing-rules'},Rules:[{Name:'customer-rule'},...(rules.has(region)?[rules.get(region)]:[])]};
          assert.equal(cmd.constructor.name,'CreateReceiptRuleCommand');assert.equal(i.RuleSetName,'existing-rules');assert.equal(i.After,'customer-rule');assert.deepEqual(i.Rule.Recipients,[]);assert.equal(i.Rule.ScanEnabled,true);assert.equal(i.Rule.Actions[0].S3Action.ObjectKeyPrefix,'staging/');rules.set(region,i.Rule);return {};
        });
        providerTest.mock.method(S3Client.prototype,'send',async function(this:InstanceType<typeof S3Client>,cmd:any){
          assert.equal((await this.config.credentials()).accessKeyId,platformKey.accessKeyId);
          const i=cmd.input,k=i.Bucket+'/'+i.Key;
          switch(cmd.constructor.name){
            case 'HeadBucketCommand': throw Object.assign(new Error('missing fixture bucket'),{name:'NotFound'});
            case 'CreateBucketCommand': case 'PutBucketTaggingCommand': case 'PutPublicAccessBlockCommand':case 'PutBucketPolicyCommand':case 'PutBucketLifecycleConfigurationCommand':return {};
            case 'HeadObjectCommand': return {ContentLength:objects.get(k)!.length,ETag:'"fixture"'};
            case 'GetObjectCommand': assert.ok(objects.has(k));assert.equal(i.IfMatch,'"fixture"');return {Body:{transformToByteArray:async()=>objects.get(k)}};
            case 'CopyObjectCommand':assert.ok(objects.has(i.CopySource));objects.set(k,objects.get(i.CopySource)!);return {};
            case 'PutObjectCommand':if(failNextArchive){failNextArchive=false;throw Error('synthetic archive interruption');}objects.set(k,Buffer.from(i.Body));return {};
            default:throw Error(cmd.constructor.name);
          }
        });
        let loseCreateResponse = false, failTenantOnce = false, dropCreate = false;
        const root = `${unique('claims')}.invalid`, domain = `mail.${root}`, foreign = `existing.${unique('ses')}.invalid`;
        const importParent=`${unique('import')}.invalid`,imported=`mail.${importParent}`, reserved=`${unique('reserved')}.invalid`;
        const verifiedIdentity = { VerificationStatus:'SUCCESS', VerifiedForSendingStatus:true, DkimAttributes:{ SigningEnabled:true, Status:'SUCCESS', Tokens:['fixture1','fixture2','fixture3'], SigningHostedZone:'dkim.amazonses.com' } };
        identities.set(`${platform}:${foreign}`, verifiedIdentity);
        const missing = () => { throw Object.assign(new Error('Synthetic missing resource'), { name: 'NotFoundException' }); };
        async function aws(this: InstanceType<typeof SNSClient> | InstanceType<typeof SESv2Client>, command: any) {
          const account = (await this.config.credentials()).accessKeyId === platformKey.accessKeyId ? platform : customer;
          const region = await this.config.region(), name = command.constructor.name, i = command.input, setKey = `${region}:${i.ConfigurationSetName}`, set = sets.get(setKey), topic = topics.get(i.TopicArn ?? i.ResourceArn ?? i.SubscriptionArn?.split(':').slice(0, 6).join(':'));
          calls.push(name);
          switch (name) {
            case 'GetEmailIdentityCommand': return identities.get(`${account}:${i.EmailIdentity}`) ?? missing();
            case 'CreateEmailIdentityCommand': {
              if (dropCreate) { dropCreate=false; throw new Error('Synthetic connection reset before SES received Create'); }
              if (identities.has(`${account}:${i.EmailIdentity}`)) throw Object.assign(new Error('Existing identity'),{name:'AlreadyExistsException'});
              assert.equal(i.Tags[0].Key,'opensend:domain-claim');
              identities.set(`${account}:${i.EmailIdentity}`, { ...verifiedIdentity, Tags:i.Tags });
              if (loseCreateResponse) { loseCreateResponse=false; throw new Error('Synthetic connection reset after SES accepted Create'); }
              return {DkimAttributes:{...verifiedIdentity.DkimAttributes,Status:'PENDING'},VerifiedForSendingStatus:false};
            }
            case 'ListResourceTenantsCommand': return {ResourceTenants:[...associations].filter(k=>k.endsWith(`:${i.ResourceArn}`)).map(k=>({TenantName:k.split(':')[0]}))};
            case 'DeleteTenantResourceAssociationCommand': assert.ok(associations.delete(`${i.TenantName}:${i.ResourceArn}`),'Never remove an association that does not exist'); return {};
            case 'DeleteEmailIdentityCommand': assert.ok(identities.delete(`${account}:${i.EmailIdentity}`)); return {};
            case 'ListEmailIdentitiesCommand': {
              assert.equal(account, customer);
              if (failImportRead) throw Object.assign(new Error('synthetic throttle'),{name:'ThrottlingException'});
              const listed=(name:string)=>({IdentityType:'DOMAIN',IdentityName:name,SendingEnabled:true,VerificationStatus:'SUCCESS'});
              return i.NextToken ? {EmailIdentities:[listed(imported),listed(`mail.${reserved}`),listed(reserved)]} : {EmailIdentities:[{...listed(domain),VerificationStatus:'PENDING'}, {...listed('me@'+domain),IdentityType:'EMAIL_ADDRESS'}],NextToken:'second'};
            }
            case 'PutEmailIdentityMailFromAttributesCommand': identities.get(`${account}:${i.EmailIdentity}`)!.MailFromAttributes = { MailFromDomain:i.MailFromDomain, MailFromDomainStatus:'SUCCESS' }; return {};
            case 'GetAccountCommand': return { ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: 'HEALTHY' };
            case 'GetConfigurationSetCommand': return set ?? missing();
            case 'GetConfigurationSetEventDestinationsCommand': return { EventDestinations: set!.destinations };
            case 'CreateConfigurationSetCommand': assert.equal(i.ConfigurationSetName.startsWith('opensend-mx-'), account === platform); sets.set(setKey, { ...i, destinations: [] }); return {};
            case 'PutConfigurationSetSuppressionOptionsCommand': assert.equal(i.SuppressionScope, account === platform ? 'TENANT' : 'ACCOUNT'); set!.SuppressionOptions = i; return {};
            case 'CreateConfigurationSetEventDestinationCommand': set!.destinations.push({ ...i.EventDestination, Name: i.EventDestinationName }); return {};
            case 'UpdateConfigurationSetEventDestinationCommand': set!.destinations = [{ ...i.EventDestination, Name: i.EventDestinationName }]; return {};
            case 'CreateTopicCommand': { const arn = `arn:aws:sns:${region}:${account}:${i.Name}`; topics.set(arn, { Tags: i.Tags, Attributes: { TopicArn: arn, Owner: account }, subs: [] }); return { TopicArn: arn }; }
            case 'GetTopicAttributesCommand': return topic ?? missing();
            case 'ListTagsForResourceCommand': return topic;
            case 'SetTopicAttributesCommand': topic!.Attributes.Policy = i.AttributeValue; return {};
            case 'ListSubscriptionsByTopicCommand': return { Subscriptions: topic!.subs };
            case 'SubscribeCommand': {
              assert.equal(i.Endpoint, `${origin}/v1/events/ses`);
              const allowed = await pool.query('SELECT 1 FROM provider_pool_regions WHERE feedback_topic_arn=$1 OR inbound_topic_arn=$1 UNION SELECT 1 FROM provider_connections WHERE feedback_topic_arn=$1 UNION SELECT 1 FROM mailbox_regions WHERE topic_arn=$1', [i.TopicArn]);
              assert.equal(allowed.rowCount, 1); topic!.subs.push({ ...i, SubscriptionArn: `${i.TopicArn}:fixture` }); return {SubscriptionArn:`${i.TopicArn}:fixture`};
            }
            case 'GetSubscriptionAttributesCommand': return { Attributes: { ...topic!.subs[0], PendingConfirmation: String(ohioConfirmationPending && region === 'us-east-2' && account === platform), Owner: account, RawMessageDelivery: 'false' } };
            case 'CreateTenantCommand': {
              assert.deepEqual(i.SuppressionAttributes, { SuppressionScope: 'TENANT', SuppressedReasons: ['BOUNCE','COMPLAINT'] });
              const unready = await pool.query("SELECT 1 FROM provider_connections WHERE 'opensend-' || workspace_id=$1 AND tenant_state<>'ready' AND lease_until IS NULL", [i.TenantName]);
              assert.equal(unready.rowCount, 1, 'CreateTenant is idempotent: no lease, and never for a tenant already marked ready.');
              if (failTenantOnce) { failTenantOnce=false; throw Object.assign(new Error('Synthetic SES outage'),{name:'TooManyRequestsException',$metadata:{httpStatusCode:429}}); }
              return { TenantName: i.TenantName, TenantArn: `arn:aws:ses:${region}:${account}:tenant/${i.TenantName}/fixture` };
            }
            case 'UpdateReputationEntityPolicyCommand': assert.equal(i.ReputationEntityPolicy, `arn:aws:ses:${region}:aws:reputation-policy/strict`); return {};
            case 'CreateTenantResourceAssociationCommand':
              assert.ok([a.org.id, b.org.id].some(wid => i.TenantName === `opensend-${wid}`));
              if (i.ResourceArn.includes(':identity/')) {
                assert.equal(account, platform); const binding = `${i.TenantName}:${i.ResourceArn}`;
                if (associations.has(binding)) throw Object.assign(new Error('Already associated'), { name:'AlreadyExistsException' });
                associations.add(binding);
              } else assert.match(i.ResourceArn, /:configuration-set\/opensend-mx-(transactional|marketing)$/);
              return {};
            default: throw new Error(`Unexpected AWS command ${name}`);
          }
        }
        providerTest.mock.method(SESv2Client.prototype, 'send', aws); providerTest.mock.method(SNSClient.prototype, 'send', aws);
        const offered = [region, 'eu-west-1'], originalRegions = runtime.config.sharedRegions;
        runtime.config.aws = platformKey; runtime.config.liveEnabled = true; runtime.config.sharedRegions = offered;
        providerTest.after(async () => { runtime.config.aws = undefined; runtime.config.liveEnabled = false; runtime.config.byoTemplateUrl = undefined; runtime.config.sharedRegions = originalRegions; await pool.query('DELETE FROM provider_pool_regions WHERE region=ANY($1) AND aws_account_id=$2', [offered, platform]); });
        const choose = (kind: string, cookie: string) => local('POST', path, { kind, region }, cookie);
        const verify = (cookie: string) => local('POST', `${path}/verify`, { awsAccountId: customer }, cookie);
        assert.deepEqual(ok(await local('GET', path, undefined, a.cookie)), { connection: null });
        error(await local('GET', path, undefined, guest), 403); error(await choose('byo', a.cookie), 503, 'BYO_NOT_CONFIGURED');
        const queries=providerTest.mock.method(pg.Client.prototype,'query');
        const originalWake=runtime.wake; let wakes=0; runtime.wake=async()=>{wakes++;}; providerTest.after(()=>{runtime.wake=originalWake;});
        const pending = ok(await local('POST',path,{kind:'shared'},a.cookie), 201);
        providerTest.diagnostic(`POST shared connection: ${queries.mock.callCount()} pg round trips including dashboard auth`);
        assert.equal(pending.state, 'ready'); assert.equal(pending.tenant, 'pending'); assert.equal(calls.length + identityChecks, 0, 'A cold pool must not trigger any AWS work on the request.');
        assert.equal(wakes,0); assert.equal((await pool.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND type='tenant.provision'",[a.org.id])).rowCount,0);
        assert.deepEqual(ok(await local('GET', path, undefined, a.cookie)).connection, pending);
        assert.deepEqual(ok(await local('GET','/v1/me',undefined,a.cookie)).connection,{kind:'shared',region,state:'ready',tenant:'pending',sendingPause:null});
        assert.equal((await pool.query('SELECT lease_until FROM provider_connections WHERE id=$1', [pending.id])).rows[0].lease_until, null);
        const { reconcileSharedConnections,tenantJob } = await import('./src/provider-connections.js');
        await reconcileSharedConnections(runtime);
        assert.ok(!calls.includes('CreateTenantCommand'), 'A tenant must wait for the confirmed regional feedback pool.');
        const waitingStart = calls.length + identityChecks;
        assert.deepEqual(ok(await choose('shared', a.cookie), 201), pending);
        assert.equal(calls.length + identityChecks, waitingStart, 'Retrying a pending connection must not touch AWS.');
        assert.equal(wakes,0,'Even a registered AWS account is not a ready pool until SNS confirms.');
        ohioConfirmationPending = false;
        await reconcileSharedConnections(runtime);
        const recovered = ok(await local('GET', path, undefined, a.cookie)).connection;
        assert.deepEqual(recovered, { ...pending, state: 'ready', tenant: 'ready', awsAccountId: platform });
        assert.deepEqual((await pool.query("SELECT region FROM provider_pool_regions WHERE sending_state='ready' AND receiving_state='ready' AND aws_account_id=$1 ORDER BY region", [platform])).rows.map(r => r.region), [...offered].sort(), 'Warm even regions with no customers.');
        // Hosted is instant: a warm pool queues the tenant job in the same statement and makes no AWS call. The job
        // owns CreateTenant; its failures are visible as `tenant`, never as a silently queued send.
        const warmStart = calls.length, warmChecks = identityChecks;
        const connected = ok(await choose('shared', b.cookie), 201);
        assert.equal(wakes,1,'The warm pool wakes the queued tenant job.');
        assert.equal(connected.state, 'ready'); assert.equal(connected.tenant, 'pending'); assert.equal(connected.awsAccountId, platform); assert.equal(connected.quickCreateUrl, null);
        assert.deepEqual(ok(await local('GET', path, undefined, b.cookie)).connection, connected);
        assert.equal(identityChecks - warmChecks, 0); assert.deepEqual(calls.slice(warmStart),[]);
        const runTenant=async(attempts=1)=>{
          const {rows:[j]}=await pool.query("SELECT * FROM jobs WHERE workspace_id=$1 AND type='tenant.provision'",[b.org.id]);
          await tenantJob(runtime,j.payload,{id:j.id,attempts,workspaceId:b.org.id});
        };
        const {MAX_ATTEMPTS}=await import('./src/jobs.js');
        failTenantOnce = true; await assert.rejects(runTenant(MAX_ATTEMPTS));
        assert.equal(ok(await local('GET', path, undefined, b.cookie)).connection.tenant,'failed','The last retry surfaces the failure instead of leaving the tenant pending forever.');
        await runTenant(); await runTenant();
        const provisioned = ok(await choose('shared',b.cookie),201); assert.equal(wakes,1,'A provisioned tenant needs no wake.'); assert.equal(provisioned.tenant,'ready');
        assert.deepEqual(calls.slice(warmStart), ['CreateTenantCommand', 'CreateTenantCommand', 'UpdateReputationEntityPolicyCommand', 'CreateTenantResourceAssociationCommand', 'CreateTenantResourceAssociationCommand']);
        const idleStart = calls.length + identityChecks;
        await reconcileSharedConnections(runtime);
        assert.equal(calls.length + identityChecks, idleStart, 'Ready pools and connections need no AWS reconciliation.');
        assert.equal(sets.size, 4); assert.equal(topics.size, 4); assert.equal(rules.size,2); assert.equal(calls.filter(n => n === 'SubscribeCommand').length, 4);
        assert.equal(identityChecks,1,'Sending and receiving pool preparation reuse the verified platform principal across regions.');
        assert.equal(calls.filter(n => n === 'CreateTenantResourceAssociationCommand').length, 4);
        const scoped = (wid: string) => ({ ...runtime, config: { ...runtime.config, workspaceId: wid, regions: [region] } });
        assert.equal((await getSes(scoped(a.org.id), region).config.credentials()).accessKeyId, platformKey.accessKeyId);
        const add = (cookie: string, name: string) => local('POST','/v1/domains',{ name,region },cookie);
        const discovery = `/v1/regions/${region}/discovery`;
        await providerTest.test('MX refuses public suffixes and reserved domain trees before reserving or contacting SES',async()=>{
          const own=new URL(runtime.config.publicUrl).hostname, start=calls.length;
          const blocked=['com','xn--p1ai',' CO.UK ','com.au','k12.ak.us','sch.uk','district.sch.uk','wixsite.com','github.io','customer.github.io','mail.vercel.app','netlify.app','onmicrosoft.com','amazonses.com','in.amazonses.com','amazonaws.com','ses.amazonaws.com',own,'in.'+own,own.split('.').slice(1).join('.')];
          for (const name of blocked) error(await add(b.cookie,name),422,'DOMAIN_NOT_ALLOWED');
          assert.equal(calls.length,start);
          assert.equal((await pool.query('SELECT 1 FROM domain_claims WHERE name=ANY($1)',[blocked.map(s=>s.trim().toLowerCase())])).rowCount,0);
          const allowed=ok(await add(b.cookie,unique('customer')+'.co.uk'),201);
          ok(await local('DELETE',`/v1/domains/${allowed.id}`,undefined,b.cookie));
        });
        await providerTest.test('MX serializes workspace claim limits across unrelated DNS names',async()=>{
          const prefix=unique('quota'),wid=b.org.id;
          await pool.query(`INSERT INTO domain_claims(name,workspace_id) SELECT $1||n||'.invalid',$2 FROM generate_series(1,9) n`,[prefix,wid]);
          const names=[prefix+'a.invalid',prefix+'b.invalid'],start=calls.length;
          try {
            const race=await Promise.all(names.map(name=>add(b.cookie,name)));
            assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);error(race.find(r=>r.status===409)!,409,'DOMAIN_LIMIT_REACHED');
            assert.deepEqual(calls.slice(start),['CreateEmailIdentityCommand']);
            const last=ok(race.find(r=>r.status===201)!,201);
            assert.equal(ok(await add(b.cookie,last.name),201).id,last.id,'Idempotent retries do not consume quota.');
            // Only one unproven claim remains; the next rejection must be the independent total limit.
            await pool.query(`UPDATE domain_claims SET ever_proven=true WHERE workspace_id=$1 AND name LIKE $2 AND name<>$3`,[wid,prefix+'%',last.name]);
            await pool.query(`INSERT INTO domain_claims(name,workspace_id,ever_proven) SELECT $1||n||'.invalid',$2,true FROM generate_series(10,99) n`,[prefix,wid]);
            error(await add(b.cookie,names.find(n=>n!==last.name)!),409,'DOMAIN_LIMIT_REACHED');
            assert.deepEqual(calls.slice(start),['CreateEmailIdentityCommand']);
            ok(await local('DELETE',`/v1/domains/${last.id}`,undefined,b.cookie));
            const replacement=ok(await add(b.cookie,names.find(n=>n!==last.name)!),201);
            ok(await local('DELETE',`/v1/domains/${replacement.id}`,undefined,b.cookie));
          } finally { await pool.query('DELETE FROM domain_claims WHERE workspace_id=$1 AND name LIKE $2',[wid,prefix+'%']); }
        });
        await providerTest.test('Domain Connect: inline cached discovery, sorted signature and workspace-bound dashboard return',async dc=>{
          const { operationJobs }=await import('./src/operations.js'), {JobDeferred}=await import('./src/jobs.js');
          const zone=`${unique('dc')}.co.uk`, name=`mail.${zone}`, providerPath='/v2/domainTemplates/providers/opensend.mx/services/mail';
          const cf='https://api.cloudflare.com/client/v4/dns/domainconnect';
          let settingsHost=cf, api=cf, sync='https://dash.cloudflare.com/domainconnect', providerId='cloudflare.com', providerName='Cloudflare', supportStatus=200, alias=false, existingMx=false;
          let deployedVersion:number|undefined;
          const requests:string[]=[];
          dc.mock.method(globalThis,'fetch',async (input:RequestInfo|URL,init?:RequestInit)=>{
            const url=new URL(String(input)); requests.push(url.href);
            if(url.origin==='https://cloudflare-dns.com') {
              const q=url.searchParams.get('name'), type=url.searchParams.get('type');
              if(type==='MX') return Response.json({Status:0,Answer:existingMx && q===name?[{name:q,type:15,data:'10 existing.invalid.'}]:[]});
              if(q===`_opensend.${name}`) return Response.json({Status:3});
              if(q===`_dmarc.${name}`) return Response.json({Status:3});
              if(q===`_dmarc.${zone}`) return Response.json({Status:0,Answer:[{name:q,type:16,data:'v=DMARC1; p=reject'}]});
              assert.equal(type,'TXT'); assert.equal(init?.redirect,'manual');
              if(q===`_domainconnect.${name}`) return Response.json({Status:3,Authority:[{name:zone,type:6,data:'ns.invalid. hostmaster.invalid. 1 2 3 4 5'}]});
              assert.equal(q,`_domainconnect.${zone}`);
              return Response.json({Status:0,Answer:[...(alias?[{name:q,type:5,data:'_domainconnect.ionos.com.'}]:[]),{name:alias?'_domainconnect.ionos.com.':q,type:16,data:JSON.stringify(settingsHost.slice(8))}]});
            }
            assert.equal(init?.redirect,'manual');
            if(url.href===`${settingsHost}/v2/${zone}/settings`) return Response.json({providerId,providerName,urlAPI:api,urlSyncUX:sync});
            assert.equal(url.href,api+providerPath); return deployedVersion ? Response.json({version:deployedVersion},{status:supportStatus}) : new Response(null,{status:supportStatus});
          });
          const created=ok(await add(b.cookie,name),201), detail=`/v1/domains/${created.id}`, setup=detail+'/dns-setup';
          dc.after(async()=>{runtime.config.domainConnect=undefined; await local('DELETE',detail,undefined,b.cookie,select(b.org.id));});
          const getSetup=async(query='')=>ok(await local('GET',setup+query,undefined,b.cookie));
          assert.equal(requests.length,0,'Domain creation does not discover the provider.');
          const expectedProvider={id:providerId,name:providerName};
          assert.deepEqual(await getSetup(),{provider:expectedProvider,groups:['sending','ownership'],applyUrl:null},'Supported provider with signing disabled.');
          assert.equal(requests.length,4,'Cold GET walks two labels, fetches settings, and checks template support inline.');
          const accountIdentity=identities.get(`${platform}:${name}`)!;
          accountIdentity.DkimAttributes={...accountIdentity.DkimAttributes,Status:'PENDING',SigningHostedZone:`dkim.${region}.amazonses.com`};
          const {rows:[vjob]}=await pool.query("SELECT * FROM jobs WHERE type='domain.verify' AND payload->>'domainId'=$1",[created.id]);
          const checkMx=async()=>{
            await pool.query("UPDATE job_schedule SET wake_not_before=now() WHERE workspace_id='domain.verify:platform'");
            await assert.rejects(operationJobs['domain.verify']!(runtime,vjob.payload,{id:vjob.id,attempts:1,workspaceId:b.org.id}),JobDeferred);
          };
          await checkMx();
          const inherited=ok(await local('GET',detail,undefined,b.cookie));
          assert.equal(inherited.dmarc.status,'reject'); assert.equal(inherited.dmarc.source,zone,'The registrable parent is not co.uk.');
          assert.ok(!inherited.dns.some((r:Json)=>r.purpose==='dmarc'));
          assert.deepEqual((await getSetup('?groups=receiving,receivingReply')).groups,['receiving'],'An empty domain needs only the MX at @.');
          existingMx=true; await checkMx();
          // Do not let this extra fixture take the next scenario's account-wide SES slot.
          await pool.query("UPDATE job_schedule SET wake_not_before=now() WHERE workspace_id='domain.verify:platform'");
          const custom=ok(await local('POST',detail+'/mail-from',{mailFromDomain:`bounce.${name}`},b.cookie));
          assert.equal(custom.dns.filter((r:Json)=>r.purpose==='mail_from' && r.name===`bounce.${name}` && r.status==='pending').length,2);
          assert.deepEqual((await getSetup('?groups=receiving,receivingReply,mailfrom')).groups,['receivingReply'],'Preserve the existing MX; a non-default MAIL FROM stays manual.');
          const manual=ok(await local('POST',detail+'/mail-from',{mailFromDomain:`email.${name}`},b.cookie));
          const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
          const {loadConfig}=await import('./src/config.js'), env={BETTER_AUTH_SECRET:'synthetic-root-'.repeat(4),PUBLIC_URL:origin};
          const pem=privateKey.export({type:'pkcs1',format:'pem'}).toString().replaceAll('\n','\\n');
          for(const invalid of [{DOMAIN_CONNECT_KEY_ID:'_dck1'},{DOMAIN_CONNECT_PRIVATE_KEY:pem},
            ...['invalid-pem',generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs1',format:'pem'}),generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'})].map(k=>({DOMAIN_CONNECT_KEY_ID:'_dck1',DOMAIN_CONNECT_PRIVATE_KEY:k.toString()}))]) {
            assert.throws(()=>loadConfig({...env,...invalid}),{code:'CONFIG_INVALID'});
          }
          runtime.config.domainConnect=loadConfig({...env,DOMAIN_CONNECT_PRIVATE_KEY:pem,DOMAIN_CONNECT_KEY_ID:'_dck1'}).domainConnect;
          const {getDashboardActor}=await import('./src/google-auth.js');
          const authStart=queries.mock.callCount(); await getDashboardActor(runtime,new Headers({cookie:b.cookie}),undefined,()=>{});
          const authQueries=queries.mock.callCount()-authStart, setupStart=queries.mock.callCount();
          const before=requests.length, offered=await getSetup(), url=new URL(offered.applyUrl), params=url.searchParams;
          const total=queries.mock.callCount()-setupStart; assert.equal(total-authQueries,1); dc.diagnostic(`GET dns-setup: ${total-authQueries} domain statement; ${total} pg round trips including dashboard auth.`);
          assert.deepEqual(offered.provider,expectedProvider); assert.deepEqual(offered.groups,['sending','ownership','receivingReply','mailfrom']);
          assert.ok(!params.has('receivingHost') && !params.has('bounceHost'),'The signed apply does not accept receiving or MAIL FROM host variables.');
          assert.equal(url.origin+url.pathname,sync+providerPath+'/apply'); assert.equal(params.get('domain'),zone); assert.equal(params.get('host'),'mail');
          assert.equal(params.get('groupId'),offered.groups.join(',')); assert.equal(params.get('key'),'_dck1'); assert.equal([...params.keys()].at(-1),'sig');
          const wire=url.search.slice(1).split('&key=')[0]!, sig=Buffer.from(params.get('sig')!,'base64');
          const sorted=new URLSearchParams(params); sorted.delete('key'); sorted.delete('sig'); sorted.sort(); assert.equal(wire,sorted.toString());
          assert.ok(verifySignature('RSA-SHA256',Buffer.from(sorted.toString()),publicKey,sig)); assert.ok(!verifySignature('RSA-SHA256',Buffer.from(wire.replace('host=mail','host=other')),publicKey,sig));
          const template=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../domain-connect/opensend.mx.mail.json',import.meta.url),'utf8'));
          const expand=(s:string)=>s.replace(/%(\w+)%/g,(_,key:string)=>{assert.ok(params.has(key));return params.get(key)!;});
          for(const record of template.records.filter((r:Json)=>offered.groups.includes(r.groupId))) {
            const host=expand(record.host), target=host==='@'?name:`${host}.${name}`;
            const type=record.type==='SPFM'?'TXT':record.type, value=record.type==='SPFM'?`v=spf1 ${record.spfRules} ~all`:expand(record.pointsTo ?? record.data);
            assert.ok(manual.dns.some((r:Json)=>r.name===target && r.type===type && r.value===value && r.priority===record.priority),`Signed ${type} at ${target} must match the manual DNS record`);
          }
          assert.deepEqual((await getSetup('?groups=ownership')).groups,['ownership']); assert.equal(requests.length,before,'Cached consent URL generation makes no outbound calls.');
          const ret=new URL(params.get('redirect_uri')!); assert.equal(ret.origin,origin); const token=params.get('state')!; assert.equal(ret.pathname.split('/').at(-1),token);
          await pool.query("UPDATE jobs SET status='completed',available_at=now()+interval '1 day' WHERE id=$1",[vjob.id]);
          error(await local('GET',setup,undefined,guest),403); assert.equal((await local('GET',ret.pathname,undefined,a.cookie)).status,303,'Invalid returns land on the domain page and change nothing.');
          assert.equal((await local('GET',ret.pathname.replace(created.id,'dom_other'),undefined,b.cookie)).status,303,'Invalid returns land on the domain page and change nothing.');
          assert.equal((await local('GET',ret.pathname+'?state=other',undefined,b.cookie)).status,303,'Invalid returns land on the domain page and change nothing.');
          const [encoded,mac]=token.split('.'), payload=JSON.parse(Buffer.from(encoded!,'base64url').toString());
          assert.equal(payload.workspaceId,b.org.id); assert.equal(payload.domainId,created.id);
          const tampered=Buffer.from(JSON.stringify({...payload,workspaceId:a.org.id})).toString('base64url')+'.'+mac;
          assert.equal((await local('GET',ret.pathname.replace(token,tampered),undefined,b.cookie)).status,303,'Invalid returns land on the domain page and change nothing.');
          // Simulate selecting a different workspace in another tab while the provider is open. B
          // is only a member there: neither that role nor that workspace authorizes the return.
          const me=ok(await local('GET','/v1/me',undefined,b.cookie)); assert.equal(payload.userId,me.id);
          const member=unique('dc-member'); await pool.query("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",[member,a.org.id,me.id]);
          dc.after(async()=>{await pool.query('DELETE FROM workspace_members WHERE id=$1',[member]);});
          assert.equal(ok(await local('GET','/v1/me',undefined,b.cookie,select(a.org.id))).role,'member');
          await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[b.org.id,me.id]);
          try {error(await local('GET',ret.pathname,undefined,b.cookie),403,'PERMISSION_DENIED'); assert.equal(ok(await local('GET','/v1/me',undefined,b.cookie)).workspaceId,a.org.id);}
          finally {await pool.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[b.org.id,me.id]);}
          assert.equal((await local('GET',ret.pathname+'?error=access_denied',undefined,b.cookie)).status,303); // Cancel does not schedule verification.
          assert.equal((await pool.query("SELECT 1 FROM jobs WHERE id=$1 AND status='completed' AND available_at>now()",[vjob.id])).rowCount,1);
          ok(await local('GET','/v1/me',undefined,b.cookie,select(a.org.id)));
          const success=await local('GET',ret.pathname,undefined,b.cookie); // No workspace header or state from Cloudflare.
          assert.equal(success.status,303,diagnostic(success)); assert.equal(success.headers.get('location'),`${origin}/domains/${created.id}`);
          assert.equal(ok(await local('GET','/v1/me',undefined,b.cookie)).workspaceId,b.org.id);
          assert.equal((await local('GET',ret.pathname+`?state=${token}`,undefined,b.cookie)).status,303,'Replays may only request the same throttled recheck.');
          // The harness runner can claim the recheck between the callback and this read. The old completed job was due tomorrow.
          assert.equal((await pool.query("SELECT 1 FROM jobs WHERE id=$1 AND workspace_id=$2 AND payload->>'domainId'=$3 AND available_at<=now() AND (status='pending' OR (status IN ('running','completed') AND attempts>0))",[vjob.id,b.org.id,created.id])).rowCount,1);
          assert.equal(ok(await local('GET',detail,undefined,b.cookie)).verified,false,'Approval never promotes sending or receiving.');
          let clock=Date.now()+601_000; dc.mock.method(Date,'now',()=>clock);
          assert.equal((await local('GET',ret.pathname,undefined,b.cookie)).status,303,'Invalid returns land on the domain page and change nothing.');
          supportStatus=503; assert.equal((await getSetup()).provider,null); const after503=requests.length;
          supportStatus=200; clock+=29_000; assert.equal((await getSetup()).applyUrl,null); assert.equal(requests.length,after503);
          clock+=2000; assert.deepEqual((await getSetup()).provider,expectedProvider,'503 recovers after 30 seconds, not five minutes.');
          clock+=301_000; supportStatus=404; const unsupported=await getSetup(); assert.equal(unsupported.provider,null); assert.equal(unsupported.applyUrl,null);
          supportStatus=200; clock+=31_000; assert.equal((await getSetup()).provider,null,'404 is a definitive negative for five minutes.');
          settingsHost='https://domainconnect.vercel.com'; api='https://vercel.com/api/domain-connect'; sync='https://vercel.com/domain-connect'; providerId='vercel.com'; providerName='Vercel';
          clock+=301_000; assert.equal(new URL((await getSetup()).applyUrl).pathname,'/domain-connect'+providerPath+'/apply');
          settingsHost=api='https://api.domainconnect.ionos.com'; sync='https://domainconnect.ionos.de/sync'; providerId='ionos.com'; providerName='IONOS'; alias=true;
          clock+=301_000; assert.equal(new URL((await getSetup()).applyUrl).origin,'https://domainconnect.ionos.de');
          api='https://unexpected.invalid'; clock+=301_000; assert.equal((await getSetup()).applyUrl,null); assert.ok(!requests.some(r=>r.startsWith(api)),'An advertised URL outside the provider allowlist is never requested.');
          api=settingsHost;
          for(const version of [1,2]) {
            deployedVersion=version; clock+=301_000;
            const signed=new URL((await getSetup()).applyUrl).searchParams;
            assert.equal(signed.get('region'),region); assert.equal(signed.get('inboundRegion'),version===2?region:null);
            assert.ok(!signed.get('groupId')!.includes('tracking'));
          }
          const {pendingGroups}=await import('./src/domain-connect.js');
          const split={...manual,region:'us-east-1',dns:manual.dns.map((r:Json)=>r.type==='MX'?{...r,value:r.purpose==='receiving'?'inbound-smtp.us-east-2.amazonaws.com':'feedback-smtp.us-east-1.amazonses.com'}:r)};
          for(const version of [1,undefined,2]) {
            const selected=pendingGroups(split,true,true,['receivingReply','mailfrom'],version);
            assert.deepEqual(selected,version===2?{groups:['receivingReply','mailfrom'],vars:{inboundRegion:'us-east-2',region:'us-east-1'}}:{groups:['mailfrom'],vars:{region:'us-east-1'}});
          }
          assert.ok(!template.records.some((r:Json)=>r.host==='_dmarc'));
        });
        // B owns a shared identity; later A connects BYO, and its discovery must skip B's claim.
        await providerTest.test('MX domains: exclusive claims, SES provenance, tenant binding and DNS proof', async dt => {
          let answer = '', lookups = 0, fault=''; const activeMx=new Set<string>();
          const policies=new Map<string,string[]>(); let dmarcQueries=0,dmarcFailure=false;
          dt.mock.method(globalThis,'fetch', async (input: RequestInfo | URL) => {
            const url = new URL(String(input)); assert.equal(url.origin + url.pathname,'https://cloudflare-dns.com/dns-query');
            if (fault===url.searchParams.get('type')+'-servfail') return Response.json({Status:2});
            if (fault===url.searchParams.get('type')+'-503') return new Response(null,{status:503});
            if (fault===url.searchParams.get('type')+'-timeout') throw new DOMException('timed out','TimeoutError');
            if(url.searchParams.get('type')==='MX') {
              const name=url.searchParams.get('name')!,host=activeMx.has(name)?`inbound-smtp.${region}.amazonaws.com`:name===domain?'existing.invalid':null;
              return Response.json({Status:0,Answer:host?[{name,type:15,data:`10 ${host}.`},...(fault==='mixed' && activeMx.has(name)?[{name,type:15,data:'20 other.invalid.'}]:[])]:[]});
            }
            assert.equal(url.searchParams.get('type'),'TXT');
            const q=url.searchParams.get('name')!;
            if(q.startsWith('_dmarc.')) {
              dmarcQueries++; const records=policies.get(q.slice(7));
              return Response.json(dmarcFailure ? {Status:2} : records ? {Status:0,Answer:records.map(data=>({name:q,type:16,data}))} : {Status:3});
            }
            lookups++; return Response.json(answer ? { Status:0, Answer:[{ name:`${url.searchParams.get('name')}.`, type:16, data:JSON.stringify(answer) }] } : {Status:3});
          });
          const before = calls.length;
          error(await local('GET',discovery,undefined,b.cookie),409,'CONNECTION_MANAGED_REGION');
          error(await local('GET','/v1/settings/ses',undefined,b.cookie),403,'SHARED_ACCOUNT_PRIVATE');
          assert.equal(calls.length,before);
          // No request reached SES, but the reservation was durable. Retry must create, not serve empty DNS.
          const recovery=`${unique('recover')}.invalid`;
          runtime.config.liveEnabled=false;
          try { error(await add(b.cookie,recovery),503,'SES_NOT_CONFIGURED'); error(await add(b.cookie,foreign),503,'SES_NOT_CONFIGURED'); }
          finally {runtime.config.liveEnabled=true;}
          assert.equal(calls.length,before);
          loseCreateResponse=true; error(await add(b.cookie,recovery),503,'SES_UNAVAILABLE');
          // The second failed request did reach SES. Recover only this claim's tagged identity.
          const restored=ok(await add(b.cookie,recovery),201);
          assert.equal(restored.dns.filter((r:Json)=>r.purpose==='sending' && r.type==='CNAME').length,3); assert.equal(restored.verified,false);
          assert.deepEqual(calls.slice(before),['CreateEmailIdentityCommand','CreateEmailIdentityCommand','GetEmailIdentityCommand']);
          ok(await local('DELETE',`/v1/domains/${restored.id}`,undefined,b.cookie));
          // A request that died before any SES call leaves a claim with no identity. The verify job it reserved owns the identity from then on.
          const {operationJobs:wedgeJobs}=await import('./src/operations.js'),{JobDeferred:Deferred}=await import('./src/jobs.js');
          const wedged=`${unique('wedge')}.invalid`,wedgeStart=calls.length;
          dropCreate=true; error(await add(b.cookie,wedged),503,'SES_UNAVAILABLE');
          const {rows:[wedge]}=await pool.query("SELECT j.*,dc.identity FROM jobs j JOIN domain_claims dc ON j.id='domain.verify:'||dc.token WHERE dc.name=$1",[wedged]);
          assert.ok(wedge && wedge.identity===null,'The reservation keeps the claim and its verify job even though SES was never called.');
          await pool.query("UPDATE job_schedule SET wake_not_before=now() WHERE workspace_id='domain.verify:platform'");
          await assert.rejects(wedgeJobs['domain.verify']!(runtime,wedge.payload,{id:wedge.id,attempts:1,workspaceId:b.org.id}),Deferred);
          assert.deepEqual(calls.slice(wedgeStart),['CreateEmailIdentityCommand','GetEmailIdentityCommand','CreateEmailIdentityCommand']);
          const unwedged=ok(await local('GET',`/v1/domains/${wedge.payload.domainId}`,undefined,b.cookie));
          assert.equal(unwedged.dns.filter((r:Json)=>r.purpose==='sending' && r.type==='CNAME').length,3); assert.ok(identities.get(`${platform}:${wedged}`));
          ok(await local('DELETE',`/v1/domains/${wedge.payload.domainId}`,undefined,b.cookie)); lookups=0;
          await pool.query("UPDATE job_schedule SET wake_not_before=now() WHERE workspace_id='domain.verify:platform'");
          const collisionStart=calls.length;
          error(await add(b.cookie,foreign),409,'DOMAIN_UNAVAILABLE');
          assert.deepEqual(calls.slice(collisionStart),['CreateEmailIdentityCommand','GetEmailIdentityCommand']);
          assert.ok(identities.has(`${platform}:${foreign}`));
          assert.equal((await pool.query('SELECT 1 FROM domain_claims WHERE name=$1',[foreign])).rowCount,0);
          const n=queries.mock.callCount(),creates=calls.length;
          const created = ok(await add(b.cookie,domain),201), proof = created.dns.find((r:Json) => r.purpose==='sending' && r.type==='TXT');
          dt.diagnostic(`POST domain: ${queries.mock.callCount()-n} pg round trips including dashboard auth`);
          assert.deepEqual(calls.slice(creates),['CreateEmailIdentityCommand']);
          assert.equal(proof.name,`_opensend.${domain}`); assert.ok(proof.value); assert.equal(created.dns.filter((r:Json)=>r.type==='CNAME' && r.purpose==='sending').length,3);
          assert.deepEqual(created.dns.find((r:Json)=>r.purpose==='receiving'),{name:domain,type:'MX',value:`inbound-smtp.${region}.amazonaws.com`,priority:10,purpose:'receiving',status:'pending'});
          assert.equal(created.verified,false); assert.equal(created.ready,false); assert.equal(lookups,0);
          assert.equal(associations.size,0);
          for (const conflict of [domain,root,`news.${domain}`]) error(await add(a.cookie,conflict),409,'DOMAIN_CLAIMED');
          const key = ok(await local('POST','/v1/api-keys',{ name:'Unrestricted fixture',permissions:['read','send'] },b.cookie),201).secret;
          const send = (from:string) => local('POST','/v1/emails/send',mail({ region,from }),undefined,{ authorization:`Bearer ${key}` });
          error(await send(`hi@sub.${domain}`),403,'SENDER_DOMAIN_NOT_VERIFIED');
          const detail = `/v1/domains/${created.id}`;
          const {operationJobs}=await import('./src/operations.js'), {JobDeferred}=await import('./src/jobs.js');
          const {rows:[job]}=await pool.query("SELECT * FROM jobs WHERE type='domain.verify' AND payload->>'domainId'=$1",[created.id]);
          const check=(poll=0)=>operationJobs['domain.verify']!(runtime,{...job.payload,poll},{id:job.id,attempts:1,workspaceId:b.org.id});
          const pace=()=>pool.query("UPDATE job_schedule SET wake_not_before=now() WHERE workspace_id='domain.verify:platform'");
          const identity=identities.get(`${platform}:${domain}`)!, dkim=identity.DkimAttributes;
          identity.DkimAttributes={...dkim,Status:'PENDING'}; answer=proof.value;
          await assert.rejects(check(40),JobDeferred); assert.equal(lookups,0,'Even a real poll must not ask for ownership TXT before DKIM succeeds.');

          const park=()=>pool.query("UPDATE jobs SET created_at=now()-interval '21 seconds',available_at=now()+interval '16 minutes',payload=payload||'{\"poll\":40}'::jsonb WHERE id=$1",[job.id]);
          await park(); const firstWake=wakes;
          ok(await local('GET',detail,undefined,undefined,{authorization:`Bearer ${key}`})); assert.equal(wakes,firstWake,'API-key reads must not nudge the runner.');
          const {getDashboardActor}=await import('./src/google-auth.js');
          const authStart=queries.mock.callCount(); await getDashboardActor(runtime,new Headers({cookie:b.cookie}),undefined,()=>{});
          const authQueries=queries.mock.callCount()-authStart;
          const readPending=()=>local('GET',detail,undefined,b.cookie), startPending=queries.mock.callCount();
          assert.equal(ok(await readPending()).verified,false); const pendingQueries=queries.mock.callCount()-startPending;
          assert.equal(pendingQueries-authQueries,1); dt.diagnostic(`GET pending domain: 1 domain statement; ${pendingQueries} pg round trips including dashboard auth.`);
          assert.equal(wakes,firstWake+1);
          const nudged=(await pool.query("SELECT payload FROM jobs WHERE id=$1 AND available_at<=now() AND payload->>'poll'='40'",[job.id])).rows[0];
          assert.ok(nudged,'Wake now without resetting the unattended backoff.');
          await pace();await assert.rejects(operationJobs['domain.verify']!(runtime,nudged.payload,{id:job.id,attempts:1,workspaceId:b.org.id}),
            e=>e instanceof JobDeferred && e.payload?.poll===40 && !e.payload.dashboard,'An early dashboard check must not advance the background poll count.');
          await Promise.all([readPending(),readPending()]); assert.equal(wakes,firstWake+1,'Reads inside the cooldown do not wake again.');
          await park(); for(const read of await Promise.all([readPending(),readPending(),readPending()])) ok(read);
          assert.equal(wakes,firstWake+2,'Racing dashboard reads share one wake per claim after the cooldown.');

          identity.DkimAttributes=dkim; answer=''; await pace();
          await assert.rejects(check(40),e=>e instanceof JobDeferred && Date.parse(e.availableAt)<=Date.now()+16_000 && e.payload?.poll===1);
          assert.equal(lookups,1,'The first DKIM success checks TXT; NXDOMAIN restarts at the short delay even after 40 polls.');
          await assert.rejects(check(),JobDeferred); assert.equal(lookups,1,'Account pacing must prevent a second SES read.');
          await pace();
          // A verified domain binds to the tenant only once the tenant job has created it; the verifier waits, never provisions.
          await pool.query("UPDATE provider_connections SET tenant_state='pending' WHERE workspace_id=$1",[b.org.id]);
          const waitStart=calls.length; answer=proof.value; await assert.rejects(check(),JobDeferred); assert.equal(ok(await local('GET',detail,undefined,b.cookie)).verified,false);
          assert.ok(!calls.slice(waitStart).some(n=>n.startsWith('CreateTenant')),'The verifier waits for the tenant job; it never provisions or binds without the tenant.');
          await pool.query("UPDATE provider_connections SET tenant_state='ready' WHERE workspace_id=$1",[b.org.id]); await pace();
          await check(); const readStart=calls.length; // Sending-only setup completes without polling SES for MX.
          await park(); const readQueries=queries.mock.callCount(), beforeVerifiedWake=wakes;
          const checked=ok(await local('GET',detail,undefined,b.cookie)); assert.equal(checked.verified,true); assert.equal(checked.ready,true);
          const verifiedQueries=queries.mock.callCount()-readQueries; assert.equal(verifiedQueries-authQueries,1); assert.equal(wakes,beforeVerifiedWake);
          dt.diagnostic(`GET verified domain: 1 domain statement; ${verifiedQueries} pg round trips including dashboard auth; no wake.`);
          const verifyQueries=queries.mock.callCount(); assert.deepEqual(ok(await local('POST',`${detail}/verify`,undefined,b.cookie)),checked);
          dt.diagnostic(`POST domain verify: ${queries.mock.callCount()-verifyQueries} pg round trips including dashboard auth`);
          assert.deepEqual(ok(await local('GET','/v1/domains',undefined,b.cookie)).data[0],checked); assert.equal(calls.length,readStart); assert.equal(lookups,3,"Two completed checks plus the one that waited for the tenant.");
          assert.ok(associations.has(`opensend-${b.org.id}:arn:aws:ses:${region}:${platform}:identity/${domain}`));
          // A verified sender on a connection whose tenant is not ready is refused at admission, never queued silently.
          await pool.query("UPDATE provider_connections SET tenant_state='failed' WHERE workspace_id=$1",[b.org.id]);
          try { error(await send(`hi@${domain}`),409,'TENANT_NOT_READY'); assert.equal((await pool.query('SELECT 1 FROM sending_emails WHERE workspace_id=$1',[b.org.id])).rowCount,0); }
          finally { await pool.query("UPDATE provider_connections SET tenant_state='ready' WHERE workspace_id=$1",[b.org.id]); }
          // Two independent connections race for the last slot. Both passed authentication before their
          // admission transactions; the waiter must see the winner's committed reservation.
          const firstWeek = runtime.config.hostedSendCaps.firstWeek;
          runtime.config.hostedSendCaps.firstWeek = 1;
          try {
            const race = await Promise.all([send(`hi@${domain}`),send(`hi@${domain}`)]);
            assert.deepEqual(race.map(r=>r.status).sort(),[202,429]);
            error(race.find(r=>r.status===429)!,429,'SEND_LIMIT_REACHED');
            await pool.query('DELETE FROM sending_emails WHERE workspace_id=$1 AND id=$2',[b.org.id,race.find(r=>r.status===202)!.body.id]);
          } finally { runtime.config.hostedSendCaps.firstWeek = firstWeek; }
          await dt.test('DMARC policies, inheritance and alignment are cached; the opt-in Hosted gate rejects only bulk',async()=>{
            const from=`bulk@${domain}`, originalMailFrom=identity.MailFromAttributes, originalFlag=runtime.config.requireDmarcForBulk;
            const inspect=async()=>ok(await local('GET',detail,undefined,b.cookie));
            const observe=async()=>{await pace();await check().catch(e=>assert.ok(e instanceof JobDeferred));return inspect();};
            const marketing=(host=domain)=>local('POST','/v1/emails/send',mail({region,from:`bulk@${host}`,kind:'marketing'}),undefined,{authorization:`Bearer ${key}`});
            const accepted=async(result:Awaited<ReturnType<typeof local>>)=>{const {id}=ok(result,202);await pool.query('DELETE FROM sending_emails WHERE workspace_id=$1 AND id=$2',[b.org.id,id]);};
            const recommended=(d:Json)=>d.dns.filter((r:Json)=>r.purpose==='dmarc').map((r:Json)=>r.value);
            try {
              const {loadConfig}=await import('./src/config.js'), env={BETTER_AUTH_SECRET:'fixture-'.repeat(6),PUBLIC_URL:origin,MULTI_TENANT:'true'};
              assert.equal(loadConfig(env).requireDmarcForBulk,false);assert.equal(loadConfig({...env,MX_REQUIRE_DMARC_FOR_BULK:'true'}).requireDmarcForBulk,true);
              assert.equal(checked.dmarc.status,'missing');assert.deepEqual(recommended(checked),['v=DMARC1; p=none']);
              await accepted(await marketing());runtime.config.requireDmarcForBulk=true;
              const count=dmarcQueries; error(await marketing(),409,'BULK_DMARC_REQUIRED');await accepted(await send(from));assert.equal(dmarcQueries,count);
              const list=ok(await local('POST','/v1/lists',{name:'DMARC fixture'},b.cookie),201);
              const draft=ok(await local('POST','/v1/campaigns',{name:'DMARC fixture',region,from,subject:'Fixture',html:'<p>Fixture</p>',audience:{listId:list.id}},b.cookie),201);
              error(await local('POST',`/v1/campaigns/${draft.id}/send`,{revision:draft.revision},b.cookie),409,'BULK_DMARC_REQUIRED');
              policies.set('invalid',['v=DMARC1; p=reject; psd=y']);const protectedSuffix=await observe();
              assert.equal(protectedSuffix.dmarc,null);assert.deepEqual(recommended(protectedSuffix),[]);policies.delete('invalid');
              policies.set(root,['"v=DMARC1; p=reject; sp=quarantine; " "aspf=s; adkim=s"']);
              identity.MailFromAttributes={MailFromDomain:`email.${domain}`,MailFromDomainStatus:'SUCCESS'};
              let d=await observe();assert.equal(d.dmarc.status,'quarantine');assert.equal(d.dmarc.source,root);assert.equal(d.dmarc.aspf,'s');
              assert.deepEqual(d.dmarc.alignment,{dkim:true,spf:false});assert.deepEqual(recommended(d),[]);await accepted(await marketing());
              error(await marketing(`sub.${domain}`),409,'BULK_DMARC_REQUIRED'); // A parent check cannot establish the exact From policy.
              policies.set(domain,['v=DMARC1; p=none']);d=await observe();assert.equal(d.dmarc.source,domain);assert.equal(d.dmarc.status,'none');assert.deepEqual(d.dmarc.alignment,{dkim:true,spf:true});await accepted(await marketing());
              policies.set(domain,['v=DMARC1; p=reject']);d=await observe();assert.equal(d.dmarc.status,'reject');assert.deepEqual(recommended(d),[]);
              const upkeep=()=>operationJobs['domain.mx']!(runtime,job.payload,{id:unique('mx'),attempts:1,workspaceId:b.org.id});
              const cached=async()=>(await pool.query("SELECT identity->'dmarc' AS policy FROM domain_claims WHERE workspace_id=$1 AND name=$2",[b.org.id,domain])).rows[0].policy;
              const lastGood=await cached();
              for(fault of ['TXT-timeout','TXT-503','TXT-servfail']) {
                await assert.rejects(upkeep(),{code:'DOMAIN_DNS_UNAVAILABLE',retryable:true});assert.deepEqual(await cached(),lastGood);await accepted(await marketing());
              }
              fault='';policies.clear();await upkeep();assert.equal((await inspect()).dmarc.status,'missing');error(await marketing(),409,'BULK_DMARC_REQUIRED');
              for(const records of [['v=DMARC1; p=bogus'],['v=DMARC1; p=none; p=reject'],['v=DMARC1; p=reject','v=DMARC1; p=none'],['v=DMARC1; p=reject; adkim=x']]) {
                policies.set(domain,records);d=await observe();assert.equal(d.dmarc.status,'invalid');assert.deepEqual(recommended(d),[]);error(await marketing(),409,'BULK_DMARC_REQUIRED');
              }
              identity.DkimAttributes={...dkim,SigningEnabled:false};policies.set(domain,['v=DMARC1; p=reject']);d=await observe();
              assert.deepEqual(d.dmarc.alignment,{dkim:false,spf:true});await accepted(await marketing());
              identity.MailFromAttributes={MailFromDomain:`email.${domain}`,MailFromDomainStatus:'FAILED'};d=await observe();assert.deepEqual(d.dmarc.alignment,{dkim:false,spf:false});error(await marketing(),409,'BULK_DMARC_REQUIRED');
              dmarcFailure=true; d=await observe();assert.equal(d.dmarc,null);assert.deepEqual(recommended(d),[]);error(await marketing(),409,'BULK_DMARC_REQUIRED');
              const staleCount=dmarcQueries;assert.equal((await inspect()).dmarc,null); assert.equal(dmarcQueries,staleCount);
            } finally {runtime.config.requireDmarcForBulk=originalFlag;policies.clear();dmarcFailure=false;fault='';identity.MailFromAttributes=originalMailFrom;identity.DkimAttributes=dkim;await observe();}
          });
          await dt.test('MX inbound routes only MX-verified customer hosts, independently of DKIM, and splits private Bcc',async it=>{
            const {acceptInboundNotification,mailboxIngestJobs}=await import('./src/mailbox-ingest.js');
            const otherHost=`${unique('receiving')}.invalid`,blind=`private@${otherHost}`,custom=`support@reply.${domain}`,dropped='drop@unknown.invalid';
            const hook=unique('hook'); // Non-routable fixture: inspect the durable snapshot, never POST externally.
            await pool.query(`INSERT INTO mailbox_webhooks(id,workspace_id,url,event_types,encrypted_secret) VALUES ($1,$2,'https://fixture.invalid/','["message.received"]','fixture')`,[hook,b.org.id]);
            it.after(async()=>{await pool.query('DELETE FROM mailbox_webhooks WHERE id=$1',[hook]);});
            const mx=checked.dns.find((r:Json)=>r.purpose==='receiving');assert.equal(mx.name,`reply.${domain}`);assert.equal(mx.priority,10);assert.equal(mx.status,'pending');assert.ok(mx.note.includes('existing.invalid') && mx.note.includes(mx.name));
            assert.equal(checked.sending,'verified');assert.equal(checked.receiving,'pending');
            const {BucketName:bucket,TopicArn:topicArn}=rules.get(region)!.Actions[0].S3Action;
            const probe=async(addr:string)=>{const id=unique('probe');return acceptInboundNotification(runtime,{topicArn,region,message:{notificationType:'Received',mail:{messageId:id},receipt:{timestamp:new Date().toISOString(),recipients:[addr],action:{type:'S3',bucketName:bucket,topicArn,objectKey:'staging/'+id}}}});};
            assert.equal(await probe(custom),0,'Sending verification cannot authorize receipt before MX.');
            // Proven ownership is enough to create addresses; nothing routes until the MX record is observed.
            const early=ok(await local('POST','/v1/inbound/addresses',{address:`early@${mx.name}`},b.cookie,{'x-opensend-environment':'live'}),201);
            assert.equal(await probe(early.address),0); ok(await local('DELETE',`/v1/inbound/addresses/${early.id}`,undefined,b.cookie,{'x-opensend-environment':'live'}));
              const mxCheck=()=>operationJobs['domain.mx']!(runtime,job.payload,{id:unique('mx'),attempts:1,workspaceId:b.org.id});
            const awsBefore=calls.length,txtBefore=lookups;
            activeMx.add(mx.name);await mxCheck();assert.equal(ok(await local('GET',detail,undefined,b.cookie)).receiving,'verified');
            assert.equal(calls.length,awsBefore);assert.equal(lookups,txtBefore,'Hourly DNS upkeep must use neither SES nor ownership TXT.');
            const stable=ok(await local('GET',detail,undefined,b.cookie));
            fault='mixed';for(let i=0;i<3;i++)await mxCheck();assert.equal(ok(await local('GET',detail,undefined,b.cookie)).receiving,'verified','Additional MX records are not proof that the verified record disappeared.');fault='';await mxCheck();
            for (fault of ['MX-timeout','MX-503','TXT-servfail','TXT-503']) {
              await pace();await assert.rejects(check(),JobDeferred);assert.deepEqual(ok(await local('GET',detail,undefined,b.cookie)),stable);
            }
            fault='MX-servfail';await assert.rejects(mxCheck(),{code:'DOMAIN_DNS_UNAVAILABLE'});assert.deepEqual(ok(await local('GET',detail,undefined,b.cookie)),stable);fault='';
            assert.equal(await probe(`support@${domain}`),0,'Verifying the suggested reply host must not activate the conflicting root MX.');
            const other=ok(await add(a.cookie,otherHost),201),otherProof=other.dns.find((r:Json)=>r.purpose==='sending' && r.type==='TXT').value;
            const identity=identities.get(`${platform}:${otherHost}`)!;identity.DkimAttributes={...identity.DkimAttributes,Status:'PENDING'};identity.VerifiedForSendingStatus=false;identity.VerificationStatus='PENDING';
            const verifyOther=()=>operationJobs['domain.verify']!(runtime,{domainId:other.id,token:otherProof},{id:unique('job'),attempts:1,workspaceId:a.org.id});
            activeMx.add(otherHost);await pace();await assert.rejects(verifyOther(),JobDeferred);assert.equal(await probe(blind),0,'Correct MX alone is not proof of ownership.');
            answer=otherProof;await pace();await assert.rejects(verifyOther(),JobDeferred);assert.equal(await probe(blind),0,'Ownership and MX cannot receive before SES verifies the identity.');
            assert.equal(ok(await local('GET',`/v1/domains/${other.id}`,undefined,a.cookie)).receiving,'pending');
            identity.VerificationStatus='SUCCESS';identity.VerifiedForSendingStatus=true;identity.DkimAttributes={...identity.DkimAttributes,Status:'SUCCESS',SigningEnabled:false};await pace();await assert.rejects(verifyOther(),JobDeferred);const receiveOnly=ok(await local('GET',`/v1/domains/${other.id}`,undefined,a.cookie));
            assert.equal(receiveOnly.sending,'pending');assert.equal(receiveOnly.receiving,'verified');assert.equal(receiveOnly.dns.find((r:Json)=>r.purpose==='receiving').status,'verified');
            // DKIM regression does not stop an established receive-only claim checking TXT and its own grace.
            identity.DkimAttributes.Status='PENDING';
            const otherState=async()=>(await pool.query('SELECT sending_state,receiving_state,receiving_lost_since IS NOT NULL AS receiving_lost FROM domain_claims WHERE name=$1',[otherHost])).rows[0];
            answer='';await pace();await assert.rejects(verifyOther(),JobDeferred);assert.equal(ok(await local('GET',`/v1/domains/${other.id}`,undefined,a.cookie)).receiving,'verified');
            assert.deepEqual(await otherState(),{sending_state:'pending',receiving_state:'lost',receiving_lost:true});
            answer=otherProof;await pace();await assert.rejects(verifyOther(),JobDeferred);assert.deepEqual(await otherState(),{sending_state:'pending',receiving_state:'active',receiving_lost:false});
            answer=proof.value;
            const sesMessageId=unique('incoming'),trace=`Received: from sender.invalid by inbound-smtp.${region}.amazonaws.com with SMTP id ${sesMessageId}\r\n for <${blind}>; Tue, 3 Nov 2026 00:00:00 +0000\r\n`;
            const body=Buffer.from(`Received: from original.invalid by sender.invalid; Tue, 3 Nov 2026 00:00:00 +0000\r\nFrom: sender@example.org\r\nTo: ${custom}\r\nMessage-ID: <${sesMessageId}@example.org>\r\nSubject: Incoming\r\nContent-Type: multipart/mixed; boundary=part\r\n\r\n--part\r\nContent-Type: text/plain\r\n\r\nMessage\r\n--part\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=file.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n/wA=\r\n--part--\r\n`);
            const raw=Buffer.concat([Buffer.from(trace),body]);objects.set(`${bucket}/staging/${sesMessageId}`,Buffer.concat([Buffer.from(`Bcc: ${blind},\r\n ${dropped}\r\nResent-Bcc: ${blind}\r\n`),raw]));
            const message={notificationType:'Received',mail:{messageId:sesMessageId,source:'sender@example.org',destination:[blind,custom,dropped],commonHeaders:{bcc:[blind]}},receipt:{timestamp:new Date().toISOString(),recipients:[blind,custom,dropped],action:{type:'S3',bucketName:bucket,topicArn,objectKey:`staging/${sesMessageId}`}}};
            const accept=()=>acceptInboundNotification(runtime,{topicArn,region,message});
            const count=queries.mock.callCount(); assert.equal(await accept(),2);it.diagnostic(`MX inbound notification: ${queries.mock.callCount()-count} pg statement(s) for 2 workspaces`);assert.equal(await accept(),0);
            const receipts=await pool.query('SELECT * FROM mail_receipts WHERE ses_message_id=$1',[sesMessageId]);assert.equal(receipts.rowCount,2);
            for(const [user,recipient,expected] of [[a,blind,raw],[b,custom,body]] as const){
              const wid=user.org.id,r=receipts.rows.find(r=>r.workspace_id===wid);assert.deepEqual(r.recipients,[recipient]);assert.ok(!JSON.stringify(r.notification).includes(blind));assert.ok(!JSON.stringify(r.notification).includes(dropped));
              const n=queries.mock.callCount();await mailboxIngestJobs['mailbox.ingest']!(runtime,{sesMessageId},{id:unique('job'),workspaceId:wid,attempts:1});it.diagnostic(`MX inbound ingest: ${queries.mock.callCount()-n} pg statements including transaction for new address, 1 attachment`);assert.equal(queries.mock.callCount()-n,5);
              const {rows:[stored]}=await pool.query('SELECT * FROM mail_messages WHERE workspace_id=$1 AND ses_message_id=$2',[wid,sesMessageId]);assert.deepEqual(stored.envelope_to,[recipient]);assert.deepEqual(stored.bcc,[]);assert.equal(stored.to[0].address,custom);assert.deepEqual(objects.get(`${bucket}/${stored.raw_key}`),expected);
              assert.equal(stored.raw_key,`workspaces/${wid}/raw/${sesMessageId}.eml`);assert.equal((await pool.query('SELECT 1 FROM mailboxes WHERE workspace_id=$1 AND address=$2 AND origin=\'auto\'',[wid,recipient])).rowCount,1);
              const {rows:[file]}=await pool.query('SELECT * FROM mail_attachments WHERE message_id=$1',[stored.id]);assert.ok(file.storage_key.startsWith(`workspaces/${wid}/att/`));assert.deepEqual(objects.get(`${bucket}/${file.storage_key}`),Buffer.from([255,0]));
              if(user===b){assert.ok(!JSON.stringify(stored.headers).includes(blind));const detail=ok(await local('GET',`/v1/inbound/messages/${stored.id}`,undefined,user.cookie,{'x-opensend-environment':'live'}));assert.ok(!JSON.stringify(detail).includes(blind));}
              const detailed=ok(await local('GET',`/v1/inbound/messages/${stored.id}?includeDelivery=true`,undefined,user.cookie,{'x-opensend-environment':'live'}));assert.deepEqual(detailed.envelopeTo,[recipient]);assert.ok(new URL(detailed.rawUrl).pathname.includes(`/workspaces/${wid}/raw/`));
            }
            message.receipt.recipients=[dropped];message.mail.messageId=unique('unmatched');message.receipt.action.objectKey='staging/'+message.mail.messageId;
            assert.equal(await accept(),0);assert.equal((await pool.query('SELECT 1 FROM mail_receipts WHERE ses_message_id=$1',[message.mail.messageId])).rowCount,0);
            message.receipt.recipients=[custom];message.receipt.timestamp='2020-01-01T00:00:00Z';assert.equal(await accept(),0,'A delayed notification predating this domain claim does not transfer old mail.');
            const deliveries=await pool.query('SELECT payload FROM mailbox_webhook_deliveries WHERE webhook_id=$1',[hook]);assert.equal(deliveries.rowCount,1);assert.ok(!JSON.stringify(deliveries.rows).includes(blind));
            const live={'x-opensend-environment':'live'},awsCount=calls.length;
            const inboundPath=`/v1/inbound/domains/${created.id}`;
            const inboundView=ok(await local('GET',inboundPath,undefined,b.cookie,live));assert.equal(inboundView.name,mx.name);assert.equal(inboundView.dns[0].name,mx.name);assert.equal(inboundView.status,'active');assert.equal(inboundView.addressCount,1);
            assert.equal(ok(await local('PATCH',inboundPath,{catchAll:'store'},b.cookie,live)).catchAll,'store');
            const policy=(await pool.query('SELECT receiving_host,catch_all FROM mailbox_domains WHERE domain_id=$1',[created.id])).rows;
            assert.deepEqual(policy,[{receiving_host:mx.name,catch_all:'store'}]);
            error(await local('POST','/v1/inbound/addresses',{address:blind},b.cookie,live),409,'MAILBOX_DOMAIN_NOT_ENABLED');
            const box=ok(await local('POST','/v1/inbound/addresses',{address:`archive@reply.${domain}`,publicAddress:`archive@${domain}`},b.cookie,live),201);
            assert.equal(calls.length,awsCount);
            const sourceBytes=new Map<string,Uint8Array>();it.mock.method(runtime.storage,'put',async(key:string,bytes:Uint8Array)=>{assert.equal((await pool.query('SELECT 1 FROM sending_attachments WHERE storage_key=$1',[key])).rowCount,1,'Reservation commits before storage upload');sourceBytes.set(key,bytes);});
            it.mock.method(runtime.storage,'get',async(key:string)=>({body:sourceBytes.get(key)!,contentType:'text/plain'}));
            failNextArchive=true;const out=ok(await local('POST','/v1/inbound/threads',{addressId:box.id,to:['outside@example.org'],subject:'archive',text:'attached',attachments:[{filename:'file.txt',contentType:'text/plain',content:Buffer.from('archive bytes').toString('base64')}]},b.cookie,live),202);
            const archive=async()=>(await pool.query('SELECT id,source_attachment_id,storage_key,bucket FROM mail_attachments WHERE message_id=$1',[out.id])).rows[0];const pending=await archive();assert.ok(pending.source_attachment_id);assert.equal((await pool.query("SELECT 1 FROM sending_attachment_links WHERE owner_type='mailbox' AND owner_id=$1",[pending.id])).rowCount,1);
            ok(await local('GET',`/v1/inbound/messages/${out.id}/attachments/${pending.id}`,undefined,b.cookie,live));const archived=await archive();assert.equal(archived.source_attachment_id,null);assert.equal(objects.get(archived.bucket+'/'+archived.storage_key)?.toString(),'archive bytes');
            await pool.query('DELETE FROM sending_emails WHERE id=$1',[out.emailId]);
            const sync=await import('./src/mailbox-send.js'),conn=await pool.connect();
            try { await conn.query('BEGIN');
              for(const {org} of [a,b]) {
                const email=unique('outbound');await conn.query(`INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,status,provider_id,snapshot,simulated) VALUES($1,$2,$3,'fixture','sender@example.org','[]','[]','[]','Fixture','delivered',$1,'{}',false)`,[email,org.id,region]);
                await conn.query(`INSERT INTO mail_messages(id,workspace_id,direction,thread_id,sender_mailbox_id,sending_email_id,status) SELECT $1,workspace_id,'outbound',thread_id,mailbox_id,$2,'queued' FROM mailbox_threads WHERE workspace_id=$3 LIMIT 1`,[unique('out'),email,org.id]);
              }
              const n=queries.mock.callCount();assert.ok(await sync.syncOutboundMessages({...runtime,db:drizzle(conn)})>=2);assert.equal(queries.mock.callCount()-n,1);
              for(const {org} of [a,b]) assert.deepEqual((await conn.query("SELECT type FROM mailbox_events WHERE workspace_id=$1 AND type IN ('message.sent','message.delivered') ORDER BY seq",[org.id])).rows.map(r=>r.type),['message.sent','message.delivered']);
            } finally {await conn.query('ROLLBACK');conn.release();}
            // A missing proof opens a grace period (`lost`) instead of revoking: the API and routing are unchanged,
            // a positive answer closes it, and only an expired grace revokes.
            const claimState=async()=>(await pool.query('SELECT sending_state,receiving_state,receiving_host,lost_since IS NOT NULL AS lost,receiving_lost_since IS NOT NULL AS receiving_lost FROM domain_claims WHERE name=$1',[domain])).rows[0];
            const expireGrace=()=>pool.query("UPDATE domain_claims SET lost_since=lost_since-interval '3 hours',receiving_lost_since=receiving_lost_since-interval '3 hours' WHERE name=$1",[domain]);
            const steady={sending_state:'verified',receiving_state:'active',receiving_host:mx.name,lost:false,receiving_lost:false};
            assert.deepEqual(await claimState(),steady);
            answer='';for(let i=0;i<2;i++){await pace();await assert.rejects(check(),JobDeferred);assert.deepEqual(ok(await local('GET',detail,undefined,b.cookie)),stable);}
            assert.deepEqual(await claimState(),{...steady,sending_state:'lost',lost:true},'Receiving is held by the same grace as the ownership it depends on.');
            assert.equal(await probe(custom),1,'Routing continues through the grace period.');
            await pool.query("WITH gone AS (DELETE FROM mail_receipts WHERE workspace_id=$1 AND ses_message_id LIKE 'probe-%' RETURNING ses_message_id) DELETE FROM jobs USING gone WHERE jobs.workspace_id=$1 AND jobs.type='mailbox.ingest' AND jobs.payload->>'sesMessageId'=gone.ses_message_id",[b.org.id]);
            answer=proof.value;await pace();await check();assert.deepEqual(await claimState(),steady);
            answer='';await pace();await assert.rejects(check(),JobDeferred);assert.deepEqual(ok(await local('GET',detail,undefined,b.cookie)),stable);
            await expireGrace();await pace();await assert.rejects(check(),JobDeferred);
            const revoked=ok(await local('GET',detail,undefined,b.cookie));assert.equal(revoked.sending,'pending');assert.equal(revoked.receiving,'pending');
            assert.deepEqual(await claimState(),{sending_state:'pending',receiving_state:'off',receiving_host:null,lost:false,receiving_lost:false});
            await it.test('Hourly expiry frees never-proven claims and their jobs, not foreign identities or formerly proven claims',async()=>{
              const {cleanup}=await import('./src/maintenance.js');
              const create=async()=>ok(await add(b.cookie,unique('expiry')+'.invalid'),201);
              const expired=await create(),foreignTag=await create(),recent=await create();
              const getToken=(x:Json)=>x.dns.find((d:Json)=>d.name==='_opensend.'+x.name).value;
              const token=getToken(expired);
              identities.get(`${platform}:${foreignTag.name}`)!.Tags=[{Key:'opensend:domain-claim',Value:randomUUID()}];
              await pool.query("UPDATE domain_claims SET created_at=now()-interval '73 hours' WHERE name=ANY($1)",[[expired.name,foreignTag.name,domain]]);
              await pool.query("UPDATE domain_claims SET created_at=now()-interval '71 hours' WHERE name=$1",[recent.name]);
              await pool.query("UPDATE jobs SET status='running',lease_until=now()+interval '1 hour' WHERE id=$1",['domain.verify:'+token]);
              await pool.query("INSERT INTO jobs(id,type,workspace_id,payload,available_at) VALUES ($1,'domain.mx',$2,'{}',now()+interval '1 hour')",['domain.mx:'+token,b.org.id]);
              const start=calls.length;
              await operationJobs['domain.verify']!(runtime,{domainId:expired.id,token},{id:'domain.verify:'+token,attempts:1,workspaceId:b.org.id});
              error(await add(b.cookie,expired.name),409,'DOMAIN_CLAIM_EXPIRED');
              assert.equal(calls.length,start,'Expired polls and retries stop before consuming a shared SES slot.');
              await cleanup(runtime);
              assert.deepEqual((await pool.query('SELECT name FROM domain_claims WHERE name=ANY($1) ORDER BY name',[[expired.name,foreignTag.name,recent.name,domain]])).rows.map(r=>r.name),[recent.name,domain].sort());
              assert.equal((await pool.query('SELECT 1 FROM jobs WHERE id=ANY($1)',[['domain.verify:'+token,'domain.mx:'+token]])).rowCount,0);
              error(await local('GET',`/v1/domains/${expired.id}`,undefined,b.cookie),404);
              assert.ok(!identities.has(`${platform}:${expired.name}`));
              for (const name of [domain,recent.name,foreignTag.name]) assert.ok(identities.has(`${platform}:${name}`));
              // Drive the unattended schedule with a poll count already in the old 24-hour backoff.
              // TXT appears just after the hour-71 poll, while SES still reports pending DKIM.
              const recentIdentity=identities.get(`${platform}:${recent.name}`)!;recentIdentity.DkimAttributes={...recentIdentity.DkimAttributes,Status:'PENDING'};
              const recentToken=getToken(recent),recentCheck=(poll:number)=>operationJobs['domain.verify']!(runtime,{domainId:recent.id,token:recentToken,poll},{id:'domain.verify:'+recentToken,attempts:1,workspaceId:b.org.id});
              const age=async(seconds:number)=>(await pool.query("UPDATE domain_claims SET created_at=clock_timestamp()-$2*interval '1 second' WHERE token=$1 RETURNING created_at+interval '72 hours' AS deadline",[recentToken,seconds])).rows[0].deadline.getTime();
              answer='';await age(70*3600+900);await pace();const startPoll=Date.now();
              await assert.rejects(recentCheck(84),e=>e instanceof JobDeferred && e.payload?.poll===85 && Date.parse(e.availableAt)>=startPoll+3600_000 && Date.parse(e.availableAt)<=Date.now()+3600_000);
              const expires=await age(71*3600+900);await pace();
              await assert.rejects(recentCheck(85),e=>e instanceof JobDeferred && e.payload?.poll===86 && Date.parse(e.availableAt)===expires-30_000);
              answer=recentToken;await age(72*3600-30);await pace();await assert.rejects(recentCheck(86),JobDeferred);
              await pool.query("UPDATE domain_claims SET created_at=now()-interval '73 hours' WHERE name=$1",[recent.name]);
              await cleanup(runtime);assert.ok(identities.has(`${platform}:${recent.name}`));
              assert.equal(ok(await local('GET',`/v1/domains/${recent.id}`,undefined,b.cookie)).sending,'pending');answer='';
              const reclaimed=ok(await add(a.cookie,expired.name),201);assert.notEqual(getToken(reclaimed),token);
              ok(await local('DELETE',`/v1/domains/${reclaimed.id}`,undefined,a.cookie));
              ok(await local('DELETE',`/v1/domains/${recent.id}`,undefined,b.cookie));
            });
            assert.equal(await probe(custom),0);await mxCheck();assert.equal(await probe(custom),0,'Hourly MX alone cannot re-authorize lost ownership.');
            answer=proof.value;await pace();await check();assert.deepEqual(await claimState(),steady);
            activeMx.delete(mx.name);await mxCheck();await mxCheck();assert.equal(ok(await local('GET',detail,undefined,b.cookie)).receiving,'verified');
            activeMx.add(mx.name);await mxCheck();assert.deepEqual(await claimState(),steady);
            activeMx.delete(mx.name);await mxCheck();assert.deepEqual(await claimState(),{...steady,receiving_state:'lost',receiving_lost:true},'An MX grace is tracked on its own side.');assert.equal(ok(await local('GET',detail,undefined,b.cookie)).receiving,'verified');
            await expireGrace();await mxCheck();assert.equal(await probe(custom),0,'An expired MX grace revokes routing while sending stays verified.');
            assert.deepEqual(await claimState(),{...steady,receiving_state:'pending',receiving_host:null});
            assert.equal(ok(await local('GET',detail,undefined,b.cookie)).sending,'verified');
            await it.test('Hourly DNS upkeep covers 2,501 active claims within 12 rounds in bounded pages',async()=>{
              const {refreshMailboxDns,mailboxSetupJobs}=await import('./src/mailbox-setup.js'),{sql}=await import('drizzle-orm');
              const abort=new Error('rollback scheduled fixtures');await assert.rejects(runtime.db.transaction(async tx=>{
                const rt={...runtime,db:tx},type='maintenance.domainDns';
                await tx.execute(sql`INSERT INTO domain_claims(workspace_id,name,connection_id,sending_state,identity)
                  SELECT workspace_id,'rotate-'||n||'.invalid',connection_id,'verified','{}'::jsonb FROM domain_claims CROSS JOIN generate_series(1,2501) n WHERE workspace_id=${b.org.id} AND name=${domain}`);
                await tx.execute(sql`INSERT INTO operation_domains(id,workspace_id,name,region) SELECT 'rotate-'||name,workspace_id,name,${region} FROM domain_claims WHERE workspace_id=${b.org.id} AND name LIKE 'rotate-%.invalid'`);
                for(let hour=0;hour<12;hour++) {
                  await refreshMailboxDns(rt);
                  const sweep=(await tx.execute<{status:string;payload:Json}>(sql`SELECT status,payload FROM jobs WHERE id=${type}`)).rows[0]!;
                  assert.equal(sweep.status,'pending');assert.deepEqual(sweep.payload,{});
                  let payload=sweep.payload,scheduled=0;
                  for(let step=0;;step++) {
                    assert.ok(step<6,'Cursor must advance through the binding index.');
                    let next:Json|undefined;
                    try {await mailboxSetupJobs[type]!(rt,payload,{id:type,attempts:1,workspaceId:rt.config.workspaceId});}
                    catch(e) {if(!(e instanceof JobDeferred))throw e;next=e.payload;assert.ok(next?.after);}
                    const count=(await tx.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM jobs WHERE type='domain.mx' AND status='pending'`)).rows[0]!.n;
                    assert.ok(count-scheduled<=50,'One step can enqueue at most 50 DNS checks.');scheduled=count;
                    if(!next) break;
                    assert.notEqual(next.after,payload.after);payload=next;
                  }
                  assert.ok(scheduled>50,'Work increases with the claim population.');
                  assert.ok((await tx.execute(sql`SELECT 1 FROM jobs WHERE type='domain.mx' AND status='pending' AND available_at>now() AND available_at<now()+interval '1 hour' LIMIT 1`)).rowCount);
                  // Simulate successful jobs and an hourly tick, without external DNS or wall-clock sleeps.
                  await tx.execute(sql`UPDATE jobs SET status='completed' WHERE type IN (${type},'domain.mx')`);
                  await refreshMailboxDns(rt);assert.equal((await tx.execute(sql`SELECT 1 FROM jobs WHERE id=${type} AND status='completed'`)).rowCount,1,'Duplicate tick cannot restart the sweep.');
                  await tx.execute(sql`UPDATE jobs SET created_at=created_at-interval '1 hour' WHERE type IN (${type},'domain.mx')`);
                  await tx.execute(sql`UPDATE domain_claims SET created_at=created_at-interval '1 hour' WHERE workspace_id=${b.org.id} AND name LIKE 'rotate-%.invalid'`);
                }
                assert.equal((await tx.execute(sql`SELECT 1 FROM jobs WHERE type='domain.mx' AND payload->>'domainId' LIKE 'rotate-%'`)).rowCount,2501);
                throw abort;
              }),e=>e===abort);
            });
            ok(await local('DELETE',`/v1/domains/${other.id}`,undefined,a.cookie));
          });
          error(await send(`hi@not${domain}`),403,'SENDER_DOMAIN_NOT_VERIFIED');
          await pool.query("UPDATE jobs SET status='running',lease_until=now()+interval '3 minutes' WHERE id=$1",[job.id]);
          const configured = ok(await local('POST',`${detail}/mail-from`,{ mailFromDomain:`bounce.${domain}` },b.cookie));
          assert.ok(configured.dns.some((r:Json) => r.type==='MX')); assert.ok(configured.dns.some((r:Json) => r.value===proof.value));
          assert.equal(configured.ready,true); assert.equal(configured.mailFromStatus,'PENDING');
          assert.notEqual((await pool.query('SELECT status FROM jobs WHERE id=$1',[job.id])).rows[0].status,'running','The old running poll cannot complete the new MAIL FROM check.');
          assert.equal(ok(await add(b.cookie,domain),201).id,created.id,'The creating claim can resume safely.');
          error(await local('DELETE',detail,undefined,a.cookie),404);
          await pool.query("UPDATE jobs SET status='pending',available_at=now()+interval '1 hour' WHERE id=$1",[job.id]);
          ok(await local('DELETE',detail,undefined,b.cookie)); assert.ok(!identities.has(`${platform}:${domain}`)); error(await local('GET',detail,undefined,b.cookie),404);
          assert.equal((await pool.query('SELECT 1 FROM jobs WHERE id=$1',[job.id])).rowCount,0);
          const reclaimed=ok(await add(a.cookie,domain),201); assert.notEqual(reclaimed.dns.find((r:Json)=>r.purpose==='sending' && r.type==='TXT').value,proof.value);
          await check(); assert.equal(ok(await local('GET',`/v1/domains/${reclaimed.id}`,undefined,a.cookie)).verified,false);
          ok(await local('DELETE',`/v1/domains/${reclaimed.id}`,undefined,a.cookie));
          const race = `${unique('race')}.invalid`;
          const raced = await Promise.all([add(a.cookie,race),add(b.cookie,`child.${race}`)]);
          assert.deepEqual(raced.map(r => r.status).sort(),[201,409]); error(raced.find(r => r.status===409)!,409,'DOMAIN_CLAIMED');
          const i=raced.findIndex(r=>r.status===201); ok(await local('DELETE',`/v1/domains/${ok(raced[i]!,201).id}`,undefined,[a,b][i]!.cookie));
        });
        for (const user of [a,b]) ok(await local('DELETE', path, undefined, user.cookie));
        runtime.config.byoTemplateUrl = 'https://synthetic-template.s3.us-east-2.amazonaws.com/byo/v4.yaml';
        runtime.config.byoV2=true; // Global rollout alone must not change the existing dashboard signup.
        const [ac, bc] = await Promise.all([choose('byo', a.cookie), choose('byo', b.cookie)]);
        runtime.config.byoV2=false;
        externalIds = [ac,bc].map(reply => {
          const row = ok(reply, 201); assert.equal(row.state, 'awaiting_role'); assert.equal(row.tenant, 'ready'); const params = new URLSearchParams(new URL(row.quickCreateUrl).hash.split('?')[1]);
          assert.equal(row.templateVersion,'v4');assert.equal(params.get('param_ConnectionId'),row.id);assert.equal(params.get('templateURL'), runtime.config.byoTemplateUrl); assert.equal(params.get('param_PlatformPrincipalArn'), callerArn); return params.get('param_ExternalId')!;
        });
        assert.notEqual(externalIds[0], externalIds[1]);
        await assert.rejects(pool.query('UPDATE provider_connections SET external_id=$1 WHERE workspace_id=$2', [externalIds[0], b.org.id]), { code: '23505' });
        await providerTest.test('signed stack confirmation proves the account, resumes paged identity import, and replays without mutations',async bt=>{
          const row=ok(ac,201),prefix=new URLSearchParams(new URL(row.quickCreateUrl).hash.split('?')[1]).get('param_ResourcePrefix')!;
          const arn=`arn:aws:sns:${region}:${customer}:${prefix}-feedback`, host=`https://sns.${region}.amazonaws.com/`;
          const tags=[{Key:'opensend:installation-id',Value:row.id},{Key:'opensend:purpose',Value:'ses-feedback'}];
          const sharedPrefix='opensend-mx',sharedArn=`arn:aws:sns:${region}:${platform}:${sharedPrefix}-feedback`;
          // Completed stack, not resources created by the app's role. Discovery checks tags, exact
          // policy, both destinations and the confirmed non-raw HTTPS subscription.
          const policy=topics.get(sharedArn)!.Attributes.Policy.replaceAll(platform,customer).replaceAll(sharedPrefix,prefix);
          topics.set(arn,{Attributes:{TopicArn:arn,Owner:customer,Policy:policy},Tags:tags,subs:[]});
          for(const kind of ['transactional','marketing']) sets.set(`${region}:${prefix}-${kind}`,{Tags:tags,SendingOptions:{SendingEnabled:true},destinations:[{...sets.get(`${region}:${sharedPrefix}-${kind}`)!.destinations[0],Name:prefix+'-events',SnsDestination:{TopicArn:arn}}]});
          identities.set(`${customer}:${imported}`,{...verifiedIdentity,DkimAttributes:{SigningAttributesOrigin:'EXTERNAL',SigningEnabled:true,Status:'SUCCESS'},MailFromAttributes:{MailFromDomain:`bounce.${imported}`,MailFromDomainStatus:'SUCCESS'}});
          identities.set(`${customer}:mail.${reserved}`,{...verifiedIdentity,DkimAttributes:{Status:'SUCCESS',SigningEnabled:false}});
          identities.set(`${customer}:${reserved}`,{...verifiedIdentity,DkimAttributes:{Status:'PENDING',SigningEnabled:true}});
          await pool.query('INSERT INTO domain_claims(name,workspace_id) VALUES($1,$2)',[reserved,b.org.id]);
          const certUrl=host+`SimpleNotificationService-${unique('fixture')}.pem`;
          const pem=(await import('node:child_process')).execFileSync('openssl',['req','-new','-x509','-key','/dev/stdin','-days','1','-subj','/CN=fixture'],{input:privateKey.export({format:'pem',type:'pkcs8'}),encoding:'utf8'});
          let confirms=0;const dns=new Map<string,string>();
          bt.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
            if(String(input)===certUrl)return new Response(pem);
            const url=new URL(String(input));if(url.hostname==='cloudflare-dns.com'){assert.equal(url.searchParams.get('type'),'TXT');const name=url.searchParams.get('name')!;return Response.json({Status:0,Answer:[{name,type:16,data:JSON.stringify(dns.get(name)??'')}]});}
            assert.equal(url.origin+'/',host);assert.equal(url.searchParams.get('TopicArn'),arn);confirms++;
            topics.get(arn)!.subs=[{TopicArn:arn,Protocol:'https',Endpoint:`${origin}/v1/events/ses`,SubscriptionArn:arn+':fixture'}];return new Response(null);
          });
          function envelope(topic:string, message?:Json){
            const values:Json=message ? {Message:JSON.stringify(message),MessageId:randomUUID(),Timestamp:new Date().toISOString(),TopicArn:topic,Type:'Notification'} : {Message:'Confirm the synthetic subscription',MessageId:randomUUID(),SubscribeURL:host+'?'+new URLSearchParams({Action:'ConfirmSubscription',TopicArn:topic,Token:'fixture'}),Timestamp:new Date().toISOString(),Token:'fixture',TopicArn:topic,Type:'SubscriptionConfirmation'};
            return {...values,SigningCertURL:certUrl,SignatureVersion:'2',Signature:Buffer.from(sign('RSA-SHA256',Buffer.from(Object.entries(values).map(([k,v])=>`${k}\n${v}\n`).join('')),privateKey)).toString('base64')};
          }
          const receive=(body:Json)=>local('POST','/v1/events/ses',body,undefined,{'content-type':'text/plain; charset=UTF-8'}), signed=envelope(arn);
          error(await receive({...signed,Type:'Notification'}),403,'SNS_TOPIC_NOT_ALLOWED');
          for(const bad of [arn.replace(region,'eu-west-1'),arn.replace(prefix,'opensend-'+ '0'.repeat(20)),arn.replace(customer,platform)])error(await receive(envelope(bad)),403,'SNS_TOPIC_NOT_ALLOWED');
          error(await receive({...signed,Message:'tampered'}),403,'SNS_INVALID_SIGNATURE');assert.equal(assumptions,0);
          error(await receive(envelope(arn.replace(customer,'333333333333'))),503,'AWS_ACCESS_DENIED');
          wrongArn=true;error(await receive(signed),409,'AWS_ACCOUNT_MISMATCH');wrongArn=false;
          laxTrust=true;error(await receive(signed),409,'EXTERNAL_ID_REQUIRED');laxTrust=false;assert.equal(confirms,0);
          assert.equal(ok(await local('GET',path,undefined,a.cookie)).connection.state,'awaiting_role');
          const original=runtime.db, start=calls.length;
          try { await original.transaction(async tx=>{
            runtime.db=tx; // Keep the separate harness runner from consuming these mocked AWS jobs.
            // Force the manual request to read awaiting_role first and lose its CAS to SNS.
            let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});holdAssume=async()=>{entered();await gate;};
            const manual=verify(a.cookie),beforeIdentity=identityChecks;await waiting;
            try {ok(await receive(signed),202);} finally {release();}assert.equal(ok(await manual).state,'provisioning');
            assert.equal(identityChecks,beforeIdentity,'AssumeRole ARN proves the account without a second STS round trip.');
            const poll=async()=>ok(await local('GET',path,undefined,a.cookie)).connection;
            assert.equal((await poll()).state,'provisioning');
            const {sql}=await import('drizzle-orm'),{JobDeferred}=await import('./src/jobs.js'),{byoVerifyJob}=await import('./src/provider-connections.js');
            const jobId='byo.verify:'+row.id;
            await tx.execute(sql`UPDATE jobs SET available_at=now()+interval '1 hour',last_error='SNS_CONFIRMATION_PENDING' WHERE id=${jobId}`);
            ok(await receive(signed),202);assert.equal(confirms,1);
            assert.equal((await tx.execute(sql`SELECT id FROM jobs WHERE id=${jobId} AND available_at<=now()`)).rowCount,1,'A replay wakes pending confirmation backoff.');
            assert.equal((await tx.execute(sql`UPDATE jobs SET status='running',attempts=1 WHERE id=${jobId} AND status='pending'`)).rowCount,1);
            const run=(payload:Json)=>byoVerifyJob(runtime,payload,{id:jobId,workspaceId:a.org.id,attempts:1});
            await tx.execute(sql`UPDATE jobs SET attempts=${MAX_ATTEMPTS} WHERE id=${jobId}`);failImportRead=true;
            try {await assert.rejects(byoVerifyJob(runtime,{connectionId:row.id},{id:jobId,workspaceId:a.org.id,attempts:MAX_ATTEMPTS}),JobDeferred);} finally {failImportRead=false;}
            assert.equal((await poll()).state,'provisioning','A transient failure at the retry limit remains recoverable.');
            await tx.execute(sql`UPDATE jobs SET attempts=1 WHERE id=${jobId}`);
            let next:Json|undefined;await assert.rejects(run({connectionId:row.id}),e=>{if(!(e instanceof JobDeferred))return false;next=e.payload;return true;});
            assert.equal(next?.cursor,'second');assert.equal((await poll()).state,'provisioning');
            await run(next!);await tx.execute(sql`UPDATE jobs SET status='completed' WHERE id=${jobId}`);
            const ready=await poll();assert.deepEqual([ready.state,ready.tenant,ready.awsAccountId,ready.importedDomains],['ready','ready',customer,3]);
            const enqueued: unknown[]=[];
            runtime.feedback={enqueue:async items=>{enqueued.push(...items);}};
            try {
              error(await receive(envelope(arn,{eventType:'Send',mail:{sendingAccountId:customer,messageId:123}})),422,'SES_INVALID_EVENT');
              error(await receive(envelope(arn,{eventType:'constructor',mail:{sendingAccountId:customer,messageId:'fixture'}})),422,'SES_UNSUPPORTED_EVENT');
              assert.equal(enqueued.length,0,'Even signed malformed feedback must not reach the queue.');
              ok(await receive(envelope(arn,{notificationType:'Rendering Failure',mail:{sendingAccountId:customer,messageId:'fixture'}})),202);
              assert.equal(enqueued.length,1);
            } finally {delete runtime.feedback;}
            const reads=calls.length,proofs=assumptions;ok(await receive(signed),202);assert.deepEqual(ok(await verify(a.cookie)),ready);
            assert.deepEqual([calls.length,assumptions,confirms],[reads,proofs,1]);
            // Exercise actual live-send admission, but roll back the queued email before any dispatcher can see it.
            const rollback=new Error('rollback queued import probe');
            await assert.rejects(tx.transaction(async save=>{
              runtime.db=save;
              const key=ok(await local('POST','/v1/api-keys',{name:'Import probe',permissions:['send']},a.cookie),201).secret;
              ok(await local('POST','/v1/emails/send',mail({region,from:`hello@${imported}`}),undefined,{authorization:`Bearer ${key}`}),202);
              const previous=runtime.config.requireDmarcForBulk;runtime.config.requireDmarcForBulk=true;
              try {ok(await local('POST','/v1/emails/send',mail({region,kind:'marketing',from:`hello@${imported}`}),undefined,{authorization:`Bearer ${key}`}),202);}
              finally {runtime.config.requireDmarcForBulk=previous;}
              for(const name of [reserved,'mail.'+reserved])error(await local('POST','/v1/emails/send',mail({region,from:`hello@${name}`}),undefined,{authorization:`Bearer ${key}`}),403,'SENDER_DOMAIN_NOT_VERIFIED');
              throw rollback;
            }),e=>e===rollback);
          }); } finally { runtime.db=original; }
          assert.ok(calls.slice(start).every(n=>/^(Get|List)/.test(n)),'No writes to customer AWS resources during verification or import.');
          const list:Json[]=ok(await local('GET','/v1/domains?refresh=false',undefined,a.cookie)).data;assert.equal(list.length,3);
          const signedDomain=list.find(x=>x.name===imported)!;
          assert.deepEqual([signedDomain.sending,signedDomain.verificationStatus,signedDomain.dkimStatus,signedDomain.mailFromDomain,signedDomain.mailFromStatus],['verified','SUCCESS','SUCCESS','bounce.'+imported,'SUCCESS']);
          assert.equal((await pool.query('SELECT workspace_id FROM domain_claims WHERE name=$1',[reserved])).rowCount,2,'An exclusive claim and an account-scoped import can have the exact same name.');
          error(await local('POST',`/v1/domains/${signedDomain.id}/mail-from`,{mailFromDomain:`another.${imported}`},a.cookie),409,'IMPORTED_IDENTITY_READ_ONLY');
          const {sql}=await import('drizzle-orm'), {operationJobs}=await import('./src/operations.js'),{JobDeferred}=await import('./src/jobs.js');
          async function canReserve(expected:boolean){
            const rollback=new Error('rollback workspace B reservations');
            await assert.rejects(runtime.db.transaction(async tx=>{
              await tx.execute(sql`UPDATE provider_connections SET state='ready',aws_account_id='333333333333',role_arn='fixture' WHERE workspace_id=${b.org.id}`);
              for(const name of [importParent,imported,'child.'+imported]) {
                const r=await tx.execute(sql`SELECT token FROM reserve_domain_claim(${b.org.id},${name},${region},${unique('dom')})`);assert.equal(!!r.rows[0]!.token,expected);
              }throw rollback;
            }),e=>e===rollback);
          }
          await canReserve(true);
          async function check(item:Json,correct:boolean){
            const proof=item.dns.find((r:Json)=>r.name==='_opensend.'+item.name);assert.equal(proof.status,'pending');
            dns.set(proof.name,correct?proof.value:'wrong');await pool.query("DELETE FROM job_schedule WHERE workspace_id='domain.verify:'||$1",[customer]);
            return operationJobs['domain.verify']!(runtime,{domainId:item.id,token:proof.value},{id:'domain.verify:'+proof.value,attempts:1,workspaceId:a.org.id});
          }
          await check(signedDomain,false);await canReserve(true);
          assert.equal((await pool.query('SELECT 1 FROM mailbox_domains WHERE workspace_id=$1 AND domain_id=$2',[a.org.id,signedDomain.id])).rowCount,0,'An unproven import is authorized only for sending.');
          await check(signedDomain,true);await canReserve(false);
          const collision=list.find(x=>x.name===reserved)!;await assert.rejects(check(collision,true),JobDeferred);
          await pool.query("DELETE FROM job_schedule WHERE workspace_id='domain.verify:'||$1",[customer]);
          const scopes=(await pool.query('SELECT name,claim_scope FROM domain_claims WHERE workspace_id=$1 AND name=ANY($2)',[a.org.id,[imported,reserved]])).rows;
          assert.deepEqual(Object.fromEntries(scopes.map(r=>[r.name,r.claim_scope])),{[imported]:'txt',[reserved]:'account'});
          ok(await local('DELETE',`/v1/domains/${collision.id}`,undefined,a.cookie));assert.ok(identities.has(`${customer}:${reserved}`));
        });
        const before = calls.length;
        error(await verify(b.cookie), 409, 'AWS_ACCOUNT_IN_USE'); assert.equal(calls.length, before, 'A duplicate customer account cannot mutate provider resources.');
        assert.equal((await getSes(scoped(a.org.id), region).config.credentials()).accessKeyId, 'synthetic-customer');
        assert.equal(ok(await local('GET','/v1/settings/ses',undefined,a.cookie)).region,region);
        identities.set(`${customer}:${foreign}`,verifiedIdentity);
        error(await add(a.cookie,foreign),409,'DOMAIN_UNAVAILABLE');
        await providerTest.test('Expiry releases an unproven BYO claim without touching its customer identity',async()=>{
          const byo=ok(await add(a.cookie,unique('byo-expiry')+'.invalid'),201),start=calls.length;
          await pool.query("UPDATE domain_claims SET created_at=now()-interval '73 hours' WHERE name=$1",[byo.name]);
          await (await import('./src/maintenance.js')).cleanup(runtime);
          assert.equal(calls.length,start);assert.ok(identities.has(`${customer}:${byo.name}`));
          error(await local('GET',`/v1/domains/${byo.id}`,undefined,a.cookie),404);
          identities.delete(`${customer}:${byo.name}`);
        });
        const byoDomain=ok(await add(a.cookie,domain),201); assert.deepEqual(byoDomain.dns.map((r:Json)=>r.purpose),['sending','sending','sending','receiving']);
        const {rows:[j]}=await pool.query("SELECT * FROM jobs WHERE type='domain.verify' AND payload->>'domainId'=$1",[byoDomain.id]);
        await providerTest.test('BYO inbound uses its assumed role and per-domain rule, never the platform catch-all',async bt=>{
          const headers={'x-opensend-environment':'live'},wid=a.org.id;
          bt.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{assert.equal(new URL(String(input)).searchParams.get('type'),'MX');return Response.json({Status:0,Answer:[{name:domain,type:15,data:`10 inbound-smtp.${region}.amazonaws.com.`}]});});
          bt.mock.method(SESClient.prototype,'send',async function(this:InstanceType<typeof SESClient>,cmd:any){
            assert.equal((await this.config.credentials()).accessKeyId,'synthetic-customer');if(cmd.constructor.name==='DescribeActiveReceiptRuleSetCommand')return {Metadata:{Name:'customer-set'},Rules:[]};
            assert.equal(cmd.constructor.name,'CreateReceiptRuleCommand');assert.equal(cmd.input.RuleSetName,'customer-set');assert.deepEqual(cmd.input.Rule.Recipients,[domain]);return {};
          });
          const oversized = unique('oversized'), mime = Buffer.from('From: sender@example.org\r\nSubject: BYO\r\n\r\nBody');
          let atHead!:()=>void, releaseHead!:()=>void;
          const reading=new Promise<void>(r=>{atHead=r;}), released=new Promise<void>(r=>{releaseHead=r;});
          let copied='', oversizedHeads=0;bt.mock.method(S3Client.prototype,'send',async function(this:InstanceType<typeof S3Client>,cmd:any){
            assert.equal((await this.config.credentials()).accessKeyId,'synthetic-customer');
            if (cmd.input.Key === `staging/${oversized}`) {
              assert.equal(cmd.constructor.name,'HeadObjectCommand','Never download an oversized staging object.');
              if (++oversizedHeads === 1) { atHead(); await released; }
              return {ContentLength:40*1024*1024+1,ETag:'"oversized"'};
            }
            if(cmd.constructor.name==='HeadObjectCommand')return {ContentLength:mime.length,ETag:'"fixture"'};
            if(cmd.constructor.name==='GetObjectCommand'){assert.equal(cmd.input.IfMatch,'"fixture"');return {Body:{transformToByteArray:async()=>mime}};}
            if(cmd.constructor.name==='CopyObjectCommand')copied=cmd.input.Key;return {};
          });
          // Verify and claim its new reconcile atomically so the separate, unmocked runner never takes it.
          const {operationJobs}=await import('./src/operations.js'),{sql}=await import('drizzle-orm');
          const scheduled=await runtime.db.transaction(async tx=>{
            await operationJobs['domain.verify']!({...runtime,db:tx},j.payload,{id:j.id,attempts:1,workspaceId:wid});
            return (await tx.execute<{id:string}>(sql`UPDATE jobs SET available_at=now()+interval '1 day' WHERE workspace_id=${wid} AND type='mailbox.reconcile' AND status='pending' RETURNING id`)).rows[0]!.id;
          });
          const getDomain=async()=>ok(await local('GET',`/v1/domains/${byoDomain.id}`,undefined,a.cookie));
          const pendingRule=await getDomain();assert.equal(pendingRule.receiving,'pending');assert.equal(pendingRule.dns.find((r:Json)=>r.purpose==='receiving').status,'verified');
          await (await import('./src/mailbox-setup.js')).mailboxSetupJobs['mailbox.reconcile']!(runtime,{region},{id:scheduled,attempts:1,workspaceId:wid});
          assert.equal((await getDomain()).receiving,'verified');
          await pool.query('DELETE FROM jobs WHERE id=$1',[scheduled]);
          const {rows:[r]}=await pool.query('SELECT bucket,topic_arn AS arn FROM mailbox_regions WHERE workspace_id=$1 AND region=$2',[wid,region]);
          const sesMessageId=unique('byo'),recipient=`byo@${domain}`,other='hidden@unclaimed.invalid';
          const {acceptInboundNotification,mailboxIngestJobs}=await import('./src/mailbox-ingest.js');
          const message={notificationType:'Received',mail:{messageId:sesMessageId},receipt:{timestamp:new Date().toISOString(),recipients:[recipient,other],action:{type:'S3',bucketName:r.bucket,topicArn:r.arn,objectKey:'staging/'+sesMessageId}}};
          const {JobDeferred}=await import('./src/jobs.js');
          assert.equal(await acceptInboundNotification(runtime,{topicArn:r.arn,region,message}),1);
          await mailboxIngestJobs['mailbox.ingest']!(runtime,{sesMessageId},{id:unique('job'),attempts:1,workspaceId:wid});
          assert.equal(copied,`workspaces/${wid}/raw/${sesMessageId}.eml`);
          const {rows:[stored]}=await pool.query('SELECT id FROM mail_messages WHERE workspace_id=$1 AND ses_message_id=$2',[wid,sesMessageId]);
          const detail=ok(await local('GET',`/v1/inbound/messages/${stored.id}?includeDelivery=true`,undefined,a.cookie,headers));assert.deepEqual(detail.envelopeTo,[recipient]);assert.match(new URL(detail.rawUrl).searchParams.get('X-Amz-Credential')!,/^synthetic-customer\//);
          message.mail.messageId=oversized;message.receipt.action.objectKey=`staging/${oversized}`;
          await runtime.db.transaction(async tx=>{
            const scoped={...runtime,db:tx};
            assert.equal(await acceptInboundNotification(scoped,{topicArn:r.arn,region,message}),1);
            const ingest=()=>mailboxIngestJobs['mailbox.ingest']!(scoped,{sesMessageId:oversized},{id:unique('job'),attempts:1,workspaceId:wid});
            const first=ingest(); await Promise.race([reading,first.then(()=>assert.fail('Expected staging metadata read'))]);
            const deferredAt=Date.now();
            try { await assert.rejects(ingest(),e=>e instanceof JobDeferred && Date.parse(e.availableAt)>=deferredAt+1_500 && Date.parse(e.availableAt)<=Date.now()+2_500); } finally {releaseHead(); await first;}
            await ingest();
            assert.equal(oversizedHeads,1,'Even a duplicate ingest job does not revisit the failed receipt.');
          });
          assert.deepEqual((await pool.query('SELECT status,error FROM mail_receipts WHERE workspace_id=$1 AND ses_message_id=$2',[wid,oversized])).rows,[{status:'failed',error:'RAW_MESSAGE_TOO_LARGE'}]);
        });
        providerTest.mock.method((await import('@aws-sdk/client-cloudwatch')).CloudWatchClient.prototype,'send',async () => ({ MetricDataResults:[] }));
        assert.equal(ok(await local('GET',discovery,undefined,a.cookie)).domains.length,4);
        const visible = ok(await local('GET','/v1/domains?refresh=false',undefined,a.cookie)).data;
        assert.deepEqual(Object.fromEntries(visible.map((r:Json)=>[r.name,r.verified])),{[domain]:true,[imported]:true,['mail.'+reserved]:false});
        await assert.rejects(getSes(scoped(b.org.id), region).config.credentials(), { code: 'CONNECTION_REQUIRED' });
        // Schedule the fixture in the future so the real background runner cannot drain it before DELETE.
        const queued = unique('fixture-mail');
        await pool.query(`INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,scheduled_at)
          VALUES ($1,$2,$3,'fixture','test@example.com','[]','[]','[]','Fixture','{}',true,now()+interval '1 day')`, [queued,a.org.id,region]);
        try { error(await local('DELETE', path, undefined, a.cookie), 409, 'CONNECTION_IN_USE'); }
        finally { await pool.query('DELETE FROM sending_emails WHERE id=$1 AND workspace_id=$2', [queued, a.org.id]); }
        // Disconnecting with a domain releases its claim instead of refusing: AWS keeps the identity, the
        // workspace keeps the name, nothing sends or routes on it, and the next connection re-proves it from scratch.
        const retained=calls.length;
        ok(await local('DELETE', path, undefined, a.cookie)); ok(await local('DELETE', path, undefined, b.cookie));
        assert.equal(calls.length,retained,'BYO identities stay in the customer account.'); assert.ok(identities.has(`${customer}:${domain}`));
        assert.deepEqual((await pool.query('SELECT name,connection_id,claim_scope FROM domain_claims WHERE workspace_id=$1 AND name=ANY($2)',[a.org.id,[imported,'mail.'+reserved]])).rows,[{name:imported,connection_id:null,claim_scope:'txt'}]);
        assert.deepEqual(ok(await local('GET', path, undefined, a.cookie)), { connection: null });
        const released=async()=>(await pool.query('SELECT connection_id,sending_state,receiving_state,receiving_host,lost_since,receiving_lost_since,identity FROM domain_claims WHERE workspace_id=$1 AND name=$2',[a.org.id,domain])).rows;
        assert.deepEqual(await released(),[{connection_id:null,sending_state:'pending',receiving_state:'off',receiving_host:null,lost_since:null,receiving_lost_since:null,identity:null}]);
        assert.equal((await pool.query('SELECT status FROM mailbox_domains WHERE domain_id=$1',[byoDomain.id])).rows[0].status,'disabled');
        assert.equal((await pool.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND type IN ('domain.verify','domain.mx') AND status='pending'",[a.org.id])).rowCount,0);
        assert.equal((await pool.query('SELECT 1 FROM operation_domains WHERE workspace_id=$1 AND name=$2',[a.org.id,domain])).rowCount,0);
        assert.deepEqual(ok(await local('GET','/v1/domains?refresh=false',undefined,a.cookie)).data,[]); error(await local('GET',`/v1/domains/${byoDomain.id}`,undefined,a.cookie),404);
        assert.deepEqual(ok(await local('GET','/v1/inbound/domains',undefined,a.cookie,{'x-opensend-environment':'live'})).data,[]);
        error(await add(a.cookie,domain),409,'CONNECTION_REQUIRED');
        ok(await choose('shared', a.cookie),201);
        const reproved=ok(await local('POST','/v1/domains',{name:domain},a.cookie),201); // Region defaults to the connection.
        assert.equal(reproved.region,region); assert.equal(reproved.verified,false); assert.equal(calls.at(-1),'CreateEmailIdentityCommand'); assert.notEqual(reproved.id,byoDomain.id);
        const reconnected=ok(await local('GET', path, undefined, a.cookie)).connection;
        assert.equal((await released())[0].connection_id,reconnected.id);
        // Disconnecting a shared connection removes its tagged pool identities so a later reconnect never meets its own ghost.
        associations.add(`opensend-${a.org.id}:arn:aws:ses:${region}:${platform}:identity/${domain}`); const sharedCalls=calls.length;
        ok(await local('DELETE', path, undefined, a.cookie));
        assert.deepEqual(calls.slice(sharedCalls),['GetEmailIdentityCommand','ListResourceTenantsCommand','DeleteTenantResourceAssociationCommand','DeleteEmailIdentityCommand']);
        assert.ok(!identities.has(`${platform}:${domain}`)); assert.equal(associations.size,[...associations].filter(k=>!k.endsWith(`:identity/${domain}`)).length);
        assert.equal((await released())[0].connection_id,null); assert.equal((await pool.query('SELECT 1 FROM operation_domains WHERE workspace_id=$1 AND name=$2',[a.org.id,domain])).rowCount,0);
        assert.deepEqual(ok(await local('GET', path, undefined, a.cookie)), { connection: null });
        // A claim left detached by an older release (domain row, no connection) can still be deleted, not 404.
        await pool.query('INSERT INTO operation_domains(id,workspace_id,name,region) VALUES ($1,$2,$3,$4)',['dom_legacy_'+unique('x'),a.org.id,domain,region]);
        const {rows:[legacy]}=await pool.query('SELECT id FROM operation_domains WHERE workspace_id=$1 AND name=$2',[a.org.id,domain]);
        ok(await local('DELETE',`/v1/domains/${legacy.id}`,undefined,a.cookie)); assert.deepEqual(await released(),[]);
        assert.equal((await pool.query('SELECT 1 FROM operation_domains WHERE workspace_id=$1 AND name=$2',[a.org.id,domain])).rowCount,0);
      });
      assert.equal(ok(await local('POST', `/v1/workspaces/invitations/${invitation.id}/accept`, undefined, guest)).workspaceId, a.org.id);
      assert.equal(ok(await local('GET', `${base}/invitations`, undefined, a.cookie)).data.length, 0);
      await login({ allowed: true, email: guestEmail, verified: true, sub: guestSub });
      const memberRegions = ok(await local('GET', '/v1/regions', undefined, guest));
      assert.ok(memberRegions.data.some((r: Json) => r.enabled && r.region === memberRegions.defaultRegion));
      for (const path of ['/v1/api-keys', '/v1/domains', '/v1/webhooks', `/v1/regions/${memberRegions.defaultRegion}/discovery`, `${base}/members`]) error(await local('GET', path, undefined, guest), 403, 'PERMISSION_DENIED');
      error(await local('PUT', `/v1/regions/${memberRegions.defaultRegion}`, { enabled: true }, guest), 403, 'PERMISSION_DENIED');
      error(await local('POST', '/v1/campaigns/nope/send', { revision: 1 }, guest), 403, 'PERMISSION_DENIED');
      const contact = ok(await local('POST', '/v1/contacts', { email: address() }, guest), 201);
      error(await local('GET', `/v1/contacts/${contact.id}`, undefined, b.cookie), 404);
      const { originAllowed } = await import('./src/sending.js');
      const queued = { workspaceId: a.org.id, actorKeyId: `user_${me.id}`, snapshot: { from: 'sender@example.com' } };
      assert.equal(await originAllowed(runtime, runtime.db, queued), true);
      assert.equal(await originAllowed(runtime, runtime.db, { ...queued, campaignId: 'campaign' }), false);
      const owner = ok(await local('GET', `${base}/members`, undefined, a.cookie)).data.find((row: Json) => row.role === 'owner');
      error(await local('DELETE', `${base}/members/${owner.id}`, undefined, a.cookie), 409, 'LAST_OWNER');
      error(await local('PATCH', `${base}/members/${owner.id}`, { role:'admin' }, a.cookie), 409, 'LAST_OWNER');
      const firstMembership = ok(await local('GET', `${base}/members`, undefined, a.cookie)).data.find((row: Json) => row.userId === me.id);
      ok(await local('DELETE', `${base}/members/${firstMembership.id}`, undefined, a.cookie));
      error(await local('GET', '/v1/me', undefined, guest), 401);
      const revoked = ok(await local('POST', `${base}/invitations`, { email: guestEmail, role:'admin' }, a.cookie), 201);
      ok(await local('DELETE', `${base}/invitations?id=${revoked.id}`, undefined, a.cookie));
      error(await local('POST', `/v1/workspaces/invitations/${revoked.id}/accept`, undefined, guest), 404);
      const rejoin = ok(await local('POST', `${base}/invitations`, { email: guestEmail, role:'member' }, a.cookie), 201);
      await login({ allowed: true, email: guestEmail, verified: true, sub: guestSub }, rejoin.acceptUrl);
      assert.equal(ok(await local('POST', `/v1/workspaces/invitations/${rejoin.id}/accept`, undefined, guest)).workspaceId, a.org.id);
      const invited = ok(await local('POST', `${base}/members`, { email: guestEmail, role:'admin' }, b.cookie), 201);
      const returning = await login({ allowed: true, email: guestEmail, verified: true, sub: guestSub });
      assert.equal(ok(await local('GET', '/v1/me', undefined, returning)).workspaceId, a.org.id, 'An unsolicited invitation must not switch an existing member into another workspace.');
      const accept = `/v1/workspaces/invitations/${invited.id}/accept`;
      error(await local('POST', accept, undefined, a.cookie), 404);
      assert.equal(ok(await local('POST', accept, undefined, guest)).workspaceId, b.org.id);
      assert.equal(ok(await local('GET', '/v1/me', undefined, guest)).role, 'admin');
      error(await local('POST', `${base}/members`, { email: address(), role:'owner' }, guest), 403, 'OWNER_REQUIRED');
      ok(await local('PATCH', base, { name: 'New name' }, guest));
      assert.equal(ok(await local('GET', '/v1/settings/workspace', undefined, b.cookie)).name, 'New name');
      assert.equal(ok(await local('GET', '/v1/me', undefined, guest, select(a.org.id))).role, 'member');
      assert.equal(ok(await local('GET', '/v1/me', undefined, guest)).workspaceId, a.org.id);
      const member = ok(await local('GET', `${base}/members`, undefined, a.cookie)).data.find((row: Json) => row.userId === me.id);
      ok(await local('PATCH', `${base}/members/${member.id}`, { role:'owner' }, a.cookie));
      // Two owners cannot concurrently demote each other and leave a workspace without an owner.
      const race = await Promise.all([local('DELETE', `${base}/members/${owner.id}`, undefined, a.cookie), local('DELETE', `${base}/members/${member.id}`, undefined, guest)]);
      assert.deepEqual(race.map(reply => reply.status).sort(), [200,409]);
      const remaining = await pool.query('SELECT user_id FROM workspace_members WHERE workspace_id = $1', [a.org.id]);
      assert.equal(remaining.rowCount, 1);
      const removed = remaining.rows[0].user_id === me.id ? a.cookie : guest;
      error(await local('GET', '/v1/me', undefined, removed, select(a.org.id)), 403, 'WORKSPACE_ACCESS_DENIED');
      assert.equal(await originAllowed(runtime, runtime.db, { ...queued, actorKeyId: `user_${removed === guest ? me.id : owner.userId}` }), false);
    });
    transport.mock.restore();
  });

  test('LIVE GOOGLE OAUTH: approved login and denied Google identity require browser verification', {
    skip: 'NOT RUN by synthetic fixtures. Manually complete real Google login and denied-identity flows with configured OAuth credentials; seeding does not verify OAuth, consent, provider claims, redirect registration, or browser cookies.',
  }, () => {});
});

describe('Hosted MCP OAuth and tools', () => {
  const resourceUrl = `${PUBLIC_ORIGIN}/mcp`;
  const writableScope = 'opensend:read opensend:manage offline_access';
  const rpcHeaders = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
  function protectOAuth(reply: Reply): Reply {
    if (reply.body && typeof reply.body === 'object') for (const [field, value] of Object.entries(reply.body)) {
      if (typeof value === 'string' && /token|secret|^url$/.test(field)) secrets.add(value);
    }
    return reply;
  }
  async function registerClient(t: TestContext, db: pg.Client, metadata: Json = {}, request = http): Promise<Reply> {
    const name = unique('acceptance-mcp-client');
    const reply = protectOAuth(await request('POST', '/api/auth/oauth2/register', undefined, {
      client_name: name, redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: writableScope, ...metadata,
    }));
    if (typeof reply.body?.client_id === 'string') cleanup(t, async () => {
      // Client-owned consents, resource links and tokens cascade; never delete another client's grants.
      await db.query('DELETE FROM oauth_client WHERE client_id = $1 AND name = $2', [reply.body.client_id, name]);
    });
    return reply;
  }
  async function oauthGrant(t: TestContext, db: pg.Client, scope = writableScope, request = http) {
    const client = ok(await registerClient(t, db, { scope }, request), 201);
    const redirectUri = 'http://127.0.0.1/callback';
    const verifier = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
    secrets.add(verifier);
    const state = unique('acceptance-mcp-state');
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      scope, state, resource: resourceUrl, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const authorization = ok(protectOAuth(await request('GET', `/api/auth/oauth2/authorize?${query}`, MANAGER, undefined, { accept: 'application/json' })));
    assert.equal(authorization.redirect, true);
    assert.equal(typeof authorization.url, 'string');
    const consentUrl = new URL(authorization.url, PUBLIC_ORIGIN);
    assert.equal(consentUrl.origin, PUBLIC_ORIGIN);
    assert.equal(consentUrl.pathname, '/mcp/consent');
    const oauthQuery = consentUrl.search.slice(1);
    secrets.add(oauthQuery);
    const approval = ok(protectOAuth(await request('POST', '/api/auth/oauth2/consent', MANAGER, { accept: true, oauth_query: oauthQuery })));
    assert.equal(typeof approval.url, 'string');
    const callback = new URL(approval.url);
    assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
    assert.equal(callback.searchParams.get('state'), state);
    const code = callback.searchParams.get('code');
    assert.ok(code, 'Approved OAuth consent must issue an authorization code.');
    secrets.add(code);
    const tokenReply = protectOAuth(await request('POST', '/api/auth/oauth2/token', undefined, new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirectUri, code, code_verifier: verifier, resource: resourceUrl,
    }).toString(), { 'content-type': 'application/x-www-form-urlencoded' }));
    const tokens = ok(tokenReply);
    assert.equal(typeof tokens.access_token, 'string');
    assert.equal(typeof tokens.refresh_token, 'string');
    assert.equal(String(tokens.token_type).toLowerCase(), 'bearer');
    const grant = await db.query('SELECT id FROM oauth_consent WHERE client_id = $1 AND user_id = $2', [client.client_id, manager!.userId]);
    assert.equal(grant.rowCount, 1);
    return { token: tokens.access_token as string, refreshToken: tokens.refresh_token as string, clientId: client.client_id as string, consentId: grant.rows[0].id as string };
  }
  async function rpc(token: string, method: string, params: Json = {}): Promise<Json> {
    const id = unique('acceptance-mcp-rpc');
    const reply = await http('POST', '/mcp', token, { jsonrpc: '2.0', id, method, params }, rpcHeaders);
    const body = ok(reply);
    assert.equal(body.jsonrpc, '2.0', diagnostic(reply));
    assert.equal(body.id, id, diagnostic(reply));
    assert.equal(body.error, undefined, diagnostic(reply));
    assert.ok(body.result && typeof body.result === 'object', diagnostic(reply));
    return body.result;
  }
  async function callTool(token: string, name: string, args: Json = {}, status = 200): Promise<Json> {
    const result = await rpc(token, 'tools/call', { name, arguments: args });
    assert.equal(result.isError, false, redact(result));
    const output = result.structuredContent;
    assert.equal(output?.status, status, redact(result));
    assert.equal(typeof output.requestId, 'string', redact(result));
    assert.ok(output.requestId, redact(result));
    assert.deepEqual(JSON.parse(result.content[0].text), output);
    return output.response;
  }

  test('hosted MCP bounds registration per peer and hour without weakening desktop redirect validation', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, request }) => {
      const register = (metadata: Json = {}, ip = '192.0.2.1') => registerClient(t, db, metadata, (m,p,k,b) => request(m,p,k,b,{'x-opensend-client-ip':ip}));
      for (const redirect of ['http://127.0.0.1/callback', 'http://localhost:49152/callback', 'http://[::1]:49152/callback']) {
        const client = ok(await register({ redirect_uris: [redirect] }), 201);
        assert.equal(client.application_type, 'native');
        assert.equal(client.token_endpoint_auth_method, 'none');
        assert.deepEqual(client.redirect_uris, [redirect]);
      }
      for (const metadata of [
        { application_type: 'web', redirect_uris: ['http://127.0.0.1/callback'] },
        { redirect_uris: ['http://example.com/callback'] },
        { redirect_uris: ['http://127.0.0.1/callback', 'https://example.com/callback'] },
        { redirect_uris: ['http://127.0.0.1.evil.example/callback'] },
        { redirect_uris: ['http://user:password@127.0.0.1/callback'] },
        { redirect_uris: ['http://127.0.0.1/callback#fragment'] },
      ]) {
        const reply = await register(metadata);
        assert.equal(reply.status, 400, diagnostic(reply));
        assert.equal(typeof reply.body.error, 'string', diagnostic(reply));
        assert.equal(reply.body.client_id, undefined, diagnostic(reply));
      }
      ok(await register(), 201); // 10th registration attempt.
      const limited = await register(); assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
      ok(await register({}, '192.0.2.2'), 201);
      await db.query("UPDATE api_request_budgets SET window_start=window_start-interval '1 hour' WHERE workspace_id=$1 AND used=11", [runtime.config.workspaceId]);
      ok(await register(), 201);
    });
  });

  test('hourly retention removes only old OAuth registrations without consent, access or refresh tokens', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, request }) => {
      const { cleanup } = await import('./src/maintenance.js');
      const ids: string[] = [];
      for (let i=0; i<5; i++) ids.push(ok(await registerClient(t,db,{},request),201).client_id);
      const [unused,fresh,consented,access,refresh] = ids;
      await db.query("UPDATE oauth_client SET created_at=now()-interval '8 days' WHERE client_id=ANY($1) AND client_id<>$2", [ids,fresh]);
      await db.query("INSERT INTO oauth_consent(id,client_id,scopes,created_at,updated_at) VALUES ($1,$1,'{}',now(),now())", [consented]);
      await db.query("INSERT INTO oauth_access_token(id,token,client_id,expires_at,created_at,scopes) VALUES ($1,$1,$1,now()+interval '1 hour',now(),'{}')", [access]);
      await db.query("INSERT INTO oauth_refresh_token(id,token,client_id,user_id,expires_at,created_at,scopes) VALUES ($1,$1,$1,$2,now()+interval '1 hour',now(),'{}')", [refresh,manager!.userId]);
      await cleanup(runtime);
      const remaining = (await db.query('SELECT client_id FROM oauth_client WHERE client_id=ANY($1)', [ids])).rows.map(row=>row.client_id);
      assert.deepEqual(remaining.sort(), ids.filter(id=>id!==unused).sort());
    });
  });

  test('hosted MCP publishes the curated task catalog and composes campaign, contact, email and temporary-token workflows', async t => {
    const db = await fixtureDatabase(t);
    const { token, consentId } = await oauthGrant(t, db);
    const initialized = await rpc(token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'acceptance', version: '1' } });
    assert.equal(initialized.protocolVersion, '2025-11-25');
    assert.equal(initialized.serverInfo.name, 'opensend');
    const catalog = await rpc(token, 'tools/list');
    assert.equal(catalog.tools.length, 56);
    assert.equal(catalog.tools.filter((tool: Json) => tool.annotations.readOnlyHint).length, 25);
    const tools = new Map<string, Json>(catalog.tools.map((tool: Json) => [tool.name, tool]));
    assert.deepEqual([...tools.keys()].sort(), [
      'archiveCampaign', 'audienceQuery', 'createAgentToken', 'deleteAttachment', 'deleteCampaign', 'deleteContact', 'deleteList', 'deleteSegment', 'deleteTemplate', 'deleteWebhook',
      'deliverCampaign', 'findCampaigns', 'findContacts', 'findDomains', 'findEmails', 'findLists', 'findSegments', 'findTemplates', 'findWebhooks', 'getAttachment', 'getCampaignStats', 'getContentGuide', 'getContext', 'getMetrics',
      'importContacts', 'importTemplateImage', 'previewCampaign', 'previewCampaignAudience', 'previewTemplate', 'publishTemplate', 'retryWebhookDelivery', 'saveCampaign', 'saveContact', 'saveList', 'saveSegment', 'saveTemplate', 'saveWebhook',
      'listInboundDomains', 'getInboundDomain', 'enableInboundDomain', 'listInboundAddresses', 'getInboundAddress', 'deleteInboundAddress', 'listInboundThreads', 'getInboundThread', 'updateInboundThread', 'listInboundMessages', 'getInboundMessage', 'listInboundEvents', 'saveInboundAddress', 'sendInboundThread',
      'saveDomain', 'sendEmail', 'setListMembers', 'testWebhook', 'uploadAttachment',
    ].sort());
    for (const tool of tools.values()) {
      assert.equal(tool.outputSchema?.type, 'object', tool.name);
      assert.equal(tool.inputSchema.properties.path, undefined, tool.name);
      assert.equal(tool.inputSchema.properties.query, undefined, tool.name);
    }
    assert.ok(!tools.has('prepareCampaign'));
    assert.doesNotMatch(JSON.stringify(tools.get('deliverCampaign')!.inputSchema), /reviewId/);
    assert.deepEqual(Object.keys(tools.get('previewCampaign')!.inputSchema.properties), ['id']);
    for (const removed of ['getDomains', 'createDomain', 'configureDomainMailFrom', 'discoverRegion', 'configureRegion', 'provisionRegion', 'listApiKeys', 'revokeApiKey', 'getWorkspaceSettings', 'updateWorkspaceSettings', 'getCampaignState']) assert.ok(!tools.has(removed), removed);
    const context = await callTool(token, 'getContext');
    assert.equal(context.environment, undefined);
    const contentGuide = await callTool(token, 'getContentGuide');
    assert.equal(contentGuide.format, 'markdown');
    assert.match(contentGuide.markdown, /campaign and template content/i);
    assert.match(contentGuide.markdown, /## Campaign personalization/);
    const template = await callTool(token, 'saveTemplate', { action: 'create', body: { name: unique('mcp-template') }, confirm: true }, 201);
    cleanup(t, async () => { ok(await http('DELETE', `/v1/templates/${template.id}`, MANAGER)); });
    assert.equal(template.published, null);
    const templateDraft = { ...template.draft, subject: 'Agent template', html: '<h1>Hello, friend</h1>' };
    const updatedTemplate = await callTool(token, 'saveTemplate', { action: 'update', id: template.id, body: { revision: template.revision, draft: templateDraft }, confirm: true });
    assert.equal(updatedTemplate.revision, 2);
    assert.equal(updatedTemplate.published, null);
    error(await http('PATCH', `/v1/templates/${template.id}`, MANAGER, { revision: 2, draft: { ...updatedTemplate.draft, html: '<h1>Hello, {{name}}</h1>' } }), 422, 'TEMPLATE_PLACEHOLDERS_UNSUPPORTED');
    assert.equal(context.origin, PUBLIC_ORIGIN);
    assert.equal(context.host, new URL(PUBLIC_ORIGIN).host);
    assert.deepEqual(context.domains, []);

    const label = unique('acceptance-mcp-contact');
    const contacts: Json[] = [];
    for (let index = 0; index < 2; index++) {
      const created = await callTool(token, 'saveContact', { action: 'create', body: { email: address(), name: label }, confirm: true, idempotencyKey: unique('mcp-contact') }, 201);
      cleanup(t, async () => { ok(await http('DELETE', `/v1/contacts/${created.id}`, MANAGER), [200, 404]); });
      contacts.push(created);
    }
    const first = await callTool(token, 'findContacts', { search: label, limit: 1 });
    assert.deepEqual(first, ok(await http('GET', `/v1/contacts?search=${encodeURIComponent(label)}&limit=1`, MANAGER)));
    assert.equal(first.data.length, 1);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await callTool(token, 'findContacts', { search: label, limit: 1, cursor: first.nextCursor });
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.data, ...second.data].map((row: Json) => row.id).sort(), contacts.map(row => row.id).sort());
    const exact = await callTool(token, 'findContacts', { id: contacts[0].id });
    assert.deepEqual(exact, { data: [ok(await http('GET', `/v1/contacts/${contacts[0].id}`, MANAGER))], nextCursor: null });
    for (const args of [{ id: contacts[0].id, search: label }, { id: contacts[0].id, limit: 1 }, { path: { id: contacts[0].id } }, { query: { search: label } }]) {
      const invalid = await rpc(token, 'tools/call', { name: 'findContacts', arguments: args });
      assert.equal(invalid.isError, true, redact(invalid));
      assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENTS', redact(invalid));
      assert.equal(invalid.structuredContent.status, null, 'Invalid input must be rejected before API dispatch.');
    }
    const noConfirmation = await rpc(token, 'tools/call', { name: 'saveContact', arguments: { action: 'update', id: contacts[0].id, body: { name: 'not authorized' } } });
    assert.equal(noConfirmation.structuredContent.error.code, 'CONFIRMATION_REQUIRED', redact(noConfirmation));
    const updated = await callTool(token, 'saveContact', { action: 'update', id: contacts[0].id, body: { name: `${label}-updated` }, confirm: true });
    assert.equal(updated.name, `${label}-updated`);
    const audienceStatement = `UPDATE contacts SET consent = 'subscribed', properties.audienceql = 'verified', properties.country = '${label.replaceAll("'", "''")}' WHERE name CONTAINS '${label.replaceAll("'", "''")}'`;
    const audiencePlan = await callTool(token, 'audienceQuery', { action: 'plan', statement: audienceStatement }, 201);
    assert.equal(audiencePlan.matched, 2);
    assert.equal(audiencePlan.requiresResubscribeConfirmation, false);
    const audienceApplied = await callTool(token, 'audienceQuery', { action: 'apply', planId: audiencePlan.id, confirm: true });
    assert.equal(audienceApplied.affected, 2);
    const audienceRows = await callTool(token, 'audienceQuery', { action: 'query', statement: `SELECT id, consent, properties.audienceql FROM contacts WHERE name CONTAINS '${label.replaceAll("'", "''")}' LIMIT 10` });
    assert.equal(audienceRows.matched, 2);
    assert.ok(audienceRows.rows.every((row: Json) => row.consent === 'subscribed' && row['properties.audienceql'] === 'verified'));
    const audienceSegment = await callTool(token, 'saveSegment', { action: 'create', body: { name: unique('audienceql-segment'), rule: { field: 'country', operator: 'eq', value: label } }, confirm: true }, 201);
    cleanup(t, async () => { ok(await http('DELETE', `/v1/segments/${audienceSegment.id}`, MANAGER), [200, 404]); });
    const segmentCount = await callTool(token, 'audienceQuery', { action: 'query', statement: `SELECT count(*) FROM contacts WHERE segment = '${audienceSegment.id}'` });
    assert.equal(segmentCount.rows[0].count, 2);
    await callTool(token, 'saveContact', { action: 'consent', id: contacts[0].id, body: { status: 'unsubscribed' }, confirm: true });
    const resubscribePlan = await callTool(token, 'audienceQuery', { action: 'plan', statement: `UPDATE contacts SET consent = 'subscribed' WHERE id = '${contacts[0].id}'` }, 201);
    assert.equal(resubscribePlan.requiresResubscribeConfirmation, true);
    const blockedResubscribe = await rpc(token, 'tools/call', { name: 'audienceQuery', arguments: { action: 'apply', planId: resubscribePlan.id, confirm: true } });
    assert.equal(blockedResubscribe.structuredContent.error.code, 'RESUBSCRIBE_CONFIRMATION_REQUIRED', redact(blockedResubscribe));
    assert.equal((await callTool(token, 'audienceQuery', { action: 'apply', planId: resubscribePlan.id, confirmResubscribe: true, confirm: true })).affected, 1);

    // The dashboard fixture is explicitly test-mode; no worker or SES delivery is needed for content reads.
    const message = mail({ text: 'Synthetic hosted MCP content snapshot.' });
    const sent = ok(await http('POST', '/v1/emails/send', MANAGER, message), 202);
    const email = await callTool(token, 'findEmails', { id: sent.id });
    assert.equal(email.data[0].id, sent.id);
    assert.equal(email.data[0].content.text, message.text);
    assert.equal(email.data[0].content.simulated, true);
    assert.ok(Array.isArray(email.data[0].events));
    const draftName = unique('mcp-name-only');
    const draftArgs = { action: 'create', body: { name: draftName }, confirm: true, idempotencyKey: unique('mcp-draft') };
    const unfinished = await callTool(token, 'saveCampaign', draftArgs, 201);
    cleanup(t, async () => { ok(await http('DELETE', `/v1/campaigns/${unfinished.id}`, MANAGER)); });
    assert.equal(unfinished.draft.name, draftName);
    assert.equal(unfinished.draft.region, ok(await http('GET', '/v1/regions', MANAGER)).defaultRegion);
    assert.equal(unfinished.draft.from, '');
    assert.equal(unfinished.draft.subject, '');
    assert.deepEqual(unfinished.draft.audience, {});
    assert.equal(unfinished.state, 'draft');
    const editorUrl = new URL(unfinished.url);
    assert.equal(editorUrl.origin, PUBLIC_ORIGIN);
    assert.equal(editorUrl.pathname, `/campaigns/${unfinished.id}/edit`);
    assert.equal(editorUrl.searchParams.get('environment'), null);
    assert.equal(editorUrl.searchParams.get('region'), null);
    assert.equal((await callTool(token, 'saveCampaign', draftArgs, 201)).id, unfinished.id);
    assert.equal((await callTool(token, 'findCampaigns', { id: unfinished.id })).data[0].url, unfinished.url);
    assert.equal((await callTool(token, 'findCampaigns', { search: draftName })).data[0].id, unfinished.id);
    const savedDraft = await callTool(token, 'saveCampaign', { action: 'update', id: unfinished.id, body: { revision: unfinished.revision, draft: { name: `${draftName}-edited` } }, confirm: true });
    assert.equal(savedDraft.draft.region, unfinished.draft.region);
    assert.equal(savedDraft.revision, 2);
    error(await http('GET', `/v1/campaigns/${unfinished.id}/audience`, MANAGER), 422, 'CAMPAIGN_INCOMPLETE');
    error(await http('POST', `/v1/campaigns/${unfinished.id}/test`, MANAGER, { to: address() }), 422, 'CAMPAIGN_RECIPIENT_INVALID');
    error(await http('POST', `/v1/campaigns/${unfinished.id}/send`, MANAGER, { revision: 2 }), 422, 'CAMPAIGN_INCOMPLETE');
    error(await http('POST', `/v1/campaigns/${unfinished.id}/send`, MANAGER, { revision: 2, reviewId: 'missing-review' }), 422, 'VALIDATION_FAILED');
    error(await http('POST', '/v1/campaigns', MANAGER, { name: '   ' }), 422, 'VALIDATION_FAILED');
    error(await http('POST', '/v1/campaigns', MANAGER, { name: draftName, from: 'invalid' }), 422, 'VALIDATION_FAILED');
    await callTool(token, 'archiveCampaign', { id: unfinished.id, body: { archived: true }, confirm: true });
    await callTool(token, 'archiveCampaign', { id: unfinished.id, body: { archived: false }, confirm: true });

    const list = await resource(t, MANAGER, '/v1/lists', { name: unique('mcp-audience') });
    const membershipPlan = await callTool(token, 'audienceQuery', { action: 'plan', statement: `ADD contacts TO LIST '${list.id}' WHERE name CONTAINS '${label.replaceAll("'", "''")}'` }, 201);
    assert.equal(membershipPlan.matched, 2);
    assert.equal((await callTool(token, 'audienceQuery', { action: 'apply', planId: membershipPlan.id, confirm: true })).affected, 2);
    assert.equal((await callTool(token, 'findLists', { id: list.id })).data[0].members.length, 2);
    const campaign = await campaignFixture(t, MANAGER, { listId: list.id }, { name: unique('mcp-campaign') });
    const summaries = await callTool(token, 'findCampaigns', { search: campaign.draft.name });
    const summary = summaries.data.find((row: Json) => row.id === campaign.id);
    assert.ok(summary);
    assert.equal(summary.draft.html, undefined);
    const detail = (await callTool(token, 'findCampaigns', { id: campaign.id })).data[0];
    assert.equal(detail.draft.html, campaign.draft.html);
    assert.equal(detail.archivedAt, null);
    const campaignPreview = await callTool(token, 'previewCampaign', { id: campaign.id });
    assert.ok(campaignPreview.html.includes(campaign.draft.html.replace(/^<p>|<\/p>$/g, '')));
    assert.equal(typeof campaignPreview.text, 'string');
    const audienceCounts = await callTool(token, 'previewCampaignAudience', { id: campaign.id });
    assert.deepEqual(audienceCounts, ok(await http('GET', `/v1/campaigns/${campaign.id}/audience`, MANAGER)));
    assert.equal(audienceCounts.matched, 2);
    assert.equal(audienceCounts.eligible + audienceCounts.suppressed + audienceCounts.unsubscribed, 2);
    cleanup(t, async () => { ok(await http('PATCH', `/v1/campaigns/${campaign.id}/archive`, MANAGER, { archived: false })); });
    const archived = await callTool(token, 'archiveCampaign', { id: campaign.id, body: { archived: true }, confirm: true });
    assert.equal(typeof archived.archivedAt, 'string');
    assert.deepEqual(archived.draft, detail.draft);
    assert.deepEqual((await callTool(token, 'findCampaigns', { search: campaign.draft.name })).data, []);
    assert.equal((await callTool(token, 'findCampaigns', { search: campaign.draft.name, archived: 'true' })).data[0].id, campaign.id);
    assert.equal((await callTool(token, 'archiveCampaign', { id: campaign.id, body: { archived: false }, confirm: true })).archivedAt, null);

    const temporary = await callTool(token, 'createAgentToken', { body: { permissions: ['read'], expiresInSeconds: 30, domains: [], purpose: 'Synthetic acceptance script' }, confirm: true }, 201);
    secrets.add(temporary.token);
    assert.equal(ok(await http('GET', '/v1/me', temporary.token)).environment, undefined);
    const [encoded, signature] = temporary.token.slice('os_agent_'.length).split('.');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const derived = Buffer.from(hkdfSync('sha256', AUTH_SECRET!, 'opensend:keys:v1', 'agent-token:v1', 32));
    const mac = (body: string, key: string | Buffer) => createHmac('sha256', key).update(`opensend-agent-token-v1:${body}`).digest('base64url');
    assert.equal(payload.v, 4); assert.ok(signature === mac(encoded, derived));
    const legacy = Buffer.from(JSON.stringify({ ...payload, v: 3 })).toString('base64url');
    ok(await http('GET', '/v1/me', `os_agent_${legacy}.${mac(legacy, AUTH_SECRET!)}`));
    for (const [body, key] of [[legacy, derived], [encoded, AUTH_SECRET!]] as const) {
      error(await http('GET', '/v1/me', `os_agent_${body}.${mac(body, key)}`), 401, 'AUTH_INVALID');
    }
    error(await http('POST', '/v1/agent-tokens', temporary.token, { permissions: ['read'], expiresInSeconds: 30, domains: [], purpose: 'Forbidden renewal' }), 403, 'MCP_AUTHORIZATION_REQUIRED');
    const managed = await callTool(token, 'createAgentToken', { body: { permissions: ['read', 'manage'], expiresInSeconds: 30, domains: [], purpose: 'Synthetic managed acceptance script' }, confirm: true }, 201);
    secrets.add(managed.token);
    const managedList = ok(await http('POST', '/v1/lists', managed.token, { name: unique('agent-managed-list') }), 201);
    ok(await http('DELETE', `/v1/lists/${managedList.id}`, managed.token));
    error(await http('GET', '/v1/api-keys', managed.token), 403, 'CREDENTIAL_DELEGATION_FORBIDDEN');
    error(await http('POST', '/v1/api-keys', managed.token, { name: 'Forbidden durable credential', permissions: ['read'], domains: [] }), 403, 'CREDENTIAL_DELEGATION_FORBIDDEN');
    const trackedTokens = page(await http('GET', '/v1/agent-tokens?includeInactive=true', MANAGER, undefined, { 'x-opensend-environment': 'live' }));
    assert.ok(trackedTokens.some(row => row.id === temporary.id && row.purpose === 'Synthetic acceptance script'));
    assert.ok(trackedTokens.some(row => row.id === managed.id && row.permissions.includes('manage')));
    ok(await http('POST', `/v1/agent-tokens/${temporary.id}/revoke`, MANAGER, undefined, { 'x-opensend-environment': 'live' }));
    error(await http('GET', '/v1/me', temporary.token), 401, 'AUTH_INVALID');
    const connections = page(await http('GET', '/v1/mcp-connections', MANAGER));
    assert.ok(connections.some(row => row.id === `mcp_${consentId}`));
    const tampered = `${temporary.token.slice(0, -1)}${temporary.token.endsWith('a') ? 'b' : 'a'}`;
    error(await http('GET', '/v1/me', tampered), 401, 'AUTH_INVALID');
    ok(await http('POST', `/v1/mcp-connections/mcp_${consentId}/revoke`, MANAGER));
    error(await http('GET', '/v1/me', managed.token), 401, 'AUTH_INVALID');
    const revokedConnection = await http('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, rpcHeaders);
    assert.equal(revokedConnection.status, 401, diagnostic(revokedConnection));
  });

  test('MX: MCP consent and queued sends respect the originating workspace and member ceiling', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, local, request, run }) => {
      Object.assign(runtime.config, { multiTenant: true, allowedDomains: [], allowedEmails: [] });
      const wid = runtime.config.workspaceId, uid = manager!.userId;
      const connection = unique('conn');
      // Simulation can use a cold connection, but must still require a verified sender claim on MX.
      await db.query("INSERT INTO provider_connections(id,workspace_id,kind,region,state) VALUES ($1,$2,'shared',$3,'ready')",[connection,wid,REGION]);
      await db.query("INSERT INTO domain_claims(name,workspace_id,connection_id) VALUES ('example.com',$1,$2)",[wid,connection]);
      error(await local('POST','/v1/emails/send',mail()),403,'SENDER_DOMAIN_NOT_VERIFIED');
      await db.query("UPDATE domain_claims SET sending_state='verified' WHERE workspace_id=$1 AND name='example.com'",[wid]);
      await db.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [wid, uid]);
      const deniedClient = ok(await registerClient(t, db, {}, request), 201);
      const query = new URLSearchParams({ response_type: 'code', client_id: deniedClient.client_id, redirect_uri: 'http://127.0.0.1/callback',
        scope: writableScope, resource: resourceUrl, state: unique('state'), code_challenge: createHash('sha256').update(randomUUID()).digest('base64url'), code_challenge_method: 'S256' });
      const denied = await request('GET', `/api/auth/oauth2/authorize?${query}`, MANAGER, undefined, { accept: 'application/json' });
      assert.equal(denied.status, 400, 'A member must not authorize manage scope.');
      assert.equal((await db.query('SELECT id FROM oauth_consent WHERE client_id=$1', [deniedClient.client_id])).rowCount, 0);
      const { token, refreshToken, clientId, consentId } = await oauthGrant(t, db, 'opensend:read opensend:send offline_access', request);
      const call = async (name: string, args: Json = {}) => ok(await local('POST','/mcp',{ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name, arguments:args } },'live',{ ...rpcHeaders, authorization:`Bearer ${token}` })).result.structuredContent;
      assert.equal((await call('getContext')).response.workspaceId, wid);
      const send = async () => {
        const reply = await call('sendEmail', { mode: 'single', body: { from: address(), to: address(), subject:'Synthetic MX', text:'Synthetic MX' }, confirm:true });
        assert.equal(reply.status, 202, redact(reply)); return reply.response.id;
      };
      const first = await send(); await run('email.dispatch');
      assert.equal((await db.query('SELECT status FROM sending_emails WHERE id=$1', [first])).rows[0].status, 'accepted');
      const oldMail = await send();
      const { reference_id: reference } = (await db.query('SELECT reference_id FROM oauth_consent WHERE id=$1', [consentId])).rows[0];
      assert.match(reference, /^mcp_v2_/);
      const oldReference = reference.replace(/^mcp_v2_/, 'mcp_');
      await db.query('UPDATE oauth_consent SET reference_id=$1 WHERE id=$2', [oldReference, consentId]);
      await db.query('UPDATE oauth_refresh_token SET reference_id=$1 WHERE client_id=$2 AND reference_id=$3', [oldReference, clientId, reference]);
      assert.equal((await request('POST', '/mcp', token, { jsonrpc:'2.0', id:1, method:'tools/list', params:{} }, rpcHeaders)).status, 401);
      const refresh = await request('POST', '/api/auth/oauth2/token', undefined, new URLSearchParams({ grant_type:'refresh_token', client_id:clientId, refresh_token:refreshToken, resource:resourceUrl }).toString(), { 'content-type':'application/x-www-form-urlencoded' });
      assert.equal(refresh.status, 400); assert.equal(refresh.body.error, 'invalid_grant');
      await run('email.dispatch');
      assert.deepEqual((await db.query('SELECT status,provider_id FROM sending_emails WHERE id=$1', [oldMail])).rows, [{status:'canceled',provider_id:null}]);
      await db.query('UPDATE oauth_consent SET reference_id=$1 WHERE id=$2', [reference, consentId]);
      const lostProof = await send(); await db.query("UPDATE domain_claims SET sending_state='failed' WHERE workspace_id=$1",[wid]); await run('email.dispatch');
      assert.equal((await db.query('SELECT status FROM sending_emails WHERE id=$1',[lostProof])).rows[0].status,'canceled','The claim must still permit sending at dispatch.');
      await db.query("UPDATE domain_claims SET sending_state='verified' WHERE workspace_id=$1",[wid]);
      const second = await send();
      await db.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2", [wid, uid]);
      assert.equal((await call('getContext')).response.role, 'member', 'An existing member grant must not grow on promotion.');
      await db.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [wid, uid]);
      await run('email.dispatch');
      assert.equal((await db.query('SELECT error_code FROM sending_emails WHERE id=$1', [second])).rows[0].error_code, 'ORIGIN_KEY_REVOKED');
    });
  });

  test('live MCP can inspect and enable receiving without forcing MX or changing other domains', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, local, jobs, request }) => {
      const manager = await oauthGrant(t, db, `${writableScope} opensend:live`, request);
      const reader = await oauthGrant(t, db, 'opensend:read opensend:live offline_access', request);
      const domain = unique('dom'), parent = unique('dom');
      const name = 'inbox.example.com';
      await db.query(`INSERT INTO operation_domains(id,workspace_id,name,region) VALUES ($1,$2,$3,$4), ($5,$2,'example.com',$4)`, [domain,runtime.config.workspaceId,name,REGION,parent]);
      runtime.config.liveEnabled = true; // SES transport is mocked below; the workspace transaction never commits.
      runtime.config.aws = { accessKeyId: 'synthetic-fixture', secretAccessKey: 'synthetic-fixture' };
      const { SESv2Client, GetEmailIdentityCommand } = await import('@aws-sdk/client-sesv2');
      let verified = false;
      const ses = t.mock.method(SESv2Client.prototype, 'send', async (command: any) => {
        assert.ok(command instanceof GetEmailIdentityCommand); assert.equal(command.input.EmailIdentity, name);
        return { VerificationStatus: verified ? 'SUCCESS' : 'PENDING' };
      });
      const rpc = async (token: string, method: string, params: Json) => ok(await local('POST','/mcp',{ jsonrpc:'2.0', id:1, method, params },'live',{ ...rpcHeaders, authorization:`Bearer ${token}` })).result;
      const call = async (name: string, args: Json) => (await rpc(manager.token,'tools/call',{ name, arguments:args })).structuredContent;
      const template = ok(await local('POST','/v1/templates',{name:'Preview scope fixture'}),201);
      ok(await local('PATCH',`/v1/templates/${template.id}`,{revision:template.revision,draft:{...template.draft,html:'<p>Scope fixture</p>'}}));
      let renders=0;
      runtime.renderHtmlImage=async()=>{renders++;return {data:Uint8Array.of(1),mimeType:'image/png'};};
      for (const [grant,visual] of [[reader,false],[manager,true]] as const) {
        const preview=await rpc(grant.token,'tools/call',{name:'previewTemplate',arguments:{id:template.id}});
        assert.equal(preview.isError,false);const body=preview.structuredContent.response;
        assert.match(body.html,/Scope fixture/);assert.equal(body.text,'Scope fixture');
        assert.equal(body.visualPreview?.mimeType,visual?'image/png':undefined);
        assert.deepEqual(preview.content.map((entry:Json)=>entry.type),visual?['text','image']:['text']);
        assert.equal(renders,visual?1:0);
      }
      const enable = (extra: Json = {}) => call('enableInboundDomain',{ id:domain, confirm:true, ...extra });
      const state = async (id: string) => (await call('getInboundDomain',{ id })).response.status;
      assert.ok(!(await rpc(reader.token,'tools/list',{})).tools.some((tool: Json) => tool.name.endsWith('InboundDomain') || tool.name === 'listInboundDomains'));
      assert.equal((await rpc(reader.token,'tools/call',{ name:'enableInboundDomain', arguments:{ id:domain,confirm:true } })).structuredContent.error.code,'TOOL_UNAVAILABLE');
      assert.deepEqual((await call('listInboundDomains',{})).response.data.map((row: Json) => row.status),['off','off']);
      assert.equal((await enable({ confirm:false })).error.code,'CONFIRMATION_REQUIRED');
      assert.equal((await enable({ body:{ force:true } })).error.code,'INVALID_ARGUMENTS');
      assert.equal(ses.mock.callCount(),0);
      assert.equal((await enable()).error.code,'DOMAIN_NOT_VERIFIED');
      verified = true;
      let mx = '10 mx.other.example.';
      const networkGuard = globalThis.fetch;
      globalThis.fetch = async input => {
        assert.equal(String(input), `https://cloudflare-dns.com/dns-query?name=${name}&type=MX`);
        return Response.json({ Status: mx ? 0 : 2, Answer: mx ? [{ name, type: 15, data: mx }] : [] });
      };
      try {
        assert.equal((await enable()).error.code,'MX_CONFLICT');
        mx = ''; assert.equal((await enable()).error.code,'MX_LOOKUP_FAILED');
        assert.equal(await state(domain),'off'); assert.equal((await jobs('mailbox.reconcile')).length,0);
        mx = `10 inbound-smtp.${REGION}.amazonaws.com.`;
        const result = await enable(); assert.equal(result.status,202); assert.equal(result.response.status,'provisioning');
        assert.equal(await state(domain),'provisioning'); assert.equal(await state(parent),'off'); assert.equal((await jobs('mailbox.reconcile')).length,1);
      } finally { globalThis.fetch = networkGuard; }
    });
  });

  test('thread-first Inbound: live MCP starts and replies; address keys see only delivered messages and safe replays', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, local, request }) => {
      const { token } = await oauthGrant(t, db, `${writableScope} opensend:live`, request);
      const { credentialFingerprint, discoveryTarget } = await import('./src/ses-region-state.js');
      const { SESv2Client, GetAccountCommand, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
      const { dispatchDue } = await import('./src/dispatcher.js');
      const { mailMessages, mailAttachments } = await import('./src/db/mailbox.js');
      const { attachToMailboxes } = await import('./src/mailbox-store.js');
      const scope = { workspaceId: runtime.config.workspaceId }, topic = `arn:aws:sns:${REGION}:111122223333:inbound-test`;
      runtime.config.liveEnabled = true; runtime.config.aws = { accessKeyId:'synthetic-fixture', secretAccessKey:'synthetic-fixture' };
      await db.query(`INSERT INTO ses_region_discovery(workspace_id,region,report,credentials_fingerprint,public_url,trusted_account_id,trusted_topic_arn) VALUES($1,$2,$3,$4,$5,'111122223333',$6)`,[scope.workspaceId,REGION,{ provisioned:true,account:{id:'111122223333',sendingEnabled:true},resources:{topic:{arn:topic},transactional:{sendingEnabled:true},marketing:{sendingEnabled:true}} },await credentialFingerprint(runtime.config),discoveryTarget(runtime.config),topic]);
      await db.query(`INSERT INTO mailbox_regions(workspace_id,region,bucket,topic_arn) VALUES($1,$2,'synthetic',$3)`,[scope.workspaceId,REGION,topic]);
      const domainId = unique('dom');
      await db.query(`INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,'example.com',$3)`, [domainId,scope.workspaceId,REGION]);
      await db.query(`INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status) VALUES($1,$2,$3,'example.com',$4,'active')`,[unique('mdom'),scope.workspaceId,domainId,REGION]);
      const sent = new Map<string, any>();
      t.mock.method(SESv2Client.prototype,'send',async (cmd:any) => {
        if (cmd instanceof GetAccountCommand) return { SendingEnabled:true, SendQuota:{ MaxSendRate:1000,Max24HourSend:10000,SentLast24Hours:0 } };
        assert.ok(cmd instanceof SendEmailCommand); const id = cmd.input.EmailTags!.find(x=>x.Name==='opensend_email_id')!.Value!;sent.set(id,cmd.input);return { MessageId:`ses-${id}` };
      });
      const base = '/v1/inbound', get = (p:string, h?:Record<string,string>) => local('GET',base+p,undefined,'live',h), post = (p:string, body:Json, h?:Record<string,string>) => local('POST',base+p,body,'live',h);
      const mcp = async (method:string, params:Json) => ok(await local('POST','/mcp',{jsonrpc:'2.0',id:unique('rpc'),method,params},'live',{ ...rpcHeaders,authorization:`Bearer ${token}` })).result;
      const tool = (name:string, args:Json) => mcp('tools/call',{name,arguments:args});
      const success = async (name:string,args:Json) => { const x=await tool(name,args);assert.equal(x.isError,false,redact(x));return x.structuredContent.response; };
      const catalog = (await mcp('tools/list',{})).tools;
      const tools = catalog.map((x:Json)=>x.name);
      const { dispatchAsActor } = await import('./src/auth.js'), { app } = await import('./src/app.js');
      for (const name of ['listInboundMessages','getInboundMessage']) {
        assert.ok(!Object.hasOwn(catalog.find((x:Json)=>x.name===name).inputSchema.properties,'includeDelivery'));
        const args = name === 'getInboundMessage' ? { messageId:'msg_probe' } : {};
        assert.equal((await tool(name,{...args,includeDelivery:'true'})).structuredContent.error.code,'INVALID_ARGUMENTS');
        const url=`${PUBLIC_ORIGIN}${base}/messages${args.messageId ? '/'+args.messageId : ''}?includeDelivery=true`;
        const denied=await dispatchAsActor(app,new Request(url),runtime,{...scope,keyId:'mcp_probe',credential:'mcp',permissions:['manage'],domains:[]});
        assert.equal(denied.status,403);assert.equal((await denied.json() as Json).error.code,'ADMIN_REQUIRED');
      }
      for (const name of ['saveInboundAddress','listInboundAddresses','getInboundAddress','listInboundThreads','getInboundThread','listInboundMessages','getInboundMessage','sendInboundThread','deleteInboundAddress']) assert.ok(tools.includes(name),name);
      for (const admin of ['createInboundKey','rotateInboundWebhookSecret','disableInboundDomain','provisionRegion']) assert.ok(!tools.includes(admin));
      const canonicalHook = ok(await post('/webhooks',{url:'https://example.com/addresses',eventTypes:['address.created','address.deleted']}),201);
      const a=await success('saveInboundAddress',{action:'create',body:{address:'support@example.com',aliases:['help@example.com'],metadata:{purpose:'support'}},confirm:true});
      const b=ok(await post('/addresses',{address:'billing@example.com'}),201);
      const updated=await success('saveInboundAddress',{action:'update',addressId:a.id,body:{displayName:'Customer support'},confirm:true});assert.deepEqual(updated.aliases,['help@example.com']);assert.deepEqual(updated.metadata,{purpose:'support'});
      assert.equal((await success('getInboundAddress',{addressId:a.id})).id,a.id);
      const domain = ok(await get(`/domains/${domainId}`));
      assert.equal(domain.addressCount,2); assert.equal(domain.catchAll,'create_address'); assert.ok(!('mailboxCount' in domain));
      assert.equal(ok(await local('PATCH',`${base}/domains/${domainId}`,{catchAll:'store'},'live')).catchAll,'store');
      assert.equal(ok(await local('PATCH',`${base}/domains/${domainId}`,{catchAll:'create_address'},'live')).catchAll,'create_address');
      const key=ok(await post('/keys',{name:'support only',addressIds:[a.id],permissions:['read','send']}),201);const h={authorization:`Bearer ${key.secret}`};
      assert.deepEqual(ok(await get('/addresses',h)).data.map((x:Json)=>x.id),[a.id]);error(await get(`/addresses/${b.id}`,h),404);error(await post('/addresses',{address:'denied@example.com'},h),403);
      error(await local('GET',`${base}/addresses`,undefined,'test'),400,'ENVIRONMENT_REMOVED');
      const startArgs={mode:'start',body:{addressId:a.id,to:['customer@example.net'],subject:'Invoice',text:'Opening message'},idempotencyKey:'thread-start',confirm:true};
      assert.equal((await tool('sendInboundThread',{...startArgs,confirm:false})).isError,true);
      const first=await success('sendInboundThread',startArgs);assert.equal(first.status,'queued');assert.match(first.threadId,/^thr_/);assert.equal((await success('sendInboundThread',startArgs)).id,first.id);
      const threadId=first.threadId,path=`/threads/${threadId}`;
      async function deliver(id:string, addresses:string[], subject:string, at:string) {
        const [row]=await runtime.db.insert(mailMessages).values({id,...scope,direction:'inbound',threadId,region:REGION,fromAddress:'sender@example.net',to:[],replyTo:[{name:null,address:'reply@example.net'}],subject,text:subject,snippet:subject,messageId:`${id}@example.net`,receivedAt:at}).returning();
        await attachToMailboxes(runtime.db,scope,row!,addresses);
      }
      // The same conversation reaches billing later. Membership never grants historical messages retroactively.
      const shared=unique('msg'),hidden=unique('msg'); const later=new Date(Date.now()+1000).toISOString();
      await deliver(shared,[a.id,b.id],'Shared invoice',later);
      const both=await success('getInboundThread',{threadId});assert.equal(both.messageCount,2);assert.deepEqual(new Set(both.addressIds),new Set([a.id,b.id]));
      error(await post(`${path}/reply`,{text:'ambiguous'}),409,'ADDRESS_REQUIRED');
      error(await local('PATCH',base+path,{read:true},'live'),409,'ADDRESS_REQUIRED');
      error(await local('PATCH',base+path,{read:true},'live',h),403);
      const marked = await success('updateInboundThread',{threadId,body:{addressId:a.id,read:true,starred:true},confirm:true});
      assert.equal(marked.addressId,a.id); assert.equal(marked.unreadCount,0);
      assert.equal(ok(await get(path,h)).messages.at(-1).read,true);
      assert.equal(ok(await get(`${path}?addressId=${b.id}`)).messages.at(-1).read,false);
      assert.deepEqual(ok(await get(`/threads?view=starred&addressId=${b.id}`)).data,[]);
      await deliver(hidden,[b.id],'billing-private-needle',new Date(Date.now()+2000).toISOString());
      assert.equal((await success('listInboundThreads',{q:'invoice'})).data.length,1);
      const support=ok(await get(path,h));assert.deepEqual(support.messages.map((m:Json)=>m.id),[first.id,shared]);assert.equal(support.snippet,'Shared invoice');assert.deepEqual(support.addressIds,[a.id]);assert.ok(!JSON.stringify(support).includes(hidden));
      assert.deepEqual(ok(await get('/threads?q=billing-private-needle',h)).data,[]);error(await get(`/messages/${hidden}`,h),404);error(await post(`${path}/reply`,{replyToMessageId:hidden,text:'hidden'},h),404);
      assert.equal((await success('getInboundMessage',{messageId:shared})).text,'Shared invoice');
      assert.deepEqual(ok(await get('/messages?q=billing-private-needle',h)).data,[]);
      assert.deepEqual((await success('listInboundMessages',{q:'billing-private-needle'})).data.map((x:Json)=>x.id),[hidden]);
      const unassigned = unique('msg'); await deliver(unassigned,[],'Unassigned storage',later);
      assert.deepEqual(ok(await get('/messages?q=Unassigned')).data.map((m:Json)=>m.addressIds),[[]]);
      assert.deepEqual(ok(await get('/messages?q=Unassigned',h)).data,[]);
      error(await get(`/messages/${unassigned}`,h),404); error(await get(`/messages/${unassigned}?addressId=${a.id}`),404);
      error(await post(`${path}/reply`,{replyToMessageId:unassigned,text:'not routed'}),404);
      const fileId = unique('att');
      await runtime.db.insert(mailAttachments).values({id:fileId,...scope,messageId:hidden,filename:'invoice.txt',contentType:'text/plain',sizeBytes:42,disposition:'attachment',sha256:'0'.repeat(64),bucket:'inbound-fixture',storageKey:`workspaces/${scope.workspaceId}/att/${hidden}/${fileId}`});
      await db.query('UPDATE mail_messages SET text=$1, html=$2, attachment_count=1 WHERE id=$3',['a'.repeat(9000),'<p>Invoice</p>',hidden]);
      const preview = ok(await get(path)).messages.find((m:Json)=>m.id===hidden);
      assert.equal(preview.text.length,8192); assert.equal(preview.bodyTruncated,true);
      const detail = ok(await get(`/messages/${hidden}?includeHtml=true`));
      assert.equal(detail.text.length,9000); assert.equal(detail.html,'<p>Invoice</p>'); assert.deepEqual(detail.attachments.map((f:Json)=>f.id),[fileId]);
      const file = `/messages/${hidden}/attachments/${fileId}`;
      error(await get(file,h),404); error(await get(`/messages/${shared}/attachments/${fileId}`),404);
      assert.equal(new URL(ok(await get(file)).url).searchParams.get('X-Amz-Expires'),'300');
      const page=ok(await get(`${path}?limit=1`,h));assert.equal(page.messages[0].id,shared);assert.ok(page.nextCursor);assert.equal(ok(await get(`${path}?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,h)).messages[0].id,first.id);
      const replayHeaders={...h,'Idempotency-Key':'latest-visible'};const reply=ok(await post(`${path}/reply`,{text:'Answering latest visible'},replayHeaders),202);assert.equal(reply.inReplyTo,`${shared}@example.net`);
      const reviewed={mode:'reply',threadId,idempotencyKey:'confirmed-reply',confirm:true,body:{addressId:a.id,replyToMessageId:shared,text:'This is the approved answer',expectedRecipients:{to:['reply@example.net'],cc:[],bcc:[]}}};
      const mismatched=await tool('sendInboundThread',{...reviewed,body:{...reviewed.body,expectedRecipients:{to:['reply@example.net'],cc:['extra@example.net'],bcc:[]}}});assert.equal(mismatched.structuredContent.error.code,'INBOUND_RECIPIENTS_CHANGED');
      const confirmed=await success('sendInboundThread',reviewed);assert.deepEqual(confirmed.to.map((x:Json)=>x.address),['reply@example.net']);
      const newId=unique('msg');await deliver(newId,[a.id],'Fresh inbound',new Date(Date.now()+3000).toISOString());
      assert.equal(ok(await post(`${path}/reply`,{text:'Answering latest visible'},replayHeaders),202).id,reply.id);assert.equal((await success('sendInboundThread',reviewed)).id,confirmed.id);
      await dispatchDue(runtime, REGION);assert.equal(sent.size,3);assert.equal(sent.get(confirmed.emailId).Content.Simple.Headers.find((x:Json)=>x.Name==='In-Reply-To').Value,`<${shared}@example.net>`);
      const solo=ok(await post('/threads',{addressId:a.id,to:['followup@example.net'],subject:'Only outbound',text:'First'},h),202);await dispatchDue(runtime, REGION);
      const followup=ok(await post(`/threads/${solo.threadId}/reply`,{text:'Following up'},h),202);assert.equal(followup.inReplyTo,`ses-${solo.emailId}@${REGION==='us-east-1'?'email':REGION}.amazonses.com`);assert.equal(followup.to[0].address,'followup@example.net');
      // Administrators may answer as any registered sender (or subdomain of one); scoped keys stay on their own addresses.
      const asTeam=ok(await post(`/threads/${solo.threadId}/reply`,{from:'team@mail.example.com',text:'From the team',replyToMessageId:solo.id,expectedRecipients:{to:['followup@example.net'],cc:[],bcc:[]}}),202);
      assert.equal(asTeam.from.address,'team@mail.example.com'); assert.equal(asTeam.threadId,solo.threadId);
      error(await post(`/threads/${solo.threadId}/reply`,{from:'team@example.com',text:'Not my address'},h),403,'FROM_NOT_ALLOWED');
      error(await post(`/threads/${solo.threadId}/reply`,{from:'someone@unregistered.invalid',text:'Unknown domain'}),422,'SENDER_DOMAIN_NOT_REGISTERED');
      const started=ok(await post('/threads',{addressId:a.id,from:'hello@example.com',to:['new@example.net'],subject:'Custom sender',text:'Hi'}),202); assert.equal(started.from.address,'hello@example.com');
      const hook=ok(await post('/webhooks',{url:'https://example.com/inbound',addressIds:[a.id],eventTypes:['message.queued']}),201);assert.deepEqual(hook.addressIds,[a.id]);assert.ok(!('mailboxIds' in hook));
      assert.ok(ok(await get(`/events?after=0&addressId=${a.id}`,h)).data.every((x:Json)=>x.addressId===a.id && !('mailboxId' in x)));
      assert.equal((await success('deleteInboundAddress',{addressId:b.id,confirm:true})).ok,true);error(await get(`/addresses/${b.id}`),404);
      const lifecycle = ok(await get('/events?after=0&types=address.created,address.deleted')).data;
      assert.deepEqual(lifecycle.map((e:Json)=>e.type),['address.created','address.created','address.deleted']);
      const deliveries = (await db.query('SELECT webhook_id,payload FROM mailbox_webhook_deliveries WHERE workspace_id=$1 ORDER BY event_seq',[scope.workspaceId])).rows;
      const bodies=deliveries.filter(d=>d.webhook_id===canonicalHook.id).map(d=>d.payload);
      assert.deepEqual(bodies.map(e=>e.type), lifecycle.map((e:Json)=>e.type));
      assert.equal(bodies.at(-1).addressId,b.id);
      runtime.config.multiTenant = true;
      // Neither a registered parent domain nor the mailbox's own address is sufficient on MX.
      for (const from of ['team@mail.example.com','support@example.com']) {
        error(await post(`/threads/${solo.threadId}/reply`,{from,text:'MX unverified sender',replyToMessageId:solo.id}),403,'SENDER_DOMAIN_NOT_VERIFIED');
      }
    });
  });

  test('hosted MCP read-only OAuth hides writes and revoked consent immediately denies the token', async t => {
    const db = await fixtureDatabase(t);
    const { token, consentId } = await oauthGrant(t, db, 'opensend:read offline_access');
    const catalog = await rpc(token, 'tools/list');
    assert.equal(catalog.tools.length, 16);
    assert.ok(!catalog.tools.some((tool: Json) => tool.name === 'prepareCampaign'));
    assert.ok(catalog.tools.every((tool: Json) => tool.annotations.readOnlyHint === true));
    assert.ok(catalog.tools.some((tool: Json) => tool.name === 'findContacts'));
    assert.ok(catalog.tools.some((tool: Json) => tool.name === 'findCampaigns'));
    assert.ok(catalog.tools.some((tool: Json) => tool.name === 'getContext'));
    assert.ok(!catalog.tools.some((tool: Json) => tool.name === 'audienceQuery'));
    const list = await resource(t, MANAGER, '/v1/lists', { name: unique('mcp-read-state') });
    const campaign = await campaignFixture(t, MANAGER, { listId: list.id });
    assert.equal((await callTool(token, 'findCampaigns', { id: campaign.id })).data[0].id, campaign.id);
    const stats = await callTool(token, 'getCampaignStats', { id: campaign.id });
    assert.equal(stats.id, campaign.id);
    assert.equal(stats.counts.total, 0);
    assert.equal(stats.rates.delivery.value, null);
    const emailId = unique('mcp-stats-email');
    cleanup(t, async () => {
      await db.query('DELETE FROM sending_email_events WHERE email_id = $1', [emailId]);
      await db.query('DELETE FROM sending_emails WHERE id = $1', [emailId]);
    });
    await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, campaign_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status)
      VALUES ($1,'default',$2,'synthetic-stats',$3,'sender@example.com','["recipient@example.com"]','[]','[]','Synthetic stats','{}',true,'delivered')`, [emailId, REGION, campaign.id]);
    for (const type of ['open', 'click', 'click']) await db.query("INSERT INTO sending_email_events (id, workspace_id, email_id, type, simulated) VALUES ($1,'default',$2,$3,true)", [unique('mcp-stats-event'), emailId, type]);
    const populated = await callTool(token, 'getCampaignStats', { id: campaign.id });
    assert.deepEqual(populated, ok(await http('GET', `/v1/campaigns/${campaign.id}/stats`, MANAGER)));
    assert.equal(populated.totals.delivered, 1);
    assert.equal(populated.totals.opened, 1);
    assert.equal(populated.totals.clicked, 1);
    const missing = await rpc(token, 'tools/call', { name: 'getCampaignStats', arguments: { id: unique('missing') } });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.status, 404);
    const invalid = await rpc(token, 'tools/call', { name: 'getCampaignStats', arguments: { path: { id: campaign.id } } });
    assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENTS');
    assert.ok(!catalog.tools.some((tool: Json) => tool.name === 'archiveCampaign'));
    const archiveDenied = await rpc(token, 'tools/call', { name: 'archiveCampaign', arguments: { id: unique('missing'), body: { archived: true }, confirm: true } });
    assert.equal(archiveDenied.isError, true, redact(archiveDenied));
    assert.equal(archiveDenied.structuredContent.error.code, 'TOOL_UNAVAILABLE', redact(archiveDenied));
    const denied = await rpc(token, 'tools/call', { name: 'saveContact', arguments: { action: 'create', confirm: true, body: { email: address() } } });
    assert.equal(denied.isError, true, redact(denied));
    assert.equal(denied.structuredContent.error.code, 'TOOL_UNAVAILABLE', redact(denied));
    const deletion = await http('POST', '/api/auth/oauth2/delete-consent', MANAGER, { id: consentId });
    assert.equal(deletion.status, 200, diagnostic(deletion));
    const revoked = await http('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, rpcHeaders);
    assert.equal(revoked.status, 401, diagnostic(revoked));
    assert.match(revoked.headers.get('www-authenticate') ?? '', /resource_metadata=/);
    const key = await keyFixture(t);
    const fallback = await http('POST', '/mcp', key.secret, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, rpcHeaders);
    assert.equal(fallback.status, 401, 'Hosted MCP must not fall back to API-key authentication.');
  });
});

describe('DB region catalog and explicit SES setup', () => {
  test('MOCK AWS TRANSPORT: catalog changes are immediate, discovery is read-only, and provisioning is explicit and idempotent', async t => {
    const [{ createApp }, { nodeRuntime }, { drizzle }, { drainJobs }, { dispatchDue }, ses, sns, sts, { regionalLimits }] = await Promise.all([
      import('./src/app.js'), import('./src/adapters/node.js'), import('drizzle-orm/node-postgres'), import('./src/dispatch.js'), import('./src/dispatcher.js'),
      import('@aws-sdk/client-sesv2'), import('@aws-sdk/client-sns'), import('@aws-sdk/client-sts'), import('./src/db/sending.js'),
    ]);
    const db = await fixtureDatabase(t);
    const instance = nodeRuntime({ DATABASE_URL: FIXTURE_DATABASE_URL, BETTER_AUTH_SECRET: AUTH_SECRET,
      GOOGLE_CLIENT_ID: 'synthetic-ses-client', GOOGLE_CLIENT_SECRET: 'synthetic-ses-client-secret', AUTH_ALLOWED_EMAILS: AUTH_EMAIL,
      PUBLIC_URL: PUBLIC_ORIGIN, DEFAULT_SES_REGION: REGION, ENABLE_LIVE_SES: 'true',
      S3_BUCKET: 'synthetic-ses-fixture', S3_ACCESS_KEY_ID: 'synthetic-storage-id', S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret' });
    cleanup(t, instance.close);
    const runtime = instance.runtime;
    runtime.config.workspaceId = unique('mock-ses-workspace');
    const app = createApp();
    const rollback = new Error('Rollback isolated SES acceptance fixtures');
    const observed: Array<{ name: string; input: Json }> = [];
    const unexpected: string[] = [];
    // SDK prototype interception includes clients constructed later or cached by the
    // adapter. No credential chain, request handler, or actual AWS endpoint is used.
    const accountId = '111122223333';
    const sets = new Map<string, Json>();
    let topic: Json | undefined;
    let subscriptions: Json[] = [];
    const mailFrom = new Map<string, string>();
    let deny = false;
    let wrongOwner = false;
    let expectedSets: string[] = [];
    let expectedTopic = '';
    const writes = () => observed.filter(call => !/^(Get|List)/.test(call.name));
    const provider = async (command: { constructor: { name: string }; input: Json }): Promise<Json> => {
      const name = command.constructor.name, input = command.input;
      observed.push({ name, input: structuredClone(input) });
      const missing = () => { throw Object.assign(new Error('Synthetic missing resource'), { name: 'NotFoundException' }); };
      if (deny) throw Object.assign(new Error('SECRET_PROVIDER_DIAGNOSTIC synthetic-access-key'), { name: 'AccessDeniedException' });
      switch (name) {
        case 'GetCallerIdentityCommand': return { Account: accountId, Arn: `arn:aws:iam::${accountId}:user/synthetic-setup` };
        case 'GetAccountCommand': return { ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: 'HEALTHY', SendQuota: { Max24HourSend: 1000, MaxSendRate: 10, SentLast24Hours: 3 } };
        case 'ListEmailIdentitiesCommand': return { EmailIdentities: [{ IdentityType: 'DOMAIN', IdentityName: 'example.com', VerificationStatus: 'SUCCESS', SendingEnabled: true }] };
        case 'GetEmailIdentityCommand':
          assert.notEqual(input.EmailIdentity, 'disabled.example.com', 'Default domain listing must not refresh disabled regions.');
          return { VerifiedForSendingStatus: true, VerificationStatus: 'SUCCESS', DkimAttributes: { Status: 'SUCCESS', SigningHostedZone: 'dkim.amazonses.com', Tokens: ['synthetic'] }, ...(mailFrom.has(input.EmailIdentity) ? { MailFromAttributes: { MailFromDomain: mailFrom.get(input.EmailIdentity), MailFromDomainStatus: 'PENDING', BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' } } : {}) };
        case 'PutEmailIdentityMailFromAttributesCommand':
          assert.equal(input.BehaviorOnMxFailure, 'USE_DEFAULT_VALUE');
          mailFrom.set(input.EmailIdentity, input.MailFromDomain); return {};
        case 'GetConfigurationSetCommand': return sets.get(input.ConfigurationSetName) ?? missing();
        case 'GetConfigurationSetEventDestinationsCommand': return { EventDestinations: sets.get(input.ConfigurationSetName)?.destinations ?? [] };
        case 'GetTopicAttributesCommand': return topic ? { Attributes: { ...topic.attributes, ...(wrongOwner ? { Owner: '999999999999' } : {}) } } : missing();
        case 'ListTagsForResourceCommand': return { Tags: topic?.tags ?? [] };
        case 'ListSubscriptionsByTopicCommand': return { Subscriptions: subscriptions };
        case 'GetSubscriptionAttributesCommand': return { Attributes: { ...subscriptions.find(sub => sub.SubscriptionArn === input.SubscriptionArn), Owner: accountId, PendingConfirmation: 'false', RawMessageDelivery: 'false' } };
        case 'CreateConfigurationSetCommand':
          assert.ok(expectedSets.includes(input.ConfigurationSetName));
          assert.ok(!sets.has(input.ConfigurationSetName), 'Repeated runs must not recreate an existing set.');
          sets.set(input.ConfigurationSetName, { Tags: input.Tags, SendingOptions: input.SendingOptions, destinations: [] }); return {};
        case 'PutConfigurationSetSuppressionOptionsCommand': {
          assert.ok(expectedSets.includes(input.ConfigurationSetName));
          assert.deepEqual(input.SuppressedReasons, ['BOUNCE', 'COMPLAINT']);
          assert.equal(input.SuppressionScope, 'ACCOUNT');
          const set = sets.get(input.ConfigurationSetName)!;
          set.SuppressionOptions = { SuppressionScope: input.SuppressionScope, SuppressedReasons: input.SuppressedReasons, ValidationOptions: input.ValidationOptions };
          return {};
        }
        case 'CreateTopicCommand':
          assert.equal(`arn:aws:sns:${REGION}:${accountId}:${input.Name}`, expectedTopic);
          assert.equal(topic, undefined, 'Repeated runs must not recreate an existing topic.');
          topic = { attributes: { TopicArn: expectedTopic, Owner: accountId }, tags: input.Tags }; return { TopicArn: expectedTopic };
        case 'SetTopicAttributesCommand':
          assert.equal(input.TopicArn, expectedTopic); assert.equal(input.AttributeName, 'Policy');
          topic!.attributes.Policy = input.AttributeValue; return {};
        case 'CreateConfigurationSetEventDestinationCommand':
        case 'UpdateConfigurationSetEventDestinationCommand': {
          assert.ok(expectedSets.includes(input.ConfigurationSetName));
          assert.equal(input.EventDestination.SnsDestination.TopicArn, expectedTopic);
          const set = sets.get(input.ConfigurationSetName)!;
          set.destinations = [...set.destinations.filter((d: Json) => d.Name !== input.EventDestinationName), { Name: input.EventDestinationName, ...input.EventDestination }]; return {};
        }
        case 'SubscribeCommand':
          assert.equal(input.TopicArn, expectedTopic); assert.equal(input.Protocol, 'https');
          assert.equal(input.Endpoint, runtime.config.sesFeedbackUrl ?? `${runtime.config.publicUrl}/v1/events/ses`);
          const registered = await (await import('./src/ses-region-state.js')).resolveRegionRuntime(runtime);
          assert.ok(registered.config.snsTopicArns.includes(input.TopicArn), 'Signed confirmation must be trusted before SNS Subscribe can deliver it.');
          assert.equal(registered.config.awsAccountId, accountId);
          assert.deepEqual(input.Attributes, { RawMessageDelivery: 'false' });
          assert.equal(subscriptions.length, 0, 'Pending confirmation must never create duplicate subscriptions.');
          subscriptions = [{ TopicArn: input.TopicArn, Protocol: input.Protocol, Endpoint: input.Endpoint, SubscriptionArn: 'PendingConfirmation' }];
          return { SubscriptionArn: 'PendingConfirmation' };
        default:
          unexpected.push(name);
          throw new Error(`Unexpected mocked AWS command: ${name}`);
      }
    };
    const sendThroughTransport = ses.SESv2Client.prototype.send;
    t.mock.method(ses.SESv2Client.prototype, 'send', function(this: InstanceType<typeof ses.SESv2Client>, command: { constructor: { name: string }; input: Json }) {
      // Simulated dispatch still runs the SES SDK, but its client must reach
      // the in-process request handler rather than this live-control-plane mock.
      if (command.constructor.name === 'SendEmailCommand') return Reflect.apply(sendThroughTransport as any, this, [command]);
      return provider(command);
    } as any);
    t.mock.method(sns.SNSClient.prototype, 'send', provider as any);
    t.mock.method(sts.STSClient.prototype, 'send', provider as any);
    const { CloudWatchClient } = await import('@aws-sdk/client-cloudwatch');
    t.mock.method(CloudWatchClient.prototype, 'send', async () => ({ MetricDataResults: [] }));
    try {
      await drizzle(db).transaction(async tx => {
        runtime.db = tx;
        await db.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $1, $1)', [runtime.config.workspaceId]);
        await db.query("UPDATE workspace_members SET workspace_id = $1 WHERE user_id = $2 AND workspace_id = 'default'", [runtime.config.workspaceId, manager!.userId]);
        await (await import('./src/ses-region-state.js')).ensureRegionSettings(runtime.db, runtime.config);
        async function local(method: string, path: string, body?: Json, key?: string, environment: 'test' | 'live' = 'live'): Promise<Reply> {
          const response = await app.fetch(new Request(`${runtime.config.publicUrl}${path}`, {
            method, headers: { origin: runtime.config.publicUrl, 'x-opensend-environment': environment,
              ...(key ? { authorization: `Bearer ${key}` } : { cookie: manager!.cookie }), ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }), runtime);
          return { status: response.status, body: await response.json(), headers: response.headers };
        }
        async function machine(permissions: string[], domains: string[] = []) {
          return ok(await local('POST', '/v1/api-keys', { name: unique('mock-ses-key'), permissions, domains }), 201).secret as string;
        }
        const testKey = await machine(['read', 'send', 'manage']);
        const reader = await machine(['read']);
        const admin = await machine(['read', 'send', 'manage']);
        const scoped = await machine(['read', 'manage'], ['example.com']);
        const initial = ok(await local('GET', '/v1/regions', undefined, testKey));
        assert.equal(initial.defaultRegion, REGION);
        assert.ok(initial.data.some((row: Json) => row.region === REGION && row.enabled && row.isDefault));
        assert.deepEqual(ok(await local('GET', '/v1/regions', undefined, reader)), initial);
        error(await local('GET', '/v1/regions', undefined, scoped), 403);
        const second = REGION === 'eu-west-1' ? 'us-west-2' : 'eu-west-1';
        ok(await local('PUT', `/v1/regions/${second}`, { enabled: true }, testKey));
        error(await local('PUT', `/v1/regions/${second}`, { enabled: true }, reader), 403);
        error(await local('PUT', '/v1/regions/not-a-region', { enabled: true }, admin), 422);
        ok(await local('PUT', `/v1/regions/${second}`, { enabled: true, makeDefault: true }, admin));
        assert.equal(ok(await local('GET', '/v1/regions', undefined, testKey)).defaultRegion, second);
        error(await local('PUT', `/v1/regions/${second}`, { enabled: false }, admin), 409);
        const sent = ok(await local('POST', '/v1/emails/send', { from: 'sender@example.com', to: address(), subject: 'DB-selected region', text: 'Synthetic only' }, testKey), 202);
        assert.equal(ok(await local('GET', `/v1/emails/${sent.id}`, undefined, testKey)).region, second, 'Changing the DB default must affect send without rebuilding the environment.');
        ok(await local('PUT', `/v1/regions/${REGION}`, { makeDefault: true }, admin));
        error(await local('PUT', `/v1/regions/${second}`, { enabled: false }, admin), 409, undefined);
        // Avoid routing the simulator's quota read through the live AWS mock; this
        // fixture is testing persisted region selection, not quota discovery.
        await runtime.db.insert(regionalLimits).values({ workspaceId: runtime.config.workspaceId, region: second, maxSendRate: 1000, max24HourSend: -1, sentLast24Hours: 0, checkedAt: new Date().toISOString() });
        await dispatchDue(runtime, second); // Do not dispatch other regions through this fixture's AWS mock.
        assert.equal(ok(await local('GET', `/v1/emails/${sent.id}`, undefined, testKey)).status, 'accepted');
        ok(await local('PUT', `/v1/regions/${second}`, { enabled: false }, admin));
        error(await local('POST', '/v1/emails/send', { from: 'sender@example.com', to: address(), region: second, subject: 'Disabled region', text: 'Synthetic only' }, testKey), 422);
        assert.equal(ok(await local('GET', `/v1/emails/${sent.id}`, undefined, testKey)).region, second, 'Disabling a region must not hide its historical email.');
        assert.equal(observed.length, 0, 'Catalog reads/writes and simulated sends must never access AWS.');
        error(await local('GET', `/v1/regions/${REGION}/discovery`, undefined, testKey), 503, 'SES_NOT_CONFIGURED');
        error(await local('GET', `/v1/regions/${REGION}/discovery`, undefined, scoped), 403);
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: true }, testKey), 503, 'SES_NOT_CONFIGURED');
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: true }, reader), 403);
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: true }, scoped), 403);
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: false }, admin), 422);
        const originalUrl = runtime.config.publicUrl;
        runtime.config.publicUrl = 'https://ses-acceptance.opensend.dev';
        error(await local('GET', `/v1/regions/${REGION}/discovery`, undefined, reader), 503, 'SES_NOT_CONFIGURED');
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: true }, admin), 503);
        assert.equal(observed.length, 0, 'Missing explicit AWS credentials must fail without SDK calls.');
        runtime.config.aws = { accessKeyId: 'synthetic-access-key', secretAccessKey: 'synthetic-secret-key' };
        runtime.config.publicUrl = 'http://127.0.0.1:8798';
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: true }, admin), 422);
        assert.equal(observed.length, 0, 'Invalid callback URL must reject provisioning before AWS calls.');
        runtime.config.sesFeedbackUrl = 'https://ses-acceptance.opensend.dev/v1/events/ses';
        const startup = await import('./src/ses-regions.js');
        assert.equal(await startup.queueStartupDiscovery(runtime), 1);
        assert.equal(await startup.queueStartupDiscovery(runtime), 0, 'Concurrent/repeated startup discovery must reuse its pending job.');
        assert.equal(ok(await local('GET', '/v1/regions', undefined, reader)).data.find((row: Json) => row.region === REGION).discoveryStatus, 'discovering');
        await drainJobs(runtime, 10);
        const startupReport = ok(await local('GET', `/v1/regions/${REGION}/discovery`, undefined, reader));
        assert.equal(startupReport.feedbackUrl, runtime.config.sesFeedbackUrl);
        assert.equal(startupReport.status, 'needs_provisioning');
        assert.equal(writes().length, 0, 'Automatic startup discovery must not provision resources.');
        assert.equal(await startup.queueStartupDiscovery(runtime), 0, 'A fresh discovery does not need another startup job.');
        runtime.config.sesFeedbackUrl = undefined;
        runtime.config.publicUrl = 'https://ses-acceptance.opensend.dev';
        const discoveryPath = `/v1/regions/${REGION}/discovery`;
        const missing = ok(await local('GET', discoveryPath, undefined, reader));
        assert.equal(missing.status, 'needs_provisioning', 'Changed credentials must invalidate the previous blocked discovery cache.');
        assert.equal(missing.account.id, accountId);
        assert.equal(missing.account.quota.maxSendRate, 10);
        assert.ok(missing.domains.some((domain: Json) => domain.name === 'example.com' && domain.sendingEnabled));
        await db.query("INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,'disabled.example.com',$3)", [unique('disabled-domain'), runtime.config.workspaceId, second]);
        const enabledDomains = ok(await local('GET', '/v1/domains', undefined, reader));
        assert.ok(enabledDomains.data.some((domain: Json) => domain.name === 'example.com'));
        assert.ok(enabledDomains.data.every((domain: Json) => domain.region !== second));
        expectedSets = [missing.resources.transactional.name, missing.resources.marketing.name];
        expectedTopic = missing.resources.topic.arn;
        assert.equal(missing.resources.topic.exists, false);
        assert.equal(missing.resources.transactional.exists, false);
        assert.equal(writes().length, 0, 'Discovering missing resources must not create, update, or subscribe anything.');
        await db.query(`UPDATE ses_region_discovery SET report = report #- '{resources,transactional,autoValidation}' #- '{resources,marketing,autoValidation}' WHERE workspace_id = $1 AND region = $2`, [runtime.config.workspaceId, REGION]);
        const cachedCalls = observed.length;
        Object.assign(runtime.config.aws, { $source: { CREDENTIALS_CODE: 'e' } });
        assert.deepEqual(ok(await local('GET', discoveryPath, undefined, reader)), missing);
        assert.equal(observed.length, cachedCalls, 'A fresh report must use the DB cache.');
        ok(await local('GET', `${discoveryPath}?refresh=true`, undefined, reader));
        assert.ok(observed.length > cachedCalls, 'Explicit refresh must repeat AWS reads.');
        assert.equal(writes().length, 0);
        const rotatedCalls = observed.length;
        runtime.config.aws.accessKeyId = 'synthetic-rotated-access-key';
        ok(await local('GET', discoveryPath, undefined, reader));
        assert.ok(observed.length > rotatedCalls, 'Credential changes must invalidate cached account discovery.');
        error(await local('POST', '/v1/emails/send', { from: 'sender@example.com', to: address(), region: REGION, subject: 'Must not queue before setup', text: 'Synthetic only' }, admin), 409, 'SES_SETUP_REQUIRED');
        const provisionPath = `/v1/regions/${REGION}/provision`;
        const queued = ok(await local('POST', provisionPath, { confirm: true }, admin), 202);
        assert.equal(queued.status, 'pending');
        assert.equal(typeof queued.jobId, 'string');
        assert.equal(ok(await local('POST', provisionPath, { confirm: true }, admin), 202).jobId, queued.jobId);
        assert.equal(writes().length, 0, 'Only the durable worker may perform provisioning writes.');
        const job = (await db.query('SELECT type, status FROM jobs WHERE id = $1', [queued.jobId])).rows[0];
        assert.deepEqual(job, { type: 'ses.provision', status: 'pending' });
        await drainJobs(runtime, 10);
        assert.equal((await db.query('SELECT status FROM jobs WHERE id = $1', [queued.jobId])).rows[0].status, 'completed');
        const pending = ok(await local('GET', `${discoveryPath}?refresh=true`, undefined, reader));
        assert.equal(pending.resources.topic.subscription, 'pending');
        assert.equal(pending.resources.transactional.autoValidation, 'off');
        assert.equal(pending.resources.marketing.autoValidation, 'managed');
        assert.equal(pending.provisioned, false);
        assert.notEqual(pending.status, 'ready', 'Creating resources cannot claim readiness before SNS confirmation.');
        assert.ok(pending.blockers.some((blocker: Json) => blocker.code === 'SNS_CONFIRMATION_PENDING'));
        assert.equal(sets.size, 2);
        assert.equal(subscriptions.length, 1);
        const policy = JSON.parse(topic!.attributes.Policy);
        const publish = policy.Statement.find((statement: Json) => statement.Principal?.Service === 'ses.amazonaws.com');
        assert.equal(publish.Action, 'sns:Publish');
        assert.equal(publish.Resource, expectedTopic);
        assert.equal(publish.Condition.StringEquals['AWS:SourceAccount'], accountId);
        assert.deepEqual(publish.Condition.StringEquals['AWS:SourceArn'].sort(), expectedSets.map(name => `arn:aws:ses:${REGION}:${accountId}:configuration-set/${name}`).sort());
        assert.ok(policy.Statement.every((statement: Json) => statement.Principal !== '*' && statement.Resource === expectedTopic));
        for (const set of sets.values()) {
          assert.ok(set.Tags.some((tag: Json) => tag.Key === 'opensend:installation-id' && tag.Value));
          // Provider acceptance comes from SendEmail's response, not a duplicate SEND notification.
          assert.deepEqual([...set.destinations[0].MatchingEventTypes].sort(), ['DELIVERY', 'BOUNCE', 'COMPLAINT', 'REJECT', 'RENDERING_FAILURE', 'DELIVERY_DELAY', 'OPEN', 'CLICK'].sort());
        }
        const validationPath = `/v1/regions/${REGION}/auto-validation`;
        error(await local('PUT', validationPath, { stream: 'transactional', mode: 'high', confirm: true }, reader), 403);
        error(await local('PUT', validationPath, { stream: 'transactional', mode: 'high', confirm: true }, scoped), 403);
        error(await local('PUT', validationPath, { stream: 'transactional', mode: 'high', confirm: false }, admin), 422);
        assert.deepEqual(ok(await local('PUT', validationPath, { stream: 'transactional', mode: 'high', confirm: true }, admin)), { stream: 'transactional', mode: 'high' });
        assert.equal(sets.get(expectedSets[0]!)!.SuppressionOptions.ValidationOptions.ConditionThreshold.OverallConfidenceThreshold.ConfidenceVerdictThreshold, 'HIGH');
        // A foreign destination must survive retries, while managed resources and
        // pending subscriptions remain singleton resources rather than duplicates.
        const unrelated = { Name: 'customer-tracking', Enabled: true, MatchingEventTypes: ['OPEN'], SnsDestination: { TopicArn: 'arn:aws:sns:us-east-1:444455556666:unrelated' } };
        sets.get(expectedSets[0]!)!.destinations.push(unrelated);
        const repeated = ok(await local('POST', provisionPath, { confirm: true }, admin), 202);
        assert.notEqual(repeated.jobId, queued.jobId);
        await drainJobs(runtime, 10);
        assert.equal((await db.query('SELECT status FROM jobs WHERE id = $1', [repeated.jobId])).rows[0].status, 'completed');
        assert.equal(writes().filter(call => call.name === 'CreateConfigurationSetCommand').length, 2);
        assert.equal(writes().filter(call => call.name === 'PutConfigurationSetSuppressionOptionsCommand').length, 3, 'Reprovisioning must preserve explicit validation settings.');
        assert.equal(writes().filter(call => call.name === 'CreateTopicCommand').length, 1);
        assert.equal(writes().filter(call => call.name === 'SubscribeCommand').length, 1);
        assert.deepEqual(sets.get(expectedSets[0]!)!.destinations.find((destination: Json) => destination.Name === unrelated.Name), unrelated);
        subscriptions[0]!.SubscriptionArn = `${expectedTopic}:00000000-0000-4000-8000-000000000000`;
        const ready = ok(await local('GET', `${discoveryPath}?refresh=true`, undefined, reader));
        assert.equal(ready.status, 'ready');
        assert.equal(ready.provisioned, true);
        const regional = await import('./src/ses-region-state.js');
        const connectedKey = runtime.config.aws.accessKeyId;
        runtime.config.aws.accessKeyId = 'another-synthetic-account-credential';
        assert.ok((await regional.resolveRegionRuntime(runtime)).config.snsTopicArns.includes(expectedTopic), 'Rotating AWS credentials must not drop signed feedback from an already provisioned topic.');
        ok(await local('GET', `${discoveryPath}?refresh=true`, undefined, reader));
        assert.ok((await regional.resolveRegionRuntime(runtime)).config.snsTopicArns.includes(expectedTopic), 'Feedback trust follows the registered account and topic independently of API credential rotation.');
        runtime.config.aws.accessKeyId = connectedKey;
        assert.ok((await regional.resolveRegionRuntime(runtime)).config.snsTopicArns.includes(expectedTopic));
        const configuredDomain = enabledDomains.data.find((domain: Json) => domain.name === 'example.com');
        assert.ok(configuredDomain);
        error(await local('POST', `/v1/domains/${configuredDomain.id}/mail-from`, { mailFromDomain: 'other.invalid' }, admin), 422, 'MAIL_FROM_DOMAIN_INVALID');
        error(await local('POST', `/v1/domains/${configuredDomain.id}/mail-from`, { mailFromDomain: 'email.example.com' }, reader), 403, 'PERMISSION_DENIED');
        const configuredMailFrom = ok(await local('POST', `/v1/domains/${configuredDomain.id}/mail-from`, { mailFromDomain: 'email.example.com' }, admin));
        assert.equal(configuredMailFrom.mailFromDomain, 'email.example.com');
        assert.equal(configuredMailFrom.mailFromStatus, 'PENDING');
        assert.ok(configuredMailFrom.dns.some((record: Json) => record.type === 'MX' && record.name === 'email.example.com' && record.priority === 10));
        assert.ok(configuredMailFrom.dns.some((record: Json) => record.type === 'TXT' && record.value === 'v=spf1 include:amazonses.com ~all'));
        const beforeWrongOwner = writes().length;
        wrongOwner = true;
        const conflict = ok(await local('GET', `${discoveryPath}?refresh=true`, undefined, reader));
        assert.equal(conflict.status, 'blocked');
        assert.ok(conflict.blockers.some((blocker: Json) => blocker.code === 'RESOURCE_OWNERSHIP_CONFLICT'));
        const conflictJob = ok(await local('POST', provisionPath, { confirm: true }, admin), 202);
        await drainJobs(runtime, 10);
        assert.equal((await db.query('SELECT status FROM jobs WHERE id = $1', [conflictJob.jobId])).rows[0].status, 'failed');
        assert.equal(writes().length, beforeWrongOwner, 'A conflicting owner must block all provisioning writes.');
        wrongOwner = false;
        deny = true;
        const denied = ok(await local('GET', `${discoveryPath}?refresh=true`, undefined, reader));
        assert.equal(denied.status, 'blocked');
        assert.ok(denied.blockers.some((blocker: Json) => blocker.code === 'AWS_ACCESS_DENIED'));
        assert.doesNotMatch(JSON.stringify(denied), /SECRET_PROVIDER_DIAGNOSTIC|synthetic-access-key|synthetic-secret-key/);
        assert.equal(writes().length, beforeWrongOwner, 'Permission-denied discovery must never attempt repair.');
        runtime.config.publicUrl = originalUrl;
        assert.deepEqual(unexpected, []);
        throw rollback;
      });
    } catch (cause) { if (cause !== rollback) throw cause; }
  });
});

describe('Contacts and explicit consent', () => {
  test('profiles persist, require manage scope, and cannot implicitly grant marketing consent', async t => {
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const email = address();
    const contact = await resource(t, key.secret, '/v1/contacts', { email, name: 'Before', properties: { plan: 'free' } });
    assert.equal(contact.marketingConsent, 'unknown');
    assert.equal(contact.environment, undefined);
    assert.equal(contact.suppressed, false);
    error(await http('POST', '/v1/contacts', reader.secret, { email: address() }), 403, 'PERMISSION_DENIED');
    error(await http('POST', '/v1/contacts', key.secret, { email: 'not-an-email' }), 422);
    error(await http('POST', '/v1/contacts', key.secret, { email: email.toUpperCase() }), 409, 'CONTACT_EXISTS');
    error(await http('PATCH', `/v1/contacts/${contact.id}`, key.secret, { marketingConsent: 'subscribed' }), 422);
    const updated = ok(await http('PATCH', `/v1/contacts/${contact.id}`, key.secret, { name: 'After', properties: { plan: 'pro', country: 'US' } }));
    assert.equal(updated.name, 'After');
    const persisted = ok(await http('GET', `/v1/contacts/${contact.id}`, reader.secret));
    assert.equal(persisted.email, email);
    assert.deepEqual(persisted.properties, { plan: 'pro', country: 'US' });
    assert.equal(persisted.marketingConsent, 'unknown');
    assert.equal(ok(await http('POST', `/v1/contacts/${contact.id}/consent`, key.secret, { status: 'subscribed' })).marketingConsent, 'subscribed');
    assert.equal(ok(await consent(key.secret, contact.id, 'unsubscribed')).marketingConsent, 'unsubscribed');
    error(await consent(key.secret, contact.id, 'subscribed'), 409, 'RESUBSCRIBE_CONFIRMATION_REQUIRED');
    const audit = page(await http('GET', `/v1/contacts/${contact.id}/consent`, key.secret));
    assert.equal(audit.length, 2);
    assert.deepEqual(audit.map((row: Json) => row.status).sort(), ['subscribed', 'unsubscribed']);
    const subscribedAudit = audit.find((row: Json) => row.status === 'subscribed');
    const unsubscribedAudit = audit.find((row: Json) => row.status === 'unsubscribed');
    assert.ok(subscribedAudit && unsubscribedAudit);
    assert.equal(subscribedAudit.source, 'api');
    assert.equal(subscribedAudit.evidence, null);
    assert.equal(unsubscribedAudit.source, 'acceptance-fixture');
    assert.equal(ok(await http('DELETE', `/v1/contacts/${contact.id}`, key.secret)).deleted, true);
    error(await http('GET', `/v1/contacts/${contact.id}`, key.secret), 404, 'NOT_FOUND');
    error(await http('POST', '/v1/contacts', key.secret, { email }), 409, 'CONTACT_EXISTS');
  });

  test('two keys in a workspace share one contact and consent history', async t => {
    const first = await keyFixture(t), second = await keyFixture(t);
    const contact = await resource(t, first.secret, '/v1/contacts', { email: address() });
    error(await http('POST', '/v1/contacts', second.secret, { email: contact.email }), 409, 'CONTACT_EXISTS');
    ok(await consent(second.secret, contact.id, 'unsubscribed'));
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, first.secret)).marketingConsent, 'unsubscribed');
  });
});

describe('Lists, compound segments, imports and exports', () => {
  test('memberships are idempotent, pagination is stable, compound rules and unknown-history exclusions affect counts', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('list') });
    const a = await resource(t, key.secret, '/v1/contacts', { email: address(), properties: { plan: 'pro', country: 'US' } });
    const b = await resource(t, key.secret, '/v1/contacts', { email: address(), properties: { plan: 'free', country: 'CA' } });
    const c = await resource(t, key.secret, '/v1/contacts', { email: address(), properties: { plan: 'pro', country: 'GB' } });
    ok(await consent(key.secret, a.id, 'subscribed'));
    ok(await consent(key.secret, c.id, 'subscribed'));
    assert.equal(ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [a.id, b.id, c.id, a.id] })).added, 3);
    assert.equal(ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [a.id] })).added, 0);
    const first = await http('GET', `/v1/lists/${list.id}/members?limit=2`, key.secret);
    assert.equal(page(first).length, 2);
    assert.equal(typeof first.body.nextCursor, 'string');
    const second = await http('GET', `/v1/lists/${list.id}/members?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`, key.secret);
    assert.equal(page(second).length, 1);
    assert.equal(second.body.nextCursor, null);
    assert.deepEqual([...first.body.data, ...second.body.data].map((row: Json) => row.id).sort(), [a.id, b.id, c.id].sort());
    const segment = await resource(t, key.secret, '/v1/segments', { name: unique('compound'), rule: { operator: 'and', rules: [
      { operator: 'or', rules: [{ field: 'plan', operator: 'eq', value: 'pro' }, { field: 'country', operator: 'eq', value: 'CA' }] },
      { field: 'country', operator: 'neq', value: 'GB' },
    ] } });
    assert.deepEqual(ok(await http('POST', `/v1/segments/${segment.id}/preview`, key.secret, { listId: list.id })), { matched: 2, eligible: 1, suppressed: 0, unsubscribed: 1 });
    ok(await http('PATCH', `/v1/segments/${segment.id}`, key.secret, { rule: { field: 'email', operator: 'eq', value: a.email.toUpperCase() } }));
    assert.deepEqual(ok(await http('POST', `/v1/segments/${segment.id}/preview`, key.secret, { listId: list.id })), { matched: 1, eligible: 1, suppressed: 0, unsubscribed: 0 }, 'Email equality must normalize uppercase input against the stored address.');
    ok(await http('PATCH', `/v1/segments/${segment.id}`, key.secret, { rule: { field: 'email', operator: 'neq', value: a.email.toUpperCase() } }));
    assert.deepEqual(ok(await http('POST', `/v1/segments/${segment.id}/preview`, key.secret, { listId: list.id })), { matched: 2, eligible: 1, suppressed: 0, unsubscribed: 1 }, 'Email inequality must exclude the same address regardless of input case.');
    const inactive = await resource(t, key.secret, '/v1/segments', { name: unique('inactive'), rule: { field: 'lastOpenAt', operator: 'inactive', days: 90 } });
    assert.deepEqual(ok(await http('POST', `/v1/segments/${inactive.id}/preview`, key.secret, { listId: list.id })), { matched: 0, eligible: 0, suppressed: 0, unsubscribed: 0 });
    error(await http('POST', '/v1/segments', key.secret, { name: unique('bad-rule'), rule: { operator: 'and', rules: [] } }), 422);
    ok(await http('DELETE', `/v1/lists/${list.id}/members/${a.id}`, key.secret));
    const remaining = page(await http('GET', `/v1/lists/${list.id}/members`, key.secret));
    assert.deepEqual(remaining.map((row: Json) => row.id).sort(), [b.id, c.id].sort());
  });

  test('CSV preview reports bad rows, commit is repeatable, quoted fields round-trip, and import preserves opt-outs', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('import-list') });
    const existing = await resource(t, key.secret, '/v1/contacts', { email: address(), name: 'Original' });
    ok(await consent(key.secret, existing.id, 'unsubscribed'));
    ok(await http('DELETE', `/v1/contacts/${existing.id}`, key.secret));
    error(await http('GET', `/v1/contacts/${existing.id}`, key.secret), 404, 'NOT_FOUND');
    const fresh = address();
    const csv = `Email,Name,Plan\r\n${existing.email},"Renamed, Person",pro\r\n${fresh},"Quote ""Person""",free\r\ninvalid-email,Bad,free\r\n${fresh},Duplicate,pro\r\n`;
    const preview = ok(await http('POST', '/v1/contact-imports', key.secret, { csv, listId: list.id, mapping: { email: 'Email', name: 'Name', plan: 'Plan' } }), 201);
    assert.equal(preview.status, 'preview');
    assert.equal(preview.imported, 0);
    assert.equal(preview.rows.length, 2);
    assert.equal(preview.errors.length, 2);
    assert.deepEqual(preview.errors.map((row: Json) => row.row).sort(), [4, 5]);
    assert.ok(preview.errors.every((row: Json) => row.field === 'email' && row.message));
    assert.equal(page(await http('GET', `/v1/lists/${list.id}/members`, key.secret)).length, 0, 'Preview must not import contacts.');
    const committed = ok(await http('POST', `/v1/contact-imports/${preview.id}/commit`, key.secret));
    assert.equal(committed.status, 'committed');
    assert.equal(committed.imported, 2);
    assert.equal(committed.errors.length, 2);
    const again = ok(await http('POST', `/v1/contact-imports/${preview.id}/commit`, key.secret));
    assert.equal(again.id, committed.id);
    assert.equal(again.imported, 2);
    const members = page(await http('GET', `/v1/lists/${list.id}/members`, key.secret));
    assert.equal(members.length, 2);
    const imported = members.find(row => row.email === fresh);
    assert.ok(imported);
    cleanup(t, async () => { ok(await http('DELETE', `/v1/contacts/${imported.id}`, key.secret), [200, 404]); });
    assert.equal(imported.name, 'Quote "Person"');
    assert.equal(imported.marketingConsent, 'unknown');
    const retained = ok(await http('GET', `/v1/contacts/${existing.id}`, key.secret));
    assert.equal(retained.name, 'Renamed, Person');
    assert.equal(retained.marketingConsent, 'unsubscribed');
    assert.equal(page(await http('GET', `/v1/contacts/${existing.id}/consent`, key.secret)).length, 1);
    error(await http('POST', '/v1/contact-imports', key.secret, { csv: 'Email\n"unterminated', mapping: { email: 'Email' } }), 422, 'INVALID_CSV');
    error(await http('POST', '/v1/contact-imports', key.secret, { csv: 'Email\na@example.com', mapping: { email: 'Absent' } }), 422, 'INVALID_IMPORT_MAPPING');
    const exported = await allPages('/v1/contacts', key.secret);
    const exportedExisting = exported.find(row => row.id === existing.id);
    const exportedFresh = exported.find(row => row.id === imported.id);
    assert.ok(exportedExisting && exportedFresh, 'Paginated contact export must include both imported contacts.');
    assert.equal(exportedExisting.name, 'Renamed, Person');
    assert.equal(exportedFresh.name, 'Quote "Person"');
    assert.equal(exportedExisting.marketingConsent, 'unsubscribed');
    assert.equal(exportedFresh.marketingConsent, 'unknown');
    const report = ok(await http('GET', `/v1/contact-imports/${preview.id}`, key.secret));
    assert.equal(report.status, 'committed');
    assert.deepEqual(report.errors.map((row: Json) => ({ row: row.row, field: row.field })), preview.errors.map((row: Json) => ({ row: row.row, field: row.field })), 'The committed import must retain a downloadable per-row error report.');
  });
});

describe('Import property boundaries', () => {
  test('CSV merges allow 50 properties, reject the 51st, and roll back every row in a failed commit', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('property-boundary') });
    const properties = Object.fromEntries(Array.from({ length: 49 }, (_, index) => [`field${index}`, `value${index}`]));
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address(), name: 'Before import', properties });
    const boundary = ok(await http('POST', '/v1/contact-imports', key.secret, {
      csv: `Email,Plan\n${contact.email},pro\n`, mapping: { email: 'Email', plan: 'Plan' }, listId: list.id,
    }), 201);
    assert.equal(ok(await http('POST', `/v1/contact-imports/${boundary.id}/commit`, key.secret)).imported, 1);
    const atLimit = ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret));
    assert.deepEqual(atLimit.properties, { ...properties, plan: 'pro' });
    assert.equal(Object.keys(atLimit.properties).length, 50);
    const earlier = await resource(t, key.secret, '/v1/contacts', { email: address(), name: 'Must roll back', properties: { existing: true } });
    const overflow = ok(await http('POST', '/v1/contact-imports', key.secret, {
      csv: `Email,Name,Country\n${earlier.email},Changed first,US\n${contact.email},Changed second,CA\n`,
      mapping: { email: 'Email', name: 'Name', country: 'Country' }, listId: list.id,
    }), 201);
    assert.equal(overflow.errors.length, 0, 'Each CSV row is individually valid; only merging with the existing 50 properties exceeds the limit.');
    error(await http('POST', `/v1/contact-imports/${overflow.id}/commit`, key.secret), 422, 'IMPORT_PROPERTIES_INVALID');
    const unchanged = ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret));
    assert.deepEqual(unchanged.properties, atLimit.properties);
    assert.equal(unchanged.name, 'Before import');
    const rolledBack = ok(await http('GET', `/v1/contacts/${earlier.id}`, key.secret));
    assert.equal(rolledBack.name, 'Must roll back');
    assert.deepEqual(rolledBack.properties, { existing: true });
    assert.deepEqual(page(await http('GET', `/v1/lists/${list.id}/members`, key.secret)).map(row => row.id), [contact.id], 'Failed commit must also roll back membership added by earlier rows.');
    const report = ok(await http('GET', `/v1/contact-imports/${overflow.id}`, key.secret));
    assert.equal(report.status, 'preview');
    assert.equal(report.imported, 0);
    const replacement = ok(await http('POST', '/v1/contact-imports', key.secret, {
      csv: `Email,Plan\n${contact.email},enterprise\n`, mapping: { email: 'Email', plan: 'Plan' },
    }), 201);
    assert.equal(ok(await http('POST', `/v1/contact-imports/${replacement.id}/commit`, key.secret)).imported, 1);
    assert.deepEqual(ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret)).properties, { ...properties, plan: 'enterprise' }, 'Replacing a property at the 50-property boundary remains supported.');
  });
});

describe('Transactional sending, idempotency and scoped authorization', () => {
  test('sends on a simulated deployment use the provider-parity lifecycle; exact retries reuse identity and conflicts do not create mail', async t => {
    const key = await keyFixture(t);
    const liveKey = await keyFixture(t, { permissions: ['read'] });
    const payload = mail();
    const headers = { 'Idempotency-Key': unique('send') };
    const queued = ok(await http('POST', '/v1/emails/send', key.secret, payload, headers), 202);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.environment, undefined);
    assert.equal(queued.simulated, true);
    const retry = ok(await http('POST', '/v1/emails/send', key.secret, payload, headers), 202);
    assert.equal(retry.id, queued.id);
    assert.equal(retry.simulated, true);
    error(await http('POST', '/v1/emails/send', key.secret, { ...payload, subject: 'Different payload' }, headers), 409, 'IDEMPOTENCY_CONFLICT');
    const completed = await poll(`/v1/emails/${queued.id}`, key.secret, body => body.status === 'delivered');
    assert.equal(completed.simulated, true);
    assert.equal(completed.environment, undefined);
    assert.match(completed.providerId, /^sim_/, 'Simulation must return an isolated provider-shaped message ID.');
    assert.deepEqual(completed.to, [payload.to]);
    assert.equal(completed.subject, payload.subject);
    const content = ok(await http('GET', `/v1/emails/${queued.id}/content`, key.secret));
    assert.equal(content.text, payload.text);
    assert.equal(content.simulated, true);
    const events = page(await http('GET', `/v1/emails/${queued.id}/events`, key.secret));
    for (const type of ['dispatch_attempt', 'accepted', 'send', 'delivery']) assert.equal(events.filter(event => event.type === type).length, 1, 'Exact retry must not duplicate lifecycle events.');
    assert.ok(events.every(event => event.simulated && event.environment === undefined));
    assert.ok(events.every(event => event.providerId === null || /^sim_/.test(event.providerId)));
    ok(await http('GET', `/v1/emails/${queued.id}`, liveKey.secret));
    const testMetrics = ok(await http('GET', '/v1/metrics', key.secret));
    const liveMetrics = ok(await http('GET', '/v1/metrics', liveKey.secret));
    assert.ok(testMetrics.totals.simulated >= 1, 'Test metrics must count the persisted simulated lifecycle.');
    assert.equal(liveMetrics.totals.simulated, testMetrics.totals.simulated);
    const messages = await allPages('/v1/emails', key.secret);
    assert.equal(messages.filter(message => message.subject === payload.subject).length, 1);
  });

  test('read-only scope, sender-domain restrictions, malformed input and unconfigured regions are rejected', async t => {
    const reader = await keyFixture(t, { permissions: ['read'] });
    const sender = await keyFixture(t, { permissions: ['send'], domains: ['allowed.example.com'] });
    error(await http('POST', '/v1/emails/send', reader.secret, mail()), 403, 'PERMISSION_DENIED');
    const denied = error(await http('POST', '/v1/emails/send', sender.secret, mail()), 403, 'SENDER_DOMAIN_FORBIDDEN');
    assert.equal(denied.field, 'from');
    error(await http('POST', '/v1/emails/send', sender.secret, mail({ from: 'sender@allowed.example.com', region: 'not-a-configured-region' })), 422, 'REGION_NOT_CONFIGURED');
    error(await http('POST', '/v1/emails/send', sender.secret, mail({ from: 'sender@allowed.example.com', to: 'invalid' })), 422);
    error(await http('POST', '/v1/emails/send', sender.secret, mail({ from: 'sender@allowed.example.com', subject: 'Header\r\nBcc: victim@example.com' })), 422);
    const allowed = ok(await http('POST', '/v1/emails/send', sender.secret, mail({ from: 'sender@allowed.example.com' })), 202);
    assert.equal(allowed.simulated, true);
    error(await http('GET', `/v1/emails/${allowed.id}`, sender.secret), 403, 'PERMISSION_DENIED');
  });

  test('batch results retain individual IDs and retries, while test templates are rejected without AWS rendering', async t => {
    const key = await keyFixture(t);
    const payload = { emails: [mail(), mail()] };
    const headers = { 'Idempotency-Key': unique('batch') };
    const first = ok(await http('POST', '/v1/emails/batch', key.secret, payload, headers), 202);
    assert.equal(first.data.length, 2);
    assert.equal(new Set(first.data.map((row: Json) => row.id)).size, 2);
    assert.ok(first.data.every((row: Json) => row.simulated && row.environment === undefined));
    const retry = ok(await http('POST', '/v1/emails/batch', key.secret, payload, headers), 202);
    assert.deepEqual(retry.data.map((row: Json) => row.id), first.data.map((row: Json) => row.id));
    for (const item of first.data) await poll(`/v1/emails/${item.id}`, key.secret, body => body.status === 'delivered');
    error(await http('POST', '/v1/emails/batch', key.secret, { emails: [] }), 422);
    error(await http('POST', '/v1/emails/send', key.secret, { from: 'sender@example.com', to: address(), region: REGION, template: { name: unique('missing-template'), data: { firstName: '<script>safe</script>' } } }), 422, 'SIMULATED_TEMPLATE_UNSUPPORTED');
  });
});

describe('Private attachment assets and campaign revisions', () => {
  test('uploads persist safe metadata, reject unsafe/oversized inputs, and share access within the workspace', async t => {
    const key = await keyFixture(t);
    const live = await keyFixture(t, { permissions: ['read', 'send'] });
    const bytes = Buffer.from('Acceptance attachment\n', 'utf8');
    const attachment = await resource(t, key.secret, '/v1/attachments', { filename: 'acceptance.txt', contentType: 'text/plain', content: bytes.toString('base64') });
    assert.equal(attachment.size, bytes.length);
    assert.equal(attachment.environment, undefined);
    const stored = ok(await http('GET', `/v1/attachments/${attachment.id}`, key.secret));
    assert.equal(stored.filename, 'acceptance.txt');
    assert.equal(stored.size, bytes.length);
    for (const field of ['content', 'url', 'publicUrl', 'storageKey']) assert.equal(stored[field], undefined, `Attachment metadata must not expose ${field}.`);
    ok(await http('GET', `/v1/attachments/${attachment.id}`, live.secret));
    const reader = await keyFixture(t, { permissions: ['read'] });
    const downloaded = await http('GET', `/v1/attachments/${attachment.id}/content`, reader.secret);
    assert.equal(ok(downloaded).content, bytes.toString('base64'));
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(downloaded.headers.get('cache-control'), 'no-store');
    assert.equal(downloaded.body.storageKey, undefined);
    ok(await http('GET', `/v1/attachments/${attachment.id}/content`, live.secret));
    error(await http('GET', `/v1/attachments/${attachment.id}/content`), 401, 'AUTH_REQUIRED');
    const liveAsset = await resource(t, live.secret, '/v1/attachments', { filename: 'production-fixture.txt', content: bytes.toString('base64') });
    assert.equal(ok(await http('GET', `/v1/attachments/${liveAsset.id}`, key.secret)).id, liveAsset.id);
    error(await http('POST', '/v1/emails/send', key.secret, mail({ attachments: [unique('attachment-missing')] })), 404, 'ATTACHMENT_NOT_FOUND');
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'unsafe.exe', content: bytes.toString('base64') }), 422, 'UNSUPPORTED_ATTACHMENT_TYPE');
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'bad.txt', content: '!!!!' }), 422, 'INVALID_BASE64');
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'inline.png', content: bytes.toString('base64'), disposition: 'inline' }), 422, 'INLINE_ATTACHMENT_INVALID');
    // Only size and SES's banned extensions are checked: any type, MIME-wrapped base64, URL-safe alphabets and unpadded input all decode.
    const wrapped = ok(await http('POST', '/v1/attachments', key.secret, { filename: 'report.tar.gz', contentType: 'image/jpg', content: bytes.toString('base64').match(/.{1,4}/g)!.join('\r\n') + '\n' }), 201);
    cleanup(t, async () => { ok(await http('DELETE', `/v1/attachments/${wrapped.id}`, key.secret), [200, 404]); });
    assert.equal(wrapped.size, bytes.length); assert.equal(wrapped.contentType, 'image/jpg');
    assert.equal(ok(await http('GET', `/v1/attachments/${wrapped.id}/content`, key.secret)).content, bytes.toString('base64'));
    const urlSafe = ok(await http('POST', '/v1/attachments', key.secret, { filename: 'binary.bin', content: Buffer.from([0xfb, 0xff, 0xbf, 0xfe, 0x01]).toString('base64url') }), 201);
    cleanup(t, async () => { ok(await http('DELETE', `/v1/attachments/${urlSafe.id}`, key.secret), [200, 404]); });
    assert.equal(ok(await http('GET', `/v1/attachments/${urlSafe.id}/content`, key.secret)).content, Buffer.from([0xfb, 0xff, 0xbf, 0xfe, 0x01]).toString('base64'));
    for (const content of ['QUJDR', 'QUJD\x01RA==', 'QUJD====', 'data:text/plain;base64,QUJDRA==']) error(await http('POST', '/v1/attachments', key.secret, { filename: 'bad.txt', content }), 422, 'INVALID_BASE64');
    const calendar = Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n');
    const upload = async (filename: string, contentType: string, content: Buffer, extra: Record<string, string> = {}) => {
      const response = await fetch(`${BASE}/v1/attachments/upload`, { method: 'POST', headers: { authorization: `Bearer ${key.secret}`, 'content-type': contentType, 'x-opensend-filename': encodeURIComponent(filename), ...extra }, body: Uint8Array.from(content).buffer });
      return { status: response.status, body: await response.json(), headers: response.headers } satisfies Reply;
    };
    const raw = ok(await upload('invite.ics', 'text/calendar; method=REQUEST; charset=utf-8', calendar), 201);
    cleanup(t, async () => { ok(await http('DELETE', `/v1/attachments/${raw.id}`, key.secret), [200, 404]); });
    assert.equal(raw.contentType, 'text/calendar; method=REQUEST; charset=utf-8');
    assert.equal(ok(await http('GET', `/v1/attachments/${raw.id}/content`, key.secret)).content, calendar.toString('base64'));
    error(await upload('unsafe.vbs', 'text/plain', bytes), 422, 'UNSUPPORTED_ATTACHMENT_TYPE');
    error(await upload('inline.pdf', 'application/pdf', Buffer.from('%PDF-1.7'), { 'x-opensend-disposition': 'inline' }), 422, 'INLINE_ATTACHMENT_INVALID');
    // 8 MiB + 1 stays within the base64 character ceiling but exceeds the decoded cap.
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'oversize.txt', content: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }, {}, 10_000), 413, 'ATTACHMENT_LIMIT_EXCEEDED');
    assert.equal(ok(await http('DELETE', `/v1/attachments/${attachment.id}`, key.secret)).deleted, true);
    error(await http('GET', `/v1/attachments/${attachment.id}`, key.secret), 404, 'ATTACHMENT_NOT_FOUND');
  });

  test('sending freezes the audience at launch and existing schedule/cancel contracts hold', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('async-review-list') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address(), properties: { firstName: 'Reviewed name' } });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const campaign = await campaignFixture(t, key.secret, { listId: list.id });
    assert.deepEqual(ok(await http('GET', `/v1/campaigns/${campaign.id}/audience`, key.secret)), { matched: 1, eligible: 1, suppressed: 0, unsubscribed: 0 });
    const sent = ok(await http('POST', `/v1/campaigns/${campaign.id}/send`, key.secret, { revision: campaign.revision }), 202);
    assert.equal(sent.state, 'preparing');
    assert.equal(sent.queued, 1);
    assert.equal(sent.scheduledAt, null);
    // The audience and personalization are frozen by the send; later contact edits never reach the message.
    ok(await http('PATCH', `/v1/contacts/${contact.id}`, key.secret, { properties: { firstName: 'Later name' } }));
    const done = await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => row.state === 'done');
    assert.equal(done.delivery.total, 1);
    assert.equal(done.delivery.prepared, 1);
    assert.equal(done.delivery.expanded, 1);
    assert.equal(done.delivery.error, null);
    const [email] = await allPages(`/v1/emails?campaignId=${campaign.id}`, key.secret);
    assert.ok(email);
    const content = ok(await http('GET', `/v1/emails/${email.id}/content`, key.secret));
    assert.ok(content.html.includes('Reviewed name'), 'Delivery must use the frozen personalization, not later contact edits.');
    assert.ok(!content.html.includes('Later name'));
    error(await http('POST', `/v1/campaigns/${campaign.id}/cancel`, key.secret), 409, 'CAMPAIGN_ALREADY_DISPATCHED');
    const later = await campaignFixture(t, key.secret, { listId: list.id });
    const scheduled = ok(await http('POST', `/v1/campaigns/${later.id}/schedule`, key.secret, { revision: later.revision, scheduledAt: new Date(Date.now() + 3600000).toISOString() }), 202);
    assert.equal(scheduled.state, 'preparing');
    assert.equal(scheduled.queued, 1);
    const waiting = await poll(`/v1/campaigns/${later.id}`, key.secret, row => row.state === 'scheduled');
    assert.equal(waiting.delivery.prepared, 1);
    assert.equal(waiting.delivery.expanded, 0, 'Future schedules reserve recipients without materializing email rows.');
    const canceled = ok(await http('POST', `/v1/campaigns/${later.id}/cancel`, key.secret));
    assert.equal(canceled.state, 'canceled');
    assert.equal(canceled.canceled, 1);
    assert.equal((await allPages(`/v1/emails?campaignId=${later.id}`, key.secret)).length, 0);
    assert.equal(ok(await http('GET', `/v1/campaigns/${later.id}`, key.secret)).delivery.canceled, 1);
    assert.deepEqual(ok(await http('POST', `/v1/campaigns/${later.id}/cancel`, key.secret)), { id: later.id, state: 'canceled', canceled: 0, inFlight: 0 }, 'Cancel is idempotent.');
  });

  test('campaign send snapshots, validates and dispatches; a failed launch is edited or launched again', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('automatic-review-list') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address(), properties: { firstName: 'Automatic reader' } });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const campaign = await campaignFixture(t, key.secret, { listId: list.id });
    const preview = ok(await http('GET', `/v1/campaigns/${campaign.id}/preview`, key.secret));
    assert.ok(preview.html.includes('Hello'));
    const accepted = ok(await http('POST', `/v1/campaigns/${campaign.id}/send`, key.secret, { revision: campaign.revision }), 202);
    assert.equal(accepted.state, 'preparing');
    assert.equal(accepted.queued, 1);
    const completed = await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => row.state === 'failed' || row.counts.byStatus.delivered === 1);
    assert.equal(completed.state, 'done', 'Done means dispatch finished; delivery feedback follows.');
    assert.equal(completed.counts.byStatus.delivered, 1);
    const invalid = await campaignFixture(t, key.secret, { listId: list.id }, { html: '<p>Hello {{missing}}</p>', defaults: {} });
    const invalidAccepted = ok(await http('POST', `/v1/campaigns/${invalid.id}/send`, key.secret, { revision: invalid.revision }), 202);
    assert.equal(invalidAccepted.queued, 1);
    const failed = await poll(`/v1/campaigns/${invalid.id}`, key.secret, row => ['done', 'failed'].includes(row.state));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.delivery.error.code, 'MISSING_TEMPLATE_VARIABLE');
    assert.equal(failed.delivery.prepared, 0);
    assert.equal(failed.counts.total, 0);
    assert.equal(failed.url, invalid.url, 'A failed campaign opens in the editor again.');
    // Launching the same revision again retries from a fresh snapshot; it fails the same way.
    ok(await http('POST', `/v1/campaigns/${invalid.id}/send`, key.secret, { revision: invalid.revision }), 202);
    assert.equal((await poll(`/v1/campaigns/${invalid.id}`, key.secret, row => ['done', 'failed'].includes(row.state))).state, 'failed');
    const corrected = ok(await http('PATCH', `/v1/campaigns/${invalid.id}`, key.secret, { revision: invalid.revision, draft: { ...invalid.draft, html: '<p>Corrected automatic message</p>' } }));
    assert.equal(corrected.state, 'draft');
    assert.equal(corrected.delivery, null, 'A new revision clears the failed launch.');
    ok(await http('POST', `/v1/campaigns/${invalid.id}/send`, key.secret, { revision: corrected.revision }), 202);
    const retried = await poll(`/v1/campaigns/${invalid.id}`, key.secret, row => row.state === 'failed' || row.counts.byStatus.delivered === 1);
    assert.equal(retried.state, 'done');
    assert.equal(retried.counts.byStatus.delivered, 1);
    const scheduled = await campaignFixture(t, key.secret, { listId: list.id });
    ok(await http('GET', `/v1/campaigns/${scheduled.id}/preview`, key.secret));
    const scheduledAccepted = ok(await http('POST', `/v1/campaigns/${scheduled.id}/schedule`, key.secret, { revision: scheduled.revision, scheduledAt: new Date(Date.now() + 3600000).toISOString() }), 202);
    assert.equal(scheduledAccepted.state, 'preparing');
    const canceled = ok(await http('POST', `/v1/campaigns/${scheduled.id}/cancel`, key.secret));
    assert.equal(canceled.state, 'canceled');
    assert.equal(canceled.canceled, 1);
    assert.equal((await allPages(`/v1/emails?campaignId=${scheduled.id}`, key.secret)).length, 0);
  });

  test('a failed launch and a superseded revision cannot deliver; edits are refused while launched', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('async-invalid-list') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const campaign = await campaignFixture(t, key.secret, { listId: list.id }, { html: '<p>Hello {{missing}}</p>', defaults: {} });
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: campaign.revision, scheduledAt: new Date(Date.now() + 3600000).toISOString() }), 202);
    const failed = await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => ['scheduled', 'failed'].includes(row.state));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.delivery.error.code, 'MISSING_TEMPLATE_VARIABLE');
    assert.equal(failed.scheduledAt, null, 'A failed launch keeps no schedule.');
    error(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: campaign.revision + 1, scheduledAt: new Date(Date.now() + 3600000).toISOString() }), 409, 'STALE_CAMPAIGN_REVISION');
    const updated = ok(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, subject: 'Corrected subject', html: '<p>Corrected message</p>' } }));
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: updated.revision, scheduledAt: new Date(Date.now() + 3600000).toISOString() }), 202);
    await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => row.state === 'scheduled');
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: updated.revision, draft: { ...updated.draft, subject: 'Changed after launch' } }), 409, 'CAMPAIGN_LOCKED');
    error(await http('POST', `/v1/campaigns/${campaign.id}/send`, key.secret, { revision: updated.revision }), 409, 'CAMPAIGN_LOCKED');
    assert.equal((await allPages(`/v1/emails?campaignId=${campaign.id}`, key.secret)).length, 0);
  });

  test('stale revisions, attachment removal, scheduling and cancellation are observable', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('campaign-list') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address(), name: 'Name {{literal}}', properties: { firstName: '<Ada {{ & Bob>' } });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const attachment = ok(await http('POST', '/v1/attachments', key.secret, { filename: 'draft.txt', content: Buffer.from('draft attachment').toString('base64') }), 201);
    const campaign = await campaignFixture(t, key.secret, { listId: list.id }, { attachments: [attachment.id], html: '<p>Hello {{name}} / {{firstName}}</p>' });
    assert.equal(campaign.state, 'draft');
    assert.equal(campaign.revision, 1);
    assert.equal(campaign.delivery, null);
    error(await http('DELETE', `/v1/attachments/${attachment.id}`, key.secret), 409, 'ATTACHMENT_IN_USE');
    ok(await http('PATCH', `/v1/contacts/${contact.id}`, key.secret, { properties: { firstName: 'Ada\r\nBcc: victim@example.com' } }));
    ok(await http('POST', `/v1/campaigns/${campaign.id}/send`, key.secret, { revision: campaign.revision }), 202);
    const invalidRecipient = await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => ['done', 'failed'].includes(row.state));
    assert.equal(invalidRecipient.state, 'failed');
    assert.equal(invalidRecipient.delivery.error.code, 'CAMPAIGN_RECIPIENT_INVALID');
    assert.equal(invalidRecipient.counts.total, 0);
    ok(await http('PATCH', `/v1/contacts/${contact.id}`, key.secret, { properties: contact.properties }));
    const draft = { ...campaign.draft, subject: 'Revised {{firstName}}', attachments: [] };
    const updated = ok(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: 1, draft }));
    assert.equal(updated.revision, 2);
    assert.equal(updated.state, 'draft');
    assert.equal(updated.delivery, null);
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: 1, draft }), 409, 'STALE_CAMPAIGN_REVISION');
    error(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: 1, scheduledAt: new Date(Date.now() + 60_000).toISOString() }), 409, 'STALE_CAMPAIGN_REVISION');
    error(await http('DELETE', `/v1/attachments/${attachment.id}`, key.secret), 409, 'ATTACHMENT_IN_USE');
    error(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: 2, scheduledAt: new Date(Date.now() - 1000).toISOString() }), 422, 'INVALID_SCHEDULE');
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: 2, scheduledAt }), 202);
    assert.equal(scheduled.state, 'preparing');
    assert.equal(scheduled.queued, 1);
    assert.equal(scheduled.simulated, true);
    assert.equal(Date.parse(scheduled.scheduledAt), Date.parse(scheduledAt));
    const scheduledCampaign = await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => row.state === 'scheduled');
    assert.equal(scheduledCampaign.delivery.total, 1);
    assert.equal(scheduledCampaign.delivery.expanded, 0, 'Future schedules reserve recipients without materializing email rows.');
    assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret)), []);
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: 2, draft }), 409, 'CAMPAIGN_LOCKED');
    error(await http('PATCH', `/v1/campaigns/${campaign.id}/archive`, key.secret, { archived: true }), 409, 'CAMPAIGN_ACTIVE');
    const canceled = ok(await http('POST', `/v1/campaigns/${campaign.id}/cancel`, key.secret));
    assert.equal(canceled.state, 'canceled');
    assert.equal(canceled.canceled, 1);
    assert.equal(canceled.inFlight, 0);
    assert.equal(ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret)).state, 'canceled');
    error(await http('POST', `/v1/campaigns/${campaign.id}/pause`, key.secret, {}), 409, 'CAMPAIGN_NOT_SENDING');
  });
});

describe('Dashboard API capabilities', () => {
  test('campaign state is compact, scoped and tracks draft, archive and delivery changes without sending', async t => {
    const db = await fixtureDatabase(t);
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const sender = await keyFixture(t, { permissions: ['send'] });
    const live = await keyFixture(t, { permissions: ['read'] });
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('state-audience') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const campaign = await campaignFixture(t, key.secret, { listId: list.id }, {
      html: `<p>${'x'.repeat(80 * 1024)}</p>`,
    });
    const path = `/v1/campaigns/${campaign.id}`;
    cleanup(t, async () => {
      await db.query("UPDATE sending_campaigns SET state = 'draft', review_id = NULL, total = 0, prepared = 0, expanded = 0, canceled = 0, paused_at = NULL, scheduled_at = NULL, archived_at = NULL WHERE id = $1 AND workspace_id = $2", [campaign.id, list.workspaceId]);
    });
    const stateFields = ['id', 'revision', 'updatedAt', 'state', 'scheduledAt', 'archivedAt'];
    const project = (value: Json) => Object.fromEntries(stateFields.map(field => [field, value[field]]));
    const initial = await http('GET', `${path}/state`, reader.secret);
    assert.deepEqual(ok(initial), project(campaign));
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.byteLength(JSON.stringify(initial.body)) < 1000, 'Polling must not transfer draft bodies or counts.');
    assert.deepEqual(ok(await http('GET', path, reader.secret)), campaign, 'The full campaign read must remain unchanged.');
    error(await http('GET', `${path}/state`), 401, 'AUTH_REQUIRED');
    error(await http('GET', `${path}/state`, 'not-a-valid-key'), 401);
    error(await http('GET', `${path}/state`, sender.secret), 403, 'PERMISSION_DENIED');
    ok(await http('GET', `${path}/state`, live.secret));
    error(await http('GET', `/v1/campaigns/${unique('missing')}/state`, reader.secret), 404, 'NOT_FOUND');
    const foreignId = unique('foreign-campaign'), foreignWorkspace = unique('foreign-workspace');
    cleanup(t, async () => { await db.query("DELETE FROM sending_campaigns WHERE id = $1 AND workspace_id = $2", [foreignId, foreignWorkspace]); });
    await db.query("INSERT INTO sending_campaigns (id, workspace_id, draft) VALUES ($1,$2,$3::jsonb)", [foreignId, foreignWorkspace, JSON.stringify(campaign.draft)]);
    error(await http('GET', `/v1/campaigns/${foreignId}/state`, reader.secret), 404, 'NOT_FOUND');

    const archived = ok(await http('PATCH', `${path}/archive`, key.secret, { archived: true }));
    const archivedState = ok(await http('GET', `${path}/state`, reader.secret));
    assert.deepEqual(archivedState, project(archived));
    assert.equal(archivedState.revision, campaign.revision);
    assert.equal(archivedState.state, 'draft');
    assert.equal(typeof archivedState.archivedAt, 'string');
    assert.notDeepEqual(archivedState, initial.body, 'Archive changes must be visible even without a draft revision change.');
    const restored = ok(await http('PATCH', `${path}/archive`, key.secret, { archived: false }));
    assert.deepEqual(ok(await http('GET', `${path}/state`, reader.secret)), project(restored));
    assert.equal(restored.archivedAt, null);
    const updated = ok(await http('PATCH', path, key.secret, { revision: restored.revision, draft: { ...restored.draft, subject: 'Updated externally' } }));
    const updatedState = ok(await http('GET', `${path}/state`, reader.secret));
    assert.deepEqual(updatedState, project(updated));
    assert.equal(updatedState.revision, campaign.revision + 1);
    assert.equal(updatedState.state, 'draft');

    // Seed only state, never emails or jobs, to exercise each delivery lifecycle value.
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const reviewId = unique('state-review');
    await db.query("INSERT INTO sending_campaign_reviews (id, workspace_id, campaign_id, revision, draft, content_hash) VALUES ($1,$2,$3,$4,$5::jsonb,'synthetic')", [reviewId, list.workspaceId, campaign.id, updated.revision, JSON.stringify(updated.draft)]);
    cleanup(t, async () => { await db.query('DELETE FROM sending_campaign_reviews WHERE id = $1', [reviewId]); });
    for (const state of ['preparing', 'scheduled', 'sending', 'paused', 'done', 'failed', 'canceled']) {
      const seeded = await db.query("UPDATE sending_campaigns SET state = $1, review_id = $5, total = 1, prepared = CASE WHEN $1 = 'preparing' THEN 0 ELSE 1 END, expanded = CASE WHEN $1 IN ('sending','done') THEN 1 ELSE 0 END, paused_at = CASE WHEN $1 = 'paused' THEN now() END, scheduled_at = $2, updated_at = updated_at + interval '1 second' WHERE id = $3 AND workspace_id = $4 RETURNING id", [state, scheduledAt, campaign.id, list.workspaceId, reviewId]);
      assert.equal(seeded.rowCount, 1);
      const polled = ok(await http('GET', `${path}/state`, reader.secret));
      const full = ok(await http('GET', path, reader.secret));
      assert.deepEqual(polled, project(full));
      assert.equal(polled.state, state);
      assert.equal(polled.revision, updatedState.revision);
      assert.equal(Date.parse(polled.scheduledAt), Date.parse(scheduledAt));
      assert.ok(Date.parse(polled.updatedAt) > Date.parse(updatedState.updatedAt));
      assert.equal(full.delivery.total, 1);
      assert.equal(full.url, `${PUBLIC_ORIGIN}/campaigns/${campaign.id}/${state === 'failed' ? 'edit' : 'review'}`);
    }
    assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, reader.secret)), []);
  });

  test('campaign content is block HTML: the guide, validation errors, preview rendering and text alternative are observable', async t => {
    const [{ sanitizeBlockStyle: serverStyle }, { sanitizeBlockStyle: composerStyle }] = await Promise.all([import('./src/block-style.js'), import('../app/src/features/campaigns/block-style.js')]);
    for (const value of ['color:#3156c7; padding:24px; border-radius:8px', 'font-size:32px;line-height:1.2;', 'position:absolute', 'background-image:url(https://example.com/x.png)', 'padding:200px']) assert.equal(composerStyle(value), serverStyle(value), `Composer and renderer style sanitizers disagree for ${value}`);
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('block-content') });
    const guide = ok(await http('GET', '/v1/campaign-content-guide', key.secret));
    assert.equal(guide.format, 'markdown');
    assert.ok(guide.markdown.includes('data-button') && guide.markdown.includes('data-columns'), 'The guide documents the block vocabulary.');
    const blocks = '<section style="background-color:#f4f4f4;padding:24px;border-radius:8px;"><h1 style="font-size:32px;line-height:1.2;">Hello {{name}}</h1><p align="center" style="color:#3156c7;">Read <a href="https://example.com/{{email}}">this</a>.</p></section><ul><li>One</li><li><p>Two</p></li></ul><img src="https://cdn.example.com/a.png" alt="Art" width="560" style="border-radius:8px;"><a data-button href="https://example.com/go" align="center" style="background-color:#3156c7;border-radius:8px;">Go</a><hr><div data-columns="2"><div data-column style="background-color:#f4f4f4;padding:16px;"><p>Left</p></div><div data-column><p>Right</p></div></div>';
    const campaign = await campaignFixture(t, key.secret, { listId: list.id }, { html: blocks });
    const path = `/v1/campaigns/${campaign.id}`;
    assert.equal(campaign.draft.html, blocks, 'Block HTML is stored verbatim.');
    assert.equal(campaign.draft.editor, undefined, 'No separate editor document exists.');
    for (const [html, fragment] of [
      ['<div style="max-width:560px"><p>Wrapped</p></div>', '<div>'],
      ['<p class="lead">Classy</p>', 'class'],
      ['<table><tr><td>Cell</td></tr></table>', '<table>'],
      ['<html><body><p>Doc</p></body></html>', 'wrappers'],
      ['<p><a href="javascript:alert(1)">x</a></p>', 'href'],
      ['<img src="data:image/png;base64,AAAA">', 'src'],
      ['<div data-columns="3"><div data-column><p>a</p></div></div>', 'data-columns'],
      ['<p onclick="x()">Handler</p>', 'onclick'],
      ['<p style="position:absolute">Positioned</p>', 'style'],
      ['<section style="background-image:url(https://example.com/x.png)"><p>Tracked</p></section>', 'style'],
      ['<div data-columns="2" style="padding:16px"><div data-column><p>A</p></div><div data-column><p>B</p></div></div>', 'style'],
    ] as const) {
      const rejected = error(await http('PATCH', path, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, html } }), 422, 'CAMPAIGN_CONTENT_INVALID');
      assert.ok(rejected.message.includes(fragment) && rejected.message.includes('getContentGuide'), `Rejection for ${html} names ${fragment}: ${rejected.message}`);
    }
    error(await http('PATCH', path, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, editor: { format: 'react-email', version: 1, document: {} } } }), 422, 'VALIDATION_FAILED');
    assert.deepEqual(ok(await http('GET', path, key.secret)), campaign, 'Rejected content never changes the draft.');

    const preview = ok(await http('GET', `${path}/preview`, key.secret));
    assert.ok(preview.html.startsWith('<!DOCTYPE html>') && preview.html.includes('max-width:600px'), 'Preview renders a complete styled document.');
    assert.ok(preview.html.includes('Hello {{name}}') && preview.html.includes('href="https://example.com/{{email}}"'), 'Preview keeps placeholders visible.');
    assert.ok(preview.html.includes('role="presentation"') && preview.html.includes('>Go</a>'), 'Buttons and columns render as presentation tables.');
    assert.ok(!preview.html.includes('data-button') && !preview.html.includes('data-columns') && !preview.html.includes('<section'), 'Rendered output contains no block markers.');
    assert.ok(preview.html.includes('font-size:32px') && preview.html.includes('background-color:#3156c7') && preview.html.includes('border-radius:8px'), 'Email-safe advanced styles survive rendering.');
    assert.ok(!preview.html.includes('Unsubscribe'), 'Preview omits the unsubscribe footer.');
    assert.equal(preview.text, 'Hello {{name}}\n\nRead this (https://example.com/{{email}}).\n\n- One\n- Two\n\n[Art] https://cdn.example.com/a.png\n\nGo: https://example.com/go\n\n----------\n\nLeft\n\nRight');

    const contact = await resource(t, key.secret, '/v1/contacts', { email: address(), name: 'Block Reader' });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    ok(await http('POST', `${path}/send`, key.secret, { revision: campaign.revision }), 202);
    await poll(path, key.secret, row => row.state === 'done');
    const [message] = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret));
    const content = ok(await http('GET', `/v1/emails/${message.id}/content`, key.secret));
    assert.ok(content.html.includes('Hello Block Reader') && content.html.includes(`href="https://example.com/${contact.email}"`), 'Rendered email is personalized.');
    assert.ok(/<a href="[^"]+" style="[^"]*">Unsubscribe<\/a><\/p><\/td>/.test(content.html), 'The unsubscribe footer sits inside the rendered layout.');
    assert.ok(content.text.startsWith('Hello Block Reader') && content.text.includes('\n\nUnsubscribe: '), 'A plain-text alternative is derived from the blocks.');
  });

  test('campaign archive filters lists, binds pagination and restores failed launches unchanged', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('archive-audience') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const marker = unique('archive');
    const reviewed: Json[] = [];
    for (let index = 0; index < 2; index++) {
      // A failed launch keeps its frozen snapshot, cursors and error; archiving must preserve all of it.
      const campaign = await campaignFixture(t, key.secret, { listId: list.id }, { name: `${marker} %_\\literal ${index}`, html: '<p>Hello {{missing}}</p>', defaults: {} });
      cleanup(t, async () => { ok(await http('PATCH', `/v1/campaigns/${campaign.id}/archive`, key.secret, { archived: false })); });
      assert.equal(campaign.archivedAt, null);
      const revised = ok(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, previewText: 'Retain this revision' } }));
      ok(await http('POST', `/v1/campaigns/${campaign.id}/send`, key.secret, { revision: revised.revision }), 202);
      const current = await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => ['done', 'failed'].includes(row.state));
      assert.equal(current.state, 'failed');
      assert.equal(current.delivery.error.code, 'MISSING_TEMPLATE_VARIABLE');
      reviewed.push(current);
    }
    const visible = await campaignFixture(t, key.secret, { listId: list.id }, { name: `${marker} ZZZliteral` });
    const activePath = `/v1/campaigns?search=${encodeURIComponent(marker)}`;
    assert.equal(page(await http('GET', activePath, key.secret)).length, 3);
    for (const before of reviewed) {
      const path = `/v1/campaigns/${before.id}`;
      const archived = ok(await http('PATCH', `${path}/archive`, key.secret, { archived: true }));
      assert.equal(typeof archived.archivedAt, 'string');
      assert.ok(Number.isFinite(Date.parse(archived.archivedAt)));
      assert.deepEqual({ ...archived, archivedAt: before.archivedAt, updatedAt: before.updatedAt }, before, 'Archive must preserve the complete draft, revision, delivery, state and counts.');
      assert.deepEqual(ok(await http('PATCH', `${path}/archive`, key.secret, { archived: true })), archived, 'Repeated archive must keep the original timestamp.');
      assert.deepEqual(ok(await http('GET', path, key.secret)), archived);
      error(await http('PATCH', path, key.secret, { revision: before.revision, draft: before.draft }), 409, 'CAMPAIGN_ARCHIVED');
      error(await http('DELETE', path, key.secret), 409, 'CAMPAIGN_ARCHIVED');
      // These calls must reject before queueing, including tests that have no campaignId in their email record.
      error(await http('POST', `${path}/send`, key.secret, { revision: before.revision }), 409, 'CAMPAIGN_ARCHIVED');
      error(await http('POST', `${path}/schedule`, key.secret, { revision: before.revision, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), 409, 'CAMPAIGN_ARCHIVED');
      error(await http('POST', `${path}/test`, key.secret, { to: contact.email }), 409, 'CAMPAIGN_ARCHIVED');
      assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${before.id}`, key.secret)), []);
      assert.deepEqual(ok(await http('GET', path, key.secret)), archived, 'Rejected writes must leave the archived record intact.');
    }
    assert.deepEqual(page(await http('GET', `/v1/emails?search=${encodeURIComponent(contact.email)}`, key.secret)), [], 'Archived send, schedule and test must not queue any recipient email.');
    for (const suffix of ['', '&archived=false', '&state=draft', `&region=${REGION}`]) {
      assert.deepEqual(page(await http('GET', `${activePath}${suffix}`, key.secret)).map(row => row.id), [visible.id]);
    }
    const query = new URLSearchParams({ search: `${marker} %_\\literal`, state: 'failed', region: REGION, archived: 'true', limit: '1' });
    const first = await http('GET', `/v1/campaigns?${query}`, key.secret);
    assert.equal(page(first).length, 1);
    assert.equal(typeof first.body.nextCursor, 'string');
    query.set('cursor', first.body.nextCursor);
    const second = await http('GET', `/v1/campaigns?${query}`, key.secret);
    assert.equal(page(second).length, 1);
    assert.equal(second.body.nextCursor, null);
    const summaries = [...first.body.data, ...second.body.data];
    assert.deepEqual(summaries.map((row: Json) => row.id).sort(), reviewed.map(row => row.id).sort());
    assert.ok(summaries.every((row: Json) => typeof row.archivedAt === 'string' && row.state === 'failed' && row.delivery.error.code === 'MISSING_TEMPLATE_VARIABLE' && row.draft.region === REGION && row.draft.html === undefined));
    for (const [filter, value] of [['archived', 'false'], ['state', 'draft'], ['search', marker], ['region', REGION === 'us-east-1' ? 'us-west-2' : 'us-east-1']]) {
      const changed = new URLSearchParams(query);
      changed.set(filter, value);
      error(await http('GET', `/v1/campaigns?${changed}`, key.secret), 422, 'INVALID_CURSOR');
    }
    assert.deepEqual(page(await http('GET', `${activePath}&archived=true&state=draft`, key.secret)), []);
    for (const before of reviewed) {
      const restored = ok(await http('PATCH', `/v1/campaigns/${before.id}/archive`, key.secret, { archived: false }));
      assert.deepEqual({ ...restored, updatedAt: before.updatedAt }, before);
      assert.deepEqual(ok(await http('PATCH', `/v1/campaigns/${before.id}/archive`, key.secret, { archived: false })), restored);
    }
    assert.deepEqual(page(await http('GET', activePath, key.secret)).map(row => row.id).sort(), [...reviewed.map(row => row.id), visible.id].sort());
    assert.deepEqual(page(await http('GET', `${activePath}&archived=true`, key.secret)), []);
  });

  test('campaign archive enforces validation, authorization and active-status guards without sending', async t => {
    const db = await fixtureDatabase(t);
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const sender = await keyFixture(t, { permissions: ['send'] });
    const restricted = await keyFixture(t, { permissions: ['read', 'send'], domains: ['allowed.example.com'] });
    const live = await keyFixture(t, { permissions: ['read', 'send'] });
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('archive-guards') });
    const campaign = await campaignFixture(t, key.secret, { listId: list.id });
    const path = `/v1/campaigns/${campaign.id}`;
    cleanup(t, async () => {
      ok(await http('PATCH', `${path}/archive`, key.secret, { archived: false }));
      await db.query("UPDATE sending_campaigns SET state = 'draft', review_id = NULL, total = 0, prepared = 0, expanded = 0, paused_at = NULL WHERE id = $1 AND workspace_id = $2", [campaign.id, list.workspaceId]);
    });
    for (const body of [{}, { archived: 'true' }, { archived: null }, { archived: 1 }, { archived: true, revision: 1 }]) error(await http('PATCH', `${path}/archive`, key.secret, body), 422);
    for (const value of ['1', 'TRUE', 'all', '']) error(await http('GET', `/v1/campaigns?archived=${value}`, key.secret), 422);
    error(await http('PATCH', `${path}/archive`, undefined, { archived: true }), 401);
    error(await http('PATCH', `/v1/campaigns/${unique('missing')}/archive`, key.secret, { archived: true }), 404, 'NOT_FOUND');
    for (const archived of [true, false]) {
      error(await http('PATCH', `${path}/archive`, reader.secret, { archived }), 403, 'PERMISSION_DENIED');
      error(await http('PATCH', `${path}/archive`, restricted.secret, { archived }), 403, 'SENDER_DOMAIN_FORBIDDEN');

    }
    assert.deepEqual(ok(await http('GET', path, key.secret)), campaign, 'Invalid or unauthorized requests must not change the campaign.');
    const archived = ok(await http('PATCH', `${path}/archive`, sender.secret, { archived: true }));
    assert.equal(typeof archived.archivedAt, 'string', 'Send permission alone is sufficient to archive.');
    assert.deepEqual(ok(await http('GET', path, reader.secret)), archived);
    assert.equal(typeof ok(await http('GET', `${path}/preview`, reader.secret)).html, 'string');
    ok(await http('GET', path, live.secret));
    assert.equal(page(await http('GET', `/v1/campaigns?archived=true&search=${campaign.id}`, live.secret))[0].id, campaign.id);
    assert.equal(ok(await http('PATCH', `${path}/archive`, sender.secret, { archived: false })).archivedAt, null);
    // Seed a terminal synthetic log and event, never a dispatch job, to verify nonzero counts and retained history.
    const emailId = unique('archive-email'), eventId = unique('archive-event');
    const snapshot = { from: campaign.draft.from, to: [address()], cc: [], bcc: [], replyTo: [], region: REGION, kind: 'marketing', subject: 'Synthetic archive history', text: 'Retained without sending.', attachments: [], tracking: false, headers: [] };
    cleanup(t, async () => {
      await db.query("DELETE FROM sending_email_events WHERE id = $1 AND email_id = $2 AND workspace_id = $3", [eventId, emailId, list.workspaceId]);
      await db.query("DELETE FROM sending_emails WHERE id = $1 AND campaign_id = $2 AND workspace_id = $3", [emailId, campaign.id, list.workspaceId]);
    });
    await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, campaign_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, status, snapshot, simulated)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'[]','[]',$8,'simulated',$9::jsonb,true)`, [emailId, list.workspaceId, REGION, key.id, campaign.id, snapshot.from, JSON.stringify(snapshot.to), snapshot.subject, JSON.stringify(snapshot)]);
    await db.query(`INSERT INTO sending_email_events (id, workspace_id, email_id, type, data, simulated)
      VALUES ($1,$2,$3,'simulated','{"synthetic":true}',true)`, [eventId, list.workspaceId, emailId]);
    const email = ok(await http('GET', `/v1/emails/${emailId}`, key.secret));
    const content = ok(await http('GET', `/v1/emails/${emailId}/content`, key.secret));
    const history = page(await http('GET', `/v1/emails/${emailId}/events`, key.secret));
    assert.equal(history.length, 1);
    const reviewId = unique('archive-review');
    await db.query("INSERT INTO sending_campaign_reviews (id, workspace_id, campaign_id, revision, draft, content_hash) VALUES ($1,$2,$3,$4,$5::jsonb,'synthetic')", [reviewId, list.workspaceId, campaign.id, campaign.revision, JSON.stringify(campaign.draft)]);
    cleanup(t, async () => { await db.query('DELETE FROM sending_campaign_reviews WHERE id = $1', [reviewId]); });
    // Scoped terminal/active states exercise guards without scheduling or sending email.
    for (const state of ['preparing', 'scheduled', 'sending', 'paused', 'done', 'failed', 'canceled']) {
      const seeded = await db.query("UPDATE sending_campaigns SET state = $1, review_id = $4, total = 1, prepared = CASE WHEN $1 = 'preparing' THEN 0 ELSE 1 END, expanded = CASE WHEN $1 IN ('sending','done') THEN 1 ELSE 0 END, paused_at = CASE WHEN $1 = 'paused' THEN now() END WHERE id = $2 AND workspace_id = $3 RETURNING id", [state, campaign.id, list.workspaceId, reviewId]);
      assert.equal(seeded.rowCount, 1);
      const before = ok(await http('GET', path, key.secret));
      assert.equal(before.state, state);
      assert.equal(before.counts.total, 1);
      assert.equal(before.counts.byStatus.simulated, 1);
      if (['preparing', 'scheduled', 'sending', 'paused'].includes(state)) {
        error(await http('PATCH', `${path}/archive`, key.secret, { archived: true }), 409, 'CAMPAIGN_ACTIVE');
        assert.deepEqual(ok(await http('GET', path, key.secret)), before);
      } else {
        const result = ok(await http('PATCH', `${path}/archive`, key.secret, { archived: true }));
        assert.equal(typeof result.archivedAt, 'string');
        assert.deepEqual({ ...result, archivedAt: before.archivedAt, updatedAt: before.updatedAt }, before);
        assert.deepEqual(ok(await http('GET', `/v1/emails/${emailId}`, key.secret)), email);
        assert.deepEqual(ok(await http('GET', `/v1/emails/${emailId}/content`, key.secret)), content);
        assert.deepEqual(page(await http('GET', `/v1/emails/${emailId}/events`, key.secret)), history);
      }
      const restored = ok(await http('PATCH', `${path}/archive`, key.secret, { archived: false }));
      assert.deepEqual({ ...restored, updatedAt: before.updatedAt }, before, 'Restore must remain available without changing delivery status.');
    }
    assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret)), [email]);
  });

  test('dashboard campaign metadata survives revisions and produces escaped immutable snapshots with real status counts', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('editor-list') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const fromName = 'Élodie 日本語 ✉';
    const previewText = '<img src=x onerror=alert(1)> & "Preview"';
    const html = '<p>Visible body</p>';
    const campaign = await campaignFixture(t, key.secret, { listId: list.id }, { fromName, previewText, html });
    const persisted = ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret));
    assert.equal(persisted.draft.fromName, fromName);
    assert.equal(persisted.draft.previewText, previewText);
    assert.equal(persisted.draft.html, html, 'Preheader injection belongs to the snapshot, not editable HTML.');
    assert.equal(persisted.counts.total, 0);
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, html: '<table><tr><td>Not a block</td></tr></table>' } }), 422, 'CAMPAIGN_CONTENT_INVALID');
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, fromName: 'Name\r\nBcc: victim@example.com' } }), 422);
    assert.deepEqual(ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret)), persisted, 'Invalid metadata must not mutate the existing revision.');
    const revised = ok(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, previewText: `${previewText}!` } }));
    assert.equal(revised.revision, campaign.revision + 1);
    error(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: campaign.revision, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), 409, 'STALE_CAMPAIGN_REVISION');
    ok(await http('POST', `/v1/campaigns/${campaign.id}/send`, key.secret, { revision: revised.revision }), 202);
    await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => row.state === 'done' && row.counts.byStatus.delivered === 1);
    const messages = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].fromName, fromName);
    assert.equal(messages[0].kind, 'marketing');
    const content = ok(await http('GET', `/v1/emails/${messages[0].id}/content`, key.secret));
    assert.equal(content.simulated, true);
    assert.ok(content.html.includes('data-opensend-preview="true"'));
    assert.ok(content.html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Preview&quot;!'));
    assert.ok(!content.html.includes('<img src=x'));
    assert.ok(content.html.indexOf('data-opensend-preview') < content.html.indexOf('Visible body'));
    // The sent row stores only a stub and its unsubscribe URL; the body above was rebuilt from the frozen review.
    const db = await fixtureDatabase(t);
    const [stored] = (await db.query("SELECT snapshot FROM sending_emails WHERE id = $1", [messages[0].id])).rows;
    assert.equal(stored.snapshot.html, undefined, 'Sent campaign emails must not persist rendered HTML.');
    assert.equal(stored.snapshot.text, undefined);
    assert.equal(stored.snapshot.deferredCampaign, true);
    assert.match(stored.snapshot.unsubscribeUrl, /\/unsubscribe\/u_[A-Za-z0-9_-]+$/);
    assert.ok(content.html.includes(stored.snapshot.unsubscribeUrl), 'The rebuilt body carries the unsubscribe link that was sent.');
    assert.ok(content.text.endsWith(`Unsubscribe: ${stored.snapshot.unsubscribeUrl}`));
    const token = stored.snapshot.unsubscribeUrl.slice(stored.snapshot.unsubscribeUrl.lastIndexOf('/') + 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM operation_unsubscribe_tokens WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [token])).rows[0].n, 1, 'The stored link is the one whose token was issued.');
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: revised.revision, draft: { ...revised.draft, previewText: 'Too late' } }), 409, 'CAMPAIGN_LOCKED');
    assert.equal(ok(await http('GET', `/v1/emails/${messages[0].id}/content`, key.secret)).html, content.html);
    const current = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret));
    const counts = ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret)).counts;
    assert.equal(counts.total, current.length);
    assert.equal(Object.values(counts.byStatus).reduce<number>((sum, value) => sum + Number(value), 0), counts.total);
    for (const [status, count] of Object.entries(counts.byStatus)) assert.equal(count, current.filter(row => row.status === status).length);
    assert.equal(counts.byStatus.delivered, 1);
  });

  test('campaign stats expose lifetime unique outcomes, explicit rates and progress through the API', async t => {
    const db = await fixtureDatabase(t);
    const live = await keyFixture(t);
    const testKey = await keyFixture(t);
    const sendOnly = await keyFixture(t, { permissions: ['send'] });
    const campaign = await campaignFixture(t, live.secret, {});
    const untracked = await campaignFixture(t, live.secret, {}, { tracking: false });
    const simulated = await campaignFixture(t, testKey.secret, {});
    const path = `/v1/campaigns/${campaign.id}/stats`;
    const empty = ok(await http('GET', path, live.secret));
    assert.equal(empty.counts.total, 0);
    assert.equal(empty.state, 'draft');
    assert.equal(empty.delivery, null);
    assert.ok(Object.values(empty.totals).every(value => value === 0));
    assert.ok(Object.values(empty.rates).every((rate: any) => rate.value === null && rate.denominator === 0));
    error(await http('GET', path), 401);
    assert.deepEqual(ok(await http('GET', path, testKey.secret)), empty);
    error(await http('GET', path, sendOnly.secret), 403, 'PERMISSION_DENIED');
    error(await http('GET', `/v1/campaigns/${unique('missing')}/stats`, live.secret), 404, 'NOT_FOUND');

    // Synthetic audit rows only: no live send, AWS call or dispatch job. Old creation times
    // prove stats have no implicit 30-day window. Raw feedback uses the real ingestion helper.
    const { nodeRuntime } = await import('./src/adapters/node.js');
    const { recordEmailEvent } = await import('./src/sending.js');
    const { runtime, close } = nodeRuntime({ ...process.env, DATABASE_URL: FIXTURE_DATABASE_URL });
    cleanup(t, close);
    const fixtures = [
      { status: 'delivered', events: ['delivery', 'open', 'open', 'click', 'click'], accepted: true },
      { status: 'complained', events: ['delivery', 'complaint', 'open'], accepted: true },
      { status: 'bounced', events: ['bounce'], accepted: true },
      { status: 'delayed', events: ['delivery_delay'], accepted: true },
      { status: 'rejected', events: ['reject'] }, { status: 'rendering_failed', events: ['rendering_failure'] },
      { status: 'suppressed', events: [] }, { status: 'canceled', events: [] }, { status: 'acceptance_unknown', events: [] },
      { status: 'sent', events: ['send'], accepted: true }, { status: 'accepted', events: [], accepted: true },
      // SES Auto Validation drop: the provider accepted the call but never sent; neither accepted nor bounced.
      { status: 'sent', events: ['send', 'validation_suppressed'], accepted: true },
      { status: 'delivered', events: [], accepted: true, campaignId: untracked.id },
      { status: 'delivered', events: ['delivery'], campaignId: simulated.id, simulated: true },
      { status: 'delivered', events: ['delivery', 'open', 'click'], simulated: true },
      { status: 'delivered', events: [], workspaceId: 'foreign-stats-workspace' },
    ];
    const ids: string[] = [];
    cleanup(t, async () => {
      await db.query('DELETE FROM operation_events WHERE data->>\'emailId\' = ANY($1::text[])', [ids]);
      await db.query('DELETE FROM sending_email_events WHERE email_id = ANY($1::text[])', [ids]);
      await db.query('DELETE FROM sending_emails WHERE id = ANY($1::text[])', [ids]);
      await db.query("UPDATE sending_campaigns SET state = 'draft', review_id = NULL, total = 0, prepared = 0, expanded = 0, canceled = 0, archived_at = NULL WHERE id = $1", [campaign.id]);
    });
    for (const fixture of fixtures) {
      const emailId = unique('stats-email'), workspaceId = fixture.workspaceId ?? 'default';
      ids.push(emailId);
      await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, campaign_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status, provider_id, created_at)
        VALUES ($1,$2,$3,$4,$5,'sender@example.com','["recipient@example.com"]','[]','[]','Synthetic stats','{}',$6,$7,$8,'2020-01-01T00:00:00Z')`,
      [emailId, workspaceId, REGION, live.id, fixture.campaignId ?? campaign.id, !!fixture.simulated, fixture.status, fixture.accepted ? unique('synthetic-provider') : null]);
      for (const type of fixture.events) await recordEmailEvent(runtime, { workspaceId, emailId, type, externalId: unique('stats-feedback'), data: { synthetic: true, isBotEvent: 'Likely' } });
    }
    // Even corrupt cross-scope feedback for a matching email ID must not be counted.
    await db.query("INSERT INTO sending_email_events (id, workspace_id, email_id, type, simulated) VALUES ($1,$2,$3,'click',false)", [unique('foreign-event'), 'foreign-stats-workspace', ids[6]]);
    await db.query("UPDATE sending_campaigns SET state = 'canceled', review_id = $2, actor_key_id = $3, total = 13, prepared = 13, expanded = 11, canceled = 2, archived_at = now() WHERE id = $1", [campaign.id, unique('stats-review'), live.id]);
    const stats = ok(await http('GET', path, live.secret));
    assert.equal(stats.state, 'canceled');
    assert.equal(stats.tracking, true);
    assert.equal(stats.counts.total, 13);
    assert.equal(stats.counts.byStatus.suppressed, 2);
    assert.equal(stats.counts.byStatus.bounced, 1);
    assert.equal(stats.counts.byStatus.delivered, 2);
    assert.equal(stats.counts.byStatus.complained, 1);
    assert.equal(stats.counts.byStatus.canceled, 1);
    assert.equal(stats.delivery.total, 13);
    assert.equal(stats.delivery.expanded, 11);
    assert.equal(stats.delivery.canceled, 2, 'Unmaterialized cancellations are separate from email counts.');
    assert.deepEqual(stats.totals, { accepted: 6, delivered: 3, bounced: 1, complained: 1, opened: 3, clicked: 2, failed: 2, deliveryDelayed: 1, simulated: 1 });
    assert.deepEqual(stats.rates.delivery, { value: 2 / 6, numerator: 2, denominator: 6 });
    assert.deepEqual(stats.rates.bounce, { value: 1 / 6, numerator: 1, denominator: 6 });
    assert.deepEqual(stats.rates.complaint, { value: 1 / 6, numerator: 1, denominator: 6 });
    assert.deepEqual(stats.rates.open, { value: 1, numerator: 2, denominator: 2 });
    assert.deepEqual(stats.rates.click, { value: 0.5, numerator: 1, denominator: 2 });
    const disabled = ok(await http('GET', `/v1/campaigns/${untracked.id}/stats`, live.secret));
    assert.equal(disabled.tracking, false);
    assert.equal(disabled.rates.delivery.value, 1);
    assert.equal(disabled.rates.open.value, null);
    assert.equal(disabled.rates.click.value, null);
    const testStats = ok(await http('GET', `/v1/campaigns/${simulated.id}/stats`, testKey.secret));
    assert.equal(testStats.totals.accepted, 0);
    assert.equal(testStats.totals.delivered, 1);
    assert.equal(testStats.totals.simulated, 1);
    assert.ok(Object.values(testStats.rates).every((rate: any) => rate.value === null && rate.numerator === 0 && rate.denominator === 0));
  });

  test('dashboard email queries bind literal search, kind, region, time and cursors while cohort metrics deduplicate event replays', async t => {
    const db = await fixtureDatabase(t);
    const key = await keyFixture(t);
    const live = await keyFixture(t, { permissions: ['read'] });
    const marker = unique('query');
    const from = new Date(Date.now() - 1000).toISOString();
    const ids: string[] = [];
    for (const suffix of ['%_\\literal', 'ZZZliteral', '%_\\literal newest']) {
      const queued = ok(await http('POST', '/v1/emails/send', key.secret, mail({ subject: `${marker} ${suffix}`, fromName: 'Élodie 日本語' })), 202);
      ids.push(queued.id);
      await poll(`/v1/emails/${queued.id}`, key.secret, row => row.status === 'delivered');
    }
    error(await http('POST', '/v1/emails/send', key.secret, mail({ fromName: 'Name\nBcc: victim@example.com' })), 422);
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    const marketing = ok(await http('POST', '/v1/emails/send', key.secret, mail({ to: contact.email, kind: 'marketing', subject: `${marker} marketing` })), 202);
    await poll(`/v1/emails/${marketing.id}`, key.secret, row => row.status === 'delivered');
    const to = new Date(Date.now() + 1000).toISOString();
    const query = new URLSearchParams({ search: marker.toUpperCase(), kind: 'transactional', region: REGION, from, to, limit: '1' });
    const first = await http('GET', `/v1/emails?${query}`, key.secret);
    assert.equal(page(first)[0].id, ids[2]);
    assert.equal(first.body.data[0].fromName, 'Élodie 日本語');
    assert.equal(first.body.data[0].kind, 'transactional');
    assert.ok(first.body.nextCursor);
    const cursor = first.body.nextCursor;
    query.set('cursor', cursor);
    const second = await http('GET', `/v1/emails?${query}`, key.secret);
    assert.equal(page(second)[0].id, ids[1]);
    query.set('cursor', second.body.nextCursor);
    const third = await http('GET', `/v1/emails?${query}`, key.secret);
    assert.equal(page(third)[0].id, ids[0]);
    assert.equal(third.body.nextCursor, null);
    query.set('cursor', cursor);
    assert.deepEqual(page(await http('GET', `/v1/emails?${query}`, live.secret)), second.body.data);
    query.set('kind', 'marketing');
    error(await http('GET', `/v1/emails?${query}`, key.secret), 422, 'INVALID_CURSOR');
    query.delete('cursor');
    assert.deepEqual(page(await http('GET', `/v1/emails?${query}`, key.secret)).map(row => row.id), [marketing.id]);
    query.set('kind', 'transactional'); query.set('limit', '100'); query.set('search', `${marker} %_\\literal`);
    assert.deepEqual(page(await http('GET', `/v1/emails?${query}`, key.secret)).map(row => row.id), [ids[2], ids[0]], 'Search must treat percent, underscore and backslash literally.');
    query.set('to', from);
    error(await http('GET', `/v1/emails?${query}`, key.secret), 422);
    query.set('to', to); query.set('region', 'not-configured');
    error(await http('GET', `/v1/emails?${query}`, key.secret), 422, 'REGION_NOT_CONFIGURED');
    const metricQuery = new URLSearchParams({ from, to, region: REGION, stream: 'transactional' });
    const historical=`/v1/metrics?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z&region=${REGION}`;
    await http('GET',historical,undefined,undefined,{cookie:manager!.cookie});
    const cached=await http('GET',historical,undefined,undefined,{cookie:manager!.cookie});
    assert.equal(cached.headers.get('x-opensend-metrics-cache'),'hit');
    assert.equal((await http('GET',historical,key.secret)).headers.get('x-opensend-metrics-cache'),null);
    const before = ok(await http('GET', `/v1/metrics?${metricQuery}`, key.secret));
    assert.equal(before.basis, 'created-cohort');
    assert.equal(before.region, REGION);
    assert.equal(before.stream, 'transactional');
    assert.ok(before.totals.emails >= 3);
    assert.equal(before.totals.accepted, 0, 'Simulated mail is not provider acceptance.');
    assert.equal(before.daily.reduce((sum: number, day: Json) => sum + day.count, 0), before.totals.emails);
    // include=previous,streams returns, in one statement, exactly what the separate window, previous-window and per-stream requests return.
    const extras = ok(await http('GET', `/v1/metrics?${new URLSearchParams({ from, to, region: REGION, stream: 'transactional', include: 'previous,streams' })}`, key.secret));
    assert.deepEqual(extras.totals, before.totals);
    assert.deepEqual(extras.daily, before.daily);
    const previousFrom = new Date(Date.parse(from) - (Date.parse(to) - Date.parse(from))).toISOString();
    assert.deepEqual(extras.previous, { from: previousFrom, to: from, totals: ok(await http('GET', `/v1/metrics?${new URLSearchParams({ from: previousFrom, to: from, region: REGION, stream: 'transactional' })}`, key.secret)).totals });
    for (const kind of ['transactional', 'marketing']) assert.deepEqual(extras.streams[kind], ok(await http('GET', `/v1/metrics?${new URLSearchParams({ from, to, region: REGION, stream: kind })}`, key.secret)).totals);
    assert.equal(ok(await http('GET', `/v1/metrics?${metricQuery}`, key.secret)).previous, undefined, 'Without include the response is unchanged.');
    error(await http('GET', `/v1/metrics?${new URLSearchParams({ from, to, include: 'bogus' })}`, key.secret), 422);
    const matched = await db.query('SELECT id FROM sending_emails WHERE id = $1 AND workspace_id = $2 AND actor_key_id = $3', [ids[0], contact.workspaceId, key.id]);
    assert.equal(matched.rowCount, 1, 'Only an exact HTTP-created scoped email can receive synthetic replay source events.');
    const events = [unique('cohort-click'), unique('cohort-click-replay')];
    cleanup(t, async () => { for (const id of events) await db.query('DELETE FROM operation_events WHERE id = $1 AND workspace_id = $2', [id, contact.workspaceId]); });
    for (const id of events) await db.query('INSERT INTO operation_events (id, workspace_id, type, region, data, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [id, contact.workspaceId, 'email.clicked', REGION, JSON.stringify({ emailId: ids[0], synthetic: true }), new Date(Date.parse(to) + 3_600_000)]);
    const after = ok(await http('GET', `/v1/metrics?${metricQuery}`, key.secret));
    assert.equal(after.totals.clicked, before.totals.clicked + 1, 'Two source events for one email count once, even when observed after the cohort end.');
    assert.equal(after.totals.emails, before.totals.emails);
    assert.equal(after.totals.accepted, 0);
    assert.equal(ok(await http('GET', `/v1/metrics?${metricQuery}`, live.secret)).totals.clicked, after.totals.clicked);
  });

  test('dashboard audience memberships and list counts partition active consent and suppression without scope leaks', async t => {
    const db = await fixtureDatabase(t);
    const key = await keyFixture(t);
    const live = await keyFixture(t, { permissions: ['read'] });
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('partition-list') });
    const other = await resource(t, key.secret, '/v1/lists', { name: unique('other-list') });
    const members: Json[] = [];
    for (let index = 0; index < 4; index++) members.push(await resource(t, key.secret, '/v1/contacts', { email: address(), name: `Partition ${index}` }));
    ok(await consent(key.secret, members[1].id, 'subscribed'));
    ok(await consent(key.secret, members[2].id, 'unsubscribed'));
    ok(await consent(key.secret, members[3].id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: members.map(row => row.id) }));
    ok(await http('POST', `/v1/lists/${other.id}/members`, key.secret, { contactIds: [members[0].id] }));
    const suppression = await db.query('UPDATE audience_contacts SET suppressed = true, suppression_reason = $1 WHERE id = $2 AND workspace_id = $3 AND email = $4 AND marketing_consent = $5 AND suppressed = false RETURNING id', ['synthetic-acceptance-source', members[3].id, list.workspaceId, members[3].email, 'subscribed']);
    assert.equal(suppression.rowCount, 1, 'Synthetic suppression must match the exact HTTP-created subscribed contact.');
    cleanup(t, async () => { await db.query('UPDATE audience_contacts SET suppressed = false, suppression_reason = NULL WHERE id = $1 AND workspace_id = $2', [members[3].id, list.workspaceId]); });
    const expected = { total: 4, subscribed: 1, unsubscribed: 1, unknown: 1, suppressed: 1 };
    assert.deepEqual(ok(await http('GET', `/v1/lists/${list.id}`, key.secret)).counts, expected);
    assert.deepEqual(page(await http('GET', `/v1/lists?search=${encodeURIComponent(list.name)}`, key.secret))[0].counts, expected);
    const contacts = page(await http('GET', `/v1/contacts?listId=${list.id}`, key.secret));
    assert.equal(contacts.length, 4);
    for (const row of contacts) assert.deepEqual(row.listIds, (row.id === members[0].id ? [list.id, other.id] : [list.id]).sort());
    assert.deepEqual(ok(await http('GET', `/v1/contacts/${members[0].id}`, key.secret)).listIds, [list.id, other.id].sort());
    assert.deepEqual(page(await http('GET', `/v1/contacts?listId=${list.id}&consent=subscribed&suppressed=false`, key.secret)).map(row => row.id), [members[1].id]);
    assert.deepEqual(page(await http('GET', `/v1/contacts?listId=${list.id}&suppressed=true`, key.secret)).map(row => row.id), [members[3].id]);
    ok(await http('GET', `/v1/lists/${list.id}`, live.secret));
    ok(await http('GET', `/v1/contacts/${members[0].id}`, live.secret));
    ok(await http('DELETE', `/v1/contacts/${members[0].id}`, key.secret));
    assert.deepEqual(ok(await http('GET', `/v1/lists/${list.id}`, key.secret)).counts, { ...expected, total: 3, unknown: 0 });
    assert.deepEqual(ok(await http('GET', `/v1/lists/${other.id}`, key.secret)).counts, { total: 0, subscribed: 0, unsubscribed: 0, unknown: 0, suppressed: 0 });
  });
});

describe('Personalization context boundaries', () => {
  test('unquoted and executable placeholders fail review, while quoted URLs and literal-brace recipient data render safely', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('template-context') });
    const contact = await resource(t, key.secret, '/v1/contacts', {
      email: address(), name: 'Name {{literal}}', properties: {
        firstName: 'https://example.com onmouseover=alert(1)', url: 'https://example.com/path?q=one&next=two', port: 443, note: 'metadata: literal text',
      },
    });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    // Executable and unquoted contexts cannot be expressed in block HTML; they fail at save time.
    const probe = await campaignFixture(t, key.secret, { listId: list.id }, { html: '<p>Probe</p>' });
    for (const html of [
      '<script>const name = "{{firstName}}";</script>',
      '<style>.name { content: "{{firstName}}"; }</style>',
      '<p><a href="https://example.com" onclick="{{firstName}}">Event handler</a></p>',
      '<!-- {{firstName}} --><p>Comment context</p>',
      '<p title="{{firstName}}">Unsupported attribute</p>',
    ]) {
      error(await http('PATCH', `/v1/campaigns/${probe.id}`, key.secret, { revision: probe.revision, draft: { ...probe.draft, html } }), 422, 'CAMPAIGN_CONTENT_INVALID');
      const unchanged = ok(await http('GET', `/v1/campaigns/${probe.id}`, key.secret));
      assert.equal(unchanged.draft.html, '<p>Probe</p>');
      assert.equal(unchanged.revision, probe.revision);
    }
    const valid = await campaignFixture(t, key.secret, { listId: list.id }, {
      html: '<p><a href="{{url}}">{{name}}</a> <a href="https://example.com:{{port}}/account">{{note}}</a></p><img src="https://example.com/i.png" alt="{{firstName}}"><p>Plain {{name}}: {{firstName}}</p>',
    });
    ok(await http('POST', `/v1/campaigns/${valid.id}/send`, key.secret, { revision: valid.revision }), 202);
    await poll(`/v1/campaigns/${valid.id}`, key.secret, row => row.state === 'done');
    const messages = page(await http('GET', `/v1/emails?campaignId=${valid.id}`, key.secret));
    assert.equal(messages.length, 1);
    const content = ok(await http('GET', `/v1/emails/${messages[0].id}/content`, key.secret));
    assert.ok(content.html.includes('@media (prefers-color-scheme: dark){li::marker{color:#c4c4c4}}'), 'Adjacent closing CSS braces in the rendered document are not template delimiters.');
    assert.ok(content.html.includes('href="https://example.com/path?q=one&amp;next=two"'), 'Quoted URL substitutions must remain supported and escape the URL’s ampersand.');
    assert.ok(content.html.includes('alt="https://example.com onmouseover=alert(1)"'), 'The injected attribute-shaped value must remain inside the quoted alt, not become an event handler.');
    assert.ok(content.html.includes('>Name {{literal}}</a>'));
    assert.ok(/href="https:\/\/example.com:443\/account"[^>]*>metadata: literal text<\/a>/.test(content.html), 'Validate complete URLs after interpolation, without rejecting harmless text values.');
    assert.ok(content.html.includes('Plain Name {{literal}}: https://example.com onmouseover=alert(1)</p>'), 'Recipient data containing braces must not be parsed recursively.');
    ok(await http('PATCH', `/v1/contacts/${contact.id}`, key.secret, { properties: { ...contact.properties, url: 'javascript:alert(1)' } }));
    const unsafeUrl = await campaignFixture(t, key.secret, { listId: list.id }, { html: '<p><a href="{{url}}">Quoted but unsafe URL</a></p>' });
    ok(await http('POST', `/v1/campaigns/${unsafeUrl.id}/send`, key.secret, { revision: unsafeUrl.revision }), 202);
    const unsafeLaunch = await poll(`/v1/campaigns/${unsafeUrl.id}`, key.secret, row => ['done', 'failed'].includes(row.state));
    assert.equal(unsafeLaunch.state, 'failed');
    assert.equal(unsafeLaunch.delivery.error.code, 'UNSAFE_HTML_URL');
    assert.equal(unsafeLaunch.counts.total, 0);
  });
});

describe('Campaign authorization and dispatch credentials', () => {
  test('domain-restricted send keys cannot retarget, delete or cancel another sender domain’s campaign', async t => {
    const owner = await keyFixture(t);
    const restricted = await keyFixture(t, { permissions: ['send'], domains: ['allowed.example.com'] });
    const list = await resource(t, owner.secret, '/v1/lists', { name: unique('domain-authorization') });
    const contact = await resource(t, owner.secret, '/v1/contacts', { email: address() });
    ok(await consent(owner.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, owner.secret, { contactIds: [contact.id] }));
    const campaign = await campaignFixture(t, owner.secret, { listId: list.id });
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, restricted.secret, {
      revision: campaign.revision, draft: { ...campaign.draft, from: 'sender@allowed.example.com' },
    }), 403, 'SENDER_DOMAIN_FORBIDDEN');
    error(await http('DELETE', `/v1/campaigns/${campaign.id}`, restricted.secret), 403, 'SENDER_DOMAIN_FORBIDDEN');
    error(await http('POST', `/v1/campaigns/${campaign.id}/cancel`, restricted.secret), 403, 'SENDER_DOMAIN_FORBIDDEN');
    const unchanged = ok(await http('GET', `/v1/campaigns/${campaign.id}`, owner.secret));
    assert.equal(unchanged.state, 'draft');
    assert.equal(unchanged.revision, campaign.revision);
    assert.deepEqual(unchanged.draft, campaign.draft);
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, owner.secret, {
      revision: campaign.revision, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    }), 202);
    await poll(`/v1/campaigns/${campaign.id}`, owner.secret, row => row.state === 'scheduled');
    error(await http('POST', `/v1/campaigns/${campaign.id}/cancel`, restricted.secret), 403, 'SENDER_DOMAIN_FORBIDDEN');
    error(await http('POST', `/v1/campaigns/${campaign.id}/pause`, restricted.secret, {}), 403, 'SENDER_DOMAIN_FORBIDDEN');
    const unchangedScheduled = ok(await http('GET', `/v1/campaigns/${campaign.id}`, owner.secret));
    assert.equal(unchangedScheduled.state, 'scheduled');
    assert.equal(unchangedScheduled.delivery.total, 1, 'Unauthorized cancellation must not release the scheduled recipient reservation.');
    assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, owner.secret)), []);
  });

  test('revoking the originating send key stops its future scheduled job before simulation or SES acceptance', async t => {
    const owner = await keyFixture(t);
    const origin = await keyFixture(t, { permissions: ['send'] });
    const reader = await keyFixture(t, { permissions: ['read'] });
    const list = await resource(t, owner.secret, '/v1/lists', { name: unique('revoked-origin') });
    const contact = await resource(t, owner.secret, '/v1/contacts', { email: address() });
    ok(await consent(owner.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, owner.secret, { contactIds: [contact.id] }));
    // A persisted test key owns the campaign; a different persisted test key
    // originates the queued job. The bootstrap live identity never schedules it.
    const campaign = await campaignFixture(t, owner.secret, { listId: list.id });
    const dueAt = Date.now() + 3_000;
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, origin.secret, {
      revision: campaign.revision, scheduledAt: new Date(dueAt).toISOString(),
    }), 202);
    await poll(`/v1/campaigns/${campaign.id}`, reader.secret, body => body.state === 'scheduled');
    assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, reader.secret)), []);
    ok(await http('POST', `/v1/api-keys/${origin.id}/revoke`, MANAGER), [200, 204]);
    assert.ok(Date.now() < dueAt, 'Revocation must finish before the scheduled job becomes due; otherwise this scenario cannot prove a dispatch-time credential check.');
    const blocked = await poll(`/v1/campaigns/${campaign.id}`, reader.secret, body => body.state === 'canceled');
    assert.equal(blocked.delivery.error.code, 'ORIGIN_KEY_REVOKED');
    assert.equal(blocked.delivery.canceled, 1);
    assert.equal(blocked.counts.total, 0, 'Revoked credentials must be checked before materializing or dispatching email.');
    assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, reader.secret)), []);
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, reader.secret)).marketingConsent, 'subscribed', 'This failure must come from revocation, not a consent change.');
  });
});

describe('Hosted unsubscribe and dispatch-time consent', () => {
  test('footer GET and provider POST are idempotent, private, and block queued marketing but not transactional mail', async t => {
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const live = await keyFixture(t);
    const email = address();
    const contact = await resource(t, key.secret, '/v1/contacts', { email });
    const production = ok(await http('GET', `/v1/contacts/${contact.id}`, live.secret));
    ok(await consent(key.secret, contact.id, 'subscribed'));
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('unsubscribe') });
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const source = ok(await http('POST', '/v1/emails/send', key.secret, mail({ to: email, kind: 'marketing', html: '<p>Capability source</p>' }), { 'x-forwarded-host': 'attacker.invalid' }), 202);
    const content = ok(await http('GET', `/v1/emails/${source.id}/content`, key.secret));
    const campaign = await campaignFixture(t, key.secret, { listId: list.id });
    const dueAt = Date.now() + 5_000;
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: campaign.revision, scheduledAt: new Date(dueAt).toISOString() }, { 'x-forwarded-host': 'attacker.invalid' }), 202);
    assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret)), []);
    const match = /Unsubscribe:\s*(https?:\/\/[^\s]+)/.exec(content.text ?? '');
    assert.ok(match, 'Marketing message must contain its configured unsubscribe URL.');
    const url = new URL(match[1]);
    assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)), 'Only localhost development may use HTTP unsubscribe URLs.');
    secrets.add(url.pathname.split('/').at(-1)!);
    assert.notEqual(url.hostname, 'attacker.invalid', 'Unsubscribe host must come from deployment configuration, not caller headers.');
    assert.ok(!url.href.includes(email) && !url.searchParams.has('email'), 'The capability URL must not disclose an email address.');
    const path = `${url.pathname}${url.search}`;
    const token = url.pathname.split('/').at(-1)!;
    assert.ok(content.html.includes(token) && content.text.includes(token), 'Manage-authorized content retrieval must preserve the usable HTML and text capability.');
    const redacted = ok(await http('GET', `/v1/emails/${source.id}/content`, reader.secret));
    const detail=ok(await http('GET',`/v1/emails/${source.id}/detail`,reader.secret));
    assert.deepEqual(detail.contact,{id:contact.id,suppressed:false});
    assert.deepEqual(detail.content,{html:redacted.html,text:redacted.text,attachments:redacted.attachments});
    assert.equal(detail.email.id,source.id); assert.ok(!JSON.stringify(detail).includes(token));
    const listedEvents=page(await http('GET',`/v1/emails/${source.id}/events`,reader.secret)) as {id:string}[];
    assert.deepEqual((detail.events.data as {id:string}[]).map(e=>e.id),listedEvents.map(e=>e.id),'Detail must return the same events as listEmailEvents.');
    assert.equal(redacted.raw, null, 'Read-only access must not expose an unredacted MIME alternative.');
    assert.ok(!JSON.stringify(redacted).includes(token), 'Read-only content must not disclose the valid unsubscribe token anywhere in its response.');
    assert.ok(!/\/unsubscribe\/u_[A-Za-z0-9_-]+/.test(JSON.stringify(redacted)), 'Read-only HTML/text must not contain a usable owned unsubscribe capability.');
    assert.equal(redacted.subject, content.subject, 'Redaction must preserve ordinary readable message content.');
    const head = await http('HEAD', path);
    assert.equal(head.status, 405, diagnostic(head));
    assert.equal(head.body, '', 'HEAD responses must have no body.');
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret)).marketingConsent, 'subscribed', 'A HEAD probe must not unsubscribe a contact.');
    assert.equal(page(await http('GET', `/v1/contacts/${contact.id}/consent`, key.secret)).length, 1, 'A HEAD probe must not append consent audit history.');
    assert.ok(Date.now() < dueAt, 'Fixture setup exceeded its scheduling window before unsubscribe; no dispatch-consent claim can be made.');
    // Link scanners fetch every footer link, so GET only asks for confirmation and changes nothing.
    const first = await http('GET', path);
    const prompt = ok(first);
    assert.match(first.headers.get('content-type') ?? '', /text\/html/);
    assert.match(first.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
    assert.match(first.headers.get('content-security-policy') ?? '', /form-action 'self'/);
    assert.ok(/<form method="post">/.test(prompt) && /name="confirm" value="footer"/.test(prompt), 'A footer GET must show a confirmation form.');
    assert.ok(!prompt.includes(email), 'Hosted confirmation must not disclose the recipient address.');
    assert.equal(ok(await http('GET', path)), prompt);
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret)).marketingConsent, 'subscribed', 'A footer GET (or a link scanner) must not unsubscribe.');
    const confirmed = ok(await http('POST', path, undefined, 'confirm=footer', { 'content-type': 'application/x-www-form-urlencoded' }));
    assert.ok(/unsubscribed/i.test(confirmed) && !/<form\b/i.test(confirmed));
    assert.ok(!confirmed.includes(email));
    const html = confirmed;
    assert.equal(ok(await http('POST', path, undefined, 'List-Unsubscribe=One-Click', { 'content-type': 'application/x-www-form-urlencoded' })), html);
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret)).marketingConsent, 'unsubscribed');
    assert.equal(ok(await http('GET', `/v1/contacts/${production.id}`, live.secret)).marketingConsent, 'unsubscribed');
    const audit = page(await http('GET', `/v1/contacts/${contact.id}/consent`, key.secret));
    assert.equal(audit.filter(row => row.source === 'footer-confirm' && row.status === 'unsubscribed').length, 1, 'The footer confirmation must be attributed to footer-confirm, not provider one-click consent.');
    assert.equal(audit.filter(row => row.status === 'unsubscribed').length, 1, 'Repeated GET and POST capability use must not duplicate or rewrite the original consent decision.');
    const last = path.at(-1)!;
    const tampered = `${path.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    const invalid = error(await http('GET', tampered), 404, 'NOT_FOUND');
    const unknown = error(await http('GET', `/unsubscribe/u_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`), 404, 'NOT_FOUND');
    assert.equal(invalid.message, unknown.message, 'Tampered and nonexistent tokens must have indistinguishable public errors.');
    assert.ok(!JSON.stringify(invalid).includes(email) && !JSON.stringify(unknown).includes(email));
    await poll(`/v1/campaigns/${campaign.id}`, key.secret, body => body.counts?.byStatus?.suppressed === 1);
    const [blocked] = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret));
    assert.equal(blocked.status, 'suppressed');
    assert.equal(blocked.providerId, null);
    assert.equal(blocked.simulated, true);
    const campaignEvents = page(await http('GET', `/v1/emails/${blocked.id}/events`, key.secret));
    assert.ok(campaignEvents.some(event => event.type === 'suppressed'));
    assert.ok(!campaignEvents.some(event => ['accepted', 'delivery', 'simulated'].includes(event.type)), 'Opt-out must be checked before even simulated marketing dispatch.');
    const transactional = ok(await http('POST', '/v1/emails/send', key.secret, mail({ to: email })), 202);
    assert.equal((await poll(`/v1/emails/${transactional.id}`, key.secret, body => body.status === 'delivered')).status, 'delivered');
  });

  test('a first-use RFC 8058 POST records its own source independently of footer GET', async t => {
    const key = await keyFixture(t);
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    const queued = ok(await http('POST', '/v1/emails/send', key.secret, mail({ to: contact.email, kind: 'marketing' })), 202);
    const content = ok(await http('GET', `/v1/emails/${queued.id}/content`, key.secret));
    const match = /Unsubscribe:\s*(https?:\/\/[^\s]+)/.exec(content.text ?? '');
    assert.ok(match, 'Marketing content must include a one-click capability URL.');
    const url = new URL(match[1]);
    secrets.add(url.pathname.split('/').at(-1)!);
    const path = `${url.pathname}${url.search}`;
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret)).marketingConsent, 'subscribed');
    const first = await http('POST', path, undefined, 'List-Unsubscribe=One-Click', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.match(ok(first), /unsubscribed/i);
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret)).marketingConsent, 'unsubscribed');
    let audit = page(await http('GET', `/v1/contacts/${contact.id}/consent`, key.secret));
    assert.equal(audit.filter(row => row.source === 'rfc8058-post' && row.status === 'unsubscribed').length, 1);
    assert.equal(audit.filter(row => row.source === 'footer-confirm').length, 0);
    ok(await http('POST', path, undefined, 'List-Unsubscribe=One-Click', { 'content-type': 'application/x-www-form-urlencoded' }));
    ok(await http('GET', path));
    audit = page(await http('GET', `/v1/contacts/${contact.id}/consent`, key.secret));
    assert.equal(audit.length, 2, 'Initial subscription plus first provider POST must remain the only consent decisions after repeated POST and GET.');
    assert.equal(audit.filter(row => row.source === 'rfc8058-post').length, 1);
    assert.equal(audit.filter(row => row.source === 'footer-get').length, 0, 'Later footer navigation must not relabel provider-originated consent.');
  });
});

describe('Scoped database source fixtures with HTTP security assertions', () => {
  test('email events and webhook delivery list/detail recursively redact unsubscribe capabilities for readers only', { skip: DATABASE_FIXTURE_SKIP }, async t => {
    const db = await fixtureDatabase(t);
    const manager = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const contact = await resource(t, manager.secret, '/v1/contacts', { email: address() });
    ok(await consent(manager.secret, contact.id, 'subscribed'));
    const queued = ok(await http('POST', '/v1/emails/send', manager.secret, mail({ to: contact.email, kind: 'marketing' })), 202);
    await poll(`/v1/emails/${queued.id}`, manager.secret, body => body.status === 'delivered');
    const deliveredEvents = page(await http('GET', `/v1/emails/${queued.id}/events`, manager.secret)) as { id: string }[];
    const deliveredDetail = ok(await http('GET', `/v1/emails/${queued.id}/detail`, manager.secret));
    assert.ok(deliveredEvents.length > 0);
    assert.deepEqual((deliveredDetail.events.data as { id: string }[]).map(e => e.id), deliveredEvents.map(e => e.id), 'Detail must return the delivered email’s own events.');
    const content = ok(await http('GET', `/v1/emails/${queued.id}/content`, manager.secret));
    const match = /Unsubscribe:\s*(https?:\/\/[^\s]+)/.exec(content.text ?? '');
    assert.ok(match, 'A real test-marketing snapshot must supply this fixture’s owned unsubscribe capability.');
    const capabilityUrl = match[1];
    const token = new URL(capabilityUrl).pathname.split('/').at(-1)!;
    secrets.add(token);
    assert.ok(/^u_[0-9a-f]{64}$/.test(token), 'Fixture capability must have the application-owned token format.');
    const endpoint = await resource(t, manager.secret, '/v1/webhooks', { url: `https://example.com/hooks/${unique('redaction')}`, paused: true });
    // Before any SQL writes, prove that this DB contains the exact HTTP-created
    // test email, its originating key, and our paused endpoint in the same scope.
    const matched = await db.query(`SELECT e.id FROM sending_emails e
      JOIN api_keys k ON k.id = e.actor_key_id AND k.workspace_id = e.workspace_id
      JOIN operation_webhooks w ON w.workspace_id = e.workspace_id
      WHERE e.id = $1 AND e.workspace_id = $2 AND e.actor_key_id = $3
        AND w.id = $4 AND w.paused = true AND w.url = $5`,
    [queued.id, contact.workspaceId, manager.id, endpoint.id, endpoint.url]);
    assert.equal(matched.rowCount, 1, 'API_FIXTURE_DATABASE_MISMATCH: no matching HTTP-created email/key/paused endpoint; no synthetic rows were inserted.');
    const eventId = unique('acceptance-click');
    const operationId = unique('acceptance-operation');
    const deliveryId = unique('acceptance-delivery');
    const data = { emailId: queued.id, link: capabilityUrl, nested: { links: [capabilityUrl, { link: capabilityUrl }], label: 'ordinary click metadata', [`key-${token}`]: token }, values: [7, true, null] };
    const payload = { id: operationId, type: 'email.clicked', createdAt: new Date().toISOString(), workspaceId: contact.workspaceId, region: REGION, data };
    // Only event-source arrangement uses SQL: no SNS signature claim, provider
    // request, dispatch job, or webhook callback is manufactured or performed.
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO sending_email_events (id, workspace_id, email_id, type, data, simulated)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [eventId, contact.workspaceId, queued.id, 'click', JSON.stringify(data), true]);
      await db.query(`INSERT INTO operation_events (id, workspace_id, type, region, data, created_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [operationId, contact.workspaceId, payload.type, REGION, JSON.stringify(data), payload.createdAt]);
      await db.query(`INSERT INTO operation_deliveries (id, workspace_id, webhook_id, event_id, payload, synthetic, status)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`, [deliveryId, contact.workspaceId, endpoint.id, operationId, JSON.stringify(payload), true, 'paused']);
      await db.query('COMMIT');
    } catch (cause) {
      await db.query('ROLLBACK');
      throw cause;
    }
    cleanup(t, async () => {
      await db.query('DELETE FROM operation_deliveries WHERE id = $1 AND workspace_id = $2 AND webhook_id = $3 AND event_id = $4', [deliveryId, contact.workspaceId, endpoint.id, operationId]);
      await db.query('DELETE FROM operation_events WHERE id = $1 AND workspace_id = $2', [operationId, contact.workspaceId]);
      await db.query('DELETE FROM sending_email_events WHERE id = $1 AND workspace_id = $2 AND email_id = $3', [eventId, contact.workspaceId, queued.id]);
    });
    const observations: Array<{ route: string; managed: Json; readable: Json }> = [];
    const managerEvents = await allPages(`/v1/emails/${queued.id}/events`, manager.secret);
    const readerEvents = await allPages(`/v1/emails/${queued.id}/events`, reader.secret);
    const managerEvent = managerEvents.find(row => row.id === eventId);
    const readerEvent = readerEvents.find(row => row.id === eventId);
    assert.ok(managerEvent && readerEvent, 'Both scopes must be able to observe the same persisted synthetic email event.');
    observations.push({ route: 'email events', managed: managerEvent.data, readable: readerEvent.data });
    const managerDeliveries = await allPages(`/v1/webhooks/${endpoint.id}/deliveries`, manager.secret);
    const readerDeliveries = await allPages(`/v1/webhooks/${endpoint.id}/deliveries`, reader.secret);
    const managerDelivery = managerDeliveries.find(row => row.id === deliveryId);
    const readerDelivery = readerDeliveries.find(row => row.id === deliveryId);
    assert.ok(managerDelivery && readerDelivery, 'Both delivery lists must contain the exact inserted fixture.');
    observations.push({ route: 'webhook delivery list', managed: managerDelivery.payload.data, readable: readerDelivery.payload.data });
    const managerDetail = ok(await http('GET', `/v1/webhooks/${endpoint.id}/deliveries/${deliveryId}`, manager.secret));
    const readerDetail = ok(await http('GET', `/v1/webhooks/${endpoint.id}/deliveries/${deliveryId}`, reader.secret));
    assert.equal(managerDetail.status, 'paused');
    assert.equal(managerDetail.attemptCount, 0);
    assert.deepEqual(managerDetail.attempts, [], 'The fixture must not make any webhook deliveries.');
    observations.push({ route: 'webhook delivery detail', managed: managerDetail.payload.data, readable: readerDetail.payload.data });
    const safeData = JSON.parse(JSON.stringify(data).replaceAll(token, '[redacted]'));
    for (const observation of observations) {
      assert.deepEqual(observation.managed, data, `${observation.route}: manage access must retain the complete original payload, including nested capabilities and property names.`);
      assert.ok(!JSON.stringify(observation.readable).includes(token), `${observation.route}: read-only access must not reveal a valid capability, including nested values.`);
      assert.deepEqual(observation.readable, safeData, `${observation.route}: recursive redaction must preserve non-capability fields and JSON types.`);
    }
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, manager.secret)).marketingConsent, 'subscribed', 'Reading redacted event metadata must not consume the underlying capability.');
  });

  test('a test key at its seeded 1,200-request budget receives HTTP 429 and recovers after its own budget resets', { skip: DATABASE_FIXTURE_SKIP }, async t => {
    const db = await fixtureDatabase(t);
    const key = await keyFixture(t);
    let fixtureWorkspace: string | undefined;
    cleanup(t, async () => {
      // Registered before the contact: delete its cleanup request's budget too,
      // after contact deletion but before key revocation. No writes if DB matching failed.
      if (fixtureWorkspace) await db.query('DELETE FROM api_request_budgets WHERE workspace_id = $1 AND key_id = $2', [fixtureWorkspace, key.id]);
    });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    const queued = ok(await http('POST', '/v1/emails/send', key.secret, mail({ to: contact.email })), 202);
    const matched = await db.query(`SELECT e.id FROM sending_emails e JOIN api_keys k
      ON k.id = e.actor_key_id AND k.workspace_id = e.workspace_id
      WHERE e.id = $1 AND e.workspace_id = $2 AND k.id = $3`, [queued.id, contact.workspaceId, key.id]);
    assert.equal(matched.rowCount, 1, 'API_FIXTURE_DATABASE_MISMATCH: no matching HTTP-created test email/key; no request budget was seeded.');
    fixtureWorkspace = contact.workspaceId;
    // This cleanup is registered after the key/contact fixtures, so it restores
    // access before their HTTP cleanup and never touches another key’s budget.
    cleanup(t, async () => { await db.query('DELETE FROM api_request_budgets WHERE workspace_id = $1 AND key_id = $2', [contact.workspaceId, key.id]); });
    let limited: Reply | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const seeded = await db.query(`INSERT INTO api_request_budgets (workspace_id, key_id, window_start, used)
        VALUES ($1, $2, date_trunc('minute', now()), $3)
        ON CONFLICT (workspace_id, key_id) DO UPDATE SET window_start = excluded.window_start, used = excluded.used
        RETURNING window_start`, [contact.workspaceId, key.id, 1200]);
      limited = await http('GET', `/v1/contacts/${contact.id}`, key.secret);
      if (limited.status === 429) break;
      const current = await db.query('SELECT window_start FROM api_request_budgets WHERE workspace_id = $1 AND key_id = $2', [contact.workspaceId, key.id]);
      assert.equal(current.rowCount, 1);
      if (new Date(current.rows[0].window_start).getTime() === new Date(seeded.rows[0].window_start).getTime()) break;
      // At most one retry, only for an observed real minute rollover between
      // seeding and HTTP admission; never loop through 600 requests.
    }
    assert.ok(limited);
    assert.equal(error(limited, 429, 'REQUEST_RATE_LIMITED').retryable, true);
    assert.equal(limited.headers.get('retry-after'), '60');
    await db.query('DELETE FROM api_request_budgets WHERE workspace_id = $1 AND key_id = $2', [contact.workspaceId, key.id]);
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret)).id, contact.id, 'Resetting this fixture key’s budget must restore access without replacing the key.');
  });
});

describe('Operational configuration and public event boundaries', () => {
  test('workspace settings are shared and simulated deployments reject real SES control-plane requests', async t => {
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const live = await keyFixture(t, { permissions: ['read'] });
    const before = ok(await http('GET', '/v1/settings/workspace', key.secret));
    cleanup(t, async () => { ok(await http('PATCH', '/v1/settings/workspace', key.secret, { name: before.name })); });
    const name = unique('acceptance-workspace');
    assert.equal(ok(await http('PATCH', '/v1/settings/workspace', key.secret, { name })).name, name);
    assert.equal(ok(await http('GET', '/v1/settings/workspace', reader.secret)).name, name);
    assert.equal(ok(await http('GET', '/v1/settings/workspace', live.secret)).name, name);
    error(await http('PATCH', '/v1/settings/workspace', reader.secret, { name: 'Forbidden' }), 403, 'PERMISSION_DENIED');
    error(await http('GET', '/v1/settings/ses', key.secret), 503, 'SES_NOT_CONFIGURED');
    const catalog = ok(await http('GET', '/v1/regions', key.secret));
    assert.equal(typeof catalog.defaultRegion, 'string');
    assert.ok(catalog.data.some((entry: Json) => entry.region === catalog.defaultRegion && entry.enabled && entry.isDefault));
    error(await http('GET', '/v1/domains', key.secret), 503, 'SES_NOT_CONFIGURED');
    error(await http('POST', '/v1/domains', key.secret, { name: `${unique('acceptance')}.example.com`, region: REGION }), 503, 'SES_NOT_CONFIGURED');
  });

  test('SES Auto Validation feedback records its subtype and suppresses the contact distinctly from a hard bounce', { skip: DATABASE_FIXTURE_SKIP }, async t => {
    const [{ nodeRuntime }, { operationJobs }] = await Promise.all([import('./src/adapters/node.js'), import('./src/operations.js')]);
    const db = await fixtureDatabase(t);
    const instance = nodeRuntime({ DATABASE_URL: FIXTURE_DATABASE_URL, BETTER_AUTH_SECRET: AUTH_SECRET,
      GOOGLE_CLIENT_ID: 'synthetic-validation-client', GOOGLE_CLIENT_SECRET: 'synthetic-validation-secret', AUTH_ALLOWED_EMAILS: AUTH_EMAIL,
      PUBLIC_URL: PUBLIC_ORIGIN, DEFAULT_SES_REGION: REGION, ENABLE_LIVE_SES: 'false',
      S3_BUCKET: 'synthetic-validation-fixture', S3_ACCESS_KEY_ID: 'synthetic-storage-id', S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret' });
    cleanup(t, instance.close);
    const runtime = instance.runtime;
    runtime.config.workspaceId = unique('validation-workspace');
    runtime.config.awsAccountId = '111122223333';
    const emailId = unique('validation-email'), contactId = unique('validation-contact'), providerId = unique('ses-message'), messageId = unique('sns-message');
    const bouncedId = unique('validation-email'), bouncedContactId = unique('validation-contact'), bouncedProviderId = unique('ses-message'), bouncedMessageId = unique('sns-message');
    const recipient = address(), bouncedRecipient = address(), topicArn = `arn:aws:sns:${REGION}:${runtime.config.awsAccountId}:synthetic-validation`;
    const snapshot = { from: 'sender@example.com', to: [recipient], cc: [], bcc: [], replyTo: [], region: REGION, kind: 'marketing', subject: 'Synthetic validation', text: 'Synthetic only', attachments: [], tracking: false, headers: [] };
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) VALUES($1,$2,$3,'subscribed')`, [contactId, runtime.config.workspaceId, recipient]);
      await db.query(`INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,status,provider_id,snapshot,simulated)
        VALUES($1,$2,$3,'worker','sender@example.com',$4::jsonb,'[]'::jsonb,'[]'::jsonb,'Synthetic validation','sent',$5,$6::jsonb,false)`, [emailId, runtime.config.workspaceId, REGION, JSON.stringify([recipient]), providerId, JSON.stringify(snapshot)]);
      await db.query(`INSERT INTO operation_sns_receipts(topic_arn,message_id,workspace_id) VALUES($1,$2,$3)`, [topicArn, messageId, runtime.config.workspaceId]);
      await db.query(`INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) VALUES($1,$2,$3,'subscribed')`, [bouncedContactId, runtime.config.workspaceId, bouncedRecipient]);
      await db.query(`INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,status,provider_id,snapshot,simulated)
        VALUES($1,$2,$3,'worker','sender@example.com',$4::jsonb,'[]'::jsonb,'[]'::jsonb,'Synthetic validation','sent',$5,$6::jsonb,false)`, [bouncedId, runtime.config.workspaceId, REGION, JSON.stringify([bouncedRecipient]), bouncedProviderId, JSON.stringify({ ...snapshot, to: [bouncedRecipient] })]);
      await db.query(`INSERT INTO operation_sns_receipts(topic_arn,message_id,workspace_id) VALUES($1,$2,$3)`, [topicArn, bouncedMessageId, runtime.config.workspaceId]);
      await db.query('COMMIT');
    } catch (cause) { await db.query('ROLLBACK'); throw cause; }
    cleanup(t, async () => {
      await db.query('DELETE FROM operation_events WHERE workspace_id=$1', [runtime.config.workspaceId]);
      await db.query('DELETE FROM operation_sns_receipts WHERE workspace_id=$1', [runtime.config.workspaceId]);
      await db.query('DELETE FROM sending_email_events WHERE workspace_id=$1', [runtime.config.workspaceId]);
      await db.query('DELETE FROM sending_emails WHERE workspace_id=$1', [runtime.config.workspaceId]);
      await db.query('DELETE FROM audience_contacts WHERE workspace_id=$1', [runtime.config.workspaceId]);
    });
    await operationJobs['operation.ses']!(runtime, { topicArn, messageId, region: REGION, message: {
      eventType: 'Bounce', mail: { messageId: providerId, sendingAccountId: runtime.config.awsAccountId },
      bounce: { bounceType: 'Permanent', bounceSubType: 'EmailValidationSuppressed', bouncedRecipients: [{ emailAddress: recipient }], timestamp: new Date().toISOString() },
    } }, { id: unique('validation-job'), attempts: 1, workspaceId: runtime.config.workspaceId });
    const contact = (await db.query('SELECT suppressed, suppression_reason FROM audience_contacts WHERE id=$1', [contactId])).rows[0];
    assert.deepEqual(contact, { suppressed: true, suppression_reason: 'email_validation' });
    const event = (await db.query("SELECT data FROM sending_email_events WHERE email_id=$1 AND type='validation_suppressed'", [emailId])).rows[0];
    assert.equal(event.data.bounceType, 'Permanent');
    assert.equal(event.data.bounceSubType, 'EmailValidationSuppressed');
    // It never left SES: the email is suppressed, not bounced, and carries no bounced (or accepted) metrics outcome.
    const suppressed = (await db.query('SELECT status, error_code, event_outcomes FROM sending_emails WHERE id=$1', [emailId])).rows[0];
    assert.deepEqual(suppressed, { status: 'suppressed', error_code: 'EMAIL_VALIDATION_SUPPRESSED', event_outcomes: 0 });
    const published = (await db.query("SELECT type, data FROM operation_events WHERE workspace_id=$1 AND data->>'emailId'=$2", [runtime.config.workspaceId, emailId])).rows;
    assert.deepEqual(published.map(row => [row.type, row.data.bounceSubType]), [['email.bounced', 'EmailValidationSuppressed']]);

    // A real permanent bounce keeps its existing representation.
    await operationJobs['operation.ses']!(runtime, { topicArn, messageId: bouncedMessageId, region: REGION, message: {
      eventType: 'Bounce', mail: { messageId: bouncedProviderId, sendingAccountId: runtime.config.awsAccountId },
      bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: bouncedRecipient }], timestamp: new Date().toISOString() },
    } }, { id: unique('validation-job'), attempts: 1, workspaceId: runtime.config.workspaceId });
    assert.deepEqual((await db.query('SELECT suppressed, suppression_reason FROM audience_contacts WHERE id=$1', [bouncedContactId])).rows[0], { suppressed: true, suppression_reason: 'hard_bounce' });
    assert.deepEqual((await db.query('SELECT status, error_code, event_outcomes FROM sending_emails WHERE id=$1', [bouncedId])).rows[0], { status: 'bounced', error_code: null, event_outcomes: 5 });
    assert.equal((await db.query("SELECT count(*)::int AS n FROM sending_email_events WHERE email_id=$1 AND type='bounce'", [bouncedId])).rows[0].n, 1);
  });

  test('webhook configuration rejects SSRF targets, defaults to seven events, and protects rotatable signing secrets without making deliveries', async t => {
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const live = await keyFixture(t);
    // These fixtures are always paused. Never invoke /test or delivery /retry:
    // no public HTTP callback is authorized by the ordinary acceptance suite.
    const endpoint = await resource(t, key.secret, '/v1/webhooks', { url: `https://example.com/hooks/${unique('acceptance')}`, paused: true });
    const defaults = ['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed'];
    assert.deepEqual([...endpoint.eventTypes].sort(), defaults.sort());
    assert.equal(endpoint.paused, true);
    assert.equal(endpoint.regions, null);
    for (const url of ['http://example.com/hook', 'https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/hook', 'https://localhost/hook', 'https://user:password@example.com/hook', `https://${new URL(PUBLIC_ORIGIN).hostname}/v1/events/ses`]) {
      error(await http('POST', '/v1/webhooks', key.secret, { url, paused: true }), 422, 'INVALID_WEBHOOK_URL');
    }
    error(await http('PATCH', `/v1/webhooks/${endpoint.id}`, key.secret, { url: 'https://localhost/private' }), 422, 'INVALID_WEBHOOK_URL');
    // Node delivery resolves the host itself and refuses non-global answers at connect time, so a public
    // name rebound to loopback, RFC1918, link-local metadata, CGNAT or ULA space is never connected to.
    const { isGlobalAddress, nodeWebhookFetch } = await import('./src/adapters/node.js'), dns = (await import('node:dns')).default;
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '172.31.255.255', '192.168.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fd12::1', 'fe80::1', '64:ff9b::10.0.0.1']) assert.equal(isGlobalAddress(ip), false, ip);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:93.184.216.34']) assert.equal(isGlobalAddress(ip), true, ip);
    const resolver = t.mock.method(dns, 'lookup', (_host: string, _options: unknown, callback: (error: null, addresses: { address: string; family: number }[]) => void) => callback(null, [{ address: '169.254.169.254', family: 4 }, { address: 'fd00::1', family: 6 }]));
    try { await assert.rejects(nodeWebhookFetch('https://rebound.example.org/hook', { method: 'POST', headers: {}, body: '{}', signal: AbortSignal.timeout(2000) }), { code: 'WEBHOOK_ADDRESS_BLOCKED' }); assert.equal(resolver.mock.callCount(), 1); }
    finally { resolver.mock.restore(); }
    // No host allowlist and no port rule: any public HTTPS endpoint, including a custom port, is accepted.
    const portUrl = `https://hooks.${unique('port')}.example.org:8443/mail`;
    assert.equal((await resource(t, key.secret, '/v1/webhooks', { url: portUrl, paused: true })).url, portUrl);
    await resource(t, key.secret, '/v1/inbound/webhooks', { url: `https://hooks.${unique('inbound')}.example.org:8443/mail`, paused: true });
    const reveal = await http('GET', `/v1/webhooks/${endpoint.id}/secret`, key.secret);
    const firstSecret = ok(reveal).secret;
    assert.ok(typeof firstSecret === 'string' && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(firstSecret), 'Explicit reveal must return a whsec_ credential with a standard-base64 suffix.');
    assert.equal(Buffer.from(firstSecret.slice(6), 'base64').length, 32, 'Webhook signing secret must encode 32 random bytes as base64, not hexadecimal.');
    assert.ok(Buffer.from(firstSecret.slice(6), 'base64').toString('base64') === firstSecret.slice(6), 'Webhook signing secret must use canonical standard base64.');
    assert.match(reveal.headers.get('cache-control') ?? '', /no-store/);
    error(await http('GET', `/v1/webhooks/${endpoint.id}/secret`, reader.secret), 403, 'PERMISSION_DENIED');
    error(await http('POST', `/v1/webhooks/${endpoint.id}/rotate-secret`, reader.secret), 403, 'PERMISSION_DENIED');
    const rotated = ok(await http('POST', `/v1/webhooks/${endpoint.id}/rotate-secret`, key.secret)).secret;
    assert.ok(rotated !== firstSecret, 'Rotation must create a different signing secret.');
    assert.ok(ok(await http('GET', `/v1/webhooks/${endpoint.id}/secret`, key.secret)).secret === rotated, 'The rotated credential must persist.');
    const updated = ok(await http('PATCH', `/v1/webhooks/${endpoint.id}`, key.secret, { description: 'Acceptance metadata', eventTypes: [...defaults, 'email.opened', 'email.clicked', 'contact.subscription_changed'], regions: [REGION], paused: true }));
    assert.equal(updated.eventTypes.length, 10);
    assert.deepEqual(updated.regions, [REGION]);
    const metadata = ok(await http('GET', `/v1/webhooks/${endpoint.id}`, reader.secret));
    assert.equal(metadata.description, 'Acceptance metadata');
    for (const item of [endpoint, metadata, ...(await allPages('/v1/webhooks', reader.secret))]) {
      for (const field of ['secret', 'encryptedSecret', 'signingSecret', 'signingKey']) assert.equal(item[field], undefined, `Ordinary webhook metadata must not contain ${field}.`);
    }
    ok(await http('GET', `/v1/webhooks/${endpoint.id}`, live.secret));
    assert.equal(page(await http('GET', `/v1/webhooks/${endpoint.id}/deliveries`, key.secret)).length, 0);
    assert.equal(ok(await http('DELETE', `/v1/webhooks/${endpoint.id}`, key.secret)).deleted, true);
    error(await http('GET', `/v1/webhooks/${endpoint.id}`, key.secret), 404, 'NOT_FOUND');
  });

  test('both webhook kinds encrypt custom headers and expose only permission-appropriate metadata', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, local, request }) => {
      const logs = ['info','warn','error'].map(level => t.mock.method(console, level as 'info' | 'warn' | 'error', () => {}));
      const reader = ok(await local('POST', '/v1/api-keys', { name: 'Webhook reader', permissions: ['read'] }), 201).secret;
      const inboxKey = ok(await local('POST', '/v1/inbound/keys', { name: 'Mailbox reader', permissions: ['read'] }), 201).secret;
      const value = 'Bearer ' + unique('header-canary'), replacement = unique('replacement');
      const rekeyFixtures: { path: string; table: string }[] = [];
      function noValues(data: unknown) { const text = JSON.stringify(data); assert.ok(!text.includes(value) && !text.includes(replacement), 'Plaintext webhook credential escaped.'); }
      for (const [base, table] of [['/v1/webhooks', 'operation_webhooks'], ['/v1/inbound/webhooks', 'mailbox_webhooks']]) {
        const url = 'https://example.com/headers', hdr = (name: string, v = value) => ({ name, value: v });
        const endpoint = ok(await local('POST', base, { url, headers: [hdr('Authorization'), hdr('X-Short', 'abc')], paused: true }), 201);
        const path = `${base}/${endpoint.id}`, timestamp = endpoint.headers[0].updatedAt;
        rekeyFixtures.push({ path, table });
        assert.ok(Number.isFinite(Date.parse(timestamp)));
        assert.deepEqual(endpoint.headers, [{ name: 'Authorization', hint: '••••' + value.slice(-4), updatedAt: timestamp }, { name: 'X-Short', hint: '••••', updatedAt: timestamp }]);
        noValues(endpoint);
        const stored = (await db.query(`SELECT * FROM ${table} WHERE id=$1`, [endpoint.id])).rows[0];
        noValues(stored);
        assert.match(stored.encrypted_headers, /^v1\.[0-9a-f]{16}\.[0-9a-f]{24}\.[0-9a-f]+$/);
        const { decrypt } = await import('./src/operations.js');
        const binding = `${runtime.config.workspaceId}:live:${table === 'mailbox_webhooks' ? 'mailbox:' : ''}${endpoint.id}`;
        assert.deepEqual(JSON.parse(await decrypt(runtime, stored.encrypted_headers, binding + ':headers')).headers, [hdr('Authorization'), hdr('X-Short', 'abc')]);
        await assert.rejects(decrypt(runtime, stored.encrypted_headers, binding), { code: 'KEY_ROTATION_REQUIRED' });
        for (const key of [MANAGER, reader]) {
          const detail = ok(await request('GET', path, key)), list = ok(await request('GET', base, key)).data;
          noValues(detail); noValues(list);
          const expected = key === reader ? [{ name: 'Authorization' }, { name: 'X-Short' }] : endpoint.headers;
          assert.deepEqual(detail.headers, expected); assert.deepEqual(list.find((item: Json) => item.id === endpoint.id)?.headers, expected);
        }
        assert.equal((await request('PATCH', path, reader, { headers: [] })).status, 403);
        if (table === 'mailbox_webhooks') {
          error(await request('GET', base, inboxKey), 403, 'ADMIN_REQUIRED');
          error(await request('GET', path + '/deliveries', reader), 403, 'ADMIN_REQUIRED');
        }
        error(await local('POST', base, { url, headers: [hdr('HOST')] }), 422, 'VALIDATION_FAILED');
        for (const invalid of [
          ...['content-TYPE','Content-Length','Content-Encoding','Transfer-Encoding','Connection','Keep-Alive','TE','Trailer','Upgrade','HTTP2-Settings','Expect','pRoXy-Authorization','Cookie','User-Agent','wEbHoOk-iD','Webhook-Timestamp','Webhook-Signature','OpenSend-Test','not a token','x'.repeat(65)].map(name => [hdr(name)]),
          ...['\r','\n','\x00'].map(bad => [hdr('X-Test', value + bad)]), [hdr('Authorization', 'a'.repeat(2049))],
          [hdr('X-Dup'), hdr('x-DUP')], Array.from({ length: 11 }, (_, i) => hdr(`X-${i}`)),
          Array.from({ length: 4 }, (_, i) => hdr(`X-${i}`, 'é'.repeat(1024))),
        ]) noValues(error(await local('PATCH', path, { headers: invalid }), 422, 'VALIDATION_FAILED'));
        assert.deepEqual(ok(await local('PATCH', path, { description: 'keep headers' })).headers, endpoint.headers);
        const changed = ok(await local('PATCH', path, { headers: [hdr('X-Routing_Key', replacement)] }));
        assert.deepEqual(changed.headers, [{ name: 'X-Routing_Key', hint: '••••' + replacement.slice(-4), updatedAt: changed.headers[0].updatedAt }]);
        assert.ok(Date.parse(changed.headers[0].updatedAt) > Date.parse(timestamp)); noValues(changed);
        assert.deepEqual(ok(await local('PATCH', path, { headers: [] })).headers, []);
        assert.deepEqual(ok(await local('GET', path)).headers, []);
        assert.equal((await db.query(`SELECT encrypted_headers FROM ${table} WHERE id=$1`, [endpoint.id])).rows[0].encrypted_headers, null);
      }
      // Keep the installer-wide key rotation strictly within this scenario's two fixture rows.
      for (const { table, path } of rekeyFixtures) {
        await db.query(`CREATE TEMP TABLE ${table} ON COMMIT DROP AS SELECT * FROM public.${table} WHERE workspace_id=$1`, [runtime.config.workspaceId]);
        ok(await local('PATCH', path, { headers: [{ name: 'Authorization', value }] }));
      }
      const { reencryptWebhookSecrets } = await import('./src/operations.js');
      runtime.config = { ...runtime.config, encryptionKey: createHash('sha256').update(unique('new-root')).digest('hex'), previousEncryptionKey: runtime.config.encryptionKey };
      assert.deepEqual(await reencryptWebhookSecrets(runtime.db, runtime.config), { scanned: 2, reencrypted: 2, skipped: 0, conflicted: 0 });
      delete runtime.config.previousEncryptionKey;
      for (const { path } of rekeyFixtures) assert.equal(ok(await local('GET', path)).headers[0].hint, '••••' + value.slice(-4));
      noValues(logs.flatMap(log => log.mock.calls.map(call => call.arguments)));
    });
  });

  test('unsigned or untrusted SNS envelopes fail publicly without trusting arbitrary certificate URLs', async () => {
    // http serializes strings as JSON (two extra quotes). Exactly 512 KiB reaches envelope validation.
    error(await http('POST', '/v1/events/ses', undefined, 'x'.repeat(512 * 1024 - 2)), 422, 'VALIDATION_FAILED');
    error(await http('POST', '/v1/events/ses', undefined, 'x'.repeat(512 * 1024 - 1)), 413, 'REQUEST_TOO_LARGE');
    // Without Content-Length, enforce the same limit on streamed bytes before parsing malformed JSON.
    const streamed = await fetch(`${BASE}/v1/events/ses`, { method: 'POST', duplex: 'half', body: new Blob(['x'.repeat(512 * 1024 + 1)]).stream() } as RequestInit);
    assert.equal(streamed.status, 413); assert.equal((await streamed.json() as Json).error.code, 'REQUEST_TOO_LARGE');
    const envelope = {
      Type: 'Notification', MessageId: unique('sns'), TopicArn: `arn:aws:sns:${REGION}:000000000000:acceptance-untrusted`,
      Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: unique('forged') } }),
      Timestamp: new Date().toISOString(), SignatureVersion: '2', Signature: Buffer.from('forged').toString('base64'),
      SigningCertURL: 'https://127.0.0.1/never-fetch-this.pem',
    };
    // One shared SNS peer can exceed the public failure threshold without losing the real rejection.
    for (let i = 0; i < 41; i++) error(await http('POST', '/v1/events/ses', undefined, envelope), 403, 'SNS_TOPIC_NOT_ALLOWED');
    // SNS defaults to text/plain, including signed subscription confirmations.
    // These must reach the same security checks, not fail as an absent JSON body.
    for (const contentType of ['text/plain', 'text/plain; charset=UTF-8']) {
      error(await http('POST', '/v1/events/ses', undefined, envelope, { 'content-type': contentType }), 403, 'SNS_TOPIC_NOT_ALLOWED');
      error(await http('POST', '/v1/events/ses', undefined, { ...envelope, Type: 'SubscriptionConfirmation', SubscribeURL: `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription`, Token: 'untrusted' }, { 'content-type': contentType }), 403, 'SNS_TOPIC_NOT_ALLOWED');
      error(await http('POST', '/v1/events/ses', undefined, {}, { 'content-type': contentType }), 422, 'VALIDATION_FAILED');
    }
    // Topic authorization is checked before certificate/signature work, even for malformed signatures.
    error(await http('POST', '/v1/events/ses', undefined, { ...envelope, Signature: '!!!' }), 403, 'SNS_TOPIC_NOT_ALLOWED');
  });

  test('MOCK REDIRECT TRANSPORT: SNS certificates and webhook delivery refuse redirects and retain retryable failures', async t => {
    const [{ createServer }, { once }, { createApp }, { nodeRuntime }, { drizzle }, { drainJobs }, regional, { setupResources }, { sesRegions }] = await Promise.all([
      import('node:http'), import('node:events'), import('./src/app.js'), import('./src/adapters/node.js'), import('drizzle-orm/node-postgres'),
      import('./src/dispatch.js'), import('./src/ses-region-state.js'), import('./src/ses-setup.js'), import('./src/db/ses-regions.js'),
    ]);
    const requests: Array<{ path: string; method: string }> = [];
    const callbacks: Array<{ headers: import('node:http').IncomingHttpHeaders; body: string }> = [];
    // Real loopback 302 responses exercise fetch's redirect behavior. No AWS or
    // public webhook endpoint is contacted, even if redirect refusal regresses.
    const server = createServer(async (request, response) => {
      requests.push({ path: request.url!, method: request.method! });
      if (request.url === '/webhook') {
        let body = ''; for await (const chunk of request) body += chunk;
        callbacks.push({ headers: request.headers, body });
        if (callbacks.length > 1) { response.writeHead(204); response.end(); return; }
      }
      if (request.url === '/certificate' || request.url === '/webhook') {
        response.writeHead(302, { Location: '/redirect-target' }); response.end('Redirect refused by OpenSend.');
      } else { response.writeHead(200); response.end('The redirect target must never be requested.'); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup(t, async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve())); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const loopback = `http://127.0.0.1:${address.port}`;
    const certUrl = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${unique('redirect')}.pem`;
    const webhookUrl = `https://example.com/hooks/${unique('redirect')}`;
    const nativeFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.url, certUrl, `Unexpected transport origin: ${new URL(request.url).origin}`);
      return nativeFetch(`${loopback}/certificate`, { method: request.method, headers: request.headers, redirect: request.redirect, signal: request.signal });
    });
    const db = await fixtureDatabase(t);
    const instance = nodeRuntime({ DATABASE_URL: FIXTURE_DATABASE_URL, BETTER_AUTH_SECRET: AUTH_SECRET,
      GOOGLE_CLIENT_ID: 'synthetic-redirect-client', GOOGLE_CLIENT_SECRET: 'synthetic-redirect-secret', AUTH_ALLOWED_EMAILS: AUTH_EMAIL,
      PUBLIC_URL: PUBLIC_ORIGIN, DEFAULT_SES_REGION: REGION, ENABLE_LIVE_SES: 'false',
      S3_BUCKET: 'synthetic-redirect-fixture', S3_ACCESS_KEY_ID: 'synthetic-storage-id', S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret' });
    cleanup(t, instance.close);
    const runtime = instance.runtime;
    runtime.config.workspaceId = unique('redirect-workspace');
    // The Node transport refuses loopback by design; route only this synthetic endpoint to the local 302 server.
    runtime.webhookFetch = async (url, init) => { assert.equal(url, webhookUrl); const r = await nativeFetch(`${loopback}/webhook`, { ...init, redirect: 'manual' }); await r.body?.cancel(); return { status: r.status }; };
    const app = createApp();
    const rollback = new Error('Rollback isolated redirect acceptance fixtures');
    try {
      await drizzle(db).transaction(async tx => {
        runtime.db = tx;
        await db.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $1, $1)', [runtime.config.workspaceId]);
        await db.query("UPDATE workspace_members SET workspace_id = $1 WHERE user_id = $2 AND workspace_id = 'default'", [runtime.config.workspaceId, manager!.userId]);
        await regional.ensureRegionSettings(runtime.db, runtime.config);
        const settings = await regional.getRegionSettings(runtime.db, runtime.config.workspaceId);
        const topicArn = `arn:aws:sns:${REGION}:111122223333:${setupResources(settings.installationId).topicName}`;
        await tx.insert(sesRegions).values({ workspaceId: runtime.config.workspaceId, region: REGION, trustedAccountId: '111122223333', trustedTopicArn: topicArn });
        async function local(method: string, path: string, body?: Json): Promise<Reply> {
          const response = await app.fetch(new Request(`${PUBLIC_ORIGIN}${path}`, { method,
            headers: { origin: PUBLIC_ORIGIN, cookie: manager!.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }), runtime);
          return { status: response.status, body: await response.json(), headers: response.headers };
        }
        const certificate = error(await local('POST', '/v1/events/ses', {
          Type: 'Notification', MessageId: unique('redirect-sns'), TopicArn: topicArn, Message: '{}', Timestamp: new Date().toISOString(),
          SignatureVersion: '2', Signature: Buffer.alloc(256, 1).toString('base64'), SigningCertURL: certUrl,
        }), 503, 'SNS_CERTIFICATE_UNAVAILABLE');
        assert.equal(certificate.retryable, true);
        assert.deepEqual(requests, [{ path: '/certificate', method: 'GET' }]);
        assert.equal((await db.query('SELECT count(*)::int AS count FROM operation_sns_receipts WHERE workspace_id = $1', [runtime.config.workspaceId])).rows[0].count, 0);

        const auth = 'Bearer ' + unique('callback'), replaced = 'Bearer ' + unique('replacement');
        const logs = ['info','warn','error'].map(level => t.mock.method(console, level as 'info' | 'warn' | 'error', () => {}));
        const endpoint = ok(await local('POST', '/v1/webhooks', { url: webhookUrl, paused: true, headers: [{ name: 'Authorization', value: auth }] }), 201);
        const path = `/v1/webhooks/${endpoint.id}`, secret = ok(await local('GET', path + '/secret')).secret;
        function checkCallback(index: number, value: string | undefined, synthetic: boolean) {
          const { headers, body } = callbacks[index];
          assert.equal(headers.authorization, value); assert.equal(headers['content-type'], 'application/json');
          assert.equal(headers['opensend-test'], synthetic ? 'true' : undefined); assert.equal(headers['webhook-id'], JSON.parse(body).id);
          assert.match(String(headers['webhook-timestamp']), /^\d+$/);
          assert.equal(headers['webhook-signature'], 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64'));
        }
        // These rows never commit: the external runner cannot see or deliver this
        // synthetic endpoint test. Only this normal drain uses the loopback transport.
        const queued = ok(await local('POST', `/v1/webhooks/${endpoint.id}/test`), 202);
        const wire = t.mock.method(db, 'query');
        await drainJobs(runtime,1,1);
        assert.equal(wire.mock.callCount(),2,'Claim plus atomic attempt/delivery/job settlement, including a retry.');
        wire.mock.restore();
        const delivery = ok(await local('GET', `/v1/webhooks/${endpoint.id}/deliveries/${queued.id}`));
        assert.equal(delivery.status, 'pending');
        assert.equal(delivery.lastStatusCode, 302);
        assert.equal(delivery.lastError, 'WEBHOOK_HTTP_ERROR');
        assert.equal(delivery.attemptCount, 1);
        assert.equal(delivery.attempts.length, 1);
        assert.equal(delivery.attempts[0].statusCode, 302);
        assert.equal(delivery.attempts[0].error, 'WEBHOOK_HTTP_ERROR');
        checkCallback(0, auth, true);
        const jobs = await db.query("SELECT status, attempts, last_error, available_at > now() AS delayed FROM jobs WHERE workspace_id = $1 AND type = 'operation.webhook' AND payload->>'deliveryId' = $2", [runtime.config.workspaceId, queued.id]);
        assert.deepEqual(jobs.rows, [{ status: 'pending', attempts: 1, last_error: 'WEBHOOK_HTTP_ERROR', delayed: true }]);
        // A normal delivery (unlike the synthetic test POST above) parks under the endpoint
        // lock. Resuming discovers it and queues exactly one new generation.
        await db.query('UPDATE operation_deliveries SET synthetic=false WHERE id=$1',[queued.id]);
        await db.query("UPDATE jobs SET available_at=now() WHERE workspace_id=$1 AND payload->>'deliveryId'=$2",[runtime.config.workspaceId,queued.id]);
        await drainJobs(runtime,1,1);
        assert.equal((await db.query('SELECT status FROM operation_deliveries WHERE id=$1',[queued.id])).rows[0].status,'paused');
        ok(await local('PATCH', path, { paused:false, headers: [{ name: 'Authorization', value: replaced }] }));
        assert.equal((await db.query("SELECT 1 FROM jobs WHERE payload->>'deliveryId'=$1 AND payload->>'generation'='1' AND status='pending'",[queued.id])).rowCount,1);
        assert.deepEqual(requests, [{ path: '/certificate', method: 'GET' }, { path: '/webhook', method: 'POST' }], 'Neither 302 may contact the redirect target.');
        await drainJobs(runtime,1,1);
        checkCallback(1, replaced, false);
        ok(await local('PATCH', path, { headers: [] }));
        ok(await local('POST', `${path}/deliveries/${queued.id}/retry`), 202);
        await drainJobs(runtime,1,1);
        checkCallback(2, undefined, false);
        const detail = ok(await local('GET', `${path}/deliveries/${queued.id}`));
        assert.equal(detail.attempts.length, 3); assert.equal(detail.status, 'delivered');
        const serialized = JSON.stringify([ok(await local('GET', `${path}/deliveries`)), detail, logs.flatMap(log => log.mock.calls.map(call => call.arguments))]);
        assert.ok(!serialized.includes(auth) && !serialized.includes(replaced));
        throw rollback;
      });
    } catch (cause) { if (cause !== rollback) throw cause; }
  });
});

// Live sending remains opt-in, separately from the remote database-fixture skips.
// Enabling this authorizes one real SES email, not a campaign or webhook delivery.
// Missing explicit recipient/from is a failure.
test('LIVE SES: one explicitly authorized recipient reaches provider acceptance (not a delivery claim)', { skip: process.env.LIVE_SES_TEST !== '1' ? 'Set LIVE_SES_TEST=1, SES_TEST_RECIPIENT and SES_TEST_FROM to authorize one real email.' : false }, async t => {
  const to = process.env.SES_TEST_RECIPIENT;
  const from = process.env.SES_TEST_FROM;
  assert.ok(to && from, 'LIVE_SES_TEST=1 requires explicit SES_TEST_RECIPIENT and SES_TEST_FROM; no live send was attempted.');
  const key = await keyFixture(t, { permissions: ['read', 'send'], domains: [from.split('@')[1]] });
  const queued = ok(await http('POST', '/v1/emails/send', key.secret, {
    from, to, region: process.env.SES_TEST_REGION ?? REGION,
    subject: unique('OpenSend authorized live acceptance'), text: 'One explicitly authorized OpenSend acceptance email. Provider acceptance is not a delivery claim.', kind: 'transactional',
  }, { 'Idempotency-Key': unique('authorized-live') }), 202);
  assert.equal(queued.environment, undefined);
  assert.equal(queued.simulated, false);
  const accepted = await poll(`/v1/emails/${queued.id}`, key.secret, body => typeof body.providerId === 'string' && body.providerId.length > 0);
  assert.equal(accepted.simulated, false);
  assert.ok(['accepted', 'sent', 'delivered', 'bounced', 'complained', 'delayed'].includes(accepted.status), 'A provider ID alone must not conceal an explicit failed or ambiguous send.');
});

// In-process simulated-provider scenarios use the actual SQL/API/job handlers in a
// rollback-only workspace. The external runner cannot observe these rows. Execute
// selected durable jobs serially so each acceptance/feedback boundary is observable;
// PostgreSQL now() is fixed inside the outer rollback transaction.
async function simulatedSesFixture(t: TestContext, scenario: (fixture: {
  runtime: import('./src/core.js').Runtime;
  db: pg.Client;
  request: typeof http;
  local: (method: string, path: string, body?: Json, environment?: 'test' | 'live', headers?: Record<string, string>) => Promise<Reply>;
  run: (type: string) => Promise<void>;
  jobs: (type: string) => Promise<Json[]>;
}) => Promise<void>) {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(FIXTURE_DATABASE_URL!).hostname), 'Simulated SES fixtures require an isolated local database.');
  const [{ createApp }, { nodeRuntime }, { drizzle }, { jobHandlers }, { operationJobs }, { ensureRegionSettings }, { dispatchDue }, { JobDeferred }] = await Promise.all([
    import('./src/app.js'), import('./src/adapters/node.js'), import('drizzle-orm/node-postgres'), import('./src/sending.js'),
    import('./src/operations.js'), import('./src/ses-region-state.js'), import('./src/dispatcher.js'), import('./src/jobs.js'),
  ]);
  const db = await fixtureDatabase(t);
  const instance = nodeRuntime({ DATABASE_URL: FIXTURE_DATABASE_URL, BETTER_AUTH_SECRET: AUTH_SECRET,
    GOOGLE_CLIENT_ID: 'synthetic-simulator-client', GOOGLE_CLIENT_SECRET: 'synthetic-simulator-secret', AUTH_ALLOWED_EMAILS: AUTH_EMAIL,
    PUBLIC_URL: PUBLIC_ORIGIN, DEFAULT_SES_REGION: REGION, ENABLE_LIVE_SES: 'false',
    S3_BUCKET: 'synthetic-simulator-fixture', S3_ACCESS_KEY_ID: 'synthetic-storage-id', S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret' });
  cleanup(t, instance.close);
  const runtime = instance.runtime;
  runtime.config.workspaceId = unique('simulated-ses-workspace');
  assert.deepEqual(runtime.config.simulatedSes, { latencyMs: 100, maxSendRate: 1000, deliveryDelayMs: 250 }, 'Test dispatch must default to the 100 ms provider simulator.');
  runtime.config.simulatedSes.latencyMs = 0;
  const app = createApp(), handlers = { ...jobHandlers, ...operationJobs };
  const rollback = new Error('Rollback isolated simulated SES fixtures');
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network is forbidden in simulated SES acceptance scenarios.'); });
  try {
    await drizzle(db).transaction(async tx => {
      runtime.db = tx;
      await db.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $1, $1)', [runtime.config.workspaceId]);
      await db.query("UPDATE workspace_members SET workspace_id = $1 WHERE user_id = $2 AND workspace_id = 'default'", [runtime.config.workspaceId, manager!.userId]);
      const request: typeof http = (method, path, key, body, headers, timeout) => http(method, path, key, body, headers, timeout, PUBLIC_ORIGIN, req => app.fetch(req, runtime));
      await ensureRegionSettings(runtime.db, runtime.config);
      async function local(method: string, path: string, body?: Json, environment: 'test' | 'live' = 'live', headers: Record<string, string> = {}): Promise<Reply> {
        const response = await app.fetch(new Request(`${PUBLIC_ORIGIN}${path}`, { method,
          headers: { origin: PUBLIC_ORIGIN, cookie: manager!.cookie, 'x-opensend-environment': environment, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }), runtime);
        return { status: response.status, body: await response.json(), headers: response.headers };
      }
      const jobs = async (type: string): Promise<Json[]> => (await db.query('SELECT * FROM jobs WHERE workspace_id = $1 AND type = $2 ORDER BY available_at, id', [runtime.config.workspaceId, type])).rows;
      async function run(type: string) {
        // Mail is no longer a job: the dispatcher claims due rows for one region directly.
        if (type === 'email.dispatch') {
          const accountId = runtime.config.multiTenant ? (await db.query('SELECT aws_account_id FROM provider_simulated_connections WHERE workspace_id=$1',[runtime.config.workspaceId])).rows[0]?.aws_account_id : undefined;
          await dispatchDue(runtime, REGION, {accountId}); return;
        }
        assert.ok(handlers[type], `No handler for ${type}`);
        const pending = (await jobs(type)).filter(job => job.status === 'pending');
        assert.ok(pending.length, `Expected a pending ${type} job.`);
        for (const job of pending) {
          await db.query("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = $1", [job.id]);
          try {
            await handlers[type]!(runtime, job.payload, { id: job.id, attempts: job.attempts + 1, workspaceId: job.workspace_id });
          } catch (error) {
            // Mirror processJobs: a deferral returns the same row to pending without consuming an attempt.
            if (!(error instanceof JobDeferred)) throw error;
            await db.query("UPDATE jobs SET status = 'pending', attempts = attempts - 1, lease_until = NULL, last_error = NULL, available_at = $2, payload = coalesce($3::jsonb, payload) WHERE id = $1", [job.id, error.availableAt, error.payload ? JSON.stringify(error.payload) : null]);
            continue;
          }
          await db.query("UPDATE jobs SET status = 'completed' WHERE id = $1", [job.id]);
        }
      }
      await scenario({ runtime, db, local, run, jobs, request });
      assert.equal(network.mock.callCount(), 0, 'No provider, webhook, certificate or credential network request is allowed.');
      throw rollback;
    });
  } catch (cause) { if (cause !== rollback) throw cause; }
}

describe('SIMULATED SES: real SDK transport and direct event fanout', () => {
  test('an idle DispatcherShard dispatches inline and does not reprobe placement on eviction', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db }) => {
      // Node has no DO host; provide only its base constructor, storage and waitUntil.
      const { registerHooks } = await import('node:module');
      const hook = registerHooks({ resolve(specifier, context, next) {
        return specifier === 'cloudflare:workers' ? { shortCircuit:true, url:'data:text/javascript,export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}' } : next(specifier, context);
      } });
      const { DispatcherShard } = await import('./src/dispatcher-do.js').finally(() => hook.deregister());
      const stored = new Map<string, unknown>(), pending: Promise<unknown>[] = [], alarms: number[] = [];
      const ctx = { storage: { get:(k:string)=>stored.get(k), put:(k:string,v:unknown)=>stored.set(k,v), getAlarm:()=>null, setAlarm:(at:number)=>alarms.push(at) }, waitUntil:(p:Promise<unknown>)=>pending.push(p) };
      let probes = 0, statusAtProbe: string | undefined;
      const receipt = ok(await local('POST', '/v1/emails/send', mail()), 202);
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        probes++; statusAtProbe = (await db.query('SELECT status FROM sending_emails WHERE id=$1',[receipt.id])).rows[0].status;
        return new Response('colo=TEST');
      };
      try { for (let i = 0; i < 2; i++) {
        const shard = new DispatcherShard(ctx as unknown as DurableObjectState, {} as Env);
        Object.assign(shard, { runtime: async () => runtime });
        assert.equal((await shard.fetch(new Request(`https://dispatcher/wake?region=${REGION}`))).status, 200);
        while (pending.length) await Promise.all(pending.splice(0));
      } } finally { globalThis.fetch = previousFetch; }
      assert.deepEqual(alarms, []); assert.equal(probes, 1); assert.equal(statusAtProbe, 'accepted');
    });
  });
  test('request logs identify a rejected field without disclosing an address in its error message', async t => {
    await simulatedSesFixture(t, async ({ local }) => {
      const logs: string[] = [];
      for (const level of ['error', 'info', 'warn'] as const) t.mock.method(console, level, (line: string) => logs.push(line));
      const email = 'private@example.net';
      const failure = error(await local('POST', '/v1/audience-query/query', { statement: `SELECT email FROM contacts WHERE email = ${email}` }), 422, 'AUDIENCEQL_INVALID');
      assert.ok(failure.message.includes(email), 'The detailed API response is unchanged.');
      const logged = logs.map(line => JSON.parse(line)).find(entry => entry.requestId === failure.requestId && entry.code === failure.code);
      assert.equal(logged?.field, 'statement'); assert.equal(logged.message, undefined);
      assert.ok(!logs.some(line => line.includes(email)));
    });
  });

  test('MX Worker placement uses bounded public edge HEAD probes, not raw TLS',async t=>{
    const {publicSignals}=await import('./src/placement-probes.js'),tls=(await import('node:tls')).default;
    const sockets=t.mock.method(tls,'connect',()=>{throw Error('No Worker TCP');});
    const host='edge.placement-fixture.com',root='placement-fixture.com',zone='dbl.invalid';
    let active=0,peak=0,heads=0,canceled=0,mode='ok';
    t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
      const u=new URL(String(input));peak=Math.max(peak,++active);
      try {
        assert.equal(init?.redirect,'manual');assert.ok(init?.signal);
        await new Promise(r=>setTimeout(r,2));
        if(u.hostname===host) {
          assert.equal(init!.method,'HEAD');assert.equal(u.href,`https://${host}/`); heads++;
          if(mode==='rebound') throw new TypeError('Edge refused private destination');
          return new Response(new ReadableStream({cancel(){canceled++;}}),{status:mode==='redirect'?302:200,
            headers:mode==='redirect'?{location:'https://127.0.0.1/'}:{'content-type':'text/html'}});
        }
        if(u.hostname==='rdap.verisign.com') return Response.json({ldhName:root,events:[{eventAction:'registration',eventDate:'2018-01-01'}]});
        assert.equal(u.hostname,'cloudflare-dns.com');const name=u.searchParams.get('name');
        if(name===host && u.searchParams.get('type')==='A') return Response.json({Status:0,Answer:[{name,type:1,data:mode==='private'?'10.2.3.4':'104.16.0.1'}]});
        return Response.json({Status:3,Authority:[{name:zone,type:6,data:'fixture SOA'}]});
      } finally {active--;}
    });
    const run=(slots:number)=>publicSignals(host,root,false,zone,AbortSignal.timeout(2000),{probesPerJob:slots});
    assert.equal((await run(3)).site,'live');assert.equal(peak,3);assert.equal(canceled,1);
    peak=0;mode='redirect';assert.equal((await run(1)).site,'redirect');assert.equal(peak,1);assert.equal(heads,2);assert.equal(canceled,2);
    mode='private';assert.equal((await run(1)).site,null);assert.equal(heads,2,'A private DoH answer must not reach edge fetch.');
    mode='rebound';assert.equal((await run(1)).site,null);assert.equal(heads,3);assert.equal(sockets.mock.callCount(),0,'Never bypass a failed edge check with raw TLS.');
  });

  test('MX shadow placement enqueues without probing, persists one private observation and never routes',async t=>{
    await simulatedSesFixture(t,async({runtime,db,local,jobs})=>{
      const {loadConfig}=await import('./src/config.js'), {operationJobs}=await import('./src/operations.js');
      const {SESv2Client}=await import('@aws-sdk/client-sesv2'), tls=(await import('node:tls')).default,{EventEmitter}=await import('node:events');
      const cfg={BETTER_AUTH_SECRET:'fixture-'.repeat(6),PUBLIC_URL:'https://fixture.example.com'};
      assert.equal(loadConfig({...cfg,MX_PLACEMENT_SHADOW:'true'}).placementShadow,false);
      assert.equal(loadConfig({...cfg,MULTI_TENANT:'true'}).placementShadow,true);
      assert.equal(loadConfig({...cfg,MULTI_TENANT:'true',MX_PLACEMENT_SHADOW:'false'}).placementShadow,false);
      const wid=runtime.config.workspaceId,oh='us-east-2',type='domain.placement',zone='licensed-dbl.invalid';
      const create=(name:string)=>local('POST','/v1/domains',{name});
      const wire:string[]=[],ips:string[]=[],aws:string[]=[]; let mode:'live'|'private'|'redirect'|'timeout'|'listed'='live';
      let spfRecord='v=spf1 include:_spf.example.net ~all';
      t.mock.method(SESv2Client.prototype,'send',async(cmd:any)=>{
        aws.push(cmd.constructor.name);assert.ok(['GetEmailIdentityCommand','CreateEmailIdentityCommand'].includes(cmd.constructor.name));
        return {DkimAttributes:{Tokens:['aaa','bbb','ccc'],SigningHostedZone:'dkim.fixture',Status:'PENDING'}};
      });
      t.mock.method(tls,'connect',(opts:{host:string;servername:string;rejectUnauthorized:boolean},ready:()=>void)=>{
        ips.push(opts.host);assert.equal(opts.host,'93.184.216.34');assert.equal(opts.rejectUnauthorized,true);
        const socket=Object.assign(new EventEmitter(),{destroy(){ socket.emit('close'); },write(s:string){
          assert.equal(s,`HEAD / HTTP/1.1\r\nHost: ${opts.servername}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`);
          socket.emit('data',Buffer.from(mode==='redirect'?'HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1/\r\n\r\n':'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n'));
        }});queueMicrotask(ready);return socket;
      });
      const forbiddenFetch=globalThis.fetch;
      globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
        const u=new URL(String(input));wire.push(u.href);assert.equal(init?.redirect,'manual');
        if(mode==='timeout') return new Promise<Response>((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('fixture timeout')),{once:true}));
        if(u.hostname!=='cloudflare-dns.com') {assert.equal(u.hostname,'rdap.verisign.com');return Response.json({ldhName:u.pathname.split('/').at(-1),events:[{eventAction:'registration',eventDate:'2018-01-01T00:00:00Z'}]});}
        const name=u.searchParams.get('name')!,q=u.searchParams.get('type');
        const reply=(type:number,data:string)=>Response.json({Status:0,Answer:[{name,type,data}]});
        if(name.endsWith('.'+zone)) return mode==='listed' && name==='example.com.'+zone ? reply(1,'127.0.1.2'):Response.json({Status:3,Authority:[{name:zone,type:6,data:'fixture SOA'}]});
        if(q==='MX') return reply(15,'10 inbound.example.net.');
        if(q==='A') return reply(1,mode==='private'?'169.254.169.254':'93.184.216.34');
        assert.equal(q,'TXT');return reply(16,name.startsWith('_dmarc.')?'"v=DMARC1; p=reject"':JSON.stringify(spfRecord));
      };
      try {
      Object.assign(runtime.config,{liveEnabled:true,aws:{accessKeyId:'fixture',secretAccessKey:'fixture'}});
      ok(await create('selfhost.fixture.com'),201);assert.equal((await jobs(type)).length,0);assert.equal(wire.length,0);
      Object.assign(runtime.config,{multiTenant:true,placementShadow:false});
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES($1,$1,$2,'ready','shared','111122223333','ready')`,[wid,oh]);
      await db.query(`UPDATE ses_installation_settings SET default_region=$2,enabled_regions=jsonb_build_array($2::text) WHERE workspace_id=$1`,[wid,oh]);
      await db.query(`UPDATE auth_user SET google_hosted_domain='example.com',email_verified=true WHERE id=$1`,[manager!.userId]);
      await db.query(`UPDATE workspace_members m SET created_at=w.created_at FROM workspaces w WHERE m.workspace_id=w.id AND w.id=$1`,[wid]);
      const prior=ok(await create('off.example.com'),201);
      assert.equal((await jobs(type)).length,0); runtime.config.placementShadow=true;
      const added=ok(await create('first.example.com'),201);
      assert.equal(wire.length+ips.length,0,'No placement I/O before returning the ordinary 201 and SES DNS.');
      assert.deepEqual([added.region,added.verified,added.ready,added.dns.map((r:Json)=>r.type)],[oh,prior.verified,prior.ready,prior.dns.map((r:Json)=>r.type)]);
      const run=async(id:string)=>{
        const pending=(await jobs(type)).filter(j=>j.payload.domainId===id);assert.equal(pending.length,1);
        await operationJobs[type]!(runtime,pending[0].payload,{id:pending[0].id,attempts:1,workspaceId:wid});
        return (await db.query('SELECT * FROM domain_placement_shadow WHERE domain_id=$1',[id])).rows[0];
      };
      runtime.config.multiTenant=false;assert.equal(await run(added.id),undefined);assert.equal(wire.length,0);runtime.config.multiTenant=true;
      const first=await run(added.id);assert.equal(first.decision,'ohio');assert.equal(first.score,9);assert.equal(first.policy_version,2);
      assert.ok(first.reasons.includes('dbl_unconfigured'));assert.equal(first.signals.dbl,'unconfigured');assert.ok(first.recorded_at>=first.started_at);
      assert.equal(wire.filter(u=>u.includes('rdap.verisign.com')).length,1);assert.ok(wire.some(u=>u.endsWith('/domain/example.com')));
      assert.deepEqual(wire.filter(u=>u.includes('type=A')).map(u=>new URL(u).searchParams.get('name')),['first.example.com'],'No DBL or second site resolution.');
      const before=wire.length;assert.deepEqual(await run(added.id),first);assert.equal(wire.length,before);
      const details=ok(await local('GET','/v1/domains/'+added.id));assert.deepEqual(details,added);assert.ok(!('placement' in details));
      assert.deepEqual(ok(await create(added.name),201),added);assert.equal((await jobs(type)).length,1);
      runtime.config.placementDblZone=zone;
      const profile=async(host:string)=>run(ok(await create(host),201).id);
      const trusted=await profile('yes.example.com');assert.equal(trusted.decision,'virginia');assert.equal(trusted.signals.verifiedSignup,true);
      assert.equal((await db.query('SELECT region FROM domain_sending_bindings WHERE domain_id=$1',[trusted.domain_id])).rows[0].region,oh);
      const lookalike=await profile('xn--pypal-4ve.com');assert.equal(lookalike.decision,'hold');assert.ok(lookalike.reasons.includes('brand_lookalike'));
      mode='listed';const listed=await profile('bad.example.com');assert.equal(listed.decision,'hold');assert.ok(listed.reasons.includes('blocklisted'));
      mode='private';const sockets=ips.length;const refused=await profile('private.example.com');assert.equal(refused.signals.site,null);assert.equal(ips.length,sockets);
      mode='redirect';assert.equal((await profile('redirect.example.com')).signals.site,'redirect');assert.equal(ips.length,sockets+1,'No follow to the private redirect target.');
      mode='timeout';const start=performance.now(),timeout=await profile('new-fixture.com');
      assert.ok(performance.now()-start<2600,'One 2s budget, not one timeout per lookup.');assert.equal(timeout.decision,'ohio');assert.equal(timeout.score,0);
      assert.equal(timeout.signals.dbl,'unknown');assert.equal(timeout.signals.ageDays,null);assert.deepEqual(timeout.signals.exact,{mx:null,spf:null,dmarc:null});
      mode='live';
      await db.query(`UPDATE domain_claims SET ever_proven=true WHERE workspace_id=$1`,[wid]);
      for(const [i,term] of ['+all','all','?all','mx','~all','-all'].entries()) {
        spfRecord='v=spf1 '+term;const sample=await profile(`spf-${i}.example.com`),closed=['~all','-all'].includes(term);
        assert.equal(sample.signals.exact.spf,closed,spfRecord);assert.equal(sample.score,closed?9:8,spfRecord);
      }
      await db.query(`UPDATE domain_claims SET ever_proven=true WHERE workspace_id=$1`,[wid]);
      const shared=await profile('store.wordpress.com');assert.equal(shared.signals.root,'store.wordpress.com');assert.equal(shared.signals.ageDays,null);
      assert.ok(!wire.some(u=>u.endsWith('/domain/wordpress.com') || new URL(u).searchParams.get('name')==='wordpress.com'));
      const noAnchor=await profile('mail.other-fixture.com');assert.equal(noAnchor.score,7);assert.equal(noAnchor.decision,'ohio');assert.ok(noAnchor.reasons.includes('no_anchor'));
      // These are historical database rows only; no dispatch, SMTP, or provider calls.
      const hist='past.other-fixture.com';
      await db.query(`INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,status,provider_id,snapshot,simulated,created_at)
        SELECT 'shadow-history-'||i,$1,$2,'fixture','test@'||$3,to_jsonb(array_fill('dest@example.net'::text,ARRAY[50])),'[]','[]','fixture','accepted','shadow-provider-'||i,'{}',false,now()-(i||' days')::interval FROM generate_series(0,19) i`,[wid,oh,hist]);
      await db.query(`INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated,created_at) SELECT 'shadow-event-'||id,$1,id,'accepted',false,created_at FROM sending_emails WHERE workspace_id=$1 AND id LIKE 'shadow-history-%'`,[wid]);
      const tracked=await profile(hist);assert.equal(tracked.decision,'virginia');assert.equal(tracked.score,10);
      assert.deepEqual(tracked.signals.domainHistory,{accepted:1000,bounces:0,complaints:0,spanDays:19});
      await db.query(`UPDATE workspaces SET created_at=created_at-interval '40 days' WHERE id=$1`,[wid]);
      await db.query('DELETE FROM hosted_health_hourly WHERE workspace_id=$1',[wid]);
      await db.query(`INSERT INTO hosted_health_hourly VALUES($1,'-infinity',date_trunc('hour',now())-interval '31 days',5000,99,1),($1,'-infinity',date_trunc('hour',now()),5000,0,0)`,[wid]);
      const mature=await profile('mature.other-fixture.com');assert.equal(mature.decision,'virginia');assert.ok(mature.reasons.includes('clean_workspace'));
      for(const [bounces,complaints] of [[100,1],[99,2]]) {
        await db.query(`UPDATE hosted_health_hourly SET bounces=$2,complaints=$3 WHERE workspace_id=$1 AND hour<now()-interval '30 days'`,[wid,bounces,complaints]);
        const boundary=await profile(`edge-${complaints}.other-fixture.com`);assert.equal(boundary.decision,'ohio');assert.equal(boundary.signals.cleanWorkspaceDays,null);
      }
      await db.query(`UPDATE provider_connections SET paused_at=now(),pause_reason='synthetic hold' WHERE workspace_id=$1`,[wid]);
      const held=await profile('held.example.com');assert.equal(held.decision,'hold');assert.ok(held.reasons.includes('active_abuse_hold'));
      const samples:number[][]=[[],[]], dbCounts:number[][]=[[],[]],probeCount=wire.length;
      const queries=t.mock.method(db,'query');
      for(let i=0;i<40;i++) {
        await db.query(`UPDATE domain_claims SET ever_proven=true WHERE workspace_id=$1 AND NOT ever_proven`,[wid]);
        const on=i%2;runtime.config.placementShadow=!!on;const from=queries.mock.callCount(),start=performance.now();
        ok(await create(`latency-${i}.example.com`),201);samples[on].push(performance.now()-start);dbCounts[on].push(queries.mock.callCount()-from);
      }
      assert.equal(wire.length,probeCount);assert.deepEqual(dbCounts[0],dbCounts[1],'No added database round trip.');
      const p95=samples.map(times=>times.sort((a,b)=>a-b)[18]!);t.diagnostic(`Synthetic fresh POST p95 (20 each, alternating): off ${p95[0].toFixed(1)} ms / on ${p95[1].toFixed(1)} ms; ${dbCounts[1][0]} DB calls.`);
      assert.ok(p95[1]<250);queries.mock.restore();
      assert.ok(aws.every(c=>['GetEmailIdentityCommand','CreateEmailIdentityCommand'].includes(c)));
      } finally { globalThis.fetch=forbiddenFetch; }
    });
  });

  test('Hosted trusted pool: concurrent setup, signed publish, fenced send-only adoption and retention',async t=>{
    const [{nodeRuntime},{createApp},{trustedProvision},{setDomainPool},{adoptIdentities},{ensureRegionSettings},{JobDeferred},{SESv2Client},{SNSClient},{STSClient},{SESClient},{S3Client}]=await Promise.all([
      import('./src/adapters/node.js'),import('./src/app.js'),import('./src/trusted-pool.js'),import('./scripts/set-domain-pool.js'),import('./scripts/adopt-identities.js'),import('./src/ses-region-state.js'),import('./src/jobs.js'),import('@aws-sdk/client-sesv2'),import('@aws-sdk/client-sns'),import('@aws-sdk/client-sts'),import('@aws-sdk/client-ses'),import('@aws-sdk/client-s3')]);
    const db=await fixtureDatabase(t),user=await sessionFixture(t),wid='ws_'+randomUUID().replaceAll('-',''),va='us-east-1',oh='us-east-2',acct='438095551154',tenant='opensendmx-trusted-'+wid,
      topic=`arn:aws:sns:${va}:${acct}:opensendmx-trusted-feedback`,tenantArn=`arn:aws:ses:${va}:${acct}:tenant/${tenant}/tenant-fixture`,flags={MULTI_TENANT:'true',MX_REGIONAL_SENDING:'true',MX_TRUSTED_POOL:'true'};
    const instance=nodeRuntime({...flags,DATABASE_URL:FIXTURE_DATABASE_URL,BETTER_AUTH_SECRET:AUTH_SECRET,GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',AUTH_ALLOWED_DOMAINS:'example.com',PUBLIC_URL:PUBLIC_ORIGIN,ENABLE_LIVE_SES:'true',AWS_ACCESS_KEY_ID:'fixture-trusted',AWS_SECRET_ACCESS_KEY:'fixture-only',S3_BUCKET:'fixture',S3_ACCESS_KEY_ID:'fixture',S3_SECRET_ACCESS_KEY:'fixture'});
    const runtime=instance.runtime,app=createApp();cleanup(t,instance.close);
    await db.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)',[wid]);
    cleanup(t,async()=>{
      await db.query('DELETE FROM jobs WHERE workspace_id=$1',[wid]);await db.query('DELETE FROM operation_domains WHERE workspace_id=$1',[wid]);
      await db.query('DELETE FROM domain_claims WHERE workspace_id=$1',[wid]);await db.query('DELETE FROM provider_feedback_history WHERE topic_arn=$1',[topic]);
      await db.query('DELETE FROM provider_pool_regions WHERE region=$1 AND aws_account_id=$2 AND NOT legacy_names',[va,acct]);
      await db.query('DELETE FROM hosted_adoptions WHERE workspace_id=$1',[wid]);await db.query('DELETE FROM hosted_operator_audit WHERE workspace_id=$1',[wid]);await db.query('DELETE FROM hosted_tenant_ownership WHERE workspace_id=$1',[wid]);
      await db.query('DELETE FROM ses_installation_settings WHERE workspace_id=$1',[wid]);await db.query('DELETE FROM workspaces WHERE id=$1',[wid]);
    });
    await db.query("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'owner')",[unique('member'),wid,user.userId]);
    await ensureRegionSettings(runtime.db,{...runtime.config,workspaceId:wid,regions:[oh]});
    await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES($1,$1,$2,'ready','shared',$3,'ready')`,[wid,oh,acct]);
    const api=async(method:string,path:string,body?:Json):Promise<Reply>=>{const res=await app.fetch(new Request(PUBLIC_ORIGIN+path,{method,headers:{cookie:user.cookie,origin:PUBLIC_ORIGIN,'x-opensend-workspace':wid,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}),runtime);return {status:res.status,headers:res.headers,body:await res.json()};};
    const signedKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey,pem=(await import('node:child_process')).execFileSync('openssl',['req','-new','-x509','-key','/dev/stdin','-days','1','-subj','/CN=fixture'],{input:signedKey.export({format:'pem',type:'pkcs8'}),encoding:'utf8'});
    let confirmed=false,policy='',sub:Json|undefined,drift=false,failAssociation=true;const calls:string[]=[],sets=new Map<string,Json>(),members=new Set<string>();
    const missing=()=>Object.assign(new Error('not found'),{name:'NotFoundException'});
    const tags=(purpose:string)=>({'opensend:owner':'mx','opensend:installation-id':'opensend-mx:pool','opensend:purpose':purpose});
    const checkTags=(ts:Json[],purpose:string)=>assert.deepEqual(Object.fromEntries(ts.map(t=>[t.Key,t.Value])),tags(purpose));
    let managedTags:{Key:string;Value:string}[]=[];
    t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{const u=new URL(String(input));if(u.hostname==='cloudflare-dns.com') {const name=u.searchParams.get('name');return Response.json({Status:0,Answer:name===`_opensend.${managed}`?[{name,type:16,data:JSON.stringify(managedTags[0]?.Value)}]:[]});}assert.equal(u.hostname,`sns.${va}.amazonaws.com`);if(u.pathname.endsWith('.pem'))return new Response(pem);assert.equal(u.searchParams.get('TopicArn'),topic);confirmed=true;return new Response(null);});
    t.mock.method(SESClient.prototype,'send',()=>assert.fail('Virginia receipt call'));t.mock.method(S3Client.prototype,'send',()=>assert.fail('Virginia S3 call'));
    t.mock.method(STSClient.prototype,'send',(cmd:any)=>{assert.equal(cmd.constructor.name,'GetCallerIdentityCommand');return {Account:acct,Arn:`arn:aws:iam::${acct}:user/opensend-mx`};});
    const identity=(name:string)=>({IdentityType:'DOMAIN',VerificationStatus:'SUCCESS',VerifiedForSendingStatus:true,DkimAttributes:{SigningEnabled:true,Status:'SUCCESS',SigningAttributesOrigin:'AWS_SES',SigningHostedZone:'dkim.amazonses.com',Tokens:['c','a','b']},MailFromAttributes:{MailFromDomain:`bounce.${name}`,MailFromDomainStatus:'SUCCESS',BehaviorOnMxFailure:'USE_DEFAULT_VALUE'}});
    const managed='canary.trusted-fixture.test';
    t.mock.method(SESv2Client.prototype,'send',async function(this:InstanceType<typeof SESv2Client>,cmd:any){const i=cmd.input,n=cmd.constructor.name;calls.push(n);assert.equal(await this.config.region(),va);
      if(i.ConfigurationSetName)assert.match(i.ConfigurationSetName,/^opensendmx-trusted-(transactional|marketing)$/);
      switch(n){
        case 'GetAccountCommand':return {SendingEnabled:true,EnforcementStatus:'HEALTHY',ProductionAccessEnabled:true,SendQuota:{Max24HourSend:100000,MaxSendRate:100}};
        case 'GetConfigurationSetCommand':if(!sets.has(i.ConfigurationSetName))throw missing();return sets.get(i.ConfigurationSetName);
        case 'CreateConfigurationSetCommand':assert.ok(!sets.has(i.ConfigurationSetName));checkTags(i.Tags,'ses-feedback');sets.set(i.ConfigurationSetName,{...i,dest:[]});return {};
        case 'GetConfigurationSetEventDestinationsCommand':return {EventDestinations:sets.get(i.ConfigurationSetName)!.dest};
        case 'PutConfigurationSetSuppressionOptionsCommand':assert.equal(i.SuppressionScope,'TENANT');sets.get(i.ConfigurationSetName)!.SuppressionOptions=i;return {};
        case 'CreateConfigurationSetEventDestinationCommand':assert.ok(confirmed);assert.equal(i.EventDestination.SnsDestination.TopicArn,topic);sets.get(i.ConfigurationSetName)!.dest.push({Name:i.EventDestinationName,...i.EventDestination});return {};
        case 'CreateTenantCommand':assert.equal(i.TenantName,tenant);checkTags(i.Tags,'workspace-tenant');assert.deepEqual(i.SuppressionAttributes,{SuppressionScope:'TENANT',SuppressedReasons:['BOUNCE','COMPLAINT']});return {TenantName:tenant,TenantArn:tenantArn};
        case 'UpdateReputationEntityPolicyCommand':assert.equal(i.ReputationEntityReference,tenantArn);assert.equal(i.ReputationEntityPolicy,`arn:aws:ses:${va}:aws:reputation-policy/strict`);return {};
        case 'CreateTenantResourceAssociationCommand':assert.equal(i.TenantName,tenant);if(i.ResourceArn.includes(':configuration-set/'))assert.ok(sets.has(i.ResourceArn.split('/')[1]));else if (failAssociation && members.size===3){failAssociation=false;throw new Error('interrupted');}assert.ok(!members.has(i.ResourceArn));members.add(i.ResourceArn);return {};
        case 'ListResourceTenantsCommand':return {ResourceTenants:members.has(i.ResourceArn)?[{TenantName:tenant,TenantId:'tenant-fixture',ResourceArn:i.ResourceArn}]:[]};
        case 'GetEmailIdentityCommand':if(i.EmailIdentity===managed && !managedTags.length)throw missing();return {...identity(i.EmailIdentity),Tags:i.EmailIdentity===managed?managedTags:[],ConfigurationSetName:drift?'changed':undefined};
        case 'CreateEmailIdentityCommand':assert.equal(i.EmailIdentity,managed);checkTags(i.Tags.filter((t:Json)=>t.Key!=='opensend:domain-claim'),'domain-identity');managedTags=i.Tags;return {Tags:i.Tags};
        case 'DeleteTenantResourceAssociationCommand':assert.equal(i.ResourceArn,`arn:aws:ses:${va}:${acct}:identity/${managed}`);assert.ok(members.delete(i.ResourceArn));return {};
        case 'DeleteEmailIdentityCommand':assert.equal(i.EmailIdentity,managed);managedTags=[];return {};
        default:assert.fail(n);
      }
    });
    t.mock.method(SNSClient.prototype,'send',async function(this:InstanceType<typeof SNSClient>,cmd:any){assert.equal(await this.config.region(),va);const i=cmd.input,n=cmd.constructor.name;calls.push(n);
      if(i.TopicArn || i.ResourceArn)assert.equal(i.TopicArn??i.ResourceArn,topic);
      switch(n){
        case 'GetTopicAttributesCommand':if(!policy)throw missing();return {Attributes:{TopicArn:topic,Owner:acct,Policy:policy}};
        case 'CreateTopicCommand':assert.equal(i.Name,'opensendmx-trusted-feedback');assert.ok(!policy);checkTags(i.Tags,'ses-feedback');policy=i.Attributes.Policy;assert.equal(JSON.parse(policy).Statement.length,1);return {TopicArn:topic};
        case 'ListTagsForResourceCommand':return {Tags:Object.entries(tags('ses-feedback')).map(([Key,Value])=>({Key,Value}))};
        case 'SetTopicAttributesCommand':assert.ok(confirmed);policy=i.AttributeValue;assert.deepEqual(JSON.parse(policy).Statement[1].Condition.StringEquals,{'AWS:SourceAccount':acct,'AWS:SourceArn':[...sets.keys()].map(n=>`arn:aws:ses:${va}:${acct}:configuration-set/${n}`)});return {};
        case 'ListSubscriptionsByTopicCommand':return {Subscriptions:sub?[sub]:[]};
        case 'SubscribeCommand':assert.ok(!sub);assert.equal(i.Endpoint,'https://opensend.mx/v1/events/ses');assert.equal((await db.query(`SELECT FROM provider_pool_regions WHERE feedback_topic_arn=$1 AND sending_state='pending' AND ownership_journal @> '[{"kind":"subscription"}]'`,[topic])).rowCount,1);sub={...i,Owner:acct,SubscriptionArn:topic+':fixture'};return {SubscriptionArn:topic+':fixture'};
        case 'GetSubscriptionAttributesCommand':return {Attributes:{...sub,PendingConfirmation:String(!confirmed),RawMessageDelivery:'false'}};
        default:assert.fail(n);
      }
    });
    const prepare=()=>trustedProvision(runtime,{connectionId:wid},{workspaceId:wid,id:'hosted.trusted:'+wid,attempts:1});
    await assert.rejects(setDomainPool(db,[wid,managed,'trusted'],{...flags,MX_TRUSTED_POOL:'false'}),/enabled/);
    runtime.config.trustedPool=false;await assert.rejects(prepare(),JobDeferred);assert.deepEqual(calls,[]);runtime.config.trustedPool=true;
    await setDomainPool(db,[wid,managed,'trusted'],flags);
    await assert.rejects(setDomainPool(db,[wid,'e2e-trusted.opensend.mx','trusted'],flags),/release-canary workspace/);
    assert.ok((await Promise.allSettled([prepare(),prepare()])).every(s=>s.status==='rejected' && s.reason instanceof JobDeferred));
    // AWS reporting a confirmed subscription is not signed-ingress evidence.
    confirmed=true;await assert.rejects(prepare(),JobDeferred);confirmed=false;assert.equal(JSON.parse(policy).Statement.length,1);
    const host=`https://sns.${va}.amazonaws.com/`,signed={Message:'fixture',MessageId:randomUUID(),SubscribeURL:host+'?'+new URLSearchParams({Action:'ConfirmSubscription',TopicArn:topic,Token:'fixture'}),Timestamp:new Date().toISOString(),Token:'fixture',TopicArn:topic,Type:'SubscriptionConfirmation'},body={...signed,SignatureVersion:'2',SigningCertURL:host+'SimpleNotificationService-trustedfixture.pem',Signature:Buffer.from(sign('RSA-SHA256',Buffer.from(Object.entries(signed).map(([k,v])=>k+'\n'+v+'\n').join('')),signedKey)).toString('base64')};
    error(await api('POST','/v1/events/ses',{...body,Message:'tampered'}),403,'SNS_INVALID_SIGNATURE');ok(await api('POST','/v1/events/ses',body),202);
    await assert.rejects(prepare(),JobDeferred);await Promise.allSettled([prepare(),prepare()]);await prepare();
    assert.deepEqual(['CreateTopicCommand','SubscribeCommand','CreateTenantCommand','CreateConfigurationSetCommand','CreateConfigurationSetEventDestinationCommand'].map(n=>calls.filter(c=>c===n).length),[1,1,1,2,2]);
    const added=ok(await api('POST','/v1/domains',{name:managed}),201);assert.equal(added.region,va);await assert.rejects(setDomainPool(db,[wid,managed,'probation'],flags),/Already bound/);
    const {operationJobs}=await import('./src/operations.js');await operationJobs['domain.verify']!(runtime,{domainId:added.id,token:managedTags[0]!.Value},{workspaceId:wid,id:'verify',attempts:1});
    assert.equal(ok(await api('GET',`/v1/domains/${added.id}`)).ready,true);
    const {adoptionFacts}=await import('./src/adopted-identity.js');const rows=Array.from({length:12},(_,i)=>{const name=`adopted-${i}.fixture.test`;return {arn:`arn:aws:ses:${va}:${acct}:identity/${name}`,...adoptionFacts(identity(name) as any)};});
    const inventory={workspaceId:wid,installation:'opensend-042df6f752eaa1f62cb8',scope:'exclusive-send-only',identities:rows};
    const op=new SESv2Client({region:va,credentials:runtime.config.aws!});cleanup(t,async()=>op.destroy());
    const adopt=(apply:boolean)=>adoptIdentities(db,op,wid,rows.map(r=>r.arn),inventory,`arn:aws:sts::${acct}:assumed-role/migration/fixture`,apply,flags);
    assert.equal((await adopt(false)).length,12);assert.equal((await db.query('SELECT FROM hosted_adoptions WHERE workspace_id=$1',[wid])).rowCount,0);
    drift=true;await assert.rejects(adopt(true),/drift/);drift=false;
    await db.query(`INSERT INTO domain_claims(workspace_id,name) VALUES($1,'adopted-0.fixture.test')`,[wid]);await assert.rejects(adopt(true),/Overlapping/);await db.query(`DELETE FROM domain_claims WHERE workspace_id=$1 AND name='adopted-0.fixture.test'`,[wid]);
    await assert.rejects(adopt(true),/interrupted/);assert.equal((await db.query(`SELECT FROM domain_claims WHERE workspace_id=$1 AND sending_state='verified' AND identity ? 'adopted'`,[wid])).rowCount,0);
    await adopt(true);await adopt(true);assert.equal(members.size,15);
    const adopted=(await db.query(`SELECT b.domain_id FROM domain_sending_bindings b JOIN domain_claims dc USING(workspace_id,name) WHERE b.workspace_id=$1 AND dc.sending_state='verified' AND dc.receiving_state='off' AND dc.identity ? 'adopted'`,[wid])).rows;assert.equal(adopted.length,12);
    assert.equal((await db.query('SELECT FROM mailbox_domains WHERE workspace_id=$1',[wid])).rowCount,0);
    ok(await api('DELETE','/v1/domains/'+added.id));const mark=calls.length;
    error(await api('POST',`/v1/domains/${adopted[0].domain_id}/mail-from`,{mailFromDomain:'bounce.'+ok(await api('GET',`/v1/domains/${adopted[0].domain_id}`)).name}),409,'IMPORTED_IDENTITY_READ_ONLY');
    ok(await api('DELETE',`/v1/domains/${adopted[0].domain_id}`));ok(await api('DELETE','/v1/connection'));assert.equal(calls.length,mark);assert.equal(members.size,14);
  });

  test('MX regional delivery: legacy backfill, closest claim, mixed batch and frozen dispatch',async t=>{
    await simulatedSesFixture(t,async({runtime,db,local,run})=>{
      const {readFile}=await import('node:fs/promises'),{runDispatcher}=await import('./src/dispatcher.js');
      const {GetAccountCommand,SESv2Client,SendEmailCommand}=await import('@aws-sdk/client-sesv2');
      const wid=runtime.config.workspaceId,acct='111122223333',oh='us-east-2',va='us-east-1',byo=unique('byo');
      const old=`arn:aws:sns:${oh}:${acct}:opensend-mx-feedback`,trusted=`arn:aws:sns:${va}:${acct}:opensendmx-trusted-feedback`;
      Object.assign(runtime.config,{multiTenant:true,liveEnabled:true,aws:{accessKeyId:'fixture',secretAccessKey:'fixture-only'}});
      assert.equal(runtime.config.regionalSending,false);
      const attempts:string[][]=[];
      t.mock.method(SESv2Client.prototype,'send',async function(this:InstanceType<typeof SESv2Client>,cmd:any){
        if(cmd instanceof GetAccountCommand)return {SendingEnabled:true,SendQuota:{MaxSendRate:1000,Max24HourSend:10000,SentLast24Hours:0}};
        assert.ok(cmd instanceof SendEmailCommand);attempts.push([await this.config.region(),cmd.input.ConfigurationSetName!,cmd.input.TenantName!]);return {MessageId:unique('provider')};
      });
      await db.query(`UPDATE ses_installation_settings SET default_region=$2,enabled_regions=jsonb_build_array($2::text,$3::text) WHERE workspace_id=$1`,[wid,oh,va]);
      await db.query(`INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state,inbound_bucket) VALUES($1,$2,$3,'ready','ohio-fixture')`,[oh,acct,old]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES($1,$1,$2,'ready','shared',$3,'ready')`,[wid,oh,acct]);
      await db.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)`,[byo]);
      const byoTopic=`arn:aws:sns:${oh}:444455556666:legacy-feedback`;
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,external_id,template_version,role_arn,platform_principal_arn,feedback_topic_arn) VALUES($1,$1,$2,'ready','byo','444455556666',gen_random_uuid(),'v4','fixture-role','fixture-platform',$3)`,[byo,oh,byoTopic]);
      await db.query(`INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state) VALUES('regional.example',$1,$1,'verified'),('legacy-byo.example',$2,$2,'verified')`,[wid,byo]);
      await db.query(`INSERT INTO operation_domains(id,name,workspace_id,region) VALUES('oh-domain','regional.example',$1,$3),('v4-domain','legacy-byo.example',$2,$3)`,[wid,byo,oh]);
      // Reproduce the push-1 database: only the old writer's rows exist. Execute the real backfill.
      await db.query(`DELETE FROM provider_connection_regions WHERE connection_id IN ($1,$2)`,[wid,byo]);
      await db.query(await readFile(new URL('./migrations/068_backfill_regional_bindings.sql',import.meta.url),'utf8'));
      assert.deepEqual((await db.query(`SELECT c.region,c.feedback_topic_arn,b.domain_id,c.legacy_names FROM regional_sending_connections c JOIN domain_sending_bindings b ON b.connection_id=c.id AND b.region=c.region WHERE c.id IN ($1,$2) ORDER BY b.domain_id`,[wid,byo])).rows,[{region:oh,feedback_topic_arn:old,domain_id:'oh-domain',legacy_names:true},{region:oh,feedback_topic_arn:byoTopic,domain_id:'v4-domain',legacy_names:true}]);
      const mail=(host:string)=>({from:`sender@${host}`,to:'success@simulator.amazonses.com',subject:'Regional fixture',text:'Mock SES only.'});
      const send=(m:Json)=>local('POST','/v1/emails/send',m),batch=(...emails:Json[])=>local('POST','/v1/emails/batch',{emails});
      const parent=mail('regional.example'),child=mail('leaf.trusted.regional.example');
      const drain=(region:string)=>runDispatcher(runtime,{region,accountId:acct,lanes:1});
      const legacy=ok(await send(parent),202);
      assert.deepEqual((await db.query(`SELECT region,snapshot ? 'binding' AS pinned FROM sending_emails WHERE id=$1`,[legacy.id])).rows,[{region:oh,pinned:false}]);
      await drain(oh);assert.deepEqual(attempts,[[oh,'opensend-mx-transactional',`opensend-${wid}`]]);
      runtime.config.regionalSending=true;
      await db.query(`INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state,pool_tier,legacy_names) VALUES($1,$2,$3,'ready','trusted',false)`,[va,acct,trusted]);
      runtime.config.trustedPool=true;
      await db.query(`INSERT INTO provider_connection_regions(connection_id,region,pool_tenant_name) VALUES($1,$2,$3)`,[wid,va,`opensendmx-trusted-${wid}`]);
      const {acquireRegionProvisioning,finishHostedRegion}=await import('./src/states.js'),ref={connectionId:wid,region:va};
      const generation=Number((await runtime.db.execute(acquireRegionProvisioning(ref))).rows[0]!.generation);
      assert.equal((await runtime.db.execute(finishHostedRegion(ref,generation))).rowCount,1);
      const reserved=(await db.query(`SELECT * FROM reserve_regional_claim($1,'trusted.regional.example',$2,'va-domain',NULL,true)`,[wid,va])).rows[0];assert.equal(reserved.id,'va-domain');
      assert.equal((await db.query(`SELECT error_code FROM reserve_regional_claim($1,'trusted.regional.example',$2,'conflict')`,[wid,oh])).rows[0].error_code,'DOMAIN_REGION_CONFLICT');
      error(await send(child),403,'SENDER_DOMAIN_NOT_VERIFIED'); // A verified parent cannot override an unready child.
      await db.query(`UPDATE domain_claims SET sending_state='verified' WHERE token=$1`,[reserved.token]);
      const before=(await db.query(`SELECT count(*) FROM sending_emails WHERE workspace_id=$1`,[wid])).rows;
      runtime.config.requireDmarcForBulk=true;
      try {error(await batch(parent,{...child,kind:'marketing'}),409,'BULK_DMARC_REQUIRED');}
      finally {runtime.config.requireDmarcForBulk=false;}
      assert.deepEqual((await db.query(`SELECT count(*) FROM sending_emails WHERE workspace_id=$1`,[wid])).rows,before,'A DMARC rejection rolls back the entire regional batch.');
      error(await batch(parent,{...child,region:oh}),422,'SENDER_REGION_MISMATCH');
      assert.deepEqual((await db.query(`SELECT count(*) FROM sending_emails WHERE workspace_id=$1`,[wid])).rows,before);
      const mixed=ok(await batch(parent,child),202).data;
      const frozen=async(id:string)=>(await db.query(`SELECT region,snapshot->'binding' AS binding,status,error_code FROM sending_emails WHERE id=$1`,[id])).rows[0];
      assert.deepEqual((await frozen(mixed[1].id)).binding,{account:acct,topic:trusted,connection:wid,domain:'va-domain',generation});
      await drain(oh);await drain(va);assert.deepEqual(attempts.slice(1),[[oh,'opensend-mx-transactional',`opensend-${wid}`],[va,'opensendmx-trusted-transactional',`opensendmx-trusted-${wid}`]]);
      runtime.config.trustedPool=false;error(await send(child),409,'TRUSTED_POOL_DISABLED');runtime.config.trustedPool=true;
      await db.query(`UPDATE workspaces SET send_cap_override=2 WHERE id=$1`,[wid]);
      const pair=[parent,child].map(m=>({...m,to:'real-counted@fixture.test'}));
      const charged=ok(await batch(...pair),202).data.map((m:Json)=>m.id);
      for (const m of pair) error(await send(m),429,'SEND_LIMIT_REACHED'); // Two regional envelopes consumed the same two slots.
      await db.query(`UPDATE provider_connections SET paused_at=now(),pause_reason='synthetic hold' WHERE id=$1`,[wid]);
      for (const m of [parent,child]) error(await send(m),409,'HOSTED_SENDING_PAUSED');
      await drain(oh);await drain(va);assert.equal(attempts.length,3); // Neither lane attempts already-admitted mail while held.
      assert.equal((await db.query(`SELECT FROM sending_emails WHERE id=ANY($1) AND status='queued'`,[charged])).rowCount,2);
      await db.query(`UPDATE sending_emails SET status='canceled' WHERE id=ANY($1)`,[charged]);await db.query(`UPDATE provider_connections SET paused_at=NULL,pause_reason=NULL WHERE id=$1`,[wid]);await db.query(`UPDATE workspaces SET send_cap_override=NULL WHERE id=$1`,[wid]);
      const c=ok(await local('POST','/v1/campaigns',{name:'Regional',from:child.from,subject:'Review',html:'<p>Fixture.</p>',audience:{listId:ok(await local('POST','/v1/lists',{name:'Regional'}),201).id}}),201);
      assert.equal(c.draft.region,va);
      await db.query(`WITH a AS (INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) VALUES('regional-contact',$1,'reader@example.net','subscribed') RETURNING id) INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT $1,$2,id FROM a`,[wid,c.draft.audience.listId]);
      ok(await local('POST',`/v1/campaigns/${c.id}/send`,{revision:c.revision}),202);await run('campaign.run');
      const reviewed=(await db.query(`SELECT r.draft->'binding' AS review,e.snapshot->'binding' AS queued,e.id FROM sending_emails e JOIN sending_campaign_reviews r ON r.id=e.review_id WHERE e.campaign_id=$1`,[c.id])).rows[0];
      assert.deepEqual(reviewed.queued,reviewed.review);assert.equal(reviewed.review.domain,'va-domain');
      const {createMailbox}=await import('./src/mailbox-store.js'),md=unique('mdom');
      await db.query(`INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,receiving_host,region,status,enabled_at) VALUES($1,$2,'va-domain','trusted.regional.example','trusted.regional.example',$3,'active',now())`,[md,wid,oh]);
      const inbound=`arn:aws:sns:${oh}:${acct}:opensend-mx-inbound`;
      await db.query(`UPDATE provider_pool_regions SET inbound_topic_arn=$1,receiving_state='ready' WHERE region=$2`,[inbound,oh]);
      const {acceptInboundNotification}=await import('./src/mailbox-ingest.js');
      const receive=()=>acceptInboundNotification(runtime,{topicArn:inbound,region:oh,message:{notificationType:'Received',mail:{messageId:'cross-region-fixture'},receipt:{timestamp:new Date().toISOString(),recipients:['reply@trusted.regional.example'],action:{type:'S3',bucketName:'ohio-fixture',topicArn:inbound,objectKey:'staging/cross-region-fixture'}}}});
      assert.equal(await receive(),0); // Sending proof cannot grant receiving.
      await db.query(`UPDATE domain_claims SET receiving_state='active',receiving_host=name WHERE token=$1`,[reserved.token]);
      assert.equal(await receive(),1); // A separately active Ohio host routes regardless of its Virginia send binding.
      const box=await createMailbox(runtime.db,{workspaceId:wid},{domainId:md,domainName:'trusted.regional.example',address:'reply@trusted.regional.example',origin:'api'});
      const thread=ok(await local('POST','/v1/inbound/threads',{addressId:box.id,to:[parent.to],subject:'Thread',text:'Fixture.'}),202);
      const stored=(await db.query(`SELECT m.region AS archive,e.region AS send_region,e.id FROM mail_messages m JOIN sending_emails e ON m.sending_email_id=e.id WHERE m.workspace_id=$1 AND m.thread_id=$2`,[wid,thread.threadId??thread.id])).rows[0];
      assert.deepEqual([stored.archive,stored.send_region],[oh,va]);
      const stale=ok(await send(child),202);
      // Even flag rollback cannot release a pinned email under a different generation.
      await db.query(`UPDATE provider_connection_regions SET generation=generation+1 WHERE connection_id=$1 AND region=$2`,[wid,va]);
      runtime.config.regionalSending=false;await drain(va);
      for (const id of [reviewed.id,stored.id,stale.id])assert.equal((await frozen(id)).error_code,'SENDER_BINDING_CHANGED');
      assert.equal(attempts.length,3);
      // A retired topic accepts delayed notifications only for the exact recorded ARN,
      // account, region and provider/email ID. Rotating a shared topic cannot move an event.
      const {ingestFeedbackBatch}=await import('./src/operations.js');
      const providerId=(await db.query('SELECT provider_id FROM sending_emails WHERE id=$1',[mixed[1].id])).rows[0].provider_id;
      const replacement=`arn:aws:sns:${va}:${acct}:opensendmx-replacement-feedback`;
      await db.query('UPDATE provider_pool_regions SET feedback_topic_arn=$1 WHERE region=$2',[replacement,va]);
      const feedback=(topicArn:string,region:string,account:string)=>({topicArn,region,messageId:unique('late'),message:{eventType:'Delivery',delivery:{timestamp:new Date().toISOString()},mail:{messageId:providerId,sendingAccountId:account,tags:{opensend_email_id:[mixed[1].id]}}}});
      const results=await ingestFeedbackBatch(runtime,[feedback(replacement,va,acct),feedback(trusted,oh,acct),feedback(trusted,va,'000000000000'),feedback(trusted,va,acct)]);
      assert.deepEqual(results.map(r=>!!r.error),[true,true,true,false]);assert.equal((await frozen(mixed[1].id)).status,'delivered');
    });
  });

  test('MX regional campaign editing, controls and disabled queue recovery', async t=>{
    await simulatedSesFixture(t,async({runtime,db,local,run})=>{
      const {acquireRegionProvisioning,finishHostedRegion,toggleRegionSending}=await import('./src/states.js');
      const {dispatchPartitions}=await import('./src/dispatch.js');
      const wid=runtime.config.workspaceId,oh='us-east-2',va='us-east-1',acct='111122223333',host='virginia.example',from=`sender@${host}`;
      Object.assign(runtime.config,{multiTenant:true,regionalSending:true});
      await db.query(`UPDATE ses_installation_settings SET default_region=$2,enabled_regions=jsonb_build_array($2::text) WHERE workspace_id=$1`,[wid,oh]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES($1,$1,$2,'ready','shared',$3,'ready')`,[wid,oh,acct]);
      await db.query(`INSERT INTO provider_pool_regions(region,aws_account_id,sending_state,feedback_topic_arn) VALUES($1,$2,'ready',$3)`,[va,acct,`arn:aws:sns:${va}:${acct}:fixture`]);
      await db.query(`INSERT INTO provider_connection_regions(connection_id,region) VALUES($1,$2)`,[wid,va]);
      const ref={connectionId:wid,region:va},generation=Number((await runtime.db.execute(acquireRegionProvisioning(ref))).rows[0]!.generation);
      const create=async(draft:Json)=>ok(await local('POST','/v1/campaigns',draft),201);
      const edit=async(c:Json,overrides:Json={})=>ok(await local('PATCH',`/v1/campaigns/${c.id}`,{revision:c.revision,draft:{...c.draft,...overrides}}));
      const list=ok(await local('POST','/v1/lists',{name:'Regional controls'}),201);
      const fields={subject:'Fixture',html:'<p>Test</p>',audience:{listId:list.id}};
      await db.query(`WITH a AS (INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent)
        SELECT 'regional-'||i,$1,'fixture'||i||'@example.net','subscribed' FROM generate_series(1,101)i RETURNING id)
        INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT $1,$2,id FROM a`,[wid,list.id]);
      // No claim yet: editing is not a send. A full-document PATCH echoes the displayed default.
      let c=await create({name:'Follow From',...fields});assert.equal(c.draft.region,oh);
      c=await edit(c,{from});assert.equal(c.draft.region,oh);
      const launch=(c:Json,action='send',extra:Json={})=>local('POST',`/v1/campaigns/${c.id}/${action}`,{revision:c.revision,...extra});
      error(await launch(c),403,'SENDER_DOMAIN_NOT_VERIFIED');
      await db.query(`INSERT INTO domain_claims(name,workspace_id,connection_id) VALUES($1,$2,$2)`,[host,wid]);
      await db.query(`INSERT INTO operation_domains(id,workspace_id,name,region) VALUES('regional-controls',$1,$2,$3)`,[wid,host,va]);
      c=await edit(c);assert.equal(c.draft.region,va,'An automatic region follows the pending domain.');
      const switched=await edit(await create({name:'Change From',...fields}),{from});assert.equal(switched.draft.region,va);
      let pinned=await create({name:'Pinned Ohio',...fields,from,region:oh});assert.equal(pinned.draft.region,oh);
      await runtime.db.execute(finishHostedRegion(ref,generation));
      assert.equal((await db.query(`SELECT enabled_regions ? $2 AS enabled FROM ses_installation_settings WHERE workspace_id=$1`,[wid,va])).rows[0].enabled,true);
      const emptyVa=await create({name:'Empty Virginia',region:va});assert.equal(emptyVa.draft.region,va);
      // Before pin metadata existed, an empty draft in a non-default region was an explicit selection.
      await db.query(`UPDATE sending_campaigns SET draft=draft-'regionPinned' WHERE id=$1`,[emptyVa.id]);
      assert.equal((await edit(ok(await local('GET',`/v1/campaigns/${emptyVa.id}`)),{from:'a@unbound.example'})).draft.region,va);
      await db.query(`UPDATE domain_claims SET sending_state='verified' WHERE workspace_id=$1 AND name=$2`,[wid,host]);
      await db.query(`UPDATE provider_connection_regions SET tenant_state='pending' WHERE connection_id=$1 AND region=$2`,[wid,va]);
      // Live-readiness checks with synthetic credentials; no SDK call is permitted by this fixture.
      const saved=runtime.config;runtime.config={...saved,liveEnabled:true,aws:{accessKeyId:'fixture',secretAccessKey:'fixture'}};
      try {c=await edit(c);error(await launch(c),409,'TENANT_NOT_READY');} finally {runtime.config=saved;}
      await db.query(`UPDATE provider_connection_regions SET tenant_state='ready' WHERE connection_id=$1 AND region=$2`,[wid,va]);
      await db.query(`UPDATE provider_connections SET paused_at=now(),pause_reason='test hold' WHERE id=$1`,[wid]);
      c=await edit(c);error(await launch(c),409,'HOSTED_SENDING_PAUSED');
      await db.query(`UPDATE provider_connections SET paused_at=NULL,pause_reason=NULL WHERE id=$1`,[wid]);
      pinned=await edit(pinned);error(await launch(pinned),422,'SENDER_REGION_MISMATCH');
      error(await local('POST',`/v1/campaigns/${pinned.id}/test`,{to:'test@example.net'}),422,'SENDER_REGION_MISMATCH');
      assert.equal((await edit(pinned,{regionPinned:false,region:undefined})).draft.region,va);
      // The launch itself resolves again: the former unbound sender now belongs to Virginia.
      const late=await create({name:'Bound after save',...fields,from:'sender@new.example'});
      await db.query(`INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state) VALUES('new.example',$1,$1,'verified')`,[wid]);
      await db.query(`INSERT INTO operation_domains(id,workspace_id,name,region) VALUES('regional-late',$1,'new.example',$2)`,[wid,va]);
      ok(await launch(late,'schedule',{scheduledAt:new Date(Date.now()+86400000).toISOString()}),202);
      assert.equal((await db.query(`SELECT draft->>'region' r FROM sending_campaign_reviews WHERE campaign_id=$1`,[late.id])).rows[0].r,va);
      assert.equal(ok(await local('GET',`/v1/campaigns/${late.id}`)).draft.region,va);
      ok(await launch(switched,'schedule',{scheduledAt:new Date(Date.now()+86400000).toISOString()}),202);
      ok(await launch(c,'send',{pacing:{perDay:100,rateShare:1}}),202);await run('campaign.run');
      const status=async()=>ok(await local('GET',`/v1/campaigns/${c.id}`));assert.equal((await status()).delivery.expanded,100);
      // A healthy region with unchanged generation is not sufficient: proof lost AFTER
      // preparation must also prevent the first release. Advance only this fixture schedule.
      await db.query(`UPDATE sending_campaigns SET scheduled_at=now()-interval '1 second' WHERE id=$1`,[late.id]);
      await db.query(`UPDATE domain_claims SET sending_state='pending' WHERE workspace_id=$1 AND name='new.example'`,[wid]);
      await run('campaign.run');const revoked=ok(await local('GET',`/v1/campaigns/${late.id}`));
      assert.equal(revoked.delivery.error.code,'SENDER_BINDING_CHANGED');assert.equal(revoked.delivery.expanded,0);
      const direct=async()=>ok(await local('POST','/v1/emails/send',{from,to:'a@example.net',subject:'Fixture',text:'Fixture'}),202).id;
      const queued=await direct(),inFlight=await direct();
      await db.query(`UPDATE sending_emails SET status='attempting',attempt_started_at=now() WHERE id=$1`,[inFlight]);
      await db.query(`UPDATE sending_emails SET scheduled_at=now()+interval '1 day',lease_until=now()+interval '2 minutes' WHERE id=$1`,[queued]);
      await runtime.db.execute(toggleRegionSending(ref,false,generation));
      for(const path of ['/v1/emails','/v1/campaigns'])assert.ok(ok(await local('GET',`${path}?region=${va}`)).data.length);
      const disposable=await edit(await create({name:'Disabled draft',...fields,from}));
      const endpoint=`/v1/campaigns/${disposable.id}`;
      ok(await local('PATCH',endpoint+'/archive',{archived:true}));ok(await local('PATCH',endpoint+'/archive',{archived:false}));ok(await local('DELETE',endpoint));
      ok(await local('POST',`/v1/campaigns/${switched.id}/pause`,{}));ok(await local('POST',`/v1/campaigns/${switched.id}/cancel`));
      await run('campaign.run');const failed=await status();assert.equal(failed.delivery.error.code,'SENDER_BINDING_CHANGED');assert.equal(failed.delivery.expanded,100);
      assert.equal((await db.query(`SELECT 1 FROM sending_emails WHERE campaign_id=$1`,[c.id])).rowCount,100);
      await dispatchPartitions(runtime,true);await dispatchPartitions(runtime,true);
      const rows=(await db.query(`SELECT id,status,error_code FROM sending_emails WHERE workspace_id=$1`,[wid])).rows;
      assert.deepEqual(rows.filter(m=>m.id!==inFlight).map(m=>[m.status,m.error_code]),Array(101).fill(['canceled','SENDER_BINDING_CHANGED']));
      assert.equal(rows.find(m=>m.id===inFlight).status,'attempting');
      ok(await local('POST',`/v1/campaigns/${c.id}/cancel`));
    });
  });

  test('MX regional BYO: a rescan is not authorization and first-ready regions provision independently',async t=>{
    await simulatedSesFixture(t,async({runtime,db,local})=>{
      const {startRegionScan,finishRegionScan,acquireRegionProvisioning,finishRegionProvisioning,toggleRegionSending}=await import('./src/states.js');
      const {setupResources}=await import('./src/ses-setup.js'),{SESv2Client,GetEmailTemplateCommand,TestRenderEmailTemplateCommand}=await import('@aws-sdk/client-sesv2');
      const wid=runtime.config.workspaceId,oh='us-east-2',va='us-east-1',account='444455556666';
      Object.assign(runtime.config,{multiTenant:true,regionalSending:true,liveEnabled:true,aws:{accessKeyId:'unused',secretAccessKey:'fixture'}});
      const names=setupResources(wid,'byo');assert.match(names.topicName,/^opensendmx-[0-9a-f]{20}-feedback$/);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,external_id,template_version,role_arn,platform_principal_arn) VALUES($1,$1,$2,'provisioning','byo',$3,gen_random_uuid(),'v5','fixture-role','fixture-platform')`,[wid,oh,account]);
      const publish=async(region:string)=>{
        const ref={connectionId:wid,region},topic=`arn:aws:sns:${region}:${account}:${names.topicName}`;
        await db.query(`INSERT INTO provider_connection_regions(connection_id,region) VALUES($1,$2)`,[wid,region]);
        const scan=Number((await runtime.db.execute(startRegionScan(ref))).rows[0]!.scan_revision);
        await runtime.db.execute(finishRegionScan(ref,scan,true));
        assert.equal((await db.query('SELECT 1 FROM regional_sending_connections WHERE id=$1 AND region=$2',[wid,region])).rowCount,0);
        const gen=Number((await runtime.db.execute(acquireRegionProvisioning(ref))).rows[0]!.generation);
        assert.equal((await runtime.db.execute(acquireRegionProvisioning(ref))).rowCount,0);
        await db.query(`UPDATE provider_connection_regions SET feedback_topic_arn=$3 WHERE connection_id=$1 AND region=$2`,[wid,region,topic]);
        assert.equal((await runtime.db.execute(finishRegionProvisioning(ref,gen,topic))).rowCount,0);
        await db.query(`UPDATE provider_connection_regions SET confirmed_topic_arn=$3,confirmed_generation=generation WHERE connection_id=$1 AND region=$2`,[wid,region,topic]); // signed confirmation fixture
        assert.equal((await runtime.db.execute(finishRegionProvisioning(ref,gen-1,topic))).rowCount,0);
        assert.equal((await runtime.db.execute(finishRegionProvisioning(ref,gen,topic))).rowCount,1);
        await runtime.db.execute(startRegionScan(ref));assert.equal((await db.query('SELECT 1 FROM regional_sending_connections WHERE id=$1 AND region=$2',[wid,region])).rowCount,1);
        const reserved=(await db.query(`SELECT * FROM reserve_regional_claim($1,$2,$3,$4,$1)`,[wid,`${region}.example`,region,`byo-${region}`])).rows[0];assert.equal(reserved.id,`byo-${region}`);
        await db.query(`UPDATE domain_claims SET sending_state='verified' WHERE token=$1`,[reserved.token]);
      };
      await publish(oh);await publish(va);
      const renders:string[]=[];
      t.mock.method(SESv2Client.prototype,'send',async function(this:InstanceType<typeof SESv2Client>,cmd:any){
        const region=await this.config.region();assert.equal(cmd.input.TemplateName,region);
        if(cmd instanceof TestRenderEmailTemplateCommand){renders.push(region);return {RenderedTemplate:'Subject: fixture\r\n\r\nFixture.'};}
        assert.ok(cmd instanceof GetEmailTemplateCommand);return {TemplateContent:{Subject:'fixture'}};
      });
      const batch=ok(await local('POST','/v1/emails/batch',{emails:[va,oh].map(r=>({from:`a@${r}.example`,to:'success@simulator.amazonses.com',template:{name:r,data:{}}}))}),202);
      assert.deepEqual(renders,[va,oh]);assert.deepEqual((await db.query(`SELECT region,snapshot#>>'{binding,connection}' AS connection FROM sending_emails WHERE id=ANY($1) ORDER BY region`,[batch.data.map((m:Json)=>m.id)])).rows,[va,oh].map(region=>({region,connection:wid})));
      assert.equal((await runtime.db.execute(toggleRegionSending({connectionId:wid,region:va},false,0))).rowCount,0);
      assert.equal((await runtime.db.execute(toggleRegionSending({connectionId:wid,region:va},false,2))).rowCount,1);
      error(await local('POST','/v1/emails/send',{from:`a@${va}.example`,to:address(),subject:'Blocked',text:'No fallback'}),409,'CONNECTION_REQUIRED');
      ok(await local('POST','/v1/emails/send',{from:`a@${oh}.example`,to:address(),subject:'Independent',text:'Mock only'}),202);
    });
  });

  test('BYO v5 enrollment: read-only inventory and independent confirmed regional imports',async t=>{
    const [{nodeRuntime},{createApp},{regionalByoJobs},{JobDeferred},{ensureRegionSettings},{STSClient},{SESv2Client},{SESClient},{SNSClient}]=await Promise.all([
      import('./src/adapters/node.js'),import('./src/app.js'),import('./src/byo-regional.js'),import('./src/jobs.js'),import('./src/ses-region-state.js'),import('@aws-sdk/client-sts'),import('@aws-sdk/client-sesv2'),import('@aws-sdk/client-ses'),import('@aws-sdk/client-sns')]);
    const db=await fixtureDatabase(t), user=await sessionFixture(t), wid='ws_'+randomUUID().replaceAll('-',''), oh='us-east-2',va='us-east-1',ie='eu-west-1',west='us-west-2', account='222288884444';
    const instance=nodeRuntime({DATABASE_URL:FIXTURE_DATABASE_URL,BETTER_AUTH_SECRET:AUTH_SECRET,GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',AUTH_ALLOWED_DOMAINS:'example.com',PUBLIC_URL:PUBLIC_ORIGIN,MULTI_TENANT:'true',DEFAULT_WORKSPACE_OWNERS:'',MX_REGIONAL_SENDING:'true',MX_BYO_V2:'true',ENABLE_LIVE_SES:'true',AWS_ACCESS_KEY_ID:'v5-fixture-platform',AWS_SECRET_ACCESS_KEY:'fixture-only',S3_BUCKET:'fixture',S3_ACCESS_KEY_ID:'fixture',S3_SECRET_ACCESS_KEY:'fixture',BYO_V5_TEMPLATE_URL:'https://synthetic-template.s3.us-east-2.amazonaws.com/byo/v5.yaml'});
    const runtime=instance.runtime,app=createApp();cleanup(t,instance.close);
    await db.query('INSERT INTO workspaces(id,slug,name) VALUES($1,$1,$1)',[wid]);
    cleanup(t,async()=>{await db.query('DELETE FROM jobs WHERE workspace_id=$1',[wid]);await db.query('DELETE FROM operation_domains WHERE workspace_id=$1',[wid]);await db.query('DELETE FROM domain_claims WHERE workspace_id=$1',[wid]);await db.query('DELETE FROM provider_feedback_history WHERE aws_account_id=$1',[account]);await db.query('DELETE FROM ses_installation_settings WHERE workspace_id=$1',[wid]);await db.query('DELETE FROM workspaces WHERE id=$1',[wid]);});
    await db.query("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'owner')",[unique('member'),wid,user.userId]);
    await ensureRegionSettings(runtime.db,{...runtime.config,workspaceId:wid});
    const api=async(method:string,path:string,body?:Json,key?:string):Promise<Reply>=>{const res=await app.fetch(new Request(PUBLIC_ORIGIN+path,{method,headers:{cookie:user.cookie,origin:PUBLIC_ORIGIN,'x-opensend-workspace':wid,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:body?JSON.stringify(body):undefined}),runtime);return {status:res.status,headers:res.headers,body:await res.json()};};
    const signedKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
    const pem=(await import('node:child_process')).execFileSync('openssl',['req','-new','-x509','-key','/dev/stdin','-days','1','-subj','/CN=fixture'],{input:signedKey.export({format:'pem',type:'pkcs8'}),encoding:'utf8'});
    const topics=new Map<string,Json>(),sets=new Map<string,Json>(),trace:{region:string;op:string}[]=[], policies:string[]=[];
    const denied=()=>Object.assign(new Error('fixture denial'),{name:'AccessDenied'}), missing=()=>Object.assign(new Error('fixture missing'),{name:'NotFoundException'});
    let external='',failOnce=true,revoked:boolean|string=false,loseSubscribe=true,throttlePoll=false,failDelete=true,createdIdentity:Json|undefined,denyCleanup=false,loseSetDelete=false;
    t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{const u=new URL(String(input));assert.match(u.hostname,/^sns\.us-east-[12]\.amazonaws\.com$/);if(u.pathname.endsWith('.pem'))return new Response(pem);const topic=topics.get(u.searchParams.get('TopicArn')!)!;topic.confirmed=true;return new Response(null);});
    t.mock.method(STSClient.prototype,'send',async function(this:InstanceType<typeof STSClient>,cmd:any){
      if(cmd.constructor.name==='GetCallerIdentityCommand')return {Account:account,Arn:`arn:aws:sts::${account}:assumed-role/OpenSendMX-${v5.id.slice(-20)}/OpenSendMX`};
      assert.equal(cmd.constructor.name,'AssumeRoleCommand');assert.equal(cmd.input.RoleSessionName,'OpenSendMX');assert.equal(cmd.input.DurationSeconds,900);assert.ok(cmd.input.Policy.length<=2048);policies.push(cmd.input.Policy);
      if (!external || cmd.input.ExternalId!==external) throw denied();
      return {AssumedRoleUser:{Arn:`arn:aws:sts::${account}:assumed-role/${cmd.input.RoleArn.split('/')[1]}/OpenSendMX`},Credentials:{AccessKeyId:'v5-fixture-customer',SecretAccessKey:'fixture-only',SessionToken:cmd.input.Policy,Expiration:new Date(Date.now()+900000)}};
    });
    t.mock.method(SESClient.prototype,'send',async function(this:InstanceType<typeof SESClient>,cmd:any){assert.equal(cmd.constructor.name,'DescribeActiveReceiptRuleSetCommand');trace.push({region:await this.config.region(),op:cmd.constructor.name});return {Metadata:{Name:'customer'},Rules:[{Name:'existing',Enabled:true,Actions:[{StopAction:{Scope:'RuleSet'}}]}]};});
    t.mock.method(SESv2Client.prototype,'send',async function(this:InstanceType<typeof SESv2Client>,cmd:any){const region=await this.config.region(),op=cmd.constructor.name,i=cmd.input,key=region+':'+i.ConfigurationSetName;trace.push({region,op});assert.equal((await this.config.credentials()).accessKeyId,'v5-fixture-customer');
      switch(op){
        case 'GetEmailTemplateCommand':case 'TestRenderEmailTemplateCommand':{
          const [s]=JSON.parse((await this.config.credentials()).sessionToken!).Statement;assert.deepEqual(s.Action,['ses:GetEmailTemplate','ses:TestRenderEmailTemplate']);assert.equal(s.Resource,`arn:aws:ses:${region}:${account}:template/opensend-pilot`);
          return op==='GetEmailTemplateCommand'?{TemplateContent:{Subject:'{{subject}}'}}:{RenderedTemplate:`Subject: ${JSON.parse(i.TemplateData).subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain;\r\n charset=UTF-8\r\n\r\nBody line.\r\nSender: body text`};
        }
        case 'SendEmailCommand':{
          const statements=JSON.parse((await this.config.credentials()).sessionToken!).Statement, prefix=`arn:aws:ses:${oh}:${account}:`, resource=params.get('param_ResourcePrefix');
          assert.deepEqual(statements.map((s:Json)=>s.Action),[['ses:SendEmail'],['ses:ApplyTrackingConfigurationOverrides']]);assert.deepEqual(statements[0].Resource,[prefix+'identity/both.example',prefix+'configuration-set/'+resource+'-transactional',prefix+'configuration-set/'+resource+'-marketing']);
          assert.equal(statements[0].Condition.StringEquals['aws:RequestedRegion'],oh);assert.equal(i.ConfigurationSetName,resource+'-transactional');assert.ok(i.Content.Raw);
          assert.equal(Buffer.from(i.Content.Raw.Data).toString(),'From: pilot@sub.both.example\r\nTo: success@simulator.amazonses.com\r\nSubject: Fixture\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nBody line.\r\nSender: body text');return {MessageId:randomUUID()};
        }
        case 'GetAccountCommand':if(![oh,ie,va,west].includes(region))throw denied();return {SendingEnabled:true,EnforcementStatus:'HEALTHY',ProductionAccessEnabled:region===va,SendQuota:{SentLast24Hours:1,Max24HourSend:1000,MaxSendRate:8}};
        case 'ListConfigurationSetsCommand':return i.NextToken?{ConfigurationSets:['opensend-legacy']}:{ConfigurationSets:['existing'],NextToken:'sets2'};
        case 'GetConfigurationSetCommand':if(i.ConfigurationSetName==='opensend-legacy')return {Tags:[{Key:'opensend:installation-id',Value:'legacy'}]};if(!sets.has(key))throw missing();return sets.get(key);
        case 'DeleteConfigurationSetCommand':{const s=JSON.parse((await this.config.credentials()).sessionToken!).Statement;assert.ok(s[0].Action.includes('ses:DeleteConfigurationSet'));assert.ok(s[0].Resource.includes(`arn:aws:ses:${region}:${account}:configuration-set/${i.ConfigurationSetName}`));assert.ok(sets.delete(key));if(loseSetDelete){loseSetDelete=false;throw Object.assign(Error('lost delete acknowledgement'),{name:'TimeoutError'});}return {};}
        case 'ListEmailIdentitiesCommand':if(region===west)return {EmailIdentities:[]};if(region===ie&&i.NextToken)throw denied();return i.NextToken?{EmailIdentities:[{IdentityType:'DOMAIN',IdentityName:region+'.example'},{IdentityType:'DOMAIN',IdentityName:'reselect.example'}]}:{NextToken:'domains2',EmailIdentities:[{IdentityType:'DOMAIN',IdentityName:'both.example'},{IdentityType:'EMAIL_ADDRESS',IdentityName:'x@both.example'}]};
        case 'GetEmailIdentityCommand':{assert.ok(!i.EmailIdentity.includes('@'));if(i.EmailIdentity==='new.example'){if(!createdIdentity)throw missing();return createdIdentity;}const invalid=revoked===true || revoked===i.EmailIdentity;return {VerificationStatus:invalid?'FAILED':'SUCCESS',VerifiedForSendingStatus:!invalid,DkimAttributes:{Status:'SUCCESS',SigningEnabled:true},ConfigurationSetName:'existing'};}
        case 'CreateEmailIdentityCommand':assert.equal(i.EmailIdentity,'new.example');assert.match(i.Tags.find((t:Json)=>t.Key==='opensend:domain-claim').Value,/^[a-f0-9-]{36}$/);assert.deepEqual(i.Tags.slice(1),[{Key:'opensend:owner',Value:'mx'},{Key:'opensend:installation-id',Value:v5.id},{Key:'opensend:purpose',Value:'domain-identity'}]);createdIdentity={Tags:i.Tags,DkimAttributes:{Status:'PENDING',Tokens:['a','b','c']}};return createdIdentity;
        case 'DeleteEmailIdentityCommand':assert.equal(i.EmailIdentity,'new.example');assert.ok(createdIdentity);if(failDelete){failDelete=false;throw Object.assign(Error('synthetic delete denied'),{name:'AccessDenied'});}createdIdentity=undefined;return {};
        case 'CreateConfigurationSetCommand':if(region===va&&failOnce){failOnce=false;throw Object.assign(Error('synthetic throttle'),{name:'ThrottlingException'});}assert.ok(!sets.has(key));assert.ok(i.Tags.some((t:Json)=>t.Key==='opensend:owner'&&t.Value==='mx'));sets.set(key,{...i,dest:[]});return {};
        case 'PutConfigurationSetSuppressionOptionsCommand':sets.get(key)!.SuppressionOptions=i;return {};
        case 'GetConfigurationSetEventDestinationsCommand':return {EventDestinations:sets.get(key)!.dest};
        case 'CreateConfigurationSetEventDestinationCommand':sets.get(key)!.dest.push({Name:i.EventDestinationName,...i.EventDestination});return {};
        default:throw Error('unexpected SES call '+op);
      }
    });
    t.mock.method(SNSClient.prototype,'send',async function(this:InstanceType<typeof SNSClient>,cmd:any){const region=await this.config.region(),op=cmd.constructor.name,i=cmd.input,arn=i.TopicArn??i.ResourceArn??i.SubscriptionArn?.split(':').slice(0,6).join(':')??`arn:aws:sns:${region}:${account}:${i.Name}`,topic=topics.get(arn);trace.push({region,op});
      switch(op){
        case 'CreateTopicCommand':assert.ok(!topic);assert.equal(JSON.parse(i.Attributes.Policy).Statement.length,1);topics.set(arn,{Tags:i.Tags,Attributes:{...i.Attributes,Owner:account,TopicArn:arn},subs:[]});return {TopicArn:arn};
        case 'GetTopicAttributesCommand':if(denyCleanup)throw denied();if(!topic)throw missing();return {Attributes:topic.Attributes};
        case 'DeleteTopicCommand':{assert.ok(!sets.has(region+':'+params.get('param_ResourcePrefix')+'-transactional')&&!sets.has(region+':'+params.get('param_ResourcePrefix')+'-marketing'));assert.ok(topics.delete(arn));return {};}
        case 'ListTagsForResourceCommand':return {Tags:topic!.Tags};
        case 'SetTopicAttributesCommand':assert.equal(i.AttributeName,'Policy');assert.ok(JSON.parse(i.AttributeValue).Statement.some((s:Json)=>s.Principal?.Service==='ses.amazonaws.com'&&s.Condition.StringEquals['AWS:SourceAccount']===account));topic!.Attributes.Policy=i.AttributeValue;return {};
        case 'ListSubscriptionsByTopicCommand':return {Subscriptions:topic!.subs};
        case 'SubscribeCommand':assert.equal(i.Endpoint,'https://opensend.mx/v1/events/ses');assert.equal((await db.query('SELECT FROM provider_connection_regions WHERE feedback_topic_arn=$1',[arn])).rowCount,1);
          if (!topic!.subs.length) topic!.subs.push({...i,Owner:account,SubscriptionArn:region===west?'PendingConfirmation':arn+':test'}); // List may return a sentinel even with ReturnSubscriptionArn.
          if(region===oh && loseSubscribe){loseSubscribe=false;throw Object.assign(Error('accepted before timeout'),{name:'TimeoutError'});}return {SubscriptionArn:arn+':test'};
        case 'GetSubscriptionAttributesCommand':if(throttlePoll){throttlePoll=false;throw Object.assign(Error('poll throttled'),{name:'ThrottlingException'});}return {Attributes:{...topic!.subs[0],PendingConfirmation:String(!topic!.confirmed),RawMessageDelivery:region===west&&!topic!.confirmed?undefined:'false'}};
        default:throw Error('unexpected SNS call '+op);
      }
    });
    const path='/v1/connection',post=(suffix:string,b?:Json)=>api('POST',path+suffix,b),poll=async()=>ok(await api('GET',path)).connection;
    const run=async(type:string,region?:string)=>{
      // The standalone harness runner may own a short, flag-off deferral of this exact job.
      // Wait for its durable settlement; don't steal an active lease or mistake it for a missing job.
      let j;for(let n=0;n<100;n++){
        j=(await db.query(`UPDATE jobs SET status='running',attempts=1,lease_until=now()+interval '3 minutes' WHERE id=(SELECT id FROM jobs WHERE workspace_id=$1 AND type=$2 AND ($3::text IS NULL OR payload->>'region'=$3) AND status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,[wid,type,region??null])).rows[0];
        if(j)break;await new Promise(r=>setTimeout(r,10));
      }assert.ok(j,type+':'+region);
      try {await regionalByoJobs[type]!(runtime,j.payload,{workspaceId:wid,id:j.id,attempts:1});}
      catch(e){if(!(e instanceof JobDeferred)) {await db.query("UPDATE jobs SET status='failed' WHERE id=$1",[j.id]);throw e;}await db.query("UPDATE jobs SET status='pending',available_at=now()+interval '1 hour',payload=$2 WHERE id=$1",[j.id,e.payload??j.payload]);return false;}
      await db.query("UPDATE jobs SET status='completed' WHERE id=$1",[j.id]);return true;
    };
    runtime.config.byoV2=false;error(await post('/scan'),404);runtime.config.byoV2=true;
    error(await post('/scan'),404);error(await post('',{kind:'byo',awsAccountId:account}),422,'VALIDATION_ERROR');
    const {setByoV2}=await import('./scripts/set-byo-v2.js');await setByoV2(db,[wid,'enable']);
    error(await post('',{kind:'byo',awsAccountId:'438095551154'}),409,'AWS_ACCOUNT_IN_USE');assert.equal(policies.length,0);
    const v5=ok(await post('',{kind:'byo',awsAccountId:account}),202),params=new URLSearchParams(new URL(v5.quickCreateUrl).hash.split('?')[1]);external=params.get('param_ExternalId')!;
    assert.equal(params.get('param_WorkspaceId'),wid);assert.equal(params.get('param_ResourcePrefix'),'opensendmx-'+createHash('sha256').update(v5.id).digest('hex').slice(0,20));assert.equal(params.has('param_ReceiveMail'),false);assert.equal(v5.awsAccountId,null);
    await run('byo.prove');assert.equal(policies.length,3);
    await assert.rejects(setByoV2(db,[wid,'disable']),/Disconnect/);
    const rs=(await db.query('SELECT region FROM provider_connection_regions WHERE connection_id=$1',[v5.id])).rows;assert.equal(rs.length,32);
    for (const {region} of rs) for(let page=0;!await run('byo.scan',region);page++)assert.ok(page<8);
    const initial=await poll(),rev=initial.scan.revision, rows=initial.candidates;
    assert.deepEqual(initial.scan.cursor,{checked:32,total:32});assert.equal(initial.state,'ready_to_import');assert.equal(initial.scan.state,'partial');assert.equal(initial.scan.alreadySendsEmail,true);
    assert.equal(rows.filter((v:Json)=>v.domain==='both.example'&&v.selectable).length,2);assert.equal(rows.find((v:Json)=>v.region===ie).status,'incomplete');assert.equal(rows.find((v:Json)=>v.region===oh).sandbox,true);
    assert.ok(trace.every(({op})=>/^(?:List|Get|Describe)/.test(op)));assert.ok(policies.every(p=>!/(?:Create|Put|Subscribe|SendEmail)/.test(p)));assert.equal(initial.importedDomains,0);
    const select=(...ids:string[])=>post('/imports',{revision:rev,confirm:true,candidateIds:ids}),ohId=oh+':both.example',vaId=va+':'+va+'.example';
    error(await select(ohId,va+':both.example'),409,'DUPLICATE_DOMAIN_SELECTION');error(await select(ie+':both.example'),409,'SCAN_STALE');
    revoked=true;error(await select(ohId),409,'CANDIDATE_NO_LONGER_VERIFIED');revoked=false;
    assert.equal((await db.query("SELECT FROM jobs WHERE type='byo.provision' AND workspace_id=$1",[wid])).rowCount,0);
    const regionStatus=async(region:string)=>ok(await api('GET',path+'/regions/status')).regions.find((r:Json)=>r.region===region);
    await t.test('revocation before regional provisioning releases the selection without AWS writes',async()=>{
      ok(await select(va+':both.example'),202);const start=trace.length;revoked=true;
      try {assert.equal(await run('byo.provision',va),true);} finally {revoked=false;}
      const result=await regionStatus(va);assert.deepEqual(result.pending,[]);assert.deepEqual(result.failedIntents,[{domain:'both.example',importing:true,error:'CANDIDATE_NO_LONGER_VERIFIED'}]);
      assert.deepEqual(trace.slice(start),[{region:va,op:'GetEmailIdentityCommand'}]);assert.equal((await db.query("SELECT FROM jobs WHERE workspace_id=$1 AND type='byo.bind'",[wid])).rowCount,0);
      await db.query(`INSERT INTO byo_domain_intents(connection_id,region,name,importing,id) SELECT $1,$2,'slot-'||n||'.example',true,'slot-'||n FROM generate_series(1,99) n`,[v5.id,oh]);
      try {assert.deepEqual(ok(await api('POST','/v1/domains',{name:'first.example'}),202).regions,[oh]);} finally {await db.query("DELETE FROM byo_domain_intents WHERE connection_id=$1 AND id LIKE 'slot-%'",[v5.id]);}
      ok(await select(ohId),202);assert.ok((await regionStatus(oh)).pending.some((i:Json)=>i.domain==='both.example'));
    });
    const concurrent=await Promise.all([select(ohId,vaId),select(ohId,vaId)]);assert.equal(ok(concurrent[0]!,202).operationId,ok(concurrent[1]!,202).operationId);
    assert.equal((await db.query("SELECT FROM jobs WHERE type='byo.provision' AND workspace_id=$1",[wid])).rowCount,2);
    ok(await select(oh+':reselect.example'),202);revoked='reselect.example';
    try {assert.equal(await run('byo.provision',oh),false);} finally {revoked=false;}
    assert.deepEqual((await regionStatus(oh)).failedIntents,[{domain:'reselect.example',importing:true,error:'CANDIDATE_NO_LONGER_VERIFIED'}]);
    assert.equal(await run('byo.provision',va),false);
    assert.equal((await regionStatus(oh)).error,'AWS_SETUP_TIMEOUT');assert.equal((await regionStatus(oh)).sendingState,'provisioning');
    assert.equal((await poll()).importedDomains,0);assert.equal((await db.query('SELECT FROM domain_sending_bindings WHERE workspace_id=$1',[wid])).rowCount,0);
    const confirm=async(region:string)=>{const TopicArn=`arn:aws:sns:${region}:${account}:${params.get('param_ResourcePrefix')}-feedback`,host=`https://sns.${region}.amazonaws.com/`;
      const signed={Message:'fixture',MessageId:randomUUID(),SubscribeURL:host+'?'+new URLSearchParams({Action:'ConfirmSubscription',TopicArn,Token:'fixture'}),Timestamp:new Date().toISOString(),Token:'fixture',TopicArn,Type:'SubscriptionConfirmation'};
      const body={...signed,SignatureVersion:'2',SigningCertURL:host+'SimpleNotificationService-v5fixture.pem',Signature:Buffer.from(sign('RSA-SHA256',Buffer.from(Object.entries(signed).map(([k,v])=>k+'\n'+v+'\n').join('')),signedKey)).toString('base64')};
      error(await api('POST','/v1/events/ses',{...body,Message:'tampered'}),403,'SNS_INVALID_SIGNATURE');ok(await api('POST','/v1/events/ses',body),202);
    };
    await confirm(oh);assert.ok(await run('byo.provision',oh));await run('byo.bind',oh);await run('byo.bind',oh);assert.equal((await poll()).importedDomains,1);
    const mark=trace.length;ok(await select(vaId),202);assert.equal(await run('byo.provision',va),false);
    throttlePoll=true;assert.equal(await run('byo.provision',va),false);assert.equal((await regionStatus(va)).error,'AWS_THROTTLED');assert.equal((await regionStatus(va)).sendingState,'provisioning');
    // The first confirmation never arrived. Normal polls must not renew the token
    // on every turn, but an overdue pending subscription re-requests it.
    assert.equal(await run('byo.provision',va),false);assert.equal(trace.filter(v=>v.region===va && v.op==='SubscribeCommand').length,1);
    await db.query(`UPDATE provider_connection_regions SET ownership_journal=(SELECT jsonb_agg(CASE WHEN e->>'kind'='subscription' THEN e||'{"requestedAt":0}' ELSE e END) FROM jsonb_array_elements(ownership_journal) e) WHERE connection_id=$1 AND region=$2`,[v5.id,va]);
    assert.equal(await run('byo.provision',va),false);assert.equal((await poll()).importedDomains,1);await confirm(va);assert.ok(await run('byo.provision',va));await run('byo.bind',va);
    assert.ok(trace.slice(mark).every(v=>v.region===va));assert.equal((await poll()).importedDomains,2);
    for (const region of [va,oh]) {assert.equal(trace.filter(v=>v.region===region&&v.op==='CreateTopicCommand').length,1);assert.equal(trace.filter(v=>v.region===region&&v.op==='SubscribeCommand').length,region===va?2:1);}
    const status=ok(await api('GET',path+'/regions/status')).regions;assert.equal(status.filter((r:Json)=>r.resources.length===6&&r.sendingState==='ready').length,2);
    await t.test('v5 dispatch signs a rendered template with separate quota, template and selected-identity sessions',async()=>{
      // Keep the envelope invisible to the independent simulated runner until THIS mocked
      // customer's regional dispatcher has recorded the provider response.
      const previous=runtime.db;try {await (await import('drizzle-orm/node-postgres')).drizzle(db).transaction(async tx=>{runtime.db=tx;
      const {dispatchDue}=await import('./src/dispatcher.js');const scoped={...runtime,config:{...runtime.config,workspaceId:wid,regions:[oh,va]}};
      const sendSubject=(subject:string)=>api('POST','/v1/emails/send',{from:'pilot@sub.both.example',to:'success@simulator.amazonses.com',template:{name:'opensend-pilot',data:{subject}}});
      error(await sendSubject('Fixture\rSender: x@evil'),422,'INVALID_RENDERED_MIME');
      error(await sendSubject('Fixture\r\nContent-Type: text/html'),422,'INVALID_RENDERED_MIME');
      const mail=ok(await sendSubject('Fixture\r\nSender: x@evil\r\nFrom : x@evil\r\nReturn-Path : x@evil\r\nResent-From: x@evil\r\nX-SES-SOURCE-ARN: foreign\r\n\tcontinued\r\nX-Unrequested: value'),202);
      await dispatchDue(scoped,oh,{accountId:account});assert.equal((await db.query('SELECT status FROM sending_emails WHERE id=$1',[mail.id])).rows[0].status,'accepted');
      assert.ok(policies.some(p=>{const s=JSON.parse(p).Statement;return s.length===1 && s[0].Action.join()==='ses:GetAccount' && s[0].Condition.StringEquals['aws:RequestedRegion']===oh;}));
      const {workspaceCredentials,workspaceConnection}=await import('./src/provider-credentials.js'),pc=await workspaceConnection(scoped,oh),other=(await db.query('SELECT domain_id FROM domain_sending_bindings WHERE workspace_id=$1 AND region=$2',[wid,va])).rows[0].domain_id;
      await assert.rejects(workspaceCredentials(scoped,oh,{...pc,deliverySession:{purpose:'send',domainId:other}}),{code:'BYO_SESSION_SCOPE_REQUIRED'});
      await assert.rejects(workspaceCredentials(scoped,oh,{...pc,deliverySession:{purpose:'template',name:'opensend-*'}}),{code:'TEMPLATE_SCOPE_REQUIRED'});
      // The enrollment link's Ohio region isn't necessarily the first enabled sender.
      await db.query('UPDATE ses_installation_settings SET default_region=$2 WHERE workspace_id=$1',[wid,va]);
      try {assert.equal(ok(await api('GET','/v1/settings/ses')).region,va);assert.ok(policies.some(p=>{const s=JSON.parse(p).Statement;return s.length===1 && s[0].Action.join()==='ses:GetAccount' && s[0].Condition.StringEquals['aws:RequestedRegion']===va;}));}
      finally {await db.query('UPDATE ses_installation_settings SET default_region=$2 WHERE workspace_id=$1',[wid,oh]);}
      });} finally {runtime.db=previous;}
    });
    await t.test('a retained v4 mailbox cannot authorize storage, ingestion or SNS confirmation on a v5 reconnect',async()=>{
      const {workspaceCredentials,workspaceConnection}=await import('./src/provider-credentials.js'),{mailboxS3}=await import('./src/mailbox-setup.js'),{acceptInboundNotification}=await import('./src/mailbox-ingest.js');
      const scoped={...runtime,config:{...runtime.config,workspaceId:wid}}, bucket='retained-v4-mail',topicArn=`arn:aws:sns:${oh}:${account}:opensend-legacy-inbound`;
      await db.query('INSERT INTO mailbox_regions(workspace_id,region,account_id,bucket,topic_arn) VALUES($1,$2,$3,$4,$5)',[wid,oh,account,bucket,topicArn]);
      try {
        const keyReads=policies.length,binding=await workspaceConnection(scoped,oh);assert.equal(binding.template_version,'v5');
        assert.equal((await db.query('SELECT template_version FROM regional_sending_connections WHERE id=$1 AND region=$2',[v5.id,oh])).rows[0].template_version,'v5');
        const bare={id:v5.id,kind:'byo' as const,aws_account_id:account,role_arn:binding.role_arn,external_id:external};
        for(const b of [bare,{...bare,legacy_names:true},{...bare,legacy:true,template_version:'v5'}]) await assert.rejects(workspaceCredentials(scoped,oh,b),{code:'BYO_SESSION_SCOPE_REQUIRED'});
        await assert.rejects(mailboxS3(scoped,wid,oh,bucket),{code:'MAILBOX_OBJECT_NOT_FOUND'});assert.equal(policies.length,keyReads);
        error(await api('POST','/v1/events/ses',{Type:'SubscriptionConfirmation',MessageId:randomUUID(),Message:'fixture',TopicArn:topicArn,Timestamp:new Date().toISOString(),Token:'fixture',SignatureVersion:'2',Signature:'invalid',SigningCertURL:`https://sns.${oh}.amazonaws.com/SimpleNotificationService-fixture.pem`}),403,'SNS_TOPIC_NOT_ALLOWED');
        await assert.rejects(acceptInboundNotification(scoped,{topicArn,region:oh,message:{notificationType:'Received',mail:{messageId:'fixture'},receipt:{timestamp:new Date().toISOString(),recipients:['a@both.example'],action:{type:'S3',topicArn,bucketName:bucket,objectKey:'staging/fixture'}}}}),{code:'MAILBOX_NOTIFICATION_UNTRUSTED'});
      } finally {await db.query('DELETE FROM mailbox_regions WHERE workspace_id=$1 AND region=$2',[wid,oh]);}
    });
    assert.deepEqual(ok(await api('POST','/v1/domains',{name:'new.example'}),202).regions,[oh]);await run('byo.bind',oh);
    assert.equal((await db.query('SELECT region FROM domain_sending_bindings WHERE workspace_id=$1 AND name=$2',[wid,'new.example'])).rows[0].region,oh);
    const verify=(await db.query("SELECT j.* FROM jobs j JOIN operation_domains d ON d.id=j.payload->>'domainId' WHERE d.workspace_id=$1 AND d.name='new.example' AND j.type='domain.verify'",[wid])).rows[0];
    await assert.rejects((await import('./src/operations.js')).operationJobs['domain.verify']!(runtime,verify.payload,{workspaceId:wid,id:verify.id,attempts:1}),JobDeferred);
    assert.equal(trace.filter(t=>t.op==='CreateEmailIdentityCommand').length,1);assert.ok(policies.at(-1)!.includes(`arn:aws:ses:${oh}:${account}:identity/new.example`));
    await t.test('terminal bind failures release both domain caps and allow regional reselection',async()=>{
      ok(await select(oh+':reselect.example'),202);revoked=true;
      try {await assert.rejects(run('byo.bind',oh),{code:'CANDIDATE_NO_LONGER_VERIFIED'});} finally {revoked=false;}
      assert.deepEqual((await regionStatus(oh)).failedIntents,[{domain:'reselect.example',importing:true,error:'CANDIDATE_NO_LONGER_VERIFIED'}]);
      const overlap=unique('claimed')+'.example';ok(await api('POST','/v1/domains',{name:overlap}),202);
      await db.query("INSERT INTO domain_claims(name,workspace_id) VALUES($1,'default')",[overlap]);
      try {await assert.rejects(run('byo.bind',oh),{code:'DOMAIN_CLAIMED'});} finally {await db.query("DELETE FROM domain_claims WHERE name=$1 AND workspace_id='default'",[overlap]);}
      const failed=await regionStatus(oh);assert.deepEqual(failed.pending,[]);assert.ok(failed.failedIntents.some((i:Json)=>i.domain===overlap && i.error==='DOMAIN_CLAIMED'));
      // Fill all but the final active slot in both the 100-total and 10-unproven quotas.
      await db.query(`INSERT INTO byo_domain_intents(connection_id,region,name,importing,id) SELECT $1,$2,'cap-'||n||'.example',n>9-(SELECT count(*) FROM domain_claims WHERE workspace_id=$3 AND NOT ever_proven),'cap-'||n FROM generate_series(1,99-(SELECT count(*)::int FROM domain_claims WHERE workspace_id=$3)) n`,[v5.id,oh,wid]);
      try {ok(await api('POST','/v1/domains',{name:'last-slot.example'}),202);error(await api('POST','/v1/domains',{name:'overflow.example'}),409,'DOMAIN_LIMIT_REACHED');}
      finally {await db.query("DELETE FROM byo_domain_intents WHERE connection_id=$1 AND id LIKE 'cap-%'",[v5.id]);}
      ok(await select(va+':reselect.example'),202);await run('byo.bind',va);
      assert.equal((await db.query("SELECT region FROM domain_sending_bindings WHERE workspace_id=$1 AND name='reselect.example'",[wid])).rows[0].region,va);
    });
    await t.test('deleting a managed identity prunes only the matching journal and only on success',async()=>{
      const journal=async():Promise<Json[]> => (await db.query('SELECT ownership_journal FROM provider_connection_regions WHERE connection_id=$1 AND region=$2',[v5.id,oh])).rows[0].ownership_journal;
      const owned=(await journal()).find(e=>e.kind==='identity' && e.resource.endsWith('/new.example'))!;assert.equal(owned.claim,verify.payload.token);
      await db.query('UPDATE provider_connection_regions SET ownership_journal=ownership_journal||$1::jsonb WHERE connection_id=$2 AND region=$3',[JSON.stringify([{...owned,claim:randomUUID()}]),v5.id,oh]);
      const before=await journal(),path='/v1/domains/'+verify.payload.domainId;
      error(await api('DELETE',path),403,'SES_ACCESS_DENIED');assert.deepEqual(await journal(),before);assert.ok(createdIdentity);
      ok(await api('DELETE',path));assert.equal(createdIdentity,undefined);assert.deepEqual(await journal(),before.filter(e=>e.claim!==owned.claim));
      assert.equal((await db.query('SELECT FROM domain_sending_bindings WHERE domain_id=$1',[verify.payload.domainId])).rowCount,0);
    });
    const selection={revision:rev,candidateIds:[ohId],confirm:true}, receipt=ok(await api('POST',path+'/imports',selection,'retry-selected'),202);
    ok(await api('POST','/v1/domains',{name:'pending.example',region:west}),202);assert.equal(await run('byo.provision',west),false);
    assert.equal((await regionStatus(west)).error,'SNS_CONFIRMATION_PENDING'); // Disconnect before this region ever receives the signed callback.
    ok(await post('/scan'),202);error(await select(ohId),409,'SCAN_STALE');assert.deepEqual(ok(await api('POST',path+'/imports',selection,'retry-selected'),202),receipt);assert.equal((await poll()).importedDomains,3);
    await t.test('disconnect fences admission, refuses drift and checkpoints only owned regional resources',async()=>{
      const del=()=>api('DELETE',path),resource=params.get('param_ResourcePrefix')!,vset=sets.get(va+':'+resource+'-transactional')!,varn=`arn:aws:sns:${va}:${account}:${resource}-feedback`,vtopic=topics.get(varn)!;
      assert.equal((await db.query("UPDATE sending_emails SET status='acceptance_unknown' WHERE workspace_id=$1 AND status='accepted'",[wid])).rowCount,1);
      error(await del(),409,'CONNECTION_IN_USE');await db.query("UPDATE sending_emails SET status='accepted' WHERE workspace_id=$1 AND status='acceptance_unknown'",[wid]);
      const campaign=ok(await api('POST','/v1/campaigns',{name:'disconnect fence'}),201);await db.query("UPDATE sending_campaigns SET state='paused',paused_at=now(),review_id='fixture-review' WHERE id=$1",[campaign.id]);
      error(await del(),409,'CONNECTION_IN_USE');await db.query("UPDATE sending_campaigns SET state='canceled',paused_at=NULL WHERE id=$1",[campaign.id]);
      // Stop the independent, flag-off harness runner from claiming the just-queued
      // rescan. Let an already claimed turn finish its legitimate short deferral.
      await db.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE workspace_id=$1 AND status='pending'",[wid]);
      for(let n=0;(await db.query("SELECT FROM jobs WHERE workspace_id=$1 AND status='running'",[wid])).rowCount;n++){assert.ok(n<100);await new Promise(r=>setTimeout(r,10));}
      const start=trace.length,operation=ok(await del(),202).operationId;
      assert.equal((await poll()).state,'disconnecting');error(await post('/scan'),409,'CONNECTION_DISCONNECTING');
      error(await api('POST','/v1/emails/send',{from:'a@both.example',to:'success@simulator.amazonses.com',subject:'blocked',text:'blocked'}),409,'CONNECTION_REQUIRED');
      const retry=async()=>assert.equal(ok(await del(),202).operationId,operation);
      vset.dest.push({Name:'foreign',Enabled:true});await assert.rejects(run('byo.disconnect'),{code:'BYO_CLEANUP_DRIFT'});vset.dest.pop();await retry();
      vtopic.subs.push({...vtopic.subs[0],Endpoint:'https://foreign.invalid/events'});await assert.rejects(run('byo.disconnect'),{code:'BYO_CLEANUP_DRIFT'});vtopic.subs.pop();await retry();
      const tags=vset.Tags;vset.Tags=[];await assert.rejects(run('byo.disconnect'),{code:'BYO_CLEANUP_DRIFT'});vset.Tags=tags;assert.ok(!trace.slice(start).some(e=>e.op.startsWith('Delete')));await retry();
      const sub=vtopic.subs[0];vtopic.subs[0]={...sub,SubscriptionArn:'PendingConfirmation',Owner:'999999999999'};
      await assert.rejects(run('byo.disconnect'),{code:'BYO_CLEANUP_DRIFT'});vtopic.subs[0]=sub;await retry();
      loseSetDelete=true;await assert.rejects(run('byo.disconnect'),{code:'AWS_SETUP_TIMEOUT'});await retry();
      assert.equal(await run('byo.disconnect'),false); // Explicit NotFound reconciles the lost response without repeating Delete.
      denyCleanup=true;await assert.rejects(run('byo.disconnect'),{code:'AWS_ACCESS_DENIED'});const manifest=(await poll()).cleanup;
      assert.deepEqual(manifest.lastError,{region:va,code:'AWS_ACCESS_DENIED'});assert.equal(manifest.remaining.length,3);assert.ok(!manifest.remaining.find((r:Json)=>r.region===va).resources.some((e:Json)=>e.resource.endsWith('-transactional')));
      const foreign='opensend-self-hosted-fixture';sets.set(va+':'+foreign,{ConfigurationSetName:foreign});topics.set(varn.replace(resource+'-feedback',foreign),{});
      const pendingArn=varn.replace(va,west),pendingSub=topics.get(pendingArn)!.subs[0];
      denyCleanup=false;await retry();for(let steps=0;!await run('byo.disconnect');steps++){
        assert.ok(steps<8);
        if(pendingSub.SubscriptionArn==='PendingConfirmation' && trace.slice(start).some(e=>e.region===west && e.op==='DeleteConfigurationSetCommand')) {
          assert.ok(!trace.slice(start).some(e=>e.region===west && e.op==='GetSubscriptionAttributesCommand'));
          pendingSub.SubscriptionArn=pendingArn+':test'; // Attributes are now readable, but the HTTPS subscription still hasn't confirmed.
        }
      }
      assert.equal(await poll(),null);assert.ok(sets.has(va+':'+foreign));assert.ok(topics.has(varn.replace(resource+'-feedback',foreign)));
      const deletes=trace.slice(start).filter(e=>e.op.startsWith('Delete'));assert.equal(deletes.filter(e=>e.op==='DeleteConfigurationSetCommand').length,6);assert.equal(deletes.filter(e=>e.op==='DeleteTopicCommand').length,3);assert.equal(deletes.length,9);
      assert.ok(trace.slice(start).some(e=>e.region===west && e.op==='GetSubscriptionAttributesCommand'));assert.ok(deletes.some(e=>e.region===west && e.op==='DeleteTopicCommand'));
      assert.equal((await db.query("SELECT FROM domain_claims WHERE workspace_id=$1 AND name='first.example' AND connection_id IS NULL",[wid])).rowCount,1);
      assert.equal((await db.query("SELECT FROM domain_claims WHERE workspace_id=$1 AND claim_scope='account'",[wid])).rowCount,0);await setByoV2(db,[wid,'disable']);
    });
  });

  test('MX: only the operator can override Hosted limits; campaign buffers and SES headroom stay independent', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, local, request, run }) => {
      const { setHostedLimits } = await import('./scripts/set-hosted-limits.js');
      const wid = runtime.config.workspaceId, pool = '111122223333', domain = 'limits.example', from = `sender@${domain}`;
      Object.assign(runtime.config, { multiTenant:true, liveEnabled:true, aws:{ accessKeyId:'fixture-platform', secretAccessKey:'fixture-only' } });
      const limits = (send: string, pending: string) => setHostedLimits(db, [wid, '--send-cap', send, '--pending-cap', pending]);
      await assert.rejects(limits('100', 'default'), /No Hosted connection/);
      await db.query(`INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state) VALUES ($1,$2,$3,'ready')`, [REGION,pool,`arn:aws:sns:${REGION}:${pool}:feedback`]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state,created_at) VALUES ($1,$1,$2,'ready','shared',$3,'ready',now()-interval '6 days 23 hours')`, [wid,REGION,pool]);
      await db.query(`INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state) VALUES ($1,$2,$2,'verified')`, [domain,wid]);
      const changes: Json[] = [];
      t.mock.method(console, 'info', (line: string) => { const entry = JSON.parse(line); if (entry.code === 'HOSTED_LIMITS_CHANGED') changes.push(entry); });
      const key = ok(await local('POST','/v1/api-keys',{name:'Limits fixture',permissions:['read','send','manage']}),201).secret;
      // Ten thousand outstanding direct messages with eleven thousand non-simulator recipients.
      await db.query(`INSERT INTO sending_emails(id,workspace_id,actor_key_id,region,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated)
        SELECT 'email_'||md5($1||n),$1,'fixture',$2,$3,'["one@example.net"]',CASE WHEN n<=1000 THEN '["two@example.net"]'::jsonb ELSE '[]' END,'[]','Fixture','{}',false FROM generate_series(1,10000)n`, [wid,REGION,from]);
      const send = (to = 'real@example.net') => request('POST','/v1/emails/send',key,mail({from,to}));
      const simulator = 'success@simulator.amazonses.com';
      assert.match(error(await send(),429,'SEND_LIMIT_REACHED').message, /100 recipients/);
      assert.match(error(await send(simulator),429,'PENDING_EMAIL_LIMIT_EXCEEDED').message, /10000/);
      await limits('11001','10001');
      error(await request('POST','/v1/connection',key,{kind:'shared',sendCapOverride:99999,pendingCapOverride:99999}),422,'VALIDATION_FAILED');
      error(await request('POST','/v1/connection',key,{kind:'shared'}),403,'PERMISSION_DENIED');
      ok(await send(),202);
      const capped = error(await send(),429,'SEND_LIMIT_REACHED');
      assert.match(capped.message, /11001 recipients/);
      assert.ok(Date.parse(capped.resetAt) > Date.now()+23*3600000, 'Crossing into week two in an hour cannot reset a fixed override.');
      assert.match(error(await send(simulator),429,'PENDING_EMAIL_LIMIT_EXCEEDED').message, /10001/);
      await limits('default','default');
      assert.match(error(await send(),429,'SEND_LIMIT_REACHED').message, /100 recipients/);
      assert.match(error(await send(simulator),429,'PENDING_EMAIL_LIMIT_EXCEEDED').message, /10000/);
      assert.deepEqual(changes.map(({workspaceId,old,new:next}) => [workspaceId,old,next]), [
        [wid,{sendCap:null,pendingCap:null},{sendCap:11001,pendingCap:10001}], [wid,{sendCap:11001,pendingCap:10001},{sendCap:null,pendingCap:null}],
      ]);

      await db.query(`UPDATE sending_emails SET snapshot='{"kind":"marketing"}' WHERE workspace_id=$1 AND actor_key_id='fixture'`,[wid]);
      ok(await send(simulator),202);
      const mixedBatch=await request('POST','/v1/emails/batch',key,{emails:[mail({from,to:simulator}),mail({from,to:simulator,kind:'marketing'})]});
      error(mixedBatch,429,'PENDING_EMAIL_LIMIT_EXCEEDED');

      // The scale run freezes the physical two-million-contact audience. Normal CI uses a sparse
      // tail fixture; neither run needs to render the previous days' 1,999,599 messages.
      await limits('100000','10001');
      const list = ok(await local('POST','/v1/lists',{name:unique('newsletter')}),201);
      const total=process.env.OPENSEND_SCALE_ACCEPTANCE==='1' ? 2_000_000 : 401;
      if (total>401) await db.query("SET LOCAL statement_timeout='180s'");
      for (let start=1;start<=total;start+=50000) await db.query(`WITH contacts AS (INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent)
        SELECT 'con_'||md5($1||n),$1,'subscriber-'||n||'@example.net','subscribed' FROM generate_series($3::int,$4::int)n RETURNING workspace_id,id)
        INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT workspace_id,$2,id FROM contacts`, [wid,list.id,start,Math.min(start+49999,total)]);
      const c = ok(await local('POST','/v1/campaigns',{name:'Large newsletter',from,subject:'Fixture',html:'<p>Fixture.</p>',audience:{listId:list.id}}),201);
      const path = `/v1/campaigns/${c.id}`, view = async () => ok(await local('GET',path));
      assert.equal(ok(await local('POST',`${path}/schedule`,{revision:c.revision,scheduledAt:new Date(Date.now()+3600000).toISOString()}),202).queued,total);
      if (total===401) await db.query(`INSERT INTO sending_review_recipients(review_id,ordinal,recipient,recipient_bytes)
        SELECT review_id,ordinal+1999599,recipient,recipient_bytes FROM sending_review_recipients WHERE review_id=(SELECT review_id FROM sending_campaigns WHERE id=$1)`, [c.id]);
      await db.query(`UPDATE sending_campaigns SET total=2000000,prepared=1999599,expanded=1999599,scheduled_at=now() WHERE id=$1`, [c.id]);
      await db.query(`INSERT INTO provider_account_limits(aws_account_id,region,max_send_rate,max_24_hour_send,sent_last_24_hours,checked_at,refresh_after) VALUES ($1,$2,20,20000,17000,clock_timestamp(),now()+interval '1 minute')`, [pool,REGION]);
      await run('campaign.run');
      const full = await view(); assert.equal(full.delivery.expanded,1999999); assert.equal(full.counts.byStatus.queued,400);
      await db.query(`UPDATE sending_emails SET status='delivered' WHERE campaign_id=$1`, [c.id]);
      await db.query(`UPDATE provider_account_limits SET sent_last_24_hours=18000 WHERE aws_account_id=$1`, [pool]);
      await run('campaign.run');
      const held = await view(); assert.equal(held.state,'sending'); assert.equal(held.delivery.waiting.reason,'ses_daily_quota'); assert.equal(held.delivery.expanded,1999999);
      await db.query(`UPDATE provider_account_limits SET sent_last_24_hours=17999 WHERE aws_account_id=$1`, [pool]);
      await run('campaign.run');
      assert.equal((await view()).delivery.expanded,2000000, 'A quota refresh releases the last recipient without a manual resume.');
    });
  });

  test('MX: Hosted admission, campaign release and dispatch share the rolling recipient cap and reputation hold', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db, run }) => {
      const { checkHostedHealth } = await import('./src/maintenance.js');
      const { resumeHostedSending } = await import('./src/states.js');
      const { runDispatcher } = await import('./src/dispatcher.js');
      const { createMailbox } = await import('./src/mailbox-store.js');
      const wid = runtime.config.workspaceId, pool = '111122223333', domain = 'guard.example', from = `sender@${domain}`;
      Object.assign(runtime.config, { multiTenant:true, liveEnabled:true, aws:{ accessKeyId:'fixture-platform', secretAccessKey:'fixture-only' } });
      await db.query(`INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state,inbound_bucket) VALUES ($1,$2,$3,'ready','fixture')`, [REGION,pool,`arn:aws:sns:${REGION}:${pool}:opensend-mx-feedback`]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES ($1,$1,$2,'ready','shared',$3,'ready')`,[wid,REGION,pool]);
      await db.query(`INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state) VALUES ($1,$2,$2,'verified')`,[domain,wid]);
      const md = unique('mdom');
      await db.query(`INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status) VALUES($1,$2,$3,$4,$5,'active')`,[md,wid,unique('domain'),domain,REGION]);
      const box = await createMailbox(runtime.db,{workspaceId:wid},{domainId:md,domainName:domain,address:from,origin:'api'});
      const simulator = 'success+e2e@simulator.amazonses.com', mail = { from, to: 'real@example.net', subject:'Guardrail', text:'Synthetic.' };
      const send = (extra:Json = {}) => local('POST','/v1/emails/send',{...mail,...extra});
      const batch = (n:number) => local('POST','/v1/emails/batch',{emails:Array.from({length:n},()=>mail)});
      const thread = () => local('POST','/v1/inbound/threads',{addressId:box.id,to:[mail.to],subject:mail.subject,text:mail.text});
      const pause = async () => ok(await local('GET','/v1/me')).connection.sendingPause;
      const keyed = (to:string) => local('POST','/v1/emails/send',{...mail,to},'live',{'Idempotency-Key':'hosted-zero-charge'});
      const free = ok(await keyed(simulator),202);
      assert.deepEqual(ok(await keyed(simulator),202),free);
      error(await keyed('different@example.net'),409,'IDEMPOTENCY_CONFLICT');
      assert.equal((await db.query('SELECT 1 FROM hosted_usage_hourly WHERE workspace_id=$1',[wid])).rowCount,0);
      const recipients = ok(await batch(98),202).data;
      error(await batch(3),429,'SEND_LIMIT_REACHED'); // All or nothing: leave two slots.
      const mixed = ok(await send({to:simulator, cc:['cc@example.net'], bcc:['bcc@example.net']}),202);
      const limited = await send(); const limitError = error(limited,429,'SEND_LIMIT_REACHED');
      assert.ok(Date.parse(limitError.resetAt) > Date.now()+23*3600000); assert.ok(limited.headers.get('retry-after'));
      error(await thread(),429,'SEND_LIMIT_REACHED');
      const hourTuple = async () => (await db.query('SELECT ctid::text,recipients FROM hosted_usage_hourly WHERE workspace_id=$1 ORDER BY hour',[wid])).rows;
      const charged = await hourTuple();
      const sim = ok(await send({to:simulator}),202); // A deploy test cannot consume tenant capacity.
      assert.deepEqual(await hourTuple(), charged, 'Even an existing hourly counter must not get a new +0 tuple.');
      error(await send({to:'fake@x.simulator.amazonses.com'}),429,'SEND_LIMIT_REACHED');
      runtime.config.liveEnabled=false;
      try { assert.equal(ok(await send(),202).simulated,true); } finally { runtime.config.liveEnabled=true; }
      await db.query(`UPDATE sending_emails SET status='suppressed' WHERE id=$1`,[mixed.id]);
      ok(await thread(),202); // Suppression released both real slots (not the SES simulator destination).

      const list = ok(await local('POST','/v1/lists',{name:unique('guard')}),201);
      await db.query(`INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) SELECT 'con_'||md5($1||n),$1,'guard-'||n||'@example.net','subscribed' FROM generate_series(1,3)n`,[wid]);
      await db.query(`INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT workspace_id,$2,id FROM audience_contacts WHERE workspace_id=$1`,[wid,list.id]);
      const c = ok(await local('POST','/v1/campaigns',{name:unique('guard'),from,subject:'Cap',html:'<p>Fixture.</p>',audience:{listId:list.id}}),201);
      // 99 real recipients already admitted. 112 minus the 12-recipient reserve leaves one marketing slot.
      const {setHostedLimits}=await import('./scripts/set-hosted-limits.js');
      await setHostedLimits(db,[wid,'--send-cap','112','--pending-cap','default']);
      ok(await local('POST',`/v1/campaigns/${c.id}/send`,{revision:c.revision,pacing:{autoPause:false}}),202);
      await run('campaign.run');
      const campaign = ok(await local('GET',`/v1/campaigns/${c.id}`));
      assert.equal(campaign.state,'sending'); assert.equal(campaign.delivery.waiting.reason,'hosted_daily_quota'); assert.equal(campaign.delivery.expanded,1);
      assert.equal(campaign.delivery.pauseReason,null); assert.ok(Date.parse(campaign.delivery.waiting.until)>Date.now());
      assert.match(error(await send({kind:'marketing'}),429,'SEND_LIMIT_REACHED').message,/Marketing stops at 100/);
      error(await local('POST','/v1/emails/batch',{emails:[mail,{...mail,kind:'marketing'}]}),429,'SEND_LIMIT_REACHED');
      ok(await batch(12),202); // Only transactional traffic can consume the remaining workspace capacity.
      error(await send(),429,'SEND_LIMIT_REACHED');
      // Even a fully drained queue cannot refill the rolling budget. Only an expired admission opens a new slot.
      await db.query(`UPDATE sending_emails SET status='delivered' WHERE workspace_id=$1 AND status='queued'`,[wid]);
      error(await send(),429,'SEND_LIMIT_REACHED');
      await db.query(`UPDATE sending_emails SET created_at=now()-interval '24 hours' WHERE id=$1`,[recipients[0].id]);
      const queued = ok(await send(),202).id;
      error(await send(),429,'SEND_LIMIT_REACHED');
      await db.query(`UPDATE sending_emails SET created_at=now()-interval '24 hours' WHERE id=ANY($1::text[])`,[recipients.slice(1,15).map((r:Json)=>r.id)]);
      await run('campaign.run');
      const resumed=ok(await local('GET',`/v1/campaigns/${c.id}`));
      assert.equal(resumed.delivery.expanded,3); assert.equal(resumed.delivery.waiting,null,'Hour expiry releases the tail without a resume request.');
      await setHostedLimits(db,[wid,'--send-cap','default','--pending-cap','default']);
      await db.query(`UPDATE provider_connections SET created_at=now()-interval '7 days' WHERE workspace_id=$1`,[wid]);
      ok(await batch(100),202);
      await db.query(`UPDATE sending_emails SET status='delivered' WHERE workspace_id=$1 AND id<>$2 AND status='queued'`,[wid,queued]);

      await (await import('./scripts/set-hosted-limits.js')).setHostedLimits(db,[wid,'--send-cap','100000','--pending-cap','25000']);
      // An operator override does not exempt this workspace from bounce or complaint holds.
      // Synthetic feedback uses the production event vocabulary, including delayed and duplicate outcomes.
      const event = async (type:string, start:number, end:number, data:Json={}, age='0 hours', simulated=false) => {
        await db.query(`INSERT INTO sending_email_events(id,workspace_id,email_id,type,data,simulated,created_at)
          SELECT gen_random_uuid()::text,$1,x,$2,$3,$4,clock_timestamp()-$5::interval FROM unnest($6::text[]) x`,
          [wid,type,data,simulated,age,recipients.slice(start,end).map((r:Json)=>r.id)]);
      };
      await event('bounce',0,9,{bounceType:'Permanent'}); await event('bounce',0,1,{bounceType:'Permanent'}); // duplicate
      await event('bounce',9,10,{bounceType:'Transient'}); await event('complaint',0,1); await event('complaint',1,2,{},'25 hours');
      await event('bounce',9,10,{bounceType:'Permanent'},'0 hours',true);
      await db.query(`INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated) VALUES(gen_random_uuid()::text,$1,$2,'complaint',false)`,[wid,sim.id]);
      await checkHostedHealth(runtime); assert.equal(await pause(),null);
      await db.query(`UPDATE sending_emails SET region='eu-west-1' WHERE id=$1`,[recipients[9].id]); // The final hard bounce is in another region.
      await event('bounce',9,10,{bounceType:'Permanent'});
      await checkHostedHealth(runtime); const held = await pause(); assert.match(held.reason,/hard-bounce/); assert.ok(Date.parse(held.at));
      await checkHostedHealth(runtime); assert.deepEqual(await pause(),held);
      for (const attempt of [send,()=>batch(1),thread,()=>send({to:simulator})]) error(await attempt(),409,'HOSTED_SENDING_PAUSED');
      const report = await runDispatcher(runtime,{region:REGION, accountId:pool}); assert.equal(report.sent,0); assert.equal(report.claimed,0);
      assert.deepEqual((await db.query('SELECT status,lease_until FROM sending_emails WHERE id=$1',[queued])).rows,[{status:'queued',lease_until:null}]);
      await runtime.db.execute(resumeHostedSending(wid)); assert.equal(await pause(),null);
      await checkHostedHealth(runtime); assert.equal(await pause(),null,'Reviewed events cannot re-pause the workspace.');
      const { SESv2Client, GetAccountCommand, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
      const ses = t.mock.method(SESv2Client.prototype,'send',async (cmd:any) => {
        if (cmd instanceof GetAccountCommand) return {SendingEnabled:true,SendQuota:{MaxSendRate:1000,Max24HourSend:10000,SentLast24Hours:0}};
        assert.ok(cmd instanceof SendEmailCommand); return {MessageId:unique('fake-ses')};
      });
      assert.equal((await runDispatcher(runtime,{region:REGION,accountId:pool})).sent,1); assert.equal(ses.mock.callCount(),2);
      await event('complaint',1,2); await checkHostedHealth(runtime); assert.equal(await pause(),null);
      await event('complaint',2,3); await checkHostedHealth(runtime); assert.match((await pause()).reason,/complaint/);
      await runtime.db.execute(resumeHostedSending(wid));
      await db.query(`DELETE FROM sending_email_events WHERE workspace_id=$1`,[wid]);
      // At 200 sends, six hard bounces are exactly 3% (not over); seven exceed the rate despite being <10.
      const accept200 = () => db.query(`INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated,created_at)
        SELECT gen_random_uuid()::text,$1,id,'accepted',false,clock_timestamp() FROM sending_emails WHERE workspace_id=$1 AND NOT simulated AND status<>'suppressed' AND to_addresses->>0<>$2 LIMIT 200`,[wid,simulator]);
      await accept200();
      assert.equal((await db.query(`SELECT count(*)::int n FROM sending_email_events WHERE workspace_id=$1`,[wid])).rows[0].n,200);
      await event('bounce',0,6,{bounceType:'Permanent'}); await checkHostedHealth(runtime); assert.equal(await pause(),null);
      await event('bounce',6,7,{bounceType:'Permanent'}); await checkHostedHealth(runtime); assert.match((await pause()).reason,/hard-bounce/);
      await runtime.db.execute(resumeHostedSending(wid));
      await accept200();
      await event('complaint',0,1); await checkHostedHealth(runtime); assert.match((await pause()).reason,/complaint/);
      ok(await local('POST',`/v1/campaigns/${c.id}/cancel`));
      error(await local('DELETE','/v1/connection'),409,'HOSTED_SENDING_PAUSED'); // No self-service unpause via disconnect.
    });
  });
  test('MX: multi-recipient SES feedback uses real destinations, yesterday’s volume and the last operator resume', async t => {
    await simulatedSesFixture(t, async ({runtime,db,local}) => {
      const { ingestFeedbackBatch } = await import('./src/operations.js');
      const { checkHostedHealth } = await import('./src/maintenance.js');
      const { resumeHostedSending } = await import('./src/states.js');
      const wid=runtime.config.workspaceId, account='111122223333', topicArn=`arn:aws:sns:${REGION}:${account}:feedback`;
      runtime.config.multiTenant=true;
      await db.query(`INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state) VALUES ($1,$2,$3,'ready')`,[REGION,account,topicArn]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES ($1,$1,$2,'ready','shared',$3,'ready')`,[wid,REGION,account]);
      const bcc=Array.from({length:49},(_,i)=>`bcc${i}@example.net`), simulator='success+fixture@simulator.amazonses.com';
      // 100 accepted envelopes yesterday: 4,999 real recipients plus one simulator. No sends today.
      await db.query(`WITH sent AS (INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,status,provider_id,feedback_topic_arn,created_at)
        SELECT 'email_'||md5($1||n),$1,$2,'fixture','support@example.net',jsonb_build_array(CASE WHEN n=1 THEN $5::text ELSE 'primary@example.net' END),'[]',$3,'Fixture','{}',false,'accepted',$1||n,$4,now()-interval '25 hours'
        FROM generate_series(1,100) n RETURNING *)
        INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated,created_at)
        SELECT gen_random_uuid()::text,s.workspace_id,s.id,t,false,s.created_at FROM sent s CROSS JOIN unnest(ARRAY['accepted','send']) t`,[wid,REGION,JSON.stringify(bcc),topicArn,simulator]);
      const feedback = async (kind:'Bounce'|'Complaint', n:number, addresses:string[]) => {
        const rows=addresses.map(emailAddress=>({emailAddress})),timestamp=new Date().toISOString();
        const [result]=await ingestFeedbackBatch(runtime,[{region:REGION,topicArn,messageId:unique('sns'),message:{eventType:kind,mail:{messageId:wid+n,sendingAccountId:account},
          ...(kind==='Bounce'?{bounce:{bounceType:'Permanent',bouncedRecipients:rows,timestamp}}:{complaint:{complainedRecipients:rows,timestamp}})}}]);
        assert.deepEqual(result,{ok:true});
      };
      const check = async () => { await checkHostedHealth(runtime); return ok(await local('GET','/v1/me')).connection.sendingPause; };
      await feedback('Complaint',1,[bcc[0],bcc[1],simulator]); await feedback('Complaint',1,[bcc[0].toUpperCase()]);
      assert.equal(await check(),null,'Two distinct complaints / 4,999 real recipients is below 0.05%, even with no sends today.');
      await feedback('Complaint',1,[bcc[2]]); assert.match((await check()).reason,/complaint/,'Three complaints on one envelope exceed the rate; do not double-count Send callbacks.');
      await runtime.db.execute(resumeHostedSending(wid)); assert.equal(await check(),null);
      await feedback('Bounce',1,[...bcc.slice(0,9),simulator]); await feedback('Bounce',1,bcc.slice(0,8));
      assert.equal(await check(),null,'Repeated hashes and a simulator bounce do not turn nine hard bounces into ten.');
      await feedback('Bounce',2,[bcc[0]]); assert.match((await check()).reason,/hard-bounce/,'The same Bcc address on another email is a separate hard bounce.');
      const {email_id,recipient_hashes}= (await db.query(`SELECT email_id,recipient_hashes FROM sending_email_events WHERE workspace_id=$1 AND type='bounce' AND cardinality(recipient_hashes)=9`,[wid])).rows[0];
      assert.ok(recipient_hashes.every((h:string)=>/^[0-9a-f]{64}$/.test(h)));
      const visible=JSON.stringify([ok(await local('GET',`/v1/emails/${email_id}/events`)),(await db.query(`SELECT data FROM operation_events WHERE workspace_id=$1`,[wid])).rows]);
      assert.ok(!visible.includes('recipient_hashes') && !visible.includes(bcc[0]) && !recipient_hashes.some((h:string)=>visible.includes(h)));

      const single='one@example.net';
      await db.query(`UPDATE sending_emails SET to_addresses=$2, bcc_addresses='[]' WHERE provider_id=$1`,[wid+'3',JSON.stringify([single])]);
      const callback=(eventType:string,detail:Json)=>({region:REGION,topicArn,messageId:unique('sns'),message:{eventType,mail:{messageId:wid+'3',sendingAccountId:account},[eventType.toLowerCase()]:detail}});
      const open=callback('Open',{timestamp:'2026-01-03T00:00:00Z'}), click=callback('Click',{timestamp:'2026-01-02T00:00:00Z',link:'https://example.net/'});
      const batch=[callback('Open',{timestamp:'2026-01-01T00:00:00Z'}),callback('Bounce',{bounceType:'Permanent',bounceSubType:'EmailValidationSuppressed',bouncedRecipients:[{emailAddress:single},{emailAddress:'foreign@example.net'}]}),open,click,open,callback('Click',{isBotEvent:'Likely',timestamp:'2026-01-04T00:00:00Z'})];
      ok(await local('POST','/v1/webhooks',{url:'https://example.com/fixture',eventTypes:['email.bounced','email.opened','email.clicked']}),201);
      let wakes=0;runtime.wake=async()=>{wakes++};
      for(let i=0;i<2;i++) assert.ok((await ingestFeedbackBatch(runtime,batch)).every(x=>x.ok));
      assert.equal(wakes,1,'One batch wake; replay does not fan out.');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM operation_deliveries WHERE workspace_id=$1',[wid])).rows[0].n,5);
      const [observed]=(await db.query(`SELECT suppression_reason,last_click_at,last_open_at,observed_since FROM audience_contacts WHERE workspace_id=$1 AND email=$2`,[wid,single])).rows;
      assert.deepEqual([observed.suppression_reason,...[observed.last_click_at,observed.last_open_at,observed.observed_since].map(d=>d.toISOString().slice(0,10))],['email_validation','2026-01-02','2026-01-03','2026-01-02']);
      assert.equal((await db.query(`SELECT 1 FROM audience_contacts WHERE workspace_id=$1 AND email='foreign@example.net'`,[wid])).rowCount,0);
      assert.deepEqual((await db.query('SELECT status,error_code FROM sending_emails WHERE provider_id=$1',[wid+'3'])).rows,[{status:'suppressed',error_code:'EMAIL_VALIDATION_SUPPRESSED'}]);
    });
  });
  test('MX: migration 060 preserves a mature ready workspace’s tier without provisioning-job history', async t => {
    await simulatedSesFixture(t, async ({runtime,db}) => {
      const {readFile}=await import('node:fs/promises'), {sql}=await import('drizzle-orm');
      const {hostedAllowance}=await import('./src/hosted-sending.js');
      // Replay the actual migration over isolated pre-060 tables; this schema rolls back with the fixture.
      await db.query(`CREATE SCHEMA upgrade060; SET LOCAL search_path TO upgrade060;
        CREATE TABLE workspaces AS SELECT id,created_at FROM public.workspaces WITH NO DATA;
        CREATE TABLE provider_connections AS SELECT id,workspace_id,kind,region,aws_account_id,role_arn,external_id,feedback_topic_arn,tenant_state,state FROM public.provider_connections WITH NO DATA;
        CREATE TABLE provider_pool_regions (LIKE public.provider_pool_regions);
        CREATE TABLE domain_claims (LIKE public.domain_claims);
        CREATE TABLE sending_email_events AS SELECT created_at,workspace_id,email_id,type,simulated,data FROM public.sending_email_events WITH NO DATA;
        CREATE TABLE sending_emails (LIKE public.sending_emails INCLUDING DEFAULTS);
        CREATE TABLE sending_campaigns (LIKE public.sending_campaigns INCLUDING CONSTRAINTS);
        INSERT INTO workspaces VALUES('mature',now()-interval '45 days');
        INSERT INTO provider_connections(id,workspace_id,kind,tenant_state,state) VALUES('mature','mature','shared','ready','ready');`);
      await db.query(await readFile(new URL('./migrations/060_hosted_sending_guardrails.sql',import.meta.url),'utf8'));
      await db.query(`INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,status,provider_id)
        VALUES('backfill','mature','us-east-1','key','a@example.org','["b@example.org"]','["c@example.org"]','["success@simulator.amazonses.com"]','fixture','{}',false,'accepted','ses-id');
        INSERT INTO sending_email_events(created_at,workspace_id,email_id,type,simulated,data) SELECT now(),'mature','backfill',v,false,'{}' FROM unnest(array['accepted','send','complaint']) v`);
      await db.query(await readFile(new URL('./migrations/062_hosted_limit_overrides.sql',import.meta.url),'utf8'));
      await db.query(await readFile(new URL('./migrations/063_direct_admission.sql',import.meta.url),'utf8'));
      assert.deepEqual((await db.query('SELECT recipients::int FROM hosted_usage_hourly')).rows,[{recipients:2}]);
      assert.deepEqual((await db.query('SELECT accepted::int, complaints::int FROM hosted_health_hourly')).rows,[{accepted:2,complaints:1}]);
      runtime.config.multiTenant=true;
      const getCap=async(wid:string)=>(await runtime.db.execute<{cap:number}>(sql`SELECT (${hostedAllowance(runtime.config,wid,1)}->>'cap')::int AS cap`)).rows[0].cap;
      assert.equal(await getCap('mature'),10000);
      await db.query(`INSERT INTO workspaces(id,created_at) VALUES('new',now()); INSERT INTO provider_connections(id,workspace_id,kind,tenant_state,state) VALUES('new','new','shared','ready','ready')`);
      assert.equal(await getCap('new'),100);
    });
  });
  test('MX: disconnect and reconnect cannot reset operator policy', async t => {
    await simulatedSesFixture(t, async ({runtime,db,local}) => {
      const {setHostedLimits}=await import('./scripts/set-hosted-limits.js'), {hostedAllowance}=await import('./src/hosted-sending.js'), {sql}=await import('drizzle-orm');
      const wid=runtime.config.workspaceId; runtime.config.multiTenant=true; runtime.config.sharedRegions=[REGION];
      runtime.config.liveEnabled=true; runtime.config.aws={accessKeyId:'fixture',secretAccessKey:'fixture'};
      const connect=()=>local('POST','/v1/connection',{kind:'shared',region:REGION});
      ok(await connect(),201); await setHostedLimits(db,[wid,'--send-cap','2','--pending-cap','3']);
      ok(await local('DELETE','/v1/connection')); await assert.rejects(setHostedLimits(db,[wid,'--send-cap','default','--pending-cap','default']),/No Hosted connection/);
      ok(await connect(),201);
      const allowance=(await runtime.db.execute<{a:{cap:number;pendingCapOverride:number}}>(sql`SELECT ${hostedAllowance(runtime.config,wid,1)} a`)).rows[0].a;
      assert.deepEqual([allowance.cap,allowance.pendingCapOverride],[2,3]);
    });
  });
  test('MX: admission reads only hourly totals even with a full day of Hosted mail', async t => {
    await simulatedSesFixture(t, async ({runtime,db}) => {
      const {sql}=await import('drizzle-orm'), {hostedAllowance}=await import('./src/hosted-sending.js');
      const wid=runtime.config.workspaceId, total=process.env.OPENSEND_SCALE_ACCEPTANCE==='1' ? 2_000_000 : 2400;
      runtime.config.multiTenant=true;
      await db.query(`INSERT INTO provider_connections(id,workspace_id,kind,region,state,tenant_state) VALUES ($1,$1,'shared',$2,'ready','ready')`,[wid,REGION]);
      for(let start=1;start<=total;start+=20000) await db.query(`INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,status,created_at)
        SELECT $1||n,$1,$2,'key','a@example.org','["b@example.org"]','[]','[]','fixture','{}',false,'delivered',now()-(n%24)*interval '1 hour' FROM generate_series($3::int,$4::int)n`,[wid,REGION,start,Math.min(start+19999,total)]);
      const allowance=hostedAllowance(runtime.config,wid,1);
      assert.equal((await runtime.db.execute<{used:number}>(sql`SELECT (${allowance}->>'used')::int AS used`)).rows[0].used,total);
      const plan=(await runtime.db.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT ${allowance}`)).rows[0]['QUERY PLAN'] as Json[];
      const nodes=(p:Json):Json[]=>[p,...(p.Plans??[]).flatMap(nodes)]; const all=nodes(plan[0].Plan);
      assert.ok(!all.some(n=>['sending_emails','sending_email_events'].includes(n['Relation Name'])));
      assert.equal(all.find(n=>n['Relation Name']==='hosted_usage_hourly')?.['Actual Rows'],24);
      assert.ok(plan[0]['Execution Time']<100,`Allowance took ${plan[0]['Execution Time']}ms for ${total} messages.`);
      t.diagnostic(`Allowance on ${total} envelopes: 24 hourly rows, ${plan[0]['Execution Time']} ms.`);
      await db.query(`UPDATE sending_emails SET status='rejected' WHERE id=$1`,[wid+'1']);
      assert.equal((await runtime.db.execute<{used:number}>(sql`SELECT (${allowance}->>'used')::int AS used`)).rows[0].used,total-1);
      await db.query(`UPDATE sending_emails SET status='rejected',provider_id='accepted-before-rejection' WHERE id=$1`,[wid+'2']);
      assert.equal((await runtime.db.execute<{used:number}>(sql`SELECT (${allowance}->>'used')::int AS used`)).rows[0].used,total-1);
      await db.query(`INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated) VALUES ('accepted',$1,$2,'accepted',false)`,[wid,wid+'2']);
      const accepted=async()=>Number((await db.query('SELECT sum(accepted) n FROM hosted_health_hourly WHERE workspace_id=$1',[wid])).rows[0].n);
      assert.equal(await accepted(),1);
      await db.query(`UPDATE sending_emails SET status='suppressed' WHERE id=$1`,[wid+'2']);
      assert.equal(await accepted(),0,'A later validation suppression removes the acceptance from reputation volume.');
    });
  });
  test('MX: an hourly health-check timeout does not prevent retention', async t => {
    await simulatedSesFixture(t,async ({runtime,db})=>{
      const {cleanup}=await import('./src/maintenance.js');
      runtime.config.multiTenant=true;
      const expired=unique('expired');
      await db.query(`INSERT INTO jobs(id,type,workspace_id,payload,status,created_at) VALUES($1,'tenant.provision',$2,'{}','completed',now()-interval '31 days')`,[expired,runtime.config.workspaceId]);
      const check=t.mock.method(runtime.db,'execute'); check.mock.mockImplementationOnce(()=>{throw Object.assign(new Error('statement timeout'),{code:'57014'});});
      await cleanup(runtime);
      assert.equal((await db.query('SELECT 1 FROM jobs WHERE id=$1',[expired])).rowCount,0);
    });
  });
  test('MX keeps the 32-day workspace health window when shadow placement is disabled',async t=>{
    await simulatedSesFixture(t,async({runtime,db})=>{
      const {cleanup}=await import('./src/maintenance.js'),wid=runtime.config.workspaceId;
      Object.assign(runtime.config,{multiTenant:true,placementShadow:false});
      await db.query(`INSERT INTO hosted_health_hourly SELECT $1,'-infinity',now()-days*interval '1 day',days,0,0 FROM unnest(ARRAY[1,3,31,33]) days`,[wid]);
      await db.query(`INSERT INTO hosted_usage_hourly VALUES($1,now()-interval '3 days',1)`,[wid]);
      await cleanup(runtime);
      assert.deepEqual((await db.query('SELECT accepted::int AS days FROM hosted_health_hourly WHERE workspace_id=$1 ORDER BY days',[wid])).rows.map(r=>r.days),[1,3,31]);
      assert.equal((await db.query('SELECT 1 FROM hosted_usage_hourly WHERE workspace_id=$1',[wid])).rowCount,0,'The two-day usage window did not change.');
    });
  });
  test('MX: account shards isolate sends, stored templates, quota and feedback', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db, run, jobs }) => {
      const { SESv2Client, GetAccountCommand, SendEmailCommand, GetEmailTemplateCommand, TestRenderEmailTemplateCommand } = await import('@aws-sdk/client-sesv2');
      const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
      const { runDispatcher } = await import('./src/dispatcher.js'), { dispatchPartitions } = await import('./src/dispatch.js');
      const { ingestFeedbackBatch } = await import('./src/operations.js'), { setupResources } = await import('./src/ses-setup.js');
      const shared = runtime.config.workspaceId, byo = unique('customer'), pool = '111122223333', account = '444455556666', externalId = randomUUID();
      const poolTopic = `arn:aws:sns:${REGION}:${pool}:opensend-mx-feedback`, byoTopic = `arn:aws:sns:${REGION}:${account}:${setupResources(byo).topicName}`;
      const role = `arn:aws:iam::${account}:role/OpenSendMX-fixture`;
      Object.assign(runtime.config, { multiTenant:true, liveEnabled:true, aws:{ accessKeyId:'fixture-platform', secretAccessKey:'fixture-only' } });
      await db.query('INSERT INTO workspaces(id,slug,name) VALUES ($1,$1,$1)',[byo]);
      await db.query("INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES ($1,$2,$3,'owner')",[unique('member'),byo,manager!.userId]);
      await db.query('INSERT INTO ses_installation_settings(workspace_id,installation_id,default_region,enabled_regions) SELECT $2,$2,default_region,enabled_regions FROM ses_installation_settings WHERE workspace_id=$1',[shared,byo]);
      await db.query("INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state) VALUES ($1,$2,$3,'ready')",[REGION,pool,poolTopic]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES ($1,$1,$2,'ready','shared',$3,'ready')`,[shared,REGION,pool]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,external_id,template_version,platform_principal_arn,role_arn,feedback_topic_arn)
        VALUES ($1,$1,$2,'ready','byo',$3,$4,'v1',$5,$6,$7)`,[byo,REGION,account,externalId,`arn:aws:iam::${pool}:user/test`,role,byoTopic]);
      await db.query("INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state) VALUES ('pool.example',$1,$1,'verified'),('customer.example',$2,$2,'verified')",[shared,byo]);
      const assumptions = t.mock.method(STSClient.prototype,'send', async (cmd: any) => {
        assert.ok(cmd instanceof AssumeRoleCommand); assert.equal(cmd.input.RoleArn,role); assert.equal(cmd.input.ExternalId,externalId);
        return { Credentials:{ AccessKeyId:'fixture-customer',SecretAccessKey:'fixture-only',SessionToken:'fixture-session',Expiration:new Date(Date.now()+3600000) } };
      });
      const quotaReads: string[] = [], sends: string[] = []; let exhausted = true;
      const bouncedAddress = address();
      const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
      runtime.storage={put:async()=>{},get:async()=>({body:gif,contentType:'image/gif'}),delete:async()=>{}};
      t.mock.method(SESv2Client.prototype,'send', async function(this: InstanceType<typeof SESv2Client>, cmd: any) {
        const key=(await this.config.credentials()).accessKeyId, customer=key==='fixture-customer';
        if (cmd instanceof GetAccountCommand) { quotaReads.push(key); if (!customer) await new Promise(r=>setTimeout(r,35)); return { ProductionAccessEnabled:!customer, SendingEnabled:true, SendQuota:{MaxSendRate:customer?1:1000,Max24HourSend:customer?200:10000,SentLast24Hours:customer&&exhausted?200:0} }; }
        if (cmd instanceof GetEmailTemplateCommand || cmd instanceof TestRenderEmailTemplateCommand) {
          assert.ok(customer); return { TemplateContent:{Subject:'fixture'},RenderedTemplate:'Subject: fixture\r\n\r\nFixture.' };
        }
        assert.ok(cmd instanceof SendEmailCommand); const input=cmd.input, wid=input.EmailTags!.find(t=>t.Name==='opensend_workspace_id')!.Value!;
        assert.equal(wid,customer?byo:shared); assert.equal(input.TenantName,customer?undefined:`opensend-${shared}`);
        assert.equal(input.ConfigurationSetName,customer?setupResources(byo).transactional:'opensend-mx-transactional');
        if(!customer){assert.ok(input.Content?.Simple);assert.equal(input.Content?.Raw,undefined);if(input.Content.Simple.Subject?.Data==='ordinary'){const [file]=input.Content.Simple.Attachments!;assert.equal(file!.ContentDisposition,'INLINE');assert.equal(file!.ContentId,'logo');assert.deepEqual(Buffer.from(file!.RawContent!),gif);}}
        if (customer) assert.match(Buffer.from(input.Content!.Raw!.Data!).toString(), /\r\nX-Ticket: 42\r\n\r\nFixture\.$/);
        else if (input.Content?.Simple?.Subject?.Data === 'ordinary') assert.deepEqual(input.Content.Simple.Headers, [{Name:'X-Ticket',Value:'42'}]);
        sends.push(wid);
        if (input.Content?.Simple?.Subject?.Data==='paused') throw Object.assign(new Error('Sending for this tenant is paused'),{ name:'MessageRejected',$metadata:{httpStatusCode:400} });
        if (!customer) {
          const tag = input.EmailTags!.find(t=>t.Name==='opensend_email_id')!.Value!;
          const early = { topicArn:poolTopic, region:REGION, messageId:unique('early-bounce'), message:{ eventType:'Bounce', mail:{messageId:'same-provider-id-in-both-accounts',sendingAccountId:pool,tags:{opensend_email_id:[tag]}}, bounce:{bounceType:'Permanent',bouncedRecipients:[{emailAddress:bouncedAddress}]} } };
          const { settleFeedbackMessage } = await import('./src/adapters/feedback-queue.js');
          for (const attempts of [1,2]) {
            const [outcome] = await ingestFeedbackBatch(runtime,[early]);
            assert.equal(outcome?.error,'SES_EMAIL_NOT_FOUND');
            settleFeedbackMessage({attempts,ack:()=>assert.fail('Matched early feedback must not be dropped'),retry:opts=>assert.equal(opts?.delaySeconds,15*2**attempts)},outcome);
          }
          assert.equal((await jobs('operation.ses')).length,1,'The known owner gets one durable recovery job.');
        }
        return {MessageId:'same-provider-id-in-both-accounts'};
      });
      const wakes: string[]=[]; runtime.dispatch=async (region, accountId)=>{ wakes.push(`${region}:${accountId}`); };
      const send = (wid:string, body:Json) => local('POST','/v1/emails/send',{from:`sender@${wid===shared?'pool':'customer'}.example`,to:address(),...body},'live',{'x-opensend-workspace':wid});
      const headers=[{name:'X-Ticket',value:'42'}];
      const template={template:{name:'fixture',data:{}},headers}; error(await send(shared,template),422,'SHARED_STORED_TEMPLATE_UNSUPPORTED');
      const image=ok(await local('POST','/v1/attachments',{filename:'logo.gif',content:gif.toString('base64'),contentType:'image/gif',disposition:'inline',contentId:'logo'},'live',{'x-opensend-workspace':shared}),201);
      const a=ok(await send(shared,{to:bouncedAddress,subject:'ordinary',html:'<img src="cid:logo">',attachments:[image.id],headers}),202), b=ok(await send(byo,template),202), paused=ok(await send(shared,{subject:'paused',text:'fixture'}),202);
      assert.deepEqual(wakes,[pool,account,pool].map(id=>`${REGION}:${id}`));
      assert.deepEqual((await dispatchPartitions(runtime)).map(p=>p.accountId).sort(),[pool,account]);
      const drain=(accountId:string)=>runDispatcher(runtime,{region:REGION,accountId,lanes:1});
      assert.equal((await drain(account)).sent,0); assert.deepEqual(sends,[]);
      // Two independent cold shard gates race the same pool refresh, but cannot repeat GetAccount.
      const shards=await Promise.all([0,1].map(index=>runDispatcher(runtime,{region:REGION,accountId:pool,lanes:1,batchSize:1,shard:{index,count:2}})));
      assert.equal(shards.reduce((n,r)=>n+r.sent,0),1); assert.deepEqual(sends,[shared,shared]);
      await run('operation.ses');
      assert.equal((await db.query('SELECT status FROM sending_emails WHERE id=$1',[a.id])).rows[0].status,'bounced');
      assert.deepEqual((await db.query('SELECT suppressed,suppression_reason FROM audience_contacts WHERE workspace_id=$1 AND email=$2',[shared,bouncedAddress])).rows,[{suppressed:true,suppression_reason:'hard_bounce'}]);
      assert.deepEqual((await db.query('SELECT status,error_code FROM sending_emails WHERE id=$1',[paused.id])).rows,[{status:'rejected',error_code:'SES_TENANT_SENDING_PAUSED'}]);
      assert.equal((await drain(account)).sent,0); assert.deepEqual(quotaReads,['fixture-customer','fixture-platform']);
      exhausted=false; await db.query("UPDATE provider_account_limits SET refresh_after='-infinity', checked_at='-infinity' WHERE aws_account_id=$1",[account]);
      assert.equal((await drain(account)).sent,1); assert.equal(assumptions.mock.callCount(),1);
      const envelope={Type:'Notification',MessageId:unique('sns'),Message:'{}',Timestamp:new Date().toISOString(),SignatureVersion:'2',Signature:'!!!',SigningCertURL:`https://sns.${REGION}.amazonaws.com/SimpleNotificationService-fixture.pem`};
      for(const topic of [poolTopic,byoTopic]) error(await local('POST','/v1/events/ses',{...envelope,TopicArn:topic}),403,'SNS_INVALID_SIGNATURE');
      error(await local('POST','/v1/events/ses',{...envelope,TopicArn:byoTopic+'-unregistered'}),403,'SNS_TOPIC_NOT_ALLOWED');
      const delivery=(topicArn:string,sendingAccountId:string,tag?:string)=>({topicArn,region:REGION,messageId:unique('feedback'),message:{eventType:'Delivery',mail:{messageId:'same-provider-id-in-both-accounts',sendingAccountId,...(tag?{tags:{opensend_email_id:[tag]}}:{})}}});
      const results=await ingestFeedbackBatch(runtime,[delivery(byoTopic,account),delivery(byoTopic,pool),delivery(byoTopic,account,a.id)]);
      assert.deepEqual(results.map(r=>r.ok),[true,false,false]);
      assert.deepEqual((await db.query('SELECT workspace_id FROM operation_sns_receipts WHERE topic_arn=$1',[byoTopic])).rows,[{workspace_id:byo}]);
      assert.deepEqual((await db.query('SELECT id FROM sending_emails WHERE workspace_id IN ($1,$2) AND status=\'delivered\'',[shared,byo])).rows,[{id:b.id}]);
      runtime.config.hostedSendCaps.firstWeek=1;
      error(await send(shared,{subject:'cap',text:'fixture'}),429,'SEND_LIMIT_REACHED');
      const uncapped = ok(await send(byo,{to:['one@example.org','two@example.org'],subject:'uncapped',text:'fixture'}),202);
      await db.query(`INSERT INTO sending_email_events(id,workspace_id,email_id,type,simulated) SELECT gen_random_uuid()::text,$1,x,'complaint',false FROM unnest($2::text[]) x`,[byo,[b.id,uncapped.id]]);
      await (await import('./src/maintenance.js')).checkHostedHealth(runtime);
      assert.equal(ok(await local('GET','/v1/me',undefined,'live',{'x-opensend-workspace':byo})).connection.sendingPause,null);
    });
  });
  test('MX: 100 emails across 100 workspaces share account-scoped quota and bounded dispatcher statements', async t => {
    await simulatedSesFixture(t, async ({ runtime, db }) => {
      const { runDispatcher } = await import('./src/dispatcher.js');
      const accounts=['111122223333','444455556666']; runtime.config.multiTenant=true; runtime.config.simulatedSes.latencyMs=15;
      await db.query(`INSERT INTO provider_pool_regions(region,aws_account_id,sending_state,feedback_topic_arn) VALUES ($1,$2,'ready',$3)`,[REGION,accounts[0],`arn:aws:sns:${REGION}:${accounts[0]}:opensend-mx-feedback`]);
      await db.query("INSERT INTO workspaces(id,name,slug) SELECT 'bench-'||n,'fixture','bench-'||n FROM generate_series(1,100)n");
      await db.query(`INSERT INTO ses_installation_settings(workspace_id,installation_id,default_region,enabled_regions) SELECT id,id,$1,jsonb_build_array($1::text) FROM workspaces WHERE id LIKE 'bench-%'`,[REGION]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,kind,state,region,aws_account_id,tenant_state) SELECT id,id,'shared','ready',$1,$2,'ready' FROM workspaces WHERE id LIKE 'bench-%' AND id<>'bench-100'`,[REGION,accounts[0]]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,kind,state,region,aws_account_id,role_arn,external_id,template_version,platform_principal_arn,feedback_topic_arn)
        VALUES ('bench-100','bench-100','byo','ready',$1,$2,'fixture-role',gen_random_uuid(),'v1','fixture-platform',$3)`,[REGION,accounts[1],`arn:aws:sns:${REGION}:${accounts[1]}:fixture`]);
      await db.query(`INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) SELECT id,id,'fixture',id,id,'["send"]','[]' FROM workspaces WHERE id LIKE 'bench-%'`);
      await db.query(`INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state) SELECT id||'.example',id,id,'verified' FROM workspaces WHERE id LIKE 'bench-%'`);
      await db.query(`INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated)
        SELECT 'email_'||id,id,$1,id,'sender@'||id||'.example','["fixture@example.net"]','[]','[]','fixture',
          $2::jsonb || jsonb_build_object('from','sender@'||id||'.example'),true FROM workspaces WHERE id LIKE 'bench-%'`,[REGION,JSON.stringify({to:['fixture@example.net'],cc:[],bcc:[],replyTo:[],region:REGION,kind:'transactional',subject:'fixture',text:'fixture',tracking:false,attachments:[],headers:[]})]);
      // Count actual pg round trips (including cache reads/writes), not timed dispatcher phases.
      const queries=t.mock.method(db,'query'); const counts:number[]=[];
      for (const [i,accountId] of accounts.entries()) {
        const start=queries.mock.callCount(), report=await runDispatcher(runtime,{region:REGION,accountId});
        counts.push(queries.mock.callCount()-start); assert.equal(report.sent,i===0?99:1);
      }
      queries.mock.restore(); t.diagnostic(`100 MX dispatches (99 shared workspaces + 1 BYO): ${counts[0]} + ${counts[1]} = ${counts[0]+counts[1]} pg statements (two lanes, cold quotas)`);
      assert.ok(counts[0]+counts[1]<=60,'Connection and readiness resolution must not add per-email statements.');

      // An idle singleton uses the same authorization and consent locks as the grouped claim.
      const wid='bench-1';
      for (const status of ['accepted','suppressed','canceled'] as const) {
        const id=unique('single');
        await db.query(`INSERT INTO sending_emails(id,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated)
          SELECT $1,workspace_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,true FROM sending_emails WHERE id='email_bench-1'`,[id]);
        if(status==='suppressed') await db.query(`INSERT INTO audience_contacts(id,workspace_id,email,suppressed) VALUES ($1,$2,'fixture@example.net',true)`,[unique('contact'),wid]);
        if(status==='canceled') await db.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1',[wid]);
        if(status!=='accepted') await db.query("UPDATE provider_account_limits SET checked_at=clock_timestamp()-interval '90 seconds',refresh_after='-infinity' WHERE aws_account_id=$1 AND region=$2",[accounts[0],REGION]);
        const statements=t.mock.method(db,'query'); await runDispatcher(runtime,{region:REGION,accountId:accounts[0]}); const total=statements.mock.callCount(); statements.mock.restore();
        assert.equal(total,status==='accepted'?2:1, 'Only a send that reaches SES needs a second (record) statement.');
        const row=(await db.query(`SELECT status,provider_id,(SELECT count(*)::int FROM sending_email_events WHERE email_id=$1 AND type='dispatch_attempt') AS attempts FROM sending_emails WHERE id=$1`,[id])).rows[0];
        assert.equal(row.status,status); assert.equal(row.attempts,status==='accepted'?1:0); assert.equal(!!row.provider_id,status==='accepted');
      }
    });
  });

  test('mailbox event cursors do not skip concurrent writers committing in different transactions', async t => {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { recordEvents, readEvents } = await import('./src/mailbox-events.js');
    const first = await fixtureDatabase(t), second = await fixtureDatabase(t), observer = await fixtureDatabase(t);
    const scope = unique('event-order'), read = (after: number) => readEvents(drizzle(observer),scope,{ after, mailboxIds:null, includeStored:true, types:['message.stored'], limit:5 });
    const publish = (conn: pg.Client, id: string) => recordEvents(drizzle(conn),scope,[{ type:'message.stored', mailboxId:null, messageId:id }]);
    await first.query('BEGIN'); await second.query('BEGIN');
    try {
      await second.query("SET LOCAL lock_timeout='5s'"); const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await publish(first,'first'); const writing = publish(second,'second'); void writing.catch(() => {});
      let waiting = false; const deadline = Date.now() + 3000;
      while (!waiting && Date.now() < deadline) { waiting = (await observer.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting',[pid])).rows[0].waiting; if (!waiting) await new Promise(r => setTimeout(r,10)); }
      assert.ok(waiting,'Another publisher must wait for the first commit.'); assert.deepEqual(await read(0),[]);
      await first.query('COMMIT'); await writing;
      const [visible] = await read(0); assert.equal(visible?.messageId,'first');
      await second.query('COMMIT'); assert.deepEqual((await read(visible!.seq)).map(row => row.messageId),['second']);
    } finally { await first.query('ROLLBACK'); await second.query('ROLLBACK'); await observer.query('DELETE FROM mailbox_events WHERE workspace_id=$1',[scope]); }
  });

  test('support mailboxes: track by receipt ID, route the customer reply, verify its webhook and enforce expiry', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, local, jobs }) => {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { SESv2Client, GetAccountCommand, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
      const { credentialFingerprint, discoveryTarget } = await import('./src/ses-region-state.js');
      const { dispatchDue } = await import('./src/dispatcher.js');
      const { acceptInboundNotification, mailboxIngestJobs } = await import('./src/mailbox-ingest.js');
      const { mailboxEventJobs } = await import('./src/mailbox-events.js');
      const scope = runtime.config.workspaceId, topic = `arn:aws:sns:${REGION}:111122223333:fixture`;
      runtime.config.aws = { accessKeyId: 'synthetic-fixture', secretAccessKey: 'synthetic-fixture' }; runtime.config.liveEnabled = true;
      await db.query(`INSERT INTO ses_region_discovery(workspace_id,region,report,credentials_fingerprint,public_url,trusted_account_id,trusted_topic_arn) VALUES($1,$2,$3,$4,$5,'111122223333',$6)`, [scope, REGION,
        { provisioned: true, account: { id: '111122223333', sendingEnabled: true }, resources: { topic: { arn: topic }, transactional: { sendingEnabled: true }, marketing: { sendingEnabled: true } } }, await credentialFingerprint(runtime.config), discoveryTarget(runtime.config), topic]);
      await db.query(`INSERT INTO mailbox_regions(workspace_id,region,bucket,topic_arn) VALUES($1,$2,'fixture-inbox',$3)`, [scope, REGION, topic]);
      await db.query(`INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status) VALUES($1,$2,$3,'example.com',$4,'active')`, [unique('domain'), scope, unique('verified'), REGION]);
      const sends = new Map<string, any>();
      t.mock.method(SESv2Client.prototype, 'send', async (cmd: any) => {
        if (cmd instanceof GetAccountCommand) return { SendingEnabled: true, SendQuota: { MaxSendRate: 1000, Max24HourSend: 10000, SentLast24Hours: 0 } };
        assert.ok(cmd instanceof SendEmailCommand); const id = cmd.input.EmailTags!.find(x => x.Name === 'opensend_email_id')!.Value!; sends.set(id, cmd.input); return { MessageId: `fixture-${id}` };
      });
      const create = async (body: Json) => ok(await local('POST', '/v1/inbound/addresses', body, 'live'), 201);
      const support = await create({ address: 'support@example.com' }), temporary = await create({ address: 'case-42@example.com', ttlSeconds: 3600 });
      assert.equal(support.expiresAt, null); assert.ok(Date.parse(temporary.expiresAt) > Date.now());
      const root = '/v1/inbound/addresses';
      error(await local('POST', root, { address: 'short@example.com', ttlSeconds: 1 }, 'live'), 422);
      error(await local('PATCH', `${root}/${temporary.id}`, { rules: ['case-*@example.com'] }, 'live'), 422);
      const scoped = ok(await local('POST', '/v1/inbound/keys', { name: 'support fixture', addressIds: [support.id], permissions: ['read', 'send'] }, 'live'), 201);
      const agent = { authorization: `Bearer ${scoped.secret}` };
      const webhook = ok(await local('POST', '/v1/inbound/webhooks', { url: 'https://example.com/support-hook', addressIds: [support.id], eventTypes: ['message.received'] }, 'live'), 201);
      const payload = { from: support.address, to: 'customer@example.net', subject: 'Case 42', text: 'An update', replyMailboxId: support.id }, idem = { 'Idempotency-Key': 'fixture-case-42' };
      error(await local('POST', '/v1/emails/send', payload, 'live', agent), 401);
      error(await local('POST', '/v1/emails/send', { ...payload, from: temporary.address }, 'live'), 422);
      error(await local('POST', '/v1/emails/send', { ...payload, replyTo: [temporary.address] }, 'live'), 422);
      await db.query(`UPDATE mailbox_domains SET status='waiting_for_mx' WHERE workspace_id=$1`, [scope]);
      error(await local('POST', '/v1/emails/send', payload, 'live'), 409, 'MAILBOX_DOMAIN_NOT_READY');
      await db.query(`UPDATE mailbox_domains SET status='active' WHERE workspace_id=$1`, [scope]);
      const sent = ok(await local('POST', '/v1/emails/send', payload, 'live', idem), 202);
      assert.deepEqual(ok(await local('POST', '/v1/emails/send', payload, 'live', idem), 202), sent);
      const replyPath = `/v1/inbound/threads/${sent.threadId}/reply`;
      assert.match(sent.id, /^email_/); assert.match(sent.mailboxMessageId, /^msg_/); assert.match(sent.threadId, /^thr_/);
      error(await local('POST', replyPath, { addressId: temporary.id, replyToMessageId: sent.inboundMessageId, text: 'other mailbox' }, 'live'), 404);
      error(await local('POST', replyPath, { addressId: temporary.id, replyToMessageId: sent.inboundMessageId, text: 'other mailbox' }, 'live', agent), 404);
      const ordinary = ok(await local('POST', '/v1/emails/send', { from: support.address, to: 'customer@example.net', subject: 'Private', text: 'Not part of the inbox' }, 'live'), 202);
      assert.equal(ordinary.threadId, undefined); error(await local('POST', replyPath, { addressId: support.id, replyToMessageId: ordinary.id, text: 'not linked' }, 'live', agent), 404);
      error(await local('POST', replyPath, { addressId: support.id, replyToMessageId: sent.inboundMessageId, text: 'too soon' }, 'live', agent), 409, 'REPLY_TARGET_NOT_ACCEPTED');
      await dispatchDue(runtime, REGION);
      const wire = `fixture-${sent.id}@${REGION === 'us-east-1' ? 'email' : REGION}.amazonses.com`;
      const followup = ok(await local('POST', replyPath, { addressId: support.id, replyToMessageId: sent.inboundMessageId, text: 'Follow up' }, 'live', agent), 202);
      assert.equal(followup.inReplyTo, wire); assert.equal(followup.threadId, sent.threadId);

      let mime = '';
      t.mock.method(S3Client.prototype, 'send', async (cmd: any) => { if(cmd.constructor.name==='HeadObjectCommand') return {ContentLength:Buffer.byteLength(mime),ETag:'"fixture"'};if(cmd.constructor.name==='CopyObjectCommand') return {};assert.ok(cmd instanceof GetObjectCommand); return { Body: { transformToByteArray: async () => Buffer.from(mime) } }; });
      async function receive(to: string, timestamp = new Date().toISOString()) {
        const receiptId = unique('fixture'), inboundId = `${receiptId}@example.net`;
        mime = `From: Customer <customer@example.net>\r\nTo: ${to}\r\nSubject: Re: Case 42\r\nMessage-ID: <${inboundId}>\r\nIn-Reply-To: <${wire}>\r\nReferences: <${wire}>\r\n\r\nThank you.`;
        const message = { notificationType: 'Received', mail: { messageId: receiptId, source: 'customer@example.net' }, receipt: { timestamp, recipients: [to], dmarcVerdict: { status: 'PASS' }, action: { type: 'S3', bucketName: 'fixture-inbox', objectKey: `raw/${receiptId}`, topicArn: topic } } };
        await acceptInboundNotification(runtime, { region: REGION, topicArn: topic, message });
        await mailboxIngestJobs['mailbox.ingest']!(runtime, { sesMessageId: receiptId }, { id: unique('job'), workspaceId: scope, attempts: 1 });
        return inboundId;
      }
      const inboundId = await receive(support.address), deliveries = await jobs('mailbox.webhook'); assert.equal(deliveries.length, 1);
      let event: Json | undefined;
      const transport = runtime.webhookFetch;
      runtime.webhookFetch = async (url, init) => {
        assert.equal(url, 'https://example.com/support-hook'); const headers = new Headers(init.headers), body = String(init.body);
        const signature = createHmac('sha256', Buffer.from(webhook.secret.slice(6), 'base64')).update(`${headers.get('webhook-id')}.${headers.get('webhook-timestamp')}.${body}`).digest('base64');
        assert.equal(headers.get('webhook-signature'), `v1,${signature}`); event = JSON.parse(body); return { status: 204 };
      };
      try { await mailboxEventJobs['mailbox.webhook']!(runtime, deliveries[0]!.payload, { id: deliveries[0]!.id, workspaceId: scope, attempts: 1 }); } finally { runtime.webhookFetch = transport; }
      assert.equal(event?.threadId, sent.threadId); assert.equal(event?.addressId, support.id); assert.equal(event?.type, 'message.received');
      const reply = ok(await local('POST', replyPath, { addressId: support.id, replyToMessageId: event!.messageId, text: 'You are welcome' }, 'live', agent), 202);
      await dispatchDue(runtime, REGION);
      assert.equal(reply.threadId, sent.threadId); assert.deepEqual(sends.get(reply.emailId).Destination.ToAddresses, ['customer@example.net']);
      assert.deepEqual(sends.get(reply.emailId).Content.Simple.Headers, [{ Name: 'In-Reply-To', Value: `<${inboundId}>` }, { Name: 'References', Value: `<${wire}> <${inboundId}>` }]);

      await receive(temporary.address, new Date(Date.parse(temporary.createdAt) - 60_000).toISOString());
      assert.equal(ok(await local('GET', `/v1/inbound/messages?addressId=${temporary.id}`, undefined, 'live')).data.length, 0, 'Delayed receipts from before creation are not claimed.');
      await receive(temporary.address);
      await db.query(`UPDATE mailboxes SET expires_at=now()-interval '1 second' WHERE id=$1`, [temporary.id]);
      const prior = ok(await local('GET', `/v1/inbound/messages?addressId=${temporary.id}`, undefined, 'live')).data;
      await receive(temporary.address); await receive('case-42+late@example.com');
      assert.equal(prior.length, 1); assert.deepEqual(ok(await local('GET', `/v1/inbound/messages?addressId=${temporary.id}`, undefined, 'live')).data, prior);
      assert.equal((await jobs('mailbox.webhook')).length, 1, 'Late replies addressed to a retired mailbox must not trigger the support webhook through their forged or forwarded References.');
      error(await local('POST', '/v1/inbound/threads', { addressId:temporary.id, to: ['user@example.net'], subject: 'late', text: 'late' }, 'live'), 409);
      error(await local('POST', '/v1/emails/send', { ...payload, from: temporary.address, replyMailboxId: temporary.id }, 'live'), 409);
      error(await local('POST', root, { address: temporary.address }, 'live'), 409);
    });
  });

  test('inbound MIME parsing enforces the 6 MiB byte cap and 30,000-line cap, storing oversized or line-heavy messages raw with SES headers', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, local }) => {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { readFileSync } = await import('node:fs');
      const PostalMime = (await import('postal-mime')).default;
      const { credentialFingerprint, discoveryTarget } = await import('./src/ses-region-state.js');
      const { acceptInboundNotification, isPostalMimeEscapeGuardInstalled, mailboxIngestJobs, parseInboundMime } = await import('./src/mailbox-ingest.js');
      const apiPkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
      assert.equal(apiPkg.dependencies['postal-mime'], '4.0.0', 'postal-mime must be pinned to an exact version.');
      assert.equal(typeof (PostalMime.prototype as { renderTextContent?: unknown }).renderTextContent, 'function');
      const probe = new PostalMime() as unknown as { textTypes?: unknown; textMap?: unknown };
      assert.ok(probe.textTypes instanceof Set && probe.textMap instanceof Map, 'PostalMime internal textTypes/textMap must match the escape guard hook.');
      assert.equal(isPostalMimeEscapeGuardInstalled(), true, 'PostalMime renderTextContent escape guard hook must be installed in CI.');
      const scope = runtime.config.workspaceId, topic = `arn:aws:sns:${REGION}:111122223333:inbound-caps`;
      const domainId = unique('domain');
      runtime.config.aws = { accessKeyId: 'synthetic-fixture', secretAccessKey: 'synthetic-fixture' }; runtime.config.liveEnabled = true;
      await db.query(`INSERT INTO ses_region_discovery(workspace_id,region,report,credentials_fingerprint,public_url,trusted_account_id,trusted_topic_arn) VALUES($1,$2,$3,$4,$5,'111122223333',$6)`, [scope, REGION, { provisioned: true, account: { id: '111122223333', sendingEnabled: true }, resources: { topic: { arn: topic }, transactional: { sendingEnabled: true }, marketing: { sendingEnabled: true } } }, await credentialFingerprint(runtime.config), discoveryTarget(runtime.config), topic]);
      await db.query(`INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,'example.com',$3)`, [domainId, scope, REGION]);
      await db.query(`INSERT INTO mailbox_regions(workspace_id,region,bucket,topic_arn) VALUES($1,$2,'fixture-inbox',$3)`, [scope, REGION, topic]);
      await db.query(`INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all) VALUES($1,$2,$3,'example.com',$4,'active','store')`, [unique('mdom'), scope, domainId, REGION]);
      const box = ok(await local('POST', '/v1/inbound/addresses', { address: 'caps@example.com' }, 'live'), 201);
      const raw = new Map<string, Uint8Array>();
      t.mock.method(S3Client.prototype, 'send', async (cmd: any) => {
        if (cmd.constructor.name === 'HeadObjectCommand') return { ContentLength: raw.get(cmd.input.Key!)!.byteLength, ETag: '"fixture"' };
        if (cmd.constructor.name === 'CopyObjectCommand' || cmd.constructor.name === 'PutObjectCommand') return {};
        assert.ok(cmd instanceof GetObjectCommand);
        const bytes = raw.get(cmd.input.Key!)!;
        return { Body: { transformToByteArray: async () => bytes } };
      });
      const parseSpy = t.mock.method(PostalMime, 'parse');
      async function ingest(bytes: Uint8Array, subject: string, messageId: string, commonFrom = ['Sender <sender@example.net>']) {
        const receiptId = unique('cap'), objectKey = `raw/${receiptId}`;
        raw.set(objectKey, bytes);
        const message = {
          notificationType: 'Received',
          mail: { messageId: receiptId, source: 'sender@example.net', commonHeaders: { from: commonFrom, subject, messageId: `<${messageId}>` } },
          receipt: { timestamp: new Date().toISOString(), recipients: [box.address], spfVerdict: { status: 'PASS' }, dmarcVerdict: { status: 'PASS' }, action: { type: 'S3', bucketName: 'fixture-inbox', objectKey, topicArn: topic } },
        };
        assert.equal(await acceptInboundNotification(runtime, { region: REGION, topicArn: topic, message }), 1);
        await mailboxIngestJobs['mailbox.ingest']!(runtime, { sesMessageId: receiptId }, { id: unique('job'), workspaceId: scope, attempts: 1 });
        const { rows: [row] } = await db.query('SELECT id, thread_id, status, automated, body_truncated, subject, from_address, message_id FROM mail_messages WHERE workspace_id = $1 AND ses_message_id = $2', [scope, receiptId]);
        return row;
      }

      const header = Buffer.from('From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nSubject: Exact 6 MiB\r\n\r\n');
      const exact6Mib = Buffer.concat([header, Buffer.alloc(6 * 1024 * 1024 - header.length - 2, 0x61), Buffer.from('\r\n')]);
      assert.equal(exact6Mib.byteLength, 6 * 1024 * 1024);
      const parsed6Mib = await ingest(exact6Mib, 'Exact 6 MiB', 'exact-6m@example.net');
      assert.equal(parsed6Mib.status, 'received');
      assert.equal(parseSpy.mock.callCount(), 1);

      const over6Mib = Buffer.concat([exact6Mib, Buffer.from('x')]);
      assert.equal(over6Mib.byteLength, 6 * 1024 * 1024 + 1);
      const unparsedBytes = await ingest(over6Mib, 'Over 6 MiB SES subject', 'over-6m@example.net');
      assert.equal(parseSpy.mock.callCount(), 1, 'Messages over 6 MiB must not invoke PostalMime.parse.');
      assert.equal(unparsedBytes.status, 'unparsed');
      assert.equal(unparsedBytes.body_truncated, true);
      assert.equal(unparsedBytes.subject, 'Over 6 MiB SES subject');
      assert.equal(unparsedBytes.from_address, 'sender@example.net');
      assert.equal(unparsedBytes.message_id, 'over-6m@example.net');
      const overDetail = ok(await local('GET', `/v1/inbound/messages/${unparsedBytes.id}?includeDelivery=true`, undefined, 'live'));
      assert.equal(overDetail.bodyTruncated, true);
      assert.match(overDetail.rawUrl, /\.eml/);

      const lineHeader = 'From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nSubject: Exact 30k lines\r\n\r\n';
      const atLineCap = Buffer.from(lineHeader + 'x\r\n'.repeat(30_000 - 4));
      const parsedLines = await ingest(atLineCap, 'Exact 30k lines', 'at-30k@example.net');
      assert.equal(parsedLines.status, 'received');
      assert.equal(parseSpy.mock.callCount(), 2);

      const overLineCap = Buffer.from(lineHeader + 'x\r\n'.repeat(30_001 - 4));
      assert.ok(overLineCap.byteLength < 200_000);
      const unparsedLines = await ingest(overLineCap, 'Over 30k SES subject', 'over-30k@example.net');
      assert.equal(parseSpy.mock.callCount(), 2, 'Messages over 30,000 lines must skip PostalMime.parse.');
      assert.equal(unparsedLines.status, 'unparsed');
      assert.equal(unparsedLines.body_truncated, true);
      assert.equal(unparsedLines.subject, 'Over 30k SES subject');
      assert.equal(unparsedLines.message_id, 'over-30k@example.net');
      assert.match(ok(await local('GET', `/v1/inbound/messages/${unparsedLines.id}?includeDelivery=true`, undefined, 'live')).rawUrl, /\.eml/);

      // Distinct unparsed receipts with identical From/Subject/Message-ID must not deduplicate across receipts,
      // nor collapse with an empty-body parsed receipt, while retrying the same receipt stays idempotent.
      const sharedMessageId = 'reused-unparsed@example.net';
      const firstUnparsed = await ingest(Buffer.from(lineHeader + 'alpha\r\n'.repeat(30_001 - 4)), 'Same unparsed subject', sharedMessageId);
      const secondUnparsed = await ingest(Buffer.from(lineHeader + 'bravo\r\n'.repeat(30_001 - 4)), 'Same unparsed subject', sharedMessageId);
      assert.notEqual(firstUnparsed.id, secondUnparsed.id, 'Unparsed messages on distinct receipts must remain separate stored messages.');
      const emptyParsed = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nSubject: Same unparsed subject\r\nMessage-ID: <${sharedMessageId}>\r\n\r\n`), 'Same unparsed subject', sharedMessageId);
      assert.equal(emptyParsed.status, 'received');
      assert.notEqual(emptyParsed.id, firstUnparsed.id, 'An empty-body parsed message must not deduplicate onto a prior unparsed message.');
      const { rows: [retryReceipt] } = await db.query('SELECT ses_message_id, raw_key FROM mail_messages WHERE id = $1', [secondUnparsed.id]);
      await mailboxIngestJobs['mailbox.ingest']!(runtime, { sesMessageId: retryReceipt.ses_message_id }, { id: unique('job'), workspaceId: scope, attempts: 2 });
      const { rows: storedShared } = await db.query('SELECT id, raw_key FROM mail_messages WHERE workspace_id = $1 AND message_id = $2 ORDER BY created_at, id', [scope, sharedMessageId]);
      assert.equal(storedShared.length, 3);
      assert.equal(new Set(storedShared.map(r => r.raw_key)).size, 3);

      const emptyFirstId = 'empty-first@example.net';
      const firstEmpty = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nSubject: Empty then unparsed\r\nMessage-ID: <${emptyFirstId}>\r\n\r\n`), 'Empty then unparsed', emptyFirstId);
      const laterUnparsed = await ingest(Buffer.from(lineHeader + 'charlie\r\n'.repeat(30_001 - 4)), 'Empty then unparsed', emptyFirstId);
      assert.equal(firstEmpty.status, 'received');
      assert.equal(laterUnparsed.status, 'unparsed');
      assert.notEqual(laterUnparsed.id, firstEmpty.id, 'A later unparsed receipt must not deduplicate onto an earlier empty-body parsed message.');

      // PostalMime textToHtml escapes all 6 characters [<>"'?&] across decoded text/plain leaves rendered into HTML.
      // Cap total decoded matches at 131,072 (including quoted-printable and base64 parts) without penalizing multipart/alternative.
      const mixedMime = (encoding: string, body: string) => Buffer.from(
        `From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="mix"\r\n\r\n--mix\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n${body}\r\n--mix\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>tail</p>\r\n--mix--\r\n`
      );
      const qpGroup = '=3C=3E=22=27=3F=26'; // 6 escaped characters in decoded text, zero raw [<>"'?&] bytes in body.
      const qpLine = qpGroup.repeat(40) + '=\r\n'; // 240 decoded matches per line.
      const qpAtCap = qpLine.repeat(546) + qpGroup.repeat(5) + '=3C=3E'; // 546*240 + 30 + 2 = 131,072 decoded matches.
      const parsedQp = await ingest(mixedMime('quoted-printable', qpAtCap), 'QP at 131,072', 'qp-at-cap@example.net');
      assert.equal(parsedQp.status, 'received');

      const unparsedQp = await ingest(mixedMime('quoted-printable', qpAtCap + '=26'), 'QP over 131,072', 'qp-over-cap@example.net');
      assert.equal(unparsedQp.status, 'unparsed');
      assert.equal(unparsedQp.body_truncated, true);
      assert.equal(unparsedQp.subject, 'QP over 131,072');

      const b64OverCap = Buffer.from('<>"\'?&'.repeat(21_845) + '<>"').toString('base64').replace(/.{76}/g, '$&\r\n'); // 131,073 decoded matches.
      const unparsedB64 = await ingest(mixedMime('base64', b64OverCap), 'Base64 over 131,072', 'b64-over-cap@example.net');
      assert.equal(unparsedB64.status, 'unparsed');
      assert.equal(unparsedB64.body_truncated, true);

      const raw6MibLt = mixedMime('8bit', '<'.repeat(5_900_000));
      assert.ok(raw6MibLt.byteLength <= 6 * 1024 * 1024);
      const unparsedRawLt = await ingest(raw6MibLt, 'Raw 14-line < expansion', 'raw-lt-over-cap@example.net');
      assert.equal(unparsedRawLt.status, 'unparsed');
      assert.equal(unparsedRawLt.body_truncated, true);

      // multipart/alternative with both text/plain and text/html never runs textToHtml, so >131,072 [<>"'?&] stays parsed.
      const altBody = '<div class="r"><a href="https://example.com/?a=1&amp;b=2">item \'x\'</a></div>\r\n'.repeat(18_000); // >180,000 [<>"'?&] chars, <30k lines.
      const altPlain = 'quote "a" & \'b\' <c> ?\r\n'.repeat(28_000 - 18_000 - 20); // >50,000 in plain too; total lines < 30,000.
      const parsedAlt = await ingest(Buffer.from(
        `From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="alt"\r\n\r\n--alt\r\nContent-Type: text/plain\r\n\r\n${altPlain}\r\n--alt\r\nContent-Type: text/html\r\n\r\n${altBody}\r\n--alt--\r\n`
      ), 'Alternative HTML', 'alt-html-ok@example.net');
      assert.equal(parsedAlt.status, 'received');

      // Concurrent root parses isolate their escape counters via AsyncLocalStorage while nested message/rfc822 parts share their root's counter.
      const mixed70kA = mixedMime('8bit', '<'.repeat(70_000));
      const mixed70kB = mixedMime('8bit', '&'.repeat(70_000));
      const nested140k = Buffer.from(
        `From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: message/rfc822\r\n\r\n${mixed70kA.toString('utf8')}\r\n--outer\r\nContent-Type: text/html\r\n\r\n<p>outer</p>\r\n--outer--\r\n`
      );
      const [concA, concNested, concB] = await Promise.all([parseInboundMime(mixed70kA), parseInboundMime(nested140k), parseInboundMime(mixed70kB)]);
      assert.ok(concA?.html && concB?.html, 'Two concurrent 70,000-escape root parses must both succeed without summing across roots.');
      assert.equal(concNested, null, 'Nested message/rfc822 escape counts must accumulate onto their own root parse.');

      // If postal-mime's hook is unavailable, log once (structured, no PII) and reject > 256 KiB by raw byte length alone before parsing.
      const warnSpy = t.mock.method(console, 'warn');
      const proto = PostalMime.prototype as { renderTextContent?: unknown };
      const savedHook = proto.renderTextContent;
      proto.renderTextContent = undefined;
      try {
        assert.equal(isPostalMimeEscapeGuardInstalled(), false);
        const degradedHdr = Buffer.from('From: secret-sender@example.net\r\nSubject: Secret Subject\r\n\r\n');
        const exact256k = Buffer.concat([degradedHdr, Buffer.alloc(256 * 1024 - degradedHdr.length - 2, 0x61), Buffer.from('\r\n')]);
        assert.equal(exact256k.byteLength, 256 * 1024);
        proto.renderTextContent = function () {}; // Non-guarded function: simulates missing guard while allowing <= 256 KiB parse to finish.
        const callsBefore = parseSpy.mock.callCount();
        assert.ok(await parseInboundMime(exact256k), 'Messages at or below 256 KiB raw bytes still parse in fallback mode.');
        assert.equal(parseSpy.mock.callCount(), callsBefore + 1);
        const over256k = Buffer.concat([exact256k, Buffer.from('x')]);
        assert.equal(over256k.byteLength, 256 * 1024 + 1);
        assert.equal(await parseInboundMime(over256k), null, 'Messages above 256 KiB raw bytes must become unparsed before parsing starts.');
        const rfc2231Boundary = Buffer.from(
          `From: secret-sender@example.net\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=first; boundary*=utf-8''second\r\n\r\n--first\r\nContent-Type: application/pdf\r\n\r\n${'A'.repeat(270_001)}\r\n--first--\r\n--second\r\nContent-Type: text/plain\r\n\r\n${'<'.repeat(270_001)}\r\n--second--\r\n`
        );
        assert.equal(await parseInboundMime(rfc2231Boundary), null, 'Raw byte-length fallback rejects > 256 KiB regardless of MIME headers.');
        assert.equal(parseSpy.mock.callCount(), callsBefore + 1, 'Rejected > 256 KiB fallback messages must not invoke PostalMime.parse.');
      } finally {
        proto.renderTextContent = savedHook;
      }
      assert.equal(isPostalMimeEscapeGuardInstalled(), true);
      const guardWarnings = warnSpy.mock.calls.map(c => String(c.arguments[0])).filter(line => line.includes('MAILBOX_MIME_ESCAPE_GUARD_UNAVAILABLE'));
      assert.equal(guardWarnings.length, 1, 'Missing escape guard must log once across repeated parses.');
      assert.doesNotMatch(guardWarnings[0]!, /secret-sender|Secret Subject/i);
      warnSpy.mock.restore();

      // Unparsed messages preserve header-based auto-reply detection from the raw header block so reply loop guards still hold.
      const unparsedTail = 'x\r\n'.repeat(30_005);
      const autoFolded = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nAuto-Submitted:\r\n auto-replied\r\n\r\n${unparsedTail}`), 'OOO unparsed', 'auto-folded@example.net');
      assert.equal(autoFolded.status, 'unparsed');
      assert.equal(autoFolded.automated, true);
      error(await local('POST', `/v1/inbound/threads/${autoFolded.thread_id}/reply`, { addressId: box.id, replyToMessageId: autoFolded.id, text: 'would loop' }, 'live'), 409, 'REPLY_TO_AUTOMATED');
      ok(await local('POST', `/v1/inbound/threads/${autoFolded.thread_id}/reply`, { addressId: box.id, replyToMessageId: autoFolded.id, text: 'explicit override', allowAutomated: true }, 'live'), 202);

      const over6MibPrecedence = Buffer.concat([Buffer.from('From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nPrecedence: bulk\r\n\r\n'), Buffer.alloc(6 * 1024 * 1024, 0x61)]);
      const bulkUnparsed = await ingest(over6MibPrecedence, 'Bulk over 6 MiB', 'bulk-6m@example.net');
      assert.equal(bulkUnparsed.status, 'unparsed');
      assert.equal(bulkUnparsed.automated, true);
      error(await local('POST', `/v1/inbound/threads/${bulkUnparsed.thread_id}/reply`, { addressId: box.id, replyToMessageId: bulkUnparsed.id, text: 'would loop' }, 'live'), 409, 'REPLY_TO_AUTOMATED');

      const xAutoreply = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nX-Autoreply: yes\r\n\r\n${unparsedTail}`), 'X-Autoreply unparsed', 'x-auto@example.net');
      assert.equal(xAutoreply.status, 'unparsed');
      assert.equal(xAutoreply.automated, true);

      const reportUnparsed = await ingest(Buffer.from(`From: bounce@isp.example\r\nTo: caps@example.com\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="r"\r\n\r\n${unparsedTail}`), 'DSN unparsed', 'dsn-unparsed@example.net');
      assert.equal(reportUnparsed.status, 'unparsed');
      assert.equal(reportUnparsed.automated, true);

      const autoNo = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nAuto-Submitted: NO\r\n\r\nAuto-Submitted: auto-replied\r\n${unparsedTail}`), 'Human over 30k', 'auto-no@example.net');
      assert.equal(autoNo.status, 'unparsed');
      assert.equal(autoNo.automated, false, 'Auto-Submitted: no and body text after the blank line must not flag a message as automated.');
      ok(await local('POST', `/v1/inbound/threads/${autoNo.thread_id}/reply`, { addressId: box.id, replyToMessageId: autoNo.id, text: 'normal reply allowed' }, 'live'), 202);

      // Structured header tokens, RFC 2047 encoded words, quoted display names, and incomplete header scan handling.
      const autoNoParam = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nAuto-Submitted: (human) no; owner=me\r\n\r\n${unparsedTail}`), 'Auto no param', 'auto-no-param@example.net');
      assert.equal(autoNoParam.automated, false);

      const autoEncoded = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nAuto-Submitted: =?UTF-8?B?YXV0by1yZXBsaWVk?=; owner=me\r\n\r\n${unparsedTail}`), 'Encoded auto-replied', 'auto-enc@example.net');
      assert.equal(autoEncoded.automated, true);

      const precEncodedB = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nPrecedence: =?UTF-8?B?YnVsaw==?=\r\n\r\n${unparsedTail}`), 'Encoded bulk', 'prec-b64@example.net');
      assert.equal(precEncodedB.automated, true);
      const precEncodedQ = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nPrecedence: =?UTF-8?Q?auto=5Freply?=\r\n\r\n${unparsedTail}`), 'Encoded auto_reply', 'prec-qp@example.net');
      assert.equal(precEncodedQ.automated, true);
      const precHyphen = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nPrecedence: auto-reply\r\n\r\n${unparsedTail}`), 'Hyphenated auto-reply', 'prec-hyphen@example.net');
      assert.equal(precHyphen.automated, true);
      const precHyphenParsed = await ingest(Buffer.from('From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nPrecedence: auto-reply\r\n\r\nhi\r\n'), 'Parsed auto-reply', 'prec-hyphen-parsed@example.net');
      assert.equal(precHyphenParsed.status, 'received');
      assert.equal(precHyphenParsed.automated, true);

      const filenameReport = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nContent-Type: application/octet-stream; name="multipart/report.eml"\r\n\r\n${unparsedTail}`), 'Filename report', 'fn-report@example.net');
      assert.equal(filenameReport.automated, false, 'A parameter value containing multipart/report must not match Content-Type media type.');
      const nonDsnReport = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nContent-Type: multipart/report; boundary="r"\r\n\r\n${unparsedTail}`), 'Report without report-type', 'no-rtype@example.net');
      assert.equal(nonDsnReport.automated, false);
      const mdnReport = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nContent-Type: multipart/report; report-type="disposition-notification"(comment); boundary="r"\r\n\r\n${unparsedTail}`), 'MDN trailing comment', 'mdn-unparsed@example.net');
      assert.equal(mdnReport.automated, true);
      const dsnTokenComment = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nContent-Type: multipart/report; report-type=delivery-status(dsn); boundary="r"\r\n\r\n${unparsedTail}`), 'DSN token comment', 'dsn-comment@example.net');
      assert.equal(dsnTokenComment.automated, true);

      const quotedPostmaster = '"<postmaster@example.net>" <human@example.net>';
      const displayPostmaster = await ingest(Buffer.from(`From: ${quotedPostmaster}\r\nTo: caps@example.com\r\n\r\n${unparsedTail}`), 'Quoted display name', 'quoted-pm@example.net', [quotedPostmaster]);
      assert.equal(displayPostmaster.from_address, 'human@example.net');
      assert.equal(displayPostmaster.automated, false, 'Quoted display name containing <postmaster@...> must not mark the message automated.');
      const realPostmaster = await ingest(Buffer.from(`From: "System" <postmaster@example.net>\r\nTo: caps@example.com\r\n\r\n${unparsedTail}`), 'Real postmaster', 'real-pm@example.net', []);
      assert.equal(realPostmaster.automated, true);

      const capWarnSpy = t.mock.method(console, 'warn');
      const unterminatedHeaders = Buffer.concat([Buffer.from('From: Sender <sender@example.net>\r\nAuto-Submitted: auto-replied\r\nX-Pad: '), Buffer.alloc(2 * 1024 * 1024 + 1024, 0x61)]);
      const cappedScan1 = await ingest(unterminatedHeaders, 'Capped header block', 'cap-hdr-1@example.net');
      assert.equal(cappedScan1.status, 'unparsed');
      assert.equal(cappedScan1.automated, false, 'Incomplete header scan must treat automated status as unknown and default to false.');
      const cappedField = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nAuto-Submitted: ${'('.concat('a'.repeat(17_000), ') auto-replied')}\r\n\r\n${unparsedTail}`), 'Capped header field', 'cap-hdr-2@example.net');
      assert.equal(cappedField.automated, false);
      const parsedHugeAuto = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nAuto-Submitted: ${'a'.repeat(1024 * 1024)}\r\n\r\nhi\r\n`), 'Parsed 1 MiB Auto-Submitted', 'cap-hdr-parsed@example.net');
      assert.equal(parsedHugeAuto.status, 'received');
      assert.equal(parsedHugeAuto.automated, false, 'Parsed messages must also enforce the 16 KiB field cap before tokenizing automated headers.');
      const capLogs = capWarnSpy.mock.calls.map(c => JSON.parse(String(c.arguments[0]))).filter(entry => entry.code === 'MAILBOX_AUTOMATED_HEADER_SCAN_INCOMPLETE');
      assert.deepEqual(capLogs.map(entry => entry.count), [1, 2, 3]);
      capWarnSpy.mock.restore();
      const utf8HeavyPrecedence = await ingest(Buffer.from(`From: Sender <sender@example.net>\r\nTo: caps@example.com\r\nPrecedence: bulk; x="${'€'.repeat(6_000)}"\r\n\r\nhi\r\n`), 'UTF-8 heavy Precedence', 'cap-hdr-utf8@example.net');
      assert.equal(utf8HeavyPrecedence.automated, false, 'The 16 KiB field cap counts UTF-8 bytes, not UTF-16 code units, on the parsed path too.');

      // Internal CR runs (quadratic under the old /\r*\n/g chain) still classify correctly; scaling is measured outside CI, not by wall clock here.
      const crRun16k = `no; x="${'\r'.repeat(16_000)}"`;
      const crMime = Buffer.from([
        'From: Sender <sender@example.net>',
        'To: caps@example.com',
        `Auto-Submitted: ${crRun16k}`,
        `Precedence: normal\r${'\r'.repeat(16_000)}x`,
        `Content-Type: text/plain; x="${'\r'.repeat(16_000)}"`,
        '',
        unparsedTail,
      ].join('\r\n'));
      const crRes = await ingest(crMime, 'Internal CR run', 'cr-linear@example.net');
      assert.equal(crRes.status, 'unparsed');
      assert.equal(crRes.automated, false);
    });
  });

  test('forwarded support: query every stored inbound message and reply to the selected message as the public address', async t => {
    await simulatedSesFixture(t, async ({ runtime, db, local, jobs }) => {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { SESv2Client, GetAccountCommand, GetEmailIdentityCommand, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
      const { credentialFingerprint, discoveryTarget } = await import('./src/ses-region-state.js');
      const { acceptInboundNotification, mailboxIngestJobs } = await import('./src/mailbox-ingest.js');
      const { dispatchDue } = await import('./src/dispatcher.js');
      const scope = runtime.config.workspaceId, topic = `arn:aws:sns:${REGION}:111122223333:inbound-fixture`;
      const domainId = unique('domain'), publicAddress = 'support@example.com', address = 'support@inbox.example.com';
      runtime.config.aws = { accessKeyId: 'synthetic-fixture', secretAccessKey: 'synthetic-fixture' }; runtime.config.liveEnabled = true;
      await db.query(`INSERT INTO ses_region_discovery(workspace_id,region,report,credentials_fingerprint,public_url,trusted_account_id,trusted_topic_arn) VALUES($1,$2,$3,$4,$5,'111122223333',$6)`, [scope, REGION, { provisioned: true, account: { id: '111122223333', sendingEnabled: true }, resources: { topic: { arn: topic }, transactional: { sendingEnabled: true }, marketing: { sendingEnabled: true } } }, await credentialFingerprint(runtime.config), discoveryTarget(runtime.config), topic]);
      await db.query(`INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,'example.com',$3),($4,$2,'inbox.example.com',$3)`, [unique('dom'),scope,REGION,domainId]);
      await db.query(`INSERT INTO mailbox_regions(workspace_id,region,bucket,topic_arn) VALUES($1,$2,'fixture-inbox',$3)`, [scope,REGION,topic]);
      await db.query(`INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all) VALUES($1,$2,$3,'inbox.example.com',$4,'active','store')`, [unique('mdom'),scope,domainId,REGION]);
      const outgoing = new Map<string, any>(); let verified = false, dkim = false;
      t.mock.method(SESv2Client.prototype, 'send', async (cmd: any) => {
        if (cmd instanceof GetEmailIdentityCommand) { assert.equal(cmd.input.EmailIdentity, 'example.com'); return { IdentityType: 'DOMAIN', VerifiedForSendingStatus: verified, VerificationStatus: verified ? 'SUCCESS' : 'PENDING', DkimAttributes: { Status: dkim ? 'SUCCESS' : 'PENDING', SigningEnabled: dkim } }; }
        if (cmd instanceof GetAccountCommand) return { SendingEnabled: true, SendQuota: { MaxSendRate: 100, Max24HourSend: 10000, SentLast24Hours: 0 } };
        assert.ok(cmd instanceof SendEmailCommand); const id = cmd.input.EmailTags!.find(x => x.Name === 'opensend_email_id')!.Value!; outgoing.set(id, cmd.input); return { MessageId: `synthetic-${id}` };
      });
      const base = '/v1/inbound', addresses = `${base}/addresses`;
      const post = (path: string, body: Json, headers?: Record<string, string>) => local('POST', path, body, 'live', headers);
      const get = (path: string, headers?: Record<string, string>) => local('GET', path, undefined, 'live', headers);
      error(await post(addresses, { address, publicAddress }), 409, 'PUBLIC_DOMAIN_NOT_VERIFIED');
      verified = true; error(await post(addresses, { address, publicAddress }), 409, 'PUBLIC_DOMAIN_DKIM_NOT_READY');
      dkim = true; error(await post(addresses, { address, publicAddress:'billing@example.com' }),422,'PUBLIC_ADDRESS_MISMATCH');
      const box = ok(await post(addresses, { address, publicAddress }), 201); assert.equal(box.publicAddress, publicAddress);
      const inbox = `${base}/messages?addressId=${box.id}`;
      const agent = { authorization: `Bearer ${ok(await post(`${base}/keys`, { name: 'support agent', addressIds: [box.id], permissions: ['read','send'] }), 201).secret}` };
      const reader = { authorization: `Bearer ${ok(await post(`${base}/keys`, { name: 'all mailbox reader', permissions: ['read'] }), 201).secret}` };
      const callbackAuth = 'Bearer ' + unique('inbound-callback'), updatedAuth = 'Bearer ' + unique('retry-callback');
      const allHook = ok(await post(`${base}/webhooks`, { url: 'https://example.com/all', eventTypes: ['message.stored'], headers: [{ name: 'Authorization', value: callbackAuth }] }), 201);
      const boxHook = ok(await post(`${base}/webhooks`, { url: 'https://example.com/support', addressIds: [box.id], eventTypes: ['message.received'] }), 201);
      const raw = new Map<string,string>();
      t.mock.method(S3Client.prototype,'send', async (cmd: any) => { if(cmd.constructor.name==='HeadObjectCommand') return {ContentLength:Buffer.byteLength(raw.get(cmd.input.Key)!),ETag:'"fixture"'};if(cmd.constructor.name==='CopyObjectCommand') return {};if(cmd.constructor.name==='PutObjectCommand') {assert.doesNotMatch(Buffer.from(cmd.input.Body).toString(),/^bcc:/im);return {};}assert.ok(cmd instanceof GetObjectCommand); const mime = raw.get(cmd.input.Key!); assert.ok(mime); return { Body: { transformToByteArray: async () => Buffer.from(mime) } }; });
      async function receive(to: string | string[], mime: string, dmarc = 'PASS') {
        const receipt = unique('receipt'), objectKey = `raw/${receipt}`; raw.set(objectKey,mime);
        const input = { region: REGION, topicArn: topic, message: { notificationType: 'Received', mail: { messageId: receipt, source: 'forwarder@example.net' }, receipt: { timestamp: new Date().toISOString(), recipients: Array.isArray(to) ? to : [to], dmarcVerdict: { status: dmarc }, action: { type:'S3', bucketName:'fixture-inbox', objectKey, topicArn:topic } } } };
        assert.equal(await acceptInboundNotification(runtime,input),1); assert.equal(await acceptInboundNotification(runtime,input),0);
        await mailboxIngestJobs['mailbox.ingest']!(runtime,{sesMessageId:receipt},{id:unique('job'),workspaceId:scope,attempts:1});
      }
      const mime = (id: string, body: string, extra: string[]) => [`From: Customer <from@example.net>`,`To: ${publicAddress}`,'Subject: Widget issue',`Message-ID: <${id}@example.net>`,...extra,'',body].join('\r\n');
      const firstMime = mime('initial','original zebra',['Reply-To: first@example.net']);
      await receive(address,firstMime);
      await receive(address,mime('selected','second zebra',['In-Reply-To: <initial@example.net>','Reply-To: case-owner@example.net','Cc: colleague@example.net, case-owner@example.net','Bcc: private@example.net']));
      await receive(address,mime('latest','third zebra',['In-Reply-To: <selected@example.net>','References: <initial@example.net>\r\n <selected@example.net>','Reply-To: different@example.net']));
      await receive('unassigned@inbox.example.com',mime('unrouted','unrouted zebra',['In-Reply-To: <selected@example.net>']));
      await receive(address,firstMime); // Separate SMTP receipt, identical logical message.
      const all = ok(await get(`${base}/messages?q=zebra`)).data; assert.equal(all.length,4);
      const byMailbox = ok(await get(`${inbox}&direction=inbound&q=zebra&limit=2`,agent)); assert.equal(byMailbox.data.length,2); assert.ok(byMailbox.nextCursor);
      const page2 = ok(await get(`${inbox}&direction=inbound&q=zebra&limit=2&cursor=${encodeURIComponent(byMailbox.nextCursor)}`,agent));
      const ids = [...byMailbox.data,...page2.data].map(m=>m.id); assert.equal(new Set(ids).size,3); assert.equal(page2.nextCursor,null);
      const selected = all.find((m: Json)=>m.snippet==='second zebra')!, unrouted = all.find((m: Json)=>m.snippet==='unrouted zebra')!;
      const detail = ok(await get(`${base}/messages/${selected.id}?addressId=${box.id}`,agent)); assert.equal(detail.text.trim(),'second zebra'); assert.equal(detail.messageId,'selected@example.net');
      assert.equal(ok(await get(`${inbox}&threadId=${detail.threadId}&direction=inbound`,agent)).data.length,3);
      error(await get(`${base}/messages/${unrouted.id}?addressId=${box.id}`,agent),404); error(await get(`${base}/messages/${unrouted.id}`,reader),404);
      assert.equal(ok(await get(`${base}/messages/${unrouted.id}`)).text.trim(),'unrouted zebra');
      error(await get(`${base}/messages?includeDelivery=true`,agent),403);
      error(await get(`${base}/messages/${selected.id}?includeDelivery=true`,reader),403);
      const logs = ok(await get(`${base}/messages?includeDelivery=true&region=${REGION}`)).data;
      assert.deepEqual(logs.find((m:Json)=>m.id===selected.id).addresses,[{id:box.id,address}]);
      assert.deepEqual(logs.find((m:Json)=>m.id===unrouted.id).addresses,[]);
      const globalEvents = ok(await get(`${base}/events?types=message.stored&after=0`)).data;
      assert.deepEqual(new Set(globalEvents.map((e: Json)=>e.messageId)),new Set(all.map((m: Json)=>m.id))); assert.equal(globalEvents.length,4);
      for (const key of [agent,reader]) assert.equal(ok(await get(`${base}/events?types=message.stored&after=0`,key)).data.length,0);
      error(await post(`${base}/webhooks`,{ url:'https://example.com/invalid-scope', eventTypes:['message.stored'], addressIds:[box.id] }),422,'INVALID_EVENT_SCOPE');
      const deliveries = (await db.query(`SELECT id, webhook_id, payload FROM mailbox_webhook_deliveries WHERE workspace_id=$1`,[scope])).rows;
      assert.equal(deliveries.filter(d=>d.webhook_id===allHook.id).length,4); assert.equal(deliveries.filter(d=>d.webhook_id===boxHook.id).length,3);
      assert.equal((await jobs('mailbox.webhook')).length,7);
      const delivery = deliveries.find(d => d.webhook_id === allHook.id && d.payload.messageId === unrouted.id)!;
      error(await get(`${base}/webhooks/${allHook.id}`, agent), 403, 'ADMIN_REQUIRED');
      const { mailboxEventJobs } = await import('./src/mailbox-events.js');
      let attempts = 0;
      const transport = runtime.webhookFetch;
      runtime.webhookFetch = async (url, init) => {
        const h = new Headers(init.headers), body = String(init.body), event = JSON.parse(body);
        assert.equal(url, 'https://example.com/all'); assert.equal(event.type, 'message.stored'); assert.equal(event.addressId, null); assert.equal(event.id, delivery.payload.id);
        assert.equal(h.get('authorization'), attempts === 0 ? callbackAuth : updatedAuth); assert.equal(h.get('content-type'), 'application/json');
        assert.equal(h.get('webhook-id'), event.id); assert.equal(h.get('webhook-signature'), 'v1,' + createHmac('sha256', Buffer.from(allHook.secret.slice(6),'base64')).update(`${event.id}.${h.get('webhook-timestamp')}.${body}`).digest('base64'));
        if (++attempts === 1) return { status: 503 };
        if (attempts === 2) throw new Error(updatedAuth); // Transport diagnostics may contain request data.
        return { status: 204 };
      };
      const deliver = (attempt: number) => mailboxEventJobs['mailbox.webhook']!(runtime,{ deliveryId:delivery.id },{ id:delivery.id,workspaceId:scope,attempts:attempt });
      try {
        await assert.rejects(deliver(1), { code:'WEBHOOK_HTTP_ERROR' });
        ok(await local('PATCH', `${base}/webhooks/${allHook.id}`, { headers: [{ name: 'Authorization', value: updatedAuth }] }));
        await assert.rejects(deliver(2), { code:'WEBHOOK_NETWORK_ERROR' });
        const failed = ok(await get(`${base}/webhooks/${allHook.id}/deliveries`));
        assert.equal(failed.data.find((d: Json) => d.id === delivery.id).lastError, 'WEBHOOK_NETWORK_ERROR');
        assert.ok(!JSON.stringify(failed).includes(callbackAuth) && !JSON.stringify(failed).includes(updatedAuth));
        await deliver(3); await deliver(4); assert.equal(attempts,3);
        assert.ok(!JSON.stringify(ok(await get(`${base}/webhooks/${allHook.id}/deliveries`))).includes(updatedAuth));
      } finally { runtime.webhookFetch = transport; }
      const replyPath = `${base}/threads/${detail.threadId}/reply`, idem = { ...agent, 'Idempotency-Key': 'answer-selected' };
      error(await post(replyPath,{ addressId:box.id,replyToMessageId:selected.id,text:'unauthorized',from:'sales@example.com' },agent),403,'FROM_NOT_ALLOWED');
      // Headers are denylisted, not X- only: structural headers OpenSend/SES own are refused, everything else passes through.
      for (const name of ['X-SeS-CONFIGURATION-SET','From','content-type','In-Reply-To','List-Unsubscribe','Auto-Submitted','Resent-From','ARC-Seal','Authentication-Results','DomainKey-Signature','Feedback-ID']) error(await post(replyPath,{ addressId:box.id,replyToMessageId:selected.id,text:'no provider overrides',headers:[{name,value:'override'}] },agent),422);
      error(await post(replyPath,{ addressId:box.id,replyToMessageId:selected.id,text:'no injection',headers:[{name:'Precedence',value:'bulk\r\nBcc: victim@example.net'}] },agent),422);
      const reply = ok(await post(replyPath,{ addressId:box.id,replyToMessageId:selected.id,text:'Answering the second one',replyAll:true,headers:[{name:'Precedence',value:'bulk'},{name:'X-Ticket',value:'42'}] },idem),202);
      assert.equal(ok(await post(replyPath,{ addressId:box.id,replyToMessageId:selected.id,text:'Answering the second one',replyAll:true,headers:[{name:'Precedence',value:'bulk'},{name:'X-Ticket',value:'42'}] },idem),202).id,reply.id);
      const tracked = ok(await post('/v1/emails/send',{ from:publicAddress,to:'customer@example.net',text:'Checking in',subject:'New case',replyMailboxId:box.id }),202);
      await dispatchDue(runtime, REGION);
      assert.equal(outgoing.get(tracked.id).FromEmailAddress,publicAddress);
      const wire = outgoing.get(reply.emailId); assert.equal(wire.FromEmailAddress,publicAddress); assert.equal(reply.threadId,detail.threadId);
      assert.deepEqual(wire.Destination,{ ToAddresses:['case-owner@example.net'],CcAddresses:['colleague@example.net'],BccAddresses:[] });
      assert.equal(wire.Content.Simple.Subject.Data,'Re: Widget issue');
      assert.deepEqual(wire.Content.Simple.Headers,[{Name:'In-Reply-To',Value:'<selected@example.net>'},{Name:'References',Value:'<initial@example.net> <selected@example.net>'},{Name:'Precedence',Value:'bulk'},{Name:'X-Ticket',Value:'42'}]);
      // Some clients return only the direct parent. No mailbox sync or subject match should be required.
      await receive(address,mime('answered','fourth zebra',[`In-Reply-To: <synthetic-${reply.emailId}@${REGION === 'us-east-1' ? 'email' : REGION}.amazonses.com>`]).replace('Subject: Widget issue','Subject: A different subject'));
      const continued = ok(await get(`${inbox}&direction=inbound&q=fourth`,agent)).data;
      assert.equal(continued.length,1); assert.equal(continued[0].threadId,detail.threadId);
      await receive(address,mime('separate','separate case',[`In-Reply-To: <synthetic-${tracked.id}@${REGION === 'us-east-1' ? 'email' : REGION}.amazonses.com>`,'References: <selected@example.net>']));
      const separate = ok(await get(`${inbox}&direction=inbound&q=separate`,agent)).data;
      assert.equal(separate.length,1); assert.equal(separate[0].threadId,tracked.threadId,'A direct, not-yet-synced SES parent takes priority over a known older reference.');
      // An address that requires DMARC keeps unverified mail for a person and announces only verified mail.
      assert.equal(box.requireDmarc,false); assert.equal(ok(await local('PATCH',`${addresses}/${box.id}`,{ requireDmarc:true },'live')).requireDmarc,true);
      const other = ok(await post(addresses,{address:'archive@inbox.example.com',requireDmarc:true}),201);
      assert.equal(other.requireDmarc,true); assert.equal(ok(await local('PATCH',`${addresses}/${other.id}`,{requireDmarc:false},'live')).requireDmarc,false);
      const announced = async () => (await db.query(`SELECT payload FROM mailbox_webhook_deliveries WHERE webhook_id=$1`,[boxHook.id])).rows.map(row => row.payload);
      const labels = async (messageId: string) => Object.fromEntries((await db.query(`SELECT mailbox_id,labels FROM mailbox_messages WHERE message_id=$1`,[messageId])).rows.map(row=>[row.mailbox_id,row.labels]));
      const before = (await announced()).length;
      await receive([address,other.address],mime('spoofed','unverified zebra',[]),'GRAY');
      const held = ok(await get(`${inbox}&direction=inbound&q=unverified`,agent)).data; assert.equal(held.length,1);
      assert.deepEqual(await labels(held[0].id),{[box.id]:['unverified'],[other.id]:[]});
      const events = ok(await get(`${base}/events?types=message.received&after=0`)).data.filter((e:Json)=>e.messageId===held[0].id);
      assert.deepEqual(events.map((e:Json)=>[e.addressId,e.data.dmarc]),[[other.id,'GRAY']]);
      assert.equal((await announced()).length,before);
      await receive(address,mime('verified','verified zebra',[]));
      const passed = ok(await get(`${inbox}&direction=inbound&q=verified`,agent)).data; assert.equal(passed.length,1); assert.deepEqual(await labels(passed[0].id),{[box.id]:[]});
      const received = (await announced()).filter(payload => payload.messageId === passed[0].id);
      assert.equal(received.length,1); assert.equal(received[0].data.dmarc,'PASS'); assert.equal((await announced()).length,before + 1);
      // Custom headers: reserved names and malformed Message-IDs are refused, replies keep their own threading,
      // and a new conversation can cite a thread OpenSend never received.
      const plain = { from:publicAddress,to:'customer@example.net',subject:'Headers',text:'Header check' };
      error(await post('/v1/emails/send',{ ...plain,headers:[{name:'from',value:'ceo@example.com'}] }),422);
      error(await post('/v1/emails/send',{ ...plain,headers:[{name:'X-SES-Configuration-Set',value:'other'}] }),422);
      for (const name of ['Mail-Reply-To','Disposition-Notification-To','TLS-Required']) error(await post('/v1/emails/send',{ ...plain,headers:[{name,value:'attacker@example.org'}] }),422);
      error(await post('/v1/emails/send',{ ...plain,headers:[{name:'In-Reply-To',value:'not-a-message-id'}] }),422);
      error(await post(replyPath,{ text:'own threading',headers:[{name:'References',value:'<old@example.net>'}] },agent),422,'THREADING_HEADER_NOT_ALLOWED');
      const custom = ok(await post('/v1/emails/send',{ ...plain,headers:[{name:'X-Ticket',value:'42'},{name:'Priority',value:'urgent'}] }),202);
      const cited = ok(await post('/v1/inbound/threads',{ addressId:box.id,to:['customer@example.net'],subject:'Re: Old case',text:'Following up',
        headers:[{name:'In-Reply-To',value:'<old-1@example.net>'},{name:'References',value:'<old-0@example.net> <old-1@example.net>'},{name:'X-Ticket',value:'7'}] },{ 'Idempotency-Key':'cite-old-case' }),202);
      assert.equal(cited.inReplyTo,'old-1@example.net'); assert.deepEqual(cited.references,['old-0@example.net','old-1@example.net']);
      const bridged = ok(await post('/v1/emails/send',{ ...plain,replyAddressId:box.id,headers:[{name:'In-Reply-To',value:'<old-1@example.net>'},{name:'References',value:'<old-0@example.net> <old-1@example.net>'}] }),202);
      const stored = ok(await get(`${base}/messages/${bridged.inboundMessageId}`,agent));
      assert.equal(stored.inReplyTo,cited.inReplyTo); assert.deepEqual(stored.references,cited.references); assert.notEqual(stored.threadId,cited.threadId);
      assert.equal((await db.query('SELECT 1 FROM mail_message_ids WHERE workspace_id=$1 AND message_id=ANY($2)',[scope,cited.references])).rowCount,0);
      const contact = ok(await post('/v1/contacts',{email:plain.to}),201);
      ok(await post(`/v1/contacts/${contact.id}/consent`,{status:'subscribed',source:'fixture',policyVersion:'v1',evidence:'Synthetic fixture.',occurredAt:new Date().toISOString()}));
      const marketing = {...plain,kind:'marketing',headers:[{name:'X-Ticket',value:'42'}]};
      error(await post('/v1/emails/batch',{emails:[{...marketing,headers:[{name:'list-unsubscribe',value:'<https://example.net/override>'}]}]}),422);
      const batch = ok(await post('/v1/emails/batch',{emails:[marketing]}),202);
      await dispatchDue(runtime, REGION);
      assert.deepEqual(outgoing.get(custom.id).Content.Simple.Headers,[{Name:'X-Ticket',Value:'42'},{Name:'Priority',Value:'urgent'}]);
      assert.deepEqual(outgoing.get(cited.emailId).Content.Simple.Headers,[{Name:'In-Reply-To',Value:'<old-1@example.net>'},{Name:'References',Value:'<old-0@example.net> <old-1@example.net>'},{Name:'X-Ticket',Value:'7'}]);
      assert.deepEqual(outgoing.get(bridged.id).Content.Simple.Headers,outgoing.get(cited.emailId).Content.Simple.Headers.slice(0,2));
      const deliveredHeaders = outgoing.get(batch.data[0].id).Content.Simple.Headers;
      assert.deepEqual(deliveredHeaders.map((h:Json)=>h.Name),['X-Ticket','List-Unsubscribe','List-Unsubscribe-Post']);
      assert.equal(deliveredHeaders[0].Value,'42'); assert.match(deliveredHeaders[1].Value,/\/unsubscribe\/u_[a-f0-9]{64}>$/); assert.equal(deliveredHeaders[2].Value,'List-Unsubscribe=One-Click');
    });
  });

  test('attachment and template uploads share one validator: any content, SES banned extensions refused', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, request, db }) => {
      const objects = new Map<string, { body: Uint8Array; contentType: string }>();
      runtime.storage = {
        async put(key, body, contentType) { objects.set(key, { body, contentType }); },
        async get(key) { return objects.get(key) ?? null; },
        async delete(key) { objects.delete(key); },
      };
      for (const path of ['/v1/attachments', '/v1/template-assets']) {
        for (const text of ['false', '0', 'null', '""', '{}', '[]']) {
          const uploaded = ok(await local('POST', path, { filename: 'scalar.json', contentType: 'application/json', content: Buffer.from(text).toString('base64') }), 201);
          assert.equal(uploaded.size, Buffer.byteLength(text));
        }
        // One shared validator: file bytes and declared types are never second-guessed; only SES's banned extensions are refused.
        for (const [filename, contentType, bytes] of [
          ['broken.json', 'application/json', Buffer.from('{')],
          ['invalid.txt', 'text/plain', Buffer.from([0xff])],
          ['fake.png', 'image/png', Buffer.from('not an image')],
          ['mismatch.json', 'image/png', Buffer.from('{}')],
        ] as const) assert.equal(ok(await local('POST', path, { filename, contentType, content: bytes.toString('base64') }), 201).size, bytes.length);
        for (const filename of ['unsafe.exe', 'macro.ps1', 'UPPER.JS', 'archive.tar.lnk', 'trailing.exe.', 'trailing.exe . ']) error(await local('POST', path, { filename, content: Buffer.from('unsafe').toString('base64') }), 422, 'UNSUPPORTED_ATTACHMENT_TYPE');
        error(await local('POST', path, { filename: 'empty.txt', content: '' }), 422);
      }
      // Paid preview/import operations share a minute budget across sessions and API keys.
      let renders = 0, imports = 0;
      runtime.renderHtmlImage = async () => { renders++; return { data: Uint8Array.of(1), mimeType: 'image/png' }; };
      runtime.importPublicImage = async () => { imports++; return { data: Uint8Array.of(2), contentType: 'image/png' }; };
      const template = ok(await local('POST', '/v1/templates', { name: 'Preview' }), 201);
      const campaign = ok(await local('POST', '/v1/campaigns', { name: 'Preview' }), 201);
      const previews = [`/v1/templates/${template.id}/preview-image`, `/v1/campaigns/${campaign.id}/preview-image`];
      const key = async (permission: string) => ok(await local('POST', '/v1/api-keys', { name: 'Preview', permissions: [permission] }), 201);
      const reader = await key('read'), sender = await key('send');
      for (const path of previews) error(await request('GET', path, reader.secret), 403, 'PERMISSION_DENIED');
      const importImage = () => local('POST', '/v1/template-assets/import', { url: 'https://example.com/logo.png' });
      ok(await importImage(), 201);
      for (let i = 0; i < 29; i++) ok(await request('GET', previews[i % 2]!, sender.secret));
      for (const reply of [await importImage(), await local('GET', previews[0]!), await local('GET', previews[1]!)]) {
        assert.equal(error(reply, 429, 'RENDER_RATE_LIMITED').retryable, true);
        assert.equal(reply.headers.get('retry-after'), '60');
      }
      assert.equal(renders, 29); assert.equal(imports, 1, 'Denied requests never reach the renderer or downloader.');
      const other = await key('manage');
      await db.query("UPDATE api_keys SET workspace_id='default' WHERE id=$1", [other.id]);
      ok(await request('POST', '/v1/template-assets/import', other.secret, { url: 'https://example.com/other.png' }), 201);
      await db.query("UPDATE api_request_budgets SET window_start=window_start - interval '1 minute' WHERE workspace_id=$1 AND key_id='render:images'", [runtime.config.workspaceId]);
      ok(await request('GET', previews[0]!, sender.secret));
    });
  });

  test('job scheduling serves every class', async t => {
    await simulatedSesFixture(t, async ({ runtime, db }) => {
      const { processJobs, enqueue } = await import('./src/jobs.js');
      const { jobHandlers } = await import('./src/sending.js');
      // processJobs drains the whole installation; isolate this queue from the harness runner.
      await db.query('CREATE TEMP TABLE jobs (LIKE public.jobs INCLUDING ALL) ON COMMIT DROP');
      const seen = new Set<string>();
      const types = ['campaign.run', 'operation.webhook', 'operation.simulatedFeedback'];
      const handlers: Record<string, import('./src/core.js').JobHandler> = { 'email.dispatch': jobHandlers['email.dispatch']! };
      for (const type of types) {
        handlers[type] = async () => { seen.add(type); };
        for (let i = 0; i < 12; i++) await enqueue(runtime.db, { type, workspaceId: runtime.config.workspaceId, payload: {} });
      }
      t.mock.method(Math, 'random', () => 0);
      assert.equal(await processJobs(runtime, handlers, 16, 2), 16);
      assert.deepEqual([...seen].sort(), [...types].sort());
      assert.equal(await processJobs(runtime, handlers, 100, 2), 20);
      assert.deepEqual([...seen].sort(), [...types].sort());
      await db.query('DELETE FROM jobs WHERE workspace_id = $1', [runtime.config.workspaceId]);
      const retired = await enqueue(runtime.db, { type: 'email.dispatch', workspaceId: runtime.config.workspaceId, payload: {} });
      assert.equal(await processJobs(runtime, handlers, 1, 1), 1);
      assert.deepEqual((await db.query('SELECT status FROM jobs WHERE id = $1', [retired])).rows, [{ status: 'completed' }]);
    });
  });

  test('followDueJobs pads in-place waits past available_at so a 2 s busy-slot deferral completes without stranding on covered', async t => {
    const [{ nodeRuntime }, { drizzle }, { processJobs, followDueJobs, JobDeferred }, { enqueue }] = await Promise.all([
      import('./src/adapters/node.js'), import('drizzle-orm/node-postgres'), import('./src/jobs.js'), import('./src/jobs.js'),
    ]);
    const session = await fixtureDatabase(t);
    const instance = nodeRuntime({ DATABASE_URL: FIXTURE_DATABASE_URL, BETTER_AUTH_SECRET: AUTH_SECRET,
      PUBLIC_URL: PUBLIC_ORIGIN, DEFAULT_SES_REGION: REGION, ENABLE_LIVE_SES: 'false',
      S3_BUCKET: 'synthetic-simulator-fixture', S3_ACCESS_KEY_ID: 'synthetic-storage-id', S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret' });
    cleanup(t, instance.close);
    // Autocommit temp tables advance now()/clock_timestamp() across sleeps while remaining invisible to the harness runner.
    await session.query('CREATE TEMP TABLE jobs (LIKE public.jobs INCLUDING ALL); CREATE TEMP TABLE job_schedule (LIKE public.job_schedule INCLUDING ALL)');
    const scoped = { ...instance.runtime, db: drizzle(session) };
    const ws = unique('follow-due-workspace');
    let active = false, completed = 0, wakes = 0;
    const handlers: Record<string, import('./src/core.js').JobHandler> = {
      'mailbox.ingest': async () => {
        if (active) throw new JobDeferred(new Date(Date.now() + 2_000).toISOString());
        active = true;
        try { await new Promise(resolve => setTimeout(resolve, 40)); completed++; } finally { active = false; }
      },
    };
    const first = await enqueue(scoped.db, { type: 'mailbox.ingest', workspaceId: ws, payload: { n: 1 } });
    const second = await enqueue(scoped.db, { type: 'mailbox.ingest', workspaceId: ws, payload: { n: 2 } });
    const started = Date.now();
    const outcome = await followDueJobs(scoped, () => processJobs(scoped, handlers, 100, 2), async () => { wakes++; }, 10_000);
    const elapsed = Date.now() - started;
    assert.equal(outcome, 'idle');
    assert.equal(completed, 2);
    assert.equal(wakes, 0);
    assert.ok(elapsed >= 2_100, `Expected padded 2.15 s in-place wait; observed ${elapsed}ms.`);
    const { rows } = await session.query('SELECT id, status, attempts FROM jobs WHERE id = ANY($1) ORDER BY id', [[first, second]]);
    assert.deepEqual(rows.map(r => ({ status: r.status, attempts: r.attempts })), [{ status: 'completed', attempts: 1 }, { status: 'completed', attempts: 1 }]);
  });

  test('the pacing gate spaces slots evenly at the quota times the rate factor and brakes to the quota after throttling', async () => {
    const { initialGate, reserve, brake, shardRate } = await import('./src/dispatcher.js');
    const gate = initialGate();
    gate.quota = { maxSendRate: 20, max24HourSend: -1, sentLast24Hours: 0, checkedAt: Date.now() };
    const pacing = { rateFactor: 1.1, live: true } as const;
    assert.equal(shardRate(gate, undefined, pacing), 22);
    assert.equal(shardRate(gate, { index: 0, count: 4 }, pacing), 5.5, 'Shards split the target evenly.');
    assert.equal(shardRate(gate, undefined, { rateFactor: 1.1, targetRate: 30, live: true }), 30, 'An absolute live target replaces the quota-derived rate.');
    assert.equal(shardRate(gate, undefined, { rateFactor: 1.1, targetRate: 30, live: false }), 22, 'The absolute target never applies to simulated SES.');
    const started = Date.now();
    const waits = Array.from({ length: 44 }, () => reserve(gate, 1, undefined, pacing));
    assert.equal(waits[0], 0, 'The first slot is immediate.');
    // 44 slots at 22/s span two seconds; every slot is 1/22 s after the previous one.
    assert.ok(Math.abs(waits[43]! - 43 * Math.ceil(1000 / 22)) <= 50, `Expected the 44th slot about 1955 ms out, saw ${waits[43]} ms.`);
    for (let index = 1; index < waits.length; index++) assert.ok(waits[index]! - waits[index - 1]! >= 40 && waits[index]! - waits[index - 1]! <= 50, 'Slots are evenly spaced, never bunched into bursts.');
    brake(gate);
    assert.equal(shardRate(gate, undefined, pacing), 20, 'A throttled response drops the target back to the raw quota.');
    assert.ok(gate.nextAllowedAt >= started + 1000, 'Braking also yields the slots that ran ahead.');
    gate.brakeUntil = Date.now() - 1;
    assert.equal(shardRate(gate, undefined, pacing), 22, 'The brake releases after its window.');
  });

  test('transactional mail wins the next lease ahead of older non-campaign marketing', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db }) => {
      const { dispatchDue } = await import('./src/dispatcher.js');
      const contact = ok(await local('POST', '/v1/contacts', { email: address() }), 201);
      ok(await local('POST', `/v1/contacts/${contact.id}/consent`, { status: 'subscribed', source: 'fixture', policyVersion: 'v1', evidence: 'Synthetic fixture.', occurredAt: new Date().toISOString() }));
      const marketing = ok(await local('POST', '/v1/emails/send', mail({ to: contact.email, kind: 'marketing' })), 202);
      await db.query("UPDATE sending_emails SET created_at = now() - interval '1 hour' WHERE id = $1", [marketing.id]);
      const transactional = ok(await local('POST', '/v1/emails/send', mail()), 202);
      const future = ok(await local('POST', '/v1/emails/send', mail()), 202);
      await db.query("UPDATE sending_emails SET created_at=now()-interval '2 hours',scheduled_at=now()+interval '1 day' WHERE id=$1",[future.id]);
      await db.query("UPDATE sending_emails SET scheduled_at=now()-interval '1 second' WHERE id=$1",[transactional.id]);
      await dispatchDue(runtime, REGION, { batchSize: 1, until: Date.now() });
      const { rows } = await db.query('SELECT id, status FROM sending_emails WHERE id = ANY($1)', [[transactional.id, marketing.id, future.id]]);
      assert.deepEqual(Object.fromEntries(rows.map(r => [r.id, r.status])), { [transactional.id]: 'accepted', [marketing.id]: 'queued', [future.id]:'queued' });
    });
  });

  test('a transactional admission borrows one slot from an already leased campaign', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db, run }) => {
      const { runDispatcher, dispatchWakeKey } = await import('./src/dispatcher.js');
      const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
      const list = ok(await local('POST', '/v1/lists', { name: unique('priority') }), 201);
      await db.query(`WITH contacts AS (INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent)
        SELECT gen_random_uuid()::text,$1,'priority-'||n||'@example.net','subscribed' FROM generate_series(1,24)n RETURNING *)
        INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT workspace_id,$2,id FROM contacts`, [runtime.config.workspaceId,list.id]);
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('priority'), from: 'sender@example.com', subject: 'Campaign', html: '<p>Fixture</p>', audience: { listId: list.id } }), 201);
      ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision }), 202);
      runtime.config.simulatedSes.maxSendRate = 6;
      await run('campaign.run');
      const priorityWake = new EventTarget();
      let admitted = 0;
      runtime.dispatch = async (region, account, _count, _kind, priority) => {
        if (priority) { admitted = Date.now(); priorityWake.dispatchEvent(new Event(dispatchWakeKey(region, account))); }
      };
      const calls: { id: string; at: number }[] = [];
      let started!: () => void;
      const first = new Promise<void>(resolve => { started = resolve; });
      const send = SESv2Client.prototype.send;
      t.mock.method(SESv2Client.prototype, 'send', function(this: InstanceType<typeof SESv2Client>, cmd: any) {
        if (cmd instanceof SendEmailCommand) { calls.push({ id: cmd.input.EmailTags!.find(t => t.Name === 'opensend_email_id')!.Value!, at: Date.now() }); started(); }
        return Reflect.apply(send, this, [cmd]);
      });
      // The budget stops new normal leases; it must not disable hints while the last batch drains.
      const dbExecute = runtime.db.execute.bind(runtime.db);
      const leaseSizes: number[] = [];
      t.mock.method(runtime.db, 'execute', async (...args: Parameters<typeof dbExecute>) => {
        const result = await dbExecute(...args);
        if (result.rows.length === 24 && result.rows[0]?.campaignId === campaign.id) {
          leaseSizes.push(result.rows.filter(r => r.review_draft && r.review_rendered).length);
        }
        return result;
      });
      const draining = runDispatcher(runtime, { region: REGION, priorityWake, lanes: 1, until: Date.now() });
      await first;
      let receipt: Json;
      try {
        assert.ok((await db.query("SELECT 1 FROM sending_emails WHERE campaign_id=$1 AND lease_until IS NOT NULL", [campaign.id])).rowCount);
        receipt = ok(await local('POST', '/v1/emails/send', mail()), 202);
      } finally { await draining; }
      const next = calls.find(c => c.at >= admitted)!;
      assert.ok(admitted > 0); assert.equal(next.id, receipt.id, 'Already-leased marketing must not own future slots.');
      assert.ok(next.at - calls[0]!.at < 140, 'Priority should start before the next normal slot.');
      assert.ok(calls[2]!.at - calls[0]!.at >= 290, 'The next marketing send repays the borrowed slot.');
      assert.equal(calls.length, 25);
      assert.deepEqual(leaseSizes, [1], 'All 24 campaign emails materialize from one returned review.');
    });
  });

  test('a low-rate shard returns queued work instead of holding attempts behind a 50-recipient envelope', async t => {
    await simulatedSesFixture(t, async ({runtime,local,db}) => {
      const {dispatchDue,initialGate}=await import('./src/dispatcher.js');
      runtime.config.simulatedSes.maxSendRate=1;
      const big=ok(await local('POST','/v1/emails/send',mail({to:Array.from({length:50},(_,i)=>`bulk-${i}@example.net`)})),202);
      await db.query("UPDATE sending_emails SET created_at=now()-interval '1 hour' WHERE id=$1",[big.id]);
      const next=ok(await local('POST','/v1/emails/send',mail()),202);
      const gate=initialGate(), started=Date.now();
      const r=await dispatchDue(runtime,REGION,{gate,shard:{index:0,count:4}});
      assert.equal(r.sent,1); assert.ok(Date.now()-started<4000); assert.ok(r.paceRetryAt!-Date.now()>190_000);
      assert.deepEqual((await db.query('SELECT status,attempt_started_at,lease_until FROM sending_emails WHERE id=$1',[next.id])).rows,[{status:'queued',attempt_started_at:null,lease_until:null}]);
      assert.equal((await db.query("SELECT 1 FROM sending_email_events WHERE email_id=$1 AND type='dispatch_attempt'",[next.id])).rowCount,0);
      assert.equal((await dispatchDue(runtime,REGION,{gate,shard:{index:0,count:4}})).claimed,0);
      assert.equal((await dispatchDue(runtime,REGION,{shard:{index:1,count:4}})).sent,1);

      // Now make the distant slot *unpredictable* at claim time: a 50-recipient transactional
      // admission preempts an already-attempting marketing sibling on a six-recipient/s gate.
      await db.query('UPDATE sending_region_limits SET max_send_rate=6 WHERE workspace_id=$1 AND region=$2',[runtime.config.workspaceId,REGION]);
      const contact=ok(await local('POST','/v1/contacts',{email:address()}),201);
      ok(await local('POST',`/v1/contacts/${contact.id}/consent`,{status:'subscribed',source:'fixture',policyVersion:'v1',evidence:'Fixture',occurredAt:new Date().toISOString()}));
      ok(await local('POST','/v1/emails/batch',{emails:[1,2].map(()=>mail({to:contact.email,kind:'marketing'}))}),202);
      const {SESv2Client,SendEmailCommand}=await import('@aws-sdk/client-sesv2'), orig=SESv2Client.prototype.send;
      const {dispatchWakeKey}=await import('./src/dispatcher.js'), priorityWake=new EventTarget();
      runtime.dispatch=async (region,account,_count,_kind,priority)=>{if(priority)priorityWake.dispatchEvent(new Event(dispatchWakeKey(region,account)));};
      let startedSend!:()=>void; const first=new Promise<void>(r=>{startedSend=r;});
      t.mock.method(SESv2Client.prototype,'send',function(this:InstanceType<typeof SESv2Client>,cmd:any){if(cmd instanceof SendEmailCommand)startedSend(); return Reflect.apply(orig,this,[cmd]);});
      const draining=dispatchDue(runtime,REGION,{priorityWake}); await first;
      try { ok(await local('POST','/v1/emails/send',mail({to:Array.from({length:50},(_,i)=>`priority-${i}@example.net`)})),202); }
      finally { await draining; }
      assert.equal((await draining).sent,2);
      assert.equal((await db.query(`SELECT e.id FROM sending_emails e JOIN sending_email_events v ON v.email_id=e.id
        WHERE e.workspace_id=$1 AND e.status='queued' AND e.attempt_started_at IS NULL AND v.type='dispatch_deferred' AND v.data->>'providerCalled'='false'`,[runtime.config.workspaceId])).rowCount,1);
    });
  });

  test('a definitive daily denial and a known uncalled sibling survive an interrupted-attempt sweep', async t => {
    await simulatedSesFixture(t,async({runtime,local,db,run})=>{
      const {dispatchDue}=await import('./src/dispatcher.js'), {dispatchPartitions}=await import('./src/dispatch.js');
      const {SESv2Client,SendEmailCommand}=await import('@aws-sdk/client-sesv2');
      runtime.config.simulatedSes.maxSendRate=4;
      const list=ok(await local('POST','/v1/lists',{name:unique('late-denial')}),201);
      await db.query(`WITH contacts AS (INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) SELECT gen_random_uuid()::text,$1,'late-'||n||'@example.net','subscribed' FROM generate_series(1,2)n RETURNING *)
        INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT workspace_id,$2,id FROM contacts`,[runtime.config.workspaceId,list.id]);
      const c=ok(await local('POST','/v1/campaigns',{name:unique('late-denial'),from:'sender@example.com',subject:'Fixture',html:'<p>Fixture</p>',audience:{listId:list.id}}),201);
      ok(await local('POST',`/v1/campaigns/${c.id}/send`,{revision:c.revision}),202); await run('campaign.run');
      const orig=SESv2Client.prototype.send; let calls=0;
      const provider=t.mock.method(SESv2Client.prototype,'send',async function(this:InstanceType<typeof SESv2Client>,cmd:any){
        if (!(cmd instanceof SendEmailCommand)) return Reflect.apply(orig,this,[cmd]);
        calls++;
        await db.query("UPDATE sending_emails SET attempt_started_at=now()-interval '4 minutes' WHERE campaign_id=$1 AND status='attempting'",[c.id]);
        await dispatchPartitions(runtime,true);
        assert.equal((await db.query('SELECT state FROM sending_campaigns WHERE id=$1',[c.id])).rows[0].state,'done');
        throw Object.assign(new Error('Daily message quota exceeded.'),{$metadata:{httpStatusCode:429}});
      });
      const held=await dispatchDue(runtime,REGION);
      assert.equal(calls,1); assert.equal(held.deferred,2);
      assert.equal((await db.query("SELECT id FROM sending_emails WHERE campaign_id=$1 AND status='queued' AND dispatch_version=1 AND attempt_started_at IS NULL",[c.id])).rowCount,2);
      assert.equal((await db.query('SELECT state FROM sending_campaigns WHERE id=$1',[c.id])).rows[0].state,'sending');
      provider.mock.restore(); await db.query('UPDATE sending_emails SET scheduled_at=clock_timestamp() WHERE campaign_id=$1',[c.id]);
      assert.equal((await dispatchDue(runtime,REGION)).sent,2);
      assert.equal((await db.query('SELECT state FROM sending_campaigns WHERE id=$1',[c.id])).rows[0].state,'done');
    });
  });

  test('a host ahead of Postgres cannot refill a spent daily sample or spin quota alarms', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db }) => {
      const { dispatchDue, initialGate } = await import('./src/dispatcher.js');
      ok(await local('POST', '/v1/emails/send', mail()), 202);
      const { rows: [sample] } = await db.query(`INSERT INTO sending_region_limits(workspace_id,region,max_send_rate,max_24_hour_send,sent_last_24_hours,checked_at)
        VALUES($1,$2,100,100,99,clock_timestamp()) ON CONFLICT(workspace_id,region) DO UPDATE SET max_send_rate=100,max_24_hour_send=100,sent_last_24_hours=99,checked_at=clock_timestamp() RETURNING checked_at`,[runtime.config.workspaceId,REGION]);
      const gate = initialGate(); gate.quota = { maxSendRate:100,max24HourSend:100,sentLast24Hours:99,checkedAt:sample.checked_at.getTime() }; gate.sentSinceRefresh=1;
      const now=Date.now.bind(Date); t.mock.method(Date,'now',() => now()+300_000);
      for (let i=0; i<2; i++) {
        gate.refreshAt=0; // A restarted host reads the *same* still-fresh database snapshot.
        const report=await dispatchDue(runtime,REGION,{gate});
        assert.equal(report.sent,0); assert.equal(gate.sentSinceRefresh,1); assert.ok(report.quotaRetryAt! - Date.now() > 50_000);
      }
    });
  });

  test('a stale quota refresh follows transactional acceptance except near the daily reserve', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db }) => {
      const { dispatchDue, initialGate } = await import('./src/dispatcher.js');
      const { SESv2Client, GetAccountCommand } = await import('@aws-sdk/client-sesv2');
      const send = SESv2Client.prototype.send, visible: boolean[] = []; let pending: string, peer = false;
      t.mock.method(SESv2Client.prototype,'send',async function(this: InstanceType<typeof SESv2Client>, cmd: any) {
        if (cmd instanceof GetAccountCommand) visible.push(!!(await db.query('SELECT provider_id FROM sending_emails WHERE id=$1',[pending])).rows[0].provider_id);
        else if (peer) await db.query('UPDATE sending_region_limits SET checked_at=clock_timestamp(),next_allowed_at=NULL WHERE workspace_id=$1 AND region=$2',[runtime.config.workspaceId,REGION]);
        return Reflect.apply(send,this,[cmd]);
      });
      for (const used of [0,899]) {
        pending = ok(await local('POST','/v1/emails/send',mail()),202).id;
        await db.query(`INSERT INTO sending_region_limits(workspace_id,region,max_send_rate,max_24_hour_send,sent_last_24_hours,checked_at)
          VALUES($1,$2,100,1000,$3,clock_timestamp()-interval '2 minutes') ON CONFLICT(workspace_id,region) DO UPDATE SET
          max_24_hour_send=1000,sent_last_24_hours=excluded.sent_last_24_hours,checked_at=excluded.checked_at,next_allowed_at=NULL`,[runtime.config.workspaceId,REGION,used]);
        assert.equal((await dispatchDue(runtime,REGION)).sent,1);
      }
      assert.deepEqual(visible,[true,false]);
      // A peer owns the refresh fence and does not publish its sample until our send starts.
      // No quota polling on the critical path, no duplicate GetAccount, and no refilled credit.
      peer=true; const gate=initialGate();
      pending=ok(await local('POST','/v1/emails/send',mail()),202).id;
      await db.query(`UPDATE sending_region_limits SET max_24_hour_send=1000,sent_last_24_hours=0,checked_at=clock_timestamp()-interval '2 minutes',next_allowed_at=clock_timestamp()+interval '1 minute' WHERE workspace_id=$1 AND region=$2`,[runtime.config.workspaceId,REGION]);
      assert.equal((await dispatchDue(runtime,REGION,{gate})).sent,1); assert.equal(gate.sentSinceRefresh,1);
      assert.deepEqual(visible,[true,false]);
    });
  });

  test('a fast provider ID is visible while its claimed sibling is still waiting for SES', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db }) => {
      const { dispatchDue } = await import('./src/dispatcher.js');
      const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
      const fast = ok(await local('POST','/v1/emails/send',mail()),202).id;
      const slow = ok(await local('POST','/v1/emails/send',mail()),202).id;
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(r => { enter = r; }), pending = new Promise<void>(r => { release = r; });
      const send = SESv2Client.prototype.send;
      t.mock.method(SESv2Client.prototype,'send',async function(this: InstanceType<typeof SESv2Client>, cmd: any) {
        if (cmd instanceof SendEmailCommand && cmd.input.EmailTags?.some(tag => tag.Value === slow)) { enter(); await pending; }
        return Reflect.apply(send,this,[cmd]);
      });
      const draining = dispatchDue(runtime,REGION);
      try {
        await entered;
        for (const deadline=Date.now()+1000; ; ) {
          const row=(await db.query('SELECT provider_id FROM sending_emails WHERE id=$1',[fast])).rows[0];
          if (row.provider_id) break;
          assert.ok(Date.now()<deadline,'An outstanding SES call must not delay a completed result.');
          await new Promise(r => setTimeout(r,5));
        }
        assert.equal((await db.query('SELECT status FROM sending_emails WHERE id=$1',[slow])).rows[0].status,'attempting');
      } finally { release(); await draining; }
      assert.equal((await draining).sent,2);
    });
  });

  test('an elected post-send refresh with lagging SES usage cannot clear a daily denial', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db }) => {
      const { dispatchDue, initialGate } = await import('./src/dispatcher.js');
      const { SESv2Client, GetAccountCommand } = await import('@aws-sdk/client-sesv2');
      const contact = ok(await local('POST','/v1/contacts',{email:address()}),201);
      ok(await local('POST',`/v1/contacts/${contact.id}/consent`,{status:'subscribed',source:'fixture',policyVersion:'v1',evidence:'Fixture',occurredAt:new Date().toISOString()}));
      const marketing = ok(await local('POST','/v1/emails/send',mail({to:contact.email,kind:'marketing'})),202).id;
      const tx = ok(await local('POST','/v1/emails/send',mail()),202).id;
      await db.query(`INSERT INTO sending_region_limits(workspace_id,region,max_send_rate,max_24_hour_send,sent_last_24_hours,checked_at)
        VALUES($1,$2,1000,1000,0,clock_timestamp()-interval '90 seconds') ON CONFLICT(workspace_id,region) DO UPDATE SET
        max_send_rate=1000,max_24_hour_send=1000,sent_last_24_hours=0,checked_at=excluded.checked_at,next_allowed_at=NULL`,[runtime.config.workspaceId,REGION]);
      const calls: string[] = [];
      t.mock.method(SESv2Client.prototype,'send',async (cmd:any) => {
        if (cmd instanceof GetAccountCommand) { calls.push('quota'); return { SendingEnabled:true,SendQuota:{MaxSendRate:1000,Max24HourSend:1000,SentLast24Hours:0} }; }
        const id = cmd.input.EmailTags.find((t:any)=>t.Name==='opensend_email_id').Value; calls.push(id);
        if (id===tx) throw Object.assign(new Error('Daily message quota exceeded.'),{$metadata:{httpStatusCode:429}});
        return {MessageId:'unexpected-marketing'};
      });
      const gate=initialGate(), start=Date.now(), report=await dispatchDue(runtime,REGION,{gate});
      assert.deepEqual(calls,[tx,'quota']); assert.equal(report.sent,0); assert.equal(gate.sentSinceRefresh,1);
      assert.ok(gate.dailyBlockedUntil! >= start+60_000); assert.ok(report.quotaRetryAt! >= gate.dailyBlockedUntil!);
      const { rows:[denied] } = await db.query('SELECT status,error_code,scheduled_at FROM sending_emails WHERE id=$1',[tx]);
      assert.equal(denied.status,'queued'); assert.equal(denied.error_code,'SES_DAILY_QUOTA_EXHAUSTED'); assert.ok(denied.scheduled_at.getTime() >= start+59_900);
      assert.deepEqual((await db.query('SELECT status,attempt_started_at,lease_until FROM sending_emails WHERE id=$1',[marketing])).rows,[{status:'queued',attempt_started_at:null,lease_until:null}]);
      assert.equal((await dispatchDue(runtime,REGION,{gate})).sent,0); assert.deepEqual(calls,[tx,'quota']);
    });
  });

  test('MX shard leases wait for fresh quota before claiming against old or thin daily headroom', async t => {
    await simulatedSesFixture(t, async ({runtime, local, db}) => {
      const { dispatchDue } = await import('./src/dispatcher.js');
      const { SESv2Client, GetAccountCommand } = await import('@aws-sdk/client-sesv2');
      const ws=runtime.config.workspaceId, accountId='111122223333';
      const ids=[ok(await local('POST','/v1/emails/send',mail()),202).id,ok(await local('POST','/v1/emails/send',mail()),202).id];
      runtime.config.multiTenant=true;
      await db.query(`INSERT INTO provider_pool_regions(region,aws_account_id,sending_state,feedback_topic_arn) VALUES($1,$2,'ready',$3)`,[REGION,accountId,`arn:aws:sns:${REGION}:${accountId}:fixture`]);
      await db.query(`INSERT INTO provider_connections(id,workspace_id,kind,state,region,aws_account_id,tenant_state) VALUES($1,$1,'shared','ready',$2,$3,'ready')`,[ws,REGION,accountId]);
      await db.query(`INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state) VALUES('example.com',$1,$1,'verified')`,[ws]);
      let reads=0,sends=0;
      t.mock.method(SESv2Client.prototype,'send',async(cmd:any) => {
        if (!(cmd instanceof GetAccountCommand)) { sends++; return {MessageId:unique('unexpected')}; }
        reads++; return {SendingEnabled:true,SendQuota:{MaxSendRate:1000,Max24HourSend:1000,SentLast24Hours:1000}};
      });
      for (const [ageSeconds,used] of [[90,800],[3600,0]]) for (const batchSize of [1,2]) {
        // 100 credits above reserve would pass the old per-shard 51-credit threshold. The
        // other case has abundant credits but is an hour old. Neither can authorize an attempt.
        await db.query(`INSERT INTO provider_account_limits(aws_account_id,region,max_send_rate,max_24_hour_send,sent_last_24_hours,checked_at,refresh_after)
          VALUES($1,$2,1000,1000,$3,clock_timestamp()-$4::int*interval '1 second','-infinity') ON CONFLICT(aws_account_id,region) DO UPDATE SET
          sent_last_24_hours=excluded.sent_last_24_hours,checked_at=excluded.checked_at,refresh_after=excluded.refresh_after`,[accountId,REGION,used,ageSeconds]);
        const before=reads;
        await Promise.all([0,1].map(index=>dispatchDue(runtime,REGION,{accountId,batchSize,lanes:1,shard:{index,count:4}})));
        assert.equal(reads-before,1); assert.equal(sends,0);
        assert.equal((await db.query("SELECT id FROM sending_emails WHERE id=ANY($1) AND status='queued' AND attempt_started_at IS NULL AND lease_until IS NULL",[ids])).rowCount,2);
        assert.equal((await db.query("SELECT id FROM sending_email_events WHERE email_id=ANY($1) AND type='dispatch_attempt'",[ids])).rowCount,0);
      }
    });
  });

  test('exhausted shard gives marketing back immediately and any shard can take the last shared credit once', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db }) => {
      const { dispatchDue } = await import('./src/dispatcher.js'), ws=runtime.config.workspaceId;
      const contact=ok(await local('POST','/v1/contacts',{email:address()}),201);
      ok(await local('POST',`/v1/contacts/${contact.id}/consent`,{status:'subscribed',source:'fixture',policyVersion:'v1',evidence:'Fixture',occurredAt:new Date().toISOString()}));
      ok(await local('POST','/v1/emails/batch',{emails:Array.from({length:9},()=>mail({to:contact.email,kind:'marketing'}))}),202);
      await db.query(`INSERT INTO sending_region_limits(workspace_id,region,max_send_rate,max_24_hour_send,sent_last_24_hours,checked_at) VALUES($1,$2,1000,100,82,clock_timestamp())
        ON CONFLICT(workspace_id,region) DO UPDATE SET max_send_rate=1000,max_24_hour_send=100,sent_last_24_hours=82,checked_at=clock_timestamp()`,[ws,REGION]);
      const drain=(index:number)=>dispatchDue(runtime,REGION,{shard:{index,count:4}});
      assert.equal((await drain(3)).sent,2);
      assert.equal((await db.query("SELECT id FROM sending_emails WHERE workspace_id=$1 AND status='queued' AND lease_until IS NULL",[ws])).rowCount,7);
      assert.equal((await drain(0)).sent,2,'Sibling can lease immediately.');
      await db.query('UPDATE sending_region_limits SET sent_last_24_hours=89,checked_at=clock_timestamp() WHERE workspace_id=$1',[ws]);
      assert.equal((await drain(3)).sent,1,'Sharding must not round a positive global remainder to zero.');
      assert.equal((await drain(2)).sent,0,'A separate cold shard cannot spend the same last credit twice.');
    });
  });

  test('rolling daily headroom holds a sending campaign, admits transactional recipients and drains after quota refresh', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db, run }) => {
      const { dispatchDue, initialGate } = await import('./src/dispatcher.js');
      const { SESv2Client, GetAccountCommand } = await import('@aws-sdk/client-sesv2');
      const gate = initialGate(), opts = { gate, lanes: 2, batchSize: 6, quotaRefreshMs: 650 };
      const list = ok(await local('POST', '/v1/lists', { name: unique('rolling-quota') }), 201);
      await db.query(`WITH contacts AS (INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent)
        SELECT gen_random_uuid()::text,$1,'rolling-'||n||'@example.net','subscribed' FROM generate_series(1,15)n RETURNING *)
        INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT workspace_id,$2,id FROM contacts`, [runtime.config.workspaceId,list.id]);
      const c = ok(await local('POST', '/v1/campaigns', { name: unique('rolling-quota'), from: 'sender@example.com', subject: 'Quota fixture', html: '<p>Fixture</p>', audience: { listId: list.id } }), 201);
      ok(await local('POST', `/v1/campaigns/${c.id}/send`, { revision: c.revision }), 202);
      await run('campaign.run');
      let used = 87, reads = 0, calls = 0, deny = false;
      const send = SESv2Client.prototype.send;
      t.mock.method(SESv2Client.prototype, 'send', function(this: InstanceType<typeof SESv2Client>, cmd: any) {
        if (cmd instanceof GetAccountCommand) { reads++; return { SendingEnabled: true, SendQuota: { Max24HourSend: 100, SentLast24Hours: used, MaxSendRate: 1000 } }; }
        calls++;
        if (deny) throw Object.assign(new Error('Daily message quota exceeded.'), { name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } });
        return Reflect.apply(send, this, [cmd]);
      });
      const drain = () => dispatchDue(runtime, REGION, opts), view = async () => ok(await local('GET', `/v1/campaigns/${c.id}`));
      // Expansion ran with ample capacity. The next sample seen at dispatch reflects later account use.
      await db.query("UPDATE sending_region_limits SET checked_at=clock_timestamp()-interval '2 minutes' WHERE workspace_id=$1 AND region=$2",[runtime.config.workspaceId,REGION]);
      const hold = await drain();
      assert.equal(hold.sent, 3, 'Concurrent lanes together leave the last ten recipients unused by marketing.');
      assert.ok(hold.quotaRetryAt! > Date.now()); assert.equal((await view()).state, 'sending');
      const tx = ok(await local('POST', '/v1/emails/send', mail({ to: [address(), address()] })), 202);
      assert.equal((await drain()).sent, 1);
      assert.equal((await db.query('SELECT status FROM sending_emails WHERE id=$1', [tx.id])).rows[0].status, 'accepted');
      assert.equal(gate.sentSinceRefresh, 5); assert.equal((await view()).counts.byStatus.queued, 12);
      assert.deepEqual([reads,calls],[1,4], 'Only the cached refresh and the affordable sends reach SES.');
      // SES may report exhaustion before the cache reflects other senders. It is a retryable
      // daily hold, not the five-attempt rate error or a campaign failure.
      deny = true;
      const later = ok(await local('POST', '/v1/emails/send', mail()), 202);
      await drain(); await drain();
      assert.deepEqual([reads,calls],[1,5]);
      const row = (await db.query('SELECT status,error_code,scheduled_at FROM sending_emails WHERE id=$1',[later.id])).rows[0];
      assert.equal(row.status,'queued'); assert.equal(row.error_code,'SES_DAILY_QUOTA_EXHAUSTED');
      used = 100; deny = false;
      await new Promise(r => setTimeout(r, Math.max(0, new Date(row.scheduled_at).getTime() - Date.now()) + 5));
      const exhausted = await drain(); assert.equal(exhausted.sent,0); assert.deepEqual([reads,calls],[2,5]);
      await drain(); assert.deepEqual([reads,calls],[2,5], 'No GetAccount or SendEmail loop during a daily hold.');
      assert.equal((await view()).state,'sending');
      used = 20;
      await new Promise(r => setTimeout(r, Math.max(0, exhausted.quotaRetryAt! - Date.now()) + 5));
      assert.equal((await drain()).sent,13);
      const final = await view(); assert.equal(final.state,'done'); assert.equal(final.counts.byStatus.accepted,15); assert.equal(final.counts.total,15);
      assert.deepEqual((await db.query('SELECT status,error_code FROM sending_emails WHERE id=$1',[later.id])).rows,[{status:'accepted',error_code:null}]);
      assert.equal(reads,3,'Capacity returns through the normal quota refresh; no resume or provider retry storm.');
    });
  });

  test('SDK responses preserve acceptance, rejection, throttling and timeout semantics without network', async t => {
    const [{ SESv2Client, SendEmailCommand, GetAccountCommand }, { createSimulatedSesHandler }] = await Promise.all([
      import('@aws-sdk/client-sesv2'), import('./src/adapters/simulated-ses.js'),
    ]);
    const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Simulated SDK transport must not access the network.'); });
    const client = new SESv2Client({ region: REGION, endpoint: 'https://ses-simulator.invalid', maxAttempts: 1,
      credentials: { accessKeyId: 'SYNTHETIC_ACCESS_KEY', secretAccessKey: 'synthetic-secret-not-an-aws-credential' },
      requestHandler: createSimulatedSesHandler({ latencyMs: 0, maxSendRate: 23, outcomes: ['accept', 'reject', 'throttle', 'timeout'] }),
    });
    cleanup(t, async () => { client.destroy(); });
    assert.equal((await client.send(new GetAccountCommand({}))).SendQuota?.MaxSendRate, 23);
    const command = () => new SendEmailCommand({ FromEmailAddress: 'sender@example.com', Destination: { ToAddresses: [address()] },
      Content: { Simple: { Subject: { Data: 'Synthetic SDK acceptance' }, Body: { Text: { Data: 'No network or real delivery.' } } } } });
    assert.match((await client.send(command())).MessageId!, /^sim_/);
    for (const [name, status] of [['MessageRejected', 400], ['TooManyRequestsException', 429], ['TimeoutError', undefined]] as const) {
      await assert.rejects(client.send(command()), (cause: any) => {
        assert.equal(cause.name, name);
        assert.equal(cause.$metadata?.httpStatusCode, status);
        assert.equal(cause.$metadata?.attempts, 1, 'The SDK must not silently retry provider outcomes.');
        return true;
      });
    }
    await assert.rejects(createSimulatedSesHandler({ latencyMs: 0 }).handle({ protocol: 'https:', hostname: `email.${REGION}.amazonaws.com`, method: 'POST', path: '/v2/email/outbound-emails', headers: {}, query: {} }), /Unsupported simulated SES endpoint/);
    assert.equal(network.mock.callCount(), 0);
  });

  test('test email and automatic campaign follow accepted → delivered through durable feedback', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const email = ok(await local('POST', '/v1/emails/send', mail()), 202);
      assert.equal(email.simulated, true);
      await run('email.dispatch');
      const accepted = ok(await local('GET', `/v1/emails/${email.id}`));
      assert.equal(accepted.status, 'accepted');
      assert.match(accepted.providerId, /^sim_/);
      const feedback = await jobs('operation.simulatedFeedback');
      assert.deepEqual((await db.query('SELECT type, data FROM operation_events WHERE workspace_id = $1', [runtime.config.workspaceId])).rows, [{ type: 'email.sent', data: { emailId: email.id, providerId: accepted.providerId, simulated: true } }], 'Acceptance publishes exactly one email.sent without waiting for feedback.');
      assert.deepEqual(feedback.map(job => job.payload.message.eventType), ['Send', 'Delivery']);
      assert.equal(new Date(feedback[1]!.available_at).getTime() - new Date(feedback[0]!.available_at).getTime(), 250);
      await run('operation.simulatedFeedback');
      assert.equal(ok(await local('GET', `/v1/emails/${email.id}`)).status, 'delivered');
      const observed = page(await local('GET', `/v1/emails/${email.id}/events`));
      for (const type of ['accepted', 'send', 'delivery']) assert.equal(observed.filter(event => event.type === type).length, 1);
      assert.ok(observed.every(event => event.environment === undefined && event.simulated));
      assert.equal((await jobs('operation.publish')).length, 0);
      assert.equal((await jobs('operation.webhook')).length, 0, 'Zero subscribers must enqueue zero publication work.');
      assert.equal((await db.query('SELECT count(*)::int AS count FROM operation_events WHERE workspace_id = $1', [runtime.config.workspaceId])).rows[0].count, 2, 'Public events must already be persisted without a publication job.');

      const list = ok(await local('POST', '/v1/lists', { name: unique('simulated-campaign') }), 201);
      const contact = ok(await local('POST', '/v1/contacts', { email: address() }), 201);
      ok(await local('POST', `/v1/contacts/${contact.id}/consent`, { status: 'subscribed', source: 'acceptance-fixture', policyVersion: 'v1', evidence: 'Synthetic reserved-domain fixture.', occurredAt: new Date().toISOString() }));
      ok(await local('POST', `/v1/lists/${list.id}/members`, { contactIds: [contact.id] }));
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('simulated-campaign'), from: 'sender@example.com', subject: 'Static synthetic campaign', html: '<p>No real email.</p>', audience: { listId: list.id } }), 201);
      assert.equal(ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision }), 202).queued, 1);
      // One run prepares, moves to sending and releases the recipient; the dispatcher finishes the campaign inline.
      await run('campaign.run');
      const released = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(released.state, 'sending');
      assert.deepEqual([released.delivery.prepared, released.delivery.expanded], [1, 1]);
      assert.equal((await jobs('campaign.run')).filter(job => job.status === 'pending').length, 0, 'A released campaign needs no further run.');
      await run('email.dispatch');
      const [campaignEmail] = page(await local('GET', `/v1/emails?campaignId=${campaign.id}`));
      assert.equal(campaignEmail!.status, 'accepted');
      assert.match(campaignEmail!.providerId, /^sim_/);
      assert.equal(ok(await local('GET', `/v1/campaigns/${campaign.id}`)).state, 'done', 'The last row leaving the queue completes the campaign in the same statement.');
      await run('operation.simulatedFeedback');
      const completed = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(completed.state, 'done');
      assert.equal(completed.counts.byStatus.delivered, 1);

      error(await local('POST', '/v1/emails/send', { from: 'sender@example.com', to: address(), region: REGION, template: { name: 'not-rendered-by-simulator', data: {} } }), 422, 'SIMULATED_TEMPLATE_UNSUPPORTED');
    });
  });

  for (const simulated of [true, false]) test(`campaign expansion rejects a worker mode change after ${simulated ? 'simulated' : 'real-SES'} launch`, async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db, run }) => {
      // Provision only a synthetic discovery record; this scenario must never call a provider.
      runtime.config.aws = { accessKeyId: 'fixture', secretAccessKey: 'fixture' };
      const { credentialFingerprint, discoveryTarget } = await import('./src/ses-region-state.js');
      const topic = `arn:aws:sns:${REGION}:111122223333:fixture`;
      await db.query(`INSERT INTO ses_region_discovery(workspace_id,region,report,credentials_fingerprint,public_url,trusted_account_id,trusted_topic_arn)
        VALUES($1,$2,$3,$4,$5,'111122223333',$6)`, [runtime.config.workspaceId, REGION, {provisioned:true, account:{id:'111122223333',sendingEnabled:true}, resources:{topic:{arn:topic}, marketing:{sendingEnabled:true}}}, await credentialFingerprint(runtime.config), discoveryTarget(runtime.config), topic]);
      const list = ok(await local('POST', '/v1/lists', { name: unique('mode-fence') }), 201);
      const contact = ok(await local('POST', '/v1/contacts', { email: address() }), 201);
      ok(await local('POST', `/v1/contacts/${contact.id}/consent`, {status:'subscribed', source:'fixture'}));
      ok(await local('POST', `/v1/lists/${list.id}/members`, { contactIds: [contact.id] }));
      runtime.config.liveEnabled = !simulated;
      const campaign = ok(await local('POST', '/v1/campaigns', {name: unique('mode-fence'), from:'sender@example.com', subject:'Fixture', html:'<p>Fixture</p>', audience:{listId:list.id}}), 201);
      const path = `/v1/campaigns/${campaign.id}`, revision = campaign.revision;
      assert.equal(ok(await local('POST', `${path}/send`, {revision}), 202).simulated, simulated);
      runtime.config.liveEnabled = simulated;
      await run('campaign.run');
      const result = ok(await local('GET', path));
      assert.equal(result.state, 'failed');
      assert.equal(result.delivery.error.code, 'SES_MODE_CHANGED');
      assert.equal(result.delivery.prepared, 0); assert.equal(result.delivery.expanded, 0); assert.equal(result.counts.total, 0);
    });
  });

  test('duplicate/out-of-order simulated feedback fans out once and cannot impersonate public SNS feedback', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const { operationJobs } = await import('./src/operations.js');
      const email = ok(await local('POST', '/v1/emails/send', mail()), 202);
      const otherRegion = REGION === 'eu-west-1' ? 'us-west-2' : 'eu-west-1';
      ok(await local('PUT', `/v1/regions/${otherRegion}`, { enabled: true }, 'live'));
      const matching: string[] = [];
      for (const options of [{}, {}, { paused: true }, { eventTypes: ['email.bounced'] }, { regions: [otherRegion] }]) {
        const endpoint = ok(await local('POST', '/v1/webhooks', { url: `https://example.com/${unique('synthetic-hook')}`, ...options }), 201);
        if (!Object.keys(options).length) matching.push(endpoint.id);
      }
      const liveEndpoint = ok(await local('POST', '/v1/webhooks', { url: `https://example.com/${unique('live-hook')}` }, 'live'), 201);
      await run('email.dispatch');
      const feedback = await jobs('operation.simulatedFeedback');
      const deliver = feedback.find(job => job.payload.message.eventType === 'Delivery')!;
      const send = feedback.find(job => job.payload.message.eventType === 'Send')!;
      const context = (job: Json) => ({ id: job.id, attempts: 1, workspaceId: runtime.config.workspaceId });
      for (const job of [deliver, deliver, send, send]) await operationJobs['operation.simulatedFeedback']!(runtime, job.payload, context(job));
      const { recordEmailEvent } = await import('./src/sending.js');
      assert.equal(await recordEmailEvent(runtime, { workspaceId: runtime.config.workspaceId, emailId: email.id, type: 'delivery', providerId: deliver.payload.message.mail.messageId, externalId: `${deliver.payload.topicArn}:${deliver.payload.messageId}` }), null, 'Replaying the same external event must not fan out again even without the receipt guard.');
      assert.equal(ok(await local('GET', `/v1/emails/${email.id}`)).status, 'delivered', 'Late Send feedback must not regress Delivery.');
      assert.equal(page(await local('GET', `/v1/emails/${email.id}/events`)).filter(event => ['send', 'delivery'].includes(event.type)).length, 2);
      const published = (await db.query('SELECT * FROM operation_events WHERE workspace_id = $1', [runtime.config.workspaceId])).rows;
      assert.deepEqual(published.map(event => event.type).sort(), ['email.delivered', 'email.sent']);
      const deliveries = (await db.query('SELECT * FROM operation_deliveries WHERE workspace_id = $1', [runtime.config.workspaceId])).rows;
      assert.equal(deliveries.length, 6);
      assert.ok(deliveries.every(delivery => [...matching, liveEndpoint.id].includes(delivery.webhook_id) && delivery.payload.data.simulated === true));
      assert.equal(new Set(deliveries.map(delivery => `${delivery.webhook_id}:${delivery.event_id}`)).size, 6);
      assert.equal((await jobs('operation.webhook')).length, 6);
      assert.equal((await jobs('operation.publish')).length, 0);
      assert.equal((await jobs('operation.publishBatch')).length, 0);
      await assert.rejects(operationJobs['operation.simulatedFeedback']!({ ...runtime, config: { ...runtime.config, liveEnabled: true, aws: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } } }, deliver.payload, context(deliver)), { code: 'SIMULATED_FEEDBACK_FORBIDDEN' });
      await assert.rejects(operationJobs['operation.ses']!(runtime, deliver.payload, context(deliver)), { code: 'SES_ACCOUNT_MISMATCH' });
      await assert.rejects(operationJobs['operation.simulatedFeedback']!(runtime, { ...deliver.payload, message: { mail: { messageId: 'real-provider-id' } } }, context(deliver)), { code: 'SIMULATED_FEEDBACK_FORBIDDEN' });
      assert.equal(ok(await local('GET', `/v1/emails/${email.id}`, undefined, 'live')).id, email.id);

      const [{ getRegionSettings }, { setupResources }, { sesRegions }] = await Promise.all([import('./src/ses-region-state.js'), import('./src/ses-setup.js'), import('./src/db/ses-regions.js')]);
      const settings = await getRegionSettings(runtime.db, runtime.config.workspaceId);
      const topicArn = `arn:aws:sns:${REGION}:111122223333:${setupResources(settings.installationId).topicName}`;
      await runtime.db.insert(sesRegions).values({ workspaceId: runtime.config.workspaceId, region: REGION, trustedAccountId: '111122223333', trustedTopicArn: topicArn });
      runtime.config.awsAccountId = '111122223333';
      await assert.rejects(operationJobs['operation.ses']!(runtime, deliver.payload, context(deliver)), { code: 'SES_ACCOUNT_MISMATCH' });
      error(await local('POST', '/v1/events/ses', { Type: 'Notification', MessageId: unique('unsigned-synthetic'), TopicArn: topicArn,
        Message: JSON.stringify(deliver.payload.message), Timestamp: new Date().toISOString(), SignatureVersion: '2', Signature: '!!!',
        SigningCertURL: `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-synthetic.pem` }), 403, 'SNS_INVALID_SIGNATURE');
      assert.equal((await db.query('SELECT count(*)::int AS count FROM operation_sns_receipts WHERE workspace_id = $1', [runtime.config.workspaceId])).rows[0].count, 2);
    });
  });

  test('dispatch rechecks shared consent for direct marketing mail and an already-expanded campaign', async t => {
    await simulatedSesFixture(t, async ({ local, run, jobs }) => {
      const contact = ok(await local('POST', '/v1/contacts', { email: address() }), 201);
      const consentBody = { source: 'acceptance-fixture', policyVersion: 'v1', evidence: 'Synthetic reserved-domain fixture.', occurredAt: new Date().toISOString() };
      ok(await local('POST', `/v1/contacts/${contact.id}/consent`, { ...consentBody, status: 'subscribed' }));
      const list = ok(await local('POST', '/v1/lists', { name: unique('consent-simulator') }), 201);
      ok(await local('POST', `/v1/lists/${list.id}/members`, { contactIds: [contact.id] }));
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('consent-simulator'), from: 'sender@example.com', subject: 'Shared consent', html: '<p>Synthetic only.</p>', audience: { listId: list.id } }), 201);
      ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision }), 202);
      await run('campaign.run');
      const direct = ok(await local('POST', '/v1/emails/send', mail({ to: contact.email, kind: 'marketing' })), 202);
      ok(await local('POST', `/v1/contacts/${contact.id}/consent`, { ...consentBody, status: 'unsubscribed', occurredAt: new Date().toISOString() }));
      await run('email.dispatch');
      const [campaignEmail] = page(await local('GET', `/v1/emails?campaignId=${campaign.id}`));
      for (const id of [direct.id, campaignEmail!.id]) {
        const rejected = ok(await local('GET', `/v1/emails/${id}`));
        assert.equal(rejected.status, 'suppressed');
        assert.equal(rejected.providerId, null);
        assert.equal(rejected.attemptStartedAt, null);
      }
      assert.equal((await jobs('operation.simulatedFeedback')).length, 0, 'Ineligible recipients must never get provider acceptance or feedback.');
    });
  });

  test('static campaign preparation validates the second frozen recipient instead of trusting the first', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const list = ok(await local('POST', '/v1/lists', { name: unique('static-validation') }), 201);
      const contacts: Json[] = [];
      for (let index = 0; index < 2; index++) {
        const contact = ok(await local('POST', '/v1/contacts', { email: address() }), 201);
        ok(await local('POST', `/v1/contacts/${contact.id}/consent`, { status: 'subscribed', source: 'acceptance-fixture', policyVersion: 'v1', evidence: 'Synthetic reserved-domain fixture.', occurredAt: new Date().toISOString() }));
        contacts.push(contact);
      }
      // Seed invalid historical contact data before snapshotting. Recipient order
      // is by contact ID; keep the first valid so the static-message cache is used.
      const ordered = (await db.query("SELECT id FROM audience_contacts WHERE workspace_id = $1 ORDER BY id", [runtime.config.workspaceId])).rows;
      const invalidContactId = ordered[1].id;
      const invalidAddress = `${'a'.repeat(250)}@example.com`;
      assert.equal((await db.query("UPDATE audience_contacts SET email = $1 WHERE workspace_id = $2 AND id = $3", [invalidAddress, runtime.config.workspaceId, invalidContactId])).rowCount, 1);
      ok(await local('POST', `/v1/lists/${list.id}/members`, { contactIds: contacts.map(contact => contact.id) }));
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('static-validation'), from: 'sender@example.com', subject: 'Unpersonalized subject', html: '<p>Unpersonalized content.</p>', audience: { listId: list.id } }), 201);
      assert.equal(ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision }), 202).queued, 2);
      const reviewId = (await db.query('SELECT review_id FROM sending_campaigns WHERE id = $1', [campaign.id])).rows[0].review_id;
      const frozen = (await db.query('SELECT ordinal, recipient FROM sending_review_recipients WHERE review_id = $1 ORDER BY ordinal', [reviewId])).rows;
      assert.equal(frozen[0].recipient.email, contacts.find(contact => contact.id === ordered[0].id)!.email);
      assert.equal(frozen[1].ordinal, 2);
      assert.equal(frozen[1].recipient.id, invalidContactId);
      assert.equal(frozen[1].recipient.email, invalidAddress);
      await run('campaign.run');
      const failed = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(failed.state, 'failed');
      assert.equal(failed.delivery.error.code, 'CAMPAIGN_RECIPIENT_INVALID');
      assert.equal(failed.delivery.prepared, 0, 'The failing preparation chunk must not commit its first valid recipient.');
      assert.match(failed.delivery.error.message, /CAMPAIGN_RECIPIENT_INVALID/, 'Background failures expose a sanitized error summary, not contact identities.');
      error(await local('POST', `/v1/campaigns/${campaign.id}/pause`, {}), 409, 'CAMPAIGN_NOT_SENDING');
      assert.equal(page(await local('GET', `/v1/emails?campaignId=${campaign.id}`)).length, 0);
      assert.equal((await jobs('email.dispatch')).length, 0);
    });
  });

  test('routine callbacks create processed receipts and public events immediately, without prereceipts or SES work', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const { operationJobs } = await import('./src/operations.js');
      const email = ok(await local('POST', '/v1/emails/send', mail()), 202);
      await run('email.dispatch');
      const callbacks = await jobs('operation.simulatedFeedback');
      assert.equal(callbacks.length, 2);
      const receipts = async () => (await db.query('SELECT message_id, processed_at FROM operation_sns_receipts WHERE workspace_id = $1 ORDER BY message_id', [runtime.config.workspaceId])).rows;
      assert.deepEqual(await receipts(), [], 'Provider acceptance queues callback vehicles, not received feedback.');
      for (const [index, kind] of ['Send', 'Delivery'].entries()) {
        const callback = callbacks.find(job => job.payload.message.eventType === kind)!;
        const context = { id: callback.id, attempts: 1, workspaceId: runtime.config.workspaceId };
        await operationJobs['operation.simulatedFeedback']!(runtime, callback.payload, context);
        const persisted = await receipts();
        assert.equal(persisted.length, index + 1);
        assert.ok(persisted.every(receipt => receipt.processed_at !== null));
        assert.equal(ok(await local('GET', `/v1/emails/${email.id}`)).status, kind === 'Send' ? 'sent' : 'delivered');
        const published = (await db.query('SELECT type FROM operation_events WHERE workspace_id = $1 ORDER BY type', [runtime.config.workspaceId])).rows;
        assert.equal(published.length, index + 1, 'Callback completion must include public event persistence.');
        assert.ok(published.some(event => event.type === (kind === 'Send' ? 'email.sent' : 'email.delivered')));
        await operationJobs['operation.simulatedFeedback']!(runtime, callback.payload, context);
        assert.equal((await receipts()).length, index + 1);
      }
      for (const type of ['operation.ses', 'operation.simulatedFeedbackRecovery', 'operation.publish', 'operation.webhook']) assert.equal((await jobs(type)).length, 0);
    });
  });

  test('a feedback sink carries simulated callbacks off the jobs table and the batch consumer ingests them exactly once', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const { ingestFeedbackBatch } = await import('./src/operations.js');
      // Cloudflare provides this sink (the feedback queue); here it is an in-memory capture.
      const sink: import('./src/core.js').FeedbackItem[] = [];
      runtime.feedback = { enqueue: async items => { sink.push(...items); } };
      cleanup(t, async () => { delete runtime.feedback; });
      const first = ok(await local('POST', '/v1/emails/send', mail()), 202);
      const second = ok(await local('POST', '/v1/emails/send', mail()), 202);
      await run('email.dispatch');
      assert.equal((await jobs('operation.simulatedFeedback')).length, 0, 'With a sink, acceptance must not create feedback jobs.');
      assert.equal(sink.length, 4, 'Two accepted emails produce Send and Delivery callbacks each.');
      assert.ok(sink.every(item => item.topicArn === `urn:opensend:simulated-ses:${REGION}` && String(item.message.mail && (item.message.mail as Json).messageId).startsWith('sim_')));
      const receipts = async () => (await db.query('SELECT message_id, processed_at FROM operation_sns_receipts WHERE workspace_id = $1 ORDER BY message_id', [runtime.config.workspaceId])).rows;
      assert.deepEqual(await receipts(), []);
      // Out of order, duplicated, plus one non-routine item the simulator can never legitimately emit.
      // Live items are trusted here because SNS signature verification happens before enqueueing.
      const deliveries = sink.filter(item => item.message.eventType === 'Delivery'), sends = sink.filter(item => item.message.eventType === 'Send');
      const bounce = { ...sends[0]!, messageId: `${sends[0]!.messageId}-bounce`, message: { ...sends[0]!.message, eventType: 'Bounce' } };
      const outcomes = await ingestFeedbackBatch(runtime, [...deliveries, ...sends, deliveries[0]!, bounce]);
      assert.deepEqual(outcomes.slice(0, 5).map(outcome => outcome.ok), [true, true, true, true, true], 'Routine items and an exact duplicate are acknowledged.');
      assert.equal(outcomes[5]!.ok, false);
      assert.equal(outcomes[5]!.error, 'SIMULATED_FEEDBACK_UNSUPPORTED');
      const { settleFeedbackMessage } = await import('./src/adapters/feedback-queue.js');
      const unknown = { ...deliveries[0]!, message: { eventType:'Delivery', mail:{ messageId:`sim_${randomUUID()}` } } };
      const [unmatched] = await ingestFeedbackBatch(runtime, [unknown]);
      assert.equal(unmatched?.error, 'SES_FEEDBACK_UNMATCHED');
      const settled: (number | 'ack')[] = [];
      const live = { ...unknown, topicArn:`arn:aws:sns:${REGION}:111122223333:fixture` };
      const [invalid, unsupported] = await ingestFeedbackBatch(runtime,[{...live,message:{eventType:'Send',mail:{}}},{...live,message:{eventType:'unknown',mail:{messageId:'fixture'}}}]);
      assert.deepEqual([invalid?.error,unsupported?.error],['SES_INVALID_EVENT','SES_UNSUPPORTED_EVENT']);
      for (const [attempts, outcome] of [[1,unmatched],[2,unmatched],[2,outcomes[5]],[1,outcomes[0]],[1,invalid],[1,unsupported],[2,{ok:false,error:'FEEDBACK_PERSIST_FAILED'}]] as const) {
        settleFeedbackMessage({ attempts, ack:()=>settled.push('ack'), retry:opts=>settled.push(opts!.delaySeconds!) }, outcome);
      }
      assert.deepEqual(settled, [15,'ack','ack','ack','ack','ack',60]);
      const persisted = await receipts();
      assert.equal(persisted.length, 4, 'Exactly one receipt per distinct callback; duplicates and rejected items add none.');
      assert.ok(persisted.every(receipt => receipt.processed_at !== null));
      for (const email of [first, second]) {
        assert.equal(ok(await local('GET', `/v1/emails/${email.id}`)).status, 'delivered', 'A late Send must not regress a delivered status.');
        const observed = page(await local('GET', `/v1/emails/${email.id}/events`));
        for (const type of ['accepted', 'send', 'delivery']) assert.equal(observed.filter(event => event.type === type).length, 1);
      }
      const published = (await db.query('SELECT type, count(*)::int AS count FROM operation_events WHERE workspace_id = $1 GROUP BY type ORDER BY type', [runtime.config.workspaceId])).rows;
      assert.deepEqual(published, [{ type: 'email.delivered', count: 2 }, { type: 'email.sent', count: 2 }]);
      for (const type of ['operation.ses', 'operation.simulatedFeedback', 'operation.simulatedFeedbackRecovery', 'operation.publish', 'operation.webhook']) assert.equal((await jobs(type)).length, 0);
      // Re-ingesting the whole batch is a no-op.
      const again = await ingestFeedbackBatch(runtime, [...deliveries, ...sends]);
      assert.ok(again.every(outcome => outcome.ok));
      assert.equal((await receipts()).length, 4);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM sending_email_events WHERE workspace_id = $1 AND type IN ('send','delivery')", [runtime.config.workspaceId])).rows[0].count, 4);
    });
  });

  test('unmatched callback retains one deferred recovery and later records delivery exactly once', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const [{ operationJobs }, { recordEmailEvent }] = await Promise.all([import('./src/operations.js'), import('./src/sending.js')]);
      const providerId = `sim_${randomUUID()}`;
      const payload = { topicArn: `urn:opensend:simulated-ses:${REGION}`, messageId: unique('early-delivery'), region: REGION,
        message: { eventType: 'Delivery', mail: { messageId: providerId }, delivery: { timestamp: new Date().toISOString() } } };
      const context = { id: unique('callback'), attempts: 1, workspaceId: runtime.config.workspaceId };
      const receipts = async () => (await db.query('SELECT processed_at FROM operation_sns_receipts WHERE workspace_id = $1 AND message_id = $2', [runtime.config.workspaceId, payload.messageId])).rows;
      for (let duplicate = 0; duplicate < 2; duplicate++) await operationJobs['operation.simulatedFeedback']!(runtime, payload, context);
      assert.deepEqual(await receipts(), [{ processed_at: null }]);
      const recovery = await jobs('operation.simulatedFeedbackRecovery');
      assert.equal(recovery.length, 1);
      assert.equal(recovery[0]!.status, 'pending');
      assert.deepEqual(recovery[0]!.payload, payload);
      const delay = (await db.query('SELECT extract(epoch FROM available_at - now())::int AS seconds FROM jobs WHERE id = $1', [recovery[0]!.id])).rows[0].seconds;
      assert.equal(delay, 15);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM operation_events WHERE workspace_id = $1', [runtime.config.workspaceId])).rows[0].count, 0);
      await assert.rejects(operationJobs['operation.simulatedFeedbackRecovery']!(runtime, payload, context), { code: 'SES_EMAIL_NOT_FOUND', retryable: true });
      assert.deepEqual(await receipts(), [{ processed_at: null }]);

      ok(await local('POST', '/v1/webhooks', { url: `https://example.com/${unique('recovery-hook')}`, eventTypes: ['email.delivered'] }), 201);
      const email = ok(await local('POST', '/v1/emails/send', mail()), 202);
      // Simulate the provider association becoming durable after the callback.
      await recordEmailEvent(runtime, { workspaceId: runtime.config.workspaceId, emailId: email.id, providerId, type: 'accepted', externalId: unique('late-acceptance') });
      await run('operation.simulatedFeedbackRecovery');
      await operationJobs['operation.simulatedFeedbackRecovery']!(runtime, payload, context);
      await operationJobs['operation.simulatedFeedback']!(runtime, payload, context);
      assert.ok((await receipts())[0].processed_at);
      assert.equal(ok(await local('GET', `/v1/emails/${email.id}`)).status, 'delivered');
      assert.equal(page(await local('GET', `/v1/emails/${email.id}/events`)).filter(event => event.type === 'delivery').length, 1);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM operation_events WHERE workspace_id = $1', [runtime.config.workspaceId])).rows[0].count, 2, 'The acceptance and recovered delivery each publish once.');
      assert.equal((await db.query('SELECT count(*)::int AS count FROM operation_deliveries WHERE workspace_id = $1', [runtime.config.workspaceId])).rows[0].count, 1);
      assert.equal((await jobs('operation.webhook')).length, 1);
      assert.equal((await jobs('operation.simulatedFeedbackRecovery')).length, 1);
      assert.equal((await jobs('operation.ses')).length, 0);
    });
  });

  test('a real SQL fanout failure rolls back receipt, status and events before a successful callback retry', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const { operationJobs } = await import('./src/operations.js');
      ok(await local('POST', '/v1/webhooks', { url: `https://example.com/${unique('atomic-hook')}`, eventTypes: ['email.delivered'] }), 201);
      const email = ok(await local('POST', '/v1/emails/send', mail()), 202);
      await run('email.dispatch');
      const callback = (await jobs('operation.simulatedFeedback')).find(job => job.payload.message.eventType === 'Delivery')!;
      const context = { id: callback.id, attempts: 1, workspaceId: runtime.config.workspaceId };
      const before = ok(await local('GET', `/v1/emails/${email.id}`));
      const beforeEvents = page(await local('GET', `/v1/emails/${email.id}/events`));
      // DDL and this workspace-only trigger are rollback-only. PostgreSQL itself
      // rejects the final webhook job insert after the statement's upstream work.
      await db.query('SAVEPOINT acceptance_fault_injection');
      await db.query(`CREATE FUNCTION pg_temp.reject_acceptance_fanout() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.workspace_id = TG_ARGV[0] AND NEW.type = 'operation.webhook' THEN
          RAISE EXCEPTION 'SYNTHETIC_FANOUT_FAILURE' USING ERRCODE = '23514';
        END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER acceptance_fanout_failure BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_acceptance_fanout('${runtime.config.workspaceId}')`);
      let databaseFailureObserved = false;
      // Isolate only each execute statement, NOT the whole handler: successful
      // earlier statements would remain visible and fail the rollback assertions.
      const faultRuntime = { ...runtime, db: new Proxy(runtime.db, { get(target, property, receiver) {
        if (property !== 'execute') return Reflect.get(target, property, receiver);
        return async (query: Parameters<typeof target.execute>[0]) => {
          await db.query('SAVEPOINT acceptance_statement');
          try {
            const result = await target.execute(query);
            await db.query('RELEASE SAVEPOINT acceptance_statement');
            return result;
          } catch (cause: any) {
            databaseFailureObserved = cause.code === '23514' || cause.cause?.code === '23514';
            await db.query('ROLLBACK TO SAVEPOINT acceptance_statement');
            await db.query('RELEASE SAVEPOINT acceptance_statement');
            throw cause;
          }
        };
      } }) };
      await assert.rejects(operationJobs['operation.simulatedFeedback']!(faultRuntime, callback.payload, context), { code: 'OPERATION_TEMPORARILY_UNAVAILABLE', retryable: true });
      assert.equal(databaseFailureObserved, true, 'The failure must originate in PostgreSQL, not a mocked request.');
      assert.deepEqual(ok(await local('GET', `/v1/emails/${email.id}`)), before);
      assert.deepEqual(page(await local('GET', `/v1/emails/${email.id}/events`)), beforeEvents);
      for (const table of ['operation_sns_receipts', 'operation_events', 'operation_deliveries']) {
        assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE workspace_id = $1`, [runtime.config.workspaceId])).rows[0].count, table === 'operation_events' ? 1 : 0, `${table} must roll back to its post-acceptance state with failed fanout.`);
      }
      assert.equal((await jobs('operation.webhook')).length, 0);
      // Assertions above inspected the failure before removing the fault. Undo the fixture DDL
      // without upgrading to ACCESS EXCLUSIVE on jobs while the real runner is polling it.
      await db.query('ROLLBACK TO SAVEPOINT acceptance_fault_injection');
      await operationJobs['operation.simulatedFeedback']!(runtime, callback.payload, context);
      await operationJobs['operation.simulatedFeedback']!(runtime, callback.payload, context);
      assert.equal(ok(await local('GET', `/v1/emails/${email.id}`)).status, 'delivered');
      assert.equal((await db.query('SELECT count(*)::int AS count FROM operation_sns_receipts WHERE workspace_id = $1 AND processed_at IS NOT NULL', [runtime.config.workspaceId])).rows[0].count, 1);
      assert.equal(page(await local('GET', `/v1/emails/${email.id}/events`)).filter(event => event.type === 'delivery').length, 1);
      assert.equal((await jobs('operation.webhook')).length, 1);
    });
  });

  test('launching and completing a 2,000-recipient campaign is bounded in statements and job rows', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db }) => {
      const { jobHandlers } = await import('./src/sending.js');
      const { dispatchDue } = await import('./src/dispatcher.js');
      const { JobDeferred } = await import('./src/jobs.js');
      const ws = runtime.config.workspaceId;
      const list = ok(await local('POST', '/v1/lists', { name: unique('bench') }), 201);
      await db.query(`INSERT INTO audience_contacts (id, workspace_id, email, marketing_consent)
        SELECT 'con_' || md5($1 || n::text), $1, 'bench-' || n || '@example.com', 'subscribed' FROM generate_series(1, 2000) AS n`, [ws]);
      await db.query(`INSERT INTO audience_list_members (workspace_id, list_id, contact_id) SELECT workspace_id, $2, id FROM audience_contacts WHERE workspace_id = $1`, [ws, list.id]);
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('bench'), from: 'sender@example.com', subject: 'Bench', html: '<p>Bench</p>', audience: { listId: list.id } }), 201);
      const queries = t.mock.method(db, 'query');
      let start = queries.mock.callCount();
      assert.equal(ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision }), 202).queued, 2000);
      const launch = queries.mock.callCount() - start;
      let jobStatements = 0, dispatchStatements = 0, jobRuns = 0, dispatchRuns = 0;
      const jobRows = async () => (await db.query("SELECT * FROM jobs WHERE workspace_id = $1 AND type LIKE 'campaign.%' ORDER BY id", [ws])).rows;
      for (let i = 0; i < 200; i++) {
        for (const job of (await jobRows()).filter(job => job.status === 'pending')) {
          await db.query("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = $1", [job.id]);
          start = queries.mock.callCount(); jobRuns++;
          try { await jobHandlers[job.type]!(runtime, job.payload, { id: job.id, attempts: job.attempts + 1, workspaceId: ws }); }
          catch (error) {
            if (!(error instanceof JobDeferred)) throw error;
            jobStatements += queries.mock.callCount() - start;
            await db.query("UPDATE jobs SET status = 'pending', attempts = attempts - 1, available_at = $2, payload = coalesce($3::jsonb, payload) WHERE id = $1", [job.id, error.availableAt, error.payload ? JSON.stringify(error.payload) : null]);
            continue;
          }
          jobStatements += queries.mock.callCount() - start;
          await db.query("UPDATE jobs SET status = 'completed' WHERE id = $1", [job.id]);
        }
        if ((await db.query('SELECT state FROM sending_campaigns WHERE id = $1', [campaign.id])).rows[0].state === 'done') break;
        if ((await db.query("SELECT 1 FROM sending_emails WHERE campaign_id = $1 AND status = 'queued' LIMIT 1", [campaign.id])).rowCount) {
          start = queries.mock.callCount(); dispatchRuns++;
          await dispatchDue(runtime, REGION);
          dispatchStatements += queries.mock.callCount() - start;
        }
      }
      queries.mock.restore();
      const final = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(final.state, 'done');
      assert.equal(final.counts.byStatus.accepted, 2000);
      assert.deepEqual([final.delivery.prepared, final.delivery.expanded], [2000, 2000]);
      assert.equal((await jobRows()).length, 1, 'A campaign has exactly one job row for its whole life.');
      t.diagnostic(`2,000-recipient campaign: launch ${launch} statements; ${jobRuns} job runs ${jobStatements} statements; ${dispatchRuns} dispatcher runs ${dispatchStatements} statements; total ${launch + jobStatements + dispatchStatements}`);
      assert.ok(launch <= 40, `Launch took ${launch} statements.`);
      assert.ok(jobStatements <= 60, `The run job took ${jobStatements} statements.`);
    });
  });

  test('a run that exhausts its retries leaves the campaign failed, and a sending campaign with nothing queued is finished by the sweep', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const { MAX_ATTEMPTS } = await import('./src/jobs.js');
      const { jobHandlers } = await import('./src/sending.js');
      const { dispatchPartitions } = await import('./src/dispatch.js');
      const list = ok(await local('POST', '/v1/lists', { name: unique('stuck') }), 201);
      const contact = ok(await local('POST', '/v1/contacts', { email: address() }), 201);
      ok(await local('POST', `/v1/contacts/${contact.id}/consent`, { status: 'subscribed', source: 'acceptance-fixture', policyVersion: 'v1', evidence: 'Synthetic reserved-domain fixture.', occurredAt: new Date().toISOString() }));
      ok(await local('POST', `/v1/lists/${list.id}/members`, { contactIds: [contact.id] }));
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('stuck'), from: 'sender@example.com', subject: 'Stuck', html: '<p>Stuck</p>', audience: { listId: list.id } }), 201);
      ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision }), 202);
      const [job] = await jobs('campaign.run');
      assert.equal(job!.id, `campaign.run:${campaign.id}`);
      // A transient failure on an early attempt retries; the same failure on the last attempt must not leave the
      // campaign preparing forever (the previous prepare job did exactly that after MAX_ATTEMPTS).
      const db0 = runtime.db;
      const failOnce = () => { let failed = false; runtime.db = new Proxy(db0, { get: (target, key) => key === 'transaction' && !failed ? (() => { failed = true; throw new Error('synthetic database outage'); }) : Reflect.get(target, key) }); };
      failOnce();
      await assert.rejects(jobHandlers['campaign.run']!(runtime, job!.payload, { id: job!.id, attempts: 1, workspaceId: runtime.config.workspaceId }), { code: 'CAMPAIGN_RUN_FAILED', retryable: true });
      runtime.db = db0;
      assert.equal(ok(await local('GET', `/v1/campaigns/${campaign.id}`)).state, 'preparing', 'A retryable failure keeps the campaign where it was.');
      failOnce();
      await jobHandlers['campaign.run']!(runtime, job!.payload, { id: job!.id, attempts: MAX_ATTEMPTS, workspaceId: runtime.config.workspaceId });
      runtime.db = db0;
      const failed = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(failed.state, 'failed');
      assert.equal(failed.delivery.error.code, 'CAMPAIGN_DEPENDENCY_FAILED');
      assert.equal(failed.counts.total, 0);
      // Launch again from failed: one run prepares and releases; the recipient is dispatched and the campaign is done.
      ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision }), 202);
      await run('campaign.run');
      await run('email.dispatch');
      assert.equal(ok(await local('GET', `/v1/campaigns/${campaign.id}`)).state, 'done');
      // A campaign left sending with every recipient released and no row queued (a missed completion edge) is finished
      // by the minute sweep that also recovers interrupted attempts.
      await db.query("UPDATE sending_campaigns SET state = 'sending' WHERE id = $1", [campaign.id]);
      assert.equal(ok(await local('GET', `/v1/campaigns/${campaign.id}`)).state, 'sending');
      await dispatchPartitions(runtime, true);
      assert.equal(ok(await local('GET', `/v1/campaigns/${campaign.id}`)).state, 'done');
      // The sweep never finishes a campaign that still has queued rows or unreleased recipients.
      await db.query("UPDATE sending_campaigns SET state = 'sending', expanded = 0 WHERE id = $1", [campaign.id]);
      await dispatchPartitions(runtime, true);
      assert.equal(ok(await local('GET', `/v1/campaigns/${campaign.id}`)).state, 'sending');
    });
  });

  test('a campaign that fails after releasing recipients cannot be relaunched, edited or deleted; it resumes on the same snapshot or is canceled', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const ws = runtime.config.workspaceId;
      const list = ok(await local('POST', '/v1/lists', { name: unique('mid-send') }), 201);
      await db.query(`INSERT INTO audience_contacts (id, workspace_id, email, marketing_consent)
        SELECT 'con_' || md5($1 || n::text), $1, 'mid-' || n || '@example.com', 'subscribed' FROM generate_series(1, 500) AS n`, [ws]);
      await db.query(`INSERT INTO audience_list_members (workspace_id, list_id, contact_id) SELECT workspace_id, $2, id FROM audience_contacts WHERE workspace_id = $1`, [ws, list.id]);
      await db.query("DELETE FROM sending_region_limits WHERE workspace_id = $1 AND region = $2", [ws, REGION]);
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('mid-send'), from: 'sender@example.com', subject: 'Mid-send failure', html: '<p>Released once.</p>', audience: { listId: list.id } }), 201);
      const path = `/v1/campaigns/${campaign.id}`;
      assert.equal(ok(await local('POST', `${path}/send`, { revision: campaign.revision }), 202).queued, 500);
      // The 400-row buffer floor releases 400 of 500; the run then fails for good (the same write failCampaign makes).
      await run('campaign.run');
      const { rows: [launched] } = await db.query('SELECT review_id, expanded FROM sending_campaigns WHERE id = $1', [campaign.id]);
      assert.equal(launched.expanded, 400);
      await db.query(`UPDATE sending_campaigns SET state = 'failed', error = '{"code":"CAMPAIGN_DEPENDENCY_FAILED","message":"synthetic"}' WHERE id = $1 AND state = 'sending'`, [campaign.id]);
      await db.query("UPDATE jobs SET status = 'failed' WHERE id = $1", [`campaign.run:${campaign.id}`]);
      const failed = ok(await local('GET', path));
      assert.equal(failed.state, 'failed');
      assert.equal(failed.delivery.expanded, 400);
      assert.equal(failed.url, `${PUBLIC_ORIGIN}/campaigns/${campaign.id}/review`, 'A failed campaign that released recipients opens in review, not the editor.');
      // Nothing may create a second snapshot for recipients who already got the message.
      error(await local('PATCH', path, { revision: campaign.revision, draft: { ...campaign.draft, subject: 'Edited after release' } }), 409, 'CAMPAIGN_LOCKED');
      error(await local('DELETE', path), 409, 'CAMPAIGN_LOCKED');
      error(await local('POST', `${path}/send`, { revision: campaign.revision }), 409, 'CAMPAIGN_LOCKED');
      error(await local('POST', `${path}/schedule`, { revision: campaign.revision, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), 409, 'CAMPAIGN_LOCKED');
      error(await local('PATCH', `${path}/archive`, { archived: true }), 409, 'CAMPAIGN_ACTIVE');
      error(await local('POST', `${path}/pause`, {}), 409, 'CAMPAIGN_NOT_PAUSABLE');
      error(await local('POST', `${path}/pacing`, { perDay: 1000 }), 409, 'CAMPAIGN_NOT_SENDING');
      // Its unreleased recipients still count against the workspace reservation (2,000,000 per originating credential).
      await db.query("UPDATE sending_campaigns SET total = 2000000, prepared = 2000000 WHERE id = $1", [campaign.id]);
      const other = ok(await local('POST', '/v1/campaigns', { name: unique('capacity'), from: 'sender@example.com', subject: 'Capacity', html: '<p>Capacity</p>', audience: { listId: list.id } }), 201);
      error(await local('POST', `/v1/campaigns/${other.id}/send`, { revision: other.revision }), 429, 'CAMPAIGN_PENDING_LIMIT_EXCEEDED');
      await db.query("UPDATE sending_campaigns SET total = 500, prepared = 500 WHERE id = $1", [campaign.id]);
      // Resume continues from the cursor on the same snapshot: the remaining 100 go out, never the first 400 again.
      const resumed = ok(await local('POST', `${path}/resume`, {}));
      assert.equal(resumed.state, 'sending');
      assert.equal(resumed.delivery.error, null);
      assert.equal((await jobs('campaign.run')).filter(job => job.status === 'pending').length, 1);
      await db.query(`INSERT INTO sending_region_limits (workspace_id, region, max_send_rate, checked_at) VALUES ($1, $2, 5000, clock_timestamp())
        ON CONFLICT ON CONSTRAINT sending_region_limits_pkey DO UPDATE SET max_send_rate = 5000, checked_at = clock_timestamp()`, [ws, REGION]);
      await run('campaign.run');
      const released = ok(await local('GET', path));
      assert.equal(released.delivery.expanded, 500);
      assert.equal(released.counts.total, 500, 'Resuming releases only the remaining recipients.');
      assert.equal((await db.query('SELECT count(DISTINCT review_id)::int AS n, count(DISTINCT review_ordinal)::int AS ordinals FROM sending_emails WHERE campaign_id = $1', [campaign.id])).rows[0].n, 1);
      assert.equal((await db.query('SELECT review_id FROM sending_campaigns WHERE id = $1', [campaign.id])).rows[0].review_id, launched.review_id, 'The snapshot never changes after a release.');
      await run('email.dispatch');
      assert.equal(ok(await local('GET', path)).state, 'done');
      // A failed campaign with released recipients can also be canceled: the rest is released from the reservation.
      const second = ok(await local('POST', '/v1/campaigns', { name: unique('mid-cancel'), from: 'sender@example.com', subject: 'Mid-send cancel', html: '<p>Canceled.</p>', audience: { listId: list.id } }), 201);
      await db.query("DELETE FROM sending_region_limits WHERE workspace_id = $1 AND region = $2", [ws, REGION]);
      ok(await local('POST', `/v1/campaigns/${second.id}/send`, { revision: second.revision }), 202);
      await run('campaign.run');
      await db.query(`UPDATE sending_campaigns SET state = 'failed', error = '{"code":"CAMPAIGN_DEPENDENCY_FAILED","message":"synthetic"}' WHERE id = $1 AND state = 'sending'`, [second.id]);
      const canceled = ok(await local('POST', `/v1/campaigns/${second.id}/cancel`));
      assert.equal(canceled.state, 'canceled');
      assert.equal(canceled.canceled, 500, '400 queued rows plus 100 unreleased recipients.');
      assert.equal(ok(await local('GET', `/v1/campaigns/${second.id}`)).delivery.canceled, 100);
    });
  });

  test('a worker still holding a retired campaign run cannot complete or requeue the row a resume now owns', async t => {
    await simulatedSesFixture(t, async ({ runtime, db }) => {
      const { processJobs } = await import('./src/jobs.js');
      const { queueCampaignRun, retireCampaignRun, campaignRunJobId } = await import('./src/states.js');
      // processJobs drains the whole installation; isolate this queue from the harness runner.
      await db.query('CREATE TEMP TABLE jobs (LIKE public.jobs INCLUDING ALL) ON COMMIT DROP');
      const ref = { workspaceId: runtime.config.workspaceId, id: unique('campaign-aba') }, jobId = campaignRunJobId(ref.id);
      const row = async () => (await db.query('SELECT status, attempts, payload FROM jobs WHERE id = $1', [jobId])).rows[0];
      await runtime.db.execute(queueCampaignRun(ref, {}));
      const first = (await row()).payload.run;
      assert.equal(typeof first, 'string');
      let seen: string | undefined;
      // While the first run is in flight, a pause retires it and a resume requeues the same row, which another worker claims.
      const stale = async (_runtime: unknown, payload: Record<string, unknown>) => {
        seen = payload.run as string;
        await runtime.db.execute(retireCampaignRun(ref, 'CAMPAIGN_PAUSED'));
        await runtime.db.execute(queueCampaignRun(ref, {}));
        await db.query("UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = now() + interval '3 minutes' WHERE id = $1", [jobId]);
      };
      assert.equal(await processJobs(runtime, { 'campaign.run': stale }, 1, 1), 1);
      assert.equal(seen, first);
      const after = await row();
      assert.equal(after.status, 'running', 'The stale worker must not complete the row the new run owns.');
      assert.equal(after.attempts, 1);
      assert.notEqual(after.payload.run, first);
      // The same holds for a stale deferral and a stale failure.
      const { JobDeferred } = await import('./src/jobs.js');
      await db.query("UPDATE jobs SET status = 'pending', attempts = 0 WHERE id = $1", [jobId]);
      for (const outcome of [() => { throw new JobDeferred(new Date(Date.now() + 60_000).toISOString(), { campaignId: ref.id, run: 'stale' }); }, () => { throw new Error('stale failure'); }]) {
        const current = (await row()).payload.run;
        const handler = async (_runtime: unknown, payload: Record<string, unknown>) => {
          await runtime.db.execute(queueCampaignRun(ref, {}));
          await db.query("UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = now() + interval '3 minutes' WHERE id = $1", [jobId]);
          void payload; outcome();
        };
        assert.equal(await processJobs(runtime, { 'campaign.run': handler }, 1, 1), 1);
        const next = await row();
        assert.equal(next.status, 'running');
        assert.notEqual(next.payload.run, current);
        assert.notEqual(next.payload.run, 'stale');
        await db.query("UPDATE jobs SET status = 'pending', attempts = 0 WHERE id = $1", [jobId]);
      }
    });
  });

  test('four dispatcher shards on separate connections drain one campaign concurrently without serializing on its row', async t => {
    const db = await fixtureDatabase(t);
    const key = await keyFixture(t);
    const [{ nodeRuntime }, { jobHandlers }, { runDispatcher }, pg] = await Promise.all([import('./src/adapters/node.js'), import('./src/sending.js'), import('./src/dispatcher.js'), import('pg')]);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('shards') });
    const ws = list.workspaceId, tag = unique('shard');
    cleanup(t, async () => {
      await db.query("DELETE FROM sending_email_events WHERE email_id IN (SELECT id FROM sending_emails WHERE workspace_id = $1 AND campaign_id IN (SELECT id FROM sending_campaigns WHERE workspace_id = $1 AND draft->>'name' = $2))", [ws, tag]);
      await db.query("DELETE FROM operation_events WHERE workspace_id = $1 AND data->>'emailId' IN (SELECT id FROM sending_emails WHERE workspace_id = $1 AND campaign_id IN (SELECT id FROM sending_campaigns WHERE workspace_id = $1 AND draft->>'name' = $2))", [ws, tag]);
      await db.query("DELETE FROM sending_emails WHERE workspace_id = $1 AND campaign_id IN (SELECT id FROM sending_campaigns WHERE workspace_id = $1 AND draft->>'name' = $2)", [ws, tag]);
      await db.query("DELETE FROM jobs WHERE id IN (SELECT 'campaign.run:' || id FROM sending_campaigns WHERE workspace_id = $1 AND draft->>'name' = $2)", [ws, tag]);
      await db.query("DELETE FROM sending_campaign_reviews WHERE workspace_id = $1 AND campaign_id IN (SELECT id FROM sending_campaigns WHERE workspace_id = $1 AND draft->>'name' = $2)", [ws, tag]);
      await db.query("DELETE FROM sending_campaigns WHERE workspace_id = $1 AND draft->>'name' = $2", [ws, tag]);
      await db.query("DELETE FROM audience_list_members WHERE workspace_id = $1 AND list_id = $2", [ws, list.id]);
      await db.query("DELETE FROM audience_contacts WHERE workspace_id = $1 AND email LIKE $2", [ws, `${tag}-%@example.com`]);
    });
    await db.query(`INSERT INTO audience_contacts (id, workspace_id, email, marketing_consent) SELECT 'con_' || md5($1 || $2 || n::text), $1, $2 || '-' || n || '@example.com', 'subscribed' FROM generate_series(1, 2000) AS n`, [ws, tag]);
    await db.query(`INSERT INTO audience_list_members (workspace_id, list_id, contact_id) SELECT workspace_id, $2, id FROM audience_contacts WHERE workspace_id = $1 AND email LIKE $3`, [ws, list.id, `${tag}-%@example.com`]);
    const campaign = await campaignFixture(t, key.secret, { listId: list.id }, { name: tag, subject: 'Shard bench', html: '<p>Shard bench</p>' });
    // Schedule an hour out: the harness runner validates every recipient and then waits, so this test owns the release.
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: campaign.revision, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), 202);
    await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => row.state === 'scheduled');
    // Wait until the runner's run has parked itself on the schedule, so no other process releases rows.
    for (const deadline = Date.now() + 10_000; ; ) {
      const { rows: [job] } = await db.query("SELECT status, available_at FROM jobs WHERE id = $1", [`campaign.run:${campaign.id}`]);
      if (job?.status === 'pending' && Date.parse(job.available_at) > Date.now() + 1_800_000) break;
      assert.ok(Date.now() < deadline, `The scheduled run must be parked: ${JSON.stringify(job)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const env = { ...process.env, DATABASE_URL: FIXTURE_DATABASE_URL, ENABLE_LIVE_SES: 'false' };
    const runtimes = Array.from({ length: 5 }, () => nodeRuntime(env));
    cleanup(t, async () => { await Promise.all(runtimes.map(instance => instance.close())); });
    for (const { runtime } of runtimes) { runtime.config.workspaceId = ws; runtime.config.simulatedSes.latencyMs = 5; }
    await db.query(`INSERT INTO sending_region_limits (workspace_id, region, max_send_rate, checked_at) VALUES ($1, $2, 5000, clock_timestamp())
      ON CONFLICT ON CONSTRAINT sending_region_limits_pkey DO UPDATE SET max_send_rate = 5000, checked_at = clock_timestamp()`, [ws, REGION]);
    assert.equal((await db.query("UPDATE sending_campaigns SET state = 'sending', scheduled_at = NULL WHERE id = $1 AND state = 'scheduled'", [campaign.id])).rowCount, 1);
    await jobHandlers['campaign.run']!(runtimes[4]!.runtime, { campaignId: campaign.id }, { id: `campaign.run:${campaign.id}`, attempts: 1, workspaceId: ws });
    const released = ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret));
    assert.equal(released.delivery.expanded, 2000);
    // Count every statement the four shards issue on their own pools; the harness runner competes for the same rows.
    const queries = t.mock.method(pg.default.Pool.prototype, 'query');
    const started = Date.now();
    const reports = await Promise.all(runtimes.slice(0, 4).map(({ runtime }, index) => runDispatcher(runtime, { region: REGION, lanes: 1, shard: { index, count: 4 } })));
    const wall = Date.now() - started;
    const statements = queries.mock.callCount(); queries.mock.restore();
    const claimed = reports.reduce((sum, report) => sum + report.claimed, 0), busiest = Math.max(...reports.map(report => report.durationMs)), summed = reports.reduce((sum, report) => sum + report.durationMs, 0);
    const final = await poll(`/v1/campaigns/${campaign.id}`, key.secret, row => row.state === 'done');
    // The harness runner's feedback moves accepted rows on to sent/delivered while this runs.
    assert.equal((final.counts.byStatus.accepted ?? 0) + (final.counts.byStatus.sent ?? 0) + (final.counts.byStatus.delivered ?? 0), 2000);
    assert.equal(final.counts.total, 2000);
    t.diagnostic(`4 shards on one 2,000-recipient campaign: ${statements} statements for ${claimed} claimed (${(statements / claimed).toFixed(2)} per email); per shard ${reports.map(report => `${report.claimed} rows/${report.durationMs}ms`).join(', ')}; wall ${wall}ms vs ${summed}ms summed`);
    assert.ok(reports.every(report => report.claimed > 0), 'Every shard must take a share of the campaign.');
    assert.ok(statements / claimed < 0.6, `Shards must not add per-email statements: ${(statements / claimed).toFixed(2)}.`);
    assert.ok(wall < 0.75 * summed, `Shards must overlap, not serialize: wall ${wall}ms vs ${summed}ms summed.`);
    assert.ok(busiest > 0);
  });

  test('the campaign dispatch buffer scales with the cached regional rate and never creates per-email jobs', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const list = ok(await local('POST', '/v1/lists', { name: unique('refill-buffer') }), 201);
      // Bulk-seed reserved-domain contacts before the normal immutable snapshot.
      await db.query(`INSERT INTO audience_contacts (id, workspace_id, email, marketing_consent)
        SELECT 'con_' || md5($1 || n::text), $1, 'refill-' || n || '@example.com', 'subscribed'
        FROM generate_series(1, 500) AS n`, [runtime.config.workspaceId]);
      await db.query(`INSERT INTO audience_list_members (workspace_id, list_id, contact_id)
        SELECT workspace_id, $2, id FROM audience_contacts WHERE workspace_id = $1`, [runtime.config.workspaceId, list.id]);
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('refill-buffer'), from: 'sender@example.com', subject: 'Synthetic refill capacity', html: '<p>Synthetic buffer acceptance only.</p>', audience: { listId: list.id } }), 201);
      assert.equal(ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision }), 202).queued, 500);
      // Without a cached regional rate the buffer is the 400-row floor: one run prepares, fills it and waits in place.
      await db.query("DELETE FROM sending_region_limits WHERE workspace_id = $1 AND region = $2", [runtime.config.workspaceId, REGION]);
      await run('campaign.run');
      const floor = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(floor.state, 'sending');
      assert.equal(floor.counts.total, 400);
      assert.equal(floor.counts.byStatus.queued, 400);
      assert.equal(floor.delivery.prepared, 500);
      assert.equal(floor.delivery.expanded, 400);
      assert.equal((await jobs('email.dispatch')).length, 0, 'Expansion materializes rows, never per-email dispatch jobs.');
      for (const rate of [20, null]) {
        if (rate === null) {
          await db.query("DELETE FROM sending_region_limits WHERE workspace_id = $1 AND region = $2", [runtime.config.workspaceId, REGION]);
        } else {
          await db.query(`INSERT INTO sending_region_limits (workspace_id, region, max_send_rate, checked_at)
            VALUES ($1, $2, $3, clock_timestamp()) ON CONFLICT ON CONSTRAINT sending_region_limits_pkey
            DO UPDATE SET max_send_rate = excluded.max_send_rate, checked_at = excluded.checked_at`, [runtime.config.workspaceId, REGION, rate]);
        }
        const before = Date.now();
        await run('campaign.run');
        const after = Date.now();
        const deferred = (await jobs('campaign.run')).filter(job => job.status === 'pending');
        assert.equal(deferred.length, 1, 'Full capacity keeps exactly the campaign’s one job row, waiting in place.');
        assert.equal(deferred[0]!.id, `campaign.run:${campaign.id}`);
        const dueAt = new Date(deferred[0]!.available_at).getTime();
        // A full 400-row buffer rechecks once it could drain to half: 200 rows at 20/s is 10 s; an unknown rate waits 5 s.
        const wait = rate === null ? 5000 : 10000;
        assert.ok(dueAt >= before + wait - 5 && dueAt <= after + wait + 5, `Rate ${rate ?? 'missing'} should defer ${wait}ms; observed ${dueAt - before}ms.`);
        assert.equal(deferred[0]!.attempts, 0, 'A deferral must not consume a job attempt.');
        const full = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
        assert.equal(full.counts.total, 400, 'Deferral must not materialize more immutable emails.');
        assert.equal(full.delivery.expanded, 400);
      }
      // A high cached rate widens the buffer (ten seconds of sends), so the remaining recipients materialize at once.
      await db.query(`INSERT INTO sending_region_limits (workspace_id, region, max_send_rate, checked_at)
        VALUES ($1, $2, 5000, clock_timestamp()) ON CONFLICT ON CONSTRAINT sending_region_limits_pkey
        DO UPDATE SET max_send_rate = excluded.max_send_rate, checked_at = excluded.checked_at`, [runtime.config.workspaceId, REGION]);
      await run('campaign.run');
      const widened = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(widened.counts.total, 500);
      assert.equal(widened.counts.byStatus.queued, 500);
      assert.equal(widened.delivery.expanded, 500);
      assert.equal(widened.state, 'sending', 'Every recipient is released; the dispatcher finishes the campaign.');
      assert.equal((await jobs('campaign.run')).filter(job => job.status === 'pending').length, 0);
      assert.equal((await jobs('email.dispatch')).length, 0);
      // The dispatcher drains the whole buffer in batches; every row reaches the simulated provider exactly once.
      await run('email.dispatch');
      const dispatched = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(dispatched.counts.byStatus.accepted, 500);
      assert.equal(dispatched.state, 'done');
      assert.equal((await db.query("SELECT count(*)::int AS count FROM sending_email_events WHERE workspace_id = $1 AND type = 'dispatch_attempt'", [runtime.config.workspaceId])).rows[0].count, 500);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM sending_emails WHERE workspace_id = $1 AND lease_until IS NOT NULL", [runtime.config.workspaceId])).rows[0].count, 0, 'Leases are released by the claim.');
    });
  });

  test('paced campaigns release one daily window at a time, pause and resume in place, hold for the SES daily quota, and pause automatically on bounces', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const ws = runtime.config.workspaceId;
      const list = ok(await local('POST', '/v1/lists', { name: unique('paced') }), 201);
      // Bulk-seed reserved-domain contacts; every fourth one is plan=active so priority ordering is observable.
      await db.query(`INSERT INTO audience_contacts (id, workspace_id, email, marketing_consent, properties)
        SELECT 'con_' || md5($1 || n::text), $1, 'paced-' || n || '@example.com', 'subscribed', CASE WHEN n % 4 = 0 THEN '{"plan":"active"}'::jsonb ELSE '{"plan":"none"}'::jsonb END
        FROM generate_series(1, 1400) AS n`, [ws]);
      await db.query(`INSERT INTO audience_list_members (workspace_id, list_id, contact_id) SELECT workspace_id, $2, id FROM audience_contacts WHERE workspace_id = $1`, [ws, list.id]);
      // A high cached rate keeps the dispatch buffer out of the way; the daily SES quota is unknown (0) until set below.
      await db.query(`INSERT INTO sending_region_limits (workspace_id, region, max_send_rate, checked_at) VALUES ($1, $2, 5000, clock_timestamp())
        ON CONFLICT ON CONSTRAINT sending_region_limits_pkey DO UPDATE SET max_send_rate = 5000, max_24_hour_send = 0, sent_last_24_hours = 0, checked_at = clock_timestamp()`, [ws, REGION]);
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('paced'), from: 'sender@example.com', subject: 'Synthetic paced send', html: '<p>Synthetic pacing acceptance only.</p>', audience: { listId: list.id, priority: { property: 'plan', values: ['active'] } } }), 201);
      error(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision, pacing: { perDay: 99 } }), 422);
      assert.equal(ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision, pacing: { perDay: 1100, rateShare: 1 } }), 202).queued, 1400);
      const firstOrdinals = (await db.query(`SELECT r.recipient->>'email' AS email FROM sending_review_recipients r JOIN sending_campaigns c ON c.review_id = r.review_id WHERE c.id = $1 ORDER BY r.ordinal LIMIT 350`, [campaign.id])).rows;
      assert.ok(firstOrdinals.every(row => Number(row.email.match(/\d+/)![0]) % 4 === 0), 'Priority contacts are reviewed and released first.');

      // One run prepares and releases exactly the daily cap, then waits in place for the next window.
      await run('campaign.run');
      let view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.state, 'sending');
      assert.equal(view.delivery.prepared, 1400);
      assert.equal(view.delivery.expanded, 1100);
      assert.equal(view.delivery.pacing.perDay, 1100);
      assert.equal(view.delivery.pacing.windowExpanded, 1100);
      assert.equal(Date.parse(view.delivery.pacing.nextWindowAt) - Date.parse(view.delivery.pacing.windowStartedAt), 86_400_000);
      await run('campaign.run');
      view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.delivery.expanded, 1100, 'The daily cap holds within the window.');
      assert.equal(view.delivery.waiting.reason, 'pacing_window');
      let pending = (await jobs('campaign.run')).filter(job => job.status === 'pending');
      assert.equal(pending.length, 1, 'Waiting for the window keeps exactly the campaign’s one job row.');
      assert.ok(Math.abs(Date.parse(pending[0]!.available_at) - Date.parse(view.delivery.pacing.nextWindowAt)) < 1000, 'The run is due when the next window opens.');
      assert.equal(pending[0]!.attempts, 0);

      // Bounces above 2% of at least 1,000 accepted emails pause the campaign before the next window opens.
      await db.query(`UPDATE sending_emails SET status = CASE WHEN review_ordinal <= 50 THEN 'bounced' ELSE 'delivered' END, provider_id = 'sim_' || id WHERE campaign_id = $1`, [campaign.id]);
      // Simulate the next day: the window has elapsed and so has the last 30-minute health check.
      await db.query(`UPDATE sending_campaigns SET window_started_at = window_started_at - interval '25 hours', health_checked_at = health_checked_at - interval '25 hours' WHERE id = $1`, [campaign.id]);
      await db.query(`UPDATE jobs SET available_at = clock_timestamp() WHERE id = $1`, [pending[0]!.id]);
      await run('campaign.run');
      view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.state, 'paused');
      assert.equal(view.delivery.pauseReason.code, 'BOUNCE_RATE_HIGH');
      assert.equal(typeof view.delivery.pausedAt, 'string');
      assert.equal(view.delivery.expanded, 1100, 'An automatic pause releases nothing more.');
      assert.equal((await jobs('campaign.run')).filter(job => job.status === 'pending').length, 0);
      error(await local('POST', `/v1/campaigns/${campaign.id}/pause`, {}), 409, 'CAMPAIGN_NOT_PAUSABLE');

      // Resume continues from the same position in a new window (the health check waits 30 minutes).
      view = ok(await local('POST', `/v1/campaigns/${campaign.id}/resume`, {}));
      assert.equal(view.state, 'sending');
      assert.equal(view.delivery.pauseReason, null);
      assert.equal(view.delivery.pausedAt, null);
      assert.equal((await jobs('campaign.run')).filter(job => job.status === 'pending').length, 1, 'Resume requeues the campaign’s one job row.');
      error(await local('POST', `/v1/campaigns/${campaign.id}/resume`, {}), 409, 'CAMPAIGN_NOT_PAUSED');
      // Manual pause retires the waiting run; pacing changes keep autoPause when omitted.
      view = ok(await local('POST', `/v1/campaigns/${campaign.id}/pause`, {}));
      assert.equal(view.state, 'paused');
      assert.equal(view.delivery.pauseReason.code, 'PAUSED_BY_USER');
      assert.equal((await jobs('campaign.run')).filter(job => job.status === 'pending').length, 0);
      view = ok(await local('POST', `/v1/campaigns/${campaign.id}/pacing`, { perDay: 200 }));
      assert.equal(view.delivery.pacing.perDay, 200);
      assert.equal(view.delivery.pacing.autoPause, true);
      ok(await local('POST', `/v1/campaigns/${campaign.id}/resume`, {}));

      // The SES 24-hour quota holds expansion while remaining capacity is within the transactional reserve.
      // 2,000/day with 1,700 sent and a 10% reserve leaves exactly 100 for campaigns.
      await db.query(`UPDATE sending_region_limits SET max_24_hour_send = 2000, sent_last_24_hours = 1700, checked_at=clock_timestamp() WHERE workspace_id = $1 AND region = $2`, [ws, REGION]);
      await run('campaign.run');
      view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.delivery.expanded, 1200, 'Only the SES allowance above the transactional reserve is released.');
      await db.query(`UPDATE sending_emails SET status = 'delivered', provider_id = 'sim_' || id WHERE campaign_id = $1 AND status = 'queued'`, [campaign.id]);
      await db.query(`UPDATE sending_region_limits SET sent_last_24_hours = 1900 WHERE workspace_id = $1 AND region = $2`, [ws, REGION]);
      await run('campaign.run');
      view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.delivery.expanded, 1200, 'Nothing is released into the reserved SES quota.');
      assert.equal(view.delivery.waiting.reason, 'ses_daily_quota');
      // No email is needed as a refresh probe. Expiry alone cannot release recipients, and a
      // full buffer cannot override the published SES hold with a short buffer-drain retry.
      assert.ok(Date.parse(view.delivery.waiting.until) <= Date.now() + 60_000);
      const {SESv2Client,GetAccountCommand}=await import('@aws-sdk/client-sesv2'); let used=1900,quotaReads=0;
      t.mock.method(SESv2Client.prototype,'send',(cmd:unknown)=>{
        assert.ok(cmd instanceof GetAccountCommand);quotaReads++;
        return {SendingEnabled:true,SendQuota:{MaxSendRate:20,Max24HourSend:2000,SentLast24Hours:used}};
      });
      await db.query(`UPDATE sending_region_limits SET checked_at = clock_timestamp() - interval '2 minutes' WHERE workspace_id = $1 AND region = $2`, [ws, REGION]);
      await run('campaign.run');
      view=ok(await local('GET',`/v1/campaigns/${campaign.id}`)); assert.equal(view.delivery.expanded,1200); assert.equal(view.delivery.waiting.reason,'ses_daily_quota'); assert.equal(quotaReads,1);
      await db.query("UPDATE sending_emails SET status='queued' WHERE campaign_id=$1 AND review_ordinal BETWEEN 1 AND 400",[campaign.id]);
      await run('campaign.run');
      pending=(await jobs('campaign.run')).filter(job=>job.status==='pending');
      assert.ok(new Date(pending[0]!.available_at).getTime()-Date.now()>50_000); assert.equal(quotaReads,1);
      assert.equal(ok(await local('GET',`/v1/campaigns/${campaign.id}`)).delivery.waiting.reason,'ses_daily_quota');
      await db.query("UPDATE sending_emails SET status='delivered' WHERE campaign_id=$1 AND status='queued'",[campaign.id]);
      await db.query(`UPDATE sending_region_limits SET checked_at = clock_timestamp() - interval '2 minutes' WHERE workspace_id = $1 AND region = $2`, [ws,REGION]);
      used=0;
      pending = (await jobs('campaign.run')).filter(job => job.status === 'pending');
      await db.query(`UPDATE jobs SET available_at = clock_timestamp() WHERE id = $1`, [pending[0]!.id]);
      await run('campaign.run');
      view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.delivery.expanded, 1300);
      assert.equal(view.delivery.pacing.windowExpanded, 200);
      assert.equal(view.delivery.waiting.reason, 'pacing_window');
      // Raising the cap mid-window lets the rest go now; cancel still works for paced campaigns.
      view = ok(await local('POST', `/v1/campaigns/${campaign.id}/pacing`, { perDay: 1000, autoPause: false }));
      assert.equal(view.delivery.waiting, null);
      await run('campaign.run');
      view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.delivery.expanded, 1400);
      assert.equal(view.state, 'sending');
      assert.equal(view.delivery.pacing.autoPause, false);
      assert.equal((await jobs('campaign.run')).filter(job => job.status === 'pending').length, 0);
      assert.equal(ok(await local('POST', `/v1/campaigns/${campaign.id}/cancel`)).state, 'canceled');
    });
  });

  test('a rate-shared campaign releases only its share of the send rate and cannot catch up after waiting', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const ws = runtime.config.workspaceId;
      const list = ok(await local('POST', '/v1/lists', { name: unique('shared') }), 201);
      await db.query(`INSERT INTO audience_contacts (id, workspace_id, email, marketing_consent)
        SELECT 'con_' || md5($1 || n::text), $1, 'shared-' || n || '@example.com', 'subscribed' FROM generate_series(1, 1000) AS n`, [ws]);
      await db.query(`INSERT INTO audience_list_members (workspace_id, list_id, contact_id) SELECT workspace_id, $2, id FROM audience_contacts WHERE workspace_id = $1`, [ws, list.id]);
      // 20/s regional rate: the 400-row campaign buffer only limits the final full-rate step.
      await db.query(`INSERT INTO sending_region_limits (workspace_id, region, max_send_rate, checked_at) VALUES ($1, $2, 20, clock_timestamp())
        ON CONFLICT ON CONSTRAINT sending_region_limits_pkey DO UPDATE SET max_send_rate = 20, max_24_hour_send = 0, sent_last_24_hours = 0, checked_at = clock_timestamp()`, [ws, REGION]);
      const campaign = ok(await local('POST', '/v1/campaigns', { name: unique('shared'), from: 'sender@example.com', subject: 'Synthetic shared rate', html: '<p>Synthetic rate share acceptance only.</p>', audience: { listId: list.id } }), 201);
      error(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision, pacing: { rateShare: 0.01 } }), 422);
      ok(await local('POST', `/v1/campaigns/${campaign.id}/send`, { revision: campaign.revision, pacing: {} }), 202);
      // Default share 0.5 of 20/s is 10/s; the first release is five seconds of that share.
      const before = Date.now();
      await run('campaign.run');
      let view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.delivery.pacing.rateShare, 0.5);
      assert.equal(view.delivery.pacing.perDay, null);
      assert.equal(view.delivery.expanded, 50);
      let [next] = (await jobs('campaign.run')).filter(job => job.status === 'pending');
      assert.ok(typeof next!.payload.releasedAt === 'string', 'The waiting run remembers when it last released.');
      const due = Date.parse(next!.available_at) - before;
      assert.ok(due >= 4000 && due <= 7000, `The next release waits until 50 rows are paid for at 10/s; observed ${due}ms.`);
      // Running again immediately releases nothing: the share has not accrued yet.
      await run('campaign.run');
      assert.equal(ok(await local('GET', `/v1/campaigns/${campaign.id}`)).delivery.expanded, 50);
      // After a long wait, at most twenty seconds of the share (200 rows) is released, not the backlog of a minute.
      [next] = (await jobs('campaign.run')).filter(job => job.status === 'pending');
      await db.query(`UPDATE jobs SET payload = jsonb_set(payload, '{releasedAt}', to_jsonb($2::text)) WHERE id = $1`, [next!.id, new Date(Date.now() - 60_000).toISOString()]);
      await run('campaign.run');
      view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.delivery.expanded, 250);
      // Raising the share to the full rate keeps other settings; only the dispatch buffer (400 queued) limits it now.
      view = ok(await local('POST', `/v1/campaigns/${campaign.id}/pacing`, { perDay: null, rateShare: 1 }));
      assert.equal(view.delivery.pacing.rateShare, 1);
      assert.equal(view.delivery.pacing.autoPause, true);
      await run('campaign.run');
      view = ok(await local('GET', `/v1/campaigns/${campaign.id}`));
      assert.equal(view.delivery.expanded, 400);
    });
  });

  test('dispatch retries definitive rate throttles independently of daily holds but never replays rejection or uncertain acceptance', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, run, jobs, db }) => {
      const [{ SESv2Client, SendEmailCommand, GetAccountCommand }, { createSimulatedSesHandler }] = await Promise.all([
        import('@aws-sdk/client-sesv2'), import('./src/adapters/simulated-ses.js'),
      ]);
      const faultClient = new SESv2Client({ region: REGION, endpoint: 'https://ses-simulator.invalid', maxAttempts: 1,
        credentials: { accessKeyId: 'SYNTHETIC_ACCESS_KEY', secretAccessKey: 'synthetic-secret-not-an-aws-credential' },
        requestHandler: createSimulatedSesHandler({ latencyMs: 0, maxSendRate: 1000, outcomes: ['throttle', 'throttle', 'accept', 'reject', 'timeout'] }),
      });
      cleanup(t, async () => { faultClient.destroy(); });
      // Preserve the real SDK serializer, signer and error decoder. Only select
      // the in-process fault transport; calling the captured method avoids recursion.
      const originalSend = SESv2Client.prototype.send;
      const providerCalls: Array<{ emailId: string; to: string[] }> = [];
      t.mock.method(SESv2Client.prototype, 'send', (command: any) => {
        assert.ok(command instanceof SendEmailCommand || command instanceof GetAccountCommand);
        if (command instanceof SendEmailCommand) {
          providerCalls.push({ emailId: command.input.EmailTags!.find(tag => tag.Name === 'opensend_email_id')!.Value!, to: command.input.Destination!.ToAddresses! });
          assert.deepEqual(command.input.Destination!.CcAddresses, []);
          assert.deepEqual(command.input.Destination!.BccAddresses, []);
        }
        return Reflect.apply(originalSend, faultClient, [command]);
      });
      const events = async (emailId: string) => page(await local('GET', `/v1/emails/${emailId}/events`));
      const stored = async (emailId: string) => (await db.query('SELECT status, dispatch_version, scheduled_at, lease_until FROM sending_emails WHERE id = $1', [emailId])).rows[0];
      const retryAddress = address();
      const first = ok(await local('POST', '/v1/emails/send', mail({ to: retryAddress })), 202);
      assert.equal((await jobs('email.dispatch')).length, 0, 'Direct sends are rows, not jobs.');
      const beforeThrottle = Date.now();
      await run('email.dispatch');
      const afterThrottle = Date.now();
      const throttled = ok(await local('GET', `/v1/emails/${first.id}`));
      assert.equal(throttled.status, 'queued');
      assert.equal(throttled.errorCode, 'SES_THROTTLED');
      assert.equal(throttled.attemptStartedAt, null);
      assert.equal(throttled.providerId, null);
      const requeued = await stored(first.id);
      assert.equal(requeued.dispatch_version, 1, 'A throttled attempt requeues the row under a new dispatch version.');
      assert.equal(requeued.lease_until, null);
      const retryAt = new Date(requeued.scheduled_at).getTime();
      assert.ok(retryAt >= beforeThrottle + 2000 && retryAt <= afterThrottle + 2000, `Retry should be due in 2000ms; observed ${retryAt - beforeThrottle}ms.`);
      assert.equal((await events(first.id)).filter(event => event.type === 'provider_throttled').length, 1);
      assert.equal((await jobs('operation.simulatedFeedback')).length, 0);
      // Not yet due: another pass must not touch the row or consume the retry outcome.
      await run('email.dispatch');
      assert.equal(providerCalls.length, 1, 'A dispatch pass before the retry is due must not call the provider.');
      assert.equal((await stored(first.id)).dispatch_version, 1);
      // Model an intervening day hold. A version bump fences stale results, but only actual
      // per-second throttles consume the five retries and advance their exponential backoff.
      await db.query(`UPDATE sending_emails SET dispatch_version=2,error_code='SES_DAILY_QUOTA_EXHAUSTED',scheduled_at=clock_timestamp() WHERE id=$1`,[first.id]);
      const secondStart = Date.now();
      await run('email.dispatch');
      const second = await stored(first.id), secondWait = new Date(second.scheduled_at).getTime();
      assert.equal(second.status,'queued'); assert.ok(secondWait >= secondStart + 4000 && secondWait <= Date.now() + 4000);
      await db.query('UPDATE sending_emails SET scheduled_at = clock_timestamp() WHERE id = $1', [first.id]);
      await run('email.dispatch');
      const accepted = ok(await local('GET', `/v1/emails/${first.id}`));
      assert.equal(accepted.status, 'accepted');
      assert.match(accepted.providerId, /^sim_/);
      assert.equal((await events(first.id)).filter(event => event.type === 'dispatch_attempt').length, 3);
      assert.equal((await events(first.id)).filter(event => event.type === 'accepted').length, 1);

      const terminal: Array<{ id: string; to: string }> = [];
      for (const [status, code, eventType] of [['rejected', 'MessageRejected', 'reject'], ['acceptance_unknown', 'SES_ACCEPTANCE_UNKNOWN', 'acceptance_unknown']]) {
        const to = address();
        const email = ok(await local('POST', '/v1/emails/send', mail({ to })), 202);
        terminal.push({ id: email.id, to });
        await run('email.dispatch');
        const result = ok(await local('GET', `/v1/emails/${email.id}`));
        assert.equal(result.status, status);
        assert.equal(result.errorCode, code);
        assert.equal(result.providerId, null);
        const recorded = await events(email.id);
        assert.equal(recorded.filter(event => event.type === 'dispatch_attempt').length, 1);
        assert.equal(recorded.filter(event => event.type === eventType).length, 1);
        assert.equal((await stored(email.id)).dispatch_version, 0, 'Terminal or ambiguous outcomes must not requeue the row.');
        const sendsBeforeReplay: number = providerCalls.length;
        await run('email.dispatch');
        await run('email.dispatch');
        assert.equal(providerCalls.length, sendsBeforeReplay, 'Further dispatch passes must not call SendEmail for terminal rows.');
        assert.deepEqual(await events(email.id), recorded);
      }
      assert.deepEqual(providerCalls, [
        ...Array.from({ length: 3 }, () => ({ emailId: first.id, to: [retryAddress] })),
        ...terminal.map(email => ({ emailId: email.id, to: [email.to] })),
      ]);
      const callbacks = await jobs('operation.simulatedFeedback');
      assert.equal(callbacks.length, 2, 'Only the accepted retry may create Send/Delivery feedback vehicles.');
      assert.ok(callbacks.every(job => job.payload.message.mail.messageId === accepted.providerId));
      const versions = (await db.query('SELECT dispatch_version FROM sending_emails WHERE workspace_id = $1 ORDER BY dispatch_version DESC', [runtime.config.workspaceId])).rows;
      assert.deepEqual(versions, [{ dispatch_version: 3 }, { dispatch_version: 0 }, { dispatch_version: 0 }]);
    });
  });

  test('MOCK JEV TRANSPORT: screened live transactional spam is rejected before SES, clean and unscreened mail sends, and an outage fails open', async t => {
    await simulatedSesFixture(t, async ({ runtime, local, db }) => {
      const [{ SESv2Client, SendEmailCommand, GetAccountCommand }, { dispatchDue }, { credentialFingerprint, discoveryTarget }, { loadConfig }] = await Promise.all([
        import('@aws-sdk/client-sesv2'), import('./src/dispatcher.js'), import('./src/ses-region-state.js'), import('./src/config.js'),
      ]);
      const base = { BETTER_AUTH_SECRET: AUTH_SECRET, PUBLIC_URL: PUBLIC_ORIGIN };
      assert.equal(loadConfig(base).screen, undefined, 'Without TYPESAFE_API_KEY the screen is off.');
      assert.deepEqual(loadConfig({ ...base, TYPESAFE_API_KEY: 'synthetic-typesafe-key' }).screen, { apiKey: 'synthetic-typesafe-key', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', mode: 'reject', threshold: 0.7 });
      assert.equal(loadConfig({ ...base, TYPESAFE_API_KEY: 'synthetic-console-key', JEV_ENDPOINT: 'https://opencode.ai/inference/systemone/v1/systemone', JEV_MODEL: 'jev-1.13-free' }).screen?.endpoint, 'https://opencode.ai/inference/systemone/v1/systemone');
      // Synthetic live provider: the SDK prototype is intercepted, so no credential or AWS endpoint is used.
      runtime.config.liveEnabled = true;
      runtime.config.aws = { accessKeyId: 'SYNTHETIC_ACCESS_KEY', secretAccessKey: 'synthetic-secret-not-an-aws-credential' };
      runtime.config.screen = { apiKey: 'synthetic-typesafe-key', endpoint: 'https://jev.synthetic.invalid/v1/systemone', model: 'jev-test', mode: 'reject', threshold: 0.7 };
      const topic = `arn:aws:sns:${REGION}:111122223333:synthetic-feedback`;
      await db.query(`INSERT INTO ses_region_discovery(workspace_id, region, report, credentials_fingerprint, public_url, trusted_account_id, trusted_topic_arn)
        VALUES ($1, $2, $3, $4, $5, '111122223333', $6)`, [runtime.config.workspaceId, REGION,
        JSON.stringify({ provisioned: true, account: { id: '111122223333', sendingEnabled: true }, resources: { topic: { arn: topic }, transactional: { sendingEnabled: true }, marketing: { sendingEnabled: true } } }),
        await credentialFingerprint(runtime.config), discoveryTarget(runtime.config), topic]);
      const sent: string[] = [];
      t.mock.method(SESv2Client.prototype, 'send', async (command: any) => {
        if (command instanceof GetAccountCommand) return { SendingEnabled: true, SendQuota: { MaxSendRate: 100, Max24HourSend: 10000, SentLast24Hours: 0 } };
        assert.ok(command instanceof SendEmailCommand, 'Only GetAccount and SendEmail are expected.');
        const emailId = command.input.EmailTags!.find((tag: Json) => tag.Name === 'opensend_email_id')!.Value!;
        sent.push(emailId);
        return { MessageId: `live-${emailId}` };
      });
      const marker = unique('CASINO-BONUS');
      let classifierDown = false;
      let sibling = '', siblingSentAtAbort = false, timeoutMs = 0;
      const classified: string[] = [];
      const passthrough = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('https://jev.synthetic.invalid/')) return passthrough(input, init);
        assert.equal(url, 'https://jev.synthetic.invalid/v1/systemone');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-typesafe-key');
        const request = JSON.parse(String(init?.body));
        assert.equal(request.model, 'jev-test');
        assert.equal(request.questions.spam.type, 'noul');
        assert.equal(request.state.signals.recipients, 1);
        classified.push(request.state.email.subject);
        if (request.state.email.subject === 'Unresponsive classifier') {
          const at = Date.now();
          return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => {
            timeoutMs = Date.now() - at; siblingSentAtAbort = sent.includes(sibling); reject(new Error('Timed out'));
          }, { once: true }));
        }
        if (classifierDown) return new Response(null, { status: 429 });
        return Response.json({ model: 'jev-test', answers: { spam: { noul: request.state.email.subject.includes(marker) ? 0.97 : 0.02 } } });
      });
      const send = async (extra: Json) => ok(await local('POST', '/v1/emails/send', mail(extra), 'live'), 202).id as string;
      const get = async (emailId: string) => ok(await local('GET', `/v1/emails/${emailId}`, undefined, 'live'));
      const events = async (emailId: string) => page(await local('GET', `/v1/emails/${emailId}/events`, undefined, 'live'));

      const spamSubject = `Join ${marker} on OpenCode`;
      const spam = await send({ subject: spamSubject, html: `<p>You were invited to <b>${marker}</b>.</p>`, screen: true });
      const clean = await send({ subject: 'Join Acme on OpenCode', screen: true });
      const unscreened = await send({ subject: `Join ${marker} unscreened on OpenCode` });
      await dispatchDue(runtime, REGION);
      const rejected = await get(spam);
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.errorCode, 'CONTENT_REJECTED_SPAM');
      assert.equal(rejected.providerId, null);
      const reject = (await events(spam)).find(event => event.type === 'reject');
      assert.ok(reject, 'A screen rejection records a reject event.');
      assert.equal(reject.data.code, 'CONTENT_REJECTED_SPAM');
      assert.equal(reject.data.providerCalled, false);
      assert.deepEqual(reject.data.screen, { spam: 0.97, model: 'jev-test', threshold: 0.7 });
      assert.ok(!sent.includes(spam), 'A rejected message never reaches SES.');
      assert.equal((await get(clean)).status, 'accepted');
      assert.equal((await get(unscreened)).status, 'accepted', 'Unscreened mail is never classified, whatever its content.');
      assert.deepEqual(classified.sort(), [spamSubject, 'Join Acme on OpenCode'].sort());
      assert.deepEqual(sent.sort(), [clean, unscreened].sort());

      classifierDown = true;
      const outage = await send({ subject: `Join ${marker} during an outage`, screen: true });
      await dispatchDue(runtime, REGION);
      assert.equal((await get(outage)).status, 'accepted', 'A classifier outage fails open.');
      assert.ok(sent.includes(outage));
      assert.equal(classified.length, 3);
      const slow = await send({ subject: 'Unresponsive classifier', screen: true });
      sibling = await send({ subject: 'Unrelated receipt' });
      await dispatchDue(runtime, REGION);
      assert.ok(siblingSentAtAbort, 'The sibling was sent while the slow screen was still pending.');
      assert.ok(timeoutMs < 1000, `Classifier aborted after ${timeoutMs} ms`);
      assert.ok(sent.includes(slow));
      t.diagnostic(`Unresponsive classifier failed open in ${timeoutMs} ms; sibling already sent.`);
    });
  });
});
