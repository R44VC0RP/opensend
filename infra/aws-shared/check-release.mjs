// Operator-only, after making a new version default. Never installs a candidate.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, parseEnv } from 'node:util';

const [candidate, fallback] = process.argv.slice(2);
if (process.argv.length !== 4 || ![candidate, fallback].every(v => /^v[1-9]\d*$/.test(v)) || +fallback.slice(1) >= +candidate.slice(1)) {
  console.error('Usage: node check-release.mjs <newly active version> <previous known-good version>');
  process.exit(2);
}
const account = '438095551154', region = 'us-east-2', arn = `arn:aws:iam::${account}:policy/opensend-mx`;
const origin = 'https://opensend.mx', name = 'iam-check.testing.mx.vogel.dev', fixture = 'dom_97087da408314135a3f6278da0e1aa80';
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop.abort(new Error(`Interrupted by ${signal}`)));
let key, createdId, armed = false;
function check(ok, message) { if (!ok) throw new Error(message); }
function aws(args, allowMissingIdentity = false) {
  const result = spawnSync('aws', ['--profile', 'anomaly', '--region', region, '--no-cli-pager', '--output', 'json', ...args], { encoding: 'utf8', timeout: 30_000 });
  if (allowMissingIdentity && result.status !== 0 && /\(NotFoundException\)/.test(result.stderr ?? '')) return null;
  check(result.status === 0, `aws ${args.slice(0, 2).join(' ')} failed (${result.status ?? 'timeout or unavailable'})`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}
const current = () => aws(['iam', 'get-policy', '--policy-arn', arn, '--query', 'Policy.DefaultVersionId']);
const version = (id, field) => aws(['iam', 'get-policy-version', '--policy-arn', arn, '--version-id', id, '--query', `PolicyVersion.${field}`]);
// Never print get-email-identity output, tags, dotenv values or API response bodies.
const identity = () => aws(['sesv2', 'get-email-identity', '--email-identity', name, '--query', "length(Tags[?Key=='opensend:domain-claim'])"], true);
async function observeIdentity(expected) {
  for (const ms of [0, 1000, 2000, 3000]) {
    await delay(ms, undefined, { signal: stop.signal });
    if (identity() === expected) return;
  }
  throw new Error(`SES did not confirm ${expected === null ? 'removal' : 'creation with the claim tag'} of ${name}`);
}
async function api(path, method = 'GET', body, cleanup = false) {
  const timeout = AbortSignal.timeout(20_000);
  const res = await fetch(origin + path, { method, redirect: 'error', signal: cleanup ? timeout : AbortSignal.any([stop.signal, timeout]),
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  const code = data?.error?.code;
  check(res.status === (method === 'POST' ? 201 : 200), `${method} ${path.split('?')[0]}: HTTP ${res.status}${/^[A-Z_]{1,80}$/.test(code) ? ` ${code}` : ''}`);
  return data;
}
async function deleteOwned(cleanup = false) {
  const result = await api(`/v1/domains/${createdId}`, 'DELETE', undefined, cleanup);
  check(result?.deleted === true, 'Canary deletion not acknowledged');
  createdId = undefined;
}
try {
  check(aws(['sts', 'get-caller-identity', '--query', 'Account']) === account, 'Wrong operator account');
  check(version(fallback, 'VersionId') === fallback, 'Known-good version unavailable');
  check(current() === candidate, 'Candidate is not default: refusing to test or change IAM');
  armed = true;
  const expected = JSON.parse(readFileSync(new URL('./runtime-policy.json', import.meta.url), 'utf8').replaceAll('YOUR_AWS_ACCOUNT_ID', account));
  check(isDeepStrictEqual(version(candidate, 'Document'), expected), 'Active candidate does not match this checkout');
  key = parseEnv(readFileSync(`${homedir()}/.config/opensend-mx/e2e.env`, 'utf8')).OPENSEND_E2E_API_KEY;
  check(typeof key === 'string' && /^[\x21-\x7E]+$/.test(key), 'Missing or invalid OPENSEND_E2E_API_KEY');
  const me = await api('/v1/me');
  check(me?.multiTenant && me.simulated === false && me.origin === origin && me.connection?.kind === 'shared' && me.connection.region === region && me.connection.state === 'ready' && me.connection.tenant === 'ready', 'Not the live, ready Ohio Hosted connection');
  const domain = await api(`/v1/domains/${fixture}`);
  check(domain?.id === fixture && domain.name === 'e2e.opensend.mx' && domain.region === region, 'Wrong E2E workspace');
  let cursor; const seen = new Set();
  do {
    const query = new URLSearchParams({ region, refresh: 'false', limit: '10', ...(cursor ? { cursor } : {}) });
    const page = await api(`/v1/domains?${query}`);
    check(!page.data.some(row => row.name === name), 'Canary already claimed; refusing to adopt or delete it');
    cursor = page.nextCursor;
    check(!cursor || !seen.has(cursor), 'Domain cursor repeated'); seen.add(cursor);
  } while (cursor);
  check(identity() === null, 'SES identity already exists; refusing to adopt or delete it');
  const created = await api('/v1/domains', 'POST', { name, region });
  check(created?.name === name && created.region === region && /^dom_[0-9a-f]{32}$/.test(created.id), 'Unexpected canary create response');
  createdId = created.id;
  await observeIdentity(1);
  await deleteOwned();
  await observeIdentity(null);
  console.log('Hosted domain canary passed; running full live E2E');
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/e2e.ts'], { cwd: new URL('../../api/', import.meta.url), stdio: 'inherit',
    env: { ...process.env, OPENSEND_E2E_URL: origin, OPENSEND_E2E_API_KEY: key }, signal: stop.signal, timeout: 300_000 });
  const [status] = await once(child, 'close');
  check(status === 0, `Live E2E failed (${status ?? 'signal'})`);
  check(current() === candidate, 'Default changed during release check');
  stop.signal.throwIfAborted();
  console.log(`Policy ${candidate} passed domain create/delete and full E2E`);
} catch (error) {
  console.error(`Release check failed: ${error.message}`); process.exitCode = 1;
  if (armed) {
    try {
      const active = current();
      if (active === candidate) aws(['iam', 'set-default-policy-version', '--policy-arn', arn, '--version-id', fallback]);
      else check(active === fallback, `Default is now ${active}; refusing to overwrite another release`);
      check(current() === fallback, `Could not verify rollback to ${fallback}`);
      console.error(`Rollback confirmed: ${fallback} is default`);
      if (createdId) await deleteOwned(true);
    } catch (e) { console.error(`Operator attention required: ${e.message}${createdId ? `; inspect canary ${createdId}` : ''}`); }
  }
}
