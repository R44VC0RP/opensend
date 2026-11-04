import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { Alert, Button, ConfirmDialog, ErrorState, Field, Input, PageHeader, StatusBadge } from '../../components/ui'
import { BootLoader } from '../../components/BootLoader'
import { ThemeToggle } from '../../components/ThemeToggle'
import { WorkspaceSwitcher } from '../../components/WorkspaceSwitcher'
import { useApi, useApiMutation, useApiQuery, useSession } from '../../data/context'
import { connectionApi, retryableConnectionErrors, useConnectionCache } from '../../data/connections'
import { setDomainStep, type OnboardingStage } from '../../data/onboarding'
import { DomainRecords, domainState, useDomain } from '../settings/domain-records'
import { ApiError, type ConnectionKind, type ProviderConnection } from '../../data/types'
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

// Full-page shell for /onboarding: no dashboard navigation or dashboard data.
export function OnboardingPage({ stage }: { stage: NonNullable<OnboardingStage> }) {
  const session = useSession()
  useEffect(() => { document.title = 'Get started · opensend' }, [])
  return <div className="onboarding-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="onboarding-header">
      <span className="wordmark"><span className="wordmark-square" aria-hidden="true" />opensend</span>
      <div className="onboarding-header-actions">
        <div className="onboarding-workspace"><WorkspaceSwitcher /></div>
        <ThemeToggle />
        <Button variant="ghost" onClick={() => void session?.logout()}>Sign out</Button>
      </div>
    </header>
    <main id="main-content" className="page-surface onboarding-surface" tabIndex={-1}>
      {session?.notice && <div className="page-notice onboarding-notice"><Alert tone="danger" title="Invitation not accepted" onDismiss={session.dismissNotice}>{session.notice}</Alert></div>}
      <OnboardingSteps stage={stage} />
    </main>
  </div>
}

// One component owns every step, so the domain form keeps its input from the choice through a ready connection.
function OnboardingSteps({ stage }: { stage: NonNullable<OnboardingStage> }) {
  const identity = useSession()?.identity
  const workspaceId = identity?.workspaceId ?? ''
  const sending = stage.step === 'sending'
  const connection = useApiQuery(['connection'], (_api, signal) => connectionApi.get(signal), { enabled: sending })
  const sync = useConnectionCache()
  // The chosen option shows the domain form at once, while the connection request finishes.
  const [picked, setPicked] = useState<ConnectionKind | null>(null)
  const [draft, setDraft] = useState('')
  const [queued, setQueued] = useState(false)
  const shared = useConnectionMutation(() => connectionApi.create({ kind: 'shared' }))
  const byo = useConnectionMutation(() => connectionApi.create({ kind: 'byo' }))
  // Setup finished elsewhere (another tab or admin): lift the gate.
  useEffect(() => { if (connection.data?.status === 'ready') sync(connection.data) }, [connection.data]) // eslint-disable-line react-hooks/exhaustive-deps
  function choose(kind: ConnectionKind) {
    shared.reset(); byo.reset()
    setPicked(kind)
    if (kind === 'shared') { shared.mutate(undefined, { onError: () => setPicked(null) }); return }
    // Open the tab inside the click so it isn't blocked; it gets the CloudFormation link once the setup exists.
    const tab = window.open('about:blank', '_blank')
    byo.mutate(undefined, {
      onSuccess: created => { if (tab && created?.quickCreateUrl) { tab.opener = null; tab.location.href = created.quickCreateUrl } else tab?.close() },
      onError: () => { tab?.close(); setPicked(null) },
    })
  }
  const reset = () => { setPicked(null); setQueued(false) }
  if (stage.step === 'setup-required') return <AdminSetupRequired />
  if (stage.step === 'domain' && stage.domainId) return <DomainSetup domainId={stage.domainId} onFinish={() => setDomainStep(workspaceId, null)} onMissing={() => setDomainStep(workspaceId, '')} />
  const current = connection.data
  const pendingAws = sending && current?.kind === 'byo' && current.status === 'pending' ? current : null
  if (sending && !pendingAws && !picked) {
    if (connection.error) return <ErrorState error={connection.error} onRetry={() => void connection.refetch()} />
    if (connection.isPending) return <BootLoader inline />
    return <ChooseSending onChoose={choose} error={shared.error ?? byo.error} />
  }
  const aws = pendingAws || (sending && picked === 'byo')
  return <AddDomain draft={draft} onDraftChange={setDraft} queued={queued} onQueuedChange={setQueued}
    ready={stage.step === 'domain'} region={identity?.connection?.region ?? ''}
    onAdded={id => setDomainStep(workspaceId, id)} onFinish={() => setDomainStep(workspaceId, null)}
    aws={aws ? <ConnectAws connection={pendingAws} onReset={reset} /> : null} />
}

function StartOver({ onReset }: { onReset: () => void }) {
  const [open, setOpen] = useState(false)
  const remove = useConnectionMutation(async () => { await connectionApi.remove(); return null })
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Start over</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} title="Start over?" description="The current CloudFormation link stops working. If you already created the stack, delete it in AWS." confirmLabel="Start over" pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(undefined); onReset() }} />
  </>
}

function AdminSetupRequired() {
  const client = useQueryClient()
  const [checking, setChecking] = useState(false)
  async function check() { setChecking(true); try { await client.refetchQueries({ queryKey: ['identity'], exact: true }) } finally { setChecking(false) } }
  return <div className="stack onboarding onboarding--narrow">
    <PageHeader title="Sending isn’t set up yet" />
    <p className="muted onboarding-lead">An admin needs to finish setup for this workspace before you can use it.</p>
    <div><Button loading={checking} onClick={() => void check()}>Check again</Button></div>
  </div>
}

function connectionError(error: unknown) {
  if (code(error) === 'AWS_NOT_CONFIGURED') return 'Hosted mail isn’t available on this installation.'
  if (code(error) === 'BYO_NOT_CONFIGURED') return 'Bring your own AWS isn’t available on this installation.'
  if (code(error) === 'CONNECTION_EXISTS') return 'Another setup is already started. Reload to continue it.'
  return message(error)
}

function ChooseSending({ onChoose, error }: { onChoose: (kind: ConnectionKind) => void; error: unknown }) {
  return <div className="onboarding-choice">
    <h1 className="onboarding-choice-title">How do you want to send?</h1>
    <div className="onboarding-split">
      <button type="button" className="onboarding-half" onClick={() => onChoose('shared')}>
        <span className="onboarding-half-title">Hosted mail<ArrowRight size={16} aria-hidden /></span>
        <span className="onboarding-half-price">$0.11 per 1,000 emails</span>
        <span className="muted">Send through OpenSend. Nothing to set up.</span>
      </button>
      <button type="button" className="onboarding-half" onClick={() => onChoose('byo')}>
        <span className="onboarding-half-title">Bring your own AWS<ArrowRight size={16} aria-hidden /></span>
        <span className="onboarding-half-price">You pay AWS directly</span>
        <span className="muted">Send from your own AWS account.</span>
      </button>
    </div>
    {error ? <Alert tone="danger">{connectionError(error)}</Alert> : null}
  </div>
}

function verifyError(error: unknown, region: string) {
  switch (code(error)) {
    case 'AWS_ACCESS_DENIED': return `OpenSend couldn’t use the role in that account yet. Check the stack shows CREATE_COMPLETE in ${region}, in this account, then try again.`
    case 'EXTERNAL_ID_REQUIRED': return 'The role doesn’t require this setup’s external ID. Delete the stack in AWS and open it again.'
    case 'AWS_ACCOUNT_IN_USE': return 'This AWS account is already connected to another workspace.'
    case 'AWS_ACCOUNT_MISMATCH': return 'This setup is tied to a different AWS account. Start over to use this one.'
    default: return message(error)
  }
}

// Compact status above the domain form while a bring-your-own setup waits for its CloudFormation stack.
function ConnectAws({ connection, onReset }: { connection: ProviderConnection | null; onReset: () => void }) {
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
  const link = connection?.quickCreateUrl
  return <section className="onboarding-aws" aria-labelledby="onboarding-aws-title">
    <div className="onboarding-aws-status">
      <p id="onboarding-aws-title" role="status"><span className="onboarding-aws-dot" aria-hidden="true" /><strong>Connect your AWS account</strong><span className="muted"> — {verify.isPending ? 'checking the role' : 'waiting for the stack'}</span></p>
      <div className="cluster">
        {link ? <a className="ui-button ui-button--ghost ui-button--sm" href={link} target="_blank" rel="noopener noreferrer">Open AWS again <ArrowUpRight size={16} aria-hidden /></a> : <Button variant="ghost" size="sm" disabled>Open AWS again <ArrowUpRight size={16} aria-hidden /></Button>}
        {connection && !verify.isPending && <StartOver onReset={onReset} />}
      </div>
    </div>
    <form className="onboarding-inline-form" onSubmit={submit} noValidate>
      <Field label="AWS account ID" htmlFor="onboarding-aws-account" error={accountError || (verify.error ? verifyError(verify.error, connection?.region ?? 'your region') : undefined)} hint={accountError || verify.error ? undefined : 'After the stack shows CREATE_COMPLETE. 12 digits, in the AWS console’s account menu.'}>
        <Input id="onboarding-aws-account" inputMode="numeric" autoComplete="off" value={account} onChange={event => setAccount(event.target.value)} placeholder="123456789012" maxLength={14} disabled={verify.isPending} />
      </Field>
      <Button type="submit" loading={verify.isPending} disabled={!connection}>Verify</Button>
    </form>
  </section>
}

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

type AddDomainProps = { draft: string; onDraftChange: (value: string) => void; queued: boolean; onQueuedChange: (queued: boolean) => void; ready: boolean; region: string; onAdded: (id: string) => void; onFinish: () => void; aws: ReactNode }
// Before the connection is ready, a valid domain waits and is added as soon as it is.
function AddDomain({ draft, onDraftChange, queued, onQueuedChange, ready, region, onAdded, onFinish, aws }: AddDomainProps) {
  const api = useApi()
  const client = useQueryClient()
  const create = useApiMutation((api, name: string) => api.domains.create({ regionId: region, name }), undefined, true)
  const [invalid, setInvalid] = useState('')
  const value = draft.trim().toLowerCase()
  async function add() {
    if (!domainPattern.test(value)) { setInvalid('Enter a domain like acme.com, without https:// or a path.'); return }
    setInvalid('')
    if (!ready) { onQueuedChange(true); return }
    try {
      const domain = await create.mutateAsync(value)
      client.setQueryData(['opensend', api.mode, 'domain', domain.id], domain)
      onAdded(domain.id)
    } catch { /* Shown inline. */ }
  }
  useEffect(() => { if (ready && queued) { onQueuedChange(false); void add() } }, [ready, queued]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="stack onboarding onboarding--narrow">
    <PageHeader title="Add your domain" actions={ready && <Button variant="ghost" disabled={create.isPending} onClick={onFinish}>Continue to dashboard</Button>} />
    {aws}
    <p className="muted onboarding-lead">Send from your own domain. Next you’ll add a few DNS records, and OpenSend verifies them on its own.</p>
    <form className="onboarding-inline-form" onSubmit={event => { event.preventDefault(); void add() }} noValidate>
      <Field label="Domain" htmlFor="onboarding-domain" error={invalid || (create.error ? message(create.error) : undefined)} hint={queued && !invalid ? `${value} is added as soon as your AWS account is connected.` : undefined}>
        <Input id="onboarding-domain" autoFocus={!aws} autoComplete="off" spellCheck={false} value={draft} onChange={event => { onDraftChange(event.target.value); onQueuedChange(false) }} placeholder="acme.com" disabled={create.isPending} />
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
  if (domain.isPending || missing) return <BootLoader inline />
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
