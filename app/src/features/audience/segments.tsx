import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Plus, X } from 'lucide-react'
import { useApiMutation, useApiQuery } from '../../data/context'
import type { SegmentInput, SegmentRule } from '../../data/types'
import { Alert, Button, DataTable, ErrorState, Field, Input, LoadingState, PageHeader, Pagination, SectionHeader, Select } from '../../components/ui'
import { ContactTable, date, fieldError, MutationError, number, pageSize, statusOptions, useAudienceLists } from './shared'

export function SegmentsPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const navigate = useNavigate()
  const params = { search, page, pageSize }
  const query = useApiQuery(['segments', params], (api, signal) => api.segments.list(params, signal))
  return <div className="audience-page"><PageHeader title="Segments" actions={<Button variant="primary" onClick={() => navigate('/segments/new')}><Plus size={16} />Create segment</Button>} /><div className="data-toolbar"><Input className="audience-search" aria-label="Search segments" placeholder="Search segments" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><span className="muted">{query.data && `${number(query.data.total)} segments`}</span></div>
    {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable rows={query.data.items} rowKey={row => row.id} columns={[{ key: 'name', label: 'Name', width: '30%', render: row => <Link to={`/segments/${row.id}`}>{row.name}</Link> }, { key: 'rules', label: 'Rules', render: row => `${row.rules.length} · match ${row.match}` }, { key: 'matched', label: 'Matched', render: row => number(row.matched) }, { key: 'eligible', label: 'Eligible', render: row => number(row.eligible) }, { key: 'updated', label: 'Updated', render: row => date(row.updatedAt) }]} /><Pagination page={page} pageSize={pageSize} total={query.data.total} onPageChange={setPage} /></>}
  </div>
}
export function SegmentEditorPage() {
  const { id } = useParams()
  return id ? <ExistingSegment key={id} id={id} /> : <SegmentEditor key="new" initial={{ name: '', match: 'all', rules: [newRule()] }} />
}
function ExistingSegment({ id }: { id: string }) {
  const query = useApiQuery(['segments', id], (api, signal) => api.segments.get(id, signal))
  return query.isPending ? <LoadingState /> : query.isError ? <><PageHeader title="Segment" backTo="/segments" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></> : <SegmentEditor initial={{ id: query.data.id, name: query.data.name, match: query.data.match, rules: query.data.rules }} />
}
function newRule(): SegmentRule { return { id: crypto.randomUUID(), field: 'status', operator: 'is', value: 'subscribed' } }
const fields = [{ value: 'status', label: 'Subscription status' }, { value: 'country', label: 'Country' }, { value: 'listId', label: 'List membership' }, { value: 'lastOpenedAt', label: 'Last opened' }]
function SegmentEditor({ initial }: { initial: SegmentInput }) {
  const [input, setInput] = useState<SegmentInput>(initial)
  const [preview, setPreview] = useState<SegmentInput | null>(null)
  const navigate = useNavigate()
  const lists = useAudienceLists()
  const save = useApiMutation((api, value: SegmentInput) => api.segments.save(value), 'Segment saved')
  const change = (next: SegmentInput) => { setInput(next); setPreview(null) }
  const updateRule = (id: string, patch: Partial<SegmentRule>) => change({ ...input, rules: input.rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule) })
  const valid = input.rules.length > 0 && input.rules.every(rule => rule.value.trim() && (rule.field !== 'lastOpenedAt' || Number(rule.value) > 0))
  async function submit() {
    try { const segment = await save.mutateAsync(input); navigate(`/segments/${segment.id}`, { replace: true }) } catch { /* Shown inline. */ }
  }
  return <div className="audience-page"><PageHeader title={initial.id ? 'Edit segment' : 'Create segment'} backTo="/segments" actions={<><Button disabled={save.isPending} onClick={() => navigate('/segments')}>Cancel</Button><Button variant="primary" type="submit" form="segment-editor" loading={save.isPending}>Save segment</Button></>} />
    <form id="segment-editor" className="stack audience-editor" onSubmit={event => { event.preventDefault(); void submit() }}>
      <MutationError error={save.error} />
      <Field label="Segment name" htmlFor="segment-name" error={fieldError(save.error, 'name')}><Input id="segment-name" className="audience-name" required value={input.name} onChange={event => change({ ...input, name: event.target.value })} /></Field>
      <section className="section stack"><SectionHeader title="Conditions" /><div className="cluster"><span>Match</span><Select aria-label="Match conditions" value={input.match} onValueChange={value => change({ ...input, match: value as 'all' | 'any' })} options={[{ value: 'all', label: 'All conditions (AND)' }, { value: 'any', label: 'Any condition (OR)' }]} /></div>
        {lists.isError && <ErrorState error={lists.error} onRetry={() => lists.refetch()} />}
        {input.rules.map((rule, index) => <div className="audience-rule" key={rule.id}>
          <Field label="Property" htmlFor={`rule-field-${rule.id}`}><Select id={`rule-field-${rule.id}`} value={rule.field} onValueChange={value => updateRule(rule.id, { field: value as SegmentRule['field'], operator: value === 'lastOpenedAt' ? 'within_days' : 'is', value: value === 'status' ? 'subscribed' : value === 'lastOpenedAt' ? '30' : '' })} options={fields} /></Field>
          <Field label="Operator" htmlFor={`rule-operator-${rule.id}`}><Select id={`rule-operator-${rule.id}`} value={rule.operator} onValueChange={value => updateRule(rule.id, { operator: value as SegmentRule['operator'] })} options={rule.field === 'lastOpenedAt' ? [{ value: 'within_days', label: 'Within the last' }] : [{ value: 'is', label: 'Is' }, { value: 'is_not', label: 'Is not' }]} /></Field>
          <Field label={rule.field === 'lastOpenedAt' ? 'Days' : 'Value'} htmlFor={`rule-value-${rule.id}`} hint={rule.field === 'country' ? 'Two-letter code, e.g. US.' : undefined} error={fieldError(save.error, `rules.${index}.value`) || fieldError(save.error, `rules.${index}`)}>{rule.field === 'status' ? <Select id={`rule-value-${rule.id}`} value={rule.value} onValueChange={value => updateRule(rule.id, { value })} options={statusOptions} /> : rule.field === 'listId' ? <Select id={`rule-value-${rule.id}`} value={rule.value} onValueChange={value => updateRule(rule.id, { value })} options={[{ value: '', label: lists.isPending ? 'Loading lists…' : 'Choose a list' }, ...(lists.data || []).map(list => ({ value: list.id, label: list.name }))]} /> : <Input id={`rule-value-${rule.id}`} required type={rule.field === 'lastOpenedAt' ? 'number' : 'text'} min={rule.field === 'lastOpenedAt' ? 1 : undefined} max={rule.field === 'lastOpenedAt' ? 3650 : undefined} maxLength={rule.field === 'country' ? 2 : undefined} step={rule.field === 'lastOpenedAt' ? 1 : undefined} placeholder={rule.field === 'country' ? 'Country' : undefined} value={rule.value} onChange={event => updateRule(rule.id, { value: event.target.value })} />}</Field>
          <Button aria-label={`Remove condition ${index + 1}`} className="audience-rule-remove" variant="ghost" onClick={() => change({ ...input, rules: input.rules.filter(item => item.id !== rule.id) })}><X size={16} /></Button>
        </div>)}
        <div className="cluster"><Button onClick={() => change({ ...input, rules: [...input.rules, newRule()] })}><Plus size={16} />Add condition</Button><Button disabled={!valid} onClick={() => setPreview({ ...input, name: input.name || 'Audience preview' })}>Preview audience</Button></div>
        {input.rules.length === 0 && <Alert tone="info">Add a condition to define this segment.</Alert>}
      </section>
    </form>
    {preview && <SegmentPreview input={preview} />}
  </div>
}
function SegmentPreview({ input }: { input: SegmentInput }) {
  const query = useApiQuery(['segments', 'preview', input], (api, signal) => api.segments.preview(input, signal))
  return <section className="section"><SectionHeader title="Audience preview" />{query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><div className="audience-summary cluster"><span>{number(query.data.matched)} matched</span><span>{number(query.data.eligible)} eligible</span><span className="muted">{number(query.data.suppressed)} suppressed</span><span className="muted">{number(query.data.unsubscribed)} unsubscribed</span></div><ContactTable contacts={query.data.contacts} members /></>}</section>
}
