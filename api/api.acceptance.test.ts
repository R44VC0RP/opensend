import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Run against the actual server and its normal background-job runner:
// ADMIN_API_KEY=... API_BASE_URL=http://127.0.0.1:8787 npx tsx --test api.acceptance.test.ts
// This file deliberately imports no implementation and creates no helper fixtures on disk.
const BASE = (process.env.API_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const ADMIN = process.env.ADMIN_API_KEY;
if (!ADMIN) throw new Error('Acceptance tests require ADMIN_API_KEY for the running API; no scenarios were run.');
// Do not send credentials to an unrelated service occupying the configured port.
const probe = await fetch(`${BASE}/health`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
const identity = await probe.json().catch(() => null) as { service?: string } | null;
if (!probe.ok || identity?.service !== 'opensend' || !probe.headers.get('x-request-id')) throw new Error('API_TARGET_MISMATCH: API_BASE_URL is not an OpenSend API. No authenticated scenarios were run.');
const secrets = new Set<string>([ADMIN]);
const unique = (prefix: string) => `${prefix}-${randomUUID().replaceAll('-', '')}`;
const address = () => `${unique('acceptance')}@example.com`;
const REGION = process.env.API_TEST_REGION ?? 'us-east-1';
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
async function http(method: string, path: string, key?: string, body?: unknown, headers: Record<string, string> = {}, timeout = 5_000): Promise<Reply> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
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
  const body = ok(await http('POST', '/v1/api-keys', ADMIN, {
    name: unique('acceptance'), environment: options.environment ?? 'test',
    permissions: options.permissions ?? ['read', 'send', 'manage'], domains: options.domains ?? [],
  }), 201);
  assert.equal(typeof body.id, 'string');
  assert.equal(typeof body.secret, 'string', 'API-key creation must return the secret exactly once.');
  assert.ok(body.secret.startsWith(options.environment === 'live' ? 'os_live_' : 'os_test_'), 'Key prefix must identify its environment.');
  secrets.add(body.secret);
  cleanup(t, async () => { ok(await http('POST', `/v1/api-keys/${body.id}/revoke`, ADMIN), [200, 204]); });
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
    const health = ok(await http('GET', '/health'));
    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'opensend');
    const document = ok(await http('GET', '/openapi.json'));
    assert.match(document.openapi, /^3\./);
    assert.ok(document.info?.title);
    assert.ok(document.paths && Object.keys(document.paths).length > 0);
    const contract: Record<string, string[]> = {
      '/v1/api-keys': ['get', 'post'], '/v1/api-keys/{id}/revoke': ['post'],
      '/v1/contacts': ['get', 'post'], '/v1/contacts/{id}': ['get', 'patch', 'delete'],
      '/v1/contacts/{id}/consent': ['get', 'post'],
      '/v1/contact-imports': ['get', 'post'], '/v1/contact-imports/{id}/commit': ['post'],
      '/v1/lists': ['get', 'post'], '/v1/lists/{id}/members': ['get', 'post'],
      '/v1/segments': ['get', 'post'], '/v1/segments/{id}/preview': ['post'],
      '/v1/emails/send': ['post'], '/v1/emails/batch': ['post'], '/v1/emails': ['get'],
      '/v1/emails/{id}': ['get'], '/v1/emails/{id}/content': ['get'], '/v1/emails/{id}/events': ['get'],
      '/v1/attachments': ['post'], '/v1/attachments/{id}': ['get', 'delete'],
      '/v1/campaigns': ['get', 'post'], '/v1/campaigns/{id}': ['get', 'patch', 'delete'],
      '/v1/campaigns/{id}/review': ['post'], '/v1/campaigns/{id}/schedule': ['post'], '/v1/campaigns/{id}/cancel': ['post'],
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

  test('bootstrap creates scoped keys, listing never discloses secrets, revocation blocks reuse', async t => {
    const key = await keyFixture(t, { permissions: ['read'] });
    const rows = await allPages('/v1/api-keys', ADMIN);
    const saved = rows.find(row => row.id === key.id);
    assert.ok(saved, 'Newly created API key must be visible in the key list.');
    for (const row of rows) {
      assert.equal(row.secret, undefined, 'API-key listing must never return a secret.');
      assert.equal(row.hash, undefined, 'API-key listing must never return credential hashes.');
      assert.equal(row.secretHash, undefined, 'API-key listing must never return credential hashes.');
    }
    page(await http('GET', '/v1/contacts', key.secret));
    error(await http('POST', '/v1/api-keys', key.secret, { name: unique('forbidden'), environment: 'test', permissions: ['manage'], domains: [] }), 403);
    ok(await http('POST', `/v1/api-keys/${key.id}/revoke`, ADMIN), [200, 204]);
    error(await http('GET', '/v1/contacts', key.secret), 401);
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
    error(await http('POST', `/v1/contacts/${contact.id}/consent`, key.secret, { status: 'subscribed' }), 422);
    assert.equal(ok(await consent(key.secret, contact.id, 'subscribed')).marketingConsent, 'subscribed');
    assert.equal(ok(await consent(key.secret, contact.id, 'unsubscribed')).marketingConsent, 'unsubscribed');
    error(await consent(key.secret, contact.id, 'subscribed'), 409, 'RESUBSCRIBE_CONFIRMATION_REQUIRED');
    const audit = page(await http('GET', `/v1/contacts/${contact.id}/consent`, key.secret));
    assert.equal(audit.length, 2);
    assert.deepEqual(audit.map((row: Json) => row.status).sort(), ['subscribed', 'unsubscribed']);
    assert.ok(audit.every((row: Json) => row.source === 'acceptance-fixture' && row.evidence && row.policyVersion === 'acceptance-v1'));
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
    const liveAsset = await resource(t, live.secret, '/v1/attachments', { filename: 'production-fixture.txt', content: bytes.toString('base64') });
    error(await http('POST', '/v1/emails/send', key.secret, mail({ attachments: [liveAsset.id] })), 404, 'ATTACHMENT_NOT_FOUND');
    error(await http('POST', '/v1/emails/send', key.secret, mail({ attachments: [unique('attachment-missing')] })), 404, 'ATTACHMENT_NOT_FOUND');
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'unsafe.exe', content: bytes.toString('base64') }), 422, 'UNSUPPORTED_ATTACHMENT_TYPE');
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'bad.txt', content: '!!!!' }), 422, 'INVALID_BASE64');
    error(await http('POST', '/v1/attachments', key.secret, { filename: 'inline.png', content: bytes.toString('base64'), disposition: 'inline' }), 422);
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

describe('Hosted unsubscribe and dispatch-time consent', () => {
  test('footer GET and provider POST are idempotent, private, environment-isolated, and block queued marketing but not transactional mail', async t => {
    const key = await keyFixture(t);
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
    assert.equal(audit.filter(row => row.source === 'hosted-unsubscribe' && row.status === 'unsubscribed').length, 1, 'Repeated capability use must not duplicate the consent decision.');
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
    error(await http('GET', '/v1/regions', key.secret), 403, 'TEST_EXTERNAL_OPERATION');
    error(await http('GET', '/v1/domains', key.secret), 403, 'TEST_EXTERNAL_OPERATION');
    error(await http('POST', '/v1/domains', key.secret, { name: `${unique('acceptance')}.example.com`, region: REGION }), 403, 'TEST_EXTERNAL_OPERATION');
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
    // Topic authorization is checked before certificate/signature work, even for malformed signatures.
    error(await http('POST', '/v1/events/ses', undefined, { ...envelope, Signature: '!!!' }), 403, 'SNS_TOPIC_NOT_ALLOWED');
  });
});

// This is the only deliberate skip. Enabling it authorizes one real SES email,
// not a campaign or webhook delivery. Missing explicit recipient/from is a failure.
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
