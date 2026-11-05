import { Component, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, Route, Routes, Link, useLocation, useParams, type Params } from 'react-router'
import { AppShell } from './components/AppShell'
import { BootLoader } from './components/BootLoader'
import { Button, EmptyState } from './components/ui'
import { loadHome, useOnboardingStage, useSession } from './data/context'
import { selectedWorkspace } from './data/live'
import { dashboardLikelyReady, rememberDashboardReady } from './data/onboarding'
import { chunk } from './lib/preloadable'
const onboarding = chunk(() => import('./features/onboarding'))
const overview = chunk(() => import('./features/overview'))
const logs = chunk(() => import('./features/logs'))
const campaigns = chunk(() => import('./features/campaigns'))
const audience = chunk(() => import('./features/audience'))
const settings = chunk(() => import('./features/settings'))
const docs = chunk(() => import('./features/docs'))
const inbound = chunk(() => import('./features/inbound'))
const loadOnboarding = onboarding.preload
const loadOverview = overview.preload
const loadLogs = logs.preload
const loadCampaigns = campaigns.preload
const loadAudience = audience.preload
const loadSettings = settings.preload
const loadDocs = docs.preload
const loadInbound = inbound.preload
const LogsPage = logs.page(m => m.LogsPage)
const EmailDetailPage = logs.page(m => m.EmailDetailPage)
const ReceivedEmailDetailPage = logs.page(m => m.ReceivedEmailDetailPage)
const CampaignsPage = campaigns.page(m => m.CampaignsPage)
const CampaignEditorPage = campaigns.page(m => m.CampaignEditorPage)
const CampaignReviewPage = campaigns.page(m => m.CampaignReviewPage)
const TemplatesPage = campaigns.page(m => m.TemplatesPage)
const TemplateEditorPage = campaigns.page(m => m.TemplateEditorPage)
const ContactsPage = audience.page(m => m.ContactsPage)
const ContactDetailPage = audience.page(m => m.ContactDetailPage)
const ListsPage = audience.page(m => m.ListsPage)
const ListDetailPage = audience.page(m => m.ListDetailPage)
const SegmentsPage = audience.page(m => m.SegmentsPage)
const SegmentEditorPage = audience.page(m => m.SegmentEditorPage)
const ApiKeysPage = settings.page(m => m.ApiKeysPage)
const DomainsPage = settings.page(m => m.DomainsPage)
const DomainDetailPage = settings.page(m => m.DomainDetailPage)
const SettingsPage = settings.page(m => m.SettingsPage)
const WebhookDetailPage = settings.page(m => m.WebhookDetailPage)
const DocsPage = docs.page(m => m.DocsPage)
const InboundPage = inbound.page(m => m.InboundPage)
const InboundAddressesPage = inbound.page(m => m.InboundAddressesPage)
const InboundAddressDetailPage = inbound.page(m => m.InboundAddressDetailPage)
const InboundWebhooksPage = inbound.page(m => m.InboundWebhooksPage)
const InboundWebhookDetailPage = inbound.page(m => m.InboundWebhookDetailPage)
const LegacyMailboxesRedirect = inbound.page(m => m.LegacyMailboxesRedirect)
const LegacyMailboxRedirect = inbound.page(m => m.LegacyMailboxRedirect)
const LegacyMailboxWebhooksRedirect = inbound.page(m => m.LegacyMailboxWebhooksRedirect)
const LegacyMailboxWebhookRedirect = inbound.page(m => m.LegacyMailboxWebhookRedirect)
const OverviewPage = overview.page(m => m.OverviewPage)
const OnboardingPage = onboarding.page(m => m.OnboardingPage)

// Preload the first screen's code alongside /v1/me. A workspace that may need onboarding waits instead.
const noop = () => {}
const initialPath = window.location.pathname
if (initialPath === '/onboarding') loadOnboarding().catch(noop)
else if (!dashboardLikelyReady(selectedWorkspace())) { if (initialPath === '/') loadHome().catch(noop) /* /v1/me decides between onboarding and the dashboard; the homepage is the signed-out answer. */ }
else if (initialPath === '/') loadOverview().catch(noop)
else if (initialPath.startsWith('/logs')) loadLogs().catch(noop)
else if (['/campaigns', '/templates'].some(path => initialPath.startsWith(path))) loadCampaigns().catch(noop)
else if (['/audience', '/contacts', '/lists', '/segments'].some(path => initialPath.startsWith(path))) loadAudience().catch(noop)
else if (['/api-keys', '/domains', '/settings'].some(path => initialPath.startsWith(path))) loadSettings().catch(noop)
else if (['/docs', '/developer'].some(path => initialPath.startsWith(path))) loadDocs().catch(noop)
else if (['/inbound', '/mailboxes'].some(path => initialPath.startsWith(path))) loadInbound().catch(noop)

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* A production reporter can be injected here; never log message bodies. */ }
  render() { return this.state.failed ? <div className="fatal-error"><h1>Something went wrong</h1><p>Unsaved changes may be lost.</p><Button onClick={() => window.location.reload()}>Reload application</Button></div> : this.props.children }
}
// /v1/me alone decides whether the workspace still needs onboarding, before any dashboard chrome or data.
function DashboardGate() {
  const stage = useOnboardingStage()
  return stage ? <Navigate to="/onboarding" replace /> : <AppShell />
}
function OnboardingRoute() {
  const stage = useOnboardingStage()
  return stage ? <Suspense fallback={<BootLoader />}><OnboardingPage stage={stage} /></Suspense> : <Navigate to="/" replace />
}
// Former sections that were folded into another page keep their links working, query and anchor included.
function Moved({ to }: { to: (params: Readonly<Params>) => string }) {
  const location = useLocation()
  const target = to(useParams())
  return <Navigate replace to={`${target}${location.search}${target.includes('#') ? '' : location.hash}`} />
}
const id = (params: Readonly<Params>) => encodeURIComponent(params.id ?? '')
function useRememberDashboardReady() {
  const identity = useSession()?.identity
  const stage = useOnboardingStage()
  useEffect(() => { if (identity) rememberDashboardReady(identity.multiTenant ? identity.workspaceId : null, !stage) }, [identity, stage])
}
export function App() {
  useRememberDashboardReady()
  return <AppErrorBoundary><Routes><Route path="docs" element={<Suspense fallback={<BootLoader />}><DocsPage /></Suspense>} /><Route path="onboarding" element={<OnboardingRoute />} /><Route element={<DashboardGate />}>
    <Route index element={<OverviewPage />} />
    <Route path="logs" element={<LogsPage />} /><Route path="logs/received/:id" element={<ReceivedEmailDetailPage />} /><Route path="logs/:id" element={<EmailDetailPage />} />
    <Route path="inbound" element={<InboundPage />} /><Route path="inbound/addresses" element={<InboundAddressesPage />} /><Route path="inbound/addresses/:id" element={<InboundAddressDetailPage />} /><Route path="inbound/webhooks" element={<InboundWebhooksPage />} /><Route path="inbound/webhooks/:id" element={<InboundWebhookDetailPage />} />
    <Route path="mailboxes" element={<LegacyMailboxesRedirect />} /><Route path="mailboxes/webhooks" element={<LegacyMailboxWebhooksRedirect />} /><Route path="mailboxes/webhooks/:id" element={<LegacyMailboxWebhookRedirect />} /><Route path="mailboxes/:id" element={<LegacyMailboxRedirect />} />
    <Route path="campaigns" element={<CampaignsPage />} /><Route path="campaigns/new" element={<CampaignEditorPage />} /><Route path="campaigns/:id/edit" element={<CampaignEditorPage />} /><Route path="campaigns/:id/review" element={<CampaignReviewPage />} />
    <Route path="campaigns/templates" element={<TemplatesPage />} /><Route path="campaigns/templates/:id" element={<TemplateEditorPage />} />
    <Route path="audience" element={<ContactsPage />} /><Route path="audience/contacts/:id" element={<ContactDetailPage />} />
    <Route path="audience/lists" element={<ListsPage />} /><Route path="audience/lists/:id" element={<ListDetailPage />} />
    <Route path="audience/segments" element={<SegmentsPage />} /><Route path="audience/segments/new" element={<SegmentEditorPage />} /><Route path="audience/segments/:id" element={<SegmentEditorPage />} />
    <Route path="api-keys" element={<ApiKeysPage />} /><Route path="domains" element={<DomainsPage />} /><Route path="domains/:id" element={<DomainDetailPage />} />
    <Route path="settings" element={<SettingsPage />} /><Route path="settings/webhooks/new" element={<WebhookDetailPage />} /><Route path="settings/webhooks/:id" element={<WebhookDetailPage />} />
    <Route path="templates" element={<Moved to={() => '/campaigns/templates'} />} /><Route path="templates/:id" element={<Moved to={params => `/campaigns/templates/${id(params)}`} />} />
    <Route path="contacts" element={<Moved to={() => '/audience'} />} /><Route path="contacts/:id" element={<Moved to={params => `/audience/contacts/${id(params)}`} />} />
    <Route path="lists" element={<Moved to={() => '/audience/lists'} />} /><Route path="lists/:id" element={<Moved to={params => `/audience/lists/${id(params)}`} />} />
    <Route path="segments" element={<Moved to={() => '/audience/segments'} />} /><Route path="segments/:id" element={<Moved to={params => `/audience/segments/${id(params)}`} />} />
    <Route path="settings/webhooks" element={<Moved to={() => '/settings#webhooks'} />} /><Route path="settings/workspace" element={<Moved to={() => '/settings#workspace'} />} />
    <Route path="developer" element={<Moved to={() => '/docs'} />} />
    <Route path="*" element={<EmptyState headingAs="h1" title="Page not found" action={<Link to="/">Return to overview</Link>} />} />
  </Route></Routes></AppErrorBoundary>
}
