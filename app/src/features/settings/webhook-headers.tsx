import { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff, Plus, X } from 'lucide-react'
import { Button, IconButton, Input } from '../../components/ui'
import { ApiError, type WebhookHeaderInput, type WebhookHeaderView } from '../../data/types'
import { MAX_WEBHOOK_HEADERS, webhookHeaderErrors } from '../../lib/webhook-headers'

export type HeaderRow = { key: string; name: string; value: string; shown?: boolean }
/** null keeps the endpoint's current headers (never sent); a list replaces them all when saved. */
export type HeaderDraft = HeaderRow[] | null

export const HEADERS_HINT = 'Sent with every delivery, such as Authorization. Values are hidden once saved.'
let nextKey = 0
const row = (name = ''): HeaderRow => ({ key: `header-${++nextKey}`, name, value: '' })
const clean = (rows: HeaderRow[]) => rows.map(({ name, value }) => ({ name: name.trim(), value: value.trim() }))

export const headerDraftErrors = (draft: HeaderDraft) => draft ? webhookHeaderErrors(clean(draft), true) : {}
/** The `headers` field for a create or update, or undefined to leave the endpoint's headers unchanged. */
export function headerPayload(draft: HeaderDraft, current: WebhookHeaderView[] = []): WebhookHeaderInput[] | undefined {
  if (!draft || (!draft.length && !current.length)) return undefined
  return clean(draft)
}
export const headersChanged = (draft: HeaderDraft, current: WebhookHeaderView[]) => headerPayload(draft, current) !== undefined

function serverError(error: unknown, field: string) {
  if (!(error instanceof ApiError)) return undefined
  return Object.entries(error.fields).find(([key]) => key.split(', ').includes(field))?.[1]
}
function listError(error: unknown) {
  if (!(error instanceof ApiError)) return undefined
  return Object.entries(error.fields).find(([key]) => key.split(', ').some(part => part === 'headers' || (part.startsWith('headers.') && !/^headers\.\d+\.(?:name|value)$/.test(part))))?.[1]
}

/** Header names and count for tables; values never leave the API. */
export function HeaderNames({ headers }: { headers: WebhookHeaderView[] }) {
  if (!headers.length) return <span className="muted">—</span>
  const names = headers.map(header => header.name)
  return <span className="webhook-header-names" title={names.join(', ')} aria-label={`${headers.length} ${headers.length === 1 ? 'header' : 'headers'}: ${names.join(', ')}`}>
    <span>{names[0]}</span>{names.length > 1 && <span className="muted">+{names.length - 1}</span>}
  </span>
}

export function WebhookHeadersField({ current, draft, onChange, errors, apiError, disabled }: { current: WebhookHeaderView[]; draft: HeaderDraft; onChange: (draft: HeaderDraft) => void; errors: Record<string, string>; apiError: unknown; disabled: boolean }) {
  const id = useId()
  const labelId = `${id}-label`, hintId = `${id}-hint`, errorId = `${id}-error`
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const replaceButton = useRef<HTMLButtonElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const [focus, setFocus] = useState<string | null>(null)
  useEffect(() => {
    if (!focus) return
    if (focus === 'replace') replaceButton.current?.focus()
    else if (focus === 'add') addButton.current?.focus()
    else inputs.current.get(focus)?.focus()
    setFocus(null)
  }, [focus])

  const replacing = draft !== null && current.length > 0
  const rows = draft ?? []
  const general = errors.headers || listError(apiError)
  const hint = !replacing ? HEADERS_HINT
    : rows.length ? 'Saving replaces every header. Enter each value again.' : 'Saving removes every header.'
  const update = (key: string, patch: Partial<HeaderRow>) => onChange(rows.map(item => item.key === key ? { ...item, ...patch } : item))
  function add() { const next = row(); onChange([...rows, next]); setFocus(`${next.key}:name`) }
  function remove(index: number) {
    const next = rows.filter((_, at) => at !== index)
    onChange(next)
    const target = next[index] ?? next[index - 1]
    setFocus(target ? `${target.key}:name` : 'add')
  }
  function replace() {
    const next = current.map(header => row(header.name))
    onChange(next)
    if (next[0]) setFocus(`${next[0].key}:value`)
  }

  return <div className="ui-field webhook-headers" role="group" aria-labelledby={labelId} aria-describedby={general ? `${hintId} ${errorId}` : hintId}>
    <div id={labelId} className="ui-field__label">Headers</div>
    <div id={hintId} className="ui-field__hint">{hint}</div>
    {draft === null && current.length > 0 && <ul className="webhook-headers__current" aria-label="Current headers">
      {current.map(header => <li key={header.name}><code>{header.name}</code><code className="muted" aria-hidden="true">{header.hint ?? '••••'}</code><span className="sr-only">{header.hint && header.hint.length > 4 ? `value ends in ${header.hint.slice(4)}` : 'value hidden'}</span></li>)}
    </ul>}
    {rows.length > 0 && <ul className="webhook-headers__rows">
      {rows.map((item, index) => {
        const n = index + 1
        const nameError = errors[`headers.${index}.name`] || serverError(apiError, `headers.${index}.name`)
        const valueError = errors[`headers.${index}.value`] || serverError(apiError, `headers.${index}.value`)
        const rowError = nameError || valueError
        const rowErrorId = `${id}-${item.key}-error`
        return <li key={item.key} className="webhook-header-row">
          <Input ref={node => { if (node) inputs.current.set(`${item.key}:name`, node); else inputs.current.delete(`${item.key}:name`) }} className="webhook-header-row__name" aria-label={`Header ${n} name`} value={item.name} placeholder="Authorization" disabled={disabled}
            autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? rowErrorId : undefined}
            onChange={event => update(item.key, { name: event.target.value })} />
          <div className="webhook-header-row__value">
            <Input ref={node => { if (node) inputs.current.set(`${item.key}:value`, node); else inputs.current.delete(`${item.key}:value`) }} type={item.shown ? 'text' : 'password'} aria-label={`Header ${n} value`} value={item.value} placeholder={replacing && current.some(header => header.name === item.name) ? 'New value' : 'Value'} disabled={disabled}
              autoComplete="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="" data-lpignore="true" data-bwignore="" aria-invalid={valueError ? true : undefined} aria-describedby={valueError ? rowErrorId : undefined}
              onChange={event => update(item.key, { value: event.target.value })} />
            <IconButton size="sm" label={`${item.shown ? 'Hide' : 'Show'} header ${n} value`} aria-pressed={Boolean(item.shown)} disabled={disabled} onClick={() => update(item.key, { shown: !item.shown })}>{item.shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}</IconButton>
          </div>
          <IconButton size="sm" label={`Remove header ${n}`} disabled={disabled} onClick={() => remove(index)}><X size={14} aria-hidden="true" /></IconButton>
          {rowError && <div id={rowErrorId} className="ui-field__hint ui-field__error webhook-header-row__error" role="alert">{nameError && valueError ? `${nameError} ${valueError}` : rowError}</div>}
        </li>
      })}
    </ul>}
    <div className="cluster webhook-headers__actions">
      {draft === null && current.length > 0
        ? <Button ref={replaceButton} variant="ghost" size="sm" disabled={disabled} onClick={replace}>Replace headers</Button>
        : <>
          {rows.length < MAX_WEBHOOK_HEADERS && <Button ref={addButton} variant="ghost" size="sm" disabled={disabled} onClick={add}><Plus size={14} aria-hidden="true" />Add header</Button>}
          {replacing && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { onChange(null); setFocus('replace') }}>Keep current headers</Button>}
        </>}
    </div>
    {general && <div id={errorId} className="ui-field__hint ui-field__error" role="alert">{general}</div>}
  </div>
}
