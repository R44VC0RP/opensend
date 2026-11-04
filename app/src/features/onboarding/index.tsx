import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Alert, Button, ConfirmDialog, ErrorState, Field, Input, PageHeader, Select, StatusBadge } from '../../components/ui'
import { RouteSkeleton } from '../../components/RouteSkeleton'
import { useApi, useApiMutation, useApiQuery, useSession } from '../../data/context'
import { connectionApi, retryableConnectionErrors, setDomainStep, useConnectionCache } from '../../data/connections'
import { DomainRecords, domainState, useDomain } from '../settings/domain-records'
import { ApiError, type ProviderConnection } from '../../data/types'
import './onboarding.css'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Bring-your-own verification is resumable; keep retrying while AWS confirms the feedback subscription.
async function retrying<T>(run: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    try { return await run() }
    catch (error) {
      if (attempt >= 20 || !(error instanceof ApiError && retryableConnectionErrors.has(error.code))) throw error
      await wait(3000)
    }
  }
}
const code = (error: unknown) => error instanceof ApiError ? error.code : undefined
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'

// A ready connection opens the add-domain step, then lifts the gate.
function useConnectionMutation<T>(write: (input: T) => Promise<ProviderConnection | null>) {
  const client = useQueryClient()
  const sync = useConnectionCache()
  const workspaceId = useSession()?.identity?.workspaceId
  return useMutation({
    gcTime: 0,
    mutationFn: write,
    onSuccess: connection => {
      if (connection?.status === 'ready' && workspaceId) setDomainStep(workspaceId, '')
      sync(connection)
      if (connection?.status !== 'ready') return
      // Regions, discovery and limits now come from the new connection.
      void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'opensend' && query.queryKey[3] !== 'connection' }).catch(() => {})
    },
  })
}

function StartOver() {
  const [open, setOpen] = useState(false)
  const remove = useConnectionMutation(async () => { await connectionApi.remove(); return null })
  return <>
    <Button variant="ghost" onClick={() => setOpen(true)}>Start over</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} title="Start over?" description="The current CloudFormation link stops working. If you already created the stack, delete it in AWS." confirmLabel="Start over" pending={remove.isPending} onConfirm={() => remove.mutateAsync(undefined)} />
  </>
}

export function SendingOnboarding() {
  const connection = useApiQuery(['connection'], (_api, signal) => connectionApi.get(signal))
  const regions = useApiQuery(['connection-regions'], (_api, signal) => connectionApi.regions(signal))
  const sync = useConnectionCache()
  // Setup finished elsewhere (another tab or admin): lift the gate.
  useEffect(() => { if (connection.data?.status === 'ready') sync(connection.data) }, [connection.data]) // eslint-disable-line react-hooks/exhaustive-deps
  if (connection.error || regions.error) return <ErrorState error={connection.error ?? regions.error} onRetry={() => { void connection.refetch(); void regions.refetch() }} />
  if (connection.isPending || regions.isPending) return <RouteSkeleton />
  const current = connection.data
  if (current?.kind === 'byo' && current.status === 'pending' && current.quickCreateUrl) return <ConnectAws connection={current} />
  return <ChooseSending regions={regions.data} />
}

export function AdminSetupRequired() {
  const client = useQueryClient()
  const environment = useSession()?.environment ?? 'live'
  const [checking, setChecking] = useState(false)
  async function check() { setChecking(true); try { await client.refetchQueries({ queryKey: ['identity', environment], exact: true }) } finally { setChecking(false) } }
  return <div className="stack onboarding onboarding--narrow">
    <PageHeader title="Sending isn’t set up yet" />
    <p className="muted onboarding-lead">An admin needs to finish setup for this workspace before you can use it.</p>
    <div><Button loading={checking} onClick={() => void check()}>Check again</Button></div>
  </div>
}

function connectionError(error: unknown) {
  if (code(error) === 'AWS_NOT_CONFIGURED') return 'Hosted mail isn’t available on this installation.'
  if (code(error) === 'CONNECTION_EXISTS') return 'Another setup is already started. Reload to continue it.'
  return message(error)
}

function ChooseSending({ regions }: { regions: { shared: string[]; byo: string[] } }) {
  const [sharedRegion, setSharedRegion] = useState(regions.shared[0] ?? '')
  const [byoRegion, setByoRegion] = useState(regions.byo[0] ?? '')
  const shared = useConnectionMutation((region: string) => connectionApi.create({ kind: 'shared', region }))
  const byo = useConnectionMutation((region: string) => connectionApi.create({ kind: 'byo', region }))
  const busy = shared.isPending || byo.isPending
  return <div className="stack onboarding">
    <PageHeader title="How do you want to send?" />
    <p className="muted onboarding-lead">Choose where your email is sent from. You can change this later in Settings.</p>
    <div className="onboarding-options">
      <section className="onboarding-option" aria-labelledby="onboarding-shared">
        <h2 id="onboarding-shared">Hosted mail</h2>
        <p className="muted">Send through OpenSend. Nothing to set up in AWS.</p>
        <p className="onboarding-price">$0.11 per 1,000 emails</p>
        {regions.shared.length > 1 && <Field label="Region" htmlFor="onboarding-shared-region"><Select id="onboarding-shared-region" value={sharedRegion} onValueChange={setSharedRegion} options={regions.shared.map(region => ({ value: region, label: region }))} disabled={busy} /></Field>}
        {shared.error ? <Alert tone="danger">{connectionError(shared.error)}</Alert> : null}
        <Button variant="primary" loading={shared.isPending} disabled={busy} onClick={() => shared.mutate(sharedRegion)}>Use Hosted mail</Button>
      </section>
      <section className="onboarding-option" aria-labelledby="onboarding-byo">
        <h2 id="onboarding-byo">Bring your own AWS</h2>
        <p className="muted">Send through your own AWS account. Takes a few minutes in the AWS console.</p>
        <p className="onboarding-price">You pay AWS directly</p>
        {regions.byo.length > 1 && <Field label="Region" htmlFor="onboarding-byo-region"><Select id="onboarding-byo-region" value={byoRegion} onValueChange={setByoRegion} options={regions.byo.map(region => ({ value: region, label: region }))} disabled={busy} /></Field>}
        {byo.error ? <Alert tone="danger">{connectionError(byo.error)}</Alert> : null}
        <Button loading={byo.isPending} disabled={busy} onClick={() => byo.mutate(byoRegion)}>Connect AWS</Button>
      </section>
    </div>
  </div>
}

function verifyError(error: unknown, region: string) {
  switch (code(error)) {
    case 'AWS_ACCESS_DENIED': return `OpenSend couldn’t use the role in that account yet. Check the stack shows CREATE_COMPLETE in ${region}, in this account, then try again.`
    case 'EXTERNAL_ID_REQUIRED': return 'The role doesn’t require this setup’s external ID. Delete the stack in AWS and create it again from the link above.'
    case 'AWS_ACCOUNT_IN_USE': return 'This AWS account is already connected to another workspace.'
    case 'AWS_ACCOUNT_MISMATCH': return 'This setup is tied to a different AWS account. Start over to use this one.'
    default: return message(error)
  }
}

function ConnectAws({ connection }: { connection: ProviderConnection }) {
  const [account, setAccount] = useState('')
  const [accountError, setAccountError] = useState('')
  const verify = useConnectionMutation((id: string) => retrying(() => connectionApi.verify(id)))
  async function submit(event: FormEvent) {
    event.preventDefault()
    const id = account.replace(/[\s-]/g, '')
    if (!/^\d{12}$/.test(id)) { setAccountError('Enter the 12-digit AWS account ID.'); return }
    setAccountError('')
    try { await verify.mutateAsync(id) } catch { /* Shown inline. */ }
  }
  return <div className="stack onboarding onboarding--narrow">
    <PageHeader title="Connect your AWS account" actions={!verify.isPending && <StartOver />} />
    <p className="muted onboarding-lead">OpenSend sends through a role in your account, in {connection.region}. AWS bills you directly.</p>
    <ol className="onboarding-steps">
      <li>
        <h2>1. Open CloudFormation</h2>
        <p className="muted">Sign in to the AWS account you want to send from. The stack opens with everything filled in.</p>
        <div><a className="ui-button ui-button--secondary" href={connection.quickCreateUrl!} target="_blank" rel="noopener noreferrer">Open AWS CloudFormation <ArrowUpRight size={16} aria-hidden /></a></div>
      </li>
      <li>
        <h2>2. Create the stack</h2>
        <p className="muted">Review the stack, tick the IAM acknowledgement at the bottom, then choose Create stack. Wait for CREATE_COMPLETE, usually under a minute.</p>
      </li>
      <li>
        <h2>3. Verify</h2>
        <form className="stack" onSubmit={submit} noValidate>
          <Field label="AWS account ID" htmlFor="onboarding-aws-account" error={accountError} hint="12 digits, in the account menu at the top right of the AWS console.">
            <Input id="onboarding-aws-account" className="onboarding-account" inputMode="numeric" autoComplete="off" value={account} onChange={event => setAccount(event.target.value)} placeholder="123456789012" maxLength={14} disabled={verify.isPending} />
          </Field>
          {verify.error ? <Alert tone="danger">{verifyError(verify.error, connection.region)}</Alert> : null}
          {verify.isPending && <p className="muted" role="status">Checking the role and setting up feedback in your account. This can take a minute.</p>}
          <div><Button type="submit" variant="primary" loading={verify.isPending}>Verify connection</Button></div>
        </form>
      </li>
    </ol>
  </div>
}

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

// The step after choosing how to send: add one domain, then records verify in the background.
export function DomainOnboarding({ domainId }: { domainId: string }) {
  const identity = useSession()?.identity
  const navigate = useNavigate()
  const workspaceId = identity?.workspaceId ?? ''
  const finish = () => { setDomainStep(workspaceId, null); navigate('/', { replace: true }) }
  return domainId ? <DomainSetup domainId={domainId} onFinish={finish} onMissing={() => setDomainStep(workspaceId, '')} /> : <AddDomain region={identity?.connection?.region ?? ''} onAdded={id => setDomainStep(workspaceId, id)} onFinish={finish} />
}

function AddDomain({ region, onAdded, onFinish }: { region: string; onAdded: (id: string) => void; onFinish: () => void }) {
  const api = useApi()
  const client = useQueryClient()
  const create = useApiMutation((api, name: string) => api.domains.create({ regionId: region, name }), undefined, true)
  const [name, setName] = useState('')
  const [invalid, setInvalid] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = name.trim().toLowerCase()
    if (!domainPattern.test(value)) { setInvalid('Enter a domain like acme.com, without https:// or a path.'); return }
    setInvalid('')
    try {
      const domain = await create.mutateAsync(value)
      client.setQueryData(['opensend', api.mode, api.environment, 'domain', domain.id], domain)
      onAdded(domain.id)
    } catch { /* Shown inline. */ }
  }
  return <div className="stack onboarding onboarding--narrow">
    <PageHeader title="Add your domain" actions={<Button variant="ghost" disabled={create.isPending} onClick={onFinish}>Continue to dashboard</Button>} />
    <p className="muted onboarding-lead">Send from your own domain. Next you’ll add a few DNS records, and OpenSend verifies them on its own.</p>
    <form className="onboarding-domain-form" onSubmit={submit} noValidate>
      <Field label="Domain" htmlFor="onboarding-domain" error={invalid || (create.error ? message(create.error) : undefined)}>
        <Input id="onboarding-domain" autoFocus autoComplete="off" spellCheck={false} value={name} onChange={event => setName(event.target.value)} placeholder="acme.com" disabled={create.isPending} />
      </Field>
      <Button type="submit" variant="primary" loading={create.isPending}>Add domain</Button>
    </form>
  </div>
}

function DomainSetup({ domainId, onFinish, onMissing }: { domainId: string; onFinish: () => void; onMissing: () => void }) {
  const domain = useDomain(domainId)
  const verified = domain.data?.status === 'verified'
  const missing = domain.error instanceof ApiError && domain.error.status === 404
  useEffect(() => { if (missing) onMissing() }, [missing]) // eslint-disable-line react-hooks/exhaustive-deps
  // Verified: show it, then carry on to the dashboard.
  useEffect(() => { if (!verified) return; const timer = setTimeout(onFinish, 2500); return () => clearTimeout(timer) }, [verified]) // eslint-disable-line react-hooks/exhaustive-deps
  if (domain.isPending || missing) return <RouteSkeleton />
  if (domain.error) return <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
  const current = domain.data
  const state = domainState(current)
  return <div className="stack onboarding onboarding--wide">
    <PageHeader title={<span className="onboarding-domain-title">{current.name}<StatusBadge status={state.status} tone={state.tone} /></span>} actions={<Button variant={verified ? 'primary' : 'secondary'} onClick={onFinish}>Continue to dashboard</Button>} />
    {verified ? <Alert tone="success" title="Domain verified">You can send from {current.name}. Opening your dashboard…</Alert>
      : current.status === 'issue' ? <Alert tone="danger">Verification stopped. Check the records below, then use Check now on the domain’s page in Domains.</Alert>
      : <p className="muted onboarding-lead" role="status">Checking automatically. Continue whenever you like; {current.name} keeps verifying in the background.</p>}
    <DomainRecords domain={current} />
  </div>
}
