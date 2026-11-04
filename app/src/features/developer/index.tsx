import { PageHeader } from '../../components/ui'
import { useApiQuery, useSession, useWorkspaceAccess } from '../../data/context'
import { AgentPrompt, McpSetup, agentPrompt, usePublicOrigin } from './agent-setup'
import './developer.css'

export function DeveloperPage() {
  const identity = useSession()?.identity
  const { multiTenant } = useWorkspaceAccess()
  const origin = usePublicOrigin()
  const domains = useApiQuery(['domains', 'agent-prompt'], (api, signal) => api.domains.list({ page: 1, pageSize: 20 }, signal))
  // Prefer a verified domain for the test send; any domain still gives the agent its DNS context.
  const items = domains.data?.items ?? []
  const listed = items.find(row => row.status === 'verified') ?? items[0] ?? null
  // The detail read carries the current DNS records, including the receiving MX.
  const detail = useApiQuery(['domain', listed?.id], (api, signal) => api.domains.get(listed!.id, signal), { enabled: !!listed })
  const domain = detail.data ?? listed
  return <div className="stack developer-page">
    <PageHeader title="Developer" />
    {!domains.isPending && !(listed && detail.isPending) && <AgentPrompt prompt={agentPrompt({ origin, domain, email: identity?.email ?? null, multiTenant })} />}
    <McpSetup chooseAccess />
  </div>
}
