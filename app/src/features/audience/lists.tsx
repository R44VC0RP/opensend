import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Plus } from 'lucide-react'
import { useApiMutation, useApiQuery } from '../../data/context'
import { Button, DataTable, Dialog, ErrorState, Field, Input, LoadingState, PageHeader, Pagination, Tabs } from '../../components/ui'
import { ContactTable, date, fieldError, MutationError, number, pageSize, statusOptions } from './shared'
import { ImportContactsDialog } from './import'

export function ListsPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [create, setCreate] = useState(false)
  const params = { page, pageSize, search }
  const query = useApiQuery(['lists', params], (api, signal) => api.lists.list(params, signal))
  return <div className="audience-page"><PageHeader title="Lists" actions={<Button variant="primary" onClick={() => setCreate(true)}><Plus size={16} />Create list</Button>} />
    <div className="data-toolbar"><Input className="audience-search" aria-label="Search lists" placeholder="Search lists" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><span className="muted">{query.data && `${number(query.data.total)} lists`}</span></div>
    {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable rows={query.data.items} rowKey={row => row.id} columns={[{ key: 'name', label: 'Name', width: '27%', render: row => <Link to={`/lists/${row.id}`}>{row.name}</Link> }, { key: 'subscribed', label: 'Subscribed', render: row => number(row.subscribed) }, { key: 'suppressed', label: 'Suppressed', render: row => number(row.suppressed) }, { key: 'unsubscribed', label: 'Unsubscribed', render: row => number(row.unsubscribed) }, { key: 'total', label: 'Total contacts', render: row => number(row.total) }, { key: 'created', label: 'Created', render: row => date(row.createdAt) }]} /><Pagination page={page} pageSize={pageSize} total={query.data.total} onPageChange={setPage} /></>}
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
  return <div className="audience-page"><PageHeader title={query.data?.name || 'List'} backTo="/lists" actions={query.data && <Button variant="primary" onClick={() => setImporting(true)}>Import contacts</Button>} />
    {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><div className="audience-summary cluster"><span>{number(query.data.total)} contacts</span><span>{number(query.data.subscribed)} subscribed</span><span className="muted">{number(query.data.suppressed)} suppressed</span><span className="muted">{number(query.data.unsubscribed)} unsubscribed</span></div><ListMembers key={id} listId={id} /></>}
    {importing && <ImportContactsDialog listId={id} onClose={() => setImporting(false)} />}
  </div>
}
function ListMembers({ listId }: { listId: string }) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const params = { listId, search, status, page, pageSize }
  const query = useApiQuery(['contacts', params], (api, signal) => api.contacts.list(params, signal))
  return <><Tabs value={status} onValueChange={value => { setStatus(value); setPage(1) }} items={[{ value: '', label: 'All members' }, ...statusOptions]} /><div className="data-toolbar"><Input className="audience-search" aria-label="Search members" placeholder="Search members" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>{query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><ContactTable contacts={query.data.items} members /><Pagination page={page} pageSize={pageSize} total={query.data.total} onPageChange={setPage} /></>}</>
}
