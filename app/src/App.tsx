import { Component, lazy, type ErrorInfo, type ReactNode } from 'react'
import { Route, Routes, Link } from 'react-router'
import { AppShell } from './components/AppShell'
import { Button, EmptyState } from './components/ui'
import { OverviewPage } from './features/overview'
const LogsPage = lazy(() => import('./features/logs').then(m => ({ default: m.LogsPage })))
const EmailDetailPage = lazy(() => import('./features/logs').then(m => ({ default: m.EmailDetailPage })))
const CampaignsPage = lazy(() => import('./features/campaigns').then(m => ({ default: m.CampaignsPage })))
const CampaignEditorPage = lazy(() => import('./features/campaigns').then(m => ({ default: m.CampaignEditorPage })))
const CampaignReviewPage = lazy(() => import('./features/campaigns').then(m => ({ default: m.CampaignReviewPage })))
const ContactsPage = lazy(() => import('./features/audience').then(m => ({ default: m.ContactsPage })))
const ContactDetailPage = lazy(() => import('./features/audience').then(m => ({ default: m.ContactDetailPage })))
const ListsPage = lazy(() => import('./features/audience').then(m => ({ default: m.ListsPage })))
const ListDetailPage = lazy(() => import('./features/audience').then(m => ({ default: m.ListDetailPage })))
const SegmentsPage = lazy(() => import('./features/audience').then(m => ({ default: m.SegmentsPage })))
const SegmentEditorPage = lazy(() => import('./features/audience').then(m => ({ default: m.SegmentEditorPage })))
const ApiKeysPage = lazy(() => import('./features/settings').then(m => ({ default: m.ApiKeysPage })))
const DomainsPage = lazy(() => import('./features/settings').then(m => ({ default: m.DomainsPage })))
const DomainDetailPage = lazy(() => import('./features/settings').then(m => ({ default: m.DomainDetailPage })))
const SettingsPage = lazy(() => import('./features/settings').then(m => ({ default: m.SettingsPage })))
const WebhooksPage = lazy(() => import('./features/settings').then(m => ({ default: m.WebhooksPage })))
const WebhookDetailPage = lazy(() => import('./features/settings').then(m => ({ default: m.WebhookDetailPage })))

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* A production reporter can be injected here; never log message bodies. */ }
  render() { return this.state.failed ? <div className="fatal-error"><h1>Something went wrong</h1><p>Your saved changes are still on this device.</p><Button onClick={() => window.location.reload()}>Reload application</Button></div> : this.props.children }
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
    <Route path="settings" element={<SettingsPage />} /><Route path="settings/webhooks" element={<WebhooksPage />} /><Route path="settings/webhooks/new" element={<WebhookDetailPage />} /><Route path="settings/webhooks/:id" element={<WebhookDetailPage />} />
    <Route path="*" element={<EmptyState title="Page not found" description="This page may have moved or no longer exists." action={<Link to="/">Return to overview</Link>} />} />
  </Route></Routes></AppErrorBoundary>
}
