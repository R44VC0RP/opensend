import { useLocation } from 'react-router'
import { OverviewRouteSkeleton } from '../features/overview/skeletons'
import { EmailDetailSkeleton, LogsRouteSkeleton } from '../features/logs/skeletons'
import { CampaignRouteSkeleton } from '../features/campaigns/skeletons'
import { AudienceRouteSkeleton } from '../features/audience/skeletons'
import { SettingsRouteSkeleton } from '../features/settings/skeletons'

export function RouteSkeleton() {
  const { pathname } = useLocation()
  const [section, id, view] = pathname.split('/').filter(Boolean)
  if (!section) return <OverviewRouteSkeleton />
  if (section === 'logs') return id ? <EmailDetailSkeleton /> : <LogsRouteSkeleton />
  if (section === 'campaigns') return <CampaignRouteSkeleton kind={!id ? 'list' : view === 'review' ? 'review' : 'editor'} isNew={id === 'new'} />
  if (section === 'contacts') return <AudienceRouteSkeleton kind={id ? 'contact' : 'contacts'} />
  if (section === 'lists') return <AudienceRouteSkeleton kind={id ? 'list' : 'lists'} />
  if (section === 'segments') return <AudienceRouteSkeleton kind={id ? 'segment' : 'segments'} isNew={id === 'new'} />
  if (section === 'api-keys') return <SettingsRouteSkeleton kind="keys" />
  if (section === 'domains') return <SettingsRouteSkeleton kind={id ? 'domain' : 'domains'} />
  if (section === 'settings') return <SettingsRouteSkeleton kind={id === 'webhooks' ? view ? 'webhook' : 'webhooks' : 'ses'} isNew={view === 'new'} />
  return null
}
