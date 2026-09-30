// Light/dark toggle, sharing OpenSend's storage key and data-theme attribute (set early by theme.js).
(() => {
  const key = 'opensend.theme'
  const apply = theme => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
      button.setAttribute('aria-label', label); button.title = label
    }
  }
  const current = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-theme-toggle]')) return
    const next = current() === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(key, next) } catch {}
    apply(next)
  })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
    let saved = null; try { saved = localStorage.getItem(key) } catch {}
    if (saved !== 'light' && saved !== 'dark') apply(event.matches ? 'dark' : 'light')
  })
  window.addEventListener('storage', event => { if (event.key === key && (event.newValue === 'light' || event.newValue === 'dark')) apply(event.newValue) })
  apply(current())
})()
