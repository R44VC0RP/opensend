import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Paperclip, X } from 'lucide-react'
import { IconButton, useToast } from '../../components/ui'
import { useApi, useApiQuery } from '../../data/context'
import type { Attachment } from '../../data/types'
import { number } from '../../lib/format'
import './attachments.css'

export type CampaignAttachmentsRef = { open: () => void }
type Props = { ids: string[]; persisted: string[]; onChange: (ids: string[]) => void; onBusy: (busy: boolean) => void; disabled: boolean }
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'

export const CampaignAttachments = forwardRef<CampaignAttachmentsRef, Props>(function CampaignAttachments({ ids, persisted, onChange, onBusy, disabled }, ref) {
  const api = useApi()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const owned = useRef(new Set<string>())
  const known = useRef(new Map<string, Attachment>())
  const [busy, setBusy] = useState(false)
  const metadata = useApiQuery(['attachments', ids], async (api, signal) => api.attachments ? Promise.all(ids.map(id => api.attachments!.get(id, signal))) : [] as Attachment[])
  useEffect(() => { metadata.data?.forEach(item => known.current.set(item.id, item)) }, [metadata.data])
  useEffect(() => { if (metadata.isError) toast(message(metadata.error), 'error') }, [metadata.isError, metadata.error, toast])
  useImperativeHandle(ref, () => ({ open() {
    if (!api.attachments) { toast('Attachments are unavailable for this connection.', 'error'); return }
    if (busy || disabled) return
    input.current?.click()
  } }))

  async function upload(file?: File) {
    if (!file || busy || disabled || !api.attachments) return
    if (metadata.isPending || metadata.isError) {
      toast(metadata.isError ? 'Attachment sizes could not be loaded. Retrying…' : 'Wait for attachment sizes to load before uploading.', 'error')
      if (metadata.isError) void metadata.refetch()
      return
    }
    if (ids.length >= 20 || file.size + metadata.data.reduce((sum, item) => sum + item.size, 0) > 8 * 1024 * 1024) { toast('Use at most 20 attachments with a combined size of 8 MiB.', 'error'); return }
    setBusy(true); onBusy(true)
    try {
      const item = await api.attachments.upload(file)
      owned.current.add(item.id); known.current.set(item.id, item); onChange([...ids, item.id])
    } catch (cause) { toast(message(cause), 'error') }
    finally { setBusy(false); onBusy(false) }
  }
  async function remove(id: string) {
    if (busy || disabled || !api.attachments) return
    setBusy(true); onBusy(true)
    try {
      if (owned.current.has(id) && !persisted.includes(id)) { await api.attachments.remove(id); owned.current.delete(id) }
      onChange(ids.filter(value => value !== id))
    } catch (cause) { toast(message(cause), 'error') }
    finally { setBusy(false); onBusy(false) }
  }
  const files = ids.map(id => metadata.data?.find(item => item.id === id) ?? known.current.get(id)).filter((item): item is Attachment => Boolean(item && item.disposition !== 'inline'))
  return <>
    {files.length > 0 && <ul className="campaign-file-blocks" aria-label="File attachments" aria-busy={busy || undefined}>{files.map(item => <li key={item.id} title={`${item.filename} · ${item.contentType} · ${number(item.size)} bytes`}>
      <Paperclip size={16} aria-hidden="true" /><span className="campaign-file-name">{item.filename}</span><span className="campaign-file-size" aria-label={`${number(item.size)} bytes`}>{number(item.size)} B</span>
      <IconButton label={`Remove ${item.filename}`} disabled={busy || disabled} onClick={() => void remove(item.id)}><X size={16} aria-hidden="true" /></IconButton>
    </li>)}</ul>}
    {busy && <span className="sr-only" role="status">Updating attachments…</span>}
    <input ref={input} type="file" hidden aria-label="Upload attachment" disabled={busy || disabled || !api.attachments} onChange={event => { void upload(event.target.files?.[0]); event.currentTarget.value = '' }} />
  </>
})
