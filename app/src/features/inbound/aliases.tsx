import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'

// The API's rules for aliases (UpdateInboundAddress): valid lowercase addresses of at most 254 characters,
// on exactly the address's own domain, at most 50 per address, and none on temporary addresses.
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
export const MAX_ALIASES = 50

export type AliasMessage = { tone: 'error' | 'info'; text: string }
export type AliasState = { list: string[]; draft: string; message: AliasMessage | null }
type Rules = { address: string; temporary: boolean }
type Reason = 'format' | 'domain' | 'length' | 'primary' | 'duplicate' | 'limit'

export const aliasState = (list: string[]): AliasState => ({ list, draft: '', message: null })
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1)
const reasons = (domain: string, address: string): Record<Reason, string> => ({
  format: `Enter a valid address, such as help@${domain}.`,
  domain: `Aliases must end in @${domain}.`,
  length: 'Addresses can be at most 254 characters.',
  primary: `${address} is this address itself.`,
  duplicate: 'Already an alias.',
  limit: `An address can have at most ${MAX_ALIASES} aliases.`,
})

/** Adds every address in the draft (separated by spaces, commas, semicolons or new lines); anything invalid stays in the draft. */
export function commitAliases(state: AliasState, { address, temporary }: Rules): AliasState & { ok: boolean; added: string[] } {
  const domain = domainOf(address)
  const tokens = state.draft.split(/[\s,;]+/).map(token => token.trim().toLowerCase().replace(/^<|>$/g, '')).filter(Boolean)
  if (!tokens.length) return { ...state, draft: '', ok: true, added: [] }
  const list = [...state.list], rest: string[] = []
  let reason: Reason | null = null, duplicates = 0
  for (const token of tokens) {
    const value = token.includes('@') ? token : `${token}@${domain}`
    const problem: Reason | null = temporary || list.length >= MAX_ALIASES ? 'limit'
      : value.length > 254 ? 'length'
      : domainOf(value) !== domain ? 'domain'
      : !ADDRESS.test(value) ? 'format'
      : value === address ? 'primary'
      : list.includes(value) ? 'duplicate' : null
    if (problem === 'duplicate') { duplicates++; continue }
    if (problem) { reason ??= problem; rest.push(token); continue }
    list.push(value)
  }
  const added = list.slice(state.list.length)
  const text = reasons(domain, address)
  // Repeats are dropped quietly in a pasted list; a single repeat is worth saying.
  const message: AliasMessage | null = reason ? { tone: 'error', text: `${added.length ? `Added ${added.length}. ` : ''}${text[reason]}` }
    : !added.length && duplicates ? { tone: 'error', text: duplicates > 1 ? 'Already aliases.' : text.duplicate }
    : added.length > 1 ? { tone: 'info', text: `Added ${added.length} aliases.` } : null
  return { list, draft: rest.join(', '), message, ok: !reason, added }
}

export function AliasEditor({ id, address, temporary, saved, value, onChange, disabled, error }: Rules & { id: string; saved: string[]; value: AliasState; onChange: (next: AliasState) => void; disabled?: boolean; error?: string }) {
  const domain = domainOf(address)
  const input = useRef<HTMLInputElement>(null)
  const removers = useRef(new Map<string, HTMLButtonElement>())
  const [focusAfterRemove, setFocusAfterRemove] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const labelId = useId(), suffixId = useId(), messageId = useId()
  const full = value.list.length >= MAX_ALIASES
  const locked = disabled || temporary || full
  useEffect(() => {
    if (focusAfterRemove === null) return
    ;(removers.current.get(focusAfterRemove) ?? input.current)?.focus()
    setFocusAfterRemove(null)
  }, [focusAfterRemove])
  function add(draft = value.draft) {
    const next = commitAliases({ ...value, draft }, { address, temporary })
    onChange({ list: next.list, draft: next.draft, message: next.message })
    if (next.added.length) setAnnouncement(next.added.length === 1 ? `Added ${next.added[0]}` : `Added ${next.added.length} aliases`)
    if (next.list.length >= MAX_ALIASES && !next.draft) requestAnimationFrame(() => removers.current.get(next.list.at(-1)!)?.focus())
  }
  function remove(alias: string) {
    const index = value.list.indexOf(alias)
    const list = value.list.filter(item => item !== alias)
    onChange({ ...value, list, message: null })
    setAnnouncement(`Removed ${alias}`)
    setFocusAfterRemove(list[index] ?? list[index - 1] ?? '')
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || (event.key === ',' && value.draft.trim())) { event.preventDefault(); if (value.draft.trim()) add() }
  }
  function paste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text')
    if (!/[\s,;]/.test(text.trim())) return
    event.preventDefault()
    const target = event.currentTarget
    add(value.draft.slice(0, target.selectionStart ?? value.draft.length) + ' ' + text + ' ' + value.draft.slice(target.selectionEnd ?? value.draft.length))
  }
  const shown = value.message ?? (error ? { tone: 'error' as const, text: error } : null)
  const hint = temporary ? 'Temporary addresses cannot have aliases.'
    : full ? `This address has the maximum of ${MAX_ALIASES} aliases.`
    : 'Other addresses that deliver here. Paste several to add them at once.'
  const typedDomain = value.draft.includes('@')
  return <div className="ui-field alias-editor">
    <label className="ui-field__label" id={labelId} htmlFor={id}>Aliases</label>
    {value.list.length > 0 && <ul className="alias-list" aria-labelledby={labelId}>
      {value.list.map(alias => <li key={alias} data-unsaved={!saved.includes(alias) || undefined}>
        <code>{alias.slice(0, alias.lastIndexOf('@'))}<wbr />{alias.slice(alias.lastIndexOf('@'))}</code>
        {!saved.includes(alias) && <span className="alias-list__note">Not saved</span>}
        <IconButton ref={node => { if (node) removers.current.set(alias, node); else removers.current.delete(alias) }} size="sm" label={`Remove ${alias}`} disabled={disabled} onClick={() => remove(alias)}><X size={14} aria-hidden="true" /></IconButton>
      </li>)}
    </ul>}
    <div className="alias-add">
      <div className="ui-input alias-input" data-invalid={shown?.tone === 'error' || undefined} data-disabled={locked || undefined} onClick={() => input.current?.focus()}>
        {/* The local part grows with its text so the fixed domain reads as the rest of the address. */}
        <span className="alias-input__sizer" data-value={value.draft || (locked ? '' : 'name')}>
          <input ref={input} id={id} className="alias-input__field" size={1} value={value.draft} disabled={locked} placeholder={locked ? undefined : 'name'} autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="done"
            aria-invalid={shown?.tone === 'error' || undefined} aria-describedby={`${typedDomain ? '' : `${suffixId} `}${messageId}`}
            onChange={event => onChange({ ...value, draft: event.target.value, message: null })} onKeyDown={keyDown} onPaste={paste} />
        </span>
        {!typedDomain && <span className="alias-input__suffix" id={suffixId} title={`@${domain}`}>@{domain}</span>}
      </div>
      <Button disabled={locked || !value.draft.trim()} onClick={() => { add(); input.current?.focus() }}>Add</Button>
    </div>
    {/* The hint keeps its space while a message shows over it, so messages up to its length never move the page. */}
    <div className="alias-message">
      <div id={messageId} className={`ui-field__hint${shown?.tone === 'error' ? ' ui-field__error' : ''}`} role={shown?.tone === 'error' ? 'alert' : undefined}>{shown?.text ?? hint}</div>
      {shown && <div className="ui-field__hint" aria-hidden="true">{hint}</div>}
    </div>
    <span className="sr-only" role="status">{announcement}</span>
  </div>
}
