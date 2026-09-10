import { after, before, describe, test, type TestContext } from 'node:test';
import { makeSignature } from 'better-auth/crypto';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
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
type Key = { id: string; secret: string; environment: 'test' | 'live' };
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
    if (['draft', 'reviewed'].includes(state.status)) ok(await http('DELETE', `/v1/campaigns/${created.id}`, key));
    else if (['scheduled', 'sending'].includes(state.status)) ok(await http('POST', `/v1/campaigns/${created.id}/cancel`, key));
    // Canceled/completed campaigns and immutable email logs have no deletion API;
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
  return text.replace(/os_(?:test|live)_[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(/(\/unsubscribe\/)[^\s"<>?]+/g, '$1[REDACTED]');
}
function diagnostic(reply: Reply): string {
  return `HTTP ${reply.status}; x-request-id=${reply.headers.get('x-request-id') ?? '(missing)'}; body=${redact(reply.body)}`;
}
async function http(method: string, path: string, key?: string, body?: unknown, headers: Record<string, string> = {}, timeout = 5_000, base = BASE): Promise<Reply> {
  if (key === MANAGER) assert.ok(manager, 'Synthetic dashboard session has not been bootstrapped.');
  const credentials: Record<string, string> = key === MANAGER
    ? { cookie: manager!.cookie, origin: PUBLIC_ORIGIN, 'x-opensend-environment': path.startsWith('/v1/api-keys') ? 'live' : 'test' }
    : key ? { authorization: `Bearer ${key}` } : {};
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...credentials, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : headers['content-type'] === 'application/x-www-form-urlencoded' ? String(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
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
async function keyFixture(t: TestContext, options: { environment?: 'test' | 'live'; permissions?: string[]; domains?: string[] } = {}): Promise<Key> {
  const body = ok(await http('POST', '/v1/api-keys', MANAGER, {
    name: unique('acceptance'), environment: options.environment ?? 'test',
    permissions: options.permissions ?? ['read', 'send', 'manage'], domains: options.domains ?? [],
  }), 201);
  assert.equal(typeof body.id, 'string');
  assert.equal(typeof body.secret, 'string', 'API-key creation must return the secret exactly once.');
  assert.ok(body.secret.startsWith(options.environment === 'live' ? 'os_live_' : 'os_test_'), 'Key prefix must identify its environment.');
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
  test('health and OpenAPI are public, protected routes reject missing and invalid credentials', async () => {
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
    assert.equal(publicFailureBucket('/v1/events/ses', 403), 'ses');
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
      '/v1/campaigns/{id}/state': ['get'], '/v1/campaigns/{id}/archive': ['patch'], '/v1/campaigns/{id}/review': ['post'], '/v1/campaigns/{id}/schedule': ['post'], '/v1/campaigns/{id}/cancel': ['post'],
    };
    for (const [path, methods] of Object.entries(contract)) for (const method of methods) {
      const operation = document.paths[path]?.[method];
      assert.ok(operation, `OpenAPI must document ${method.toUpperCase()} ${path}.`);
      assert.ok(Object.keys(operation.responses ?? {}).some(status => /^2\d\d$/.test(status)), `OpenAPI ${method} ${path} needs a successful response contract.`);
      assert.ok(operation.responses?.['401'] && operation.responses?.['422'], `OpenAPI ${method} ${path} must document authentication/validation errors.`);
    }
    const resolve = (schema: Json): Json => schema?.$ref ? schema.$ref.slice(2).split('/').reduce((value: Json, part: string) => value?.[part], document) : schema;
    const sendSchema = resolve(document.paths['/v1/emails/send'].post.requestBody.content['application/json'].schema);
    assert.ok(sendSchema.properties?.from && sendSchema.properties?.to && sendSchema.properties?.region, 'Generated send schema needs usable typed fields, not an empty object.');
    assert.ok(sendSchema.required?.includes('from') && sendSchema.required?.includes('to'));
    const contactSchema = resolve(document.paths['/v1/contacts'].post.requestBody.content['application/json'].schema);
    assert.equal(contactSchema.properties?.email?.format, 'email');
    const queuedSchema = resolve(document.paths['/v1/emails/send'].post.responses['202'].content['application/json'].schema);
    assert.ok(queuedSchema.properties?.id && queuedSchema.properties?.simulated && queuedSchema.properties?.environment);
    error(await http('GET', '/v1/api-keys'), 401);
    error(await http('GET', '/v1/api-keys', 'not-a-valid-key'), 401);
  });

  test('an approved dashboard session creates scoped keys, listing never discloses secrets, revocation blocks reuse', async t => {
    const key = await keyFixture(t, { permissions: ['read'] });
    const rows = await allPages('/v1/api-keys', MANAGER);
    const saved = rows.find(row => row.id === key.id);
    assert.ok(saved, 'Newly created API key must be visible in the key list.');
    for (const row of rows) {
      assert.equal(row.secret, undefined, 'API-key listing must never return a secret.');
      assert.equal(row.hash, undefined, 'API-key listing must never return credential hashes.');
      assert.equal(row.secretHash, undefined, 'API-key listing must never return credential hashes.');
    }
    page(await http('GET', '/v1/contacts', key.secret));
    error(await http('POST', '/v1/api-keys', key.secret, { name: unique('forbidden'), environment: 'test', permissions: ['manage'], domains: [] }), 403);
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
  test('approved synthetic Google sessions identify the operator and select an environment without exposing credentials', async t => {
    const me = ok(await http('GET', '/v1/me', MANAGER));
    assert.equal(me.id, manager!.userId);
    assert.equal(me.email, AUTH_EMAIL);
    assert.equal(me.name, 'Synthetic acceptance operator');
    assert.equal(me.environment, 'test');
    assert.ok(me.permissions.includes('manage'));
    assert.equal(ok(await http('GET', '/v1/me', MANAGER, undefined, { 'x-opensend-environment': 'live' })).environment, 'live');
    error(await http('GET', '/v1/me', MANAGER, undefined, { 'x-opensend-environment': 'invalid' }), 422, 'ENVIRONMENT_INVALID');
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
    assert.equal(machineMe.environment, 'test', 'Dashboard headers cannot elevate an API key into live scope.');
    assert.deepEqual(machineMe.permissions, ['read']);
    for (const field of ['token', 'secret', 'cookie', 'accessToken', 'refreshToken']) assert.equal(me[field], undefined);
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
      const headers: Record<string, string> = { cookie: manager!.cookie, 'x-opensend-environment': 'test' };
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
    const headers = { cookie: fixture.cookie, origin: PUBLIC_ORIGIN, 'x-opensend-environment': 'test' };
    assert.equal(ok(await http('GET', '/v1/me', undefined, undefined, headers)).id, fixture.userId, 'An exact approved hd must authorize a verified Google account.');
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
      assert.equal(ok(await http('GET', '/api/auth/get-session', undefined, undefined, headers)), null, state.reason);
      const email = address();
      error(await http('POST', '/v1/contacts', undefined, { email }, headers), 401, 'AUTH_REQUIRED');
      assert.equal((await authDb!.query('SELECT id FROM audience_contacts WHERE email = $1', [email])).rowCount, 0, `${state.reason} must prevent all API writes.`);
    }
    await authDb!.query('UPDATE auth_user SET email = $2, email_verified = true, google_hosted_domain = $3 WHERE id = $1', [fixture.userId, fixture.email, AUTH_DOMAIN]);
    assert.equal(ok(await http('GET', '/v1/me', undefined, undefined, headers)).id, fixture.userId, 'Restoring this fixture’s current Google policy evidence must restore access without replacing its cookie.');
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
      error(await http('POST', '/v1/contacts', undefined, { email }, { ...headers, 'x-opensend-environment': 'test' }), 401, 'AUTH_REQUIRED');
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
    const origin = 'https://mock-oauth.opensend.invalid';
    const emailAllowed = `${unique('mock-email-approved')}@unapproved.invalid`;
    const runtime: import('./src/core.js').Runtime = {
      db: drizzle(authDb!),
      storage: { async put() { throw new Error('Unexpected storage access'); }, async get() { throw new Error('Unexpected storage access'); }, async delete() { throw new Error('Unexpected storage access'); } },
      config: { workspaceId: unique('mock-oauth-workspace'), authSecret: unique('mock-oauth-root-secret'), googleClientId: 'acceptance-client.apps.googleusercontent.com', googleClientSecret: 'synthetic-client-secret',
        allowedEmails: [emailAllowed], allowedDomains: ['example.com', 'second.example.com'], publicUrl: origin, regions: [REGION], liveEnabled: false, encryptionKey: '0'.repeat(64), snsTopicArns: [], webhookAllowedHosts: [], configurationSets: { transactional: '', marketing: '' } },
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
    async function local(method: string, path: string, body?: Json, cookie?: string): Promise<Reply> {
      const response = await app.fetch(new Request(`${origin}${path}`, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), runtime);
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
    for (const scenario of scenarios) {
      fixtureEmails.push(scenario.email);
      jwtFault = scenario.jwtFault ?? '';
      profile = { sub: scenario.sub ?? unique('mock-google-sub'), name: 'Mock provider identity', email: scenario.email, email_verified: scenario.verified, ...(scenario.hd ? { hd: scenario.hd } : {}) };
      const userBefore = (await authDb!.query('SELECT * FROM auth_user WHERE email = $1', [scenario.email])).rows;
      const subjectBefore = (await authDb!.query('SELECT u.*, a.account_id FROM auth_user u JOIN auth_account a ON a.user_id = u.id WHERE a.provider_id = $1 AND a.account_id = $2', ['google', profile.sub])).rows;
      const sessionsBefore = (await authDb!.query('SELECT s.* FROM auth_session s JOIN auth_account a ON a.user_id = s.user_id WHERE a.provider_id = $1 AND a.account_id = $2 ORDER BY s.id', ['google', profile.sub])).rows;
      const start = await local('POST', '/api/auth/sign-in/social', { provider: 'google', callbackURL: `${origin}/`, disableRedirect: true });
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
        assert.equal(callback.headers.get('location'), `${origin}/`);
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
    }
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
  async function registerClient(t: TestContext, db: pg.Client, metadata: Json = {}): Promise<Reply> {
    const name = unique('acceptance-mcp-client');
    const reply = protectOAuth(await http('POST', '/api/auth/oauth2/register', undefined, {
      client_name: name, redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: writableScope, ...metadata,
    }));
    if (typeof reply.body?.client_id === 'string') cleanup(t, async () => {
      // Client-owned consents, resource links and tokens cascade; never delete another client's grants.
      await db.query('DELETE FROM oauth_client WHERE client_id = $1 AND name = $2', [reply.body.client_id, name]);
    });
    return reply;
  }
  async function oauthGrant(t: TestContext, db: pg.Client, scope = writableScope) {
    const client = ok(await registerClient(t, db, { scope }), 201);
    const redirectUri = 'http://127.0.0.1/callback';
    const verifier = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
    secrets.add(verifier);
    const state = unique('acceptance-mcp-state');
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      scope, state, resource: resourceUrl, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const authorization = ok(protectOAuth(await http('GET', `/api/auth/oauth2/authorize?${query}`, MANAGER)));
    assert.equal(authorization.redirect, true);
    assert.equal(typeof authorization.url, 'string');
    const consentUrl = new URL(authorization.url, PUBLIC_ORIGIN);
    assert.equal(consentUrl.origin, PUBLIC_ORIGIN);
    assert.equal(consentUrl.pathname, '/mcp/consent');
    const oauthQuery = consentUrl.search.slice(1);
    secrets.add(oauthQuery);
    const approval = ok(protectOAuth(await http('POST', '/api/auth/oauth2/consent', MANAGER, { accept: true, oauth_query: oauthQuery })));
    assert.equal(typeof approval.url, 'string');
    const callback = new URL(approval.url);
    assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
    assert.equal(callback.searchParams.get('state'), state);
    const code = callback.searchParams.get('code');
    assert.ok(code, 'Approved OAuth consent must issue an authorization code.');
    secrets.add(code);
    const tokenReply = protectOAuth(await http('POST', '/api/auth/oauth2/token', undefined, new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirectUri, code, code_verifier: verifier, resource: resourceUrl,
    }).toString(), { 'content-type': 'application/x-www-form-urlencoded' }));
    const tokens = ok(tokenReply);
    assert.equal(typeof tokens.access_token, 'string');
    assert.equal(typeof tokens.refresh_token, 'string');
    assert.equal(String(tokens.token_type).toLowerCase(), 'bearer');
    const grant = await db.query('SELECT id FROM oauth_consent WHERE client_id = $1 AND user_id = $2', [client.client_id, manager!.userId]);
    assert.equal(grant.rowCount, 1);
    return { token: tokens.access_token as string, consentId: grant.rows[0].id as string };
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

  test('hosted MCP accepts omitted-type loopback desktop registration without weakening redirect validation', async t => {
    const db = await fixtureDatabase(t);
    for (const redirect of ['http://127.0.0.1/callback', 'http://localhost:49152/callback', 'http://[::1]:49152/callback']) {
      const client = ok(await registerClient(t, db, { redirect_uris: [redirect] }), 201);
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
      const reply = await registerClient(t, db, metadata);
      assert.equal(reply.status, 400, diagnostic(reply));
      assert.equal(typeof reply.body.error, 'string', diagnostic(reply));
      assert.equal(reply.body.client_id, undefined, diagnostic(reply));
    }
  });

  test('hosted MCP publishes the curated task catalog and composes campaign, contact, email and temporary-token workflows', async t => {
    const db = await fixtureDatabase(t);
    const { token, consentId } = await oauthGrant(t, db);
    const initialized = await rpc(token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'acceptance', version: '1' } });
    assert.equal(initialized.protocolVersion, '2025-11-25');
    assert.equal(initialized.serverInfo.name, 'opensend');
    const catalog = await rpc(token, 'tools/list');
    assert.equal(catalog.tools.length, 38);
    assert.equal(catalog.tools.filter((tool: Json) => tool.annotations.readOnlyHint).length, 12);
    const tools = new Map<string, Json>(catalog.tools.map((tool: Json) => [tool.name, tool]));
    assert.deepEqual([...tools.keys()].sort(), [
      'archiveCampaign', 'audienceQuery', 'createAgentToken', 'deleteAttachment', 'deleteCampaign', 'deleteContact', 'deleteList', 'deleteSegment', 'deleteTemplate', 'deleteWebhook',
      'deliverCampaign', 'findCampaigns', 'findContacts', 'findDomains', 'findEmails', 'findLists', 'findSegments', 'findTemplates', 'findWebhooks', 'getAttachment', 'getContentGuide', 'getContext', 'getMetrics',
      'importContacts', 'publishTemplate', 'retryWebhookDelivery', 'reviewCampaign', 'saveCampaign', 'saveContact', 'saveList', 'saveSegment', 'saveTemplate', 'saveWebhook',
      'saveDomain', 'sendEmail', 'setListMembers', 'testWebhook', 'uploadAttachment',
    ].sort());
    for (const tool of tools.values()) {
      assert.equal(tool.outputSchema?.type, 'object', tool.name);
      assert.equal(tool.inputSchema.properties.path, undefined, tool.name);
      assert.equal(tool.inputSchema.properties.query, undefined, tool.name);
    }
    for (const removed of ['getDomains', 'createDomain', 'configureDomainMailFrom', 'discoverRegion', 'configureRegion', 'provisionRegion', 'listApiKeys', 'revokeApiKey', 'getWorkspaceSettings', 'updateWorkspaceSettings', 'getCampaignState']) assert.ok(!tools.has(removed), removed);
    const context = await callTool(token, 'getContext');
    assert.equal(context.environment, 'test');
    const contentGuide = await callTool(token, 'getContentGuide');
    assert.equal(contentGuide.format, 'markdown');
    assert.match(contentGuide.markdown, /campaign and template content/i);
    assert.match(contentGuide.markdown, /## Personalization/);
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
    assert.equal(unfinished.status, 'draft');
    const editorUrl = new URL(unfinished.url);
    assert.equal(editorUrl.origin, PUBLIC_ORIGIN);
    assert.equal(editorUrl.pathname, `/campaigns/${unfinished.id}/edit`);
    assert.equal(editorUrl.searchParams.get('environment'), 'test');
    assert.equal(editorUrl.searchParams.get('region'), null);
    assert.equal((await callTool(token, 'saveCampaign', draftArgs, 201)).id, unfinished.id);
    assert.equal((await callTool(token, 'findCampaigns', { id: unfinished.id })).data[0].url, unfinished.url);
    assert.equal((await callTool(token, 'findCampaigns', { search: draftName })).data[0].id, unfinished.id);
    const savedDraft = await callTool(token, 'saveCampaign', { action: 'update', id: unfinished.id, body: { revision: unfinished.revision, draft: { name: `${draftName}-edited` } }, confirm: true });
    assert.equal(savedDraft.draft.region, unfinished.draft.region);
    assert.equal(savedDraft.revision, 2);
    error(await http('POST', `/v1/campaigns/${unfinished.id}/review`, MANAGER, { revision: 2 }), 422, 'CAMPAIGN_INCOMPLETE');
    error(await http('POST', `/v1/campaigns/${unfinished.id}/audience-preview`, MANAGER), 422, 'CAMPAIGN_INCOMPLETE');
    error(await http('POST', `/v1/campaigns/${unfinished.id}/test`, MANAGER, { to: address() }), 422, 'CAMPAIGN_RECIPIENT_INVALID');
    error(await http('POST', `/v1/campaigns/${unfinished.id}/send`, MANAGER, { revision: 2, reviewId: 'missing-review' }), 409, 'STALE_CAMPAIGN_REVIEW');
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
    cleanup(t, async () => { ok(await http('PATCH', `/v1/campaigns/${campaign.id}/archive`, MANAGER, { archived: false })); });
    const archived = await callTool(token, 'archiveCampaign', { id: campaign.id, body: { archived: true }, confirm: true });
    assert.equal(typeof archived.archivedAt, 'string');
    assert.deepEqual(archived.draft, detail.draft);
    assert.deepEqual((await callTool(token, 'findCampaigns', { search: campaign.draft.name })).data, []);
    assert.equal((await callTool(token, 'findCampaigns', { search: campaign.draft.name, archived: 'true' })).data[0].id, campaign.id);
    assert.equal((await callTool(token, 'archiveCampaign', { id: campaign.id, body: { archived: false }, confirm: true })).archivedAt, null);

    const temporary = await callTool(token, 'createAgentToken', { body: { permissions: ['read'], environment: 'test', expiresInSeconds: 30, domains: [], purpose: 'Synthetic acceptance script' }, confirm: true }, 201);
    secrets.add(temporary.token);
    assert.equal(ok(await http('GET', '/v1/me', temporary.token)).environment, 'test');
    error(await http('POST', '/v1/agent-tokens', temporary.token, { permissions: ['read'], environment: 'test', expiresInSeconds: 30, domains: [], purpose: 'Forbidden renewal' }), 403, 'MCP_AUTHORIZATION_REQUIRED');
    const managed = await callTool(token, 'createAgentToken', { body: { permissions: ['read', 'manage'], environment: 'test', expiresInSeconds: 30, domains: [], purpose: 'Synthetic managed acceptance script' }, confirm: true }, 201);
    secrets.add(managed.token);
    const managedList = ok(await http('POST', '/v1/lists', managed.token, { name: unique('agent-managed-list') }), 201);
    ok(await http('DELETE', `/v1/lists/${managedList.id}`, managed.token));
    error(await http('GET', '/v1/api-keys', managed.token), 403, 'CREDENTIAL_DELEGATION_FORBIDDEN');
    error(await http('POST', '/v1/api-keys', managed.token, { name: 'Forbidden durable credential', environment: 'live', permissions: ['read'], domains: [] }), 403, 'CREDENTIAL_DELEGATION_FORBIDDEN');
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

  test('hosted MCP read-only OAuth hides writes and revoked consent immediately denies the token', async t => {
    const db = await fixtureDatabase(t);
    const { token, consentId } = await oauthGrant(t, db, 'opensend:read offline_access');
    const catalog = await rpc(token, 'tools/list');
    assert.equal(catalog.tools.length, 10);
    assert.ok(catalog.tools.every((tool: Json) => tool.annotations.readOnlyHint === true));
    assert.ok(catalog.tools.some((tool: Json) => tool.name === 'findContacts'));
    assert.ok(catalog.tools.some((tool: Json) => tool.name === 'findCampaigns'));
    assert.ok(catalog.tools.some((tool: Json) => tool.name === 'getContext'));
    assert.ok(!catalog.tools.some((tool: Json) => tool.name === 'audienceQuery'));
    const list = await resource(t, MANAGER, '/v1/lists', { name: unique('mcp-read-state') });
    const campaign = await campaignFixture(t, MANAGER, { listId: list.id });
    assert.equal((await callTool(token, 'findCampaigns', { id: campaign.id })).data[0].id, campaign.id);
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
    const [{ createApp }, { nodeRuntime }, { drizzle }, { drain }, ses, sns, sts] = await Promise.all([
      import('./src/app.js'), import('./src/adapters/node.js'), import('drizzle-orm/node-postgres'), import('./src/dispatch.js'),
      import('@aws-sdk/client-sesv2'), import('@aws-sdk/client-sns'), import('@aws-sdk/client-sts'),
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
    t.mock.method(ses.SESv2Client.prototype, 'send', provider as any);
    t.mock.method(sns.SNSClient.prototype, 'send', provider as any);
    t.mock.method(sts.STSClient.prototype, 'send', provider as any);
    try {
      await drizzle(db).transaction(async tx => {
        runtime.db = tx;
        await (await import('./src/ses-region-state.js')).ensureRegionSettings(runtime.db, runtime.config);
        async function local(method: string, path: string, body?: Json, key?: string, environment: 'test' | 'live' = 'live'): Promise<Reply> {
          const response = await app.fetch(new Request(`${runtime.config.publicUrl}${path}`, {
            method, headers: { origin: runtime.config.publicUrl, 'x-opensend-environment': environment,
              ...(key ? { authorization: `Bearer ${key}` } : { cookie: manager!.cookie }), ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }), runtime);
          return { status: response.status, body: await response.json(), headers: response.headers };
        }
        async function machine(environment: 'test' | 'live', permissions: string[], domains: string[] = []) {
          return ok(await local('POST', '/v1/api-keys', { name: unique('mock-ses-key'), environment, permissions, domains }), 201).secret as string;
        }
        const testKey = await machine('test', ['read', 'send', 'manage']);
        const reader = await machine('live', ['read']);
        const admin = await machine('live', ['read', 'send', 'manage']);
        const scoped = await machine('live', ['read', 'manage'], ['example.com']);
        const initial = ok(await local('GET', '/v1/regions', undefined, testKey));
        assert.equal(initial.defaultRegion, REGION);
        assert.ok(initial.data.some((row: Json) => row.region === REGION && row.enabled && row.isDefault));
        assert.deepEqual(ok(await local('GET', '/v1/regions', undefined, reader)), initial);
        error(await local('GET', '/v1/regions', undefined, scoped), 403);
        const second = REGION === 'eu-west-1' ? 'us-west-2' : 'eu-west-1';
        error(await local('PUT', `/v1/regions/${second}`, { enabled: true }, testKey), 403);
        error(await local('PUT', `/v1/regions/${second}`, { enabled: true }, reader), 403);
        error(await local('PUT', '/v1/regions/not-a-region', { enabled: true }, admin), 422);
        ok(await local('PUT', `/v1/regions/${second}`, { enabled: true, makeDefault: true }, admin));
        assert.equal(ok(await local('GET', '/v1/regions', undefined, testKey)).defaultRegion, second);
        error(await local('PUT', `/v1/regions/${second}`, { enabled: false }, admin), 409);
        const sent = ok(await local('POST', '/v1/emails/send', { from: 'sender@example.com', to: address(), subject: 'DB-selected region', text: 'Synthetic only' }, testKey), 202);
        assert.equal(ok(await local('GET', `/v1/emails/${sent.id}`, undefined, testKey)).region, second, 'Changing the DB default must affect send without rebuilding the environment.');
        ok(await local('PUT', `/v1/regions/${REGION}`, { makeDefault: true }, admin));
        error(await local('PUT', `/v1/regions/${second}`, { enabled: false }, admin), 409, undefined);
        for (let count = 0; count < 5 && await drain(runtime, 10); count++) { /* Drain only this transaction's unique workspace. */ }
        assert.equal(ok(await local('GET', `/v1/emails/${sent.id}`, undefined, testKey)).status, 'simulated');
        ok(await local('PUT', `/v1/regions/${second}`, { enabled: false }, admin));
        error(await local('POST', '/v1/emails/send', { from: 'sender@example.com', to: address(), region: second, subject: 'Disabled region', text: 'Synthetic only' }, testKey), 422);
        assert.equal(ok(await local('GET', `/v1/emails/${sent.id}`, undefined, testKey)).region, second, 'Disabling a region must not hide its historical email.');
        assert.equal(observed.length, 0, 'Catalog reads/writes and simulated sends must never access AWS.');
        error(await local('GET', `/v1/regions/${REGION}/discovery`, undefined, testKey), 403);
        error(await local('GET', `/v1/regions/${REGION}/discovery`, undefined, scoped), 403);
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: true }, testKey), 403);
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: true }, reader), 403);
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: true }, scoped), 403);
        error(await local('POST', `/v1/regions/${REGION}/provision`, { confirm: false }, admin), 422);
        const originalUrl = runtime.config.publicUrl;
        runtime.config.publicUrl = 'https://ses-acceptance.opensend.dev';
        const blocked = ok(await local('GET', `/v1/regions/${REGION}/discovery`, undefined, reader));
        assert.equal(blocked.status, 'blocked');
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
        await drain(runtime, 10);
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
        await db.query("INSERT INTO operation_domains(id,workspace_id,environment,name,region) VALUES($1,$2,'live','disabled.example.com',$3)", [unique('disabled-domain'), runtime.config.workspaceId, second]);
        const enabledDomains = ok(await local('GET', '/v1/domains', undefined, reader));
        assert.ok(enabledDomains.data.some((domain: Json) => domain.name === 'example.com'));
        assert.ok(enabledDomains.data.every((domain: Json) => domain.region !== second));
        expectedSets = [missing.resources.transactional.name, missing.resources.marketing.name];
        expectedTopic = missing.resources.topic.arn;
        assert.equal(missing.resources.topic.exists, false);
        assert.equal(missing.resources.transactional.exists, false);
        assert.equal(writes().length, 0, 'Discovering missing resources must not create, update, or subscribe anything.');
        await db.query(`UPDATE ses_regions SET report = report #- '{resources,transactional,autoValidation}' #- '{resources,marketing,autoValidation}' WHERE workspace_id = $1 AND region = $2`, [runtime.config.workspaceId, REGION]);
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
        await drain(runtime, 10);
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
          assert.deepEqual([...set.destinations[0].MatchingEventTypes].sort(), ['SEND', 'DELIVERY', 'BOUNCE', 'COMPLAINT', 'REJECT', 'RENDERING_FAILURE', 'DELIVERY_DELAY', 'OPEN', 'CLICK'].sort());
        }
        const validationPath = `/v1/regions/${REGION}/auto-validation`;
        error(await local('PUT', validationPath, { stream: 'transactional', mode: 'high', confirm: true }, testKey), 403);
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
        await drain(runtime, 10);
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
        await drain(runtime, 10);
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

describe('Contacts, explicit consent, and environment isolation', () => {
  test('profiles persist, require manage scope, and cannot implicitly grant marketing consent', async t => {
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const email = address();
    const contact = await resource(t, key.secret, '/v1/contacts', { email, name: 'Before', properties: { plan: 'free' } });
    assert.equal(contact.marketingConsent, 'unknown');
    assert.equal(contact.environment, 'test');
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

  test('test consent changes and resource IDs do not mutate or expose production records', async t => {
    const testKey = await keyFixture(t);
    const liveKey = await keyFixture(t, { environment: 'live' });
    const email = address();
    const liveContact = await resource(t, liveKey.secret, '/v1/contacts', { email, name: unique('production-fixture') });
    const testContact = await resource(t, testKey.secret, '/v1/contacts', { email, name: unique('simulation-fixture') });
    assert.notEqual(liveContact.id, testContact.id);
    assert.equal(liveContact.environment, 'live');
    error(await http('GET', `/v1/contacts/${liveContact.id}`, testKey.secret), 404, 'NOT_FOUND');
    error(await http('PATCH', `/v1/contacts/${liveContact.id}`, testKey.secret, { name: 'Not allowed' }), 404, 'NOT_FOUND');
    error(await http('GET', `/v1/contacts/${testContact.id}`, liveKey.secret), 404, 'NOT_FOUND');
    assert.equal(ok(await consent(testKey.secret, testContact.id, 'unsubscribed')).marketingConsent, 'unsubscribed');
    const production = ok(await http('GET', `/v1/contacts/${liveContact.id}`, liveKey.secret));
    assert.equal(production.marketingConsent, 'unknown');
    assert.equal(production.name, liveContact.name);
    assert.equal(page(await http('GET', `/v1/contacts/${liveContact.id}/consent`, liveKey.secret)).length, 0);
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
  test('test sends have a persisted simulated lifecycle; exact retries reuse identity and conflicts do not create mail', async t => {
    const key = await keyFixture(t);
    const liveKey = await keyFixture(t, { environment: 'live', permissions: ['read'] });
    const payload = mail();
    const headers = { 'Idempotency-Key': unique('send') };
    const queued = ok(await http('POST', '/v1/emails/send', key.secret, payload, headers), 202);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.environment, 'test');
    assert.equal(queued.simulated, true);
    const retry = ok(await http('POST', '/v1/emails/send', key.secret, payload, headers), 202);
    assert.equal(retry.id, queued.id);
    assert.equal(retry.simulated, true);
    error(await http('POST', '/v1/emails/send', key.secret, { ...payload, subject: 'Different payload' }, headers), 409, 'IDEMPOTENCY_CONFLICT');
    const completed = await poll(`/v1/emails/${queued.id}`, key.secret, body => body.status === 'simulated');
    assert.equal(completed.simulated, true);
    assert.equal(completed.environment, 'test');
    assert.equal(completed.providerId, null, 'Simulation must not fabricate a provider message ID.');
    assert.deepEqual(completed.to, [payload.to]);
    assert.equal(completed.subject, payload.subject);
    const content = ok(await http('GET', `/v1/emails/${queued.id}/content`, key.secret));
    assert.equal(content.text, payload.text);
    assert.equal(content.simulated, true);
    const events = page(await http('GET', `/v1/emails/${queued.id}/events`, key.secret));
    assert.equal(events.filter(event => event.type === 'simulated').length, 1, 'Exact retry must not produce another lifecycle event.');
    assert.ok(events.every(event => event.simulated && event.environment === 'test' && event.providerId === null));
    assert.ok(events.every(event => event.type !== 'delivery'), 'Simulation must never be labeled observed SES delivery.');
    error(await http('GET', `/v1/emails/${queued.id}`, liveKey.secret), 404, 'NOT_FOUND');
    const testMetrics = ok(await http('GET', '/v1/metrics', key.secret));
    const liveMetrics = ok(await http('GET', '/v1/metrics', liveKey.secret));
    assert.ok(testMetrics.totals.simulated >= 1, 'Test metrics must count the persisted simulated lifecycle.');
    assert.equal(liveMetrics.totals.simulated, 0, 'Production metrics must exclude test simulations.');
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

  test('batch results retain individual IDs and retries, while test templates never claim live rendering', async t => {
    const key = await keyFixture(t);
    const payload = { emails: [mail(), mail()] };
    const headers = { 'Idempotency-Key': unique('batch') };
    const first = ok(await http('POST', '/v1/emails/batch', key.secret, payload, headers), 202);
    assert.equal(first.data.length, 2);
    assert.equal(new Set(first.data.map((row: Json) => row.id)).size, 2);
    assert.ok(first.data.every((row: Json) => row.simulated && row.environment === 'test'));
    const retry = ok(await http('POST', '/v1/emails/batch', key.secret, payload, headers), 202);
    assert.deepEqual(retry.data.map((row: Json) => row.id), first.data.map((row: Json) => row.id));
    for (const item of first.data) await poll(`/v1/emails/${item.id}`, key.secret, body => body.status === 'simulated');
    error(await http('POST', '/v1/emails/batch', key.secret, { emails: [] }), 422);
    const template = ok(await http('POST', '/v1/emails/send', key.secret, { from: 'sender@example.com', to: address(), region: REGION, template: { name: unique('missing-template'), data: { firstName: '<script>safe</script>' } } }), 202);
    const content = ok(await http('GET', `/v1/emails/${template.id}/content`, key.secret));
    assert.equal(content.render, 'simulated');
    assert.equal(content.simulated, true);
    assert.equal(content.raw, null, 'A test key must not invoke SES to render a real stored template.');
    await poll(`/v1/emails/${template.id}`, key.secret, body => body.status === 'simulated');
  });
});

describe('Private attachment assets and campaign revisions', () => {
  test('uploads persist safe metadata, reject unsafe/oversized inputs, and enforce environment ownership', async t => {
    const key = await keyFixture(t);
    const live = await keyFixture(t, { environment: 'live', permissions: ['read', 'send'] });
    const bytes = Buffer.from('Acceptance attachment\n', 'utf8');
    const attachment = await resource(t, key.secret, '/v1/attachments', { filename: 'acceptance.txt', contentType: 'text/plain', content: bytes.toString('base64') });
    assert.equal(attachment.size, bytes.length);
    assert.equal(attachment.environment, 'test');
    const stored = ok(await http('GET', `/v1/attachments/${attachment.id}`, key.secret));
    assert.equal(stored.filename, 'acceptance.txt');
    assert.equal(stored.size, bytes.length);
    for (const field of ['content', 'url', 'publicUrl', 'storageKey']) assert.equal(stored[field], undefined, `Attachment metadata must not expose ${field}.`);
    error(await http('GET', `/v1/attachments/${attachment.id}`, live.secret), 404, 'ATTACHMENT_NOT_FOUND');
    const reader = await keyFixture(t, { permissions: ['read'] });
    const downloaded = await http('GET', `/v1/attachments/${attachment.id}/content`, reader.secret);
    assert.equal(ok(downloaded).content, bytes.toString('base64'));
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(downloaded.headers.get('cache-control'), 'no-store');
    assert.equal(downloaded.body.storageKey, undefined);
    error(await http('GET', `/v1/attachments/${attachment.id}/content`, live.secret), 404, 'ATTACHMENT_NOT_FOUND');
    error(await http('GET', `/v1/attachments/${attachment.id}/content`), 401, 'AUTH_REQUIRED');
    const liveAsset = await resource(t, live.secret, '/v1/attachments', { filename: 'production-fixture.txt', content: bytes.toString('base64') });
    error(await http('POST', '/v1/emails/send', key.secret, mail({ attachments: [liveAsset.id] })), 404, 'ATTACHMENT_NOT_FOUND');
    error(await http('POST', '/v1/emails/send', key.secret, mail({ attachments: [unique('attachment-missing')] })), 404, 'ATTACHMENT_NOT_FOUND');
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'unsafe.exe', content: bytes.toString('base64') }), 422, 'UNSUPPORTED_ATTACHMENT_TYPE');
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'bad.txt', content: '!!!!' }), 422, 'INVALID_BASE64');
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'inline.png', content: bytes.toString('base64'), disposition: 'inline' }), 422);
    const calendar = Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n');
    const upload = async (filename: string, contentType: string, content: Buffer, extra: Record<string, string> = {}) => {
      const response = await fetch(`${BASE}/v1/attachments/upload`, { method: 'POST', headers: { authorization: `Bearer ${key.secret}`, 'content-type': contentType, 'x-opensend-filename': encodeURIComponent(filename), ...extra }, body: Uint8Array.from(content).buffer });
      return { status: response.status, body: await response.json(), headers: response.headers } satisfies Reply;
    };
    const raw = ok(await upload('invite.ics', 'text/calendar; method=REQUEST; charset=utf-8', calendar), 201);
    cleanup(t, async () => { ok(await http('DELETE', `/v1/attachments/${raw.id}`, key.secret), [200, 404]); });
    assert.equal(raw.contentType, 'text/calendar; method=REQUEST; charset=utf-8');
    assert.equal(ok(await http('GET', `/v1/attachments/${raw.id}/content`, key.secret)).content, calendar.toString('base64'));
    error(await upload('fake.png', 'image/png', bytes), 422, 'ATTACHMENT_CONTENT_INVALID');
    error(await upload('inline.pdf', 'application/pdf', Buffer.from('%PDF-1.7'), { 'x-opensend-disposition': 'inline', 'x-opensend-content-id': 'not-an-image' }), 422, 'INLINE_ATTACHMENT_INVALID');
    // 8 MiB + 1 stays within the base64 character ceiling but exceeds the decoded cap.
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'oversize.txt', content: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }, {}, 10_000), 413, 'ATTACHMENT_LIMIT_EXCEEDED');
    assert.equal(ok(await http('DELETE', `/v1/attachments/${attachment.id}`, key.secret)).deleted, true);
    error(await http('GET', `/v1/attachments/${attachment.id}`, key.secret), 404, 'ATTACHMENT_NOT_FOUND');
  });

  test('draft review, stale revisions, attachment removal, immutable scheduling and cancellation are observable', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('campaign-list') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address(), name: 'Name {{literal}}', properties: { firstName: '<Ada {{ & Bob>' } });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const attachment = await resource(t, key.secret, '/v1/attachments', { filename: 'draft.txt', content: Buffer.from('draft attachment').toString('base64') });
    const campaign = await campaignFixture(t, key.secret, { listId: list.id }, { attachments: [attachment.id], html: '<p>Hello {{name}} / {{firstName}}</p>' });
    assert.equal(campaign.status, 'draft');
    assert.equal(campaign.revision, 1);
    error(await http('DELETE', `/v1/attachments/${attachment.id}`, key.secret), 409, 'ATTACHMENT_IN_USE');
    assert.deepEqual(ok(await http('POST', `/v1/campaigns/${campaign.id}/audience-preview`, key.secret)), { matched: 1, eligible: 1, suppressed: 0, unsubscribed: 0 });
    ok(await http('PATCH', `/v1/contacts/${contact.id}`, key.secret, { properties: { firstName: 'Ada\r\nBcc: victim@example.com' } }));
    const invalidRecipient = error(await http('POST', `/v1/campaigns/${campaign.id}/review`, key.secret, { revision: campaign.revision }), 422, 'CAMPAIGN_RECIPIENT_INVALID');
    assert.equal(invalidRecipient.field, 'contactId');
    assert.ok(invalidRecipient.message.includes(contact.id), 'Invalid rendered subject must identify the affected contact rather than return an internal error.');
    assert.equal(ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret)).status, 'draft');
    ok(await http('PATCH', `/v1/contacts/${contact.id}`, key.secret, { properties: contact.properties }));
    const review = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, key.secret, { revision: campaign.revision }));
    assert.equal(review.eligible, 1);
    assert.equal(review.revision, 1);
    assert.ok(review.contentHash);
    const draft = { ...campaign.draft, subject: 'Revised {{firstName}}', attachments: [] };
    const updated = ok(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: 1, draft }));
    assert.equal(updated.revision, 2);
    assert.equal(updated.status, 'draft');
    assert.equal(updated.reviewId, null);
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: 1, draft }), 409, 'STALE_CAMPAIGN_REVISION');
    error(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: 2, reviewId: review.id, scheduledAt: new Date(Date.now() + 60_000).toISOString() }), 409, 'STALE_CAMPAIGN_REVIEW');
    assert.equal(ok(await http('DELETE', `/v1/attachments/${attachment.id}`, key.secret)).deleted, true);
    const currentReview = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, key.secret, { revision: 2 }));
    assert.notEqual(currentReview.contentHash, review.contentHash);
    error(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: 2, reviewId: currentReview.id, scheduledAt: new Date(Date.now() - 1000).toISOString() }), 422, 'INVALID_SCHEDULE');
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: 2, reviewId: currentReview.id, scheduledAt }), 202);
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.queued, 1);
    assert.equal(scheduled.simulated, true);
    const queued = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].status, 'queued');
    const content = ok(await http('GET', `/v1/emails/${queued[0].id}/content`, key.secret));
    assert.equal(content.subject, 'Revised <Ada {{ & Bob>', 'Literal braces inside a contact value must remain data, not template syntax.');
    assert.ok(content.html.includes('&lt;Ada {{ &amp; Bob&gt;'), 'HTML personalization must preserve literal braces while escaping untrusted values.');
    assert.ok(content.html.includes('Name {{literal}}'), 'A contact name containing literal template-like text must not be interpreted recursively.');
    assert.deepEqual(content.attachments, []);
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: 2, draft }), 409, 'CAMPAIGN_LOCKED');
    const canceled = ok(await http('POST', `/v1/campaigns/${campaign.id}/cancel`, key.secret));
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.canceled, 1);
    assert.equal(canceled.inFlight, 0);
    assert.equal(ok(await http('GET', `/v1/emails/${queued[0].id}`, key.secret)).status, 'canceled');
    assert.equal(ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret)).status, 'canceled');
  });
});

describe('Dashboard API capabilities', () => {
  test('campaign state is compact, scoped and tracks draft review archive and status changes without sending', async t => {
    const db = await fixtureDatabase(t);
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const sender = await keyFixture(t, { permissions: ['send'] });
    const live = await keyFixture(t, { environment: 'live', permissions: ['read'] });
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('state-audience') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const campaign = await campaignFixture(t, key.secret, { listId: list.id }, {
      html: `<p>${'x'.repeat(80 * 1024)}</p>`,
    });
    const path = `/v1/campaigns/${campaign.id}`;
    cleanup(t, async () => {
      await db.query("UPDATE sending_campaigns SET status = 'draft', scheduled_at = NULL, archived_at = NULL WHERE id = $1 AND workspace_id = $2 AND environment = 'test'", [campaign.id, list.workspaceId]);
    });
    const stateFields = ['id', 'environment', 'revision', 'updatedAt', 'status', 'reviewId', 'scheduledAt', 'archivedAt'];
    const project = (value: Json) => Object.fromEntries(stateFields.map(field => [field, value[field]]));
    const initial = await http('GET', `${path}/state`, reader.secret);
    assert.deepEqual(ok(initial), project(campaign));
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.byteLength(JSON.stringify(initial.body)) < 1000, 'Polling must not transfer draft bodies or counts.');
    assert.deepEqual(ok(await http('GET', path, reader.secret)), campaign, 'The full campaign read must remain unchanged.');
    error(await http('GET', `${path}/state`), 401, 'AUTH_REQUIRED');
    error(await http('GET', `${path}/state`, 'not-a-valid-key'), 401);
    error(await http('GET', `${path}/state`, sender.secret), 403, 'PERMISSION_DENIED');
    error(await http('GET', `${path}/state`, live.secret), 404, 'NOT_FOUND');
    error(await http('GET', `/v1/campaigns/${unique('missing')}/state`, reader.secret), 404, 'NOT_FOUND');
    const foreignId = unique('foreign-campaign'), foreignWorkspace = unique('foreign-workspace');
    cleanup(t, async () => { await db.query("DELETE FROM sending_campaigns WHERE id = $1 AND workspace_id = $2 AND environment = 'test'", [foreignId, foreignWorkspace]); });
    await db.query("INSERT INTO sending_campaigns (id, workspace_id, environment, draft) VALUES ($1,$2,'test',$3::jsonb)", [foreignId, foreignWorkspace, JSON.stringify(campaign.draft)]);
    error(await http('GET', `/v1/campaigns/${foreignId}/state`, reader.secret), 404, 'NOT_FOUND');

    const reviewed = ok(await http('POST', `${path}/review`, key.secret, { revision: campaign.revision }));
    const reviewState = ok(await http('GET', `${path}/state`, reader.secret));
    assert.deepEqual(reviewState, project(ok(await http('GET', path, reader.secret))));
    assert.equal(reviewState.revision, campaign.revision);
    assert.equal(reviewState.status, 'reviewed');
    assert.equal(reviewState.reviewId, reviewed.id);
    assert.notDeepEqual(reviewState, initial.body, 'Review changes must be visible even without a draft revision change.');
    const reviewedAgain = ok(await http('POST', `${path}/review`, key.secret, { revision: campaign.revision }));
    const repeatedReviewState = ok(await http('GET', `${path}/state`, reader.secret));
    assert.equal(repeatedReviewState.revision, reviewState.revision);
    assert.equal(repeatedReviewState.status, reviewState.status);
    assert.equal(repeatedReviewState.reviewId, reviewedAgain.id);
    assert.notEqual(repeatedReviewState.reviewId, reviewState.reviewId);
    const archived = ok(await http('PATCH', `${path}/archive`, key.secret, { archived: true }));
    const archivedState = ok(await http('GET', `${path}/state`, reader.secret));
    assert.deepEqual(archivedState, project(archived));
    assert.equal(archivedState.revision, repeatedReviewState.revision);
    assert.equal(archivedState.status, repeatedReviewState.status);
    assert.equal(typeof archivedState.archivedAt, 'string');
    const restored = ok(await http('PATCH', `${path}/archive`, key.secret, { archived: false }));
    assert.deepEqual(ok(await http('GET', `${path}/state`, reader.secret)), project(restored));
    assert.equal(restored.archivedAt, null);
    const updated = ok(await http('PATCH', path, key.secret, { revision: restored.revision, draft: { ...restored.draft, subject: 'Updated externally' } }));
    const updatedState = ok(await http('GET', `${path}/state`, reader.secret));
    assert.deepEqual(updatedState, project(updated));
    assert.equal(updatedState.revision, campaign.revision + 1);
    assert.equal(updatedState.status, 'draft');
    assert.equal(updatedState.reviewId, null);

    // Seed only state, never emails or dispatch jobs, to exercise each delivery lifecycle value.
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    for (const status of ['scheduled', 'sending', 'completed', 'canceled']) {
      const seeded = await db.query("UPDATE sending_campaigns SET status = $1, scheduled_at = $2, updated_at = updated_at + interval '1 second' WHERE id = $3 AND workspace_id = $4 AND environment = 'test' RETURNING id", [status, scheduledAt, campaign.id, list.workspaceId]);
      assert.equal(seeded.rowCount, 1);
      const state = ok(await http('GET', `${path}/state`, reader.secret));
      assert.deepEqual(state, project(ok(await http('GET', path, reader.secret))));
      assert.equal(state.status, status);
      assert.equal(state.revision, updatedState.revision);
      assert.equal(Date.parse(state.scheduledAt), Date.parse(scheduledAt));
      assert.ok(Date.parse(state.updatedAt) > Date.parse(updatedState.updatedAt));
    }
    assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, reader.secret)), []);
  });

  test('campaign content is block HTML: the guide, validation errors, preview rendering and text alternative are observable', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('block-content') });
    const guide = ok(await http('GET', '/v1/campaign-content-guide', key.secret));
    assert.equal(guide.format, 'markdown');
    assert.ok(guide.markdown.includes('data-button') && guide.markdown.includes('data-columns'), 'The guide documents the block vocabulary.');
    const blocks = '<h1>Hello {{name}}</h1><p align="center">Read <a href="https://example.com/{{email}}">this</a>.</p><ul><li>One</li><li><p>Two</p></li></ul><img src="https://cdn.example.com/a.png" alt="Art" width="560"><a data-button href="https://example.com/go" align="center">Go</a><hr><div data-columns="2"><div data-column><p>Left</p></div><div data-column><p>Right</p></div></div>';
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
    ] as const) {
      const rejected = error(await http('PATCH', path, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, html } }), 422, 'CAMPAIGN_CONTENT_INVALID');
      assert.ok(rejected.message.includes(fragment) && rejected.message.includes('getCampaignContentGuide'), `Rejection for ${html} names ${fragment}: ${rejected.message}`);
    }
    error(await http('PATCH', path, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, editor: { format: 'react-email', version: 1, document: {} } } }), 422, 'VALIDATION_FAILED');
    assert.deepEqual(ok(await http('GET', path, key.secret)), campaign, 'Rejected content never changes the draft.');

    const preview = ok(await http('GET', `${path}/preview`, key.secret));
    assert.ok(preview.html.startsWith('<!DOCTYPE html>') && preview.html.includes('max-width:600px'), 'Preview renders a complete styled document.');
    assert.ok(preview.html.includes('Hello {{name}}') && preview.html.includes('href="https://example.com/{{email}}"'), 'Preview keeps placeholders visible.');
    assert.ok(preview.html.includes('role="presentation"') && preview.html.includes('>Go</a>'), 'Buttons and columns render as presentation tables.');
    assert.ok(!preview.html.includes('data-button') && !preview.html.includes('data-columns'), 'Rendered output contains no block markers.');
    assert.ok(!preview.html.includes('Unsubscribe'), 'Preview omits the unsubscribe footer.');
    assert.equal(preview.text, 'Hello {{name}}\n\nRead this (https://example.com/{{email}}).\n\n- One\n- Two\n\n[Art] https://cdn.example.com/a.png\n\nGo: https://example.com/go\n\n----------\n\nLeft\n\nRight');

    const contact = await resource(t, key.secret, '/v1/contacts', { email: address(), name: 'Block Reader' });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const review = ok(await http('POST', `${path}/review`, key.secret, { revision: campaign.revision }));
    ok(await http('POST', `${path}/schedule`, key.secret, { revision: campaign.revision, reviewId: review.id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), 202);
    const [message] = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret));
    const content = ok(await http('GET', `/v1/emails/${message.id}/content`, key.secret));
    assert.ok(content.html.includes('Hello Block Reader') && content.html.includes(`href="https://example.com/${contact.email}"`), 'Rendered email is personalized.');
    assert.ok(/<a href="[^"]+" style="[^"]*">Unsubscribe<\/a><\/p><\/td>/.test(content.html), 'The unsubscribe footer sits inside the rendered layout.');
    assert.ok(content.text.startsWith('Hello Block Reader') && content.text.includes('\n\nUnsubscribe: '), 'A plain-text alternative is derived from the blocks.');
  });

  test('campaign archive filters lists, binds pagination and restores unchanged reviewed drafts', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('archive-audience') });
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const marker = unique('archive');
    const reviewed: Json[] = [];
    for (let index = 0; index < 2; index++) {
      const campaign = await campaignFixture(t, key.secret, { listId: list.id }, { name: `${marker} %_\\literal ${index}` });
      cleanup(t, async () => { ok(await http('PATCH', `/v1/campaigns/${campaign.id}/archive`, key.secret, { archived: false })); });
      assert.equal(campaign.archivedAt, null);
      const revised = ok(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, previewText: 'Retain this revision' } }));
      const review = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, key.secret, { revision: revised.revision }));
      const current = ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret));
      assert.equal(current.reviewId, review.id);
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
      assert.deepEqual({ ...archived, archivedAt: before.archivedAt, updatedAt: before.updatedAt }, before, 'Archive must preserve the complete draft, revision, review, status and counts.');
      assert.deepEqual(ok(await http('PATCH', `${path}/archive`, key.secret, { archived: true })), archived, 'Repeated archive must keep the original timestamp.');
      assert.deepEqual(ok(await http('GET', path, key.secret)), archived);
      assert.deepEqual(ok(await http('POST', `${path}/audience-preview`, key.secret)), { matched: 1, eligible: 1, suppressed: 0, unsubscribed: 0 });
      error(await http('PATCH', path, key.secret, { revision: before.revision, draft: before.draft }), 409, 'CAMPAIGN_ARCHIVED');
      error(await http('DELETE', path, key.secret), 409, 'CAMPAIGN_ARCHIVED');
      error(await http('POST', `${path}/review`, key.secret, { revision: before.revision }), 409, 'CAMPAIGN_ARCHIVED');
      // These calls must reject before queueing, including tests that have no campaignId in their email record.
      error(await http('POST', `${path}/send`, key.secret, { revision: before.revision, reviewId: before.reviewId }), 409, 'CAMPAIGN_ARCHIVED');
      error(await http('POST', `${path}/schedule`, key.secret, { revision: before.revision, reviewId: before.reviewId, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), 409, 'CAMPAIGN_ARCHIVED');
      error(await http('POST', `${path}/test`, key.secret, { to: contact.email }), 409, 'CAMPAIGN_ARCHIVED');
      assert.deepEqual(page(await http('GET', `/v1/emails?campaignId=${before.id}`, key.secret)), []);
      assert.deepEqual(ok(await http('GET', path, key.secret)), archived, 'Rejected writes must leave the archived record intact.');
    }
    assert.deepEqual(page(await http('GET', `/v1/emails?search=${encodeURIComponent(contact.email)}`, key.secret)), [], 'Archived send, schedule and test must not queue any recipient email.');
    for (const suffix of ['', '&archived=false', '&status=draft', `&region=${REGION}`]) {
      assert.deepEqual(page(await http('GET', `${activePath}${suffix}`, key.secret)).map(row => row.id), [visible.id]);
    }
    const query = new URLSearchParams({ search: `${marker} %_\\literal`, status: 'reviewed', region: REGION, archived: 'true', limit: '1' });
    const first = await http('GET', `/v1/campaigns?${query}`, key.secret);
    assert.equal(page(first).length, 1);
    assert.equal(typeof first.body.nextCursor, 'string');
    query.set('cursor', first.body.nextCursor);
    const second = await http('GET', `/v1/campaigns?${query}`, key.secret);
    assert.equal(page(second).length, 1);
    assert.equal(second.body.nextCursor, null);
    const summaries = [...first.body.data, ...second.body.data];
    assert.deepEqual(summaries.map((row: Json) => row.id).sort(), reviewed.map(row => row.id).sort());
    assert.ok(summaries.every((row: Json) => typeof row.archivedAt === 'string' && row.status === 'reviewed' && row.draft.region === REGION && row.draft.html === undefined));
    for (const [filter, value] of [['archived', 'false'], ['status', 'draft'], ['search', marker], ['region', REGION === 'us-east-1' ? 'us-west-2' : 'us-east-1']]) {
      const changed = new URLSearchParams(query);
      changed.set(filter, value);
      error(await http('GET', `/v1/campaigns?${changed}`, key.secret), 422, 'INVALID_CURSOR');
    }
    assert.deepEqual(page(await http('GET', `${activePath}&archived=true&status=draft`, key.secret)), []);
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
    const live = await keyFixture(t, { environment: 'live', permissions: ['read', 'send'] });
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('archive-guards') });
    const campaign = await campaignFixture(t, key.secret, { listId: list.id });
    const path = `/v1/campaigns/${campaign.id}`;
    cleanup(t, async () => {
      ok(await http('PATCH', `${path}/archive`, key.secret, { archived: false }));
      await db.query("UPDATE sending_campaigns SET status = 'draft' WHERE id = $1 AND workspace_id = $2 AND environment = 'test'", [campaign.id, list.workspaceId]);
    });
    for (const body of [{}, { archived: 'true' }, { archived: null }, { archived: 1 }, { archived: true, revision: 1 }]) error(await http('PATCH', `${path}/archive`, key.secret, body), 422);
    for (const value of ['1', 'TRUE', 'all', '']) error(await http('GET', `/v1/campaigns?archived=${value}`, key.secret), 422);
    error(await http('PATCH', `${path}/archive`, undefined, { archived: true }), 401);
    error(await http('PATCH', `/v1/campaigns/${unique('missing')}/archive`, key.secret, { archived: true }), 404, 'NOT_FOUND');
    for (const archived of [true, false]) {
      error(await http('PATCH', `${path}/archive`, reader.secret, { archived }), 403, 'PERMISSION_DENIED');
      error(await http('PATCH', `${path}/archive`, restricted.secret, { archived }), 403, 'SENDER_DOMAIN_FORBIDDEN');
      error(await http('PATCH', `${path}/archive`, live.secret, { archived }), 404, 'NOT_FOUND');
    }
    assert.deepEqual(ok(await http('GET', path, key.secret)), campaign, 'Invalid or unauthorized requests must not change the campaign.');
    const archived = ok(await http('PATCH', `${path}/archive`, sender.secret, { archived: true }));
    assert.equal(typeof archived.archivedAt, 'string', 'Send permission alone is sufficient to archive.');
    assert.deepEqual(ok(await http('GET', path, reader.secret)), archived);
    assert.deepEqual(ok(await http('POST', `${path}/audience-preview`, reader.secret)), { matched: 0, eligible: 0, suppressed: 0, unsubscribed: 0 });
    error(await http('GET', path, live.secret), 404, 'NOT_FOUND');
    assert.deepEqual(page(await http('GET', `/v1/campaigns?archived=true&search=${campaign.id}`, live.secret)), []);
    assert.equal(ok(await http('PATCH', `${path}/archive`, sender.secret, { archived: false })).archivedAt, null);
    // Seed a terminal synthetic log and event, never a dispatch job, to verify nonzero counts and retained history.
    const emailId = unique('archive-email'), eventId = unique('archive-event');
    const snapshot = { from: campaign.draft.from, to: [address()], cc: [], bcc: [], replyTo: [], region: REGION, kind: 'marketing', subject: 'Synthetic archive history', text: 'Retained without sending.', attachments: [], tracking: false, headers: [] };
    cleanup(t, async () => {
      await db.query("DELETE FROM sending_email_events WHERE id = $1 AND email_id = $2 AND workspace_id = $3 AND environment = 'test'", [eventId, emailId, list.workspaceId]);
      await db.query("DELETE FROM sending_emails WHERE id = $1 AND campaign_id = $2 AND workspace_id = $3 AND environment = 'test'", [emailId, campaign.id, list.workspaceId]);
    });
    await db.query(`INSERT INTO sending_emails (id, workspace_id, environment, region, actor_key_id, campaign_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, status, snapshot, simulated)
      VALUES ($1,$2,'test',$3,$4,$5,$6,$7::jsonb,'[]','[]',$8,'simulated',$9::jsonb,true)`, [emailId, list.workspaceId, REGION, key.id, campaign.id, snapshot.from, JSON.stringify(snapshot.to), snapshot.subject, JSON.stringify(snapshot)]);
    await db.query(`INSERT INTO sending_email_events (id, workspace_id, environment, email_id, type, data, simulated)
      VALUES ($1,$2,'test',$3,'simulated','{"synthetic":true}',true)`, [eventId, list.workspaceId, emailId]);
    const email = ok(await http('GET', `/v1/emails/${emailId}`, key.secret));
    const content = ok(await http('GET', `/v1/emails/${emailId}/content`, key.secret));
    const history = page(await http('GET', `/v1/emails/${emailId}/events`, key.secret));
    assert.equal(history.length, 1);
    // Scoped terminal/active states exercise guards without scheduling or sending email.
    for (const status of ['scheduled', 'sending', 'completed', 'canceled']) {
      const seeded = await db.query("UPDATE sending_campaigns SET status = $1 WHERE id = $2 AND workspace_id = $3 AND environment = 'test' RETURNING id", [status, campaign.id, list.workspaceId]);
      assert.equal(seeded.rowCount, 1);
      const before = ok(await http('GET', path, key.secret));
      assert.equal(before.status, status);
      assert.equal(before.counts.total, 1);
      assert.equal(before.counts.byStatus.simulated, 1);
      if (['scheduled', 'sending'].includes(status)) {
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

  test('dashboard campaign metadata survives review revisions and produces escaped immutable snapshots with real status counts', async t => {
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
    const review = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, key.secret, { revision: campaign.revision }));
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, html: '<section><p>Not a block</p></section>' } }), 422, 'CAMPAIGN_CONTENT_INVALID');
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, fromName: 'Name\r\nBcc: victim@example.com' } }), 422);
    assert.equal(ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret)).reviewId, review.id, 'Invalid metadata must not invalidate or mutate the existing revision.');
    const revised = ok(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: { ...campaign.draft, previewText: `${previewText}!` } }));
    assert.equal(revised.reviewId, null);
    error(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: revised.revision, reviewId: review.id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), 409, 'STALE_CAMPAIGN_REVIEW');
    const finalReview = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, key.secret, { revision: revised.revision }));
    assert.notEqual(finalReview.contentHash, review.contentHash);
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: revised.revision, reviewId: finalReview.id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), 202);
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
    error(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: revised.revision, draft: { ...revised.draft, previewText: 'Too late' } }), 409, 'CAMPAIGN_LOCKED');
    assert.equal(ok(await http('GET', `/v1/emails/${messages[0].id}/content`, key.secret)).html, content.html);
    for (const expected of ['queued', 'canceled']) {
      if (expected === 'canceled') ok(await http('POST', `/v1/campaigns/${campaign.id}/cancel`, key.secret));
      const current = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret));
      const counts = ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret)).counts;
      assert.equal(counts.total, current.length);
      assert.equal(Object.values(counts.byStatus).reduce<number>((sum, value) => sum + Number(value), 0), counts.total);
      for (const [status, count] of Object.entries(counts.byStatus)) assert.equal(count, current.filter(row => row.status === status).length);
      assert.equal(counts.byStatus[expected], 1);
    }
  });

  test('dashboard email queries bind literal search, kind, region, time and cursors while cohort metrics deduplicate event replays', async t => {
    const db = await fixtureDatabase(t);
    const key = await keyFixture(t);
    const live = await keyFixture(t, { environment: 'live', permissions: ['read'] });
    const marker = unique('query');
    const from = new Date(Date.now() - 1000).toISOString();
    const ids: string[] = [];
    for (const suffix of ['%_\\literal', 'ZZZliteral', '%_\\literal newest']) {
      const queued = ok(await http('POST', '/v1/emails/send', key.secret, mail({ subject: `${marker} ${suffix}`, fromName: 'Élodie 日本語' })), 202);
      ids.push(queued.id);
      await poll(`/v1/emails/${queued.id}`, key.secret, row => row.status === 'simulated');
    }
    error(await http('POST', '/v1/emails/send', key.secret, mail({ fromName: 'Name\nBcc: victim@example.com' })), 422);
    const contact = await resource(t, key.secret, '/v1/contacts', { email: address() });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    const marketing = ok(await http('POST', '/v1/emails/send', key.secret, mail({ to: contact.email, kind: 'marketing', subject: `${marker} marketing` })), 202);
    await poll(`/v1/emails/${marketing.id}`, key.secret, row => row.status === 'simulated');
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
    error(await http('GET', `/v1/emails?${query}`, live.secret), 422, 'INVALID_CURSOR');
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
    const before = ok(await http('GET', `/v1/metrics?${metricQuery}`, key.secret));
    assert.equal(before.basis, 'created-cohort');
    assert.equal(before.region, REGION);
    assert.equal(before.stream, 'transactional');
    assert.ok(before.totals.emails >= 3);
    assert.equal(before.totals.accepted, 0, 'Simulated mail is not provider acceptance.');
    assert.equal(before.daily.reduce((sum: number, day: Json) => sum + day.count, 0), before.totals.emails);
    const matched = await db.query('SELECT id FROM sending_emails WHERE id = $1 AND workspace_id = $2 AND environment = $3 AND actor_key_id = $4', [ids[0], contact.workspaceId, 'test', key.id]);
    assert.equal(matched.rowCount, 1, 'Only an exact HTTP-created scoped email can receive synthetic replay source events.');
    const events = [unique('cohort-click'), unique('cohort-click-replay')];
    cleanup(t, async () => { for (const id of events) await db.query('DELETE FROM operation_events WHERE id = $1 AND workspace_id = $2 AND environment = $3', [id, contact.workspaceId, 'test']); });
    for (const id of events) await db.query('INSERT INTO operation_events (id, workspace_id, environment, type, region, data, created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)', [id, contact.workspaceId, 'test', 'email.clicked', REGION, JSON.stringify({ emailId: ids[0], synthetic: true }), new Date(Date.parse(to) + 3_600_000)]);
    const after = ok(await http('GET', `/v1/metrics?${metricQuery}`, key.secret));
    assert.equal(after.totals.clicked, before.totals.clicked + 1, 'Two source events for one email count once, even when observed after the cohort end.');
    assert.equal(after.totals.emails, before.totals.emails);
    assert.equal(after.totals.accepted, 0);
    assert.equal(ok(await http('GET', `/v1/metrics?${metricQuery}`, live.secret)).totals.clicked, 0, 'Synthetic test events cannot leak into live metrics.');
  });

  test('dashboard audience memberships and list counts partition active consent and suppression without scope leaks', async t => {
    const db = await fixtureDatabase(t);
    const key = await keyFixture(t);
    const live = await keyFixture(t, { environment: 'live', permissions: ['read'] });
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('partition-list') });
    const other = await resource(t, key.secret, '/v1/lists', { name: unique('other-list') });
    const members: Json[] = [];
    for (let index = 0; index < 4; index++) members.push(await resource(t, key.secret, '/v1/contacts', { email: address(), name: `Partition ${index}` }));
    ok(await consent(key.secret, members[1].id, 'subscribed'));
    ok(await consent(key.secret, members[2].id, 'unsubscribed'));
    ok(await consent(key.secret, members[3].id, 'subscribed'));
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: members.map(row => row.id) }));
    ok(await http('POST', `/v1/lists/${other.id}/members`, key.secret, { contactIds: [members[0].id] }));
    const suppression = await db.query('UPDATE audience_contacts SET suppressed = true, suppression_reason = $1 WHERE id = $2 AND workspace_id = $3 AND environment = $4 AND email = $5 AND marketing_consent = $6 AND suppressed = false RETURNING id', ['synthetic-acceptance-source', members[3].id, list.workspaceId, 'test', members[3].email, 'subscribed']);
    assert.equal(suppression.rowCount, 1, 'Synthetic suppression must match the exact HTTP-created subscribed contact.');
    cleanup(t, async () => { await db.query('UPDATE audience_contacts SET suppressed = false, suppression_reason = NULL WHERE id = $1 AND workspace_id = $2 AND environment = $3', [members[3].id, list.workspaceId, 'test']); });
    const expected = { total: 4, subscribed: 1, unsubscribed: 1, unknown: 1, suppressed: 1 };
    assert.deepEqual(ok(await http('GET', `/v1/lists/${list.id}`, key.secret)).counts, expected);
    assert.deepEqual(page(await http('GET', `/v1/lists?search=${encodeURIComponent(list.name)}`, key.secret))[0].counts, expected);
    const contacts = page(await http('GET', `/v1/contacts?listId=${list.id}`, key.secret));
    assert.equal(contacts.length, 4);
    for (const row of contacts) assert.deepEqual(row.listIds, (row.id === members[0].id ? [list.id, other.id] : [list.id]).sort());
    assert.deepEqual(ok(await http('GET', `/v1/contacts/${members[0].id}`, key.secret)).listIds, [list.id, other.id].sort());
    assert.deepEqual(page(await http('GET', `/v1/contacts?listId=${list.id}&consent=subscribed&suppressed=false`, key.secret)).map(row => row.id), [members[1].id]);
    assert.deepEqual(page(await http('GET', `/v1/contacts?listId=${list.id}&suppressed=true`, key.secret)).map(row => row.id), [members[3].id]);
    error(await http('GET', `/v1/lists/${list.id}`, live.secret), 404, 'NOT_FOUND');
    error(await http('GET', `/v1/contacts/${members[0].id}`, live.secret), 404, 'NOT_FOUND');
    ok(await http('DELETE', `/v1/contacts/${members[0].id}`, key.secret));
    assert.deepEqual(ok(await http('GET', `/v1/lists/${list.id}`, key.secret)).counts, { ...expected, total: 3, unknown: 0 });
    assert.deepEqual(ok(await http('GET', `/v1/lists/${other.id}`, key.secret)).counts, { total: 0, subscribed: 0, unsubscribed: 0, unknown: 0, suppressed: 0 });
  });
});

describe('Bounded campaign admission', () => {
  test('expanded content and 101 pending test recipients fail atomically; exactly 100 fit and cancellation releases capacity', async t => {
    const key = await keyFixture(t);
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('pending-boundary') });
    // One small CSV plus sequential consent writes exercises the real API without
    // a high-concurrency load test, private fixtures, or fabricated consent in SQL.
    const addresses = Array.from({ length: 101 }, () => address());
    const preview = ok(await http('POST', '/v1/contact-imports', key.secret, {
      csv: `Email\n${addresses.join('\n')}\n`, mapping: { email: 'Email' }, listId: list.id,
    }), 201);
    assert.equal(preview.errors.length, 0);
    assert.equal(ok(await http('POST', `/v1/contact-imports/${preview.id}/commit`, key.secret)).imported, 101);
    const contacts = await allPages(`/v1/lists/${list.id}/members`, key.secret);
    assert.equal(contacts.length, 101);
    for (const contact of contacts) cleanup(t, async () => { ok(await http('DELETE', `/v1/contacts/${contact.id}`, key.secret), [200, 404]); });
    for (const contact of contacts) ok(await consent(key.secret, contact.id, 'subscribed'));

    const expansionList = await resource(t, key.secret, '/v1/lists', { name: unique('expanded-budget') });
    ok(await http('POST', `/v1/lists/${expansionList.id}/members`, key.secret, { contactIds: contacts.slice(0, 34).map(contact => contact.id) }));
    // The body remains below 512 KiB. Thirty-four recipients expand a 500 KiB
    // HTML part beyond the 16 MiB test budget from a request smaller than 10 KiB.
    const expansion = await campaignFixture(t, key.secret, { listId: expansionList.id }, {
      subject: 'Bounded expansion', html: `<p>${'{{chunk}}'.repeat(256)}</p>`, defaults: { chunk: 'x'.repeat(2000) },
    });
    const before = ok(await http('GET', '/v1/metrics?stream=marketing', key.secret)).totals.emails;
    error(await http('POST', `/v1/campaigns/${expansion.id}/review`, key.secret, { revision: expansion.revision }, {}, 15_000), 413, 'EXPANDED_CAMPAIGN_TOO_LARGE');
    const rejectedExpansion = ok(await http('GET', `/v1/campaigns/${expansion.id}`, key.secret));
    assert.equal(rejectedExpansion.status, 'draft');
    assert.equal(rejectedExpansion.reviewId, null);
    assert.equal(page(await http('GET', `/v1/emails?campaignId=${expansion.id}`, key.secret)).length, 0);
    assert.equal(ok(await http('GET', '/v1/metrics?stream=marketing', key.secret)).totals.emails, before, 'Rejected expansion must not create partial email metrics.');

    const campaign = await campaignFixture(t, key.secret, { listId: list.id });
    const review = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, key.secret, { revision: campaign.revision }, {}, 15_000));
    assert.equal(review.eligible, 101);
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const denied = error(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, {
      revision: campaign.revision, reviewId: review.id, scheduledAt,
    }, {}, 15_000), 429, 'PENDING_EMAIL_LIMIT_EXCEEDED');
    assert.equal(denied.retryable, true);
    const rejectedAdmission = ok(await http('GET', `/v1/campaigns/${campaign.id}`, key.secret));
    assert.equal(rejectedAdmission.status, 'reviewed');
    assert.equal(rejectedAdmission.reviewId, review.id);
    assert.equal(rejectedAdmission.scheduledAt, null);
    assert.equal(page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret)).length, 0);
    assert.equal(ok(await http('GET', '/v1/metrics?stream=marketing', key.secret)).totals.emails, before, 'Rejected admission must leave the email counter unchanged.');
    ok(await http('DELETE', `/v1/lists/${list.id}/members/${contacts[0].id}`, key.secret));
    const revised = ok(await http('PATCH', `/v1/campaigns/${campaign.id}`, key.secret, { revision: campaign.revision, draft: campaign.draft }));
    const atLimit = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, key.secret, { revision: revised.revision }, {}, 15_000));
    assert.equal(atLimit.eligible, 100);
    const scheduled = ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, {
      revision: revised.revision, reviewId: atLimit.id, scheduledAt,
    }, {}, 15_000), 202);
    assert.equal(scheduled.queued, 100, 'The failed 101-recipient admission must not reserve any of the key’s 100 available slots.');
    const queued = await allPages(`/v1/emails?campaignId=${campaign.id}`, key.secret);
    assert.equal(queued.length, 100);
    assert.ok(queued.every(message => message.status === 'queued' && message.environment === 'test' && message.providerId === null));
    error(await http('POST', '/v1/emails/send', key.secret, mail()), 429, 'PENDING_EMAIL_LIMIT_EXCEEDED');
    assert.equal(ok(await http('POST', `/v1/campaigns/${campaign.id}/cancel`, key.secret)).canceled, 100);
    const released = ok(await http('POST', '/v1/emails/send', key.secret, mail()), 202);
    assert.equal((await poll(`/v1/emails/${released.id}`, key.secret, body => body.status === 'simulated')).providerId, null);
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
    const review = ok(await http('POST', `/v1/campaigns/${valid.id}/review`, key.secret, { revision: valid.revision }));
    ok(await http('POST', `/v1/campaigns/${valid.id}/schedule`, key.secret, {
      revision: valid.revision, reviewId: review.id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    }), 202);
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
    error(await http('POST', `/v1/campaigns/${unsafeUrl.id}/review`, key.secret, { revision: unsafeUrl.revision }), 422, 'UNSAFE_HTML_URL');
    assert.equal(ok(await http('GET', `/v1/campaigns/${unsafeUrl.id}`, key.secret)).status, 'draft');
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
    assert.equal(unchanged.status, 'draft');
    assert.equal(unchanged.revision, campaign.revision);
    assert.deepEqual(unchanged.draft, campaign.draft);
    const review = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, owner.secret, { revision: campaign.revision }));
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, owner.secret, {
      revision: campaign.revision, reviewId: review.id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    }), 202);
    error(await http('POST', `/v1/campaigns/${campaign.id}/cancel`, restricted.secret), 403, 'SENDER_DOMAIN_FORBIDDEN');
    assert.equal(ok(await http('GET', `/v1/campaigns/${campaign.id}`, owner.secret)).status, 'scheduled');
    const messages = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, owner.secret));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].status, 'queued', 'Unauthorized cancellation must not touch already queued messages.');
    assert.equal(messages[0].from, 'sender@example.com');
  });

  test('revoking the originating test send key stops its future scheduled job before simulation or SES acceptance', async t => {
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
    const review = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, origin.secret, { revision: campaign.revision }));
    const dueAt = Date.now() + 3_000;
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, origin.secret, {
      revision: campaign.revision, reviewId: review.id, scheduledAt: new Date(dueAt).toISOString(),
    }), 202);
    const messages = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, reader.secret));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].status, 'queued');
    assert.equal(messages[0].environment, 'test');
    ok(await http('POST', `/v1/api-keys/${origin.id}/revoke`, MANAGER), [200, 204]);
    assert.ok(Date.now() < dueAt, 'Revocation must finish before the scheduled job becomes due; otherwise this scenario cannot prove a dispatch-time credential check.');
    const blocked = await poll(`/v1/emails/${messages[0].id}`, reader.secret, body => ['canceled', 'suppressed'].includes(body.status));
    assert.equal(blocked.errorCode, 'ORIGIN_KEY_REVOKED');
    assert.equal(blocked.providerId, null);
    assert.equal(blocked.attemptStartedAt, null, 'Revoked credentials must be checked before attempting dispatch.');
    assert.equal(blocked.simulated, true);
    const events = page(await http('GET', `/v1/emails/${messages[0].id}/events`, reader.secret));
    assert.ok(!events.some(event => ['accepted', 'send', 'sent', 'delivery', 'simulated'].includes(event.type)), 'Revoked-origin work must never reach SES acceptance or even a successful test simulation.');
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, reader.secret)).marketingConsent, 'subscribed', 'This failure must come from revocation, not a consent change.');
  });
});

describe('Hosted unsubscribe and dispatch-time consent', () => {
  test('footer GET and provider POST are idempotent, private, environment-isolated, and block queued marketing but not transactional mail', async t => {
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const live = await keyFixture(t, { environment: 'live' });
    const email = address();
    const contact = await resource(t, key.secret, '/v1/contacts', { email });
    const production = await resource(t, live.secret, '/v1/contacts', { email });
    ok(await consent(key.secret, contact.id, 'subscribed'));
    const list = await resource(t, key.secret, '/v1/lists', { name: unique('unsubscribe') });
    ok(await http('POST', `/v1/lists/${list.id}/members`, key.secret, { contactIds: [contact.id] }));
    const campaign = await campaignFixture(t, key.secret, { listId: list.id });
    const review = ok(await http('POST', `/v1/campaigns/${campaign.id}/review`, key.secret, { revision: campaign.revision }));
    const dueAt = Date.now() + 5_000;
    ok(await http('POST', `/v1/campaigns/${campaign.id}/schedule`, key.secret, { revision: campaign.revision, reviewId: review.id, scheduledAt: new Date(dueAt).toISOString() }, { 'x-forwarded-host': 'attacker.invalid' }), 202);
    const queued = page(await http('GET', `/v1/emails?campaignId=${campaign.id}`, key.secret));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].status, 'queued');
    const content = ok(await http('GET', `/v1/emails/${queued[0].id}/content`, key.secret));
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
    const redacted = ok(await http('GET', `/v1/emails/${queued[0].id}/content`, reader.secret));
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
    const first = await http('GET', path);
    const html = ok(first);
    assert.match(first.headers.get('content-type') ?? '', /text\/html/);
    assert.match(first.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(/unsubscribed/i.test(html) && !/<form\b/i.test(html), 'A single footer navigation must complete unsubscribe, not show a confirmation form.');
    assert.ok(!html.includes(email), 'Hosted confirmation must not disclose the recipient address.');
    assert.equal(ok(await http('GET', path)), html);
    assert.equal(ok(await http('POST', path, undefined, 'List-Unsubscribe=One-Click', { 'content-type': 'application/x-www-form-urlencoded' })), html);
    assert.equal(ok(await http('GET', `/v1/contacts/${contact.id}`, key.secret)).marketingConsent, 'unsubscribed');
    assert.equal(ok(await http('GET', `/v1/contacts/${production.id}`, live.secret)).marketingConsent, 'unknown');
    const audit = page(await http('GET', `/v1/contacts/${contact.id}/consent`, key.secret));
    assert.equal(audit.filter(row => row.source === 'footer-get' && row.status === 'unsubscribed').length, 1, 'The footer navigation must be attributed to footer-get, not provider one-click consent.');
    assert.equal(audit.filter(row => row.status === 'unsubscribed').length, 1, 'Repeated GET and POST capability use must not duplicate or rewrite the original consent decision.');
    const last = path.at(-1)!;
    const tampered = `${path.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    const invalid = error(await http('GET', tampered), 404, 'NOT_FOUND');
    const unknown = error(await http('GET', `/unsubscribe/u_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`), 404, 'NOT_FOUND');
    assert.equal(invalid.message, unknown.message, 'Tampered and nonexistent tokens must have indistinguishable public errors.');
    assert.ok(!JSON.stringify(invalid).includes(email) && !JSON.stringify(unknown).includes(email));
    const blocked = await poll(`/v1/emails/${queued[0].id}`, key.secret, body => body.status === 'suppressed');
    assert.equal(blocked.providerId, null);
    assert.equal(blocked.simulated, true);
    const campaignEvents = page(await http('GET', `/v1/emails/${queued[0].id}/events`, key.secret));
    assert.ok(campaignEvents.some(event => event.type === 'suppressed'));
    assert.ok(!campaignEvents.some(event => ['accepted', 'delivery', 'simulated'].includes(event.type)), 'Opt-out must be checked before even simulated marketing dispatch.');
    const transactional = ok(await http('POST', '/v1/emails/send', key.secret, mail({ to: email })), 202);
    assert.equal((await poll(`/v1/emails/${transactional.id}`, key.secret, body => body.status === 'simulated')).status, 'simulated');
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
    assert.equal(audit.filter(row => row.source === 'footer-get').length, 0);
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
    await poll(`/v1/emails/${queued.id}`, manager.secret, body => body.status === 'simulated');
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
      JOIN api_keys k ON k.id = e.actor_key_id AND k.workspace_id = e.workspace_id AND k.environment = e.environment
      JOIN operation_webhooks w ON w.workspace_id = e.workspace_id AND w.environment = e.environment
      WHERE e.id = $1 AND e.workspace_id = $2 AND e.environment = $3 AND e.actor_key_id = $4
        AND w.id = $5 AND w.paused = true AND w.url = $6`,
    [queued.id, contact.workspaceId, 'test', manager.id, endpoint.id, endpoint.url]);
    assert.equal(matched.rowCount, 1, 'API_FIXTURE_DATABASE_MISMATCH: no matching HTTP-created email/key/paused endpoint; no synthetic rows were inserted.');
    const eventId = unique('acceptance-click');
    const operationId = unique('acceptance-operation');
    const deliveryId = unique('acceptance-delivery');
    const data = { emailId: queued.id, link: capabilityUrl, nested: { links: [capabilityUrl, { link: capabilityUrl }], label: 'ordinary click metadata', [`key-${token}`]: token }, values: [7, true, null] };
    const payload = { id: operationId, type: 'email.clicked', createdAt: new Date().toISOString(), workspaceId: contact.workspaceId, environment: 'test', region: REGION, data };
    // Only event-source arrangement uses SQL: no SNS signature claim, provider
    // request, dispatch job, or webhook callback is manufactured or performed.
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO sending_email_events (id, workspace_id, environment, email_id, type, data, simulated)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`, [eventId, contact.workspaceId, 'test', queued.id, 'click', JSON.stringify(data), true]);
      await db.query(`INSERT INTO operation_events (id, workspace_id, environment, type, region, data, created_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`, [operationId, contact.workspaceId, 'test', payload.type, REGION, JSON.stringify(data), payload.createdAt]);
      await db.query(`INSERT INTO operation_deliveries (id, workspace_id, environment, webhook_id, event_id, payload, synthetic, status)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`, [deliveryId, contact.workspaceId, 'test', endpoint.id, operationId, JSON.stringify(payload), true, 'paused']);
      await db.query('COMMIT');
    } catch (cause) {
      await db.query('ROLLBACK');
      throw cause;
    }
    cleanup(t, async () => {
      await db.query('DELETE FROM operation_deliveries WHERE id = $1 AND workspace_id = $2 AND environment = $3 AND webhook_id = $4 AND event_id = $5', [deliveryId, contact.workspaceId, 'test', endpoint.id, operationId]);
      await db.query('DELETE FROM operation_events WHERE id = $1 AND workspace_id = $2 AND environment = $3', [operationId, contact.workspaceId, 'test']);
      await db.query('DELETE FROM sending_email_events WHERE id = $1 AND workspace_id = $2 AND environment = $3 AND email_id = $4', [eventId, contact.workspaceId, 'test', queued.id]);
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

  test('a test key at its seeded 600-request budget receives HTTP 429 and recovers after its own budget resets', { skip: DATABASE_FIXTURE_SKIP }, async t => {
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
      ON k.id = e.actor_key_id AND k.workspace_id = e.workspace_id AND k.environment = e.environment
      WHERE e.id = $1 AND e.workspace_id = $2 AND e.environment = $3 AND k.id = $4`, [queued.id, contact.workspaceId, 'test', key.id]);
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
        RETURNING window_start`, [contact.workspaceId, key.id, 600]);
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
  test('workspace settings persist independently and test keys cannot touch real SES domains or readiness', async t => {
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const live = await keyFixture(t, { environment: 'live', permissions: ['read'] });
    const before = ok(await http('GET', '/v1/settings/workspace', key.secret));
    const liveBefore = ok(await http('GET', '/v1/settings/workspace', live.secret));
    cleanup(t, async () => { ok(await http('PATCH', '/v1/settings/workspace', key.secret, { name: before.name })); });
    const name = unique('acceptance-workspace');
    assert.equal(ok(await http('PATCH', '/v1/settings/workspace', key.secret, { name })).name, name);
    assert.equal(ok(await http('GET', '/v1/settings/workspace', reader.secret)).name, name);
    assert.equal(ok(await http('GET', '/v1/settings/workspace', live.secret)).name, liveBefore.name);
    error(await http('PATCH', '/v1/settings/workspace', reader.secret, { name: 'Forbidden' }), 403, 'PERMISSION_DENIED');
    error(await http('GET', '/v1/settings/ses', key.secret), 403, 'TEST_EXTERNAL_OPERATION');
    const catalog = ok(await http('GET', '/v1/regions', key.secret));
    assert.equal(typeof catalog.defaultRegion, 'string');
    assert.ok(catalog.data.some((entry: Json) => entry.region === catalog.defaultRegion && entry.enabled && entry.isDefault));
    error(await http('GET', '/v1/domains', key.secret), 403, 'TEST_EXTERNAL_OPERATION');
    error(await http('POST', '/v1/domains', key.secret, { name: `${unique('acceptance')}.example.com`, region: REGION }), 403, 'TEST_EXTERNAL_OPERATION');
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
    const recipient = address(), topicArn = `arn:aws:sns:${REGION}:${runtime.config.awsAccountId}:synthetic-validation`;
    const snapshot = { from: 'sender@example.com', to: [recipient], cc: [], bcc: [], replyTo: [], region: REGION, kind: 'marketing', subject: 'Synthetic validation', text: 'Synthetic only', attachments: [], tracking: false, headers: [] };
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO audience_contacts(id,workspace_id,environment,email,marketing_consent) VALUES($1,$2,'live',$3,'subscribed')`, [contactId, runtime.config.workspaceId, recipient]);
      await db.query(`INSERT INTO sending_emails(id,workspace_id,environment,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,status,provider_id,snapshot,simulated)
        VALUES($1,$2,'live',$3,'worker','sender@example.com',$4::jsonb,'[]'::jsonb,'[]'::jsonb,'Synthetic validation','sent',$5,$6::jsonb,false)`, [emailId, runtime.config.workspaceId, REGION, JSON.stringify([recipient]), providerId, JSON.stringify(snapshot)]);
      await db.query(`INSERT INTO operation_sns_receipts(topic_arn,message_id,workspace_id,environment) VALUES($1,$2,$3,'live')`, [topicArn, messageId, runtime.config.workspaceId]);
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
    } }, { id: unique('validation-job'), attempts: 1, workspaceId: runtime.config.workspaceId, environment: 'live' });
    const contact = (await db.query('SELECT suppressed, suppression_reason FROM audience_contacts WHERE id=$1', [contactId])).rows[0];
    assert.deepEqual(contact, { suppressed: true, suppression_reason: 'email_validation' });
    const event = (await db.query("SELECT data FROM sending_email_events WHERE email_id=$1 AND type='bounce'", [emailId])).rows[0];
    assert.equal(event.data.bounceType, 'Permanent');
    assert.equal(event.data.bounceSubType, 'EmailValidationSuppressed');
  });

  test('webhook configuration rejects SSRF targets, defaults to seven events, and protects rotatable signing secrets without making deliveries', async t => {
    const key = await keyFixture(t);
    const reader = await keyFixture(t, { permissions: ['read'] });
    const live = await keyFixture(t, { environment: 'live' });
    // These fixtures are always paused. Never invoke /test or delivery /retry:
    // no public HTTP callback is authorized by the ordinary acceptance suite.
    const endpoint = await resource(t, key.secret, '/v1/webhooks', { url: `https://example.com/hooks/${unique('acceptance')}`, paused: true });
    const defaults = ['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed'];
    assert.deepEqual([...endpoint.eventTypes].sort(), defaults.sort());
    assert.equal(endpoint.paused, true);
    assert.equal(endpoint.regions, null);
    for (const url of ['http://example.com/hook', 'https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/hook', 'https://localhost/hook', 'https://user:password@example.com/hook', 'https://example.com:8443/hook']) {
      error(await http('POST', '/v1/webhooks', key.secret, { url, paused: true }), 422, 'INVALID_WEBHOOK_URL');
    }
    error(await http('PATCH', `/v1/webhooks/${endpoint.id}`, key.secret, { url: 'https://localhost/private' }), 422, 'INVALID_WEBHOOK_URL');
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
    error(await http('GET', `/v1/webhooks/${endpoint.id}`, live.secret), 404, 'NOT_FOUND');
    assert.equal(page(await http('GET', `/v1/webhooks/${endpoint.id}/deliveries`, key.secret)).length, 0);
    assert.equal(ok(await http('DELETE', `/v1/webhooks/${endpoint.id}`, key.secret)).deleted, true);
    error(await http('GET', `/v1/webhooks/${endpoint.id}`, key.secret), 404, 'NOT_FOUND');
  });

  test('unsigned or untrusted SNS envelopes fail publicly without trusting arbitrary certificate URLs', async () => {
    const envelope = {
      Type: 'Notification', MessageId: unique('sns'), TopicArn: `arn:aws:sns:${REGION}:000000000000:acceptance-untrusted`,
      Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: unique('forged') } }),
      Timestamp: new Date().toISOString(), SignatureVersion: '2', Signature: Buffer.from('forged').toString('base64'),
      SigningCertURL: 'https://127.0.0.1/never-fetch-this.pem',
    };
    error(await http('POST', '/v1/events/ses', undefined, envelope), 403, 'SNS_TOPIC_NOT_ALLOWED');
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
    const [{ createServer }, { once }, { createApp }, { nodeRuntime }, { drizzle }, { drain }, regional, { setupResources }, { sesRegions }] = await Promise.all([
      import('node:http'), import('node:events'), import('./src/app.js'), import('./src/adapters/node.js'), import('drizzle-orm/node-postgres'),
      import('./src/dispatch.js'), import('./src/ses-region-state.js'), import('./src/ses-setup.js'), import('./src/db/ses-regions.js'),
    ]);
    const requests: Array<{ path: string; method: string }> = [];
    // Real loopback 302 responses exercise fetch's redirect behavior. No AWS or
    // public webhook endpoint is contacted, even if redirect refusal regresses.
    const server = createServer((request, response) => {
      requests.push({ path: request.url!, method: request.method! });
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
      const path = request.url === certUrl ? '/certificate' : request.url === webhookUrl ? '/webhook' : undefined;
      assert.ok(path, `Unexpected transport origin: ${new URL(request.url).origin}`);
      return nativeFetch(`${loopback}${path}`, { method: request.method, headers: request.headers,
        ...(request.method === 'POST' ? { body: await request.text() } : {}), redirect: request.redirect, signal: request.signal });
    });
    const db = await fixtureDatabase(t);
    const instance = nodeRuntime({ DATABASE_URL: FIXTURE_DATABASE_URL, BETTER_AUTH_SECRET: AUTH_SECRET,
      GOOGLE_CLIENT_ID: 'synthetic-redirect-client', GOOGLE_CLIENT_SECRET: 'synthetic-redirect-secret', AUTH_ALLOWED_EMAILS: AUTH_EMAIL,
      PUBLIC_URL: PUBLIC_ORIGIN, DEFAULT_SES_REGION: REGION, ENABLE_LIVE_SES: 'false', WEBHOOK_ALLOWED_HOSTS: 'example.com',
      S3_BUCKET: 'synthetic-redirect-fixture', S3_ACCESS_KEY_ID: 'synthetic-storage-id', S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret' });
    cleanup(t, instance.close);
    const runtime = instance.runtime;
    runtime.config.workspaceId = unique('redirect-workspace');
    const app = createApp();
    const rollback = new Error('Rollback isolated redirect acceptance fixtures');
    try {
      await drizzle(db).transaction(async tx => {
        runtime.db = tx;
        await regional.ensureRegionSettings(runtime.db, runtime.config);
        const settings = await regional.getRegionSettings(runtime.db, runtime.config.workspaceId);
        const topicArn = `arn:aws:sns:${REGION}:111122223333:${setupResources(settings.installationId).topicName}`;
        await tx.insert(sesRegions).values({ workspaceId: runtime.config.workspaceId, region: REGION, trustedAccountId: '111122223333', trustedTopicArn: topicArn });
        async function local(method: string, path: string, body?: Json): Promise<Reply> {
          const response = await app.fetch(new Request(`${PUBLIC_ORIGIN}${path}`, { method,
            headers: { origin: PUBLIC_ORIGIN, cookie: manager!.cookie, 'x-opensend-environment': 'test', ...(body ? { 'content-type': 'application/json' } : {}) },
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

        const endpoint = ok(await local('POST', '/v1/webhooks', { url: webhookUrl, paused: true }), 201);
        // These rows never commit: the external runner cannot see or deliver this
        // synthetic endpoint test. Only this normal drain uses the loopback transport.
        const queued = ok(await local('POST', `/v1/webhooks/${endpoint.id}/test`), 202);
        assert.equal(await drain(runtime), 1);
        const delivery = ok(await local('GET', `/v1/webhooks/${endpoint.id}/deliveries/${queued.id}`));
        assert.equal(delivery.status, 'pending');
        assert.equal(delivery.lastStatusCode, 302);
        assert.equal(delivery.lastError, 'WEBHOOK_HTTP_ERROR');
        assert.equal(delivery.attemptCount, 1);
        assert.equal(delivery.attempts.length, 1);
        assert.equal(delivery.attempts[0].statusCode, 302);
        assert.equal(delivery.attempts[0].error, 'WEBHOOK_HTTP_ERROR');
        const jobs = await db.query("SELECT status, attempts, last_error, available_at > now() AS delayed FROM jobs WHERE workspace_id = $1 AND type = 'operation.webhook'", [runtime.config.workspaceId]);
        assert.deepEqual(jobs.rows, [{ status: 'pending', attempts: 1, last_error: 'WEBHOOK_HTTP_ERROR', delayed: true }]);
        assert.deepEqual(requests, [{ path: '/certificate', method: 'GET' }, { path: '/webhook', method: 'POST' }], 'Neither 302 may contact the redirect target.');
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
  const key = await keyFixture(t, { environment: 'live', permissions: ['read', 'send'], domains: [from.split('@')[1]] });
  const queued = ok(await http('POST', '/v1/emails/send', key.secret, {
    from, to, region: process.env.SES_TEST_REGION ?? REGION,
    subject: unique('OpenSend authorized live acceptance'), text: 'One explicitly authorized OpenSend acceptance email. Provider acceptance is not a delivery claim.', kind: 'transactional',
  }, { 'Idempotency-Key': unique('authorized-live') }), 202);
  assert.equal(queued.environment, 'live');
  assert.equal(queued.simulated, false);
  const accepted = await poll(`/v1/emails/${queued.id}`, key.secret, body => typeof body.providerId === 'string' && body.providerId.length > 0);
  assert.equal(accepted.simulated, false);
  assert.ok(['accepted', 'sent', 'delivered', 'bounced', 'complained', 'delayed'].includes(accepted.status), 'A provider ID alone must not conceal an explicit failed or ambiguous send.');
});
