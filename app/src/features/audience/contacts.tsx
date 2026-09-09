import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Plus } from 'lucide-react'
import { useApiMutation, useApiQuery, useRegion } from '../../data/context'
import type { Contact, ContactInput, ContactStatus } from '../../data/types'
import { Alert, Button, Checkbox, ConfirmDialog, ControlSkeleton, DataTable, Dialog, EmptyState, ErrorState, Field, Input, LoadingRegion, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select, SkeletonText, StatusBadge, Tabs } from '../../components/ui'
import { activityColumns, AudienceRouteSkeleton } from './skeletons'
import { ContactTable, date, fieldError, MutationError, number, pageSize, statusOptions, useAudienceLists } from './shared'
import { ImportContactsDialog } from './import'

export function ContactsPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [listId, setListId] = useState('')
  const [page, setPage] = useState(1)
  const [add, setAdd] = useState(false)
  const [importing, setImporting] = useState(false)
  const lists = useAudienceLists()
  const params = { page, pageSize, search, status, listId }
  const query = useApiQuery(['contacts', params], (api, signal) => api.contacts.list(params, signal))
  return <div className="audience-page">
    <PageHeader title="Contacts" actions={<><Button onClick={() => setImporting(true)}>Import contacts</Button><Button variant="primary" onClick={() => setAdd(true)}><Plus size={16} />Add contact</Button></>} />
    <Tabs value={status} onValueChange={value => { setStatus(value); setPage(1) }} items={[{ value: '', label: 'All contacts' }, ...statusOptions]} />
    <div className="data-toolbar"><div className="cluster"><Input className="audience-search" aria-label="Search contacts" placeholder="Search email or name" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} />{lists.isPending ? <LoadingRegion label="Loading list filter"><ControlSkeleton width={170} /></LoadingRegion> : <Select className="audience-list-filter" aria-label="Filter by list" value={listId} onValueChange={value => { setListId(value); setPage(1) }} options={[{ value: '', label: 'All lists' }, ...(lists.data || []).map(list => ({ value: list.id, label: list.name }))]} />}</div><span className="muted audience-count">{query.isPending ? <SkeletonText width={100} /> : query.data && `${number(query.data.total)} contacts`}</span></div>
    {lists.isError && <ErrorState error={lists.error} onRetry={() => lists.refetch()} />}
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><ContactTable contacts={query.data?.items || []} lists={lists.data} listsLoading={lists.isPending} loading={query.isPending} minRows={pageSize} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={pageSize} total={query.data.total} onPageChange={setPage} />}</>}
    {add && <ContactEditor onClose={() => setAdd(false)} />}
    {importing && <ImportContactsDialog onClose={() => setImporting(false)} />}
  </div>
}

function ContactEditor({ contact, onClose }: { contact?: Contact; onClose: () => void }) {
  const [input, setInput] = useState<ContactInput>(() => contact ? { id: contact.id, email: contact.email, name: contact.name, country: contact.country, status: contact.status, listIds: [...contact.listIds] } : { email: '', name: '', country: '', status: 'unsubscribed', listIds: [] })
  const [consent, setConsent] = useState(false)
  const lists = useAudienceLists()
  const save = useApiMutation((api, value: ContactInput) => api.contacts.save(value), contact ? 'Contact updated' : 'Contact added')
  async function submit() {
    try { await save.mutateAsync({ ...input, status: contact ? contact.status : consent ? 'subscribed' : 'unsubscribed' }); onClose() } catch { /* Shown inline. */ }
  }
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose() }} title={contact ? 'Edit contact' : 'Add contact'} footer={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="primary" type="submit" form="contact-editor" loading={save.isPending} disabled={lists.isPending || lists.isError}>{contact ? 'Save changes' : 'Add contact'}</Button></>}>
    <form id="contact-editor" className="stack" onSubmit={event => { event.preventDefault(); void submit() }}>
      <MutationError error={save.error} />
      <Field label="Email" htmlFor="contact-email" error={fieldError(save.error, 'email')}><Input id="contact-email" type="email" required readOnly={!!contact} value={input.email} onChange={event => setInput({ ...input, email: event.target.value })} /></Field>
      <div className="form-grid"><Field label="Full name" htmlFor="contact-name" error={fieldError(save.error, 'name')}><Input id="contact-name" value={input.name} onChange={event => setInput({ ...input, name: event.target.value })} /></Field><Field label="Country" htmlFor="contact-country" hint="Two-letter country code, e.g. US." error={fieldError(save.error, 'country')}><Input id="contact-country" maxLength={2} value={input.country} onChange={event => setInput({ ...input, country: event.target.value })} /></Field></div>
      <Field label="Lists" error={fieldError(save.error, 'listIds')}><div className="stack">{lists.isPending ? <LoadingRegion label="Loading lists"><ControlSkeleton /></LoadingRegion> : lists.isError ? <ErrorState error={lists.error} onRetry={() => lists.refetch()} /> : lists.data.length ? lists.data.map(list => <Checkbox key={list.id} checked={input.listIds.includes(list.id)} onCheckedChange={checked => setInput({ ...input, listIds: checked ? [...input.listIds, list.id] : input.listIds.filter(id => id !== list.id) })} label={list.name} />) : <span className="muted">No lists yet.</span>}</div></Field>
      {!contact && <Checkbox checked={consent} onCheckedChange={setConsent} label="I confirm this contact has given valid marketing opt-in." />}
      {contact?.status === 'suppressed' && <Alert tone="warning">Suppression retained: {contact.suppressionReason || 'This contact cannot receive marketing email.'}</Alert>}
    </form>
  </Dialog>
}

export function ContactDetailPage() {
  const { id = '' } = useParams()
  const query = useApiQuery(['contacts', id], (api, signal) => api.contacts.get(id, signal))
  return query.isPending ? <AudienceRouteSkeleton kind="contact" /> : query.isError ? <><PageHeader title="Contact" backTo="/contacts" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></> : <ContactDetails key={id} contact={query.data} />
}
function ContactDetails({ contact }: { contact: Contact }) {
  const { regionId } = useRegion()
  const [edit, setEdit] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const lists = useAudienceLists()
  const status = useApiMutation((api, input: ContactInput) => api.contacts.save(input), 'Subscription updated')
  const nextStatus: ContactStatus = contact.status === 'subscribed' ? 'unsubscribed' : 'subscribed'
  async function changeStatus() {
    try { await status.mutateAsync({ id: contact.id, email: contact.email, name: contact.name, country: contact.country, listIds: contact.listIds, status: nextStatus }); setConfirm(false) } catch { setConfirm(false) }
  }
  return <div className="audience-page">
    <PageHeader title={contact.name || contact.email} backTo="/contacts" actions={<><Button disabled={contact.status === 'suppressed' || status.isPending} onClick={() => setConfirm(true)}>{contact.status === 'subscribed' ? 'Unsubscribe' : 'Resubscribe'}</Button><Button variant="primary" onClick={() => setEdit(true)}>Edit contact</Button></>} />
    <div className="audience-summary cluster"><span>{contact.email}</span><StatusBadge status={contact.status} /></div>
    <MutationError error={status.error} />
    {contact.status === 'suppressed' && <Alert tone="warning">{contact.suppressionReason || 'Suppressed'}. Resubscription is disabled; editing this contact will not clear its suppression.</Alert>}
    <div className="form-grid audience-properties"><section><SectionHeader title="Properties" /><dl><dt>Full name</dt><dd>{contact.name || '—'}</dd><dt>Country</dt><dd>{contact.country || '—'}</dd><dt>Created</dt><dd>{date(contact.createdAt)}</dd><dt>Last opened</dt><dd>{date(contact.lastOpenedAt)}</dd></dl></section><section><SectionHeader title="Marketing consent" /><dl><dt>Status</dt><dd><StatusBadge status={contact.status} /></dd><dt>Consent source</dt><dd>{contact.consent.source || 'Not recorded'}</dd><dt>Confirmed</dt><dd>{contact.consent.at ? date(contact.consent.at) : 'Not recorded'}</dd><dt>Suppression</dt><dd>{contact.suppressionReason || 'None'}</dd></dl></section></div>
    <section className="section"><SectionHeader title="Lists" actions={<Button onClick={() => setEdit(true)}>Manage lists</Button>} />{lists.isPending ? <LoadingRegion label="Loading list memberships"><SkeletonText width={170} /></LoadingRegion> : lists.isError ? <ErrorState error={lists.error} onRetry={() => lists.refetch()} /> : <div className="cluster">{contact.listIds.length ? contact.listIds.map(id => <Link key={id} to={`/lists/${id}`}>{lists.data.find(list => list.id === id)?.name || id}</Link>) : <span className="muted">Not on any lists.</span>}</div>}</section>
    <ContactActivity key={`${contact.email}:${regionId}`} email={contact.email} />
    {edit && <ContactEditor contact={contact} onClose={() => setEdit(false)} />}
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={nextStatus === 'subscribed' ? 'Confirm marketing opt-in' : 'Unsubscribe contact?'} description={nextStatus === 'subscribed' ? `Confirm that ${contact.email} has given valid, current permission to receive marketing email.` : `${contact.email} will no longer be eligible for marketing campaigns.`} confirmLabel={nextStatus === 'subscribed' ? 'Confirm and resubscribe' : 'Unsubscribe'} onConfirm={changeStatus} pending={status.isPending} danger={nextStatus === 'unsubscribed'} />
  </div>
}
function ContactActivity({ email }: { email: string }) {
  const { regionId } = useRegion()
  const [page, setPage] = useState(1)
  const params = { search: email, page, pageSize: 5, regionId }
  const query = useApiQuery(['emails', 'contact-activity', params], (api, signal) => api.emails.list(params, signal))
  return <section className="section"><SectionHeader title="Recent email activity" /><p className="muted">{regionId}</p>{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable rows={query.data?.items || []} loading={query.isPending} skeletonRows={5} minRows={5} rowKey={row => row.id} empty={<EmptyState title="No email activity" description="No matching emails in the selected region." />} columns={[{ ...activityColumns[0], render: row => <Link className="audience-cell-text" title={row.subject} to={`/logs/${row.id}`}>{row.subject}</Link> }, { ...activityColumns[1], render: row => <StatusBadge status={row.status} /> }, { ...activityColumns[2], render: row => date(row.sentAt) }]} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={5} total={query.data.total} onPageChange={setPage} />}</>}</section>
}
