// A small typed client for the OpenSend mailbox API (/mailbox/v1), authenticated with one mailbox key.

export type Address = { name: string | null; address: string };
export type Mailbox = { id: string; address: string; displayName: string | null; domain: string; aliases: string[]; metadata?: Record<string, unknown>; stats: { threads: number; unreadThreads: number; lastMessageAt: string | null } };
export type Thread = { id: string; mailboxId: string; subject: string; snippet: string; participants: Address[]; messageCount: number; unreadCount: number; lastMessageAt: string; archived: boolean; starred: boolean; spam: boolean; trashed: boolean; labels: string[] };
export type Attachment = { id: string; filename: string; contentType: string; size: number; disposition: 'attachment' | 'inline' };
export type Message = {
  id: string; threadId: string; direction: 'inbound' | 'outbound'; status: string; errorCode: string | null; read: boolean; labels: string[];
  from: Address; to: Address[]; cc: Address[]; subject: string; snippet: string; sentAt: string | null; receivedAt: string; attachmentCount: number; spam: boolean; automated: boolean;
  messageId?: string | null; inReplyTo?: string | null; text?: string; replyText?: string; attachments?: Attachment[];
};
export type ThreadDetail = Thread & { messages: Message[] };
export type Contact = { address: string; name: string | null; sentCount: number; receivedCount: number; copiedCount: number; firstContactAt: string; lastContactAt: string; automated: boolean };
export type MailEvent = { id: string; cursor: string; type: string; createdAt: string; mailboxId: string | null; threadId: string | null; messageId: string | null; data: Record<string, unknown> };
export type AttachmentInput = { filename: string; content: string; contentType?: string } | { id: string };

export class OpenSendError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** One authenticated call to OpenSend. path starts at the API root (/mailbox/v1/…, /v1/…). */
async function request<T>(baseUrl: string, key: string, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new OpenSendError(503, 'OPENSEND_UNREACHABLE', 'OpenSend could not be reached. Try again shortly.'); }
  const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new OpenSendError(response.status, data?.error?.code ?? `HTTP_${response.status}`, data?.error?.message ?? `OpenSend returned HTTP ${response.status}.`);
  return data as T;
}

/** Agent-side client: one mailbox key, scoped by OpenSend to its mailboxes and permissions. */
export class OpenSend {
  private mailboxCache?: Promise<Mailbox[]>;
  constructor(private baseUrl: string, private key: string) {}
  private call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string) { return request<T>(this.baseUrl, this.key, method, `/mailbox/v1${path}`, body, idempotencyKey); }

  mailboxes() { return this.mailboxCache ??= this.call<{ data: Mailbox[] }>('GET', '/mailboxes?limit=100').then(result => result.data); }
  threads(mailboxId: string, query: { view: string; unread?: boolean; q?: string; limit: number; cursor?: string }) {
    const params = new URLSearchParams({ view: query.view, limit: String(query.limit), ...(query.unread ? { unread: 'true' } : {}), ...(query.q ? { q: query.q } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) });
    return this.call<{ data: Thread[]; nextCursor: string | null }>('GET', `/mailboxes/${enc(mailboxId)}/threads?${params}`);
  }
  thread(mailboxId: string, threadId: string) { return this.call<ThreadDetail>('GET', `/mailboxes/${enc(mailboxId)}/threads/${enc(threadId)}`); }
  message(mailboxId: string, messageId: string) { return this.call<Message>('GET', `/mailboxes/${enc(mailboxId)}/messages/${enc(messageId)}`); }
  updateThreads(mailboxId: string, threadIds: string[], changes: Record<string, unknown>) {
    return threadIds.length === 1
      ? this.call<Thread>('PATCH', `/mailboxes/${enc(mailboxId)}/threads/${enc(threadIds[0]!)}`, changes).then(thread => [thread])
      : this.call<{ data: Thread[] }>('POST', `/mailboxes/${enc(mailboxId)}/threads/batch`, { threadIds, changes }).then(result => result.data);
  }
  searchMessages(mailboxId: string, query: { q?: string; direction?: string; unread?: boolean; label?: string; limit: number; cursor?: string }) {
    const params = new URLSearchParams({ limit: String(query.limit), ...(query.q ? { q: query.q } : {}), ...(query.direction ? { direction: query.direction } : {}), ...(query.unread ? { unread: 'true' } : {}), ...(query.label ? { label: query.label } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) });
    return this.call<{ data: Message[]; nextCursor: string | null }>('GET', `/mailboxes/${enc(mailboxId)}/messages?${params}`);
  }
  send(mailboxId: string, body: Record<string, unknown>, idempotencyKey?: string) { return this.call<Message>('POST', `/mailboxes/${enc(mailboxId)}/messages`, body, idempotencyKey); }
  replyToThread(mailboxId: string, threadId: string, body: Record<string, unknown>, idempotencyKey?: string) { return this.call<Message>('POST', `/mailboxes/${enc(mailboxId)}/threads/${enc(threadId)}/reply`, body, idempotencyKey); }
  replyToMessage(mailboxId: string, messageId: string, body: Record<string, unknown>, idempotencyKey?: string) { return this.call<Message>('POST', `/mailboxes/${enc(mailboxId)}/messages/${enc(messageId)}/reply`, body, idempotencyKey); }
  forward(mailboxId: string, messageId: string, body: Record<string, unknown>, idempotencyKey?: string) { return this.call<Message>('POST', `/mailboxes/${enc(mailboxId)}/messages/${enc(messageId)}/forward`, body, idempotencyKey); }
  events(mailboxId: string, query: { after?: string; wait: number; types?: string[] }) {
    const params = new URLSearchParams({ wait: String(query.wait), limit: '50', ...(query.after ? { after: query.after } : {}), ...(query.types?.length ? { types: query.types.join(',') } : {}) });
    return this.call<{ data: MailEvent[]; cursor: string }>('GET', `/mailboxes/${enc(mailboxId)}/events?${params}`);
  }
  attachment(mailboxId: string, attachmentId: string) { return this.call<Attachment & { messageId: string; url: string; expiresAt: string }>('GET', `/mailboxes/${enc(mailboxId)}/attachments/${enc(attachmentId)}`); }
  contacts(mailboxId: string, query: { q?: string; sort?: 'recent' | 'frequent'; limit?: number; includeAutomated?: boolean } = {}) {
    const params = new URLSearchParams({ limit: String(query.limit ?? 100), sort: query.sort ?? 'recent', ...(query.q ? { q: query.q } : {}), ...(query.includeAutomated ? { includeAutomated: 'true' } : {}) });
    return this.call<{ data: Contact[]; nextCursor: string | null }>('GET', `/mailboxes/${enc(mailboxId)}/contacts?${params}`);
  }
  labels(mailboxId: string) { return this.call<{ data: { name: string; threads: number; messages: number; unreadMessages: number }[] }>('GET', `/mailboxes/${enc(mailboxId)}/labels`); }
}

export type Subdomain = { id: string; name: string; parentDomainId: string; status: 'active' | 'disabled'; catchAll: string; metadata: Record<string, unknown>; mx: { state: string; message: string } | null; mailboxCount: number; createdAt: string };
export type MailboxKey = { id: string; name: string; prefix: string; mailboxIds: string[] | null; permissions: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
export type Permission = 'read' | 'send' | 'modify';

/** Product-side client: codemail's one live OpenSend API key (manage + send) for domains, mailboxes, keys and invites. */
export class OpenSendAdmin {
  private parentCache?: Promise<string>;
  constructor(private baseUrl: string, private key: string, private mailDomain: string) {}
  private call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string) { return request<T>(this.baseUrl, this.key, method, path, body, idempotencyKey); }

  /** The OpenSend domain ID of the parent mail domain (opcd.ai), looked up once per isolate. */
  parentDomainId() {
    return this.parentCache ??= this.call<{ data: { id: string; name: string; status: string }[] }>('GET', '/mailbox/v1/domains').then(({ data }) => {
      const domain = data.find(item => item.name === this.mailDomain);
      if (!domain) throw new OpenSendError(500, 'MAIL_DOMAIN_MISSING', `${this.mailDomain} is not a domain in OpenSend.`);
      return domain.id;
    }).catch(error => { this.parentCache = undefined; throw error; });
  }
  async addSubdomain(label: string, metadata: Record<string, unknown>) { return this.call<Subdomain>('POST', `/mailbox/v1/domains/${enc(await this.parentDomainId())}/subdomains`, { name: label, metadata }); }
  async removeSubdomain(subdomainId: string) { return this.call<Subdomain>('DELETE', `/mailbox/v1/domains/${enc(await this.parentDomainId())}/subdomains/${enc(subdomainId)}`); }
  async updateSubdomain(subdomainId: string, metadata: Record<string, unknown>) { return this.call<Subdomain>('PATCH', `/mailbox/v1/domains/${enc(await this.parentDomainId())}/subdomains/${enc(subdomainId)}`, { metadata }); }
  async subdomain(subdomainId: string) { return this.call<Subdomain>('GET', `/mailbox/v1/domains/${enc(await this.parentDomainId())}/subdomains/${enc(subdomainId)}`); }

  mailboxes(host: string) { return this.call<{ data: Mailbox[] }>('GET', `/mailbox/v1/mailboxes?limit=100&domain=${enc(host)}`).then(result => result.data); }
  mailbox(mailboxId: string) { return this.call<Mailbox>('GET', `/mailbox/v1/mailboxes/${enc(mailboxId)}`); }
  createMailbox(input: { address: string; displayName?: string; metadata: Record<string, unknown> }) { return this.call<Mailbox>('POST', '/mailbox/v1/mailboxes', input); }
  deleteMailbox(mailboxId: string) { return this.call<unknown>('DELETE', `/mailbox/v1/mailboxes/${enc(mailboxId)}`); }
  threads(mailboxId: string, limit = 30) { return this.call<{ data: Thread[]; nextCursor: string | null }>('GET', `/mailbox/v1/mailboxes/${enc(mailboxId)}/threads?view=all&limit=${limit}`); }
  thread(mailboxId: string, threadId: string) { return this.call<ThreadDetail>('GET', `/mailbox/v1/mailboxes/${enc(mailboxId)}/threads/${enc(threadId)}`); }

  createKey(input: { name: string; mailboxIds: string[]; permissions: Permission[] }) { return this.call<MailboxKey & { secret: string }>('POST', '/mailbox/v1/keys', input); }
  revokeKey(keyId: string) { return this.call<MailboxKey>('POST', `/mailbox/v1/keys/${enc(keyId)}/revoke`).catch(error => { if (error instanceof OpenSendError && error.status === 404) return null; throw error; }); }

  sendEmail(input: { from: string; fromName?: string; to: string; subject: string; text: string; html?: string }, idempotencyKey?: string) { return this.call<{ id: string }>('POST', '/v1/emails/send', { ...input, kind: 'transactional' }, idempotencyKey); }
}

const enc = encodeURIComponent;
