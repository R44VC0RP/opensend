import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Plus } from 'lucide-react'
import { useApiMutation, useApiQuery } from '../../data/context'
import { Button, ControlSkeleton, DataTable, Dialog, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SkeletonText, Tabs } from '../../components/ui'
import { listColumns, ListDetailBodySkeleton } from './skeletons'
import { ContactTable, date, fieldError, MutationError, number, pageSize, statusOptions } from './shared'
import { ImportContactsDialog } from './import'

export function ListsPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [create, setCreate] = useState(false)
  const params = { page, pageSize, search }
  const query = useApiQuery(['lists', params], (api, signal) => api.lists.list(params, signal))
  return <div className="audience-page"><PageHeader title="Lists" actions={<Button variant="primary" onClick={() => setCreate(true)}><Plus size={16} />Create list</Button>} />
    <div className="data-toolbar"><Input className="audience-search" aria-label="Search lists" placeholder="Search lists" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><span className="muted audience-count">{query.isPending ? <SkeletonText width={100} /> : query.data?.total !== undefined && `${number(query.data.total)} lists`}</span></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable rows={query.data?.items || []} loading={query.isPending} skeletonRows={5} minRows={5} rowKey={row => row.id} columns={[{ ...listColumns[0], render: row => <Link className="audience-cell-text" title={row.name} to={`/lists/${row.id}`}>{row.name}</Link> }, { ...listColumns[1], render: row => number(row.subscribed) }, { ...listColumns[2], render: row => number(row.suppressed) }, { ...listColumns[3], render: row => number(row.unsubscribed) }, { key: 'unknown', label: 'Unknown consent', render: row => number(row.unknown) }, { ...listColumns[4], render: row => number(row.total) }, { ...listColumns[5], render: row => date(row.createdAt) }]} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}
    {create && <CreateListDialog onClose={() => setCreate(false)} />}
  </div>
}
function CreateListDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const navigate = useNavigate()
  const create = useApiMutation((api, input: { name: string }) => api.lists.create(input), 'List created')
  async function submit() { try { const list = await create.mutateAsync({ name }); onClose(); navigate(`/lists/${list.id}`) } catch { /* Shown inline. */ } }
  return <Dialog open onOpenChange={open => { if (!open && !create.isPending) onClose() }} title="Create list" footer={<><Button disabled={create.isPending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="create-list" loading={create.isPending}>Create list</Button></>}><form id="create-list" className="stack" onSubmit={event => { event.preventDefault(); void submit() }}><MutationError error={create.error} /><Field label="List name" htmlFor="list-name" error={fieldError(create.error, 'name')}><Input autoFocus id="list-name" required value={name} onChange={event => setName(event.target.value)} /></Field></form></Dialog>
}
export function ListDetailPage() {
  const { id = '' } = useParams()
  const query = useApiQuery(['lists', id], (api, signal) => api.lists.get(id, signal))
  const [importing, setImporting] = useState(false)
  return <div className="audience-page"><PageHeader title={query.isPending ? <SkeletonText width={180} lineHeight={24} /> : query.data?.name || 'List'} backTo="/lists" actions={query.isPending ? <ControlSkeleton width={132} /> : query.data && <Button variant="primary" onClick={() => setImporting(true)}>Import contacts</Button>} />
    {query.isPending ? <ListDetailBodySkeleton /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><div className="audience-summary cluster"><span>{number(query.data.total)} contacts</span><span>{number(query.data.subscribed)} subscribed</span><span className="muted">{number(query.data.suppressed)} suppressed</span><span className="muted">{number(query.data.unsubscribed)} unsubscribed</span>{query.data.unknown !== undefined && <span className="muted">{number(query.data.unknown)} unknown consent</span>}</div><ListMembers key={id} listId={id} /></>}
    {importing && <ImportContactsDialog listId={id} onClose={() => setImporting(false)} />}
  </div>
}
function ListMembers({ listId }: { listId: string }) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const params = { listId, search, status, page, pageSize }
  const query = useApiQuery(['contacts', params], (api, signal) => api.contacts.list(params, signal))
  return <><Tabs value={status} onValueChange={value => { setStatus(value); setPage(1) }} items={[{ value: '', label: 'All members' }, ...statusOptions]} /><div className="data-toolbar"><Input className="audience-search" aria-label="Search members" placeholder="Search members" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><ContactTable contacts={query.data?.items || []} members loading={query.isPending} minRows={pageSize} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}</>
}
