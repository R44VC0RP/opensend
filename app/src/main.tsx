import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiProvider, RegionProvider } from './data/context'
import { ThemeProvider } from './lib/theme'
import { ToastProvider } from './components/ui'
import { App } from './App'
import './styles/tokens.css'
import './styles/ui.css'
import './styles/app.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } })
createRoot(document.getElementById('root')!).render(
  <StrictMode><ThemeProvider><QueryClientProvider client={queryClient}><ToastProvider><ApiProvider><RegionProvider><BrowserRouter><App /></BrowserRouter></RegionProvider></ApiProvider></ToastProvider></QueryClientProvider></ThemeProvider></StrictMode>,
)
