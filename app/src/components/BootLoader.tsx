import { LoaderCircle } from 'lucide-react'

// Neutral placeholder while the session decides between onboarding and the dashboard.
export function BootLoader({ inline = false }: { inline?: boolean }) {
  return <div className={inline ? 'boot-loader boot-loader--inline' : 'boot-loader'} role="status" aria-label="Loading">
    <LoaderCircle className="ui-spinner" size={20} aria-hidden="true" />
  </div>
}
