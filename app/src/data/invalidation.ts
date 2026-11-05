import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

// Query keys are ['opensend', mode, resource, ...args]; the resource names what a query reads.
export const resourceOf = (queryKey: readonly unknown[]) => String(queryKey[2])
// Lists and details backed by SES or other slow external reads: an ordinary write leaves them alone, and the
// mutations that change them (domains, regions) pass refreshSes to refresh everything.
const external = new Set(['regions', 'region-discovery', 'domain', 'domains', 'campaign-options'])
export const staleAfterWrite = (queryKey: readonly unknown[], refreshSes: boolean) => queryKey[0] === 'opensend' && (refreshSes || !external.has(resourceOf(queryKey)))

// A polled detail page learns of a status change (domain verified, campaign done) before any cached list of the same
// resource does; when the observed value changes, mark those lists stale so the next visit refetches them.
export function useRefreshListsOnChange(resource: string, value: string | undefined) {
  const client = useQueryClient()
  const previous = useRef(value)
  useEffect(() => {
    if (previous.current !== undefined && value !== undefined && previous.current !== value) void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'opensend' && resourceOf(query.queryKey) === resource }).catch(() => {})
    if (value !== undefined) previous.current = value
  }, [client, resource, value])
}
