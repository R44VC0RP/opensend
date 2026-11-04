import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, id, type DbExecutor } from './core.js';
import { mailboxAddresses, mailboxes, mailboxWriteLanes, mailMessages, type MailAddress, type SendLimits } from './db/mailbox.js';

export type Scope = { workspaceId: string };
/** SES assigns the wire Message-ID independently of OpenSend's durable receipt. */
export const sesMessageId = (providerId: string, region: string) => `${providerId}@${region === 'us-east-1' ? 'email' : region}.amazonses.com`;
/** ON CONFLICT locks even when its WHERE rejects the update: one trip, no idle tuple churn. */
export async function lockMailboxLane(tx: DbExecutor, workspaceId:string, lane: typeof mailboxWriteLanes.$inferSelect.lane) {
  await tx.execute(sql`INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(${workspaceId},${lane}) ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false`);
}
export const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Message-IDs compare without angle brackets or surrounding whitespace; case is preserved (RFC 5322 local parts are case-sensitive). */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/<([^<>\s]+)>/);
  const result = (match ? match[1]! : value.trim().replace(/^<|>$/g, '')).trim();
  return result && result.length <= 998 && !/\s/.test(result) ? result : null;
}
export function messageIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map(match => match[1]!);
  const list = bracketed.length ? bracketed : value.split(/[\s,]+/).map(item => normalizeMessageId(item)).filter((item): item is string => !!item);
  return [...new Set(list)].slice(-100);
}
export function normalizeSubject(value: string) {
  let subject = value.trim();
  for (let i = 0; i < 10; i++) { const next = subject.replace(/^(?:re|fwd?|aw|wg|sv|vs|antw|rif|tr)(?:\[\d+\])?\s*:\s*/i, '').trim(); if (next === subject) break; subject = next; }
  return subject;
}
/** Plain text without quoted history: drops "> " lines and everything from a reply attribution line. */
export function replyText(text: string | null | undefined): string {
  if (!text) return '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Attribution lines ("On Tue, Ana <a@b.c> wrote:"), including ones wrapped onto a second line.
    if (/^\s*On\s.{0,300}\swrote:\s*$/i.test(line) || (/^\s*On\s/i.test(line) && /\swrote:\s*$/i.test(lines[i + 1] ?? ''))) break;
    if (/^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(line) || /^_{10,}\s*$/.test(line) || /^From:\s.+/.test(line) && /^(?:Sent|Date):\s/.test(lines[i + 1] ?? '')) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function htmlToPlain(html: string) {
  return html.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
}
export function snippetOf(text: string | null | undefined, html: string | null | undefined) {
  const source = replyText(text || (html ? htmlToPlain(html) : ''));
  return source.replace(/\s+/g, ' ').trim().slice(0, 200);
}
export function uniqueAddresses(list: MailAddress[], limit = 20): MailAddress[] {
  const seen = new Set<string>(), out: MailAddress[] = [];
  for (const item of list) { const key = item.address.toLowerCase(); if (!key || seen.has(key)) continue; seen.add(key); out.push({ name: item.name || null, address: key }); if (out.length >= limit) break; }
  return out;
}
/** Wildcard address rules: "*" matches any run of characters, e.g. support+*@acme.com or *@help.acme.com. */
export function ruleMatches(rule: string, address: string) {
  const pattern = new RegExp(`^${rule.toLowerCase().split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return pattern.test(address);
}
export function validateRule(rule: string, domain: string) {
  const value = rule.trim().toLowerCase();
  const [local, host] = value.split('@');
  if (!local || !host || value.split('@').length !== 2 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || !/^[a-z0-9*.-]+$/.test(host)) throw new ApiError(422, 'INVALID_RULE', 'Rules look like support+*@example.com or *@help.example.com.', 'rules');
  const concrete = host.replace(/^\*\./, '');
  if (host.includes('*') && !host.startsWith('*.') || concrete.includes('*') || (concrete !== domain && !concrete.endsWith(`.${domain}`))) throw new ApiError(422, 'RULE_DOMAIN_MISMATCH', `Rules must stay within ${domain} or its subdomains.`, 'rules');
  if (value === `*@${domain}`) throw new ApiError(422, 'RULE_TOO_BROAD', 'A rule cannot claim every address on the domain; use the domain catch-all setting instead.', 'rules');
  return value;
}

export function checkTemporaryMailboxRouting(input: { aliases?: string[]; rules?: string[] }) {
  if (input.aliases?.length || input.rules?.length) throw new ApiError(422, 'TEMPORARY_MAILBOX_ROUTING', 'Temporary mailboxes do not support aliases or wildcard rules.', input.aliases?.length ? 'aliases' : 'rules');
}

/** Creates a mailbox with its primary address and aliases. Addresses stay reserved until deletion. */
export async function createMailbox(tx: DbExecutor, scope: Scope, input: { domainId: string; domainName: string; address: string; displayName?: string | null; aliases?: string[]; rules?: string[]; metadata?: Record<string, unknown>; origin: 'api' | 'auto'; sendLimits?: Partial<SendLimits>; ttlSeconds?: number }) {
  const address = input.address.trim().toLowerCase();
  if (input.ttlSeconds !== undefined) checkTemporaryMailboxRouting(input);
  const aliases = [...new Set((input.aliases ?? []).map(value => value.trim().toLowerCase()))].filter(value => value !== address);
  for (const value of [address, ...aliases]) if (!ADDRESS.test(value) || !value.endsWith(`@${input.domainName}`)) throw new ApiError(422, 'ADDRESS_DOMAIN_MISMATCH', `Addresses must be valid and end in @${input.domainName}.`, 'address');
  const rules = [...new Set((input.rules ?? []).map(rule => validateRule(rule, input.domainName)))];
  const all = [address, ...aliases];
  const taken = await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, scope.workspaceId), inArray(mailboxAddresses.address, all)));
  if (taken.length) throw new ApiError(409, 'ADDRESS_TAKEN', `${taken[0]!.address} already belongs to a mailbox.`, 'address');
  const mailboxId = id('mbx');
  // Start the lease after acquiring the address lock, not at transaction start before any wait.
  const lease = input.ttlSeconds === undefined ? {} : { createdAt: sql`statement_timestamp()`, updatedAt: sql`statement_timestamp()`, expiresAt: sql`statement_timestamp() + ${input.ttlSeconds}::int * interval '1 second'` };
  const [row] = await tx.insert(mailboxes).values({ id: mailboxId, ...scope, domainId: input.domainId, address, displayName: input.displayName ?? null, rules, metadata: input.metadata ?? {}, origin: input.origin, sendLimits: input.sendLimits ?? {}, ...lease }).returning();
  await tx.insert(mailboxAddresses).values(all.map((value, index) => ({ ...scope, address: value, mailboxId, kind: index === 0 ? 'primary' as const : 'alias' as const })));
  return row!;
}

export const threadSummaryConflict=sql`ON CONFLICT(mailbox_id,thread_id) DO UPDATE SET message_count=t.message_count+1,unread_count=t.unread_count+excluded.unread_count,
      participants=(SELECT coalesce(jsonb_agg(p ORDER BY n),'[]') FROM (SELECT * FROM (SELECT DISTINCT ON(lower(p->>'address')) p,n FROM jsonb_array_elements(t.participants||excluded.participants) WITH ORDINALITY v(p,n) ORDER BY lower(p->>'address'),n) first_seen ORDER BY n LIMIT 20) limited),
      snippet=CASE WHEN excluded.last_message_at>=t.last_message_at THEN excluded.snippet ELSE t.snippet END,subject=coalesce(nullif(t.subject,''),excluded.subject),last_message_at=greatest(t.last_message_at,excluded.last_message_at),last_inbound_at=greatest(t.last_inbound_at,excluded.last_inbound_at),archived=CASE WHEN excluded.last_inbound_at IS NOT NULL THEN false ELSE t.archived END`;

/** Adds a stored message to mailboxes and updates each mailbox's thread summary. Returns mailboxes that newly received it. */
export async function attachToMailboxes(tx: DbExecutor, scope: Scope, message: typeof mailMessages.$inferSelect, mailboxIds: string[]) {
  if (!mailboxIds.length) return [];
  const inbound = message.direction === 'inbound';
  const people = uniqueAddresses([{ name: message.fromName, address: message.fromAddress }, ...message.to, ...message.cc]);
  const result=await tx.execute<{mailbox_id:string}>(sql`WITH added AS (
    INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at)
    SELECT box,${message.id},${scope.workspaceId},${message.threadId},${message.direction},${!inbound},${message.receivedAt}::timestamptz FROM jsonb_array_elements_text(${JSON.stringify(mailboxIds)}::jsonb) b(box) ON CONFLICT DO NOTHING RETURNING *
  ) INSERT INTO mailbox_threads AS t(mailbox_id,thread_id,workspace_id,subject,snippet,participants,message_count,unread_count,last_message_at,last_inbound_at,spam,labels)
    SELECT mailbox_id,thread_id,workspace_id,${message.subject},${message.snippet},${JSON.stringify(people)}::jsonb,1,${inbound?1:0},received_at,CASE WHEN ${inbound} THEN received_at END,${message.spam},CASE WHEN ${message.spam} THEN ARRAY['spam'] ELSE ARRAY[]::text[] END FROM added ORDER BY mailbox_id
    ${threadSummaryConflict} RETURNING mailbox_id`);
  return result.rows.map(row=>row.mailbox_id);
}
