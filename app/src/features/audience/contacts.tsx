import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Plus } from 'lucide-react'
import { useApiMutation, useApiQuery, useRegion, useApi } from '../../data/context'
import type { Contact, ContactInput, ContactStatus, ConsentInput } from '../../data/types'
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
  const [listSearch, setListSearch] = useState('')
  const [listCursor, setListCursor] = useState<string | undefined>()
  const lists = useAudienceLists(listSearch, listCursor)
  const params = { page, pageSize, search, status, listId }
  const query = useApiQuery(['contacts', params], (api, signal) => api.contacts.list(params, signal))
  return <div className="audience-page">
    <PageHeader title="Contacts" actions={<><Button onClick={() => setImporting(true)}>Import contacts</Button><Button variant="primary" onClick={() => setAdd(true)}><Plus size={16} />Add contact</Button></>} />
    <Tabs value={status} onValueChange={value => { setStatus(value); setPage(1) }} items={[{ value: '', label: 'All contacts' }, ...statusOptions]} />
    <div className="data-toolbar"><div className="cluster"><Input className="audience-search" aria-label="Search contacts" placeholder="Search email or name" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><Input aria-label="Find list filter" placeholder="Find list by name" value={listSearch} onChange={event => {setListSearch(event.target.value); setListCursor(undefined)}} />{lists.isPending ? <LoadingRegion label="Loading list filter"><ControlSkeleton width={170} /></LoadingRegion> : <Select className="audience-list-filter" aria-label="Filter by list" value={listId} onValueChange={value => { setListId(value); setPage(1) }} options={[{ value: '', label: 'All lists' }, ...(listId && !(lists.data ?? []).some(list => list.id === listId) ? [{value: listId, label: listId}] : []), ...(lists.data || []).map(list => ({ value: list.id, label: `${list.name} · ${list.id}` }))]} />}</div><span className="muted audience-count">{query.isPending ? <SkeletonText width={100} /> : query.data?.total !== undefined && `${number(query.data.total)} contacts`}</span></div>
    {(listCursor || lists.data?.nextCursor) && <div className="cluster"><Button disabled={lists.isFetching || !listCursor} onClick={() => setListCursor(undefined)}>First matching lists</Button><Button disabled={lists.isFetching || !lists.data?.nextCursor} onClick={() => setListCursor(lists.data?.nextCursor ?? undefined)}>Next matching lists</Button></div>}
    {lists.isError && <ErrorState error={lists.error} onRetry={() => lists.refetch()} />}
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><ContactTable contacts={query.data?.items || []} lists={lists.data} listsLoading={lists.isPending} loading={query.isPending} minRows={pageSize} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}
    {add && <ContactEditor onClose={() => setAdd(false)} />}
    {importing && <ImportContactsDialog onClose={() => setImporting(false)} />}
  </div>
}

function ContactEditor({ contact, onClose }: { contact?: Contact; onClose: () => void }) {
  const [input, setInput] = useState<ContactInput>(() => contact ? { id: contact.id, email: contact.email, name: contact.name, country: contact.country, status: contact.status, listIds: [...contact.listIds] } : { email: '', name: '', country: '', status: 'unsubscribed', listIds: [] })
  const [listSearch, setListSearch] = useState('')
  const [listCursor, setListCursor] = useState<string | undefined>()
  const lists = useAudienceLists(listSearch, listCursor)
  const save = useApiMutation((api, value: ContactInput) => api.contacts.save(value), contact ? 'Contact updated' : 'Contact added')
  async function submit() {
    try { await save.mutateAsync({ ...input, status: contact ? contact.status : 'unknown' }); onClose() } catch { /* Shown inline. */ }
  }
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose() }} title={contact ? 'Edit contact' : 'Add contact'} footer={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="primary" type="submit" form="contact-editor" loading={save.isPending} disabled={lists.isPending || lists.isError}>{contact ? 'Save changes' : 'Add contact'}</Button></>}>
    <form id="contact-editor" className="stack" onSubmit={event => { event.preventDefault(); void submit() }}>
      <MutationError error={save.error} />
      <Field label="Email" htmlFor="contact-email" error={fieldError(save.error, 'email')}><Input id="contact-email" type="email" required readOnly={!!contact} value={input.email} onChange={event => setInput({ ...input, email: event.target.value })} /></Field>
      <div className="form-grid"><Field label="Full name" htmlFor="contact-name" error={fieldError(save.error, 'name')}><Input id="contact-name" value={input.name} onChange={event => setInput({ ...input, name: event.target.value })} /></Field><Field label="Country" htmlFor="contact-country" hint="Two-letter country code, e.g. US." error={fieldError(save.error, 'country')}><Input id="contact-country" maxLength={2} value={input.country} onChange={event => setInput({ ...input, country: event.target.value })} /></Field></div>
      <Field label="Find lists" htmlFor="contact-list-search"><Input id="contact-list-search" type="search" placeholder="Search list names" value={listSearch} onChange={event => {setListSearch(event.target.value); setListCursor(undefined)}} /></Field>
      <Field label="Lists" error={fieldError(save.error, 'listIds')}><div className="stack">{lists.isPending ? <LoadingRegion label="Loading lists"><ControlSkeleton /></LoadingRegion> : lists.isError ? <ErrorState error={lists.error} onRetry={() => lists.refetch()} /> : lists.data.length ? lists.data.map(list => <Checkbox key={list.id} checked={input.listIds.includes(list.id)} onCheckedChange={checked => setInput({ ...input, listIds: checked ? [...input.listIds, list.id] : input.listIds.filter(id => id !== list.id) })} label={`${list.name} · ${list.id}`} />) : <span className="muted">No matching lists.</span>}</div></Field>
      {input.listIds.length > 0 && <p className="muted">Selected lists: {input.listIds.join(', ')}</p>}
      {(listCursor || lists.data?.nextCursor) && <div className="cluster"><Button disabled={save.isPending || lists.isFetching || !listCursor} onClick={() => setListCursor(undefined)}>First matching lists</Button><Button disabled={save.isPending || lists.isFetching || !lists.data?.nextCursor} onClick={() => setListCursor(lists.data?.nextCursor ?? undefined)}>Next matching lists</Button></div>}
      {!contact && <Alert tone="info">Marketing consent starts as unknown.</Alert>}
      {contact?.status === 'suppressed' && <Alert tone="warning">Suppressed: {contact.suppressionReason || 'Delivery blocked.'}</Alert>}
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
  const [consentInput, setConsentInput] = useState<ConsentInput>({status: contact.status === 'subscribed' ? 'unsubscribed' : 'subscribed', source: '', evidence: '', policyVersion: '', occurredAt: '', confirmResubscribe: false})
  const status = useApiMutation(async (api, input: ConsentInput) => api.consent ? api.consent(contact.id, input) : api.contacts.save({...contact, status: input.status}), 'Consent recorded')
  const [consentError, setConsentError] = useState('')
  const nextStatus = consentInput.status
  async function changeStatus() {
    setConsentError('')
    const occurred = new Date(consentInput.occurredAt)
    if (!Number.isFinite(occurred.getTime())) {setConsentError('Enter a valid consent date and time.'); return}
    try { await status.mutateAsync({...consentInput, occurredAt: occurred.toISOString()}); setConfirm(false) } catch { /* Shown in the consent dialog. */ }
  }
  return <div className="audience-page">
    <PageHeader title={contact.name || contact.email} backTo="/contacts" actions={<><Button disabled={contact.status === 'suppressed' || status.isPending} onClick={() => {status.reset(); setConsentError(''); setConsentInput({status: contact.status === 'subscribed' ? 'unsubscribed' : 'subscribed', source: '', evidence: '', policyVersion: '', occurredAt: '', confirmResubscribe: false}); setConfirm(true)}}>{contact.status === 'subscribed' ? 'Unsubscribe' : 'Resubscribe'}</Button><Button variant="primary" onClick={() => setEdit(true)}>Edit contact</Button></>} />
    <div className="audience-summary cluster"><span>{contact.email}</span><StatusBadge status={contact.status} /></div>
    <MutationError error={status.error} />
    {contact.status === 'suppressed' && <Alert tone="warning">{contact.suppressionReason || 'Delivery suppressed'}. Resubscription unavailable.</Alert>}
    <div className="form-grid audience-properties"><section><SectionHeader title="Properties" /><dl><dt>Full name</dt><dd>{contact.name || '—'}</dd><dt>Country</dt><dd>{contact.country || '—'}</dd><dt>Created</dt><dd>{date(contact.createdAt)}</dd><dt>Last opened</dt><dd>{date(contact.lastOpenedAt)}</dd></dl></section><section><SectionHeader title="Marketing consent" /><dl><dt>Status</dt><dd><StatusBadge status={contact.status} /></dd>{contact.consent.source && <><dt>Consent source</dt><dd>{contact.consent.source}</dd><dt>Confirmed</dt><dd>{contact.consent.at ? date(contact.consent.at) : 'Not recorded'}</dd></>}<dt>Suppression</dt><dd>{contact.suppressionReason || 'None'}</dd></dl></section></div>
    <section className="section"><SectionHeader title="Lists" actions={<Button onClick={() => setEdit(true)}>Manage lists</Button>} />{lists.isPending ? <LoadingRegion label="Loading list memberships"><SkeletonText width={170} /></LoadingRegion> : lists.isError ? <ErrorState error={lists.error} onRetry={() => lists.refetch()} /> : <div className="cluster">{contact.listIds.length ? contact.listIds.map(id => <Link key={id} to={`/lists/${id}`}>{lists.data.find(list => list.id === id)?.name || id}</Link>) : <span className="muted">Not on any lists.</span>}</div>}</section>
    <ConsentHistory id={contact.id} />
    <ContactActivity key={`${contact.email}:${regionId}`} email={contact.email} />
    {edit && <ContactEditor contact={contact} onClose={() => setEdit(false)} />}
    <Dialog open={confirm} onOpenChange={setConfirm} title="Record marketing consent" footer={<><Button onClick={() => setConfirm(false)} disabled={status.isPending}>Cancel</Button><Button variant="primary" type="submit" form="contact-consent" loading={status.isPending}>Record consent</Button></>}><form id="contact-consent" className="stack" onSubmit={event => {event.preventDefault(); void changeStatus()}}><MutationError error={consentError || status.error} /><Field label="Status" htmlFor="consent-status"><Select id="consent-status" value={consentInput.status} onValueChange={value => setConsentInput({...consentInput, status: value as ConsentInput['status']})} options={[{value: 'subscribed', label: 'Subscribed'}, {value: 'unsubscribed', label: 'Unsubscribed'}]} /></Field>{(['source', 'policyVersion', 'evidence'] as const).map(key => <Field key={key} label={key === 'policyVersion' ? 'Policy version' : key === 'source' ? 'Source' : 'Evidence'} htmlFor={`consent-${key}`}><Input id={`consent-${key}`} required maxLength={key === 'evidence' ? 2000 : key === 'source' ? 200 : 120} value={consentInput[key]} onChange={event => setConsentInput({...consentInput, [key]: event.target.value})} /></Field>)}<Field label="Consent occurred at (local time)" htmlFor="consent-at"><Input id="consent-at" type="datetime-local" required value={consentInput.occurredAt} onChange={event => setConsentInput({...consentInput, occurredAt: event.target.value})} /></Field>{consentInput.status === 'subscribed' && <Checkbox checked={consentInput.confirmResubscribe} onCheckedChange={checked => setConsentInput({...consentInput, confirmResubscribe: checked})} label="This evidence explicitly authorizes resubscription if previously unsubscribed." />}</form></Dialog>

  </div>
}
function ContactActivity({ email }: { email: string }) {
  const { regionId } = useRegion()
  const [page, setPage] = useState(1)
  const params = { search: email, page, pageSize: 5, regionId }
  const query = useApiQuery(['emails', 'contact-activity', params], (api, signal) => api.emails.list(params, signal))
  return <section className="section"><SectionHeader title="Matching emails" /><p className="muted">{regionId}</p>{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable rows={query.data?.items || []} loading={query.isPending} skeletonRows={5} minRows={5} rowKey={row => row.id} empty={<EmptyState title="No email activity" />} columns={[{ ...activityColumns[0], render: row => <Link className="audience-cell-text" title={row.subject} to={`/logs/${row.id}`}>{row.subject}</Link> }, { ...activityColumns[1], render: row => <StatusBadge status={row.status} /> }, { ...activityColumns[2], render: row => date(row.sentAt) }]} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={5} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}</section>
}

function ConsentHistory({id}: {id: string}) {
  const api = useApi(), [cursor, setCursor] = useState<string | undefined>()
  const query = useApiQuery(['consent-history', id, cursor], async api => api.consentHistory ? api.consentHistory(id, cursor) : null)
  if (!api.consentHistory) return null
  return <section className="section"><SectionHeader title="Consent evidence history" />{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable loading={query.isPending} rows={query.data?.items ?? []} rowKey={row => row.id} columns={[{key: 'status', label: 'Status', render: row => row.status}, {key: 'source', label: 'Source', render: row => row.source}, {key: 'evidence', label: 'Evidence', render: row => row.evidence}, {key: 'policy', label: 'Policy version', render: row => row.policyVersion}, {key: 'at', label: 'Occurred at', render: row => date(row.occurredAt)}]} /><div className="cluster"><Button disabled={!cursor} onClick={() => setCursor(undefined)}>First page</Button><Button disabled={!query.data?.nextCursor} onClick={() => setCursor(query.data?.nextCursor ?? undefined)}>Next page</Button></div></>}</section>
}
