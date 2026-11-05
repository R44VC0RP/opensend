(() => {
  let saved = null
  try { saved = localStorage.getItem('opensend.theme') } catch {}
  const theme = saved === 'light' || saved === 'dark'
    ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
})()

// Start the session check while the app's scripts download. The app (data/live.ts) takes these
// responses over, and only when the workspace header matches what it would have sent itself.
;(() => {
  const path = location.pathname
  if (path === '/docs' || path.startsWith('/docs/') || new URLSearchParams(location.search).get('invitation')) return
  let workspace = null, ready = null
  try { workspace = localStorage.getItem('opensend.workspace'); ready = localStorage.getItem('opensend.dashboard-ready') } catch {}
  const start = url => {
    const response = fetch(url, { credentials: 'include', headers: { Accept: 'application/json', ...(workspace ? { 'X-OpenSend-Workspace': workspace } : {}) } })
    response.catch(() => {}) // The app awaits the real rejection; this only silences the unhandled one.
    return response
  }
  const responses = { '/v1/me': start('/v1/me') }
  // The public homepage check, for visitors whose workspace is not remembered as ready.
  if (path === '/' && ready !== (workspace ?? '*')) responses['/health'] = start('/health')
  window.__opensendEarly = { workspace, at: Date.now(), responses }
})()
