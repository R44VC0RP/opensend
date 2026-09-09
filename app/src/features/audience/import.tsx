import { useMemo, useState } from 'react'
import { useApiMutation } from '../../data/context'
import type { ImportResult, ImportRow } from '../../data/types'
import { Alert, Button, Checkbox, ControlSkeleton, DataTable, Dialog, ErrorState, Field, Input, LoadingRegion, Select } from '../../components/ui'
import { MutationError, useAudienceLists } from './shared'
import { parseCsv } from './csv'

const targets = [{ value: 'email', label: 'Email (required)' }, { value: 'name', label: 'Full name' }, { value: 'country', label: 'Country' }, { value: 'consent', label: 'Marketing consent' }] as const
export function ImportContactsDialog({ listId: initialListId = '', onClose }: { listId?: string; onClose: () => void }) {
  const [listId, setListId] = useState(initialListId)
  const [csv, setCsv] = useState<string[][]>([])
  const [filename, setFilename] = useState('')
  const [mapping, setMapping] = useState<Record<string, string>>({ email: '', name: '', country: '', consent: '' })
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [reading, setReading] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const lists = useAudienceLists()
  const mutation = useApiMutation((api, input: { listId: string; rows: ImportRow[] }) => api.contacts.import(input), 'Contacts imported')
  const rows = useMemo(() => csv.slice(1).map(row => {
    const value = (field: string) => mapping[field] === '' ? '' : (row[Number(mapping[field])] || '').trim()
    return { email: value('email'), name: value('name'), country: value('country'), subscribed: consent && (mapping.consent === '' || ['true', 'yes', '1', 'subscribed', 'opted_in'].includes(value('consent').toLowerCase())) }
  }), [csv, mapping, consent])
  const invalid = useMemo(() => {
    const seen = new Set<string>()
    return rows.map((row, index) => {
      const address = row.email.toLowerCase()
      const message = !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) || address.length > 254 ? 'Invalid or missing email' : (row.name?.length || 0) > 200 ? 'Name exceeds 200 characters' : row.country && !/^[a-z]{2}$/i.test(row.country) ? 'Country must be a two-letter code' : seen.has(address) ? 'Duplicate email in this import' : ''
      if (!message) seen.add(address)
      return { row: index + 2, message }
    }).filter(issue => issue.message)
  }, [rows])
  async function readFile(file: File | undefined) {
    if (!file) return
    setError(null); setCsv([]); setResult(null); setConsent(false); mutation.reset(); setReading(true)
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Choose a CSV smaller than 10 MB.')
      const parsed = parseCsv(await file.text())
      if (parsed.length > 10001) throw new Error('Import at most 10,000 contact rows at a time.')
      setCsv(parsed); setFilename(file.name)
      const headers = parsed[0].map(header => header.trim().toLowerCase().replace(/[\s_-]/g, ''))
      const find = (names: string[]) => { const index = headers.findIndex(header => names.includes(header)); return index < 0 ? '' : String(index) }
      setMapping({ email: find(['email', 'emailaddress']), name: find(['name', 'fullname']), country: find(['country']), consent: find(['consent', 'subscribed', 'marketingconsent', 'optin']) })
    } catch (caught) { setError(caught) } finally { setReading(false) }
  }
  async function submit() {
    try { setResult(await mutation.mutateAsync({ listId, rows })) } catch { /* Shown inline. */ }
  }
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending && !reading) onClose() }} title={result ? 'Import complete' : 'Import contacts'} footer={result ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button disabled={mutation.isPending || reading} onClick={onClose}>Cancel</Button><Button variant="primary" loading={mutation.isPending} disabled={!listId || !csv.length || mapping.email === '' || invalid.length === rows.length || reading} onClick={() => void submit()}>Import {rows.length ? `${rows.length} contacts` : 'contacts'}</Button></>}>
    <div className="stack"><MutationError error={error || mutation.error} />
      {result ? <><Alert tone="success">{result.created} created · {result.matched} existing contacts matched · {result.skipped} skipped</Alert>{result.issues.length > 0 && <DataTable rows={result.issues} rowKey={row => String(row.row)} columns={[{ key: 'row', label: 'Data row', render: row => row.row }, { key: 'issue', label: 'Issue', render: row => row.message }]} />}</> : <>
        {!initialListId && <Field label="Destination list" htmlFor="import-list">{lists.isPending ? <LoadingRegion label="Loading destination lists"><ControlSkeleton /></LoadingRegion> : lists.isError ? <ErrorState error={lists.error} onRetry={() => lists.refetch()} /> : <Select id="import-list" value={listId} onValueChange={setListId} options={[{ value: '', label: 'Choose a list' }, ...lists.data.map(list => ({ value: list.id, label: list.name }))]} />}{lists.data?.length === 0 && <span className="muted">Create a list before importing contacts.</span>}</Field>}
        <Field label="CSV file" htmlFor="import-file"><Input id="import-file" type="file" accept=".csv,text/csv" disabled={mutation.isPending || reading} onChange={event => void readFile(event.target.files?.[0])} /></Field>
        {reading && <p className="muted" role="status">Reading CSV file…</p>}
        {csv.length > 0 && <><p className="muted">{filename} · {rows.length} contact rows</p><div className="form-grid">{targets.map(target => <Field key={target.value} label={target.label} htmlFor={`map-${target.value}`}><Select id={`map-${target.value}`} value={mapping[target.value]} onValueChange={value => { setMapping({ ...mapping, [target.value]: value }); setConsent(false) }} options={[{ value: '', label: target.value === 'email' ? 'Choose email column' : 'Do not import' }, ...csv[0].map((header, index) => ({ value: String(index), label: header || `Column ${index + 1}` }))]} /></Field>)}</div>
          {mapping.email !== '' && <><DataTable rows={rows.slice(0, 5).map((row, index) => ({ ...row, index }))} rowKey={row => String(row.index)} columns={[{ key: 'email', label: 'Email preview', render: row => row.email || 'Missing' }, { key: 'name', label: 'Name', render: row => row.name || '—' }, { key: 'status', label: 'New contact status', render: row => row.subscribed ? 'Subscribed' : 'Not subscribed' }]} />{invalid.length > 0 && <Alert tone="warning">{invalid.length} invalid rows will be skipped.{invalid.slice(0, 5).map(issue => <div key={issue.row}>CSV row {issue.row}: {issue.message}</div>)}</Alert>}</>}
          <Checkbox checked={consent} onCheckedChange={setConsent} label={mapping.consent !== '' ? 'Apply affirmative consent values from this column; I confirm they represent valid marketing opt-in.' : 'I confirm all new contacts in this file have given valid marketing opt-in.'} />
          <Alert tone="info">New contacts are not subscribed unless opt-in is explicitly confirmed. Existing subscription states and suppressions are always retained.</Alert>
        </>}
      </>}
    </div>
  </Dialog>
}
