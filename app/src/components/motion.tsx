import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useToast, type Tone } from './ui'
import './motion.css'

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')

// A labelled copy button whose icon morphs to a check and whose label rolls Copy → Copied.
export function CopyAction({ value, label, variant = 'secondary', size = 'md', compact = false, className }: { value: string; label: string; variant?: 'secondary' | 'ghost' | 'primary'; size?: 'sm' | 'md'; compact?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const toast = useToast()
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    try { await navigator.clipboard.writeText(value) } catch { toast('Could not copy to clipboard.', 'error'); return }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1800)
  }
  return <>
    <button type="button" className={cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, 'copy-action', compact && 'copy-action--compact', className)} data-copied={copied || undefined} aria-label={label} title={label} onClick={() => void copy()}>
      <span className="copy-action__icon" aria-hidden="true"><Copy size={14} /><Check size={14} strokeWidth={2.5} /></span>
      {!compact && <span className="copy-action__text" aria-hidden="true">Cop<span className="copy-action__roll"><span>y</span><span>ied</span></span></span>}
    </button>
    <span className="sr-only" role="status">{copied ? 'Copied to clipboard' : ''}</span>
  </>
}

export type LiveState = 'pending' | 'verified' | 'failed'
const liveTone: Record<LiveState, Tone> = { pending: 'warning', verified: 'success', failed: 'danger' }
const liveLabels: Record<LiveState, string> = { pending: 'Pending', verified: 'Verified', failed: 'Failed' }
const liveStates = Object.keys(liveLabels) as LiveState[]

// Status that pulses while pending and morphs its dot into a check once verified. Plain drops the pill.
// Every label is laid out in one cell, so the width never changes between states.
export function LiveStatus({ state, labels, plain = false }: { state: LiveState; labels?: Partial<Record<LiveState, string>>; plain?: boolean }) {
  return <span className={cx(!plain && 'ui-status', `ui-tone--${liveTone[state]}`, 'live-status', plain && 'live-status--plain')} data-state={state}>
    <span className="live-status__mark" aria-hidden="true"><span className="live-status__dot" /><Check className="live-status__check" size={11} strokeWidth={3} /></span>
    <span className="live-status__label">{liveStates.map(key => <span key={key} data-active={key === state || undefined} aria-hidden={key === state ? undefined : true}>{labels?.[key] ?? liveLabels[key]}</span>)}</span>
  </span>
}
