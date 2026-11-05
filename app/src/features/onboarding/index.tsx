import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, Send, X } from 'lucide-react'
import { Alert, Button, ErrorState, Field, Input, SectionHeader, useToast } from '../../components/ui'
import { CopyAction, LiveStatus } from '../../components/motion'
import { BootLoader } from '../../components/BootLoader'
import { ThemeToggle } from '../../components/ThemeToggle'
import { WorkspaceSwitcher } from '../../components/WorkspaceSwitcher'
import { useApi, useApiMutation, useApiQuery, useSession } from '../../data/context'
import { connectionApi, retryableConnectionErrors, useConnectionCache } from '../../data/connections'
import { agentStep, setDomainStep, type OnboardingStage } from '../../data/onboarding'
import { DomainRecords, useDnsSetup, useDomain } from '../settings/domain-records'
import { AgentPrompt, McpSetup, agentPrompt, usePublicOrigin } from '../developer/agent-setup'
import { ApiError, type ConnectionKind, type ConnectionState, type ProviderConnection } from '../../data/types'
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
      if (connection?.state === 'ready' && workspaceId) setDomainStep(workspaceId, '')
      sync(connection)
      if (connection?.state !== 'ready') return
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

type View = 'loading' | 'choose' | 'connect' | 'domain' | 'imported' | 'records' | 'agent' | 'admin' | 'error'
const viewRank: Record<View, number> = { loading: 0, admin: 0, error: 0, choose: 1, connect: 2, domain: 3, imported: 3, records: 4, agent: 5 }
const hostedSteps = ['Choose', 'Add domain', 'Connect your agent']
const awsSteps = ['Choose', 'Connect AWS', 'Add domain', 'Connect your agent']
// The loader and a failed load sit in step 1, so the indicator is already in place when the choice appears.
function stepOf(view: View, aws: boolean, choosingDomain: boolean) {
  if (view === 'loading' && choosingDomain) return aws ? 3 : 2
  const steps: Partial<Record<View, number>> = { loading: 1, error: 1, choose: 1, connect: 2, domain: 2, imported: 2, records: 2, agent: 3 }
  const step = steps[view]
  return step && aws && step >= 2 && view !== 'connect' ? step + 1 : step
}
const rise = (index: number) => ({ '--i': index }) as CSSProperties
// Older APIs return no count; a list is accepted too.
function importedCount(connection: ProviderConnection | null | undefined) {
  const value = (connection as { importedDomains?: unknown } | null | undefined)?.importedDomains
  return typeof value === 'number' ? value : Array.isArray(value) ? value.length : 0
}
// Connected stays on screen this long before Add domain takes over.
const CONNECTED_HOLD_MS = 1400

// One component owns every step, so the domain form keeps its input from the choice through a ready connection.
function OnboardingSteps({ stage }: { stage: NonNullable<OnboardingStage> }) {
  const api = useApi()
  const client = useQueryClient()
  const toast = useToast()
  const identity = useSession()?.identity
  const workspaceId = identity?.workspaceId ?? ''
  const sending = stage.step === 'sending'
  const choosingDomain = stage.step === 'domain' && !stage.domainId
  const sync = useConnectionCache()
  // The chosen option shows its next step at once, while the connection request finishes.
  const [picked, setPicked] = useState<ConnectionKind | null>(null)
  // A connection being deleted (Back, or Hosted instead) is ignored until the delete lands.
  const [dropped, setDropped] = useState<string | null>(null)
  // BYO: connecting, then a short Connected moment, then Add domain.
  const [awsPhase, setAwsPhase] = useState<'idle' | 'connecting' | 'connected' | 'done'>('idle')
  // Imported domains can be skipped to add another one.
  const [addAnother, setAddAnother] = useState(false)
  const [draft, setDraft] = useState('')
  const [queued, setQueued] = useState(false)
  // Polls every 3 s while a BYO setup waits on AWS (only while the page is visible) and on focus.
  const connection = useQuery({
    queryKey: ['opensend', api.mode, 'connection'],
    queryFn: ({ signal }) => connectionApi.get(signal),
    enabled: sending || choosingDomain,
    refetchInterval: query => sending && picked !== 'shared' && query.state.data?.kind === 'byo' && query.state.data.state !== 'ready' ? 3000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: query => sending && query.state.data?.kind === 'byo' ? 'always' : false,
  })
  const shared = useConnectionMutation(() => connectionApi.create({ kind: 'shared' }))
  const byo = useConnectionMutation(() => connectionApi.create({ kind: 'byo' }))
  const current = connection.data && connection.data.id !== dropped ? connection.data : null
  // Ready from a poll (auto-verify), another tab or an admin: continue to Add domain.
  useEffect(() => {
    if (!sending || current?.state !== 'ready' || (picked === 'shared' && current.kind === 'byo')) return
    setDomainStep(workspaceId, '')
    sync(current)
  }, [current?.state, current?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  function choose(kind: ConnectionKind) {
    shared.reset(); byo.reset()
    setPicked(kind)
    if (kind === 'shared') shared.mutate(undefined, { onError: () => setPicked(null) })
    else byo.mutate(undefined, { onError: () => setPicked(null) })
  }
  // Deletes the pending BYO connection without waiting for it, so leaving is instant.
  function leaveAws(next: ConnectionKind | null) {
    const pending = current
    setDropped(pending?.id ?? null)
    setAwsPhase('idle')
    shared.reset(); byo.reset()
    setPicked(next)
    if (pending?.state === 'provisioning' || pending?.state === 'failed') toast('If you created the OpenSend stack in AWS, you can delete it there.', 'info')
    void client.cancelQueries({ queryKey: ['opensend', api.mode, 'connection'] })
    void (async () => {
      try { if (pending) await connectionApi.remove() }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) { toast(message(error), 'error'); setDropped(null); setPicked(pending ? 'byo' : null); return } }
      sync(null)
      if (next === 'shared') shared.mutate(undefined, { onError: () => setPicked(null) })
    })()
  }
  const flow: ConnectionKind | null = sending ? picked ?? current?.kind ?? null : identity?.connection?.kind ?? null
  const ready = stage.step !== 'sending' && stage.step !== 'setup-required'
  if (sending && flow === 'byo' && awsPhase === 'idle') setAwsPhase('connecting')
  if (sending && flow !== 'byo' && awsPhase === 'connecting') setAwsPhase('idle')
  if (awsPhase === 'connecting' && (ready || current?.state === 'ready')) setAwsPhase('connected')
  useEffect(() => {
    if (awsPhase !== 'connected') return
    const timer = setTimeout(() => setAwsPhase('done'), CONNECTED_HOLD_MS)
    return () => clearTimeout(timer)
  }, [awsPhase])
  const connectionState: ConnectionState | 'creating' = awsPhase === 'connected' ? 'ready' : current?.kind === 'byo' ? current.state : 'creating'
  const imported = importedCount(connection.data)
  const domainForm = () => <AddDomain draft={draft} onDraftChange={setDraft} queued={queued} onQueuedChange={setQueued}
    ready={stage.step === 'domain'} region={identity?.connection?.region ?? ''}
    onAdded={id => setDomainStep(workspaceId, id)} onFinish={() => setDomainStep(workspaceId, null)} />
  let view: View, content: ReactNode
  if (stage.step === 'setup-required') { view = 'admin'; content = <AdminSetupRequired /> }
  else if (stage.step === 'agent') { view = 'agent'; content = <AgentSetup domainId={stage.domainId} onFinish={() => setDomainStep(workspaceId, null)} /> }
  else if (stage.step === 'domain' && stage.domainId) { view = 'records'; content = <DomainSetup domainId={stage.domainId} onContinue={() => setDomainStep(workspaceId, agentStep(stage.domainId))} onMissing={() => setDomainStep(workspaceId, '')} /> }
  else if (awsPhase === 'connecting' || awsPhase === 'connected') {
    view = 'connect'
    content = <ConnectAwsStep state={connectionState} connection={current} onBack={() => leaveAws(null)} onHosted={() => leaveAws('shared')} />
  }
  else if (sending && !picked && connection.error) { view = 'error'; content = <ErrorState error={connection.error} onRetry={() => void connection.refetch()} /> }
  else if ((sending && !picked && connection.isPending) || (choosingDomain && flow === 'byo' && connection.isPending)) { view = 'loading'; content = <BootLoader inline /> }
  else if (sending && !flow) { view = 'choose'; content = <ChooseSending onChoose={choose} error={shared.error ?? byo.error} /> }
  else if (choosingDomain && flow === 'byo' && imported > 0 && !addAnother) {
    view = 'imported'
    content = <ImportedDomains count={imported} onContinue={id => setDomainStep(workspaceId, agentStep(id))} onAddAnother={() => setAddAnother(true)} fallback={domainForm()} />
  }
  else { view = 'domain'; content = domainForm() }
  // Steps slide in the direction of travel; the first paint and the loader stay still.
  const [frame, setFrame] = useState<{ view: View; previous: View | null }>({ view, previous: null })
  if (frame.view !== view) setFrame({ view, previous: frame.view })
  const previous = frame.view === view ? frame.previous : frame.view
  const motion = previous === null || view === 'loading' ? undefined : previous === 'loading' || view === 'error' || view === 'admin' ? 'fade' : viewRank[view] >= viewRank[previous] ? 'forward' : 'back'
  useEffect(() => { if (previous !== null) document.getElementById('main-content')?.scrollTo({ top: 0 }) }, [view]) // eslint-disable-line react-hooks/exhaustive-deps
  const aws = flow === 'byo'
  const step = stepOf(view, aws, choosingDomain)
  return <>
    {/* Keyed by flow: switching between 3 and 4 steps mounts a new indicator instead of moving the old one. */}
    {step && <StepIndicator key={aws ? 'aws' : 'hosted'} steps={aws ? awsSteps : hostedSteps} current={step} />}
    <div key={view} className="onboarding-step" data-motion={motion}>{content}</div>
  </>
}

// Persists across steps, so its marks and connecting lines animate as setup moves forward.
function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return <ol className="onboarding-progress" aria-label="Setup progress">
    {steps.map((label, index) => {
      const state = index + 1 < current ? 'done' : index + 1 === current ? 'current' : 'upcoming'
      return <li key={label} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
        {index > 0 && <span className="onboarding-progress-line" aria-hidden="true" />}
        <span className="onboarding-progress-mark" aria-hidden="true"><span>{index + 1}</span><Check size={13} strokeWidth={2.75} /></span>
        <span className="onboarding-progress-label" data-label={label}>{label}{state === 'done' && <span className="sr-only"> (done)</span>}</span>
      </li>
    })}
    <li className="onboarding-progress-caption" aria-hidden="true">Step {current} of {steps.length} · {steps[current - 1]}</li>
  </ol>
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
        <span className="onboarding-option-icon onboarding-option-icon--aws" aria-hidden="true"><AwsLogo /></span>
        <span className="onboarding-option-title">Your AWS account</span>
        <span className="onboarding-option-body">Send through SES in your own account. A short AWS setup connects it.</span>
        <span className="onboarding-option-foot"><span className="onboarding-option-price">You pay AWS directly</span><span className="onboarding-option-go">Continue<ArrowRight size={16} aria-hidden /></span></span>
      </button>
    </div>
    {error ? <Alert tone="danger">{connectionError(error)}</Alert> : null}
  </div>
}

// The AWS mark: the wordmark follows the text colour, the smile stays AWS orange in both themes.
function AwsLogo() {
  return <svg viewBox="0 0 24 24" width="26" height="26">
    <path fill="currentColor" d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167z" />
    <path fill="#FF9900" d="M21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607zM22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z" />
  </svg>
}

function verifyError(error: unknown, region: string) {
  switch (code(error)) {
    case 'AWS_ACCESS_DENIED': return `OpenSend can’t use the role yet. Check the stack shows CREATE_COMPLETE in ${region} in this account, then try again.`
    case 'EXTERNAL_ID_REQUIRED': return 'The role doesn’t require this setup’s external ID. Delete the stack in AWS and open it again.'
    case 'AWS_ACCOUNT_IN_USE': return 'This AWS account is already connected to another workspace.'
    case 'AWS_ACCOUNT_MISMATCH': return 'This setup is tied to a different AWS account. Start over to use this one.'
    default: return message(error)
  }
}

const connectStates: { key: ConnectionState | 'creating'; title: string; detail: string }[] = [
  { key: 'creating', title: 'Preparing…', detail: 'Getting your AWS link ready.' },
  { key: 'awaiting_role', title: 'Waiting for AWS…', detail: 'Create the stack in the AWS tab. This page updates on its own.' },
  { key: 'provisioning', title: 'Setting up…', detail: 'AWS confirmed the stack. Creating the sending resources in your account.' },
  { key: 'ready', title: 'Connected', detail: 'Your AWS account is ready. Taking you to the next step…' },
  { key: 'failed', title: 'Setup didn’t finish', detail: 'Check the stack in AWS, then try again or enter your account ID below.' },
]

// BYO step 2: one task. Open AWS, watch the live status, leave any time.
function ConnectAwsStep({ state, connection, onBack, onHosted }: { state: ConnectionState | 'creating'; connection: ProviderConnection | null; onBack: () => void; onHosted: () => void }) {
  const [trouble, setTrouble] = useState(false)
  const link = connection?.quickCreateUrl
  const connected = state === 'ready'
  const active = connectStates.find(item => item.key === state) ?? connectStates[0]
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <button type="button" className="onboarding-back" onClick={onBack} disabled={connected}><ArrowLeft size={14} aria-hidden />Back</button>
      <h1 className="onboarding-title">Connect your AWS account</h1>
      <p className="onboarding-lead">A CloudFormation stack gives OpenSend a role in your account. It takes about two minutes, and this page continues on its own.</p>
    </div>
    <div className="onboarding-connect-actions onb-rise" style={rise(1)} inert={connected}>
      {link ? <a className="ui-button ui-button--primary ui-button--md" href={link} target="_blank" rel="noopener noreferrer">Open AWS to create the stack<ArrowUpRight size={16} aria-hidden /></a>
        : <Button variant="primary" loading>Open AWS to create the stack<ArrowUpRight size={16} aria-hidden /></Button>}
      <Button variant="ghost" onClick={onHosted}>Use Hosted mail instead</Button>
    </div>
    {/* Every status is laid out in one cell, so moving from Waiting to Connected never changes the height. */}
    <div className="onboarding-connect-status onb-rise" style={rise(2)} data-state={state}>
      <span className="onboarding-connect-mark" aria-hidden="true"><span className="onboarding-connect-dot" /><Check size={14} strokeWidth={3} /><X size={14} strokeWidth={3} /></span>
      <div className="onboarding-slot">
        {connectStates.map(item => <p key={item.key} data-active={item.key === state || undefined} aria-hidden={item.key !== state || undefined}><strong>{item.title}</strong><span>{item.key === 'ready' && connection?.awsAccountId ? `Account ${connection.awsAccountId} is ready. Taking you to the next step…` : item.detail}</span></p>)}
      </div>
      <span className="sr-only" role="status">{active.title}</span>
    </div>
    <div className="onboarding-trouble onb-rise" style={rise(3)} inert={connected}>
      <button type="button" className="onboarding-disclosure" aria-expanded={trouble} aria-controls="onboarding-aws-trouble" onClick={() => setTrouble(open => !open)}><ChevronRight size={14} aria-hidden />Having trouble? Enter your AWS account ID</button>
      {trouble && !connected && <div id="onboarding-aws-trouble" className="onboarding-trouble-body"><VerifyAccount connection={connection} /></div>}
    </div>
  </div>
}

// Fallback until auto-verify is everywhere: verify the role by its AWS account ID.
function VerifyAccount({ connection }: { connection: ProviderConnection | null }) {
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
  return <form className="onboarding-inline-form" onSubmit={submit} noValidate>
    <div className="onboarding-field onboarding-field--aws">
      <Field label="AWS account ID" htmlFor="onboarding-aws-account" error={accountError || (verify.error ? verifyError(verify.error, connection?.region ?? 'your region') : undefined)} hint="Once the stack shows CREATE_COMPLETE. It’s the 12 digits in the AWS console’s account menu.">
        <Input id="onboarding-aws-account" inputMode="numeric" autoComplete="off" autoFocus value={account} onChange={event => setAccount(event.target.value)} placeholder="123456789012" maxLength={14} disabled={verify.isPending} />
      </Field>
    </div>
    <Button type="submit" loading={verify.isPending} disabled={!connection}>Verify</Button>
  </form>
}

// BYO with verified domains already in SES: they're done; continue, or add another.
function ImportedDomains({ count, onContinue, onAddAnother, fallback }: { count: number; onContinue: (id: string) => void; onAddAnother: () => void; fallback: ReactNode }) {
  const domains = useApiQuery(['domains', 'onboarding-imported'], (api, signal) => api.domains.list({ page: 1, pageSize: 20 }, signal))
  if (domains.isPending) return <BootLoader inline />
  const verified = (domains.data?.items ?? []).filter(domain => domain.status === 'verified')
  if (domains.error || verified.length === 0) return fallback
  const shown = Math.max(count, verified.length)
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">Your domains are ready</h1>
      <p className="onboarding-lead">We imported {shown} verified {shown === 1 ? 'domain' : 'domains'} from your AWS account. You can send from {shown === 1 ? 'it' : 'them'} now.</p>
    </div>
    <ul className="onboarding-imported onb-rise" style={rise(1)}>
      {verified.map(domain => <li key={domain.id}><code>{domain.name}</code><LiveStatus state="verified" plain /></li>)}
    </ul>
    <div className="onboarding-connect-actions onb-rise" style={rise(2)}>
      <Button variant="primary" onClick={() => onContinue(verified[0].id)}>Continue<ArrowRight size={16} aria-hidden /></Button>
      <Button variant="ghost" onClick={onAddAnother}>Add another domain</Button>
    </div>
  </div>
}

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

type AddDomainProps = { draft: string; onDraftChange: (value: string) => void; queued: boolean; onQueuedChange: (queued: boolean) => void; ready: boolean; region: string; onAdded: (id: string) => void; onFinish: () => void }
// Before the connection is ready, a valid domain waits and is added as soon as it is.
function AddDomain({ draft, onDraftChange, queued, onQueuedChange, ready, region, onAdded, onFinish }: AddDomainProps) {
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
      <p className="onboarding-lead">Use a domain you own. Next, you’ll add a few DNS records.</p>
    </div>
    <form className="onboarding-inline-form onb-rise" style={rise(2)} onSubmit={event => { event.preventDefault(); void add() }} noValidate>
      <div className="onboarding-field onboarding-field--domain">
        {/* The hint line is always there: the live preview, the queued note or an error take turns in it. */}
        <Field label="Domain" htmlFor="onboarding-domain" error={invalid || (create.error ? message(create.error) : undefined)} hint={queued ? `${value} is added as soon as sending is ready.` : <>You’ll send as <code className="onboarding-preview">hello@{domainPattern.test(value) ? value : 'acme.com'}</code></>}>
          <Input id="onboarding-domain" autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft} onChange={event => { onDraftChange(event.target.value); onQueuedChange(false) }} placeholder="acme.com" disabled={create.isPending} />
        </Field>
      </div>
      <Button type="submit" variant="primary" loading={create.isPending}>Add domain<ArrowRight size={16} aria-hidden /></Button>
    </form>
    <div className="onb-rise onboarding-reserve" style={rise(3)} data-hidden={!ready || undefined} inert={!ready}><button type="button" className="onboarding-skip" disabled={create.isPending} onClick={onFinish}>Skip for now</button></div>
  </div>
}

function DomainSetup({ domainId, onContinue, onMissing }: { domainId: string; onContinue: () => void; onMissing: () => void }) {
  const domain = useDomain(domainId)
  const verified = domain.data?.status === 'verified'
  const missing = domain.error instanceof ApiError && domain.error.status === 404
  useEffect(() => { if (missing) onMissing() }, [missing]) // eslint-disable-line react-hooks/exhaustive-deps
  // Verified: show it, then carry on to the agent setup.
  useEffect(() => { if (!verified) return; const timer = setTimeout(onContinue, 2500); return () => clearTimeout(timer) }, [verified]) // eslint-disable-line react-hooks/exhaustive-deps
  // Resolved before the records show, so the one-click button never lands above visible records.
  const dns = useDnsSetup(domain.data)
  if (domain.isPending || missing || (!domain.error && dns.pending)) return <BootLoader inline />
  if (domain.error) return <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
  const current = domain.data
  return <div className="onboarding onboarding--wide">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title onboarding-domain-title"><span>{current.name}</span><LiveStatus state={verified ? 'verified' : current.status === 'issue' ? 'failed' : 'pending'} /></h1>
      {/* One slot for the lead, the failure note and the verified moment: each replaces the other in place. */}
      <div className="onboarding-slot">
        <p className="onboarding-lead" data-active={(!verified && current.status !== 'issue') || undefined} aria-hidden={verified || current.status === 'issue' || undefined}>Add these records at your DNS provider. We’ll check automatically, and you can continue while it verifies.</p>
        <div data-active={(!verified && current.status === 'issue') || undefined} inert={verified || current.status !== 'issue'}><Alert tone="danger">Verification stopped. Check the records below, then use Check now on the domain’s page in Domains.</Alert></div>
        <div className="onboarding-verified" data-active={verified || undefined} aria-hidden={!verified || undefined}>
          <span className="onboarding-verified-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
          <p><strong>{current.name} is verified.</strong> You can send email now. Taking you to the last step…</p>
          <span className="onboarding-verified-timer" aria-hidden="true" />
        </div>
      </div>
      <span className="sr-only" role="status">{verified ? `${current.name} is verified. Continuing to the last step.` : ''}</span>
    </div>
    <div className="onb-rise" style={rise(1)}><DomainRecords domain={current} guided setup={dns.setup} /></div>
    <div className="onboarding-actions">
      <p className="muted">{verified ? 'All set.' : 'Records can take a few minutes to show up.'}</p>
      <Button variant="primary" onClick={onContinue}>Continue<ArrowRight size={16} aria-hidden /></Button>
    </div>
  </div>
}

// Same length as a real key (os_ and 64 hex digits), so the reveal takes exactly the reserved space.
const keyPlaceholder = `os_${'0'.repeat(64)}`

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
        <p className={create.error ? 'developer-copy onboarding-error onboarding-key-copy' : 'muted developer-copy onboarding-key-copy'} role={create.error ? 'alert' : undefined}>{create.error ? message(create.error) : <>Store it as <code>OPENSEND_API_KEY</code> in your project’s environment. It’s shown once.</>}</p>
        {/* The key replaces the button in a slot sized for both, so the sections below never move. */}
        <div className="onboarding-slot onboarding-key">
          <div data-active={!secret || undefined} inert={!!secret}><Button loading={create.isPending} onClick={() => void createKey()}>Create API key</Button></div>
          <div className="developer-url onboarding-reveal" data-active={secret ? true : undefined} inert={!secret}><code>{secret ?? keyPlaceholder}</code><CopyAction value={secret ?? ''} label="Copy API key" variant="ghost" size="sm" compact className="developer-copy-icon" /></div>
        </div>
        <span className="sr-only" role="status">{secret ? 'API key created. It is shown once.' : ''}</span>
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
