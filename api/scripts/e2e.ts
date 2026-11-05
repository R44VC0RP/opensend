// Public client only: no database, dashboard session, provider credentials or test-mode shortcuts.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import * as sdk from '../../sdk/src/sdk.gen.js';
import { createClient } from '../../sdk/src/client/index.js';
import type { SendEmailInput } from '../../sdk/src/types.gen.js';

type Op = keyof typeof sdk;
const dashboard = 'Requires a signed-in dashboard session, not an API key.';
const shared = 'Would change shared domain, routing, provider or workspace configuration.';
const subdomain = 'Hosted receiving follows exact verified DNS; no wildcard/subdomain fixture.';
// Deliberately enumerate IDs (not paths, tags or prefixes): a new endpoint must never auto-skip.
const SKIP: Partial<Record<Op, string>> = {
  listMcpConnections: dashboard, revokeMcpConnection: dashboard,
  createAgentToken: 'Only an MCP OAuth principal can mint an agent token.',
  revokeAgentToken: 'Manage keys can revoke, but cannot mint a run-owned OAuth agent token to revoke.',
  listWorkspaces: dashboard, renameCurrentWorkspace: shared, listWorkspaceMembers: dashboard,
  inviteWorkspaceMember: dashboard, createWorkspaceInvitation: dashboard, listWorkspaceInvitations: dashboard,
  revokeWorkspaceInvitation: dashboard, updateWorkspaceMember: dashboard, removeWorkspaceMember: dashboard,
  acceptWorkspaceInvitation: dashboard,
  getConnection: dashboard, listConnectionRegions: dashboard, createConnection: shared,
  verifyConnection: 'BYO AWS-role verification, not Hosted mail.', deleteConnection: 'Would disconnect this shared workspace.',
  updateWorkspaceSettings: shared, configureRegion: shared, provisionRegion: shared, configureRegionAutoValidation: shared,
  createDomain: 'Creates an SES identity/domain claim; the runner does not provision DNS or AWS resources.',
  deleteDomain: 'The verified claim is shared by every run.', configureDomainMailFrom: shared,
  getDomainDnsSetup: dashboard, completeDomainDnsSetup: 'Browser return with signed Domain Connect token and Google session.',
  receiveSesSnsEvent: 'Authenticated AWS ingress; indirect coverage via real SES feedback, never forge SNS.',
  unsubscribeOneClick: 'Leaves a persistent recipient opt-out; consent CRUD uses a fresh simulator contact instead.',
  importTemplateImage: 'Requires a remote HTTPS image source; test assets are generated in-process.',
  updateInboundDomain: shared, enableInboundDomain: 'Hosted receiving follows DNS; there is no run-owned domain to enable.',
  disableInboundDomain: 'Hosted receiving cannot be disabled via API; removing the shared MX would break delivery.',
  createInboundSubdomain: subdomain, updateInboundSubdomain: subdomain, removeInboundSubdomain: subdomain,
  getInboundSubdomain: subdomain,
};

const started = Date.now();
const prefix = `e2e-${started}-${randomUUID().slice(0, 12)}`;
const domain = 'e2e.opensend.mx', domainId = 'dom_97087da408314135a3f6278da0e1aa80', region = 'us-east-2';
const from = `${prefix}@${domain}`, inbox = `${prefix}-in@${domain}`;
// SES supports +labels on all three mailboxes. Never reuse a real contact or retained suppression.
const simulator = (kind: 'success' | 'bounce' | 'complaint', label = '') => `${kind}+${prefix}${label}@simulator.amazonses.com`;
const success = simulator('success'), singleSuccess = simulator('success', '-single'), bounce = simulator('bounce'), complaint = simulator('complaint');
const subject = `OpenSend MX E2E ${prefix}`, text = `OpenSend MX delivery check ${prefix}.`;
const html = `<p>${text}</p>`;
const webhookUrl = 'https://httpbin.org/status/204';
const key = process.env.OPENSEND_E2E_API_KEY;
const base = new URL(process.env.OPENSEND_E2E_URL || 'https://opensend.mx');
const client = createClient({ baseUrl: base.origin, redirect: 'error', auth: scheme => scheme.scheme === 'bearer' ? key : undefined });
const openapi: { paths: Record<string, Record<string, { operationId: string }>> } = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const contract = new Set(Object.values(openapi.paths).flatMap(path => Object.values(path).map(op => op.operationId)));
const attempted = new Set<Op>();
type Step = { name: string; operationIds: Op[]; status: 'pass' | 'fail'; ms: number; requestId?: string | null; error?: string };
const steps: Step[] = [];
const ctx = new AsyncLocalStorage<{ last?: Op; requestId: string | null; ops: Set<Op> }>();
const cleanups: { name: string; fn: () => Promise<unknown> }[] = [];
const defer = (name: string, fn: () => Promise<unknown>) => cleanups.push({ name, fn });
let deadline = started + 205_000, failures = 0;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
type Input<K extends Op> = NonNullable<Parameters<typeof sdk[K]>[0]>;
type Output<K extends Op> = NonNullable<Awaited<ReturnType<typeof sdk[K]>>['data']>;
class ApiFailure extends Error {
  constructor(op: Op, readonly status: number | undefined, readonly code: string | undefined) {
    super(`${op}: HTTP ${status ?? 'transport failure'} ${code ?? 'no API error code'}`);
  }
}
async function api<K extends Op>(op: K, input: Input<K>): Promise<Output<K>> {
  check(contract.has(op) && !SKIP[op], `unregistered or skipped operation ${op}`);
  const ms = Math.min(op === 'renderCampaignPreviewImage' || op === 'renderCampaignTemplatePreviewImage' ? 30_000 : 12_000, deadline - Date.now());
  check(ms > 0, `run deadline before ${op}`);
  const state = ctx.getStore();
  if (state) { state.last = op; state.requestId = null; state.ops.add(op); }
  attempted.add(op);
  // Keep the generated method's input/output tied to its key; no handwritten route or schema.
  const call = sdk[op] as (opts: Input<K>) => ReturnType<typeof sdk[K]>;
  const result = await call({ ...input, client: input.client ?? client, signal: AbortSignal.timeout(ms) });
  const apiError = 'error' in result ? result.error?.error : undefined;
  if (state) state.requestId = result.response?.headers.get('x-request-id') ?? apiError?.requestId ?? null;
  // Never serialize SDK errors: request objects, tokens, and unrelated mail can all be sensitive.
  if (result.data === undefined || !result.response?.ok) throw new ApiFailure(op, result.response?.status, apiError?.code);
  return result.data as Output<K>;
}
async function expectDenial(call: () => Promise<unknown>, status: number, code: string) {
  try { await call(); } catch (error) {
    if (error instanceof ApiFailure && error.status === status && error.code === code) return;
    throw error;
  }
  throw new Error(`expected ${status} ${code}, got success`);
}
async function step<T>(name: string, work: () => Promise<T>) {
  const trace = { requestId: null, ops: new Set<Op>() };
  return ctx.run(trace, async () => {
    const start = Date.now();
    try {
      const result = await work();
      steps.push({ name, operationIds: [...trace.ops], status: 'pass', ms: Date.now() - start });
      console.log(`✓ ${name} (${Date.now() - start} ms)`);
      return result;
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message : 'unexpected failure';
      steps.push({ name, operationIds: [...trace.ops], status: 'fail', ms: Date.now() - start, requestId: trace.requestId, error: message });
      console.error(`✗ ${name} (${Date.now() - start} ms): ${message} [${ctx.getStore()?.last ?? 'local'} requestId=${trace.requestId ?? 'unavailable'}]`);
    }
  });
}
async function until<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean, describe: (value: T) => string, maxMs = 90_000) {
  const end = Math.min(Date.now() + maxMs, deadline);
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    const remaining = end - Date.now();
    check(remaining > 0, `timed out waiting for ${label}; last: ${describe(value)}`);
    await delay(Math.min(2000, remaining));
  }
}
function hasId(page: { data: { id: string }[] }, id: string) { return page.data.some(row => row.id === id); }
async function listed<T extends { id: string }>(id: string, read: (cursor?: string) => Promise<{ data: T[]; nextCursor: string | null }>) {
  let cursor: string | undefined;
  do {
    const page = await read(cursor), row = page.data.find(r => r.id === id);
    if (row) return row;
    check(page.nextCursor !== cursor, 'pagination cursor did not advance');
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  throw new Error(`run-owned record not listed: ${id}`);
}
async function workspaceReads() {
  check((await api('getWorkspaceSettings', {})).name === "Ryan Vogel's Organization", 'unexpected workspace name');
  const catalog = await api('listRegions', {});
  check(catalog.data.some(r => r.region === region && r.enabled) && catalog.data.some(r => r.region === catalog.defaultRegion && r.isDefault), 'invalid regional catalog');
  const tokens = await api('listAgentTokens', { query: { includeInactive: 'false', limit: 1 } });
  check(Array.isArray(tokens.data) && tokens.data.every(t => t.id.startsWith('agt_') && t.revokedAt === null && !('token' in t)), 'invalid active agent-token metadata');
  // Even an unrestricted workspace manager must not see the shared SES account.
  await expectDenial(() => api('getSesSettings', { query: { region } }), 403, 'SHARED_ACCOUNT_PRIVATE');
  await expectDenial(() => api('discoverRegion', { path: { region } }), 409, 'CONNECTION_MANAGED_REGION');
}
const idKey = (name: string) => ({ 'Idempotency-Key': `${prefix}:${name}` });
function message(to: string): SendEmailInput {
  check([singleSuccess, bounce, complaint].includes(to), 'refusing a recipient outside this run');
  // Add send-route header coverage here when the deployed contract supports it.
  return { region, from, to: [to], subject, text };
}
async function outcome(id: string, recipient: string, status: 'delivered' | 'bounced' | 'complained') {
  const email = await until(`${id} → ${status}`, () => api('getEmail', { path: { id } }), e => {
    check(!e.simulated && e.id === id && e.from === from && e.to.length === 1 && e.to[0] === recipient, `unexpected envelope or simulated email ${id}`);
    check(!['rejected', 'canceled', 'suppressed', 'rendering_failed', 'acceptance_unknown'].includes(e.status), `${id}: ${e.status} ${e.errorCode ?? ''}`);
    return e.status === status;
  }, e => `${e.status} ${e.errorCode ?? ''}`);
  check(email.providerId && !email.providerId.startsWith('sim_'), `missing live SES id for ${id}`);
  const event = { delivered: 'delivery', bounced: 'bounce', complained: 'complaint' }[status];
  const events = await api('listEmailEvents', { path: { id } });
  check(events.data.some(e => e.type === event && !e.simulated && e.emailId === id), `${id}: no live ${event} event`);
}
async function direct() {
  const options = { body: message(singleSuccess), headers: idKey('send') };
  const a = await api('sendEmail', options);
  check(!a.simulated && a.status === 'queued', 'expected a live queued receipt');
  const b = await api('sendEmail', options);
  check(a.id === b.id, 'idempotency replay created another email');
  await outcome(a.id, singleSuccess, 'delivered');
  const content = await api('getEmailContent', { path: { id: a.id } });
  check(content.text === text && content.subject === subject && !content.simulated, 'stored email content differs');
  const logs = await api('listEmails', { query: { search: singleSuccess, region } });
  check(logs.nextCursor === null && logs.data.length === 1 && hasId(logs, a.id), 'email missing or duplicated in log');
}
async function batch() {
  // SES feedback upserts a suppressed contact. Own it before sending so cleanup never has
  // to sweep by name or race late feedback; deleting the profile keeps its suppression tombstone.
  for (const email of [bounce, complaint]) {
    const row = await api('createContact', { body: { email, name: prefix } });
    defer(`delete simulator contact ${row.id}`, async () => check((await api('deleteContact', { path: { id: row.id } })).deleted, 'contact not deleted'));
  }
  const { data } = await api('sendEmailBatch', { body: { emails: [message(bounce), message(complaint)] }, headers: idKey('batch') });
  check(data.length === 2 && data[0].id !== data[1].id && data.every(e => !e.simulated), 'expected two different live batch receipts');
  await Promise.all([
    step('SES bounce feedback', () => outcome(data[0].id, bounce, 'bounced')),
    step('SES complaint feedback', () => outcome(data[1].id, complaint, 'complained')),
  ]);
}

async function audience() {
  const contact = await api('createContact', { body: { email: success, name: prefix } });
  const c = { id: contact.id };
  defer(`delete contact ${c.id}`, async () => check((await api('deleteContact', { path: c })).deleted, 'contact not deleted'));
  check(contact.email === success, 'contact address differs');
  const list = await api('createContactList', { body: { name: prefix } });
  const l = { id: list.id };
  defer(`delete list ${l.id}`, async () => check((await api('deleteContactList', { path: l })).deleted, 'list not deleted'));
  const rule = { field: 'email', operator: 'eq', value: success } as const;
  const segment = await api('createSegment', { body: { name: prefix, rule } });
  const s = { id: segment.id };
  defer(`delete segment ${s.id}`, async () => check((await api('deleteSegment', { path: s })).deleted, 'segment not deleted'));
  await api('updateContact', { path: c, body: { name: subject } });
  await api('updateContactList', { path: l, body: { description: subject } });
  await api('updateSegment', { path: s, body: { name: subject } });
  check((await api('getContact', { path: c })).name === subject, 'contact edit not persisted');
  check((await api('getContactList', { path: l })).description === subject, 'list edit not persisted');
  const saved = await api('getSegment', { path: s });
  check(saved.name === subject && 'field' in saved.rule && saved.rule.field === 'email' && saved.rule.operator === 'eq' && saved.rule.value === success, 'exact simulator segment not persisted');
  check(hasId(await api('listContacts', { query: { email: success } }), c.id), 'contact not listed');
  check(hasId(await api('listContactLists', { query: { search: prefix } }), l.id), 'list not listed');
  check(hasId(await api('listSegments', { query: { search: prefix } }), s.id), 'segment not listed');
  await api('updateContactConsent', { path: c, body: { status: 'subscribed', source: prefix } });
  check((await api('listContactConsentEvents', { path: c })).data.some(e => e.source === prefix && e.status === 'subscribed'), 'no subscription audit');
  const added = await api('addListMembers', { path: l, body: { contactIds: [c.id] } });
  check(added.added === 1, 'did not add exactly one member');
  defer(`remove membership ${l.id}`, async () => check((await api('removeListMember', { path: { ...l, contactId: c.id } })).deleted, 'membership not removed'));
  const members = await api('listListMembers', { path: l });
  check(members.nextCursor === null && members.data.length === 1 && members.data[0].id === c.id && members.data[0].email === success, 'refusing audience: not exactly this run’s simulator recipient');
  const preview = await api('previewSegment', { path: s, body: { listId: l.id } });
  check(preview.matched === 1 && preview.eligible === 1, 'segment did not select one eligible member');
  const rows = await api('queryAudience', { body: { statement: `SELECT email FROM contacts WHERE id = '${c.id}'` } });
  check(rows.rows.length === 1 && rows.rows[0].email === success, 'AudienceQL returned another contact');
  const plan = await api('planAudienceMutation', { body: { statement: `UPDATE contacts SET name = '${prefix}' WHERE id = '${c.id}'` } });
  check(plan.matched === 1 && plan.sample.length === 1 && plan.sample[0].id === c.id && plan.sample[0].email === success, 'refusing plan: not exactly this run’s contact');
  check((await api('applyAudiencePlan', { body: { planId: plan.id } })).affected === 1, 'audience plan did not apply');
  await step('One-row contact import and retained receipt', async () => {
    const name = `${prefix}-import`;
    const preview = await api('previewContactImport', { body: { csv: `email,name\n${success},${name}\n`, listId: l.id, mapping: { email: 'email', name: 'name' } } });
    const path = { id: preview.id };
    check(preview.status === 'preview' && preview.listId === l.id && preview.rows.length === 1 && preview.rows[0].email === success && !preview.errors.length, 'refusing import of anything but this run’s contact');
    const committed = await api('commitContactImport', { path });
    check(committed.status === 'committed' && committed.imported === 1, 'import did not commit exactly one row');
    const receipt = await api('getContactImport', { path });
    check(receipt.id === path.id && receipt.listId === l.id && receipt.rows.length === 1 && receipt.rows[0].name === name, 'incorrect stored import');
    // This endpoint exposes summary metadata only and has no server-side listId filter.
    const summary = await listed(path.id, cursor => api('listContactImports', { query: { cursor, limit: 100 } }));
    check(summary.listId === l.id && summary.imported === 1 && summary.status === 'committed', 'incorrect import summary');
    const updated = await api('getContact', { path: c });
    check(updated.name === name && updated.email === success && updated.listIds.includes(l.id) && updated.marketingConsent === 'subscribed', 'import lost membership or consent');
  });
  return { listId: l.id, segmentId: s.id };
}

// One opaque RGBA pixel. Build PNG chunks locally so neither upload nor inspection fetches an image.
function pixelPng() {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4); bytes.set(data, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 32, 96, 128, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function templateAsset() {
  const png = pixelPng(), filename = `${prefix}.png`, content = png.toString('base64');
  const file = await api('uploadTemplateAsset', { body: { filename, content, contentType: 'image/png', disposition: 'inline', contentId: prefix } });
  const path = { id: file.id };
  defer(`delete template PNG ${file.id}`, async () => check((await api('deleteTemplateAsset', { path })).deleted, 'template asset not deleted'));
  const stored = await api('getTemplateAsset', { path });
  check(stored.filename === filename && stored.size === png.length && stored.contentType === 'image/png' && stored.contentId === prefix, 'template PNG metadata changed');
  check((await api('getTemplateAssetContent', { path })).content === content, 'template PNG bytes changed');
}
function checkScreenshot(image: { data: string; mimeType: string }) {
  const png = Buffer.from(image.data, 'base64');
  check(image.mimeType === 'image/png' && png.length > 33 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.readUInt32BE(16) === 720 && png.readUInt32BE(20) > 0, 'expected a rendered 720px PNG');
}

async function attachment() {
  const content = Buffer.from(text).toString('base64');
  const file = await api('uploadAttachment', { body: { filename: `${prefix}.txt`, contentType: 'text/plain', content } });
  const path = { id: file.id };
  defer(`delete attachment ${file.id}`, async () => check((await api('deleteAttachment', { path })).deleted, 'attachment not deleted'));
  check((await api('getAttachment', { path })).size === Buffer.byteLength(text), 'incorrect stored size');
  check((await api('getAttachmentContent', { path })).content === content, 'attachment bytes changed');
  // A sent email holds an immutable reference. Use a disposable draft to exercise actual
  // attachment use without leaving an undeletable uploaded object after every deploy.
  const draft = await api('createCampaign', { body: { name: `${prefix}-attachment`, region, from, attachments: [file.id] } });
  const campaign = { id: draft.id };
  defer(`delete attachment draft ${draft.id}`, async () => check((await api('deleteCampaign', { path: campaign })).deleted, 'draft not deleted'));
  check((await api('getCampaign', { path: campaign })).draft.attachments?.includes(file.id), 'draft lost attachment reference');
}

async function template() {
  const item = await api('createCampaignTemplate', { body: { name: prefix } });
  const path = { id: item.id };
  defer(`delete template ${item.id}`, async () => check((await api('deleteCampaignTemplate', { path })).deleted, 'template not deleted'));
  const saved = await api('updateCampaignTemplate', { path, body: { revision: item.revision, draft: { ...item.draft, subject, html } } });
  const published = await api('publishCampaignTemplate', { path, body: { revision: saved.revision } });
  check(published.publishedRevision === saved.revision, 'wrong published revision');
  const preview = await api('previewCampaignTemplate', { path, query: { published: 'true' } });
  check(preview.html.includes(text) && preview.text.includes(text), 'published content missing in preview');
  await step('Render published template PNG', async () => {
    const image = await api('renderCampaignTemplatePreviewImage', { path, query: { published: 'true' } });
    check(image.published && image.revision === saved.revision, 'renderer returned another template revision');
    checkScreenshot(image);
  });
  check((await api('getCampaignTemplate', { path })).published?.subject === subject, 'published subject differs');
  check(hasId(await api('listCampaignTemplates', { query: { search: prefix, publishedOnly: 'true' } }), item.id), 'template not listed');
  check((await api('setCampaignTemplateArchived', { path, body: { archived: true } })).archivedAt, 'template did not archive');
  check(!(await api('setCampaignTemplateArchived', { path, body: { archived: false } })).archivedAt, 'template did not restore');
  return item.id;
}

function retireCampaign(id: string) {
  const path = { id };
  // Only draft/unreleased failed campaigns can be deleted. Archive dispatch history instead.
  defer(`retire campaign ${id}`, async () => {
    const row = await api('getCampaign', { path });
    if (row.state === 'draft' || (row.state === 'failed' && !row.delivery?.expanded)) {
      check((await api('deleteCampaign', { path })).deleted, 'draft not deleted');
    } else {
      if (row.state !== 'done' && row.state !== 'canceled') {
        try { await api('cancelCampaign', { path }); }
        catch (error) { if ((await api('getCampaignState', { path })).state !== 'done') throw error; }
      }
      check((await api('setCampaignArchived', { path, body: { archived: true } })).archivedAt, 'terminal campaign not archived');
    }
  });
  return path;
}
type Audience = { listId: string; segmentId: string };
async function scheduledCampaign(audience: Audience) {
  const item = await api('createCampaign', { body: { name: `${prefix}-schedule`, audience, from, region, subject, html, tracking: false } });
  const path = retireCampaign(item.id);
  const eligible = await api('previewCampaignAudience', { path });
  check(item.draft.audience?.listId === audience.listId && item.draft.audience.segmentId === audience.segmentId && eligible.matched === 1 && eligible.eligible === 1, 'refusing unexpected scheduled audience');
  const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
  const launch = await api('scheduleCampaign', { path, headers: idKey('schedule'), body: { revision: item.revision, scheduledAt } });
  check(launch.id === item.id && launch.queued === 1 && launch.scheduledAt === scheduledAt && !launch.simulated, 'schedule receipt differs');
  await until('campaign prepared for tomorrow', () => api('getCampaignState', { path }), row => {
    check(['preparing', 'scheduled'].includes(row.state), `unexpected pre-schedule state ${row.state}`);
    return row.state === 'scheduled';
  }, row => row.state);
  const paused = await api('pauseCampaign', { path, body: {} });
  check(paused.state === 'paused' && paused.delivery?.expanded === 0, 'future campaign did not pause before dispatch');
  const paced = await api('setCampaignPacing', { path, body: { perDay: 100, rateShare: 0.25 } });
  check(paced.delivery?.pacing.perDay === 100 && paced.delivery.pacing.rateShare === 0.25, 'pacing changes missing');
  const resumed = await api('resumeCampaign', { path, body: {} });
  check(resumed.state === 'scheduled' && resumed.scheduledAt && Date.parse(resumed.scheduledAt) === Date.parse(scheduledAt), 'resume lost future schedule');
  const canceled = await api('cancelCampaign', { path });
  check(canceled.state === 'canceled' && canceled.inFlight === 0 && canceled.canceled === 1, 'cancel did not stop one future recipient');
  const stats = await api('getCampaignStats', { path });
  check(stats.state === 'canceled' && stats.counts.total === 0 && stats.delivery?.expanded === 0, 'scheduled campaign materialized an email');
}
async function campaign(audience: Audience, templateId?: string) {
  const item = await api('createCampaign', { body: { name: prefix, from, region, audience, tracking: false, ...(templateId ? { templateId } : { subject, html }) } });
  const path = retireCampaign(item.id);
  check(item.draft.subject === subject && item.draft.html === html && (!templateId || item.sourceTemplateId === templateId), 'unexpected draft or template copy');
  const saved = await api('updateCampaign', { path, body: { revision: item.revision, draft: { ...item.draft, name: subject } } });
  check(saved.revision > item.revision && saved.draft.name === subject, 'revision did not advance');
  check(hasId(await api('listCampaigns', { query: { search: prefix } }), item.id), 'campaign not listed');
  const preview = await api('previewCampaign', { path });
  check(preview.html.includes(text) && preview.text.includes(text), 'campaign preview differs');
  await step('Render campaign PNG', async () => checkScreenshot(await api('renderCampaignPreviewImage', { path })));
  const allowed = await api('previewCampaignAudience', { path });
  check(saved.draft.audience?.listId === audience.listId && saved.draft.audience.segmentId === audience.segmentId && allowed.matched === 1 && allowed.eligible === 1, 'refusing campaign: not the verified one-member exact-email audience');
  const test = await api('testCampaign', { path, body: { to: success }, headers: idKey('campaign-test') });
  check(!test.simulated && test.status === 'queued', 'test email not live');
  const sent = await api('sendCampaign', { path, body: { revision: saved.revision }, headers: idKey('campaign') });
  check(!sent.simulated && sent.queued === 1 && sent.id === item.id, 'expected one live campaign recipient');
  await until(`campaign ${item.id} done`, () => api('getCampaignState', { path }), c => {
    check(!['failed', 'canceled', 'paused'].includes(c.state), `campaign ${item.id} ${c.state}`);
    return c.state === 'done';
  }, c => c.state);
  const stats = await api('getCampaignStats', { path });
  check(stats.totals.accepted === 1 && stats.counts.total === 1 && stats.totals.simulated === 0, 'campaign done without one live acceptance');
  const logs = await api('listEmails', { query: { campaignId: item.id } });
  check(logs.data.length === 1 && logs.data[0].to[0] === success, 'wrong campaign recipient');
  await outcome(logs.data[0].id, success, 'delivered');
  await step('Read unsubscribe confirmation without changing consent', async () => {
    const { text } = await api('getEmailContent', { path: { id: logs.data[0].id } });
    const token = text?.match(/\/unsubscribe\/(u_[a-f0-9]{64})\s*$/)?.[1];
    check(token, 'no unsubscribe capability in run-owned marketing email');
    const page = await api('unsubscribeByLink', { path: { token }, parseAs: 'text' });
    check(page.includes('<form method="post">'), 'GET must display a confirmation form');
    check((await api('previewCampaignAudience', { path })).eligible === 1, 'GET changed audience consent');
  });
  await outcome(test.id, success, 'delivered');
  // Cancellation must not retroactively retract a finished, delivered campaign.
  try { await api('cancelCampaign', { path }); }
  catch (error) {
    if (!(error instanceof ApiFailure && error.status === 409 && error.code === 'CAMPAIGN_ALREADY_DISPATCHED')) throw error;
    return;
  }
  throw new Error('cancelCampaign accepted a completed campaign');
}

async function webhook() {
  // Synthetic tests bypass pause, actual workspace subscriptions do not. No customer events
  // or signing secrets leave MX. httpbin's fixed 204 endpoint is not a public request inbox.
  const item = await api('createWebhook', { body: { url: webhookUrl, description: prefix, eventTypes: ['email.delivered'], paused: true } });
  const path = { id: item.id };
  defer(`delete webhook ${item.id}`, async () => check((await api('deleteWebhook', { path })).deleted, 'webhook not deleted'));
  check(item.paused && (await api('getWebhook', { path })).paused, 'test endpoint must remain paused');
  await api('updateWebhook', { path, body: { description: subject, paused: true } });
  check((await api('getWebhook', { path })).description === subject, 'webhook edit not persisted');
  check(hasId(await api('listWebhooks', { query: { limit: 100 } }), item.id), 'webhook not listed');
  const before = await api('revealWebhookSecret', { path });
  const after = await api('rotateWebhookSecret', { path });
  check(after.secret.startsWith('whsec_') && before.secret !== after.secret, 'test endpoint signing secret did not rotate');
  const test = await api('testWebhook', { path });
  const detail = await until('synthetic signed webhook HTTP attempt', () => api('getWebhookDelivery', { path: { ...path, deliveryId: test.id } }), d => d.attempts.some(a => a.statusCode !== null), d => `${d.status}, attempts=${d.attemptCount} ${d.lastError ?? ''}`);
  // Even an HTTP error proves the request reached a receiver. Do not gate an MX deploy on
  // httpbin's uptime; a DNS/connect/signing failure (no HTTP response) does not qualify.
  check(detail.synthetic && detail.webhookId === item.id && detail.payload.id === detail.eventId && detail.attempts.some(a => a.deliveryId === test.id && a.statusCode !== null && a.statusCode >= 100 && a.statusCode < 600), `no HTTP attempt recorded for synthetic delivery ${test.id}`);
  check(hasId(await api('listWebhookDeliveries', { path }), test.id), 'signed test attempt not listed');
  // Retry only our synthetic probe. HTTP errors can already have an automatic retry pending;
  // in that case verify the duplicate-retry guard instead of forcing another delivery.
  const deliveryPath = { ...path, deliveryId: test.id };
  try {
    const next = await api('retryWebhookDelivery', { path: deliveryPath });
    check(next.id === test.id && next.status === 'pending', 'wrong retry receipt');
  } catch (error) {
    if (!(error instanceof ApiFailure && error.status === 409 && error.code === 'DELIVERY_PENDING' && detail.status === 'pending')) throw error;
    return;
  }
  await until('second synthetic HTTP attempt', () => api('getWebhookDelivery', { path: deliveryPath }), d => d.synthetic && d.attemptCount > detail.attemptCount && d.attempts.some(a => a.statusCode !== null && !detail.attempts.some(first => a.id === first.id)), d => `${d.status}, attempts=${d.attemptCount}`);
}

async function apiKey() {
  const item = await api('createApiKey', { body: { name: prefix, permissions: ['read'], domains: [domain] } });
  const path = { id: item.id };
  defer(`revoke throwaway key ${item.id}`, async () => check((await api('revokeApiKey', { path })).revoked, 'key not revoked'));
  check(item.name === prefix && item.domains.length === 1 && item.domains[0] === domain && item.permissions.join() === 'read', 'wrong child key scope');
  check(hasId(await api('listApiKeys', { query: { includeRevoked: 'false', limit: 100 } }), item.id), 'throwaway key not listed');
}

async function inboundKey(addressId: string, otherId: string) {
  const key = await api('createInboundKey', { body: { name: prefix, addressIds: [addressId], permissions: ['read'] } });
  const path = { id: key.id };
  const restricted = createClient({ baseUrl: base.origin, redirect: 'error', headers: { Authorization: `Bearer ${key.secret}` } });
  defer(`revoke inbound key ${key.id}`, async () => {
    const revoked = await api('revokeInboundKey', { path });
    check(revoked.id === key.id && revoked.revokedAt, 'inbound key not revoked');
    await expectDenial(() => api('getInboundAddress', { client: restricted, path: { addressId } }), 401, 'AUTH_INVALID');
  });
  const row = await listed(key.id, cursor => api('listInboundKeys', { query: { cursor, limit: 100 } }));
  check(row.addressIds?.length === 1 && row.addressIds[0] === addressId && row.permissions.join() === 'read', 'inbound key scope differs');
  check((await api('getInboundAddress', { client: restricted, path: { addressId } })).address === inbox, 'run key cannot read its address');
  await expectDenial(() => api('getInboundAddress', { client: restricted, path: { addressId: otherId } }), 404, 'NOT_FOUND');
}

async function inboundWebhook(addressId: string, threadId: string) {
  // Only this address's thread-state metadata, never message.received/stored or mail content.
  const item = await api('createInboundWebhook', { body: { url: webhookUrl, description: prefix, addressIds: [addressId], eventTypes: ['thread.updated'], paused: true } });
  const path = { id: item.id };
  defer(`delete inbound webhook ${path.id}`, async () => check((await api('deleteInboundWebhook', { path })).ok, 'inbound webhook not deleted'));
  const stored = await api('getInboundWebhook', { path });
  check(stored.paused && stored.addressIds?.length === 1 && stored.addressIds[0] === addressId && stored.eventTypes.join() === 'thread.updated', 'unsafe inbound webhook subscription');
  check(hasId(await api('listInboundWebhooks', {}), path.id), 'inbound webhook not listed');
  const rotated = await api('rotateInboundWebhookSecret', { path });
  check(rotated.secret.startsWith('whsec_') && rotated.secret !== item.secret, 'inbound webhook secret did not rotate');
  const before = await api('listInboundEvents', { query: { addressId, types: 'thread.updated' } });
  const active = await api('updateInboundWebhook', { path, body: { paused: false, addressIds: [addressId], eventTypes: ['thread.updated'] } });
  check(!active.paused && active.addressIds?.[0] === addressId && active.addressIds.length === 1 && active.eventTypes.join() === 'thread.updated', 'inbound subscription scope changed');
  const state = await api('updateInboundThread', { path: { threadId }, body: { addressId, addLabels: [prefix] } });
  check(state.labels.includes(prefix), 'test label was not applied');
  const events = await api('listInboundEvents', { query: { addressId, types: 'thread.updated', after: before.cursor } });
  const event = events.data.find(e => e.addressId === addressId && e.threadId === threadId && e.type === 'thread.updated');
  check(event, 'no matching thread metadata event');
  await until('scoped thread metadata HTTP attempt', () => api('listInboundWebhookDeliveries', { path }), page => page.data.some(d => d.webhookId === item.id && d.eventId === event.id && d.attemptCount > 0 && d.lastStatusCode !== null), page => `${page.data.length} deliveries`);
}

async function inbound() {
  const d = { id: domainId };
  check(hasId(await api('listInboundDomains', {}), domainId), 'inbound domain not listed');
  const report = await until('public MX exclusively routed to the test region', () => api('checkInboundDomain', { path: d }), r => {
    check(r.name === domain && r.region === region, 'wrong inbound domain');
    return r.mx?.state === 'active';
  }, r => r.mx?.state ?? 'unknown');
  check(report.mx?.expected.name === domain && report.mx.records.length && report.mx.records.every(r => r.host === `inbound-smtp.${region}.amazonaws.com`), 'refusing self-loop: unexpected public mail exchanger');
  await until('receiving MX active', () => api('getInboundDomain', { path: d }), row => row.status === 'active', row => row.status);
  async function address(email: string) {
    const row = await api('createInboundAddress', { body: { address: email, ttlSeconds: 600 } });
    const path = { addressId: row.id };
    defer(`delete address ${row.id}`, async () => check((await api('deleteInboundAddress', { path })).ok, 'address not deleted'));
    check(row.address === email && row.expiresAt, 'unexpected temporary address');
    return row;
  }
  const sender = await address(from), receiver = await address(inbox);
  const addressId = receiver.id;
  await step('Verify inbound read key is restricted to one address', () => inboundKey(addressId, sender.id));
  const children = await api('listInboundSubdomains', { path: d, query: { limit: 1 } });
  check(Array.isArray(children.data) && children.data.every(r => r.parentDomainId === domainId), 'subdomain page includes another parent');
  await api('updateInboundAddress', { path: { addressId }, body: { displayName: prefix } });
  check((await api('getInboundAddress', { path: { addressId } })).displayName === prefix, 'receiving address edit not persisted');
  check(hasId(await api('listInboundAddresses', { query: { domain, q: prefix } }), addressId), 'receiving address not listed');
  const events = await api('listInboundEvents', { query: { addressId, types: 'message.received' } });
  const sent = await api('createInboundThread', {
    headers: idKey('self-loop'), body: { addressId: sender.id, from, to: [inbox], subject, text,
      attachments: [{ filename: `${prefix}.txt`, content: Buffer.from(prefix).toString('base64') }] },
  });
  check(sent.direction === 'outbound' && sent.from.address === from && sent.to.length === 1 && sent.to[0].address === inbox, 'wrong self-loop envelope');
  const arrival = await until('new inbound message event', () => api('listInboundEvents', { query: { addressId, types: 'message.received', after: events.cursor } }), e => e.data.some(v => v.addressId === addressId && v.type === 'message.received'), e => `${e.data.length} matching events`);
  const event = arrival.data.find(v => v.addressId === addressId && v.type === 'message.received')!;
  check(event.threadId && event.messageId, 'receipt missing thread/message IDs');
  const path = { threadId: event.threadId };
  const msg = await api('getInboundMessage', { path: { messageId: event.messageId }, query: { addressId } });
  check(msg.direction === 'inbound' && msg.from.address === from && msg.subject === subject && msg.text.includes(text) && msg.to.some(a => a.address === inbox), 'inbound message differs from sent content');
  check(msg.attachments.length === 1 && msg.attachments[0].filename === `${prefix}.txt`, 'inbound attachment missing');
  const link = await api('getInboundAttachment', { path: { messageId: msg.id, attachmentId: msg.attachments[0].id }, query: { addressId } });
  check(new URL(link.url).protocol === 'https:' && Date.parse(link.expiresAt) > Date.now(), 'expected a temporary HTTPS attachment URL');
  check(hasId(await api('listInboundThreads', { query: { addressId, q: prefix } }), path.threadId), 'arrived thread not listed');
  check(hasId(await api('listInboundMessages', { query: { addressId, direction: 'inbound', q: prefix } }), msg.id), 'arrived message not listed');
  check((await api('getInboundThread', { path, query: { addressId } })).messages.some(m => m.id === msg.id), 'message absent from thread');
  check((await api('updateInboundThread', { path, body: { addressId, starred: true } })).starred, 'thread edit failed');
  await step('Scoped inbound webhook, rotation and thread metadata delivery', () => inboundWebhook(addressId, path.threadId));
  const reply = await api('replyToInboundThread', { path, headers: idKey('reply'), body: {
    addressId, replyToMessageId: msg.id, text, expectedRecipients: { to: [from], cc: [], bcc: [] },
  } });
  check(reply.threadId === msg.threadId && reply.direction === 'outbound' && reply.to[0]?.address === from && reply.emailId, 'reply not bound to original conversation');
  const replies = await until('reply received by original test sender', () => api('listInboundMessages', { query: { addressId: sender.id, direction: 'inbound', q: prefix } }), page => page.data.some(m => m.from.address === inbox && m.threadId === sent.threadId), page => `${page.data.length} messages`);
  const received = replies.data.find(m => m.from.address === inbox && m.threadId === sent.threadId)!;
  const delivered = await api('getInboundMessage', { path: { messageId: received.id }, query: { addressId: sender.id } });
  check(delivered.text.includes(text) && msg.messageId && delivered.inReplyTo === msg.messageId, 'reply body or In-Reply-To differs');
}

async function prepare() {
  check(base.protocol === 'https:' && base.href === base.origin + '/', 'OPENSEND_E2E_URL must be a bare HTTPS origin');
  check(key, 'missing OPENSEND_E2E_API_KEY');
  const me = await api('getCurrentIdentity', {});
  check(me.multiTenant && !me.simulated && me.origin === base.origin && me.connection?.kind === 'shared' && me.connection.region === region && me.connection.state === 'ready' && me.connection.tenant === 'ready', 'expected live MX, ready Hosted mail, us-east-2');
  // Inbound, webhooks, templates, metrics and key management need an unrestricted key; the domain ID
  // check below still pins the run to the test workspace, and every send in this script is from the test domain.
  check((me.domains.length === 0 || (me.domains.length === 1 && me.domains[0] === domain)) && ['read', 'send', 'manage'].every(p => me.permissions.some(v => v === p)), 'refusing a key scoped to another domain or missing read/send/manage');
  const path = { id: domainId };
  const info = await api('getDomain', { path });
  check(info.id === domainId && info.name === domain && info.region === region, 'test domain ID/name/region mismatch');
  check(hasId(await api('listDomains', { query: { refresh: 'false', region, limit: 10 } }), domainId), 'domain absent from scoped catalog');
  await api('verifyDomain', { path });
  await until('verified sending domain', () => api('getDomain', { path }), d => d.ready && d.sending === 'verified', d => `${d.sending}/${d.verificationStatus}/${d.dkimStatus}`, 110_000);
  return true;
}

async function run() {
  console.log(`${prefix} ${base.origin}`);
  try {
    const ready = await step('Live identity and verified domain', prepare);
    if (!ready) return;
    await Promise.all([
      step('Single send, replay, delivery and email log', direct),
      step('Batch send', batch), step('Attachment upload, bytes and draft use', attachment),
      step('Temporary inbound addresses, self-loop, thread and reply', inbound),
      step('Paused webhook, rotated secret and synthetic signed HTTP attempt', webhook),
      step('Create and list restricted throwaway API key', apiKey),
      step('Workspace settings, region catalog, token metadata and Hosted SES privacy', workspaceReads),
      step('Upload and inspect a template PNG', templateAsset),
      (async () => {
        const [selection, tpl, guide] = await Promise.all([
          step('Contact, consent, list, segment and AudienceQL', audience),
          step('Publish, preview and restore literal template', template),
          step('Campaign content guide', async () => {
            check((await api('getCampaignContentGuide', {})).markdown.includes('<p>'), 'guide missing paragraph block');
            return true;
          }),
        ]);
        // A template permission failure does not hide campaign dispatch regressions.
        if (selection && guide) await Promise.all([
          step('Preview exact audience, send campaign and observe done + delivery', () => campaign(selection, tpl)),
          step('Schedule, pause, pace, resume and cancel without dispatch', () => scheduledCampaign(selection)),
        ]);
      })(),
    ]);
    await step('Regional metrics for this run window', async () => {
      const m = await api('getMetrics', { query: { from: new Date(started).toISOString(), region, granularity: 'hour' } });
      check(m.basis === 'created-cohort' && m.region === region && m.totals.emails >= 3 && m.totals.bounced >= 1 && m.totals.complained >= 1 && m.totals.delivered >= 1, 'regional metrics do not include expected simulator outcomes');
    });
  } finally {
    deadline = Date.now() + 35_000;
    for (const { name, fn } of cleanups.reverse()) await step(name, fn);
  }
}

function finish() {
  const ended = Date.now();
  const missing = [...contract].filter(op => !attempted.has(op as Op) && !Object.hasOwn(SKIP, op));
  const stale = Object.keys(SKIP).filter(op => !contract.has(op));
  if (missing.length || stale.length) {
    failures++;
    const error = [missing.length && `not reached: ${missing.join(', ')}`, stale.length && `obsolete skips: ${stale.join(', ')}`].filter(Boolean).join('; ');
    steps.push({ name: 'OpenAPI coverage', status: 'fail', ms: 0, operationIds: [], requestId: null, error });
    console.error(`✗ OpenAPI coverage (0 ms): ${error}`);
  }
  const skipped = Object.keys(SKIP).length;
  const covered = new Set(steps.filter(s => s.status === 'pass').flatMap(s => s.operationIds));
  const headline = `MX E2E ${failures ? 'FAIL' : 'PASS'} — ${covered.size}/${contract.size} operations in passing steps, ${attempted.size} attempted, ${skipped} intentionally skipped, ${missing.length} not reached (${((ended - started) / 1000).toFixed(1)} s)`;
  console.log(headline);
  const commit = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const report = { commit, targetUrl: base.origin, run: prefix, start: new Date(started).toISOString(), end: new Date(ended).toISOString(), ms: ended - started,
    status: failures ? 'fail' : 'pass', steps, coverage: { total: contract.size, passed: [...covered].sort(), attempted: [...attempted].sort(), notReached: missing.sort(), skipped: SKIP, staleSkips: stale } };
  // Atomic replacement also makes a shared working directory safe for concurrent invocations.
  const tmp = `.${prefix}-report.tmp`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n');
  renameSync(tmp, 'e2e-report.json');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escape = (v: string) => v.replaceAll('|', '\\|').replace(/[<>\r\n]/g, ' ');
    const failed = steps.filter(s => s.status === 'fail');
    const md = [`## ${headline}`, '', ...failed.map(s => `- **${escape(s.name)}**: ${s.name === 'OpenAPI coverage' ? 'See unaccounted operations in the JSON artifact.' : escape(s.error!)} (request ID: \`${s.requestId ?? 'unavailable'}\`)`), '', '<details><summary>Every step</summary>', '', '| Step | Result | ms |', '|---|---|---:|', ...steps.map(s => `| ${escape(s.name)} | ${s.status} | ${s.ms} |`), '', '</details>', ''];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
  }
  if (failures) process.exitCode = 1;
}
try { await run(); } finally { finish(); }
