import { Suspense, useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useApi, useApiQuery, useRegion } from '../data/context'
import { number, percent } from '../lib/format'
import { Button, LoadingState, Select } from './ui'
import { ThemeToggle } from './ThemeToggle'

const navigation = [['/', 'Overview'], ['/logs', 'Logs'], ['/campaigns', 'Campaigns'], ['/contacts', 'Contacts'], ['/lists', 'Lists'], ['/segments', 'Segments'], ['/api-keys', 'API keys'], ['/domains', 'Domains'], ['/settings', 'Settings']] as const
export function AppShell() {
  const api = useApi()
  const { regionId, setRegionId } = useRegion()
  const regions = useApiQuery(['regions'], (client, signal) => client.regions.list(signal))
  const current = regions.data?.find(region => region.id === regionId)
  const location = useLocation()
  const navigate = useNavigate()
  const content = useRef<HTMLElement>(null)
  useEffect(() => {
    window.scrollTo(0, 0)
    content.current?.scrollTo(0, 0)
  }, [location.pathname])
  useEffect(() => { if (regions.data?.length && !current) setRegionId(regions.data[0].id) }, [regions.data, current, setRegionId])
  useEffect(() => { document.title = `${navigation.find(([path]) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path))?.[1] ?? 'opensend'} · opensend` }, [location.pathname])
  function changeRegion(id: string) {
    setRegionId(id)
    const parts = location.pathname.split('/').filter(Boolean)
    if (['logs', 'campaigns', 'domains'].includes(parts[0])) {
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
      <NavLink className="wordmark" to="/" aria-label="opensend overview"><span className="wordmark-square" aria-hidden="true" />opensend</NavLink>
      <ThemeToggle />
      <div className="sidebar-context">
        <Select aria-label="AWS region" value={regionId} onValueChange={changeRegion} options={(regions.data ?? []).map(region => ({ value: region.id, label: region.id }))} disabled={!regions.data?.length} />
        {api.mode === 'demo' && <span className="demo-indicator" title="Sample data. Changes stay in this browser; no email, AWS, or webhook requests are made.">Demo mode</span>}
      </div>
      <nav className="main-navigation" aria-label="Main navigation">{navigation.map(([path, title]) => <NavLink key={path} to={path} end={path === '/'}>{title}</NavLink>)}</nav>
      <div className="sidebar-quota">{current ? <>
        <div className="quota-label"><span>SES · 24h</span><span>{percent(current.sent24h / Math.max(1, current.dailyQuota), 0)}</span></div>
        <meter className="quota-meter" min={0} max={current.dailyQuota} value={current.sent24h} aria-label="Daily sending quota used" />
        <span>{number(current.sent24h)} / {number(current.dailyQuota)} sent</span>
      </> : regions.isError ? <><span>Quota unavailable</span><Button variant="ghost" onClick={() => regions.refetch()}>Retry</Button></> : <span>Loading region…</span>}</div>
    </aside>
    <main ref={content} id="main-content" className="page-surface" tabIndex={-1}><Suspense fallback={<LoadingState />}><Outlet /></Suspense></main>
  </div>
}
