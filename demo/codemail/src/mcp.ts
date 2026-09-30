import { McpServer } from '@modelcontextprotocol/server';
import { getMcpAuthContext } from 'agents/mcp/server';
import { z } from 'zod';
import { conversationText, mailboxLine, messageLines, own, size, threadLines, who } from './format.js';
import { directoryText, resolveRecipients, tagger, type Directory } from './directory.js';
import { OpenSend, OpenSendError, type AttachmentInput, type Mailbox, type Message } from './opensend.js';

/** Stored encrypted in the OAuth grant. The mailbox key is minted for this grant alone. */
export type CodemailProps = { mailboxKey: string; keyId: string; userId: string; organizationId: string; mailboxes: { id: string; address: string }[] };

const INSTRUCTIONS = `codemail gives you real email mailboxes.

Typical loop: check_inbox → read_conversation → reply (or update_conversations to archive, star or label).
- Conversations have IDs like thr_…; messages have IDs like msg_…; attachments have IDs like matt_….
- Replies are threaded by their email headers, so reply(thread_id=…) keeps the conversation together.
- Leave out "mailbox" when this connection has one mailbox; otherwise pass its address.
- To react to new mail, call wait_for_mail (it blocks up to 30s) and pass back the cursor it returns, instead of calling check_inbox in a loop.
- send_email, reply and forward send real email to real people. Only send when the user asked for it or clearly intends it.
- Automated senders (no-reply addresses, bounces, mailing lists) are protected from replies; set allow_automated only if the user explicitly wants to reply anyway.
- Reading does not mark mail read. Pass mark_as_read=true to read_conversation, or use update_conversations, when you have handled a conversation.
- Your organization's people and agent mailboxes are listed by find_people. In to, cc and bcc you can write a teammate's name (cc=["maya"]) instead of their address; codemail resolves it and tells you who it picked. Conversations mark teammates and agents.`;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (value: string, structured?: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: value }] as Content[], ...(structured ? { structuredContent: structured } : {}) });
const failure = (value: string) => ({ content: [{ type: 'text' as const, text: value }] as Content[], isError: true });

// Actionable wording for API errors an agent can recover from.
function explain(error: unknown) {
  if (!(error instanceof OpenSendError)) return failure(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  const hints: Record<string, string> = {
    REPLY_TO_AUTOMATED: 'The original message is automated (auto-reply, bounce or bulk mail). Replying could start a loop. Only retry with allow_automated=true if the user explicitly asked.',
    REPLY_TO_NO_REPLY: 'The recipient is a no-reply style address that will not read replies. Only retry with allow_automated=true if the user explicitly asked.',
    MAILBOX_SEND_LIMIT: 'The mailbox hit its send limit. Wait before sending more; the limits exist to stop runaway agents.',
    RECIPIENT_SEND_LIMIT: 'Too many messages to this recipient recently. This guards against reply loops; wait before sending again.',
    THREAD_LOOP_SUSPECTED: 'Too many replies in this conversation in 10 minutes. Stop and check with the user before continuing.',
    PERMISSION_DENIED: 'This connection was not given that permission. Ask the user to reconnect codemail and allow it (send or organize mail).',
    NOT_FOUND: 'Not found in this mailbox. Check the ID with check_inbox or search_mail.',
    AUTH_INVALID: 'This connection was disconnected. Ask the user to reconnect codemail.',
    RECIPIENT_UNRESOLVED: 'Nothing was sent. Use exact addresses, or call find_people to see who is in the organization.',
  };
  return failure(`${error.message}${hints[error.code] ? `\n\n${hints[error.code]}` : ''} (${error.code})`);
}

async function pickMailbox(client: OpenSend, requested?: string): Promise<Mailbox> {
  const mailboxes = await client.mailboxes();
  if (!mailboxes.length) throw new OpenSendError(404, 'NO_MAILBOXES', 'This connection has no mailboxes.');
  if (!requested) {
    if (mailboxes.length === 1) return mailboxes[0]!;
    throw new OpenSendError(400, 'MAILBOX_REQUIRED', `This connection can use ${mailboxes.length} mailboxes: ${mailboxes.map(m => m.address).join(', ')}. Pass mailbox with one of them.`);
  }
  const value = requested.trim().toLowerCase();
  const match = mailboxes.find(m => m.id === requested || m.address === value || m.aliases.includes(value)) ?? mailboxes.find(m => m.address.split('@')[0] === value);
  if (!match) throw new OpenSendError(404, 'MAILBOX_NOT_FOUND', `No mailbox "${requested}" on this connection. Available: ${mailboxes.map(m => m.address).join(', ')}.`);
  return match;
}

/** The cc list OpenSend's reply_all would compute, so extra people can be added to it. */
async function replyAllCc(client: OpenSend, mailbox: Mailbox, threadId?: string, messageId?: string) {
  const mine = own(mailbox);
  let target: Message | undefined;
  if (threadId) {
    const thread = await client.thread(mailbox.id, threadId);
    target = [...thread.messages].reverse().find(message => message.direction === 'inbound') ?? thread.messages.at(-1);
  } else target = await client.message(mailbox.id, messageId!);
  if (!target) return [];
  const to = new Set((target.direction === 'outbound' ? target.to : [target.from]).map(value => value.address.toLowerCase()));
  const candidates = target.direction === 'outbound' ? target.cc : [...target.to, ...target.cc];
  return [...new Set(candidates.map(value => value.address.toLowerCase()).filter(address => !mine.has(address) && !to.has(address)))];
}

const mailboxArg = z.string().max(254).optional().describe('Mailbox address (or ID). Optional when the connection has a single mailbox.');
const recipient = z.string().trim().min(1).max(254);
const recipients = z.union([recipient, z.array(recipient).max(50)]).transform(value => Array.isArray(value) ? value : [value])
  .describe('Email addresses, or names of people in your organization (see find_people), e.g. ["maya", "ops@acme.com"].');
const attachmentsArg = z.array(z.union([
  z.object({ filename: z.string().min(1).max(200), content_base64: z.string().min(4).describe('File bytes, standard base64.'), content_type: z.string().max(100).optional() }),
  z.object({ attachment_id: z.string().describe('Reuse a received attachment (matt_…) from this mailbox.') }),
])).max(20).optional().describe('Up to 20 files, 8 MiB combined: PDF, text, CSV, JSON, images, ICS and Office documents.');
const toAttachments = (items?: z.infer<typeof attachmentsArg>): AttachmentInput[] => (items ?? []).map(item => 'attachment_id' in item ? { id: item.attachment_id } : { filename: item.filename, content: item.content_base64, ...(item.content_type ? { contentType: item.content_type } : {}) });
const readOnly = { readOnlyHint: true, openWorldHint: false };

export function createServer(openSendUrl: string, directory?: Directory) {
  const tag = tagger(directory);
  const resolved = (lines: string[]) => lines.length ? `\nResolved: ${lines.join('; ')}.` : '';
  return () => {
    const props = getMcpAuthContext()?.props as CodemailProps | undefined;
    const server = new McpServer({ name: 'codemail', version: '0.1.0' }, { instructions: INSTRUCTIONS });
    const client = props?.mailboxKey ? new OpenSend(openSendUrl, props.mailboxKey) : null;
    const run = <A>(work: (client: OpenSend, args: A) => Promise<ReturnType<typeof text>>) => async (args: A) => {
      if (!client) return failure('codemail is not connected to a mailbox. Reconnect the MCP server to sign in.');
      try { return await work(client, args); } catch (error) { return explain(error); }
    };

    server.registerTool('list_mailboxes', {
      title: 'List mailboxes',
      description: 'List the mailboxes this connection can use, with unread counts. Call this first if you do not know which mailbox to use.',
      inputSchema: z.object({}), annotations: readOnly,
    }, run(async client => {
      const mailboxes = await client.mailboxes();
      return text(`${mailboxes.length} mailbox${mailboxes.length === 1 ? '' : 'es'}:\n${mailboxes.map(mailboxLine).join('\n')}\n\nNext: check_inbox${mailboxes.length > 1 ? '(mailbox="…")' : '()'} to see conversations.`, { mailboxes });
    }));

    server.registerTool('check_inbox', {
      title: 'Check inbox',
      description: 'List conversations, newest activity first. Use folder to switch views, unread_only for new mail, and search for full-text search (subject, sender and body). Returns thread IDs for read_conversation.',
      inputSchema: z.object({
        mailbox: mailboxArg,
        folder: z.enum(['inbox', 'starred', 'archive', 'spam', 'trash', 'all']).default('inbox').describe('inbox = not archived, trashed or spam.'),
        unread_only: z.boolean().default(false),
        search: z.string().max(200).optional().describe('Full-text search, e.g. "invoice" or "from maya".'),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().max(300).optional().describe('The cursor from a previous check_inbox result, to get the next page.'),
      }), annotations: readOnly,
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const page = await client.threads(mailbox.id, { view: args.folder, unread: args.unread_only, q: args.search, limit: args.limit, cursor: args.cursor });
      const title = `${mailbox.address} · ${args.folder}${args.unread_only ? ' (unread)' : ''}${args.search ? ` · "${args.search}"` : ''}`;
      if (!page.data.length) return text(`${title}: no conversations.${args.folder === 'inbox' && !args.search ? ' Use wait_for_mail to wait for new mail.' : ''}`, { threads: [], nextCursor: null });
      const unread = page.data.filter(thread => thread.unreadCount).length;
      return text(`${title}: ${page.data.length} conversation${page.data.length === 1 ? '' : 's'}${unread ? `, ${unread} unread` : ''}\n\n${threadLines(mailbox, page.data)}\n\nNext: read_conversation(thread_id="…").${page.nextCursor ? ` More: check_inbox(cursor="${page.nextCursor}").` : ''}`, { mailbox: mailbox.address, threads: page.data, nextCursor: page.nextCursor });
    }));

    server.registerTool('read_conversation', {
      title: 'Read conversation',
      description: 'Read every message in a conversation, oldest first, with who replied to which message. Quoted history is removed unless include_quoted is true. Does not mark mail read unless mark_as_read is true.',
      inputSchema: z.object({
        thread_id: z.string().min(1).max(120).describe('Conversation ID (thr_…) from check_inbox, search_mail or wait_for_mail.'),
        mailbox: mailboxArg,
        include_quoted: z.boolean().default(false).describe('Include quoted earlier messages in each body.'),
        mark_as_read: z.boolean().default(false),
      }), annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const thread = await client.thread(mailbox.id, args.thread_id);
      if (args.mark_as_read && thread.unreadCount) await client.updateThreads(mailbox.id, [thread.id], { read: true });
      const latestInbound = [...thread.messages].reverse().find(message => message.direction === 'inbound');
      const header = `"${thread.subject || '(no subject)'}" · ${mailbox.address} · ${thread.id} · ${thread.messageCount} message${thread.messageCount === 1 ? '' : 's'}${thread.labels.length ? ` · labels: ${thread.labels.join(', ')}` : ''}${args.mark_as_read && thread.unreadCount ? ' · marked read' : thread.unreadCount ? ` · ${thread.unreadCount} unread` : ''}`;
      const next = latestInbound ? `Next: reply(thread_id="${thread.id}", body="…") answers [${thread.messages.indexOf(latestInbound) + 1}] from ${who(latestInbound.from)}${latestInbound.automated ? ' (automated sender, so replies are blocked by default)' : ''}.` : `Next: reply(thread_id="${thread.id}", body="…") follows up on your own message.`;
      return text(`${header}\n\n${conversationText(mailbox, thread, args.include_quoted, tag)}\n\n${next}`, { mailbox: mailbox.address, thread });
    }));

    server.registerTool('search_mail', {
      title: 'Search mail',
      description: 'Find individual messages (not conversations) by text, direction, unread state or label. Useful for "emails from X" or "what did I send about Y". Returns message and thread IDs.',
      inputSchema: z.object({
        query: z.string().max(200).optional().describe('Full-text search across subject, sender and body.'),
        mailbox: mailboxArg,
        direction: z.enum(['inbound', 'outbound']).optional().describe('inbound = received, outbound = sent by this mailbox.'),
        unread_only: z.boolean().default(false),
        label: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().max(300).optional(),
      }), annotations: readOnly,
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const page = await client.searchMessages(mailbox.id, { q: args.query, direction: args.direction, unread: args.unread_only, label: args.label?.toLowerCase(), limit: args.limit, cursor: args.cursor });
      if (!page.data.length) return text(`No messages in ${mailbox.address} match.`, { messages: [], nextCursor: null });
      return text(`${page.data.length} message${page.data.length === 1 ? '' : 's'} in ${mailbox.address}:\n\n${messageLines(page.data)}\n\nNext: read_conversation(thread_id="…") for context.${page.nextCursor ? ` More: search_mail(cursor="${page.nextCursor}").` : ''}`, { mailbox: mailbox.address, messages: page.data, nextCursor: page.nextCursor });
    }));

    server.registerTool('send_email', {
      title: 'Send email',
      description: 'Send a new email from a mailbox, starting a new conversation. This sends real email: only use it when the user asked. To answer an existing email use reply instead, so it stays threaded.',
      inputSchema: z.object({
        to: recipients,
        subject: z.string().min(1).max(998),
        body: z.string().min(1).max(500_000).describe('Plain-text body.'),
        html: z.string().max(500_000).optional().describe('Optional HTML version of the body.'),
        cc: recipients.optional(), bcc: recipients.optional(),
        mailbox: mailboxArg,
        from: z.string().email().optional().describe('Send as one of the mailbox aliases instead of its main address.'),
        attachments: attachmentsArg,
        idempotency_key: z.string().max(200).optional().describe('Reuse the same key when retrying so the email is not sent twice.'),
      }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const [to, cc, bcc] = await Promise.all([resolveRecipients(directory, args.to), resolveRecipients(directory, args.cc ?? []), resolveRecipients(directory, args.bcc ?? [])]);
      const sent = await client.send(mailbox.id, { to: to.addresses, cc: cc.addresses, bcc: bcc.addresses, subject: args.subject, text: args.body, ...(args.html ? { html: args.html } : {}), ...(args.from ? { from: args.from } : {}), attachments: toAttachments(args.attachments) }, args.idempotency_key);
      return text(`Queued ${sent.id} from ${sent.from.address} to ${sent.to.map(value => value.address).join(', ')}${sent.cc.length ? `, cc ${sent.cc.map(value => value.address).join(', ')}` : ''} (conversation ${sent.threadId}).${resolved([...to.resolved, ...cc.resolved, ...bcc.resolved])}\nDelivery status appears in read_conversation; replies arrive in the same conversation.`, { message: sent });
    }));

    server.registerTool('reply', {
      title: 'Reply',
      description: 'Reply in an existing conversation, threaded with the right email headers. Pass thread_id to answer the newest received message, or message_id to answer a specific one. Replies go to the sender (Reply-To if set); reply_all also copies everyone else. Use cc to loop in teammates (by name or address) on top of that.',
      inputSchema: z.object({
        thread_id: z.string().max(120).optional(), message_id: z.string().max(120).optional(),
        body: z.string().min(1).max(500_000).describe('Plain-text reply. Do not include the quoted original; set quote=true instead.'),
        html: z.string().max(500_000).optional(),
        reply_all: z.boolean().default(false),
        cc: recipients.optional().describe('Also copy these people, e.g. ["maya"] to loop in a teammate. Added to the reply_all recipients, not instead of them.'),
        bcc: recipients.optional(),
        quote: z.boolean().default(false).describe('Append the original message as quoted text.'),
        mailbox: mailboxArg,
        attachments: attachmentsArg,
        allow_automated: z.boolean().default(false).describe('Reply even to automated or no-reply senders. Only when the user explicitly asked.'),
        idempotency_key: z.string().max(200).optional(),
      }).refine(value => !!value.thread_id !== !!value.message_id, 'Pass exactly one of thread_id or message_id.'),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const [extraCc, bcc] = await Promise.all([resolveRecipients(directory, args.cc ?? []), resolveRecipients(directory, args.bcc ?? [])]);
      // OpenSend treats cc as the full list, so keep the reply_all recipients when adding people.
      let cc: string[] | undefined;
      if (extraCc.addresses.length) cc = [...new Set([...(args.reply_all ? await replyAllCc(client, mailbox, args.thread_id, args.message_id) : []), ...extraCc.addresses])];
      const body = { text: args.body, ...(args.html ? { html: args.html } : {}), replyAll: args.reply_all, quote: args.quote, allowAutomated: args.allow_automated, attachments: toAttachments(args.attachments), ...(cc ? { cc } : {}), ...(bcc.addresses.length ? { bcc: bcc.addresses } : {}) };
      const sent = args.thread_id ? await client.replyToThread(mailbox.id, args.thread_id, body, args.idempotency_key) : await client.replyToMessage(mailbox.id, args.message_id!, body, args.idempotency_key);
      return text(`Reply ${sent.id} queued to ${sent.to.map(value => value.address).join(', ')}${sent.cc.length ? `, cc ${sent.cc.map(value => value.address).join(', ')}` : ''} in conversation ${sent.threadId} ("${sent.subject}").${resolved([...extraCc.resolved, ...bcc.resolved])}`, { message: sent });
    }));

    server.registerTool('forward', {
      title: 'Forward',
      description: 'Forward a message to new recipients with an optional note. Original attachments are included by default.',
      inputSchema: z.object({
        message_id: z.string().min(1).max(120).describe('Message ID (msg_…) from read_conversation or search_mail.'),
        to: recipients, cc: recipients.optional(),
        note: z.string().max(100_000).optional().describe('Text placed above the forwarded message.'),
        include_attachments: z.boolean().default(true),
        mailbox: mailboxArg,
        idempotency_key: z.string().max(200).optional(),
      }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const [to, cc] = await Promise.all([resolveRecipients(directory, args.to), resolveRecipients(directory, args.cc ?? [])]);
      const sent = await client.forward(mailbox.id, args.message_id, { to: to.addresses, cc: cc.addresses, ...(args.note ? { text: args.note } : {}), includeAttachments: args.include_attachments }, args.idempotency_key);
      return text(`Forwarded as ${sent.id} to ${sent.to.map(value => value.address).join(', ')} ("${sent.subject}", ${sent.attachmentCount} attachment${sent.attachmentCount === 1 ? '' : 's'}).${resolved([...to.resolved, ...cc.resolved])}`, { message: sent });
    }));

    server.registerTool('update_conversations', {
      title: 'Organize conversations',
      description: 'Mark conversations read or unread, archive or unarchive, star, trash, flag as spam, or add and remove labels. Works on one or up to 100 conversations at once. Labels are created by using them.',
      inputSchema: z.object({
        thread_ids: z.union([z.string(), z.array(z.string()).min(1).max(100)]).transform(value => Array.isArray(value) ? value : [value]).describe('One conversation ID or a list.'),
        mailbox: mailboxArg,
        mark_read: z.boolean().optional().describe('true = read, false = unread.'),
        archive: z.boolean().optional().describe('true = archive (leave the inbox), false = move back to the inbox.'),
        star: z.boolean().optional(), trash: z.boolean().optional(), spam: z.boolean().optional(),
        add_labels: z.array(z.string().min(1).max(64)).max(20).optional(), remove_labels: z.array(z.string().min(1).max(64)).max(20).optional(),
      }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const changes = { ...(args.mark_read !== undefined ? { read: args.mark_read } : {}), ...(args.archive !== undefined ? { archived: args.archive } : {}), ...(args.star !== undefined ? { starred: args.star } : {}), ...(args.trash !== undefined ? { trashed: args.trash } : {}), ...(args.spam !== undefined ? { spam: args.spam } : {}),
        ...(args.add_labels?.length ? { addLabels: args.add_labels.map(label => label.toLowerCase()) } : {}), ...(args.remove_labels?.length ? { removeLabels: args.remove_labels.map(label => label.toLowerCase()) } : {}) };
      if (!Object.keys(changes).length) return failure('Nothing to change. Set mark_read, archive, star, trash, spam, add_labels or remove_labels.');
      const updated = await client.updateThreads(mailbox.id, args.thread_ids, changes);
      return text(`Updated ${updated.length} conversation${updated.length === 1 ? '' : 's'} in ${mailbox.address}:\n${threadLines(mailbox, updated)}`, { threads: updated });
    }));

    server.registerTool('wait_for_mail', {
      title: 'Wait for new mail',
      description: 'Block until new mail arrives (up to timeout_seconds, max 30) and return it. Start without a cursor, then always pass back the returned cursor so nothing is missed or repeated. Also reports delivery results for mail you sent when include_delivery is true.',
      inputSchema: z.object({
        mailbox: mailboxArg,
        cursor: z.string().max(20).optional().describe('Cursor from the previous wait_for_mail. Omit to start from now.'),
        timeout_seconds: z.number().int().min(0).max(30).default(25),
        include_delivery: z.boolean().default(false).describe('Also return sent, delivered, bounced and failed events for outgoing mail.'),
      }), annotations: readOnly,
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const types = ['message.received', ...(args.include_delivery ? ['message.sent', 'message.delivered', 'message.bounced', 'message.complained', 'message.failed'] : [])];
      const page = await client.events(mailbox.id, { after: args.cursor, wait: args.timeout_seconds, types });
      if (!page.data.length) return text(`No new mail in ${mailbox.address} after ${args.timeout_seconds}s.\nNext: wait_for_mail(cursor="${page.cursor}") to keep waiting.`, { events: [], cursor: page.cursor });
      const lines = page.data.map(event => {
        const data = event.data as { from?: { name: string | null; address: string }; subject?: string; snippet?: string; status?: string; errorCode?: string; automated?: boolean };
        return event.type === 'message.received'
          ? `● New mail ${event.messageId} in ${event.threadId} from ${data.from ? who(data.from) : 'unknown'}: "${data.subject ?? ''}"${data.automated ? ' (automated)' : ''}\n    ${data.snippet ?? ''}`
          : `○ ${event.type.replace('message.', '')}: ${event.messageId} in ${event.threadId} "${data.subject ?? ''}"${data.errorCode ? ` (${data.errorCode})` : ''}`;
      });
      return text(`${page.data.length} event${page.data.length === 1 ? '' : 's'} in ${mailbox.address}:\n\n${lines.join('\n')}\n\nNext: read_conversation(thread_id="…"), then wait_for_mail(cursor="${page.cursor}").`, { events: page.data, cursor: page.cursor });
    }));

    server.registerTool('get_attachment', {
      title: 'Get attachment',
      description: 'Open an attachment from read_conversation. Returns text files inline, images as images, and a short-lived download link for anything else.',
      inputSchema: z.object({ attachment_id: z.string().min(1).max(120).describe('Attachment ID (matt_…).'), mailbox: mailboxArg }), annotations: readOnly,
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const file = await client.attachment(mailbox.id, args.attachment_id);
      const textual = /^text\/|^application\/(?:json|xml|csv)|\+json$|\+xml$/.test(file.contentType);
      const image = /^image\/(?:png|jpeg|gif|webp)$/.test(file.contentType);
      if ((textual && file.size <= 256 * 1024) || (image && file.size <= 2 * 1024 * 1024)) {
        const response = await fetch(file.url);
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (textual) return text(`${file.filename} (${file.contentType}, ${size(file.size)}):\n\n${new TextDecoder().decode(bytes)}`);
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          return { content: [{ type: 'text' as const, text: `${file.filename} (${size(file.size)})` }, { type: 'image' as const, data: btoa(binary), mimeType: file.contentType }] };
        }
      }
      return text(`${file.filename} (${file.contentType}, ${size(file.size)}) cannot be shown inline. Download link, valid until ${file.expiresAt}:\n${file.url}`, { attachment: file });
    }));

    server.registerTool('find_people', {
      title: 'Find people',
      description: 'List the people in your organization and its other agent mailboxes, with their addresses, like a company directory. Use it to cc or forward to a teammate. Names also work directly in to, cc and bcc.',
      inputSchema: z.object({ query: z.string().max(100).optional().describe('Filter by name or address, e.g. "maya" or "ops".') }), annotations: readOnly,
    }, run(async (_client, args) => {
      if (!directory) return failure('This connection is not part of an organization.');
      const result = await directoryText(directory, args.query);
      return text(result.text, { people: result.people, agents: result.agents });
    }));

    server.registerTool('list_labels', {
      title: 'List labels',
      description: 'List the labels in use in a mailbox with conversation and message counts.',
      inputSchema: z.object({ mailbox: mailboxArg }), annotations: readOnly,
    }, run(async (client, args) => {
      const mailbox = await pickMailbox(client, args.mailbox);
      const { data } = await client.labels(mailbox.id);
      if (!data.length) return text(`No labels in ${mailbox.address} yet. Add one with update_conversations(add_labels=[…]).`, { labels: [] });
      return text(`Labels in ${mailbox.address}:\n${data.map(label => `- ${label.name}: ${label.threads} conversations, ${label.messages} messages${label.unreadMessages ? ` (${label.unreadMessages} unread)` : ''}`).join('\n')}\n\nNext: check_inbox(search="…") or search_mail(label="…").`, { labels: data });
    }));

    void own;
    return server;
  };
}
