import type { ReactNode } from 'react'
import { PageHeader } from '../../components/ui'
import { SectionNav } from '../../components/SectionNav'

const sections = [{ to: '/campaigns', label: 'Campaigns' }, { to: '/campaigns/templates', label: 'Templates' }]

// Campaigns and the templates they start from share one page; each section keeps its own URL.
export function CampaignsHeader({ actions }: { actions?: ReactNode }) {
  return <><PageHeader title="Campaigns" actions={actions} /><SectionNav label="Campaign sections" items={sections} /></>
}
