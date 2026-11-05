import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, Route, Routes, Link, useLocation, useParams, type Params } from 'react-router'
import { AppShell } from './components/AppShell'
import { BootLoader } from './components/BootLoader'
import { Button, EmptyState } from './components/ui'
import { loadHome, useOnboardingStage, useSession } from './data/context'
import { selectedWorkspace } from './data/live'
import { dashboardLikelyReady, rememberDashboardReady } from './data/onboarding'
import { preloadable } from './lib/preloadable'
const onboarding = preloadable(() => import('./features/onboarding'), m => m.OnboardingPage)
const overview = preloadable(() => import('./features/overview'), m => m.OverviewPage)
const loadOnboarding = onboarding.preload
const loadOverview = overview.preload
const loadLogs = () => import('./features/logs')
const loadCampaigns = () => import('./features/campaigns')
const loadAudience = () => import('./features/audience')
const loadSettings = () => import('./features/settings')
const loadDocs = () => import('./features/docs')
const loadInbound = () => import('./features/inbound')
const OverviewPage = overview.Component
const LogsPage = lazy(() => loadLogs().then(m => ({ default: m.LogsPage })))
const EmailDetailPage = lazy(() => loadLogs().then(m => ({ default: m.EmailDetailPage })))
const ReceivedEmailDetailPage = lazy(() => loadLogs().then(m => ({ default: m.ReceivedEmailDetailPage })))
const CampaignsPage = lazy(() => loadCampaigns().then(m => ({ default: m.CampaignsPage })))
const CampaignEditorPage = lazy(() => loadCampaigns().then(m => ({ default: m.CampaignEditorPage })))
const CampaignReviewPage = lazy(() => loadCampaigns().then(m => ({ default: m.CampaignReviewPage })))
const TemplatesPage = lazy(() => loadCampaigns().then(m => ({ default: m.TemplatesPage })))
const TemplateEditorPage = lazy(() => loadCampaigns().then(m => ({ default: m.TemplateEditorPage })))
const ContactsPage = lazy(() => loadAudience().then(m => ({ default: m.ContactsPage })))
const ContactDetailPage = lazy(() => loadAudience().then(m => ({ default: m.ContactDetailPage })))
const ListsPage = lazy(() => loadAudience().then(m => ({ default: m.ListsPage })))
const ListDetailPage = lazy(() => loadAudience().then(m => ({ default: m.ListDetailPage })))
const SegmentsPage = lazy(() => loadAudience().then(m => ({ default: m.SegmentsPage })))
const SegmentEditorPage = lazy(() => loadAudience().then(m => ({ default: m.SegmentEditorPage })))
const ApiKeysPage = lazy(() => loadSettings().then(m => ({ default: m.ApiKeysPage })))
const DomainsPage = lazy(() => loadSettings().then(m => ({ default: m.DomainsPage })))
const DomainDetailPage = lazy(() => loadSettings().then(m => ({ default: m.DomainDetailPage })))
const SettingsPage = lazy(() => loadSettings().then(m => ({ default: m.SettingsPage })))
const WebhookDetailPage = lazy(() => loadSettings().then(m => ({ default: m.WebhookDetailPage })))
const DocsPage = lazy(() => loadDocs().then(m => ({ default: m.DocsPage })))
const InboundPage = lazy(() => loadInbound().then(m => ({ default: m.InboundPage })))
const InboundAddressesPage = lazy(() => loadInbound().then(m => ({ default: m.InboundAddressesPage })))
const InboundAddressDetailPage = lazy(() => loadInbound().then(m => ({ default: m.InboundAddressDetailPage })))
const InboundWebhooksPage = lazy(() => loadInbound().then(m => ({ default: m.InboundWebhooksPage })))
const InboundWebhookDetailPage = lazy(() => loadInbound().then(m => ({ default: m.InboundWebhookDetailPage })))
const LegacyMailboxesRedirect = lazy(() => loadInbound().then(m => ({ default: m.LegacyMailboxesRedirect })))
const LegacyMailboxRedirect = lazy(() => loadInbound().then(m => ({ default: m.LegacyMailboxRedirect })))
const LegacyMailboxWebhooksRedirect = lazy(() => loadInbound().then(m => ({ default: m.LegacyMailboxWebhooksRedirect })))
const LegacyMailboxWebhookRedirect = lazy(() => loadInbound().then(m => ({ default: m.LegacyMailboxWebhookRedirect })))
const OnboardingPage = onboarding.Component

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
