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
  if (section === 'campaigns') return id === 'templates' ? <CampaignRouteSkeleton kind={view ? 'template' : 'templates'} /> : <CampaignRouteSkeleton kind={!id ? 'list' : view === 'review' ? 'review' : 'editor'} isNew={id === 'new'} />
  if (section === 'audience') return id === 'lists' ? <AudienceRouteSkeleton kind={view ? 'list' : 'lists'} /> : id === 'segments' ? <AudienceRouteSkeleton kind={view ? 'segment' : 'segments'} isNew={view === 'new'} /> : <AudienceRouteSkeleton kind={view ? 'contact' : 'contacts'} />
  if (section === 'api-keys') return <SettingsRouteSkeleton kind="keys" />
  if (section === 'domains') return <SettingsRouteSkeleton kind={id ? 'domain' : 'domains'} />
  if (section === 'settings') return <SettingsRouteSkeleton kind={id === 'webhooks' && view ? 'webhook' : 'settings'} isNew={view === 'new'} />
  return null
}
