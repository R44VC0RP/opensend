import { useState } from 'react'
import { Button, ConfirmDialog, ErrorState, FieldSkeleton, SectionHeader, StatusBadge } from '../../components/ui'
import { useApiMutation, useApiQuery } from '../../data/context'
import { connectionApi, connectionKindLabel, useConnectionCache } from '../../data/connections'

export function SendingConnection() {
  const connection = useApiQuery(['connection'], (_api, signal) => connectionApi.get(signal))
  const disconnect = useApiMutation(() => connectionApi.remove(), 'Disconnected', true)
  const [confirming, setConfirming] = useState(false)
  const sync = useConnectionCache()
  const current = connection.data
  return <section className="section stack">
    <SectionHeader title="Sending" actions={current && <Button variant="danger" onClick={() => setConfirming(true)}>Disconnect</Button>} />
    {connection.error ? <ErrorState error={connection.error} onRetry={() => void connection.refetch()} /> : connection.isPending ? <FieldSkeleton /> : !current ? <p className="muted settings-section-note">Not connected.</p> : <dl className="settings-facts">
      <div><dt>Type</dt><dd>{connectionKindLabel[current.kind]}</dd></div>
      <div><dt>Region</dt><dd>{current.region}</dd></div>
      <div><dt>Status</dt><dd><StatusBadge status={current.state} /></dd></div>
      {current.kind === 'shared' && <div><dt>Hosted setup</dt><dd><StatusBadge status={current.tenant} /></dd></div>}
      {current.kind === 'byo' && <div><dt>AWS account</dt><dd>{current.awsAccountId ?? '—'}</dd></div>}
    </dl>}
    <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Disconnect sending?" description={current?.kind === 'byo' ? 'Sending stops until you connect again. AWS resources stay in your account; delete the OpenSend stack in AWS to revoke access.' : 'Sending stops until you connect again.'} confirmLabel="Disconnect" danger pending={disconnect.isPending} onConfirm={async () => { await disconnect.mutateAsync(undefined); sync(null) }} />
  </section>
}
