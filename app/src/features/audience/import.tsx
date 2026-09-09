import { useState } from 'react'
import { useApi, useApiMutation } from '../../data/context'
import type { ImportPreview } from '../../data/types'
import { Alert, Button, DataTable, Dialog, Field, Input, Select } from '../../components/ui'
import { MutationError, useAudienceLists } from './shared'
import { parseCsv } from './csv'

const targets = [{value: 'email', label: 'Email (required)'}, {value: 'name', label: 'Full name'}, {value: 'country', label: 'Country'}, {value: 'firstName', label: 'First name'}, {value: 'plan', label: 'Plan'}]
export function ImportContactsDialog({listId: initialListId = '', onClose}: {listId?: string; onClose: () => void}) {
  const api = useApi()
  const [listSearch, setListSearch] = useState('')
  const [listCursor, setListCursor] = useState<string | undefined>()
  const lists = useAudienceLists(listSearch, listCursor)
  const [listId, setListId] = useState(initialListId)
  const [csv, setCsv] = useState(''), [headers, setHeaders] = useState<string[]>([]), [filename, setFilename] = useState('')
  const [mapping, setMapping] = useState<Record<string, string>>({}), [error, setError] = useState<unknown>(null), [reading, setReading] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const mutation = useApiMutation(async (_api, action: 'preview' | 'commit') => {
    const selected = Object.fromEntries(Object.entries(mapping).filter(([, value]) => value !== ''))
    if (api.imports) return action === 'preview' ? api.imports.preview({csv, mapping: selected, ...(listId ? {listId} : {})}) : api.imports.commit(preview!.id)
    const rows = parseCsv(csv).slice(1).map((row, index) => ({row: index + 2, email: row[headers.indexOf(mapping.email)] ?? '', name: row[headers.indexOf(mapping.name)] ?? '', country: row[headers.indexOf(mapping.country)] ?? ''}))
    if (action === 'preview') return {id: 'demo-import', status: 'preview', imported: 0, rows, errors: []} satisfies ImportPreview
    const result = await api.contacts.import({listId, rows: rows.map(row => ({...row, subscribed: false}))})
    return {...preview!, status: 'committed', imported: result.created + result.matched, errors: result.issues.map(issue => ({...issue, field: 'email'}))} satisfies ImportPreview
  })
  function resetPreview() {setPreview(null); setError(null); mutation.reset()}
  async function readFile(file?: File) {
    if (!file) return
    resetPreview(); setCsv(''); setHeaders([]); setReading(true)
    try {
      if (file.size > 1024 * 1024) throw new Error('Choose a CSV no larger than 1 MiB.')
      const raw = await file.text(), rows = parseCsv(raw)
      if (rows.length < 2 || rows.length > 1001) throw new Error('Import 1–1,000 contact rows at a time.')
      if (new Set(rows[0]).size !== rows[0].length) throw new Error('Use unique column headings.')
      setCsv(raw); setHeaders(rows[0]); setFilename(file.name)
      const defaults: Record<string, string> = {}
      for (const target of targets) defaults[target.value] = rows[0].find(h => h.toLowerCase().replace(/[ _-]/g, '') === target.value.toLowerCase()) ?? ''
      setMapping(defaults)
    } catch (cause) {setError(cause)} finally {setReading(false)}
  }
  async function submit(action: 'preview' | 'commit') {setError(null); try {setPreview(await mutation.mutateAsync(action))} catch { /* inline */ }}
  const busy = reading || mutation.isPending
  const committed = preview?.status === 'committed'
  return <Dialog open onOpenChange={open => {if (!open && !busy) onClose()}} title={committed ? 'Import complete' : 'Import contacts'} footer={committed ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!csv || !mapping.email} onClick={() => submit(preview ? 'commit' : 'preview')}>{preview ? 'Commit reviewed import' : 'Preview import'}</Button></>}><div className="stack"><MutationError error={error || mutation.error} />{committed ? <Alert tone="success">{preview.imported} contacts imported.</Alert> : <><Field label="Find destination list" htmlFor="import-list-search"><Input id="import-list-search" type="search" disabled={busy || !!preview} value={listSearch} onChange={event => {setListSearch(event.target.value); setListCursor(undefined)}} /></Field><Field label="Destination list" htmlFor="import-list"><Select id="import-list" disabled={busy || !!preview} value={listId} onValueChange={value => {setListId(value); resetPreview()}} options={[{value: '', label: 'No list'}, ...(listId && !(lists.data ?? []).some(list => list.id === listId) ? [{value: listId, label: listId}] : []), ...(lists.data ?? []).map(list => ({value: list.id, label: `${list.name} · ${list.id}`}))]} /></Field>{(listCursor || lists.data?.nextCursor) && <div className="cluster"><Button disabled={busy || !!preview || lists.isFetching || !listCursor} onClick={() => setListCursor(undefined)}>First matching lists</Button><Button disabled={busy || !!preview || lists.isFetching || !lists.data?.nextCursor} onClick={() => setListCursor(lists.data?.nextCursor ?? undefined)}>Next matching lists</Button></div>}<Field label="CSV file (1 MiB, 1,000 rows maximum)" htmlFor="import-file"><Input type="file" id="import-file" accept=".csv,text/csv" disabled={busy || !!preview} onChange={event => readFile(event.target.files?.[0])} /></Field>{csv && <><p className="muted">{filename}</p><div className="form-grid">{targets.map(target => <Field key={target.value} label={target.label} htmlFor={`map-${target.value}`}><Select id={`map-${target.value}`} disabled={busy || !!preview} value={mapping[target.value] ?? ''} onValueChange={value => {setMapping({...mapping, [target.value]: value}); resetPreview()}} options={[{value: '', label: 'Do not import'}, ...headers.map(header => ({value: header, label: header}))]} /></Field>)}</div></>}<Alert tone="info">Imports do not grant marketing consent. Existing consent and suppressions are preserved.</Alert></>}{preview && <><DataTable rows={preview.rows.slice(0, 10)} rowKey={row => String(row.row)} columns={[{key: 'row', label: 'CSV row', render: row => row.row}, {key: 'email', label: 'Email', render: row => row.email}, {key: 'name', label: 'Name', render: row => row.name || '—'}]} /><span className="muted">{preview.rows.length} valid rows · First 10 shown</span>{preview.errors.length > 0 && <Alert tone="warning">{preview.errors.length} rows rejected{preview.errors.slice(0, 10).map((issue, i) => <div key={i}>Row {issue.row}: {issue.message}</div>)}</Alert>}{!committed && <Button disabled={busy} onClick={resetPreview}>Change mapping</Button>}</>}</div></Dialog>
}
