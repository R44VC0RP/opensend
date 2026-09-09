import { useEffect, useId, useRef, useState } from 'react'
import { Input } from '../../components/ui'
import './sender-input.css'

type Sender = { name: string; email: string }
export type CampaignSenderInputProps = Sender & {
  domains: string[]
  allowUnverified?: boolean
  disabled?: boolean
  onChange: (sender: Sender) => void
}

const formatSender = ({ name, email }: Sender) => email ? (name ? `${name} <${email}>` : email) : name
const validName = (name: string) => name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name)
// Match the API's practical ASCII address shape, not a general mailbox grammar.
const validEmail = (email: string) => email.length <= 254 && /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/.test(email)
const unquote = (name: string) => name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1).replace(/\\(["\\])/g, '$1') : name
const draftName = (text: string) => unquote((text.includes('<') ? text.slice(0, text.indexOf('<')) : text.includes('@') ? '' : text).trim())

function parseSender(text: string): Sender | null {
  if (/[\x00-\x1f\x7f]/.test(text)) return null
  const match = text.trim().match(/^(.*?)\s*<([^<>]+)>$/)
  const sender = match ? { name: unquote(match[1].trim()), email: match[2].trim() } : { name: '', email: text.trim() }
  return validName(sender.name) && validEmail(sender.email) ? sender : null
}

function suggestSenders(text: string, domains: string[]): Sender[] {
  if (/[\x00-\x1f\x7f]/.test(text)) return []
  const value = text.trim()
  const bracket = value.match(/^([^<>]*)<([^<>]*)>?$/)
  if (!bracket && /[<>]/.test(value)) return []
  const name = draftName(value)
  if (!validName(name)) return []
  const address = bracket ? bracket[2].trim() : value.includes('@') ? value : ''
  const [typedLocal, prefix = '', extra] = address.split('@')
  if (extra !== undefined) return []
  const local = typedLocal || name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 64).replace(/\.$/, '')
  if (!local) return []
  return domains.filter(domain => domain.startsWith(prefix.toLowerCase())).map(domain => ({ name, email: `${local}@${domain}` })).filter(sender => validEmail(sender.email))
}

export function CampaignSenderInput({ name, email, domains, allowUnverified = false, disabled = false, onChange }: CampaignSenderInputProps) {
  // The editor remounts for another campaign/region. Parent echoes must not replace
  // an unfinished draft (or move the caret) when its published email is empty.
  const [draft, setDraft] = useState(() => formatSender({ name, email }))
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [touched, setTouched] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const errorId = `${listId}-error`
  // Preserve only exact saved/accepted addresses, not arbitrary new addresses on
  // a saved domain that is absent from the current verified-domain page.
  const retained = useRef(new Set(!allowUnverified && validEmail(email) ? [email.toLowerCase()] : []))
  const verified = [...new Set(domains.map(domain => domain.trim().toLowerCase()))]
  const allowed = (sender: Sender) => allowUnverified || verified.includes(sender.email.split('@')[1].toLowerCase()) || retained.current.has(sender.email.toLowerCase())
  const parsed = parseSender(draft)
  const candidates = parsed ? (allowed(parsed) ? [parsed] : []) : suggestSenders(draft, verified)
  const expanded = open && !disabled && candidates.length > 0
  const activeIndex = expanded && active < candidates.length ? active : -1
  const error = !validName(draftName(draft)) ? 'Use a sender name of 200 characters or fewer, without control characters.'
    : parsed && !allowed(parsed) ? 'Choose an address on a verified domain.'
    : candidates.length ? 'Choose a sender address.' : 'Enter a full email address, with an optional sender name.'
  const showError = touched && (!parsed || !allowed(parsed))

  useEffect(() => {
    if (expanded && activeIndex >= 0) list.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [expanded, activeIndex])

  function publish(text: string) {
    const sender = parseSender(text)
    if (sender && allowed(sender)) {
      if (!allowUnverified) retained.current.add(sender.email.toLowerCase())
      onChange(sender)
    } else {
      onChange({ name: draftName(text).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200), email: '' })
    }
  }

  function choose(sender: Sender, focus = true) {
    if (disabled || !allowed(sender)) return
    if (focus) input.current?.focus()
    const text = formatSender(sender)
    setDraft(text)
    publish(text)
    setOpen(false)
    setActive(-1)
    setTouched(false)
  }

  return <div className="campaign-sender" onBlur={event => {
    if (event.currentTarget.contains(event.relatedTarget)) return
    setOpen(false)
    setActive(-1)
    setTouched(true)
    if (parsed && allowed(parsed)) choose(parsed, false)
  }}>
    <Input ref={input} id="campaign-from-email" role="combobox" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false}
      placeholder="Name <sender@example.com>" value={draft} maxLength={458} disabled={disabled} required
      aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      aria-invalid={showError || undefined} aria-describedby={showError ? errorId : undefined}
      onFocus={() => setOpen(true)}
      onChange={event => { setDraft(event.target.value); publish(event.target.value); setTouched(false); setOpen(true); setActive(-1) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!candidates.length) return
          event.preventDefault()
          setOpen(true)
          setActive(event.key === 'ArrowDown' ? (activeIndex + 1) % candidates.length : activeIndex <= 0 ? candidates.length - 1 : activeIndex - 1)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          if (activeIndex >= 0) choose(candidates[activeIndex])
          else if (parsed && allowed(parsed)) choose(parsed)
          else { setOpen(true); setTouched(true) }
        } else if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          setActive(-1)
        }
      }} />
    {expanded && <div ref={list} id={listId} role="listbox" aria-label="Sender addresses" className="campaign-sender-options">
      {candidates.map((sender, index) => <button key={sender.email} type="button" role="option" id={`${listId}-${index}`} tabIndex={-1}
        aria-selected={index === activeIndex} className="campaign-sender-option"
        onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(sender)}>
        {formatSender(sender)}
      </button>)}
    </div>}
    {showError && <div id={errorId} className="campaign-sender-error">{error}</div>}
  </div>
}
