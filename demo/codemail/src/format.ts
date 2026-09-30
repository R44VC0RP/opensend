// Compact, agent-readable text for tool results. Each result names the IDs to use next.
import type { Address, Mailbox, Message, Thread, ThreadDetail } from './opensend.js';

export const who = (value: Address) => value.name ? `${value.name} <${value.address}>` : value.address;
export const shortWho = (value: Address) => value.name || value.address;

export function ago(iso: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60); if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60); if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
export const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
export const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
// The mailbox's own addresses, including plus-address variants (support+billing@ counts as support@).
export function own(mailbox: Mailbox) {
  const addresses = new Set([mailbox.address, ...mailbox.aliases].map(value => value.toLowerCase()));
  return { has: (value: string) => { const lower = value.toLowerCase(); const [local = '', host = ''] = lower.split('@'); return addresses.has(lower) || addresses.has(`${local.split('+')[0]}@${host}`); } };
}

export function mailboxLine(mailbox: Mailbox) {
  const unread = mailbox.stats.unreadThreads ? `${mailbox.stats.unreadThreads} unread` : 'no unread';
  const last = mailbox.stats.lastMessageAt ? `, last mail ${ago(mailbox.stats.lastMessageAt)}` : '';
  return `- ${mailbox.address}${mailbox.displayName ? ` (${mailbox.displayName})` : ''}: ${mailbox.stats.threads} conversations, ${unread}${last}${mailbox.aliases.length ? `; aliases ${mailbox.aliases.join(', ')}` : ''} [${mailbox.id}]`;
}

export function threadLines(mailbox: Mailbox, threads: Thread[]) {
  const mine = own(mailbox);
  return threads.map(thread => {
    const others = thread.participants.filter(person => !mine.has(person.address.toLowerCase()));
    const people = (others.length ? others : thread.participants).slice(0, 3).map(shortWho).join(', ');
    const flags = [thread.unreadCount ? `${thread.unreadCount} unread` : null, thread.starred ? 'starred' : null, thread.archived ? 'archived' : null, thread.spam ? 'spam' : null, ...thread.labels.filter(label => label !== 'spam').map(label => `#${label}`)].filter(Boolean).join(', ');
    return `${thread.unreadCount ? '●' : '○'} ${thread.id} · ${people} · "${thread.subject || '(no subject)'}" · ${thread.messageCount} msg · ${ago(thread.lastMessageAt)}${flags ? ` · ${flags}` : ''}\n    ${thread.snippet || '(empty)'}`;
  }).join('\n');
}

export function conversationText(mailbox: Mailbox, thread: ThreadDetail, includeQuoted: boolean, tag: (address: string) => { kind: string; name: string | null } | null = () => null) {
  const mine = own(mailbox);
  const index = new Map(thread.messages.map((message, position) => [message.messageId ?? '', position + 1]));
  const person = (value: Address) => { if (mine.has(value.address.toLowerCase())) return `you (${value.address})`; const known = tag(value.address); return known ? `${who({ name: value.name || known.name, address: value.address })} (${known.kind})` : who(value); };
  const parts = thread.messages.map((message, position) => {
    const parent = message.inReplyTo ? index.get(message.inReplyTo) : undefined;
    const meta = [
      message.direction === 'outbound' ? `sent, ${message.status}${message.errorCode ? ` (${message.errorCode})` : ''}` : message.read ? 'read' : 'UNREAD',
      parent ? `replying to [${parent}]` : message.inReplyTo ? 'reply to an earlier message' : null,
      message.automated ? 'automated sender' : null, message.spam ? 'spam' : null,
      ...message.labels.map(label => `#${label}`),
    ].filter(Boolean).join(' · ');
    const body = (includeQuoted ? message.text : message.replyText || message.text)?.trim() || '(no text)';
    const files = message.attachments?.length ? `\nAttachments: ${message.attachments.map(file => `${file.filename} (${size(file.size)}, ${file.id})`).join('; ')}` : '';
    const recipients = [...message.to, ...message.cc].map(person).join(', ') || '—';
    return `[${position + 1}] ${message.id} · ${utc(message.receivedAt)} · ${meta}\nFrom: ${person(message.from)}\nTo: ${recipients}\n\n${body}${files}`;
  });
  return parts.join('\n\n---\n\n');
}

export function messageLines(messages: Message[]) {
  return messages.map(message => `${message.read ? '○' : '●'} ${message.id} (thread ${message.threadId}) · ${message.direction === 'outbound' ? `to ${message.to.map(shortWho).join(', ')}` : `from ${who(message.from)}`} · "${message.subject}" · ${ago(message.receivedAt)}${message.direction === 'outbound' ? ` · ${message.status}` : ''}\n    ${message.snippet}`).join('\n');
}
