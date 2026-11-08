import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Archive, ArrowLeft, Inbox, Mail, MailOpen, Paperclip, Reply, Search, Star, Trash2, Undo2, X } from 'lucide-react'
import { Alert, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, Pagination, Select, SkeletonText, StatusBadge, Tabs, Textarea, useToast } from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { useApi, useApiDef, useApiMutation, useApiQuery } from '../../data/context'
import { queries } from '../../data/queries'
import { ApiError, type InboundAddress, type InboundMessage, type InboundThread, type InboundThreadDetail, type InboundThreadPatch, type InboundThreadView, type MailAddress } from '../../data/types'
import { date, label, time } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { ownAddressesOf, replyRecipients, senderOf } from '../../lib/reply-recipients'
import { fieldError, MutationError } from '../settings/shared'
import { addressName, full, idempotencyFor, nameOf, when } from './shared'
import '../settings/settings.css'
import './inbound.css'

const views: { value: InboundThreadView; label: string }[] = [{ value: 'inbox', label: 'Inbox' }, { value: 'starred', label: 'Starred' }, { value: 'archive', label: 'Archive' }, { value: 'spam', label: 'Spam' }, { value: 'trash', label: 'Trash' }, { value: 'all', label: 'All' }]
const statusTone = (status: string) => status === 'delivered' ? 'success' as const : ['bounced', 'complained', 'rejected', 'suppressed', 'rendering_failed', 'canceled'].includes(status) ? 'danger' as const : status === 'delayed' ? 'warning' as const : 'neutral' as const
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
type Addresses = Map<string, InboundAddress>
const ownAddresses = (addresses: Addresses) => new Set([...addresses.values()].flatMap(address => [...ownAddressesOf(address)]))

function AddressLabels({ ids, addresses }: { ids: string[]; addresses: Addresses }) {
  return <>{ids.slice(0, 3).map(id => <span key={id} className="mailbox-address-label" title={addressName(addresses, id)}>{addressName(addresses, id)}</span>)}{ids.length > 3 && <span className="mailbox-address-label">+{ids.length - 3}</span>}</>
}

function ThreadRow({ thread, addresses, showAddresses, selected, onSelect }: { thread: InboundThread; addresses: Addresses; showAddresses: boolean; selected: boolean; onSelect: () => void }) {
  return <li><button type="button" className="mailbox-thread-row" data-selected={selected || undefined} onClick={onSelect} aria-current={selected || undefined}>
    <span className="mailbox-thread-row__top">
      <span className="inbound-thread-row__subject">{thread.subject || '(no subject)'}</span>
      {thread.messageCount > 1 && <span className="mailbox-thread-row__count" aria-label={`${thread.messageCount} messages`}>{thread.messageCount}</span>}
      <time className="mailbox-thread-row__time" dateTime={thread.lastMessageAt}>{when(thread.lastMessageAt)}</time>
    </span>
    <span className="mailbox-thread-row__snippet">{thread.snippet}</span>
    {showAddresses && thread.addressIds.length > 0 && <span className="mailbox-labels"><AddressLabels ids={thread.addressIds} addresses={addresses} /></span>}
  </button></li>
}

function MessageCard({ message, addressId, parent, expanded, onToggle, onReply, isTarget, showAddresses, addresses, own }: {
  message: InboundMessage; addressId?: string; parent?: InboundMessage; expanded: boolean; onToggle: () => void; onReply: () => void; isTarget: boolean; showAddresses: boolean; addresses: Addresses; own: Set<string>
}) {
  const api = useApi()
  const toast = useToast()
  const [showQuoted, setShowQuoted] = useState(false)
  const [formatted, setFormatted] = useState(false)
  // Timeline bodies are previews; the full body, HTML and attachments load from the message itself only when asked for.
  const [wanted, setWanted] = useState<null | 'full' | 'formatted' | 'attachments'>(null)
  const detail = useApiQuery(['inbound-message', message.id, addressId ?? null, wanted !== null], (api, signal) => wanted ? api.inbound.message(message.id, { addressId }, signal) : Promise.resolve(null))
  const loaded = detail.data ?? null
  useEffect(() => { if (wanted === 'formatted' && loaded?.html) setFormatted(true) }, [wanted, loaded])
  const outbound = message.direction === 'outbound'
  const unread = message.read === false
  const text = loaded?.text ?? message.text, replyText = loaded?.replyText ?? message.replyText
  const recipients = [...message.to, ...message.cc]
  const hasQuote = text.trim() !== replyText.trim() && replyText.trim().length > 0
  const pending = detail.isFetching && wanted !== null
  async function download(attachmentId: string) {
    try { window.open((await api.inbound.attachmentUrl(message.id, attachmentId, { addressId })).url, '_blank', 'noopener') }
    catch (error) { toast(error instanceof Error ? error.message : 'The attachment could not be opened.', 'error') }
  }
  return <li id={`message-${message.id}`} className="mailbox-message" data-direction={outbound ? 'outbound' : 'inbound'} data-unread={unread || undefined} data-reply-target={isTarget || undefined}>
    <article className="mailbox-message__card">
      <button type="button" className="mailbox-message__header" onClick={onToggle} aria-expanded={expanded}>
        <span className="mailbox-message__from"><strong>{outbound ? 'You' : nameOf(message.from)}</strong><span className="muted">{message.from.address}</span></span>
        <span className="mailbox-message__meta">
          {unread && <StatusBadge status="New" tone="info" />}
          {outbound && <StatusBadge status={label(message.status)} tone={statusTone(message.status)} />}
          <time dateTime={message.receivedAt} title={`${date(message.receivedAt)} ${time(message.receivedAt)} UTC`}>{when(message.receivedAt)}</time>
        </span>
      </button>
      <p className="mailbox-message__context">
        <span title={recipients.map(full).join(', ')}>to {recipients.map(person => own.has(person.address.toLowerCase()) ? person.address : nameOf(person)).join(', ') || '—'}</span>
        {showAddresses && <span>via {message.addressIds.map(id => addressName(addresses, id)).join(', ')}</span>}
        {parent ? <span className="mailbox-message__reply-to"><Undo2 size={12} aria-hidden="true" />Replying to <a href={`#message-${parent.id}`} onClick={event => { event.preventDefault(); document.getElementById(`message-${parent.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}>{parent.direction === 'outbound' ? 'your message' : nameOf(parent.from)}</a> · {when(parent.receivedAt)}</span>
          : message.inReplyTo ? <span className="mailbox-message__reply-to"><Undo2 size={12} aria-hidden="true" />Reply to an earlier message</span> : null}
      </p>
      {expanded ? <>
        {detail.error && <Alert tone="danger">{detail.error instanceof Error ? detail.error.message : 'The full message could not be loaded.'}</Alert>}
        {loaded ? loaded.bodyTruncated && <Alert tone="info">Part of this message was too large to store in full.</Alert>
          : message.bodyTruncated && <Alert tone="info">This is a preview of a long message. <Button variant="ghost" size="sm" loading={pending && wanted === 'full'} onClick={() => setWanted('full')}>Show the full message</Button></Alert>}
        {formatted && loaded?.html ? <EmailPreview html={loaded.html} title={`Message from ${nameOf(message.from)}`} remoteImages className="mailbox-message__html" />
          : <div className="mailbox-message__body">{(showQuoted ? text : replyText || text) || <span className="muted">(no text)</span>}</div>}
        {loaded && wanted === 'formatted' && !loaded.html && <p className="mailbox-message__attachments-note muted">This message has no formatted version.</p>}
        <div className="cluster mailbox-message__toggles">
          <Button variant="ghost" size="sm" onClick={onReply} aria-pressed={isTarget}><Reply size={14} aria-hidden="true" />{isTarget ? 'Replying to this' : 'Reply to this message'}</Button>
          {hasQuote && !formatted && <Button variant="ghost" size="sm" onClick={() => setShowQuoted(value => !value)}>{showQuoted ? 'Hide quoted text' : 'Show quoted text'}</Button>}
          {loaded?.html ? <Button variant="ghost" size="sm" onClick={() => setFormatted(value => !value)}>{formatted ? 'Show plain text' : 'Show formatted'}</Button>
            : !loaded && <Button variant="ghost" size="sm" loading={pending && wanted === 'formatted'} onClick={() => setWanted('formatted')}>Show formatted</Button>}
        </div>
        {message.attachmentCount > 0 && (loaded ? loaded.attachments.length > 0 && <ul className="mailbox-attachments">{loaded.attachments.map(file => <li key={file.id}><button type="button" onClick={() => void download(file.id)}><Paperclip size={12} aria-hidden="true" />{file.filename}<span className="muted">{Math.max(1, Math.round(file.size / 1024))} KB</span></button></li>)}</ul>
          : <div className="mailbox-attachments"><Button variant="ghost" size="sm" loading={pending && wanted === 'attachments'} onClick={() => setWanted('attachments')}><Paperclip size={12} aria-hidden="true" />Show {message.attachmentCount} attachment{message.attachmentCount === 1 ? '' : 's'}</Button></div>)}
      </> : <p className="mailbox-message__snippet muted">{message.snippet}</p>}
    </article>
  </li>
}

function Conversation({ thread, addressId, addresses, focusMessage, onBack }: { thread: InboundThreadDetail; addressId?: string; addresses: Addresses; focusMessage: string | null; onBack: () => void }) {
  const api = useApi()
  const own = useMemo(() => ownAddresses(addresses), [addresses])
  // Older pages hang off the first page's oldest message; if a refetch moves that boundary, the cursors are stale.
  const [older, setOlder] = useState<{ anchor: string | undefined; messages: InboundMessage[]; cursor: string | null } | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<unknown>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [target, setTarget] = useState<string | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const anchor = thread.messages[0]?.id
  const olderPages = older && older.anchor === anchor ? older : null
  useEffect(() => { setOlder(null); setOlderError(null); setExpanded({}); setTarget(null) }, [thread.id, addressId])
  useEffect(() => { if (older && older.anchor !== anchor) { setOlder(null); setOlderError(null) } }, [older, anchor])
  const messages = useMemo(() => {
    const seen = new Set<string>()
    return [...(olderPages?.messages ?? []), ...thread.messages].filter(message => !seen.has(message.id) && seen.add(message.id))
  }, [olderPages, thread.messages])
  const olderCursor = olderPages ? olderPages.cursor : thread.nextCursor
  // Read, star, archive and trash are per address: offer them only when exactly one address is in scope.
  const states = thread.addressStates ?? []
  const stateAddress = addressId ?? (states.length === 1 ? states[0]!.addressId : undefined)
  const flags = stateAddress ? states.find(state => state.addressId === stateAddress) : undefined
  const byMessageId = useMemo(() => new Map(messages.filter(m => m.messageId).map(m => [m.messageId!, m])), [messages])
  const lastId = messages.at(-1)?.id
  const showAddresses = !addressId && thread.addressIds.length > 1
  const focused = useRef<string | null>(null)
  useEffect(() => {
    if (!focusMessage || focused.current === focusMessage || !messages.some(message => message.id === focusMessage)) return
    focused.current = focusMessage
    setExpanded(current => ({ ...current, [focusMessage]: true }))
    requestAnimationFrame(() => document.getElementById(`message-${focusMessage}`)?.scrollIntoView({ block: 'center' }))
  }, [focusMessage, messages])
  const isExpanded = (message: InboundMessage) => expanded[message.id] ?? (message.id === lastId || messages.length <= 3 || message.read === false)
  const toggle = (message: InboundMessage) => setExpanded(current => ({ ...current, [message.id]: !isExpanded(message) }))
  const update = useApiMutation((api, patch: Omit<InboundThreadPatch, 'addressId'>) => api.inbound.updateThread(thread.id, { addressId: stateAddress, ...patch }))
  const act = (patch: Omit<InboundThreadPatch, 'addressId'>) => { update.mutateAsync(patch).catch(() => undefined) }
  async function loadOlder() {
    if (!olderCursor) return
    setLoadingOlder(true); setOlderError(null)
    try { const page = await api.inbound.thread(thread.id, { addressId, cursor: olderCursor }); setOlder({ anchor, messages: [...page.messages, ...(olderPages?.messages ?? [])], cursor: page.nextCursor }) }
    catch (error) { setOlderError(error) }
    finally { setLoadingOlder(false) }
  }
  function replyTo(message: InboundMessage) {
    setTarget(current => current === message.id ? null : message.id)
    requestAnimationFrame(() => composer.current?.focus())
  }
  const people = [...new Map(messages.filter(message => message.direction === 'inbound').map(message => [message.from.address, message.from])).values()]
  const replyTarget = messages.find(message => message.id === target) ?? messages.at(-1)!
  return <section className="mailbox-conversation" aria-label="Conversation">
    <header className="mailbox-conversation__header">
      <IconButton variant="ghost" className="mailbox-back" label="Back to conversations" onClick={onBack}><ArrowLeft size={16} /></IconButton>
      <div className="mailbox-conversation__title">
        <h2>{thread.subject || '(no subject)'}</h2>
        <p className="muted">{thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}{people.length > 0 && ` · with ${people.map(nameOf).join(', ')}`}</p>
        {(!addressId || (flags && flags.labels.length > 0)) && <span className="mailbox-labels">
          {!addressId && <AddressLabels ids={thread.addressIds} addresses={addresses} />}
          {flags?.labels.map(item => <span key={item} className="mailbox-label">{item}</span>)}
        </span>}
      </div>
      {flags && <div className="cluster mailbox-conversation__actions">
        <IconButton variant="ghost" label={flags.unreadCount ? 'Mark read' : 'Mark unread'} onClick={() => act({ read: flags.unreadCount > 0 })}>{flags.unreadCount ? <MailOpen size={16} /> : <Mail size={16} />}</IconButton>
        <IconButton variant="ghost" label={flags.starred ? 'Unstar' : 'Star'} onClick={() => act({ starred: !flags.starred })}><Star size={16} className={flags.starred ? 'mailbox-star' : undefined} /></IconButton>
        <IconButton variant="ghost" label={flags.archived ? 'Move to inbox' : 'Archive'} onClick={() => act({ archived: !flags.archived })}>{flags.archived ? <Inbox size={16} /> : <Archive size={16} />}</IconButton>
        <IconButton variant="ghost" label={flags.trashed ? 'Restore' : 'Move to trash'} onClick={() => act({ trashed: !flags.trashed })}>{flags.trashed ? <Undo2 size={16} /> : <Trash2 size={16} />}</IconButton>
      </div>}
    </header>
    {!stateAddress && states.length > 1 && <p className="muted inbound-scope-note">This conversation reached several addresses. Filter by one address to star, archive or mark it read.</p>}
    {update.error && <Alert tone="danger">{update.error instanceof Error ? update.error.message : 'The conversation could not be updated.'}</Alert>}
    {olderCursor && <div className="inbound-older">{olderError ? <ErrorState error={olderError} onRetry={() => void loadOlder()} /> : <Button variant="ghost" size="sm" loading={loadingOlder} onClick={() => void loadOlder()}>Show earlier messages</Button>}</div>}
    <ol className="mailbox-messages">
      {messages.map(message => <MessageCard key={message.id} message={message} addressId={addressId} addresses={addresses} own={own} showAddresses={showAddresses}
        parent={message.inReplyTo ? byMessageId.get(message.inReplyTo) : undefined} expanded={isExpanded(message)} onToggle={() => toggle(message)}
        onReply={() => replyTo(message)} isTarget={target === message.id} />)}
    </ol>
    <Composer thread={thread} target={replyTarget} explicit={target !== null && replyTarget.id === target} onClearTarget={() => setTarget(null)} addressId={addressId} addresses={addresses} textarea={composer} />
  </section>
}

function RecipientList({ label: title, values, people }: { label: string; values: string[]; people: Map<string, MailAddress> }) {
  return <p className="mailbox-composer__to inbound-recipients"><span className="inbound-recipients__label">{title}</span><span>{values.map(value => full(people.get(value) ?? { name: null, address: value })).join(', ')}</span></p>
}

function Composer({ thread, target, explicit, onClearTarget, addressId, addresses, textarea }: { thread: InboundThreadDetail; target: InboundMessage; explicit: boolean; onClearTarget: () => void; addressId?: string; addresses: Addresses; textarea: RefObject<HTMLTextAreaElement | null> }) {
  const [text, setText] = useState('')
  const [replyAll, setReplyAll] = useState(false)
  const [chosen, setChosen] = useState('')
  const [automated, setAutomated] = useState<string | null>(null)
  const key = useRef({ key: '', body: '' })
  const send = useApiMutation((api, input: Omit<Parameters<typeof api.inbound.reply>[1], 'idempotencyKey'>) => api.inbound.reply(thread.id, { ...input, idempotencyKey: idempotencyFor(key.current, { threadId: thread.id, ...input }) }), 'Reply queued')
  useEffect(() => { setText(''); setReplyAll(false); send.reset(); key.current = { key: '', body: '' } }, [thread.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setChosen('') }, [target.id])
  // A message linked to several addresses needs an explicit sender; the API refuses to guess (ADDRESS_REQUIRED).
  const candidates = target.addressIds
  const fixed = addressId && candidates.includes(addressId) ? addressId : candidates.length === 1 ? candidates[0]! : null
  const sender = fixed ?? (candidates.includes(chosen) ? chosen : null)
  const missing = sender && !addresses.has(sender) ? sender : null
  const lookup = useApiQuery(['inbound-reply-address', missing], (api, signal) => missing ? api.inbound.address(missing, signal) : Promise.resolve(null))
  const senderAddress = (sender ? addresses.get(sender) : undefined) ?? lookup.data
  // The exact To/Cc the API will resolve for this sender; it rejects the send if they differ (expectedRecipients).
  const resolved = senderAddress ? replyRecipients(target, ownAddressesOf(senderAddress), replyAll) : null
  const withAll = senderAddress && !replyAll ? replyRecipients(target, ownAddressesOf(senderAddress), true) : resolved
  const extra = withAll ? withAll.to.length + withAll.cc.length - (resolved?.to.length ?? 0) - (resolved?.cc.length ?? 0) : 0
  const people = useMemo(() => new Map([target.from, ...target.replyTo, ...target.to, ...target.cc].map(person => [person.address.toLowerCase(), person])), [target])
  async function submit(event?: FormEvent, allowAutomated = false) {
    event?.preventDefault()
    if (!text.trim() || !sender || !resolved?.to.length || send.isPending) return
    try {
      await send.mutateAsync({ text: text.trim(), addressId: sender, replyToMessageId: target.id, replyAll, allowAutomated, expectedRecipients: resolved })
      setText(''); setReplyAll(false); onClearTarget(); key.current = { key: '', body: '' }
    } catch (error) { if (error instanceof ApiError && ['REPLY_TO_AUTOMATED', 'REPLY_TO_NO_REPLY'].includes(error.code)) { send.reset(); setAutomated(error.message.replace(/\s*\[[A-Z_]+\].*$/, '')) } }
  }
  const changed = send.error instanceof ApiError && send.error.code === 'INBOUND_RECIPIENTS_CHANGED'
  return <form className="mailbox-composer" data-filled={text ? true : undefined} onSubmit={submit}>
    <div className="inbound-composer__target">
      <label className="mailbox-composer__to" htmlFor="inbound-reply">{explicit ? `Replying to ${target.direction === 'outbound' ? 'your message' : `${nameOf(target.from)}’s message`} from ${when(target.receivedAt)}` : 'Replying to the newest message'}</label>
      {explicit && <IconButton variant="ghost" size="sm" label="Reply to the newest message instead" onClick={onClearTarget}><X size={14} /></IconButton>}
    </div>
    {!fixed && <Field label="Send as" htmlFor="inbound-reply-sender" hint="This message reached more than one of your addresses. Choose which one replies." error={fieldError(send.error, 'addressId')}>
      <Select id="inbound-reply-sender" value={sender ?? ''} onValueChange={setChosen} disabled={send.isPending} placeholder="Choose an address" options={candidates.map(id => ({ value: id, label: addressName(addresses, id) }))} />
    </Field>}
    <div className="inbound-recipients-review" aria-label="Reply recipients">
      {lookup.error && <ErrorState error={lookup.error} onRetry={() => void lookup.refetch()} />}
      {sender && !senderAddress ? <p className="mailbox-composer__to">The sending address could not be loaded, so its recipients can’t be reviewed.</p>
        : !senderAddress || !resolved ? <p className="mailbox-composer__to">Choose the sending address to review recipients.</p> : <>
          <RecipientList label="From" values={[senderOf(senderAddress).address.toLowerCase()]} people={new Map([[senderOf(senderAddress).address.toLowerCase(), senderOf(senderAddress)]])} />
          {resolved.to.length ? <RecipientList label="To" values={resolved.to} people={people} /> : <p className="mailbox-composer__to">This reply has no recipients outside your own addresses.</p>}
          {resolved.cc.length > 0 && <RecipientList label="Cc" values={resolved.cc} people={people} />}
        </>}
    </div>
    <Textarea ref={textarea} id="inbound-reply" rows={2} value={text} onChange={event => setText(event.target.value)} placeholder="Write a reply" disabled={send.isPending} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit() }} />
    {send.error && <Alert tone="danger">{changed ? 'The recipients changed since you reviewed them. Check To and Cc above, then send again.' : send.error instanceof Error ? send.error.message : 'The reply could not be sent.'}</Alert>}
    <div className="mailbox-composer__actions">
      {replyAll || extra > 0 ? <Checkbox label={replyAll ? 'Reply all' : `Reply all (+${extra})`} checked={replyAll} onCheckedChange={setReplyAll} disabled={send.isPending} /> : <span />}
      <Button variant="primary" type="submit" loading={send.isPending} disabled={!text.trim() || !resolved?.to.length}>Send reply</Button>
    </div>
    <ConfirmDialog open={!!automated} onOpenChange={open => { if (!open) setAutomated(null) }} title="Send to an automated sender?" description={`${automated ?? ''} Replying to automated mail can start a loop between systems.`} confirmLabel="Send anyway" onConfirm={() => submit(undefined, true)} />
  </form>
}

function NewThreadDialog({ open, onOpenChange, addresses, defaultAddress, onSent }: { open: boolean; onOpenChange: (open: boolean) => void; addresses: InboundAddress[]; defaultAddress?: string; onSent: (threadId: string) => void }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const key = useRef({ key: '', body: '' })
  const send = useApiMutation((api, input: Omit<Parameters<typeof api.inbound.startThread>[0], 'idempotencyKey'>) => api.inbound.startThread({ ...input, idempotencyKey: idempotencyFor(key.current, input) }), 'Message queued')
  useEffect(() => { if (open) { send.reset(); setErrors({}); setFrom(current => current || defaultAddress || (addresses.length === 1 ? addresses[0]!.id : '')) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const selected = addresses.find(address => address.id === from)
  const sender = selected ? senderOf(selected) : null
  async function submit(event: FormEvent) {
    event.preventDefault()
    const recipients = to.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean)
    const next: Record<string, string> = {}
    if (!from) next.addressId = 'Choose the address to send from.'
    if (!recipients.length) next.to = 'Add at least one recipient.'
    else if (recipients.some(value => !EMAIL.test(value))) next.to = 'Enter valid email addresses, separated by commas.'
    if (!subject.trim()) next.subject = 'Enter a subject.'
    if (!text.trim()) next.text = 'Write a message.'
    setErrors(next)
    if (Object.keys(next).length) return
    try {
      const message = await send.mutateAsync({ addressId: from, to: recipients, subject: subject.trim(), text: text.trim() })
      key.current = { key: '', body: '' }; setTo(''); setSubject(''); setText('')
      onOpenChange(false); onSent(message.threadId)
    } catch { /* Shown in the form. */ }
  }
  return <Dialog open={open} onOpenChange={next => { if (!send.isPending) onOpenChange(next) }} title="New message" footer={<><Button disabled={send.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="inbound-new-thread" loading={send.isPending}>Send</Button></>}>
    <form id="inbound-new-thread" className="stack" onSubmit={submit} noValidate>
      <MutationError error={send.error} />
      <Field label="Address" htmlFor="inbound-new-from" error={errors.addressId || fieldError(send.error, 'addressId')} hint={selected && sender && sender.address !== selected.address ? `Sends as ${full(sender)}.` : undefined}>
        <Select id="inbound-new-from" value={from} onValueChange={setFrom} disabled={send.isPending} placeholder="Choose an address" options={addresses.map(address => ({ value: address.id, label: address.displayName ? `${address.displayName} <${address.address}>` : address.address }))} />
      </Field>
      <Field label="To" htmlFor="inbound-new-to" error={errors.to || fieldError(send.error, 'to')} hint="Separate several recipients with commas."><Input id="inbound-new-to" value={to} onChange={event => setTo(event.target.value)} disabled={send.isPending} placeholder="name@example.com" autoComplete="off" /></Field>
      <Field label="Subject" htmlFor="inbound-new-subject" error={errors.subject || fieldError(send.error, 'subject')}><Input id="inbound-new-subject" value={subject} onChange={event => setSubject(event.target.value)} disabled={send.isPending} /></Field>
      <Field label="Message" htmlFor="inbound-new-text" error={errors.text || fieldError(send.error, 'text')}><Textarea id="inbound-new-text" rows={8} value={text} onChange={event => setText(event.target.value)} disabled={send.isPending} /></Field>
    </form>
  </Dialog>
}

export function InboundPage() {
  const [params, setParams] = useSearchParams()
  const addressId = params.get('address') || undefined
  const view = (views.some(item => item.value === params.get('view')) ? params.get('view') : 'inbox') as InboundThreadView
  const threadId = params.get('thread')
  const [search, setSearch] = useState('')
  const [composing, setComposing] = useState(false)
  const pagination = useCursorPagination()
  const addressList = useApiDef(queries.inboundAddressOptions())
  const missing = !!addressId && !!addressList.data && !addressList.data.some(address => address.id === addressId)
  const linked = useApiQuery(['inbound-address', addressId ?? null, missing], (api, signal) => addressId && missing ? api.inbound.address(addressId, signal) : Promise.resolve(null))
  const addresses = useMemo<Addresses>(() => new Map([...(addressList.data ?? []), ...(linked.data ? [linked.data] : [])].map(address => [address.id, address])), [addressList.data, linked.data])
  const q = search.trim()
  const threads = useApiDef(queries.inboundThreads(addressId, view, q, pagination.cursor), { interval: 30_000, keepPrevious: true })
  const thread = useApiQuery(['inbound-thread', threadId, addressId ?? null], (api, signal) => threadId ? api.inbound.thread(threadId, { addressId }, signal) : Promise.resolve(null))
  function change(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params)
    for (const [name, value] of Object.entries(changes)) { if (value === null) next.delete(name); else next.set(name, value) }
    setParams(next)
  }
  const filterAddress = (value: string) => { pagination.reset(); change({ address: value || null, thread: null, message: null }) }
  return <div className="mailbox-page" data-thread-open={threadId ? true : undefined}>
    <PageHeader title="Inbox" backTo="/receiving" actions={<Button variant="primary" disabled={!addresses.size} onClick={() => setComposing(true)}>New message</Button>} />
    <div className="mailbox-layout">
      <aside className="mailbox-list" aria-label="Conversations">
        <div className="inbound-filter"><Select aria-label="Filter by address" value={addressId ?? ''} onValueChange={filterAddress} disabled={addressList.isPending} placeholder="All addresses"
          options={[{ value: '', label: 'All addresses' }, ...[...addresses.values()].map(address => ({ value: address.id, label: address.address }))]} /></div>
        <Tabs label="Conversation views" value={view} onValueChange={value => { pagination.reset(); change({ view: value, thread: null, message: null }) }} items={views} />
        <div className="search-box mailbox-search"><Search size={16} /><Input type="search" aria-label="Search conversations" placeholder="Search mail" value={search} onChange={event => { setSearch(event.target.value); pagination.reset() }} /></div>
        {addressList.error && <Alert tone="warning">Addresses could not be loaded, so they show as IDs.</Alert>}
        {threads.error ? <ErrorState error={threads.error} onRetry={() => void threads.refetch()} /> : threads.isPending ? <div className="mailbox-thread-skeleton">{[0, 1, 2, 3].map(index => <div key={index}><SkeletonText width="60%" /><SkeletonText width="85%" /></div>)}</div>
          : threads.data.length ? <>
            <ul className="mailbox-threads">{threads.data.map(item => <ThreadRow key={item.id} thread={item} addresses={addresses} showAddresses={!addressId || item.addressIds.length > 1} selected={item.id === threadId} onSelect={() => change({ thread: item.id, message: null })} />)}</ul>
            {(pagination.page > 1 || threads.data.nextCursor) && <Pagination page={pagination.page} pageSize={50} nextCursor={threads.data.nextCursor} onPageChange={next => pagination.onPageChange(next, threads.data.nextCursor)} />}
          </> : <EmptyState title={q ? 'No matching conversations' : `Nothing in ${views.find(item => item.value === view)!.label.toLowerCase()}`} description={!q && !addresses.size && !addressList.isPending ? 'Create an address to start receiving mail.' : undefined} action={!q && !addresses.size && !addressList.isPending ? <Link to="/receiving">Create an address</Link> : undefined} />}
      </aside>
      <div className="mailbox-reader">
        {!threadId ? <EmptyState title="Select a conversation" />
          : thread.error ? <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />
          : thread.isPending || !thread.data ? <div className="mailbox-thread-skeleton"><SkeletonText width="50%" lineHeight={24} /><SkeletonText width="80%" /><SkeletonText width="70%" /></div>
          : <Conversation thread={thread.data} addressId={addressId} addresses={addresses} focusMessage={params.get('message')} onBack={() => change({ thread: null, message: null })} />}
      </div>
    </div>
    <NewThreadDialog open={composing} onOpenChange={setComposing} addresses={[...addresses.values()]} defaultAddress={addressId} onSent={id => change({ thread: id, message: null })} />
  </div>
}
