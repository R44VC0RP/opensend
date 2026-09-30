import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, id, type DbExecutor, type Mode } from './core.js';
import { emails } from './db/sending.js';
import { mailboxAddresses, mailboxDomains, mailboxes, mailboxMessages, mailboxThreads, mailMessageIds, mailMessages, mailThreads, type MailAddress, type SendLimits } from './db/mailbox.js';

export type Scope = { workspaceId: string; environment: Mode };
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

/** Creates a mailbox with its primary address and aliases. Addresses are unique across mailboxes. */
export async function createMailbox(tx: DbExecutor, scope: Scope, input: { domainId: string; domainName: string; address: string; displayName?: string | null; aliases?: string[]; rules?: string[]; metadata?: Record<string, unknown>; origin: 'api' | 'auto'; sendLimits?: Partial<SendLimits> }) {
  const address = input.address.trim().toLowerCase();
  const aliases = [...new Set((input.aliases ?? []).map(value => value.trim().toLowerCase()))].filter(value => value !== address);
  for (const value of [address, ...aliases]) if (!ADDRESS.test(value) || !value.endsWith(`@${input.domainName}`)) throw new ApiError(422, 'ADDRESS_DOMAIN_MISMATCH', `Addresses must be valid and end in @${input.domainName}.`, 'address');
  const rules = [...new Set((input.rules ?? []).map(rule => validateRule(rule, input.domainName)))];
  const all = [address, ...aliases];
  const taken = await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, scope.workspaceId), eq(mailboxAddresses.environment, scope.environment), inArray(mailboxAddresses.address, all)));
  if (taken.length) throw new ApiError(409, 'ADDRESS_TAKEN', `${taken[0]!.address} already belongs to a mailbox.`, 'address');
  const mailboxId = id('mbx');
  const [row] = await tx.insert(mailboxes).values({ id: mailboxId, ...scope, domainId: input.domainId, address, displayName: input.displayName ?? null, rules, metadata: input.metadata ?? {}, origin: input.origin, sendLimits: input.sendLimits ?? {} }).returning();
  await tx.insert(mailboxAddresses).values(all.map((value, index) => ({ ...scope, address: value, mailboxId, kind: index === 0 ? 'primary' as const : 'alias' as const })));
  return row!;
}

/** Resolves envelope recipients to mailboxes: exact address/alias, plus-address base, wildcard rules, then the domain catch-all. */
export async function routeRecipients(tx: DbExecutor, scope: Scope, recipients: string[], options: { allowCreate: boolean }) {
  const mailboxIds = new Set<string>(), unrouted: string[] = [], created: string[] = [];
  const domainNames = [...new Set(recipients.map(value => value.split('@')[1] ?? ''))].filter(Boolean);
  if (!domainNames.length) return { mailboxIds: [], unrouted, created };
  const domains = await tx.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, scope.workspaceId), eq(mailboxDomains.environment, scope.environment), inArray(mailboxDomains.name, domainNames), inArray(mailboxDomains.status, ['provisioning', 'waiting_for_mx', 'active'])));
  for (const recipient of recipients) {
    const [local = '', host = ''] = recipient.split('@');
    const domain = domains.find(row => row.name === host);
    if (!domain) continue;
    const candidates = [...new Set([recipient, local.includes('+') ? `${local.split('+')[0]}@${host}` : recipient])];
    const exact = await tx.select({ address: mailboxAddresses.address, mailboxId: mailboxAddresses.mailboxId }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, scope.workspaceId), eq(mailboxAddresses.environment, scope.environment), inArray(mailboxAddresses.address, candidates)));
    const hit = exact.find(row => row.address === recipient) ?? exact[0];
    if (hit) { mailboxIds.add(hit.mailboxId); continue; }
    const ruled = await tx.select({ id: mailboxes.id, rules: mailboxes.rules }).from(mailboxes).where(and(eq(mailboxes.workspaceId, scope.workspaceId), eq(mailboxes.environment, scope.environment), eq(mailboxes.domainId, domain.id), sql`jsonb_array_length(${mailboxes.rules}) > 0`)).orderBy(mailboxes.createdAt);
    const matched = ruled.find(row => row.rules.some(rule => ruleMatches(rule, recipient)));
    if (matched) { mailboxIds.add(matched.id); continue; }
    if (domain.catchAll === 'create_mailbox' && options.allowCreate && ADDRESS.test(recipient)) {
      // Serialize creation per address so concurrent deliveries share one mailbox.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`mailbox_address:${scope.workspaceId}:${recipient}`}))`);
      const [again] = await tx.select({ mailboxId: mailboxAddresses.mailboxId }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, scope.workspaceId), eq(mailboxAddresses.environment, scope.environment), eq(mailboxAddresses.address, recipient)));
      const mailboxId = again?.mailboxId ?? (await createMailbox(tx, scope, { domainId: domain.id, domainName: domain.name, address: recipient, origin: 'auto' })).id;
      if (!again) created.push(mailboxId);
      mailboxIds.add(mailboxId); continue;
    }
    unrouted.push(recipient);
  }
  return { mailboxIds: [...mailboxIds], unrouted, created };
}

/** Finds the conversation for a message from In-Reply-To/References, or starts one. Serialized per workspace. */
export async function assignThread(tx: DbExecutor, scope: Scope, input: { inReplyTo: string | null; references: string[]; subject: string; at: string; messageId?: string | null }) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`mail_thread:${scope.workspaceId}`}))`);
  // The message's own Message-ID comes last: it matches when one of our mailboxes sent it to another (internal delivery),
  // so the recipient's copy joins the sender's conversation instead of starting a new one.
  const candidates = [...new Set([input.inReplyTo, ...[...input.references].reverse(), input.messageId].filter((value): value is string => !!value))].slice(0, 101);
  let threadId: string | undefined;
  if (candidates.length) {
    const rows = await tx.select({ messageId: mailMessageIds.messageId, threadId: mailMessageIds.threadId }).from(mailMessageIds).where(and(eq(mailMessageIds.workspaceId, scope.workspaceId), eq(mailMessageIds.environment, scope.environment), inArray(mailMessageIds.messageId, candidates)));
    threadId = candidates.map(candidate => rows.find(row => row.messageId === candidate)?.threadId).find(Boolean);
    // Replies can arrive before the outbound sync records SES's Message-ID; match the SES provider ID directly.
    const providerIds = candidates.map(candidate => candidate.match(/^([^@]+)@(?:[a-z0-9-]+\.)?amazonses\.com$/i)?.[1]).filter((value): value is string => !!value);
    if (!threadId && providerIds.length) {
      const sent = await tx.select({ sesMessageId: mailMessages.sesMessageId, threadId: mailMessages.threadId }).from(mailMessages).where(and(eq(mailMessages.workspaceId, scope.workspaceId), eq(mailMessages.environment, scope.environment), eq(mailMessages.direction, 'outbound'), inArray(mailMessages.sesMessageId, providerIds)));
      threadId = providerIds.map(value => sent.find(row => row.sesMessageId === value)?.threadId).find(Boolean);
      if (!threadId) {
        const [pending] = await tx.select({ threadId: mailMessages.threadId }).from(mailMessages).innerJoin(emails, and(eq(emails.id, mailMessages.sendingEmailId), eq(emails.workspaceId, mailMessages.workspaceId))).where(and(eq(mailMessages.workspaceId, scope.workspaceId), eq(mailMessages.environment, scope.environment), inArray(emails.providerId, providerIds))).limit(1);
        threadId = pending?.threadId;
      }
    }
  }
  if (!threadId) {
    threadId = id('thr');
    await tx.insert(mailThreads).values({ id: threadId, ...scope, subject: normalizeSubject(input.subject).slice(0, 998), messageCount: 0, lastMessageAt: input.at });
  }
  await tx.update(mailThreads).set({ messageCount: sql`${mailThreads.messageCount} + 1`, lastMessageAt: sql`greatest(${mailThreads.lastMessageAt}, ${input.at}::timestamptz)` }).where(eq(mailThreads.id, threadId));
  return threadId;
}
export async function rememberMessageIds(tx: DbExecutor, scope: Scope, messageRowId: string, threadId: string, ids: (string | null)[]) {
  const values = [...new Set(ids.filter((value): value is string => !!value))];
  if (values.length) await tx.insert(mailMessageIds).values(values.map(messageId => ({ ...scope, messageId, mailMessageId: messageRowId, threadId }))).onConflictDoNothing();
}

/** Adds a stored message to mailboxes and updates each mailbox's thread summary. Returns mailboxes that newly received it. */
export async function attachToMailboxes(tx: DbExecutor, scope: Scope, message: typeof mailMessages.$inferSelect, mailboxIds: string[]) {
  const added: string[] = [];
  const inbound = message.direction === 'inbound';
  const people = uniqueAddresses([{ name: message.fromName, address: message.fromAddress }, ...message.to, ...message.cc]);
  for (const mailboxId of mailboxIds) {
    const [link] = await tx.insert(mailboxMessages).values({ mailboxId, messageId: message.id, ...scope, threadId: message.threadId, direction: message.direction, read: !inbound, receivedAt: message.receivedAt }).onConflictDoNothing().returning({ mailboxId: mailboxMessages.mailboxId });
    if (!link) continue;
    added.push(mailboxId);
    await tx.insert(mailboxThreads).values({ mailboxId, threadId: message.threadId, ...scope, subject: message.subject, snippet: message.snippet, participants: people, messageCount: 0, unreadCount: 0, lastMessageAt: message.receivedAt, spam: message.spam, labels: message.spam ? ['spam'] : [] }).onConflictDoNothing();
    const [current] = await tx.select().from(mailboxThreads).where(and(eq(mailboxThreads.mailboxId, mailboxId), eq(mailboxThreads.threadId, message.threadId))).for('update');
    const newer = Date.parse(message.receivedAt) >= Date.parse(current!.lastMessageAt) || current!.messageCount === 0;
    await tx.update(mailboxThreads).set({
      messageCount: current!.messageCount + 1, unreadCount: current!.unreadCount + (inbound ? 1 : 0),
      participants: uniqueAddresses([...current!.participants, ...people]),
      ...(newer ? { lastMessageAt: message.receivedAt, snippet: message.snippet, subject: current!.subject || message.subject } : {}),
      ...(inbound ? { lastInboundAt: message.receivedAt, archived: false } : {}),
      ...(inbound && message.spam && !current!.labels.includes('spam') && current!.messageCount === 0 ? { spam: true } : {}),
    }).where(and(eq(mailboxThreads.mailboxId, mailboxId), eq(mailboxThreads.threadId, message.threadId)));
  }
  return added;
}
