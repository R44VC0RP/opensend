// Operator only. Candidate and companions must already exist, INACTIVE / UNATTACHED.
// Arm before the first IAM mutation, not after a human changes the default.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { account, names, render } from './runtime-policies.mjs';

const [candidate, fallback, manifest] = process.argv.slice(2);
if (process.argv.length !== 5 || !/^v[1-9]\d*$/.test(candidate) || +candidate.slice(1) < 8 || fallback !== 'v7') {
  console.error('Usage: node check-release.mjs <inactive candidate v8 or later> v7 <attested-adopted-arns.json>');
  process.exit(2);
}
const documents = render(manifest), [primary, ...companions] = names;
const adopted = documents[primary].Statement.find(s => s.Sid === 'ProtectAdoptedIdentities').Resource;
const ohio = 'us-east-2', virginia = 'us-east-1', regions = [ohio, virginia];
const user = 'opensend-mx', principal = `arn:aws:iam::${account}:user/${user}`, arn = name => `arn:aws:iam::${account}:policy/${name}`;
const origin = 'https://opensend.mx', domain = 'iam-check.testing.mx.vogel.dev', fixtureId = 'dom_1aa89a5a687348e89699f5cd97f5496b';
const run = randomUUID(), key = process.env.OPENSEND_E2E_API_KEY, stop = new AbortController();
const tags = {'opensend:owner': 'mx', 'opensend:installation-id': 'opensend-mx:pool', 'opensend:purpose': 'domain-identity', 'opensend:domain-claim': run};
let armed = false, activationAttempted = false, iamWritePending = false, createdId, pendingIdentity;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop.abort(new Error(`Interrupted by ${signal}`)));
function check(ok, msg) { if (!ok) throw new Error(msg); }
function aws(args, region = ohio, profile = 'anomaly', missing) {
  const r = spawnSync('aws', ['--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager', ...args], {
    encoding: 'utf8', timeout: 30_000, env: {...process.env, AWS_MAX_ATTEMPTS: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true'},
  });
  if (r.status !== 0 && missing && missing.test(r.stderr || '')) return null;
  check(r.status === 0, `${profile}: ${args.slice(0, 2).join(' ')} in ${region} failed (${r.status ?? 'timeout/unavailable'})`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
}
const iam = (...args) => aws(['iam', ...args]);
const current = (name = primary) => iam('get-policy', '--policy-arn', arn(name), '--query', 'Policy.DefaultVersionId');
const version = (name, id) => iam('get-policy-version', '--policy-arn', arn(name), '--version-id', id, '--query', 'PolicyVersion.Document');
const setDefault = id => iam('set-default-policy-version', '--policy-arn', arn(primary), '--version-id', id);
const attached = () => iam('list-attached-user-policies', '--user-name', user, '--query', 'AttachedPolicies[].PolicyArn').sort();
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const v7Digest = 'bbf2d65755a262da7e263245d355bdf03617f440fd251b7da5961f7af3615de6'; // canonical policy at 7527783, including terminal LF
const missing = /\(NotFoundException\)/;
const identity = (region, name = domain) => aws(['sesv2', 'get-email-identity', '--email-identity', name, '--query', 'Tags'], region, 'anomaly', missing);
const runtime = (args, region) => aws(args, region, 'opensend-mx-runtime');
async function until(label, probe, ms = 60_000) {
  const end = Date.now() + ms;
  do { stop.signal.throwIfAborted(); if (await probe()) return; await delay(1500, undefined, {signal: stop.signal}); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
async function api(path, method = 'GET', body, status = [200], cleanup = false) {
  const timeout = AbortSignal.timeout(20_000);
  const res = await fetch(origin + path, {method, redirect: 'error', signal: cleanup ? timeout : AbortSignal.any([timeout, stop.signal]),
    headers: {Authorization: `Bearer ${key}`, ...(body && {'Content-Type': 'application/json', 'Idempotency-Key': `${run}:${body.region || 'domain'}`})}, body: body && JSON.stringify(body)});
  check(status.includes(res.status), `${method} ${path.split('?')[0]}: HTTP ${res.status}`);
  return res.json(); // Never print API bodies, credential values or identity metadata.
}
async function findDomains(region) {
  const rows = [], cursors = new Set(); let cursor;
  do {
    const q = new URLSearchParams({...(region && {region}), refresh: 'false', limit: '10', ...(cursor && {cursor})});
    const page = await api(`/v1/domains?${q}`); rows.push(...page.data); cursor = page.nextCursor;
    check(!cursor || !cursors.has(cursor), 'Repeated domain cursor'); cursors.add(cursor);
  } while (cursor);
  return rows;
}
function checkIreland() {
  const region = 'eu-west-1', read = (...args) => aws(args, region);
  const owned = n => /^(?:opensend-mx-|opensend-ws_|opensendmx-)/.test(n);
  const sets = read('sesv2', 'list-configuration-sets').ConfigurationSets ?? [];
  const tenants = read('sesv2', 'list-tenants').Tenants ?? [];
  const topics = read('sns', 'list-topics').Topics ?? [];
  const rules = read('ses', 'list-receipt-rule-sets').RuleSets ?? [];
  const ids = read('sesv2', 'list-email-identities').EmailIdentities ?? [];
  check(!sets.some(owned) && !tenants.some(t => owned(t.TenantName)) && !topics.some(t => owned(t.TopicArn.split(':').at(-1))) && !rules.some(t => owned(t.Name)), 'Ireland has potential Hosted resources; inventory/drain before removing access');
  for (const r of rules) check(!(read('ses', 'describe-receipt-rule-set', '--rule-set-name', r.Name).Rules ?? []).some(rule => owned(rule.Name)), 'Ireland has a possible Hosted receipt rule');
  for (const i of ids) check(!(read('sesv2', 'get-email-identity', '--email-identity', i.IdentityName, '--query', 'Tags') ?? []).some(t => t.Key === 'opensend:domain-claim' || t.Key === 'opensend:owner' && t.Value === 'mx'), 'Ireland has a possible Hosted identity');
  check(!read('s3api', 'list-buckets', '--query', 'Buckets[].Name').includes(`opensend-mx-${account}-mail-${region}`), 'Ireland mailbox bucket still exists');
}
function decision(region, actions, resources, verdict, context = {}) {
  const entries = Object.entries({'aws:RequestedRegion': region, ...context}).map(([ContextKeyName, value]) => ({ContextKeyName, ContextKeyValues: Array.isArray(value) ? value : [value], ContextKeyType: Array.isArray(value) ? 'stringList' : 'string'}));
  const results = iam('simulate-principal-policy', '--policy-source-arn', principal, '--action-names', ...actions, '--resource-arns', ...resources, '--context-entries', JSON.stringify(entries)).EvaluationResults;
  const rows = results.flatMap(x => x.ResourceSpecificResults?.length ? x.ResourceSpecificResults.map(y => ({EvalActionName: x.EvalActionName, EvalResourceName: y.EvalResourceName, EvalDecision: y.EvalResourceDecision})) : [x]);
  check(actions.every(a => resources.every(r => rows.some(x => x.EvalActionName.toLowerCase() === a.toLowerCase() && x.EvalResourceName === r && verdict.includes(x.EvalDecision)))), `Unexpected effective IAM decision: ${actions.join(', ')} (${region})`);
}
function boundaries(workspace) {
  const legacy = 'opensend-042df6f752eaa1f62cb8', denied = ['implicitDeny', 'explicitDeny'];
  decision(virginia, ['ses:CreateReceiptRule', 'ses:UpdateReceiptRule', 'ses:SetActiveReceiptRuleSet', 'ses:DeleteReceiptRule'], ['*'], ['explicitDeny']);
  decision(ohio, ['ses:CreateReceiptRule', 'ses:UpdateReceiptRule'], ['*'], ['allowed']);
  decision(ohio, ['ses:CreateReceiptRuleSet', 'ses:SetActiveReceiptRuleSet', 'ses:DescribeReceiptRuleSet'], ['*'], denied);
  decision(virginia, ['s3:PutBucketPolicy'], [`arn:aws:s3:::opensend-mx-${account}-mail-${virginia}`], ['explicitDeny']);
  for (const r of regions) {
    const ses = `arn:aws:ses:${r}:${account}:configuration-set/`, sns = `arn:aws:sns:${r}:${account}:`;
    const tenant = r === ohio ? `opensend-${workspace}` : `opensendmx-trusted-${workspace}`;
    decision(r, ['ses:GetConfigurationSet', 'ses:UpdateConfigurationSetEventDestination'], [ses + legacy + '-transactional'], ['explicitDeny']);
    decision(r, ['sns:SetTopicAttributes', 'sns:SetSubscriptionAttributes'], [sns + legacy + '-feedback'], ['explicitDeny']);
    decision(r, ['ses:SendEmail'], [ses + legacy + '-marketing'], ['explicitDeny'], {'ses:TenantName': tenant, 'ses:ApiVersion': '2'});
    decision(r, ['ses:GetConfigurationSet'], [ses + 'foreign-set', `arn:aws:ses:${r}:111122223333:configuration-set/opensendmx-trusted-transactional`], denied);
    decision(r, ['sns:SetTopicAttributes'], [sns + 'foreign-feedback'], denied);
    const actual = ses + (r === ohio ? 'opensend-mx' : 'opensendmx-trusted') + '-transactional';
    decision(r, ['ses:SendEmail'], [actual], denied, {'ses:ApiVersion': '2'}); // absent tenant
    decision(r, ['ses:SendEmail'], [actual], denied, {'ses:ApiVersion': '2', 'ses:TenantName': tenant, 'ses:MultiRegionEndpointId': 'canary.global'});
  }
  const ctx = {'aws:ResourceTag/opensend:owner': 'mx', 'aws:ResourceTag/opensend:installation-id': 'opensend-mx:pool', 'aws:ResourceTag/opensend:purpose': 'domain-identity', 'aws:ResourceTag/opensend:domain-claim': run};
  decision(virginia, ['ses:PutEmailIdentityMailFromAttributes', 'ses:DeleteEmailIdentity', 'ses:TagResource', 'ses:CreateTenantResourceAssociation'], adopted, ['explicitDeny'], ctx);
}
function ownedIdentity({region, name}) {
  const result = identity(region, name);
  if (result === null) return false;
  check(isDeepStrictEqual(Object.fromEntries(result.map(t => [t.Key, t.Value])), tags), 'Canary identity has unexpected tags; never adopt or delete');
  return true;
}
async function disposable(region) {
  const name = `opensendmx-iam-canary-${run}.${region}.testing.mx.vogel.dev`;
  check(identity(region, name) === null, `${region}: canary identity already exists`);
  pendingIdentity = {region, name, deleteAttempted: false}; // Includes ambiguous creates. Never retry create or delete by name alone.
  runtime(['sesv2', 'create-email-identity', '--email-identity', name, '--dkim-signing-attributes', 'NextSigningKeyLength=RSA_2048_BIT', '--tags', JSON.stringify(Object.entries(tags).map(([Key, Value]) => ({Key, Value})))], region);
  await until(`${region} identity with run-owned claim`, () => ownedIdentity(pendingIdentity));
  pendingIdentity.deleteAttempted = true;
  runtime(['sesv2', 'delete-email-identity', '--email-identity', name], region);
  await until(`${region} identity removal`, () => identity(region, name) === null); pendingIdentity = undefined;
}
async function sendProbe(region, workspace) {
  const legacy = region === ohio, host = legacy ? 'e2e.opensend.mx' : 'e2e-trusted.opensend.mx';
  const d = (await findDomains(region)).find(d => d.name === host && d.region === region && d.ready);
  check(d && (!legacy || d.id === fixtureId), `Missing ready ${region} E2E fixture in the pinned workspace`);
  const tenants = aws(['sesv2', 'list-resource-tenants', '--resource-arn', `arn:aws:ses:${region}:${account}:identity/${host}`], region).ResourceTenants;
  const approved = legacy ? [`opensend-${workspace}`, `opensendmx-probation-${workspace}`] : [`opensendmx-trusted-${workspace}`];
  check(tenants?.length === 1 && approved.includes(tenants[0].TenantName), 'Canary identity is not exclusive to the expected tenant');
  const prefix = legacy ? 'opensend-mx' : 'opensendmx-trusted';
  const dests = aws(['sesv2', 'get-configuration-set-event-destinations', '--configuration-set-name', `${prefix}-transactional`], region).EventDestinations;
  check(dests?.length === 1 && dests[0].Enabled && dests[0].MatchingEventTypes.includes('DELIVERY') && dests[0].SnsDestination?.TopicArn === `arn:aws:sns:${region}:${account}:${prefix}-feedback`, 'Unexpected feedback destination');
  const from = `iam-${run}@${host}`, to = `success+iam-${region}-${run}@simulator.amazonses.com`;
  const queued = await api('/v1/emails/send', 'POST', {from, to: [to], region, subject: 'OpenSend MX policy canary', text: run}, [202]);
  check(queued.simulated === false && /^email_[a-f0-9]{32}$/.test(queued.id), 'Expected one live queued receipt');
  await until(`${region} signed simulator delivery`, async () => {
    const {email, events} = await api(`/v1/emails/${queued.id}/detail`);
    check(email.id === queued.id && email.region === region && email.from === from && email.simulated === false && isDeepStrictEqual(email.to, [to]), 'Simulator envelope/binding mismatch');
    check(['queued', 'attempting', 'accepted', 'sent', 'delivered', 'delayed'].includes(email.status), `Simulator send ended ${email.status}`);
    return email.status === 'delivered' && email.providerId && !email.providerId.startsWith('sim_') && events.data.some(e => e.type === 'delivery' && e.simulated === false && e.emailId === email.id && e.providerId === email.providerId);
  }, 90_000);
}
async function deleteDomain(cleanup = false) {
  check((await api(`/v1/domains/${createdId}`, 'DELETE', undefined, [200], cleanup)).deleted === true, 'Domain deletion not acknowledged');
  createdId = undefined;
}
async function domainProbe() {
  for (const r of regions) check(identity(r) === null && !(await findDomains(r)).some(d => d.name === domain), 'Reserved domain already exists; refusing to adopt it');
  const row = await api('/v1/domains', 'POST', {name: domain}, [201, 202]);
  check(row.name === domain && /^dom_[a-f0-9]{32}$/.test(row.id), 'Ambiguous create: inspect reserved domain; never delete by name');
  createdId = row.id;
  await until('new regional identity with owner and claim', () => regions.some(r => {
    const t = identity(r); return t?.some(t => t.Key === 'opensend:owner' && t.Value === 'mx') && t.some(t => t.Key === 'opensend:domain-claim' && /^[a-f0-9-]{36}$/.test(t.Value));
  }));
  await deleteDomain(); await until('domain removal', () => regions.every(r => identity(r) === null));
}
// The release must be serialized. IAM lists/gets can lag writes, including writes whose
// caller timed out. Issue both detaches before trusting a list. Reconcile late arrivals
// and require stable reads; an interrupted check must not cancel its own recovery.
async function rollbackIam() {
  const start = Date.now(), deadline = start + 90_000;
  const detach = new Set(companions);
  let restored = false, stableSince, issues;
  do {
    issues = [];
    const attempt = fn => { try { return fn(); } catch (e) { issues.push(e.message); } };
    const active = attempt(current);
    let wrote = false;
    if (active === candidate || (active === fallback && activationAttempted && !restored)) {
      wrote = true;
      attempt(() => { setDefault(fallback); restored = true; });
    } else if (active && active !== fallback) issues.push(`Concurrent default ${active}; refusing to overwrite it`);
    const policies = attempt(attached);
    for (const n of companions) if (detach.has(n) || policies?.includes(arn(n))) {
      wrote = true;
      detach.add(n);
      attempt(() => {
        aws(['iam', 'detach-user-policy', '--user-name', user, '--policy-arn', arn(n)], ohio, 'anomaly', /\(NoSuchEntity\)/);
        detach.delete(n);
      });
    }
    if (!wrote && !issues.length && active === fallback && isDeepStrictEqual(policies, [arn(primary)])) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 10_000 && (!iamWritePending || Date.now() - start >= 60_000)) return;
    } else stableSince = undefined;
    await delay(1500);
  } while (Date.now() < deadline);
  throw new Error(`Could not confirm ${fallback} and original attachments within cleanup window${issues.length ? ': ' + issues.join('; ') : ''}`);
}
async function cleanupIdentity() {
  if (!pendingIdentity) return;
  const {region, name} = pendingIdentity, end = Date.now() + 60_000;
  do {
    if (ownedIdentity(pendingIdentity)) {
      const tenants = aws(['sesv2', 'list-resource-tenants', '--resource-arn', `arn:aws:ses:${region}:${account}:identity/${name}`], region).ResourceTenants;
      check(Array.isArray(tenants) && !tenants.length, 'Canary identity acquired tenant bindings');
      pendingIdentity.deleteAttempted = true;
      aws(['sesv2', 'delete-email-identity', '--email-identity', name], region, 'anomaly', missing);
    } else if (pendingIdentity.deleteAttempted) return;
    await delay(1500); // A timed-out create may not be visible yet.
  } while (Date.now() < end);
  throw new Error(`Inspect unresolved disposable identity in ${region}: ${name}`);
}
try {
  check(aws(['sts', 'get-caller-identity', '--query', 'Account']) === account, 'Wrong operator account');
  check(runtime(['sts', 'get-caller-identity', '--query', 'Arn'], ohio) === principal, 'Wrong worker principal');
  check(current() === fallback && isDeepStrictEqual(attached(), [arn(primary)]), 'Not the expected v7-only installation');
  check(createHash('sha256').update(JSON.stringify(canonical(version(primary, fallback))) + '\n').digest('hex') === v7Digest, 'Fallback differs from the reviewed v7 policy');
  check(!iam('list-groups-for-user', '--user-name', user).Groups.length && !iam('list-user-policies', '--user-name', user).PolicyNames.length, 'Unexpected group/inline grants');
  for (const n of names) {
    check(isDeepStrictEqual(version(n, n === primary ? candidate : current(n)), documents[n]), `IAM document mismatch: ${n}`);
    const scope = iam('list-entities-for-policy', '--policy-arn', arn(n));
    check(!scope.PolicyGroups.length && !scope.PolicyRoles.length && isDeepStrictEqual(scope.PolicyUsers.map(u => u.UserName), n === primary ? [user] : []), `Unexpected policy attachment: ${n}`);
  }
  checkIreland();
  check(aws(['ses', 'describe-active-receipt-rule-set', '--query', 'Metadata.Name'], ohio) === 'opensend-mx-inbound', 'Expected the existing Ohio opensend-mx-inbound active set; operator review required');
  check(typeof key === 'string' && /^[\x21-\x7E]+$/.test(key), 'Inject OPENSEND_E2E_API_KEY via Deadbolt');
  const me = await api('/v1/me'), fixture = await api(`/v1/domains/${fixtureId}`);
  check(me.multiTenant && me.simulated === false && me.origin === origin && me.connection?.kind === 'shared' && me.connection.state === 'ready' && /^ws_[a-f0-9]{32}$/.test(me.workspaceId), 'Not a live ready Hosted workspace');
  check(fixture.id === fixtureId && fixture.name === 'e2e.opensend.mx' && fixture.region === ohio, 'Wrong workspace');
  stop.signal.throwIfAborted(); check(current() === fallback, 'Default changed before activation');
  armed = true;
  console.log(`Checking ${candidate}, fallback ${fallback}, canary run ${run}`);
  iamWritePending = true;
  for (const n of companions) iam('attach-user-policy', '--user-name', user, '--policy-arn', arn(n));
  activationAttempted = true;
  setDefault(candidate);
  iamWritePending = false;
  await until('candidate attachments/default visible', () => current() === candidate && isDeepStrictEqual(attached(), names.map(arn).sort()));
  boundaries(me.workspaceId);
  for (const region of regions) {
    stop.signal.throwIfAborted(); await disposable(region);
    // On first install, v7 cannot create these resources. An operator may request a
    // bounded bootstrap window AFTER the Ohio canary, with the existing rollback armed.
    // No enrollment, DNS or extra grants here; never substitute waiting for sendProbe.
    if (region === virginia && process.env.OPENSEND_E2E_TRUSTED_BOOTSTRAP === '1') {
      console.log('Ohio canary passed. Prepare the pinned Virginia E2E fixture now (15 minutes; no customer enrollment).');
      await until('verified Virginia release fixture', async () => (await findDomains()).some(d => d.name === 'e2e-trusted.opensend.mx' && d.region === virginia && d.ready), 900_000);
    }
    await sendProbe(region, me.workspaceId);
  }
  await domainProbe();
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/e2e.ts'], {cwd: new URL('../../api/', import.meta.url), stdio: 'inherit',
    env: {...process.env, OPENSEND_E2E_URL: origin}, signal: stop.signal, timeout: 300_000});
  check((await once(child, 'close'))[0] === 0, 'Live E2E failed');
  check(current() === candidate && isDeepStrictEqual(attached(), names.map(arn).sort()), 'IAM changed during check');
  for (const n of names) check(isDeepStrictEqual(version(n, current(n)), documents[n]), `Final document mismatch: ${n}`);
  stop.signal.throwIfAborted(); console.log(`${candidate}: both regional canaries, protected-resource denials, domain creation/deletion and E2E passed`);
} catch (e) {
  console.error(`Release check failed: ${e.message}`); process.exitCode = 1;
  if (armed) {
    try { await rollbackIam(); console.error(`Rollback confirmed: ${fallback}, original attachments`); }
    catch (err) { console.error(`Manual IAM recovery required: ${err.message}; run ${run}`); }
    try { await cleanupIdentity(); }
    catch (err) { console.error(`Manual identity recovery required: ${err.message}; ${pendingIdentity.region}/${pendingIdentity.name}; run ${run}`); }
    if (createdId) try { await deleteDomain(true); }
    catch (err) { console.error(`Manual API cleanup required: ${err.message}; domain ${createdId}; run ${run}`); }
  }
}
