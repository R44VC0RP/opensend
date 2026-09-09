import { ApiError, type OpenSendApi, type PageRequest, type PageResult, type Campaign, type Contact, type AudienceList, type Segment, type Domain, type Webhook, type WebhookDelivery, type Email, type RegionCatalog, type SesDiscovery, type RegionProvisionReceipt, type Workspace, type Identity } from './types'

type Json = Record<string, any>
const idPath = (id: string) => encodeURIComponent(id)
export async function request<T = Json>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; environment?: 'live' | 'test' } = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { method: options.method ?? 'GET', credentials: 'include', signal: options.signal,
      headers: { Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.environment ? { 'X-OpenSend-Environment': options.environment } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body) })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('Cannot reach OpenSend. Check the API service and try again.', 'NETWORK_UNAVAILABLE')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = data?.error
    const code = typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`
    const message = typeof error?.message === 'string' ? error.message : 'The request could not be completed.'
    if (response.status === 401 && path.startsWith('/v1/') && path !== '/v1/me') window.dispatchEvent(new Event('opensend:unauthorized'))
    throw new ApiError(message, code, error?.field ? { [error.field]: message } : {}, error?.requestId ?? response.headers.get('x-request-id') ?? undefined, response.status)
  }
  if (data === null && response.status !== 204 && path !== '/api/auth/get-session') throw new ApiError('The API returned an invalid response.', 'INVALID_RESPONSE')
  return data as T
}
const unsupported = (message: string): never => { throw new ApiError(message, 'UNSUPPORTED_OPERATION') }
const mapContact = (r: Json): Contact => ({ ...r, name: r.name ?? '', country: typeof r.properties?.country === 'string' ? r.properties.country : '', status: r.suppressed ? 'suppressed' : r.marketingConsent, listIds: r.listIds ?? [], lastOpenedAt: r.lastOpenAt, consent: { source: '', at: null }, suppressionReason: r.suppressionReason ?? undefined } as Contact)
const mapList = (r: Json): AudienceList => ({ ...r, total: r.counts?.total, subscribed: r.counts?.subscribed, unsubscribed: r.counts?.unsubscribed, suppressed: r.counts?.suppressed, unknown: r.counts?.unknown } as AudienceList)
const mapSegment = (r: Json): Segment => ({ ...r, rule: r.rule, match: r.rule?.operator === 'or' ? 'any' : 'all', rules: [], matched: undefined, eligible: undefined } as unknown as Segment)
const mapCampaign = (r: Json): Campaign => ({ ...r, id: r.id, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, scheduledAt: r.scheduledAt, revision: r.revision, draft: r.draft, reviewId: r.reviewId, regionId: r.draft.region, name: r.draft.name, fromEmail: r.draft.from, fromName: r.draft.fromName ?? '', subject: r.draft.subject, previewText: r.draft.previewText ?? '', html: r.draft.html ?? '', editor: r.draft.editor, listId: r.draft.audience.listId, segmentId: r.draft.audience.segmentId ?? null, attachments: r.draft.attachments ?? [], timezone: 'UTC', recipients: r.counts?.total, delivered: r.counts?.byStatus?.delivered, bounced: r.counts?.byStatus?.bounced, complaints: r.counts?.byStatus?.complained })
const mapCampaignSummary = (r: Json): Campaign => ({...mapCampaign(r), draft: undefined, attachments: undefined})
const mapEmailEvent = (r: Json) => ({id: r.id, type: r.type, at: r.createdAt, description: r.type, diagnostic: typeof r.data?.diagnostic === 'string' ? r.data.diagnostic : undefined})
const mapEmail = (r: Json): Email => ({ ...r, id: r.id, from: r.from, subject: r.subject, status: r.status, to: r.to.join(', '), regionId: r.region, stream: r.kind, sentAt: r.createdAt, html: '', events: [] })
const mapDomain = (r: Json): Domain => ({ ...r, regionId: r.region, status: r.ready ? 'verified' : r.verificationStatus === 'FAILED' ? 'issue' : 'pending', mailFromStatus: r.mailFromStatus == null ? 'not_configured' : r.mailFromStatus.toLowerCase() === 'success' ? 'verified' : r.mailFromStatus.toLowerCase() === 'failed' ? 'failed' : 'pending', records: (r.dns ?? []).map((d: Json, i: number) => ({ ...d, id: String(i), value: d.priority === undefined ? d.value : `${d.priority} ${d.value}`, status: 'not_checked' })) } as Domain)
const mapDelivery = (r: Json): WebhookDelivery => ({ id: r.id, at: r.createdAt, regionId: r.payload.region ?? 'Workspace', event: r.payload.type, response: r.lastStatusCode, attempts: r.attemptCount, status: r.status, payload: r.payload })
const mapWebhook = (r: Json): Webhook => ({ id: r.id, name: r.description || r.url, url: r.url, regionIds: r.regions ?? 'all', events: r.eventTypes, status: r.paused ? 'paused' : 'active', secretHint: 'Signing secret is hidden', deliveries: [] })
function regionCatalog(value: unknown): RegionCatalog {
  const record = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
  const nullableString = (v: unknown) => v === null || typeof v === 'string'
  if (!record(value) || typeof value.defaultRegion !== 'string' || !Array.isArray(value.data) || !value.data.every((row: unknown) => record(row)
    && typeof row.region === 'string' && typeof row.enabled === 'boolean' && typeof row.isDefault === 'boolean'
    && ['not_discovered', 'discovering', 'stale', 'ready', 'needs_provisioning', 'blocked'].includes(row.discoveryStatus)
    && nullableString(row.lastDiscoveredAt) && nullableString(row.provisionJobId) && nullableString(row.provisionError)
    && (row.provisionStatus === null || ['pending', 'running', 'completed', 'failed'].includes(row.provisionStatus)))) {
    throw new ApiError('The API did not return a region catalog. Update the running API service and run its database migrations; older region account responses are not supported.', 'INVALID_RESPONSE')
  }
  return value as RegionCatalog
}

export function createLiveApi(environment: 'live' | 'test'): OpenSendApi {
  const call = <T = Json>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => request<T>(`/v1${path}`, { method, body, signal, environment })
  // Page numbers are local navigation only. The API owns cursors and never supplies fictional totals.
  const keyCall = <T = Json>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => request<T>(`/v1${path}`, {method, body, signal, environment: 'live'})
  const cursors = new Map<string, Map<number, string | undefined>>()
  async function page<T>(path: string, input: PageRequest = {}, map: (r: Json) => T, filters: Json = {}, signal?: AbortSignal): Promise<PageResult<T>> {
    const limit = Math.min(path === '/domains' ? 10 : 100, input.pageSize ?? 20)
    const key = JSON.stringify([path, limit, filters])
    const history = cursors.get(key) ?? new Map([[1, undefined]])
    cursors.set(key, history)
    const requested = input.page ?? 1
    const current = input.cursor !== undefined || history.has(requested) ? requested : 1
    const cursor = input.cursor ?? history.get(current)
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
    const data = await call(`${path}?${params}`, 'GET', undefined, signal)
    if (data.nextCursor) history.set(current + 1, data.nextCursor)
    else history.delete(current + 1)
    return { items: data.data.map(map), page: current, pageSize: limit, nextCursor: data.nextCursor, total: undefined }
  }
  const getCampaign = async (id: string, signal?: AbortSignal) => mapCampaign(await call(`/campaigns/${idPath(id)}`, 'GET', undefined, signal))
  const getContact = async (id: string, signal?: AbortSignal) => mapContact(await call(`/contacts/${idPath(id)}`, 'GET', undefined, signal))
  const getWorkspace = async (signal?: AbortSignal) => {
    const [settings, identity] = await Promise.all([call('/settings/workspace', 'GET', undefined, signal), call<Identity>('/me', 'GET', undefined, signal)])
    return { name: settings.name, id: identity.id, role: identity.permissions.join(', ') } satisfies Workspace
  }
  const deliveries = async (id: string, cursor?: string) => { const result = await page(`/webhooks/${idPath(id)}/deliveries`, { cursor, pageSize: 20 }, mapDelivery); return { items: result.items, nextCursor: result.nextCursor ?? null } }
  return {
    mode: 'live', environment,
    consentHistory: async (id, cursor) => {const result = await call(`/contacts/${idPath(id)}/consent?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); return {items: result.data, nextCursor: result.nextCursor}},
    emailEvents: async (id, cursor) => {const result = await call(`/emails/${idPath(id)}/events?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); return {items: result.data.map(mapEmailEvent), nextCursor: result.nextCursor}},
    regions: {
      list: async signal => regionCatalog(await call('/regions', 'GET', undefined, signal)),
      configure: async (region, input, signal) => regionCatalog(await keyCall(`/regions/${idPath(region)}`, 'PUT', input, signal)),
      discover: (region, options, signal) => keyCall<SesDiscovery>(`/regions/${idPath(region)}/discovery${options?.refresh === true ? '?refresh=true' : ''}`, 'GET', undefined, signal),
      provision: (region, signal) => keyCall<RegionProvisionReceipt>(`/regions/${idPath(region)}/provision`, 'POST', { confirm: true }, signal),
    },
    workspace: { get: getWorkspace, update: async (input, signal) => { await call('/settings/workspace', 'PATCH', input, signal); return getWorkspace(signal) } },
    overview: { get: async (input, signal) => {
      const end = new Date(), start = new Date(end.getTime() - ({ '24h': 1, '7d': 7, '30d': 30 }[input.range]) * 86400000)
      const params = new URLSearchParams({ region: input.regionId, from: start.toISOString(), to: end.toISOString() })
      if (input.stream) params.set('stream', input.stream)
      const [metrics, campaigns] = await Promise.all([call(`/metrics?${params}`, 'GET', undefined, signal), page('/campaigns', {pageSize: 4}, mapCampaignSummary, {region: input.regionId}, signal)])
      const previousParams = new URLSearchParams(params); previousParams.set('to', start.toISOString()); previousParams.set('from', new Date(start.getTime() - (end.getTime() - start.getTime())).toISOString())
      const [previous, transactional, marketing] = await Promise.all([call(`/metrics?${previousParams}`, 'GET', undefined, signal), ...(['transactional', 'marketing'] as const).map(stream => {const q = new URLSearchParams(params); q.set('stream', stream); return call(`/metrics?${q}`, 'GET', undefined, signal)})])
      // The public created-cohort contract defines absent UTC buckets as no emails.
      // Fill that known absence across the selected interval, not across guessed history.
      const daily = new Map<string, Json>(metrics.daily.map((row: Json) => [String(row.date).slice(0, 10), row]))
      const startAt = new Date(metrics.from), endAt = Date.parse(metrics.to)
      const points = []
      for (let day = Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate()); day < endAt; day += 86400000) {
        const at = new Date(day).toISOString(), row = daily.get(at.slice(0, 10))
        points.push({at, sent: row?.count ?? 0, delivered: row?.delivered ?? 0, bounced: row?.bounced ?? 0, complaints: row?.complained ?? 0})
      }
      return { periodStart: metrics.from, periodEnd: metrics.to, sent: metrics.totals.emails, delivered: metrics.totals.delivered, bounced: metrics.totals.bounced, complaints: metrics.totals.complained, deferred: metrics.totals.deliveryDelayed, previousSent: previous.totals.emails, points, streams: [{name: 'transactional', sent: transactional.totals.emails}, {name: 'marketing', sent: marketing.totals.emails}], recentCampaigns: campaigns.items }
    } },
    emails: {
      list: (input, signal) => page('/emails', input, mapEmail, { region: input.regionId, kind: input.stream, status: input.status, search: input.search, to: input.to, from: input.from }, signal),
      get: async (id, signal) => { const path = `/emails/${idPath(id)}`; const [row, content, events] = await Promise.all([call(path, 'GET', undefined, signal), call(`${path}/content`, 'GET', undefined, signal), call(`${path}/events?limit=100`, 'GET', undefined, signal)]); return { ...mapEmail(row), html: content.html ?? '', text: content.text, attachments: content.attachments, events: events.data.map(mapEmailEvent), eventsNextCursor: events.nextCursor } }
    },
    campaigns: {
      list: (input, signal) => page('/campaigns', input, mapCampaignSummary, {region: input.regionId, status: input.status, search: input.search}, signal), get: getCampaign,
      save: async (input, signal) => {
        const existing = input.draft ?? {}
        const {segmentId: _oldSegment, ...audience} = existing.audience ?? {}
        const draft = { ...existing, name: input.name, region: input.regionId, from: input.fromEmail, fromName: input.fromName, previewText: input.previewText, subject: input.subject, ...(input.html ? {html: input.html} : existing.text && !existing.html ? {} : {html: input.html}), editor: input.editor ?? null, attachments: input.attachments ?? existing.attachments ?? [], audience: {...audience, listId: input.listId, ...(input.segmentId ? {segmentId: input.segmentId} : {})} }
        if (input.id && !input.revision) throw new ApiError('Reload this campaign before saving.', 'REVISION_REQUIRED')
        return mapCampaign(await call(input.id ? `/campaigns/${idPath(input.id)}` : '/campaigns', input.id ? 'PATCH' : 'POST', input.id ? {revision: input.revision, draft} : draft, signal))
      },
      audience: async () => unsupported('Save the draft, then generate its recipient review. No audience is inferred from partial contact lists.'),
      send: async (input, signal) => {
        if (!input.reviewId || !input.revision) throw new ApiError('Generate a recipient review before sending.', 'REVIEW_REQUIRED')
        const receipt = await call(`/campaigns/${idPath(input.id)}/${input.mode === 'schedule' ? 'schedule' : 'send'}`, 'POST', {reviewId: input.reviewId, revision: input.revision, ...(input.mode === 'schedule' ? {scheduledAt: input.scheduledAt} : {})}, signal)
        return receipt as import('./types').CampaignSendReceipt
      },
      test: async (input, signal) => { const result = await call(`/campaigns/${idPath(input.id)}/test`, 'POST', {to: input.to}, signal); return {accepted: result.status === 'queued', id: result.id, status: result.status, simulated: result.simulated} }
    },
    review: async (id, revision) => ({ ...(await call(`/campaigns/${idPath(id)}/review`, 'POST', {revision})), contacts: [] } as any),
    attachments: {
      get: (id, signal) => call<any>(`/attachments/${idPath(id)}`, 'GET', undefined, signal),
      content: (id, signal) => call<any>(`/attachments/${idPath(id)}/content`, 'GET', undefined, signal),
      upload: async (file, inline) => {
        if (file.size > 8 * 1024 * 1024) throw new ApiError('Attachments must total at most 8 MiB.', 'ATTACHMENT_TOO_LARGE')
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
        return call<any>('/attachments', 'POST', {filename: file.name, contentType: file.type || 'application/octet-stream', content: btoa(binary), ...(inline ? {disposition: 'inline', contentId: inline.contentId} : {})})
      },
      remove: async id => { await call(`/attachments/${idPath(id)}`, 'DELETE') }
    },
    contacts: {
      list: (input, signal) => page('/contacts', input, mapContact, {search: input.search, listId: input.listId, ...(input.status === 'suppressed' ? {suppressed: true} : input.status ? {consent: input.status, suppressed: false} : {})}, signal),
      get: getContact,
      save: async (input, signal) => {
        const current = input.id ? await call(`/contacts/${idPath(input.id)}`, 'GET', undefined, signal) : null
        const body = {name: input.name, properties: {...current?.properties, country: input.country}, ...(!input.id ? {email: input.email} : {})}
        const result = await call(input.id ? `/contacts/${idPath(input.id)}` : '/contacts', input.id ? 'PATCH' : 'POST', body, signal)
        const oldLists: string[] = current?.listIds ?? []
        for (const listId of input.listIds.filter(x => !oldLists.includes(x))) await call(`/lists/${idPath(listId)}/members`, 'POST', {contactIds: [result.id]}, signal)
        for (const listId of oldLists.filter(x => !input.listIds.includes(x))) await call(`/lists/${idPath(listId)}/members/${idPath(result.id)}`, 'DELETE', undefined, signal)
        return getContact(result.id, signal)
      },
      import: async () => unsupported('Upload the original CSV and review the server preview before committing.')
    },
    consent: async (id, input) => mapContact(await call(`/contacts/${idPath(id)}/consent`, 'POST', input)),
    imports: { preview: input => call<any>('/contact-imports', 'POST', input), commit: id => call<any>(`/contact-imports/${idPath(id)}/commit`, 'POST') },
    lists: { list: (input = {}, signal) => page('/lists', input, mapList, {search: input.search}, signal), get: async (id, signal) => mapList(await call(`/lists/${idPath(id)}`, 'GET', undefined, signal)), create: async (input, signal) => mapList(await call('/lists', 'POST', input, signal)) },
    segments: {
      list: (input = {}, signal) => page('/segments', input, mapSegment, {search: input.search}, signal), get: async (id, signal) => mapSegment(await call(`/segments/${idPath(id)}`, 'GET', undefined, signal)),
      save: async (input, signal) => { if (!input.rule) throw new ApiError('Enter a valid public segment rule.', 'RULE_REQUIRED'); return mapSegment(await call(input.id ? `/segments/${idPath(input.id)}` : '/segments', input.id ? 'PATCH' : 'POST', {name: input.name, rule: input.rule}, signal)) },
      preview: async (input, signal) => { if (!input.id) throw new ApiError('Save this segment before previewing.', 'SEGMENT_REQUIRED'); return {...await call(`/segments/${idPath(input.id)}/preview`, 'POST', {}, signal), contacts: []} as any }
    },
    keys: {
      list: async (signal, cursor) => { const result = await keyCall(`/api-keys?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal); return Object.assign(result.data.map((r: Json) => ({...r, permission: r.permissions.includes('manage') ? 'manage' : r.permissions.join(', '), domainId: r.domains.join(', ') || null})), {nextCursor: result.nextCursor}) },
      create: async (input, signal) => { const result = await keyCall('/api-keys', 'POST', {name: input.name, environment: input.environment ?? 'test', permissions: [input.permission], domains: input.domainId ? [input.domainId] : []}, signal); const {secret, ...key} = result; return {key, secret} as any },
      revoke: async (id, signal) => { await keyCall(`/api-keys/${idPath(id)}/revoke`, 'POST', undefined, signal) }
    },
    domains: { list: (input, signal) => page('/domains', input, mapDomain, {region: input.regionId}, signal), get: async (id, signal) => mapDomain(await call(`/domains/${idPath(id)}`, 'GET', undefined, signal)), create: async (input, signal) => mapDomain(await call('/domains', 'POST', {name: input.name, region: input.regionId}, signal)), verify: async (id, signal) => mapDomain(await call(`/domains/${idPath(id)}/verify`, 'POST', undefined, signal)) },
    webhooks: {
      list: async (signal, cursor) => {const result = await call(`/webhooks?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal); return Object.assign(result.data.map(mapWebhook), {nextCursor: result.nextCursor})},
      get: async (id, signal) => { const [row, history] = await Promise.all([call(`/webhooks/${idPath(id)}`, 'GET', undefined, signal), deliveries(id)]); return {...mapWebhook(row), deliveries: history.items, nextCursor: history.nextCursor} },
      save: async (input, signal) => mapWebhook(await call(input.id ? `/webhooks/${idPath(input.id)}` : '/webhooks', input.id ? 'PATCH' : 'POST', {description: input.name, url: input.url, regions: input.regionIds === 'all' ? null : input.regionIds, eventTypes: input.events}, signal)),
      setStatus: async (id, status, signal) => mapWebhook(await call(`/webhooks/${idPath(id)}`, 'PATCH', {paused: status === 'paused'}, signal)),
      test: async (id, signal) => { const queued = await call(`/webhooks/${idPath(id)}/test`, 'POST', undefined, signal); return mapDelivery(await call(`/webhooks/${idPath(id)}/deliveries/${idPath(queued.id)}`, 'GET', undefined, signal)) },
      retry: async (id, deliveryId, signal) => { await call(`/webhooks/${idPath(id)}/deliveries/${idPath(deliveryId)}/retry`, 'POST', undefined, signal); return mapDelivery(await call(`/webhooks/${idPath(id)}/deliveries/${idPath(deliveryId)}`, 'GET', undefined, signal)) },
      rotate: (id, signal) => call<any>(`/webhooks/${idPath(id)}/rotate-secret`, 'POST', undefined, signal), remove: async (id, signal) => { await call(`/webhooks/${idPath(id)}`, 'DELETE', undefined, signal) }
    },
    webhookDeliveries: deliveries
  }
}
