import { Alert, Dialog, Button, CopyButton, Tabs } from '../../components/ui'
import { ApiError } from '../../data/types'
import { useNavigate } from 'react-router'

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The change could not be saved. Try again.'
}
export function fieldError(error: unknown, field: string) {
  return error instanceof ApiError ? error.fields[field] : undefined
}
export function MutationError({ error }: { error: unknown }) {
  return error ? <Alert tone="danger">{errorText(error)}</Alert> : null
}
export function SettingsTabs({ value }: { value: 'ses' | 'webhooks' }) {
  const navigate = useNavigate()
  return <Tabs value={value} onValueChange={next => navigate(next === 'ses' ? '/settings' : '/settings/webhooks')} items={[{ value: 'ses', label: 'Amazon SES' }, { value: 'webhooks', label: 'Webhooks' }]} />
}
export function SecretDialog({ secret, title, onClose }: { secret: string | null; title: string; onClose: () => void }) {
  return <Dialog open={secret !== null} onOpenChange={open => { if (!open) onClose() }} title={title} description="Shown once. Copy it now." footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
    <div className="settings-secret"><code>{secret}</code>{secret && <CopyButton value={secret} label="Copy secret" />}</div>
  </Dialog>
}
