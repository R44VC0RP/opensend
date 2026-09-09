import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Plus, X } from 'lucide-react'
import { useApiMutation, useApiQuery, useApi } from '../../data/context'
import type { SegmentInput, SegmentRule } from '../../data/types'
import { Alert, Button, ControlSkeleton, DataTable, ErrorState, Field, Input, LoadingRegion, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select, SkeletonText } from '../../components/ui'
import { AudienceRouteSkeleton, AudienceSummarySkeleton, segmentColumns } from './skeletons'
import { ContactTable, date, fieldError, MutationError, number, pageSize, statusOptions, useAudienceLists } from './shared'

function DemoSegmentsPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const navigate = useNavigate()
  const params = { search, page, pageSize }
  const query = useApiQuery(['segments', params], (api, signal) => api.segments.list(params, signal))
  return <div className="audience-page"><PageHeader title="Segments" actions={<Button variant="primary" onClick={() => navigate('/segments/new')}><Plus size={16} />Create segment</Button>} /><div className="data-toolbar"><Input className="audience-search" aria-label="Search segments" placeholder="Search segments" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><span className="muted audience-count">{query.isPending ? <SkeletonText width={100} /> : query.data?.total !== undefined && `${number(query.data.total)} segments`}</span></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable rows={query.data?.items || []} loading={query.isPending} skeletonRows={5} minRows={5} rowKey={row => row.id} columns={[{ ...segmentColumns[0], render: row => <Link className="audience-cell-text" title={row.name} to={`/segments/${row.id}`}>{row.name}</Link> }, { ...segmentColumns[1], render: row => `${row.rules.length} · match ${row.match}` }, { ...segmentColumns[2], render: row => number(row.matched) }, { ...segmentColumns[3], render: row => number(row.eligible) }, { ...segmentColumns[4], render: row => date(row.updatedAt) }]} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}
  </div>
}
function DemoSegmentEditorPage() {
  const { id } = useParams()
  return id ? <ExistingSegment key={id} id={id} /> : <SegmentEditor key="new" initial={{ name: '', match: 'all', rules: [newRule()] }} />
}
function ExistingSegment({ id }: { id: string }) {
  const query = useApiQuery(['segments', id], (api, signal) => api.segments.get(id, signal))
  return query.isPending ? <AudienceRouteSkeleton kind="segment" /> : query.isError ? <><PageHeader title="Segment" backTo="/segments" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></> : <SegmentEditor initial={{ id: query.data.id, name: query.data.name, match: query.data.match, rules: query.data.rules }} />
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
      <section className="section stack"><SectionHeader title="Conditions" /><div className="cluster"><span>Match</span><Select className="audience-match" aria-label="Match conditions" value={input.match} onValueChange={value => change({ ...input, match: value as 'all' | 'any' })} options={[{ value: 'all', label: 'All conditions (AND)' }, { value: 'any', label: 'Any condition (OR)' }]} /></div>
        {lists.isError && <ErrorState error={lists.error} onRetry={() => lists.refetch()} />}
        {input.rules.map((rule, index) => <div className="audience-rule" key={rule.id}>
          <Field label="Property" htmlFor={`rule-field-${rule.id}`}><Select id={`rule-field-${rule.id}`} value={rule.field} onValueChange={value => updateRule(rule.id, { field: value as SegmentRule['field'], operator: value === 'lastOpenedAt' ? 'within_days' : 'is', value: value === 'status' ? 'subscribed' : value === 'lastOpenedAt' ? '30' : '' })} options={fields} /></Field>
          <Field label="Operator" htmlFor={`rule-operator-${rule.id}`}><Select id={`rule-operator-${rule.id}`} value={rule.operator} onValueChange={value => updateRule(rule.id, { operator: value as SegmentRule['operator'] })} options={rule.field === 'lastOpenedAt' ? [{ value: 'within_days', label: 'Within the last' }] : [{ value: 'is', label: 'Is' }, { value: 'is_not', label: 'Is not' }]} /></Field>
          <Field label={rule.field === 'lastOpenedAt' ? 'Days' : 'Value'} htmlFor={`rule-value-${rule.id}`} hint={rule.field === 'country' ? 'Two-letter code, e.g. US.' : undefined} error={fieldError(save.error, `rules.${index}.value`) || fieldError(save.error, `rules.${index}`)}>{rule.field === 'status' ? <Select id={`rule-value-${rule.id}`} value={rule.value} onValueChange={value => updateRule(rule.id, { value })} options={statusOptions} /> : rule.field === 'listId' ? lists.isPending ? <LoadingRegion label="Loading list options"><ControlSkeleton /></LoadingRegion> : <Select id={`rule-value-${rule.id}`} value={rule.value} onValueChange={value => updateRule(rule.id, { value })} options={[{ value: '', label: 'Choose a list' }, ...(lists.data || []).map(list => ({ value: list.id, label: list.name }))]} /> : <Input id={`rule-value-${rule.id}`} required type={rule.field === 'lastOpenedAt' ? 'number' : 'text'} min={rule.field === 'lastOpenedAt' ? 1 : undefined} max={rule.field === 'lastOpenedAt' ? 3650 : undefined} maxLength={rule.field === 'country' ? 2 : undefined} step={rule.field === 'lastOpenedAt' ? 1 : undefined} placeholder={rule.field === 'country' ? 'Country' : undefined} value={rule.value} onChange={event => updateRule(rule.id, { value: event.target.value })} />}</Field>
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
  return <section className="section"><SectionHeader title="Audience preview" />{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>{query.isPending ? <LoadingRegion label="Loading audience counts"><AudienceSummarySkeleton /></LoadingRegion> : <div className="audience-summary cluster"><span>{number(query.data.matched)} matched</span><span>{number(query.data.eligible)} eligible</span><span className="muted">{number(query.data.suppressed)} suppressed</span><span className="muted">{number(query.data.unsubscribed)} unsubscribed</span></div>}<ContactTable contacts={query.data?.contacts || []} members loading={query.isPending} minRows={pageSize} /></>}</section>
}

export function SegmentsPage() {
  const api = useApi()
  return api.mode === 'demo' ? <DemoSegmentsPage /> : <LiveSegmentsPage />
}
function LiveSegmentsPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const query = useApiQuery(['segments', {page, search}], (api, signal) => api.segments.list({page, search, pageSize}, signal))
  return <div className="audience-page"><PageHeader title="Segments" actions={<Link className="ui-button ui-button--primary" to="/segments/new">Create segment</Link>} /><div className="data-toolbar"><Input aria-label="Search segments" placeholder="Search segments" value={search} onChange={event => {setSearch(event.target.value); setPage(1)}} /></div>{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable rows={query.data?.items ?? []} loading={query.isPending} rowKey={row => row.id} minRows={5} columns={[{key: 'name', label: 'Name', render: row => <Link to={`/segments/${row.id}`}>{row.name}</Link>}, {key: 'rule', label: 'Rule', render: row => <code>{JSON.stringify(row.rule)}</code>}, {key: 'updatedAt', label: 'Updated', render: row => date(row.updatedAt)}]} />{query.data && <Pagination page={query.data.page} pageSize={pageSize} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}</div>
}
export function SegmentEditorPage() {
  const api = useApi(), {id} = useParams()
  return api.mode === 'demo' ? <DemoSegmentEditorPage /> : <LiveSegmentRoute key={id ?? 'new'} id={id} />
}
function LiveSegmentRoute({id}: {id?: string}) {
  const query = useApiQuery(['segments', id ?? 'new'], (api, signal) => id ? api.segments.get(id, signal) : Promise.resolve(null))
  return query.isPending ? <AudienceRouteSkeleton kind="segment" /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <LiveSegmentEditor initial={query.data ? {id: query.data.id, name: query.data.name, match: query.data.match, rules: [], rule: query.data.rule} : {name: '', match: 'all', rules: [], rule: {field: 'country', operator: 'eq', value: 'US'}}} />
}
function validRule(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (r.operator === 'and' || r.operator === 'or') return depth < 3 && Object.keys(r).every(k => ['operator', 'rules'].includes(k)) && Array.isArray(r.rules) && r.rules.length > 0 && r.rules.length <= 10 && r.rules.every(child => validRule(child, depth + 1))
  if (['email', 'firstName', 'plan', 'country'].includes(String(r.field))) return Object.keys(r).every(k => ['field', 'operator', 'value'].includes(k)) && ['eq', 'neq', 'contains'].includes(String(r.operator)) && typeof r.value === 'string' && r.value.length <= 200
  return Object.keys(r).every(k => ['field', 'operator', 'days'].includes(k)) && ['lastOpenAt', 'lastClickAt'].includes(String(r.field)) && ['within', 'inactive'].includes(String(r.operator)) && Number.isInteger(r.days) && Number(r.days) >= 1 && Number(r.days) <= 730
}
function LiveSegmentEditor({initial}: {initial: SegmentInput}) {
  const [name, setName] = useState(initial.name), [text, setText] = useState(JSON.stringify(initial.rule, null, 2)), [error, setError] = useState('')
  const [savedId, setSavedId] = useState(initial.id)
  const navigate = useNavigate()
  const save = useApiMutation((api, input: SegmentInput) => api.segments.save(input), 'Segment saved')
  const preview = useApiMutation((api, input: SegmentInput) => api.segments.preview(input))
  async function submit(showPreview: boolean) {
    setError(''); preview.reset()
    try { const rule: unknown = JSON.parse(text); if (!name.trim() || !validRule(rule)) throw new Error('Enter a name and a valid public segment rule.'); const segment = await save.mutateAsync({id: savedId, name: name.trim(), rule: rule as Record<string, unknown>, match: 'all', rules: []}); setSavedId(segment.id); if (showPreview) await preview.mutateAsync({...segment, id: segment.id}); else navigate(`/segments/${segment.id}`, {replace: true}) }
    catch (cause) {setError(cause instanceof Error ? cause.message : 'Cannot save segment.')}
  }
  const busy = save.isPending || preview.isPending
  return <div className="audience-page"><PageHeader title={savedId ? 'Edit segment' : 'Create segment'} backTo="/segments" actions={<Button variant="primary" loading={busy} onClick={() => submit(false)}>Save segment</Button>} /><div className="stack audience-editor"><Field label="Segment name" htmlFor="segment-name"><Input id="segment-name" value={name} onChange={event => {setName(event.target.value); preview.reset()}} /></Field><SectionHeader title="Conditions" /><Field label="Public rule JSON" htmlFor="segment-rule" hint="Supports nested and/or groups; email, firstName, plan, country; lastOpenAt and lastClickAt."><textarea id="segment-rule" className="ui-input" rows={18} spellCheck={false} value={text} onChange={event => {setText(event.target.value); preview.reset()}} /></Field>{error && <Alert tone="danger">{error}</Alert>}<Button loading={busy} onClick={() => submit(true)}>Save and preview</Button>{preview.data && <section className="section"><SectionHeader title="Audience preview" /><div className="audience-summary cluster"><span>{number(preview.data.matched)} matched</span><span>{number(preview.data.eligible)} eligible</span><span>{number(preview.data.suppressed)} suppressed</span><span>{number(preview.data.unsubscribed)} not subscribed</span></div></section>}</div></div>
}
