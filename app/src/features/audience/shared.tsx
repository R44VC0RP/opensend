import { useApiQuery } from '../../data/context'
import { ApiError, type AudienceList, type Contact } from '../../data/types'
import { Alert, DataTable, SkeletonText, StatusBadge } from '../../components/ui'
import { Link } from 'react-router'
import { contactColumns, memberColumns } from './skeletons'
import { date as formatDate, number } from '../../lib/format'

export const pageSize = 8
export const date = (value: string | null) => value ? formatDate(value) : 'Never'
export { number }
export const statusOptions = [{ value: 'subscribed', label: 'Subscribed' }, { value: 'unsubscribed', label: 'Unsubscribed' }, { value: 'suppressed', label: 'Suppressed' }, { value: 'unknown', label: 'Unknown consent' }]
export function fieldError(error: unknown, field: string) { return error instanceof ApiError ? error.fields[field] : undefined }
export function MutationError({ error }: { error: unknown }) { return error ? <Alert tone="danger">{error instanceof Error ? error.message : 'The request could not be completed.'}</Alert> : null }
export function useAudienceLists(search = '', cursor?: string) {
  return useApiQuery(['lists', 'options', { pageSize: 100, search, cursor }], async (api, signal) => {
    const page = await api.lists.list({pageSize: 100, search, cursor}, signal)
    return Object.assign(page.items, {nextCursor: page.nextCursor ?? null})
  })
}
export function ContactTable({ contacts, lists = [], members = false, loading = false, minRows = pageSize, listsLoading = false, tableRef }: { contacts: Contact[]; lists?: AudienceList[]; members?: boolean; loading?: boolean; minRows?: number; listsLoading?: boolean; tableRef?: (node: HTMLDivElement | null) => void }) {
  const columns = members ? memberColumns : contactColumns
  return <DataTable tableRef={tableRef} rows={contacts} loading={loading} skeletonRows={minRows} minRows={minRows} rowKey={row => row.id} columns={columns.map(column => ({ ...column, render: (row: Contact) => {
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
