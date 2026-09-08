import { useApiQuery } from '../../data/context'
import { ApiError, type AudienceList, type Contact } from '../../data/types'
import { Alert, DataTable, StatusBadge } from '../../components/ui'
import { Link } from 'react-router'
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
export function ContactTable({ contacts, lists = [], members = false }: { contacts: Contact[]; lists?: AudienceList[]; members?: boolean }) {
  return <DataTable rows={contacts} rowKey={row => row.id} columns={[
    { key: 'email', label: 'Email', width: '28%', render: row => <Link to={`/contacts/${row.id}`}>{row.email}</Link> },
    { key: 'status', label: 'Status', width: '17%', render: row => <StatusBadge status={row.status} /> },
    ...(members ? [{ key: 'suppression', label: 'Suppression reason', render: (row: Contact) => row.suppressionReason || 'None' }] : [
      { key: 'name', label: 'Name', render: (row: Contact) => row.name || '—' },
      { key: 'lists', label: 'Lists', render: (row: Contact) => row.listIds.length ? row.listIds.map(id => lists.find(list => list.id === id)?.name || id).join(', ') : '—' },
    ]),
    { key: 'created', label: 'Added', width: '17%', render: row => date(row.createdAt) },
  ]} />
}
