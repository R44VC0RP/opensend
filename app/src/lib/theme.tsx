import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'

type Theme = 'light' | 'dark'
const storageKey = 'opensend.theme'
const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void } | null>(null)
const parseTheme = (value: string | null): Theme | null => value === 'light' || value === 'dark' ? value : null
function savedTheme() {
  try { return parseTheme(localStorage.getItem(storageKey)) } catch { return null }
}
function systemTheme(): Theme { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Theme | null>(savedTheme)
  const [system, setSystem] = useState<Theme>(systemTheme)
  const theme = preference ?? system

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onSystemChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light')
    const onStorageChange = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) setPreference(parseTheme(event.newValue))
    }
    media.addEventListener('change', onSystemChange)
    window.addEventListener('storage', onStorageChange)
    return () => {
      media.removeEventListener('change', onSystemChange)
      window.removeEventListener('storage', onStorageChange)
    }
  }, [])

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setPreference(next)
    try { localStorage.setItem(storageKey, next) } catch { /* Theme remains usable without persistence. */ }
  }, [theme])

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('ThemeProvider is required')
  return context
}
