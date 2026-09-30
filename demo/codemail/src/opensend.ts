// A small typed client for the OpenSend mailbox API (/mailbox/v1), authenticated with one mailbox key.

export type Address = { name: string | null; address: string };
export type Mailbox = { id: string; address: string; displayName: string | null; domain: string; aliases: string[]; stats: { threads: number; unreadThreads: number; lastMessageAt: string | null } };
export type Thread = { id: string; mailboxId: string; subject: string; snippet: string; participants: Address[]; messageCount: number; unreadCount: number; lastMessageAt: string; archived: boolean; starred: boolean; spam: boolean; trashed: boolean; labels: string[] };
export type Attachment = { id: string; filename: string; contentType: string; size: number; disposition: 'attachment' | 'inline' };
export type Message = {
  id: string; threadId: string; direction: 'inbound' | 'outbound'; status: string; errorCode: string | null; read: boolean; labels: string[];
  from: Address; to: Address[]; cc: Address[]; subject: string; snippet: string; sentAt: string | null; receivedAt: string; attachmentCount: number; spam: boolean; automated: boolean;
  messageId?: string | null; inReplyTo?: string | null; text?: string; replyText?: string; attachments?: Attachment[];
};
export type ThreadDetail = Thread & { messages: Message[] };
export type MailEvent = { id: string; cursor: string; type: string; createdAt: string; mailboxId: string | null; threadId: string | null; messageId: string | null; data: Record<string, unknown> };
export type AttachmentInput = { filename: string; content: string; contentType?: string } | { id: string };

export class OpenSendError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export class OpenSend {
  private mailboxCache?: Promise<Mailbox[]>;
  constructor(private baseUrl: string, private key: string) {}

  private async call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/mailbox/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new OpenSendError(503, 'OPENSEND_UNREACHABLE', 'OpenSend could not be reached. Try again shortly.'); }
    const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    if (!response.ok) throw new OpenSendError(response.status, data?.error?.code ?? `HTTP_${response.status}`, data?.error?.message ?? `OpenSend returned HTTP ${response.status}.`);
    return data as T;
  }

  mailboxes() { return this.mailboxCache ??= this.call<{ data: Mailbox[] }>('GET', '/mailboxes?limit=100').then(result => result.data); }
  threads(mailboxId: string, query: { view: string; unread?: boolean; q?: string; limit: number; cursor?: string }) {
    const params = new URLSearchParams({ view: query.view, limit: String(query.limit), ...(query.unread ? { unread: 'true' } : {}), ...(query.q ? { q: query.q } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) });
    return this.call<{ data: Thread[]; nextCursor: string | null }>('GET', `/mailboxes/${enc(mailboxId)}/threads?${params}`);
  }
  thread(mailboxId: string, threadId: string) { return this.call<ThreadDetail>('GET', `/mailboxes/${enc(mailboxId)}/threads/${enc(threadId)}`); }
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
  labels(mailboxId: string) { return this.call<{ data: { name: string; threads: number; messages: number; unreadMessages: number }[] }>('GET', `/mailboxes/${enc(mailboxId)}/labels`); }
}

const enc = encodeURIComponent;
