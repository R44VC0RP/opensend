import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { Alert, Button, ConfirmDialog, ErrorState, Field, Input, PageHeader, Select, useToast } from '../../components/ui'
import { RouteSkeleton } from '../../components/RouteSkeleton'
import { useApiQuery, useSession } from '../../data/context'
import { connectionApi, retryableConnectionErrors, useConnectionCache } from '../../data/connections'
import { ApiError, type ProviderConnection } from '../../data/types'
import './onboarding.css'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Shared setup and BYO verification are resumable; keep retrying while AWS finishes.
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

function useConnectionMutation<T>(write: (input: T) => Promise<ProviderConnection | null>, readyMessage?: string) {
  const client = useQueryClient()
  const toast = useToast()
  const sync = useConnectionCache()
  return useMutation({
    gcTime: 0,
    mutationFn: write,
    onSuccess: connection => {
      sync(connection)
      if (connection?.status !== 'ready') return
      if (readyMessage) toast(readyMessage, 'success')
      // Regions, discovery and limits now come from the new connection.
      void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'opensend' && query.queryKey[3] !== 'connection' }).catch(() => {})
    },
  })
}

function StartOver({ connection }: { connection: ProviderConnection }) {
  const [open, setOpen] = useState(false)
  const remove = useConnectionMutation(async () => { await connectionApi.remove(); return null })
  return <>
    <Button variant="ghost" onClick={() => setOpen(true)}>Start over</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} title="Start over?" description={connection.kind === 'byo' ? 'The current CloudFormation link stops working. If you already created the stack, delete it in AWS.' : 'Clears the unfinished setup so you can choose again.'} confirmLabel="Start over" pending={remove.isPending} onConfirm={() => remove.mutateAsync(undefined)} />
  </>
}

export function SendingOnboarding() {
  const connection = useApiQuery(['connection'], (_api, signal) => connectionApi.get(signal), { interval: data => data?.kind === 'shared' && data.status === 'pending' ? 5000 : false })
  const regions = useApiQuery(['connection-regions'], (_api, signal) => connectionApi.regions(signal))
  const sync = useConnectionCache()
  // Setup finished elsewhere (another tab or admin): lift the gate.
  useEffect(() => { if (connection.data?.status === 'ready') sync(connection.data) }, [connection.data]) // eslint-disable-line react-hooks/exhaustive-deps
  if (connection.error || regions.error) return <ErrorState error={connection.error ?? regions.error} onRetry={() => { void connection.refetch(); void regions.refetch() }} />
  if (connection.isPending || regions.isPending) return <RouteSkeleton />
  const current = connection.data
  if (current?.kind === 'byo' && current.status === 'pending' && current.quickCreateUrl) return <ConnectAws connection={current} />
  return <ChooseSending unfinished={current?.status === 'pending' ? current : null} regions={regions.data} />
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

function sharedError(error: unknown) {
  if (code(error) === 'AWS_NOT_CONFIGURED') return 'Shared sending isn’t configured on this installation.'
  if (code(error) === 'CONNECTION_EXISTS') return 'Another setup is already started. Start over to choose again.'
  return message(error)
}

function ChooseSending({ unfinished, regions }: { unfinished: ProviderConnection | null; regions: { shared: string[]; byo: string[] } }) {
  const sharedOptions = [...new Set([...regions.shared, ...unfinished ? [unfinished.region] : []])].map(region => ({ value: region, label: region }))
  const byoOptions = regions.byo.map(region => ({ value: region, label: region }))
  const [sharedRegion, setSharedRegion] = useState(unfinished?.kind === 'shared' ? unfinished.region : regions.shared[0] ?? '')
  const [byoRegion, setByoRegion] = useState(regions.byo[0] ?? '')
  const shared = useConnectionMutation((region: string) => retrying(() => connectionApi.create({ kind: 'shared', region })), 'Shared sending is ready')
  const byo = useConnectionMutation((region: string) => connectionApi.create({ kind: 'byo', region }))
  const busy = shared.isPending || byo.isPending
  const resuming = unfinished?.kind === 'shared'
  return <div className="stack onboarding">
    <PageHeader title="How do you want to send?" actions={unfinished && !busy && <StartOver connection={unfinished} />} />
    <p className="muted onboarding-lead">Choose where your email is sent from. You can change this later in Settings.</p>
    <div className="onboarding-options">
      <section className="onboarding-option" aria-labelledby="onboarding-shared">
        <h2 id="onboarding-shared">OpenSend shared sending</h2>
        <p className="muted">Send through OpenSend’s AWS account. Ready in about a minute.</p>
        <p className="onboarding-price">$0.11 per 1,000 emails</p>
        <Field label="Region" htmlFor="onboarding-shared-region"><Select id="onboarding-shared-region" value={sharedRegion} onValueChange={setSharedRegion} options={sharedOptions} disabled={busy || resuming} /></Field>
        {shared.error ? <Alert tone="danger">{sharedError(shared.error)}</Alert> : null}
        {shared.isPending && <p className="muted" role="status">Setting up shared sending in {sharedRegion}. This can take a minute.</p>}
        <Button variant="primary" loading={shared.isPending} disabled={busy} onClick={() => shared.mutate(sharedRegion)}>{resuming ? 'Finish setup' : 'Use shared sending'}</Button>
      </section>
      <section className="onboarding-option" aria-labelledby="onboarding-byo">
        <h2 id="onboarding-byo">Bring your own AWS</h2>
        <p className="muted">Send through your own AWS account. Takes a few minutes in the AWS console.</p>
        <p className="onboarding-price">You pay AWS directly</p>
        <Field label="Region" htmlFor="onboarding-byo-region"><Select id="onboarding-byo-region" value={byoRegion} onValueChange={setByoRegion} options={byoOptions} disabled={busy || resuming} /></Field>
        {byo.error ? <Alert tone="danger">{code(byo.error) === 'CONNECTION_EXISTS' ? 'Shared sending setup is already started. Start over to choose this instead.' : message(byo.error)}</Alert> : null}
        <Button loading={byo.isPending} disabled={busy || resuming} onClick={() => byo.mutate(byoRegion)}>Connect AWS</Button>
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
  const verify = useConnectionMutation((id: string) => retrying(() => connectionApi.verify(id)), 'AWS connected')
  async function submit(event: FormEvent) {
    event.preventDefault()
    const id = account.replace(/[\s-]/g, '')
    if (!/^\d{12}$/.test(id)) { setAccountError('Enter the 12-digit AWS account ID.'); return }
    setAccountError('')
    try { await verify.mutateAsync(id) } catch { /* Shown inline. */ }
  }
  return <div className="stack onboarding onboarding--narrow">
    <PageHeader title="Connect your AWS account" actions={!verify.isPending && <StartOver connection={connection} />} />
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
