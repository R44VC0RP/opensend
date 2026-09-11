import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi } from '../../data/context'
import type { Campaign } from '../../data/types'

export function campaignVersion(campaign: Pick<Campaign, 'id' | 'revision' | 'updatedAt' | 'status' | 'reviewId' | 'scheduledAt' | 'archivedAt'>) {
  return JSON.stringify([
    campaign.id,
    campaign.revision ?? 1,
    Date.parse(campaign.updatedAt),
    campaign.status,
    campaign.reviewId ?? null,
    campaign.scheduledAt ? Date.parse(campaign.scheduledAt) : null,
    campaign.archivedAt ? Date.parse(campaign.archivedAt) : null,
  ])
}

export function useCampaignSync(campaign: Campaign | null, onUpdate: (next: Campaign) => void) {
  const api = useApi()
  const id = campaign?.id ?? null
  const current = useRef({ api, campaign, onUpdate })
  current.current = { api, campaign, onUpdate }
  const check = useRef<() => void>(() => {})
  const checkNow = useCallback(() => check.current(), [])
  const [status, setStatus] = useState<{
    api: typeof api
    id: string | null
    connection: 'local' | 'connecting' | 'live' | 'offline'
    error: Error | null
  }>({ api, id, connection: id ? 'connecting' : 'local', error: null })

  useEffect(() => {
    setStatus({ api, id, connection: id ? 'connecting' : 'local', error: null })
    if (!id) return

    const controller = new AbortController()
    let stopped = false
    let busy = false
    let checkAgain = false
    let failures = 0
    let delivered: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const active = () => !stopped && current.current.api === api && current.current.campaign?.id === id
    const visible = () => document.visibilityState === 'visible'
    const clearTimer = () => { clearTimeout(timer); timer = undefined }

    async function poll() {
      if (!active() || !visible()) return
      busy = true
      let delay = 3000
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
        const state = await api.campaigns.state(id!, signal)
        if (!active()) return
        const accepted = current.current.campaign!
        const version = campaignVersion(state)
        if (version !== campaignVersion(accepted) && version !== delivered) {
          const next = await api.campaigns.get(id!, signal)
          if (!active()) return
          // A local save can finish while the full snapshot is in flight.
          const baseline = current.current.campaign!
          const revision = next.revision ?? 1
          const baselineRevision = baseline.revision ?? 1
          const older = revision < baselineRevision || (revision === baselineRevision && Date.parse(next.updatedAt) < Date.parse(baseline.updatedAt))
          const nextVersion = campaignVersion(next)
          if (next.id === id && !older && nextVersion !== campaignVersion(baseline) && nextVersion !== delivered) {
            current.current.onUpdate(next)
            // The full snapshot may already be newer than the compact state.
            delivered = nextVersion
          }
        }
        failures = 0
        setStatus({ api, id, connection: 'live', error: null })
      } catch (cause) {
        if (!active() || controller.signal.aborted) return
        delay = Math.min(3000 * 2 ** failures, 30000)
        failures = Math.min(failures + 1, 4)
        setStatus({ api, id, connection: 'offline', error: cause instanceof Error ? cause : new Error('Campaign synchronization failed.') })
      } finally {
        busy = false
        if (active() && visible()) timer = setTimeout(requestCheck, checkAgain ? 0 : delay)
        checkAgain = false
      }
    }

    function requestCheck() {
      clearTimer()
      if (!active() || !visible()) return
      if (busy) { checkAgain = true; return }
      void poll()
    }

    function visibilityChanged() {
      if (visible()) requestCheck()
      else clearTimer()
    }

    check.current = requestCheck
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('pageshow', requestCheck)
    window.addEventListener('focus', requestCheck)
    window.addEventListener('online', requestCheck)
    timer = setTimeout(requestCheck, 3000)
    return () => {
      stopped = true
      clearTimer()
      controller.abort()
      if (check.current === requestCheck) check.current = () => {}
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('pageshow', requestCheck)
      window.removeEventListener('focus', requestCheck)
      window.removeEventListener('online', requestCheck)
    }
  }, [api, id])

  const scoped = status.api === api && status.id === id
  return {
    connection: scoped ? status.connection : id ? 'connecting' as const : 'local' as const,
    error: scoped ? status.error : null,
    checkNow,
  }
}
