import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { Archive, ArrowLeft, Inbox, Mail, MailOpen, Paperclip, Search, Star, Trash2, Undo2 } from 'lucide-react'
import { Alert, Button, Checkbox, ConfirmDialog, EmptyState, ErrorState, IconButton, Input, PageHeader, SkeletonText, StatusBadge, Tabs, Textarea, useToast } from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { useApi, useApiMutation, useApiQuery } from '../../data/context'
import { ApiError, type Mailbox, type MailboxMessage, type MailboxThread, type MailboxThreadDetail, type MailboxThreadView, type MailAddress } from '../../data/types'
import { date, label, time } from '../../lib/format'
import '../settings/settings.css'
import './mailboxes.css'

const views: { value: MailboxThreadView; label: string }[] = [{ value: 'inbox', label: 'Inbox' }, { value: 'starred', label: 'Starred' }, { value: 'archive', label: 'Archive' }, { value: 'spam', label: 'Spam' }, { value: 'trash', label: 'Trash' }, { value: 'all', label: 'All' }]
const nameOf = (value: MailAddress) => value.name || value.address.split('@')[0]!
const full = (value: MailAddress) => value.name ? `${value.name} <${value.address}>` : value.address
function when(value: string) {
  const at = new Date(value), now = new Date()
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}
const statusTone = (status: string) => status === 'delivered' ? 'success' as const : ['bounced', 'complained', 'rejected', 'suppressed', 'rendering_failed', 'canceled'].includes(status) ? 'danger' as const : status === 'delayed' ? 'warning' as const : 'neutral' as const

function ownAddresses(mailbox?: Mailbox) { return new Set(mailbox ? [mailbox.address, ...mailbox.aliases] : []) }
function counterparts(thread: MailboxThread, own: Set<string>) {
  const others = thread.participants.filter(person => !own.has(person.address))
  return others.length ? others : thread.participants
}

function ThreadRow({ thread, own, selected, onSelect }: { thread: MailboxThread; own: Set<string>; selected: boolean; onSelect: () => void }) {
  const people = counterparts(thread, own)
  const unread = thread.unreadCount > 0
  return <li><button type="button" className="mailbox-thread-row" data-selected={selected || undefined} data-unread={unread || undefined} onClick={onSelect} aria-current={selected || undefined}>
    <span className="mailbox-thread-row__top">
      {unread && <span className="mailbox-unread-dot" aria-label="Unread" />}
      <span className="mailbox-thread-row__people">{people.slice(0, 2).map(nameOf).join(', ')}{people.length > 2 && ` +${people.length - 2}`}</span>
      {thread.starred && <Star size={12} className="mailbox-star" aria-label="Starred" />}
      {thread.messageCount > 1 && <span className="mailbox-thread-row__count" aria-label={`${thread.messageCount} messages`}>{thread.messageCount}</span>}
      <time className="mailbox-thread-row__time" dateTime={thread.lastMessageAt}>{when(thread.lastMessageAt)}</time>
    </span>
    <span className="mailbox-thread-row__subject">{thread.subject || '(no subject)'}</span>
    <span className="mailbox-thread-row__snippet">{thread.snippet}</span>
    {thread.labels.filter(item => item !== 'spam').length > 0 && <span className="mailbox-labels">{thread.labels.filter(item => item !== 'spam').map(item => <span key={item} className="mailbox-label">{item}</span>)}</span>}
  </button></li>
}

function MessageCard({ mailboxId, message, parent, expanded, onToggle, own }: { mailboxId: string; message: MailboxMessage; parent?: MailboxMessage; expanded: boolean; onToggle: () => void; own: Set<string> }) {
  const api = useApi()
  const toast = useToast()
  const [showQuoted, setShowQuoted] = useState(false)
  const [formatted, setFormatted] = useState(false)
  const outbound = message.direction === 'outbound' || own.has(message.from.address)
  const recipients = [...message.to, ...message.cc]
  const hasQuote = message.text.trim() !== message.replyText.trim() && message.replyText.trim().length > 0
  async function download(attachmentId: string) {
    try { window.open((await api.mailboxes.attachmentUrl(mailboxId, attachmentId)).url, '_blank', 'noopener') }
    catch (error) { toast(error instanceof Error ? error.message : 'The attachment could not be opened.', 'error') }
  }
  return <li id={`message-${message.id}`} className="mailbox-message" data-direction={outbound ? 'outbound' : 'inbound'} data-unread={!message.read || undefined}>
    <span className="mailbox-message__node" aria-hidden="true" />
    <article className="mailbox-message__card">
      <button type="button" className="mailbox-message__header" onClick={onToggle} aria-expanded={expanded}>
        <span className="mailbox-message__from"><strong>{outbound ? 'You' : nameOf(message.from)}</strong><span className="muted">{message.from.address}</span></span>
        <span className="mailbox-message__meta">
          {!message.read && <StatusBadge status="New" tone="info" />}
          {outbound && <StatusBadge status={label(message.status)} tone={statusTone(message.status)} />}
          <time dateTime={message.receivedAt} title={`${date(message.receivedAt)} ${time(message.receivedAt)} UTC`}>{when(message.receivedAt)}</time>
        </span>
      </button>
      <p className="mailbox-message__context">
        <span title={recipients.map(full).join(', ')}>to {recipients.map(person => own.has(person.address) ? 'you' : nameOf(person)).join(', ') || '—'}</span>
        {parent ? <span className="mailbox-message__reply-to"><Undo2 size={12} aria-hidden="true" />Replying to <a href={`#message-${parent.id}`} onClick={event => { event.preventDefault(); document.getElementById(`message-${parent.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}>{parent.direction === 'outbound' || own.has(parent.from.address) ? 'your message' : nameOf(parent.from)}</a> · {when(parent.receivedAt)}</span>
          : message.inReplyTo ? <span className="mailbox-message__reply-to"><Undo2 size={12} aria-hidden="true" />Reply to an earlier message</span> : null}
      </p>
      {expanded ? <>
        {message.errorCode && <Alert tone="danger">Delivery failed: {message.errorCode}</Alert>}
        {formatted && message.html ? <EmailPreview html={message.html} title={`Message from ${nameOf(message.from)}`} remoteImages className="mailbox-message__html" />
          : <div className="mailbox-message__body">{(showQuoted ? message.text : message.replyText || message.text) || <span className="muted">(no text)</span>}</div>}
        {(hasQuote || message.html) && <div className="cluster mailbox-message__toggles">
          {hasQuote && !formatted && <Button variant="ghost" size="sm" onClick={() => setShowQuoted(value => !value)}>{showQuoted ? 'Hide quoted text' : 'Show quoted text'}</Button>}
          {message.html && <Button variant="ghost" size="sm" onClick={() => setFormatted(value => !value)}>{formatted ? 'Show plain text' : 'Show formatted'}</Button>}
        </div>}
        {message.attachments.length > 0 && <ul className="mailbox-attachments">{message.attachments.map(file => <li key={file.id}><button type="button" onClick={() => void download(file.id)}><Paperclip size={12} aria-hidden="true" />{file.filename}<span className="muted">{Math.max(1, Math.round(file.size / 1024))} KB</span></button></li>)}</ul>}
      </> : <p className="mailbox-message__snippet muted">{message.snippet}</p>}
    </article>
  </li>
}

function Conversation({ mailbox, thread, onBack }: { mailbox: Mailbox; thread: MailboxThreadDetail; onBack: () => void }) {
  const own = useMemo(() => ownAddresses(mailbox), [mailbox])
  const byMessageId = useMemo(() => new Map(thread.messages.filter(m => m.messageId).map(m => [m.messageId!, m])), [thread.messages])
  const lastId = thread.messages.at(-1)?.id
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const [collapsedLast, setCollapsedLast] = useState(false)
  useEffect(() => { setOpened(new Set()); setCollapsedLast(false) }, [thread.id])
  // Short conversations stay open; longer ones open the newest and any unread message.
  const isExpanded = (message: MailboxMessage) => opened.has(message.id) || (message.id === lastId ? !collapsedLast : thread.messages.length <= 3 || !message.read)
  const toggle = (message: MailboxMessage) => {
    if (message.id === lastId && !opened.has(message.id)) { setCollapsedLast(value => !value); return }
    setOpened(current => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next })
  }
  const update = useApiMutation((api, patch: Parameters<typeof api.mailboxes.updateThread>[2]) => api.mailboxes.updateThread(mailbox.id, thread.id, patch))
  const act = (patch: Parameters<typeof update.mutateAsync>[0]) => { update.mutateAsync(patch).catch(() => undefined) }
  const others = counterparts(thread, own)
  return <section className="mailbox-conversation" aria-label="Conversation">
    <header className="mailbox-conversation__header">
      <IconButton variant="ghost" className="mailbox-back" label="Back to conversations" onClick={onBack}><ArrowLeft size={16} /></IconButton>
      <div className="mailbox-conversation__title">
        <h2>{thread.subject || '(no subject)'}</h2>
        <p className="muted">{thread.messageCount} message{thread.messageCount === 1 ? '' : 's'} · with {others.map(nameOf).join(', ')}</p>
        {thread.labels.length > 0 && <span className="mailbox-labels">{thread.labels.map(item => <span key={item} className="mailbox-label">{item}</span>)}</span>}
      </div>
      <div className="cluster mailbox-conversation__actions">
        <IconButton variant="ghost" label={thread.unreadCount ? 'Mark read' : 'Mark unread'} onClick={() => act({ read: thread.unreadCount > 0 })}>{thread.unreadCount ? <MailOpen size={16} /> : <Mail size={16} />}</IconButton>
        <IconButton variant="ghost" label={thread.starred ? 'Unstar' : 'Star'} onClick={() => act({ starred: !thread.starred })}><Star size={16} className={thread.starred ? 'mailbox-star' : undefined} /></IconButton>
        <IconButton variant="ghost" label={thread.archived ? 'Move to inbox' : 'Archive'} onClick={() => act({ archived: !thread.archived })}>{thread.archived ? <Inbox size={16} /> : <Archive size={16} />}</IconButton>
        <IconButton variant="ghost" label={thread.trashed ? 'Restore' : 'Move to trash'} onClick={() => act({ trashed: !thread.trashed })}>{thread.trashed ? <Undo2 size={16} /> : <Trash2 size={16} />}</IconButton>
      </div>
    </header>
    <ol className="mailbox-messages">
      {thread.messages.map(message => <MessageCard key={message.id} mailboxId={mailbox.id} message={message} own={own} parent={message.inReplyTo ? byMessageId.get(message.inReplyTo) : undefined} expanded={isExpanded(message)} onToggle={() => toggle(message)} />)}
    </ol>
    <Composer mailbox={mailbox} thread={thread} own={own} />
  </section>
}

function Composer({ mailbox, thread, own }: { mailbox: Mailbox; thread: MailboxThreadDetail; own: Set<string> }) {
  const target = [...thread.messages].reverse().find(m => m.direction === 'inbound') ?? thread.messages.at(-1)!
  const [text, setText] = useState('')
  const [replyAll, setReplyAll] = useState(false)
  const [automated, setAutomated] = useState<string | null>(null)
  const key = useRef(crypto.randomUUID())
  const send = useApiMutation((api, input: { allowAutomated: boolean }) => api.mailboxes.reply(mailbox.id, target.id, { text: text.trim(), replyAll, allowAutomated: input.allowAutomated, idempotencyKey: key.current }), 'Reply queued')
  useEffect(() => { setText(''); setReplyAll(false); send.reset(); key.current = crypto.randomUUID() }, [thread.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const recipient = target.direction === 'inbound' && !own.has(target.from.address) ? (target.replyTo[0] ?? target.from) : target.to[0]
  const others = [...target.to, ...target.cc].filter(person => !own.has(person.address) && person.address !== recipient?.address)
  async function submit(event?: FormEvent, allowAutomated = false) {
    event?.preventDefault()
    if (!text.trim()) return
    try { await send.mutateAsync({ allowAutomated }); setText(''); key.current = crypto.randomUUID() }
    catch (error) { if (error instanceof ApiError && ['REPLY_TO_AUTOMATED', 'REPLY_TO_NO_REPLY'].includes(error.code)) { send.reset(); setAutomated(error.message.replace(/\s*\[[A-Z_]+\].*$/, '')) } }
  }
  return <form className="mailbox-composer" data-filled={text ? true : undefined} onSubmit={submit}>
    <label className="mailbox-composer__to" htmlFor="mailbox-reply">Reply to {recipient ? full(recipient) : 'this conversation'}{replyAll && others.length > 0 && <span className="muted"> and {others.map(nameOf).join(', ')}</span>}</label>
    <Textarea id="mailbox-reply" rows={2} value={text} onChange={event => setText(event.target.value)} placeholder={`Write a reply as ${mailbox.address}`} disabled={send.isPending} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit() }} />
    {send.error && <Alert tone="danger">{send.error instanceof Error ? send.error.message : 'The reply could not be sent.'}</Alert>}
    <div className="mailbox-composer__actions">
      {others.length > 0 ? <Checkbox label={`Reply all (${others.length + 1})`} checked={replyAll} onCheckedChange={setReplyAll} disabled={send.isPending} /> : <span />}
      <Button variant="primary" type="submit" loading={send.isPending} disabled={!text.trim()}>Send reply</Button>
    </div>
    <ConfirmDialog open={!!automated} onOpenChange={open => { if (!open) setAutomated(null) }} title="Send to an automated sender?" description={`${automated ?? ''} Replying to automated mail can start a loop between systems.`} confirmLabel="Send anyway" onConfirm={() => submit(undefined, true)} />
  </form>
}

export function MailboxDetailPage() {
  const { id = '' } = useParams()
  const api = useApi()
  const [params, setParams] = useSearchParams()
  const view = (views.some(item => item.value === params.get('view')) ? params.get('view') : 'inbox') as MailboxThreadView
  const threadId = params.get('thread')
  const [search, setSearch] = useState('')
  const mailbox = useApiQuery(['mailbox', id], (api, signal) => api.mailboxes.get(id, signal))
  const threads = useApiQuery(['mailbox-threads', id, view, search], (api, signal) => api.mailboxes.threads(id, { view, search: search.trim() || undefined }, signal))
  const thread = useApiQuery(['mailbox-thread', id, threadId], (api, signal) => threadId ? api.mailboxes.thread(id, threadId, signal) : Promise.resolve(null))
  const own = useMemo(() => ownAddresses(mailbox.data), [mailbox.data])
  const select = (next: string | null) => { const search = new URLSearchParams(params); if (next) search.set('thread', next); else search.delete('thread'); setParams(search) }
  if (api.environment === 'test') return <><PageHeader title="Mailbox" backTo="/mailboxes" /><Alert tone="info">Mailboxes receive real mail, so they are managed in live mode only.</Alert></>
  if (mailbox.error) return <><PageHeader title="Mailbox" backTo="/mailboxes" /><ErrorState error={mailbox.error} onRetry={() => void mailbox.refetch()} /></>
  const unread = threads.data?.filter(item => item.unreadCount > 0).length ?? 0
  return <div className="mailbox-page" data-thread-open={threadId ? true : undefined}>
    <PageHeader title={mailbox.data ? <span className="mailbox-title">{mailbox.data.address}{mailbox.data.displayName && <span className="muted">{mailbox.data.displayName}</span>}</span> : <SkeletonText width={240} lineHeight={28} />} backTo="/mailboxes" />
    <div className="mailbox-layout">
      <aside className="mailbox-list" aria-label="Conversations">
        <Tabs label="Mailbox views" value={view} onValueChange={value => { const search = new URLSearchParams(params); search.set('view', value); search.delete('thread'); setParams(search) }} items={views} />
        <div className="search-box mailbox-search"><Search size={16} /><Input type="search" aria-label="Search conversations" placeholder="Search mail" value={search} onChange={event => setSearch(event.target.value)} /></div>
        {threads.error ? <ErrorState error={threads.error} onRetry={() => void threads.refetch()} /> : threads.isPending ? <div className="mailbox-thread-skeleton">{[0, 1, 2, 3].map(index => <div key={index}><SkeletonText width="60%" /><SkeletonText width="85%" /></div>)}</div>
          : threads.data.length ? <>
            <p className="muted mailbox-list__summary">{threads.data.length}{threads.data.nextCursor ? '+' : ''} conversation{threads.data.length === 1 ? '' : 's'}{unread ? ` · ${unread} unread` : ''}</p>
            <ul className="mailbox-threads">{threads.data.map(item => <ThreadRow key={item.id} thread={item} own={own} selected={item.id === threadId} onSelect={() => select(item.id)} />)}</ul>
          </> : <EmptyState title={search ? 'No matching conversations' : `Nothing in ${views.find(item => item.value === view)!.label.toLowerCase()}`} />}
      </aside>
      <div className="mailbox-reader">
        {!threadId ? <EmptyState title="Select a conversation" description="Messages are grouped by their reply headers, so every reply appears with the message it answers." />
          : thread.error ? <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />
          : thread.isPending || !mailbox.data || !thread.data ? <div className="mailbox-thread-skeleton"><SkeletonText width="50%" lineHeight={24} /><SkeletonText width="80%" /><SkeletonText width="70%" /></div>
          : <Conversation mailbox={mailbox.data} thread={thread.data} onBack={() => select(null)} />}
      </div>
    </div>
  </div>
}
