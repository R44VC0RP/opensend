import { Component, lazy, type ErrorInfo, type ReactNode } from 'react'
import { Route, Routes, Link } from 'react-router'
import { AppShell } from './components/AppShell'
import { Button, EmptyState } from './components/ui'
const loadOverview = () => import('./features/overview')
const loadLogs = () => import('./features/logs')
const loadCampaigns = () => import('./features/campaigns')
const loadAudience = () => import('./features/audience')
const loadSettings = () => import('./features/settings')
const TemplatesPage = lazy(() => import('./features/templates').then(m => ({default: m.TemplatesPage})))
const TemplateDetailPage = lazy(() => import('./features/templates').then(m => ({default: m.TemplateDetailPage})))
const loadDeveloper = () => import('./features/developer')
const OverviewPage = lazy(() => loadOverview().then(m => ({ default: m.OverviewPage })))
const LogsPage = lazy(() => loadLogs().then(m => ({ default: m.LogsPage })))
const EmailDetailPage = lazy(() => loadLogs().then(m => ({ default: m.EmailDetailPage })))
const CampaignsPage = lazy(() => loadCampaigns().then(m => ({ default: m.CampaignsPage })))
const CampaignEditorPage = lazy(() => loadCampaigns().then(m => ({ default: m.CampaignEditorPage })))
const CampaignReviewPage = lazy(() => loadCampaigns().then(m => ({ default: m.CampaignReviewPage })))
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
const WebhooksPage = lazy(() => loadSettings().then(m => ({ default: m.WebhooksPage })))
const WebhookDetailPage = lazy(() => loadSettings().then(m => ({ default: m.WebhookDetailPage })))
const DeveloperPage = lazy(() => loadDeveloper().then(m => ({ default: m.DeveloperPage })))

const initialPath = window.location.pathname
if (initialPath === '/') void loadOverview()
else if (initialPath.startsWith('/logs')) void loadLogs()
else if (initialPath.startsWith('/campaigns')) void loadCampaigns()
else if (['/contacts', '/lists', '/segments'].some(path => initialPath.startsWith(path))) void loadAudience()
else if (['/api-keys', '/domains', '/settings'].some(path => initialPath.startsWith(path))) void loadSettings()
else if (initialPath.startsWith('/developer')) void loadDeveloper()

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* A production reporter can be injected here; never log message bodies. */ }
  render() { return this.state.failed ? <div className="fatal-error"><h1>Something went wrong</h1><p>Unsaved changes may be lost.</p><Button onClick={() => window.location.reload()}>Reload application</Button></div> : this.props.children }
}
export function App() {
  return <AppErrorBoundary><Routes><Route element={<AppShell />}>
    <Route index element={<OverviewPage />} />
    <Route path="logs" element={<LogsPage />} /><Route path="logs/:id" element={<EmailDetailPage />} />
    <Route path="campaigns" element={<CampaignsPage />} /><Route path="campaigns/new" element={<CampaignEditorPage />} /><Route path="campaigns/:id/edit" element={<CampaignEditorPage />} /><Route path="campaigns/:id/review" element={<CampaignReviewPage />} />
    <Route path="contacts" element={<ContactsPage />} /><Route path="contacts/:id" element={<ContactDetailPage />} />
    <Route path="lists" element={<ListsPage />} /><Route path="lists/:id" element={<ListDetailPage />} />
    <Route path="segments" element={<SegmentsPage />} /><Route path="segments/new" element={<SegmentEditorPage />} /><Route path="segments/:id" element={<SegmentEditorPage />} />
    <Route path="api-keys" element={<ApiKeysPage />} /><Route path="domains" element={<DomainsPage />} /><Route path="domains/:id" element={<DomainDetailPage />} />
    <Route path="templates" element={<TemplatesPage />} /><Route path="templates/:id" element={<TemplateDetailPage />} />
    <Route path="developer" element={<DeveloperPage />} />
    <Route path="settings" element={<SettingsPage />} /><Route path="settings/webhooks" element={<WebhooksPage />} /><Route path="settings/webhooks/new" element={<WebhookDetailPage />} /><Route path="settings/webhooks/:id" element={<WebhookDetailPage />} />
    <Route path="*" element={<EmptyState headingAs="h1" title="Page not found" action={<Link to="/">Return to overview</Link>} />} />
  </Route></Routes></AppErrorBoundary>
}
