import { Alert, Dialog, Button, CopyButton } from '../../components/ui'
import { ApiError } from '../../data/types'

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The change could not be saved. Try again.'
}
export function fieldError(error: unknown, field: string) {
  return error instanceof ApiError ? error.fields[field] : undefined
}
export function MutationError({ error }: { error: unknown }) {
  return error ? <Alert tone="danger">{errorText(error)}</Alert> : null
}
export function SecretDialog({ secret, title, onClose }: { secret: string | null; title: string; onClose: () => void }) {
  return <Dialog open={secret !== null} onOpenChange={open => { if (!open) onClose() }} title={title} description="Shown once. Copy it now." footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
    <div className="settings-secret"><code>{secret}</code>{secret && <CopyButton value={secret} label="Copy secret" />}</div>
  </Dialog>
}
