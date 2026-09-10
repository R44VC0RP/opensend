export interface UploadAttachmentBytesOptions {
  apiUrl: string
  token: string
  filename: string
  bytes: Uint8Array | ArrayBuffer | Blob
  contentType?: string
  disposition?: 'attachment' | 'inline'
  contentId?: string
  idempotencyKey?: string
  signal?: AbortSignal
}
export interface UploadedAttachment {
  id: string
  filename: string
  contentType: string
  size: number
  disposition: 'attachment' | 'inline'
  contentId: string | null
  createdAt: string
  environment: 'live' | 'test'
}
export class OpenSendUploadError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly requestId?: string) { super(message); this.name = 'OpenSendUploadError' }
}
export async function uploadAttachmentBytes(options: UploadAttachmentBytesOptions): Promise<UploadedAttachment> {
  const base = new URL(options.apiUrl)
  const endpoint = new URL('/v1/attachments/upload', base.origin)
  const bytes = options.bytes instanceof Blob ? options.bytes : new Blob([options.bytes instanceof Uint8Array ? options.bytes.slice().buffer : options.bytes])
  const response = await fetch(endpoint, {
    method: 'POST', signal: options.signal, body: bytes,
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': options.contentType ?? 'application/octet-stream',
      'X-OpenSend-Filename': encodeURIComponent(options.filename),
      'X-OpenSend-Disposition': options.disposition ?? 'attachment',
      ...(options.contentId ? { 'X-OpenSend-Content-Id': options.contentId } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      Accept: 'application/json',
    },
  })
  const data = await response.json().catch(() => null) as UploadedAttachment | { error?: { code?: string; message?: string; requestId?: string } } | null
  if (!response.ok) {
    const error = data && 'error' in data ? data.error : undefined
    throw new OpenSendUploadError(error?.message ?? 'Attachment upload failed.', error?.code ?? `HTTP_${response.status}`, response.status, error?.requestId ?? response.headers.get('x-request-id') ?? undefined)
  }
  if (!data || !('id' in data) || typeof data.id !== 'string') throw new OpenSendUploadError('OpenSend returned an invalid attachment response.', 'INVALID_RESPONSE', response.status, response.headers.get('x-request-id') ?? undefined)
  return data as UploadedAttachment
}
