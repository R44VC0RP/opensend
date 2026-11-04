import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ArrowUpRight, Check, Cloud, Send } from 'lucide-react'
import { Alert, Button, ConfirmDialog, ErrorState, Field, Input, SectionHeader } from '../../components/ui'
import { CopyAction, LiveStatus } from '../../components/motion'
import { BootLoader } from '../../components/BootLoader'
import { ThemeToggle } from '../../components/ThemeToggle'
import { WorkspaceSwitcher } from '../../components/WorkspaceSwitcher'
import { useApi, useApiMutation, useApiQuery, useSession } from '../../data/context'
import { connectionApi, retryableConnectionErrors, useConnectionCache } from '../../data/connections'
import { agentStep, setDomainStep, type OnboardingStage } from '../../data/onboarding'
import { DomainRecords, useDomain } from '../settings/domain-records'
import { AgentPrompt, McpSetup, agentPrompt, usePublicOrigin } from '../developer/agent-setup'
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

type View = 'loading' | 'choose' | 'domain' | 'records' | 'agent' | 'admin' | 'error'
const viewRank: Record<View, number> = { loading: 0, admin: 0, error: 0, choose: 1, domain: 2, records: 3, agent: 4 }
const viewStep: Partial<Record<View, number>> = { choose: 1, domain: 2, records: 2, agent: 3 }
const rise = (index: number) => ({ '--i': index }) as CSSProperties

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
  const current = connection.data
  const pendingAws = sending && current?.kind === 'byo' && current.status === 'pending' ? current : null
  let view: View, content: ReactNode
  if (stage.step === 'setup-required') { view = 'admin'; content = <AdminSetupRequired /> }
  else if (stage.step === 'agent') { view = 'agent'; content = <AgentSetup domainId={stage.domainId} onFinish={() => setDomainStep(workspaceId, null)} /> }
  else if (stage.step === 'domain' && stage.domainId) { view = 'records'; content = <DomainSetup domainId={stage.domainId} onContinue={() => setDomainStep(workspaceId, agentStep(stage.domainId))} onMissing={() => setDomainStep(workspaceId, '')} /> }
  else if (sending && !pendingAws && !picked && connection.error) { view = 'error'; content = <ErrorState error={connection.error} onRetry={() => void connection.refetch()} /> }
  else if (sending && !pendingAws && !picked && connection.isPending) { view = 'loading'; content = <BootLoader inline /> }
  else if (sending && !pendingAws && !picked) { view = 'choose'; content = <ChooseSending onChoose={choose} error={shared.error ?? byo.error} /> }
  else {
    const aws = pendingAws || (sending && picked === 'byo')
    view = 'domain'
    content = <AddDomain draft={draft} onDraftChange={setDraft} queued={queued} onQueuedChange={setQueued}
      ready={stage.step === 'domain'} region={identity?.connection?.region ?? ''}
      onAdded={id => setDomainStep(workspaceId, id)} onFinish={() => setDomainStep(workspaceId, null)}
      aws={aws ? <ConnectAws connection={pendingAws} onReset={reset} /> : null} />
  }
  // Steps slide in the direction of travel; the first paint and the loader stay still.
  const [frame, setFrame] = useState<{ view: View; previous: View | null }>({ view, previous: null })
  if (frame.view !== view) setFrame({ view, previous: frame.view })
  const previous = frame.view === view ? frame.previous : frame.view
  const motion = previous === null || view === 'loading' ? undefined : previous === 'loading' || !viewStep[view] ? 'fade' : viewRank[view] >= viewRank[previous] ? 'forward' : 'back'
  useEffect(() => { if (previous !== null) document.getElementById('main-content')?.scrollTo({ top: 0 }) }, [view]) // eslint-disable-line react-hooks/exhaustive-deps
  const step = viewStep[view]
  return <>
    {step && <StepIndicator current={step} />}
    <div key={view} className="onboarding-step" data-motion={motion}>{content}</div>
  </>
}

const steps = ['Choose', 'Add domain', 'Connect your agent']
// Persists across steps, so its marks and connecting lines animate as setup moves forward.
function StepIndicator({ current }: { current: number }) {
  return <ol className="onboarding-progress" aria-label="Setup progress">
    {steps.map((label, index) => {
      const state = index + 1 < current ? 'done' : index + 1 === current ? 'current' : 'upcoming'
      return <li key={label} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
        {index > 0 && <span className="onboarding-progress-line" aria-hidden="true" />}
        <span className="onboarding-progress-mark" aria-hidden="true"><span>{index + 1}</span><Check size={13} strokeWidth={2.75} /></span>
        <span className="onboarding-progress-label">{label}{state === 'done' && <span className="sr-only"> (done)</span>}</span>
      </li>
    })}
    <li className="onboarding-progress-caption" aria-hidden="true">Step {current} of {steps.length} · {steps[current - 1]}</li>
  </ol>
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
  return <div className="onboarding onboarding--narrow onboarding--center">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">Sending isn’t set up yet</h1>
      <p className="onboarding-lead">An admin needs to finish setup for this workspace before you can use it.</p>
    </div>
    <div className="onb-rise" style={rise(1)}><Button loading={checking} onClick={() => void check()}>Check again</Button></div>
  </div>
}

function connectionError(error: unknown) {
  if (code(error) === 'AWS_NOT_CONFIGURED') return 'Hosted mail isn’t available on this installation.'
  if (code(error) === 'BYO_NOT_CONFIGURED') return 'Bring your own AWS isn’t available on this installation.'
  if (code(error) === 'CONNECTION_EXISTS') return 'Another setup is already started. Reload to continue it.'
  return message(error)
}

function ChooseSending({ onChoose, error }: { onChoose: (kind: ConnectionKind) => void; error: unknown }) {
  return <div className="onboarding onboarding--choice">
    <div className="onboarding-intro onboarding-intro--center onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">Where should your email send from?</h1>
      <p className="onboarding-lead">Either way, it goes out from your own domain.</p>
    </div>
    <div className="onboarding-options">
      <button type="button" className="onboarding-option onb-rise" style={rise(1)} onClick={() => onChoose('shared')}>
        <span className="onboarding-option-icon" aria-hidden="true"><Send size={18} /></span>
        <span className="onboarding-option-title">Hosted mail</span>
        <span className="onboarding-option-body">Send through OpenSend. Nothing to set up.</span>
        <span className="onboarding-option-foot"><span className="onboarding-option-price">$0.11 per 1,000 emails</span><span className="onboarding-option-go">Continue<ArrowRight size={16} aria-hidden /></span></span>
      </button>
      <button type="button" className="onboarding-option onb-rise" style={rise(2)} onClick={() => onChoose('byo')}>
        <span className="onboarding-option-icon" aria-hidden="true"><Cloud size={18} /></span>
        <span className="onboarding-option-title">Your AWS account</span>
        <span className="onboarding-option-body">Use your own AWS account. Setup opens AWS in a new tab.</span>
        <span className="onboarding-option-foot"><span className="onboarding-option-price">You pay AWS directly</span><span className="onboarding-option-go">Open AWS<ArrowUpRight size={16} aria-hidden /></span></span>
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
      <p id="onboarding-aws-title" role="status"><span className="onboarding-aws-dot" aria-hidden="true" /><strong>Connect your AWS account</strong><span className="muted">{verify.isPending ? 'Checking the role…' : 'Waiting for the stack in AWS'}</span></p>
      <div className="cluster">
        {link ? <a className="ui-button ui-button--ghost ui-button--sm" href={link} target="_blank" rel="noopener noreferrer">Open AWS again <ArrowUpRight size={16} aria-hidden /></a> : <Button variant="ghost" size="sm" disabled>Open AWS again <ArrowUpRight size={16} aria-hidden /></Button>}
        {connection && !verify.isPending && <StartOver onReset={onReset} />}
      </div>
    </div>
    <form className="onboarding-inline-form" onSubmit={submit} noValidate>
      <Field label="AWS account ID" htmlFor="onboarding-aws-account" error={accountError || (verify.error ? verifyError(verify.error, connection?.region ?? 'your region') : undefined)} hint={accountError || verify.error ? undefined : 'Once the stack shows CREATE_COMPLETE. It’s the 12 digits in the AWS console’s account menu.'}>
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
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">Add your domain</h1>
      <p className="onboarding-lead">Your email will come from it, like <code className="onboarding-preview">hello@{domainPattern.test(value) ? value : 'acme.com'}</code></p>
    </div>
    {aws && <div className="onb-rise" style={rise(1)}>{aws}</div>}
    <form className="onboarding-inline-form onb-rise" style={rise(2)} onSubmit={event => { event.preventDefault(); void add() }} noValidate>
      <Field label="Domain" htmlFor="onboarding-domain" error={invalid || (create.error ? message(create.error) : undefined)} hint={queued && !invalid ? `${value} is added as soon as your AWS account is connected.` : undefined}>
        <Input id="onboarding-domain" autoFocus={!aws} autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft} onChange={event => { onDraftChange(event.target.value); onQueuedChange(false) }} placeholder="acme.com" disabled={create.isPending} />
      </Field>
      <Button type="submit" variant="primary" loading={create.isPending}>Add domain{!create.isPending && <ArrowRight size={16} aria-hidden />}</Button>
    </form>
    {ready && <div className="onb-rise" style={rise(3)}><button type="button" className="onboarding-skip" disabled={create.isPending} onClick={onFinish}>Skip for now</button></div>}
  </div>
}

function DomainSetup({ domainId, onContinue, onMissing }: { domainId: string; onContinue: () => void; onMissing: () => void }) {
  const domain = useDomain(domainId)
  const verified = domain.data?.status === 'verified'
  const missing = domain.error instanceof ApiError && domain.error.status === 404
  useEffect(() => { if (missing) onMissing() }, [missing]) // eslint-disable-line react-hooks/exhaustive-deps
  // Verified: show it, then carry on to the agent setup.
  useEffect(() => { if (!verified) return; const timer = setTimeout(onContinue, 2500); return () => clearTimeout(timer) }, [verified]) // eslint-disable-line react-hooks/exhaustive-deps
  if (domain.isPending || missing) return <BootLoader inline />
  if (domain.error) return <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
  const current = domain.data
  return <div className="onboarding onboarding--wide">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title onboarding-domain-title"><span>{current.name}</span><LiveStatus state={verified ? 'verified' : current.status === 'issue' ? 'failed' : 'pending'} /></h1>
      {current.status === 'issue' ? <Alert tone="danger">Verification stopped. Check the records below, then use Check now on the domain’s page in Domains.</Alert>
        : !verified && <p className="onboarding-lead" role="status">Add these records at your DNS provider. We’ll check automatically, and you can continue while it verifies.</p>}
      {verified && <div className="onboarding-verified" role="status">
        <span className="onboarding-verified-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
        <div><strong>{current.name} is verified</strong><p>You can send email now. Taking you to the last step…</p></div>
        <span className="onboarding-verified-timer" aria-hidden="true" />
      </div>}
    </div>
    <div className="onb-rise" style={rise(1)}><DomainRecords domain={current} guided /></div>
    <div className="onboarding-actions">
      <p className="muted">{verified ? 'All set.' : 'Records can take a few minutes to show up.'}</p>
      <Button variant="primary" onClick={onContinue}>Continue<ArrowRight size={16} aria-hidden /></Button>
    </div>
  </div>
}

// Last step: everything a coding agent needs. Domain verification keeps running in the background.
function AgentSetup({ domainId, onFinish }: { domainId: string; onFinish: () => void }) {
  const identity = useSession()?.identity
  const origin = usePublicOrigin()
  const domain = useDomain(domainId)
  const create = useApiMutation((api, _: void) => api.keys.create({ name: 'Coding agent', permission: 'manage', domains: [] }))
  const [secret, setSecret] = useState<string | null>(null)
  async function createKey() {
    try { setSecret((await create.mutateAsync(undefined)).secret) } catch { /* Shown inline. */ }
  }
  // A removed domain still leaves a useful prompt without domain details.
  const missing = domain.error instanceof ApiError && domain.error.status === 404
  if (domain.isPending) return <BootLoader inline />
  if (domain.error && !missing) return <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
  const prompt = agentPrompt({ origin, domain: domain.data ?? null, email: identity?.email ?? null, multiTenant: identity?.multiTenant === true })
  return <div className="onboarding onboarding--agent">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">Connect your agent</h1>
      <p className="onboarding-lead">Give your coding agent these three things. You can find them again under Developer.</p>
    </div>
    <div className="onboarding-agent-steps">
      <section className="section stack developer-section onb-rise" style={rise(1)} aria-label="API key">
        <SectionHeader title="API key" />
        {secret ? <div className="onboarding-reveal stack">
          <div className="developer-url"><code>{secret}</code><CopyAction value={secret} label="Copy API key" size="sm" /></div>
          <p className="muted developer-copy" role="status">Shown once. Store it as <code>OPENSEND_API_KEY</code> in your project’s environment.</p>
        </div> : <>
          <p className="muted developer-copy">Full access to send and manage this workspace, for every domain.</p>
          <div><Button loading={create.isPending} onClick={() => void createKey()}>Create API key</Button></div>
          {create.error ? <Alert tone="danger">{message(create.error)}</Alert> : null}
        </>}
      </section>
      <div className="onb-rise" style={rise(2)}><AgentPrompt prompt={prompt} /></div>
      <div className="onb-rise" style={rise(3)}><McpSetup /></div>
    </div>
    <div className="onboarding-actions">
      <p className="muted">{domain.data?.status === 'verified' ? 'Your domain is verified and ready to send.' : 'Your domain keeps verifying in the background.'}</p>
      <Button variant="primary" onClick={onFinish}>Go to dashboard<ArrowRight size={16} aria-hidden /></Button>
    </div>
  </div>
}
