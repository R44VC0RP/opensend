import { useApiQuery } from '../../data/context'
import { ApiError, type AudienceList, type Contact } from '../../data/types'
import { Alert, DataTable, SkeletonText, StatusBadge } from '../../components/ui'
import { Link } from 'react-router'
import { contactColumns, memberColumns } from './skeletons'
import { date as formatDate, number } from '../../lib/format'

export const pageSize = 8
export const date = (value: string | null) => value ? formatDate(value) : 'Never'
export { number }
export const statusOptions = [{ value: 'subscribed', label: 'Subscribed' }, { value: 'unsubscribed', label: 'Unsubscribed' }, { value: 'suppressed', label: 'Suppressed' }]
export function fieldError(error: unknown, field: string) { return error instanceof ApiError ? error.fields[field] : undefined }
export function MutationError({ error }: { error: unknown }) { return error ? <Alert tone="danger">{error instanceof Error ? error.message : 'The request could not be completed.'}</Alert> : null }
export function useAudienceLists() {
  return useApiQuery(['lists', 'options', { pageSize: 1000 }], async (api, signal) => {
    const first = await api.lists.list({ page: 1, pageSize: 1000 }, signal)
    const items = [...first.items]
    for (let page = 2; items.length < first.total; page++) {
      const next = await api.lists.list({ page, pageSize: 1000 }, signal)
      if (!next.items.length) break
      items.push(...next.items)
    }
    return items
  })
}
export function ContactTable({ contacts, lists = [], members = false, loading = false, minRows = pageSize, listsLoading = false }: { contacts: Contact[]; lists?: AudienceList[]; members?: boolean; loading?: boolean; minRows?: number; listsLoading?: boolean }) {
  const columns = members ? memberColumns : contactColumns
  return <DataTable rows={contacts} loading={loading} skeletonRows={pageSize} minRows={minRows} rowKey={row => row.id} columns={columns.map(column => ({ ...column, render: (row: Contact) => {
    if (column.key === 'email') return <Link className="audience-cell-text" title={row.email} to={`/contacts/${row.id}`}>{row.email}</Link>
    if (column.key === 'status') return <StatusBadge status={row.status} />
    if (column.key === 'suppression') return <span className="audience-cell-text" title={row.suppressionReason || 'None'}>{row.suppressionReason || 'None'}</span>
    if (column.key === 'name') return <span className="audience-cell-text" title={row.name}>{row.name || '—'}</span>
    if (column.key === 'lists') {
      if (listsLoading && row.listIds.length) return <SkeletonText width="70%" />
      const names = row.listIds.map(id => lists.find(list => list.id === id)?.name || id).join(', ')
      return <span className="audience-cell-text" title={names}>{names || '—'}</span>
    }
    return date(row.createdAt)
  } }))} />
}
