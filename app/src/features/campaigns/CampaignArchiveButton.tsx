import { Archive, ArchiveRestore } from 'lucide-react'
import { useApiMutation } from '../../data/context'
import type { Campaign } from '../../data/types'
import { Button, IconButton, useToast } from '../../components/ui'

export function CampaignArchiveButton({ campaign, compact = false, onSuccess }: { campaign: Campaign; compact?: boolean; onSuccess?: () => void }) {
  const archived = Boolean(campaign.archivedAt)
  const active = !archived && ['scheduled', 'sending'].includes(campaign.status)
  const toast = useToast()
  const mutation = useApiMutation((api, value: boolean) => api.campaigns.setArchived({ id: campaign.id, archived: value }), archived ? 'Campaign restored' : 'Campaign archived')
  const label = archived ? 'Restore campaign' : 'Archive campaign'
  const title = active ? 'Finish or cancel sending before archiving' : label
  async function update() {
    if (active || mutation.isPending) return
    try { await mutation.mutateAsync(!archived); onSuccess?.() }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not update this campaign.', 'error') }
  }
  return compact
    ? <IconButton label={`${archived ? 'Restore' : 'Archive'} ${campaign.name}`} title={title} disabled={active} loading={mutation.isPending} onClick={event => { event.stopPropagation(); void update() }}>{archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}</IconButton>
    : <Button variant="secondary" title={title} disabled={active} loading={mutation.isPending} onClick={() => void update()}>{label}</Button>
}
