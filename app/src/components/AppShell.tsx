import { Suspense, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useApi, useApiQuery, useRegion, useSession, useWorkspaceAccess } from '../data/context'
import { workspaceApi } from '../data/workspaces'
import { useRegionCatalog, useRegionDiscovery } from '../data/regions'
import { label, number, percent } from '../lib/format'
import { Alert, Button, EmptyState, ErrorState, Select, Skeleton, SkeletonText, useToast } from './ui'
import { RouteSkeleton } from './RouteSkeleton'
import { ThemeToggle } from './ThemeToggle'

// Members can't manage sending infrastructure; the API enforces this too.
const adminOnly = new Set(['/api-keys', '/domains'])
const navigation = [['/', 'Overview'], ['/logs', 'Logs'], ['/inbound', 'Inbound'], ['/campaigns', 'Campaigns'], ['/templates', 'Templates'], ['/contacts', 'Contacts'], ['/lists', 'Lists'], ['/segments', 'Segments'], ['/api-keys', 'API keys'], ['/domains', 'Domains'], ['/developer', 'Developer'], ['/docs', 'Docs'], ['/settings', 'Settings']] as const
export function AppShell() {
  const api = useApi()
  const { regionId, setRegionId } = useRegion()
  const session = useSession()
  const access = useWorkspaceAccess()
  const toast = useToast()
  const workspaces = useApiQuery(['workspaces'], (_api, signal) => workspaceApi.list(signal), { enabled: access.multiTenant })
  const [switching, setSwitching] = useState(false)
  const location = useLocation()
  const needsRegion = location.pathname === '/' || ['/logs', '/domains'].some(path => location.pathname.startsWith(path))
  const regions = useRegionCatalog()
  const enabled = regions.data?.data.filter(region => region.enabled) ?? []
  const current = regions.data?.data.find(region => region.region === regionId && region.enabled)
  const discovery = useRegionDiscovery(current)
  const quota = discovery.data?.account?.quota
  const provisioning = current?.provisionStatus === 'pending' || current?.provisionStatus === 'running'
  const needsProvisioning = Boolean(current && !provisioning && (current.discoveryStatus === 'needs_provisioning' || (discovery.data && !discovery.data.provisioned)))
  const navigate = useNavigate()
  const content = useRef<HTMLElement>(null)
  const testEnvironment = api.environment === 'test' || new URLSearchParams(location.search).get('environment') === 'test'
  const environmentSearch = testEnvironment ? '?environment=test' : ''
  useEffect(() => {
    window.scrollTo(0, 0)
    content.current?.scrollTo(0, 0)
  }, [location.pathname])
  useEffect(() => {
    const preferred = regions.data?.defaultRegion
    if (regions.data && !current && enabled.length) setRegionId(enabled.find(region => region.region === preferred)?.region ?? enabled[0].region)
  }, [regions.data, current, enabled, setRegionId])
  useEffect(() => { document.title = `${navigation.find(([path]) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path))?.[1] ?? 'opensend'} · opensend` }, [location.pathname])
  useEffect(() => {
    if (api.environment !== 'test' || new URLSearchParams(location.search).get('environment') === 'test') return
    const search = new URLSearchParams(location.search); search.set('environment', 'test')
    navigate({ pathname: location.pathname, search: search.toString() }, { replace: true })
  }, [api.environment, location.pathname, location.search, navigate])
  async function changeWorkspace(id: string) {
    // Detail routes belong to the previous workspace; keep only the section.
    const [section, child] = location.pathname.split('/').filter(Boolean)
    const path = section === 'settings' && child === 'workspace' ? '/settings/workspace' : section ? `/${section}` : '/'
    setSwitching(true)
    try { await session?.switchWorkspace(id, `${path}${environmentSearch}`) }
    catch (error) { toast(error instanceof Error ? error.message : 'Couldn’t switch workspace.', 'error'); setSwitching(false) }
  }
  function changeRegion(id: string) {
    setRegionId(id)
    const parts = location.pathname.split('/').filter(Boolean)
    if (['logs', 'domains'].includes(parts[0])) {
      if (parts.length > 1) navigate(`/${parts[0]}`)
      else {
        const search = new URLSearchParams(location.search)
        search.delete('page')
        navigate({ pathname: location.pathname, search: search.toString() }, { replace: true })
      }
    }
  }
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <NavLink className="wordmark" to={`/${environmentSearch}`} aria-label="opensend overview"><span className="wordmark-square" aria-hidden="true" />opensend</NavLink>
      <ThemeToggle />
      <div className="sidebar-context">
        {access.multiTenant && <Select id="sidebar-workspace" aria-label="Workspace" value={session?.identity?.workspaceId ?? ''} onValueChange={id => void changeWorkspace(id)} options={(workspaces.data ?? []).map(workspace => ({ value: workspace.id, label: workspace.name }))} disabled={switching || workspaces.isPending} placeholder={workspaces.isPending ? 'Loading workspaces…' : 'Workspace'} />}
        {access.canAdminister && <Select id="sidebar-view-region" aria-label="Viewing region" value={current?.region ?? ''} onValueChange={changeRegion} options={enabled.map(region => ({ value: region.region, label: region.region }))} disabled={regions.isPending || !enabled.length} placeholder={regions.isPending ? 'Loading regions…' : 'No enabled regions'} />}
        {access.canAdminister && regions.isError && <Button variant="ghost" onClick={() => regions.refetch()}>Retry regions</Button>}
        {api.mode === 'demo' && <span className="demo-indicator" title="Sample data; no external requests.">Demo mode</span>}
      </div>
      <nav className="main-navigation" aria-label="Main navigation">{navigation.filter(([path]) => access.canAdminister || !adminOnly.has(path)).map(([path, title]) => <NavLink key={path} to={`${path}${environmentSearch}`} end={path === '/'}>{title}</NavLink>)}</nav>
      <div className="sidebar-footer">
        {access.canAdminister && needsProvisioning && <Link className="sidebar-setup" to={`/settings?region=${encodeURIComponent(regionId)}`}><span>Region needs provisioning</span><span className="sidebar-setup-action">Set up {regionId} →</span></Link>}
      <div className="sidebar-quota">{api.environment === 'test' || !access.canAdminister ? null : quota?.sentLast24Hours != null && quota.max24HourSend != null ? <>
        <div className="quota-label"><span>SES · 24h</span><span>{percent(quota.sentLast24Hours / Math.max(1, quota.max24HourSend), 0)}</span></div>
        {quota.max24HourSend > 0 && <meter className="quota-meter" min={0} max={quota.max24HourSend} value={quota.sentLast24Hours} aria-label="Daily sending quota used" />}
        <span>{number(quota.sentLast24Hours)} / {number(quota.max24HourSend)} sent</span>
      </> : discovery.isFetching ? <><div className="quota-label"><span>Checking SES…</span><Skeleton width={28} /></div><Skeleton height={3} /><SkeletonText lineHeight={18} /></> : <><span>SES · {discovery.isError ? 'Check failed' : label(current?.discoveryStatus ?? 'not_discovered')}</span><Link to="/settings">Set up SES</Link></>}</div>
      </div>
    </aside>
    <main ref={content} id="main-content" className="page-surface" tabIndex={-1}>{session?.notice && <div className="page-notice"><Alert tone="danger" title="Invitation not accepted" onDismiss={session.dismissNotice}>{session.notice}</Alert></div>}<Suspense fallback={<RouteSkeleton />}>{needsRegion && regions.isError && !regions.data ? <ErrorState error={regions.error} onRetry={() => regions.refetch()} /> : needsRegion && (regions.isPending ? !regionId : !current && enabled.length > 0) ? <RouteSkeleton /> : needsRegion && !enabled.length ? <EmptyState title="No enabled regions" action={<Link to="/settings">Set up SES</Link>} /> : <Outlet />}</Suspense></main>
  </div>
}
