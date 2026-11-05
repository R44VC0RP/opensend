// Query keys are ['opensend', mode, resource, ...args]; the resource names what a query reads.
export const resourceOf = (queryKey: readonly unknown[]) => String(queryKey[2])
// Lists and details backed by SES or other slow external reads: an ordinary write leaves them alone, and the
// mutations that change them (domains, regions) pass refreshSes to refresh everything.
const external = new Set(['regions', 'region-discovery', 'domain', 'domains', 'campaign-options'])
export const staleAfterWrite = (queryKey: readonly unknown[], refreshSes: boolean) => queryKey[0] === 'opensend' && (refreshSes || !external.has(resourceOf(queryKey)))
