import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, Route, Routes, Link } from 'react-router'
import { AppShell } from './components/AppShell'
import { BootLoader } from './components/BootLoader'
import { Button, EmptyState } from './components/ui'
import { useOnboardingStage, useSession } from './data/context'
import { selectedWorkspace } from './data/live'
import { dashboardLikelyReady, rememberDashboardReady } from './data/onboarding'
const loadOnboarding = () => import('./features/onboarding')
const loadOverview = () => import('./features/overview')
const loadLogs = () => import('./features/logs')
const loadCampaigns = () => import('./features/campaigns')
const loadTemplates = () => import('./features/templates')
const loadAudience = () => import('./features/audience')
const loadSettings = () => import('./features/settings')
const loadDeveloper = () => import('./features/developer')
const loadDocs = () => import('./features/docs')
const loadInbound = () => import('./features/inbound')
const OverviewPage = lazy(() => loadOverview().then(m => ({ default: m.OverviewPage })))
const LogsPage = lazy(() => loadLogs().then(m => ({ default: m.LogsPage })))
const EmailDetailPage = lazy(() => loadLogs().then(m => ({ default: m.EmailDetailPage })))
const ReceivedEmailDetailPage = lazy(() => loadLogs().then(m => ({ default: m.ReceivedEmailDetailPage })))
const CampaignsPage = lazy(() => loadCampaigns().then(m => ({ default: m.CampaignsPage })))
const CampaignEditorPage = lazy(() => loadCampaigns().then(m => ({ default: m.CampaignEditorPage })))
const CampaignReviewPage = lazy(() => loadCampaigns().then(m => ({ default: m.CampaignReviewPage })))
const TemplatesPage = lazy(() => loadTemplates().then(m => ({ default: m.TemplatesPage })))
const TemplateEditorPage = lazy(() => loadTemplates().then(m => ({ default: m.TemplateEditorPage })))
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
const WorkspaceSettingsPage = lazy(() => loadSettings().then(m => ({ default: m.WorkspaceSettingsPage })))
const WebhooksPage = lazy(() => loadSettings().then(m => ({ default: m.WebhooksPage })))
const WebhookDetailPage = lazy(() => loadSettings().then(m => ({ default: m.WebhookDetailPage })))
const DeveloperPage = lazy(() => loadDeveloper().then(m => ({ default: m.DeveloperPage })))
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
const OnboardingPage = lazy(() => loadOnboarding().then(m => ({ default: m.OnboardingPage })))

// Preload the first screen's code alongside /v1/me. A workspace that may need onboarding waits instead.
const initialPath = window.location.pathname
if (initialPath === '/onboarding') void loadOnboarding()
else if (!dashboardLikelyReady(selectedWorkspace())) { /* /v1/me decides between onboarding and the dashboard. */ }
else if (initialPath === '/') void loadOverview()
else if (initialPath.startsWith('/logs')) void loadLogs()
else if (initialPath.startsWith('/campaigns')) void loadCampaigns()
else if (initialPath.startsWith('/templates')) void loadTemplates()
else if (['/contacts', '/lists', '/segments'].some(path => initialPath.startsWith(path))) void loadAudience()
else if (['/api-keys', '/domains', '/settings'].some(path => initialPath.startsWith(path))) void loadSettings()
else if (initialPath.startsWith('/developer')) void loadDeveloper()
else if (initialPath.startsWith('/docs')) void loadDocs()
else if (['/inbound', '/mailboxes'].some(path => initialPath.startsWith(path))) void loadInbound()

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
function useRememberDashboardReady() {
  const identity = useSession()?.identity
  const stage = useOnboardingStage()
  useEffect(() => { if (identity) rememberDashboardReady(identity.multiTenant ? identity.workspaceId : null, !stage) }, [identity, stage])
}
export function App() {
  useRememberDashboardReady()
  return <AppErrorBoundary><Routes><Route path="docs" element={<DocsPage />} /><Route path="onboarding" element={<OnboardingRoute />} /><Route element={<DashboardGate />}>
    <Route index element={<OverviewPage />} />
    <Route path="logs" element={<LogsPage />} /><Route path="logs/received/:id" element={<ReceivedEmailDetailPage />} /><Route path="logs/:id" element={<EmailDetailPage />} />
    <Route path="inbound" element={<InboundPage />} /><Route path="inbound/addresses" element={<InboundAddressesPage />} /><Route path="inbound/addresses/:id" element={<InboundAddressDetailPage />} /><Route path="inbound/webhooks" element={<InboundWebhooksPage />} /><Route path="inbound/webhooks/:id" element={<InboundWebhookDetailPage />} />
    <Route path="mailboxes" element={<LegacyMailboxesRedirect />} /><Route path="mailboxes/webhooks" element={<LegacyMailboxWebhooksRedirect />} /><Route path="mailboxes/webhooks/:id" element={<LegacyMailboxWebhookRedirect />} /><Route path="mailboxes/:id" element={<LegacyMailboxRedirect />} />
    <Route path="campaigns" element={<CampaignsPage />} /><Route path="campaigns/new" element={<CampaignEditorPage />} /><Route path="campaigns/:id/edit" element={<CampaignEditorPage />} /><Route path="campaigns/:id/review" element={<CampaignReviewPage />} />
    <Route path="templates" element={<TemplatesPage />} /><Route path="templates/:id" element={<TemplateEditorPage />} />
    <Route path="contacts" element={<ContactsPage />} /><Route path="contacts/:id" element={<ContactDetailPage />} />
    <Route path="lists" element={<ListsPage />} /><Route path="lists/:id" element={<ListDetailPage />} />
    <Route path="segments" element={<SegmentsPage />} /><Route path="segments/new" element={<SegmentEditorPage />} /><Route path="segments/:id" element={<SegmentEditorPage />} />
    <Route path="api-keys" element={<ApiKeysPage />} /><Route path="domains" element={<DomainsPage />} /><Route path="domains/:id" element={<DomainDetailPage />} />
    <Route path="developer" element={<DeveloperPage />} />
    <Route path="settings" element={<SettingsPage />} /><Route path="settings/workspace" element={<WorkspaceSettingsPage />} /><Route path="settings/webhooks" element={<WebhooksPage />} /><Route path="settings/webhooks/new" element={<WebhookDetailPage />} /><Route path="settings/webhooks/:id" element={<WebhookDetailPage />} />
    <Route path="*" element={<EmptyState headingAs="h1" title="Page not found" action={<Link to="/">Return to overview</Link>} />} />
  </Route></Routes></AppErrorBoundary>
}
