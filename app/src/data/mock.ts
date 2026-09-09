import { ApiError } from './types'
import type { AudienceList, AudiencePreview, Campaign, CampaignEditorMetadata, CampaignInput, Contact, ContactInput, Domain, Email, OpenSendApi, PageRequest, PageResult, RegionCatalog, RegionCatalogEntry, SesDiscovery, Segment, SegmentInput, SegmentRule, Webhook, WebhookDelivery, WebhookEvent } from './types'
import { createSeed } from './seed'
import type { DemoState } from './seed'

const STORAGE_KEY = 'opensend.demo.v1'
const EVENTS: WebhookEvent[] = ['send', 'delivered', 'bounced', 'complaint', 'rejected', 'delivery_delayed', 'email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed', 'email.opened', 'email.clicked', 'contact.subscription_changed']
const CONTACT_STATUSES = ['unknown', 'subscribed', 'unsubscribed', 'suppressed']
const CONNECTABLE_REGIONS: Record<string, string> = {
  'us-east-1': 'US East (N. Virginia)', 'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)', 'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'Europe (Ireland)', 'eu-west-2': 'Europe (London)', 'eu-west-3': 'Europe (Paris)',
  'eu-central-1': 'Europe (Frankfurt)', 'eu-north-1': 'Europe (Stockholm)', 'eu-south-1': 'Europe (Milan)',
  'ap-south-1': 'Asia Pacific (Mumbai)', 'ap-southeast-1': 'Asia Pacific (Singapore)', 'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)', 'ap-northeast-2': 'Asia Pacific (Seoul)', 'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ca-central-1': 'Canada (Central)', 'sa-east-1': 'South America (São Paulo)',
  'af-south-1': 'Africa (Cape Town)', 'me-south-1': 'Middle East (Bahrain)',
}
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
const now = () => new Date().toISOString()
const DISCOVERY_TTL = 15 * 60 * 1000
function demoDiscovery(state: DemoState, region: string, resourcesReady: boolean, subscription: SesDiscovery['resources']['topic']['subscription'] = resourcesReady ? 'confirmed' : 'missing'): SesDiscovery {
  const profile = find(state.regions, region, 'Region')
  const set = (kind: string) => ({ name: `opensend-demo-${kind}`, exists: resourcesReady, owned: resourcesReady, sendingEnabled: resourcesReady, eventDestinationExists: resourcesReady, eventWired: resourcesReady })
  const blockers: SesDiscovery['blockers'] = []
  if (profile.access === 'sandbox') blockers.push({ code: 'SES_SANDBOX', message: 'Demo SES production access is not enabled in this region. Provisioning cannot grant production approval.' })
  if (!profile.sendingEnabled) blockers.push({ code: 'SES_SENDING_DISABLED', message: 'Demo SES account sending is disabled.' })
  if (profile.health !== 'healthy') blockers.push({ code: 'SES_ACCOUNT_ENFORCEMENT', message: 'Demo SES account enforcement status is not healthy.' })
  if (subscription === 'pending') blockers.push({ code: 'SNS_CONFIRMATION_PENDING', message: 'Demo SNS subscription confirmation is pending. Poll the catalog again to advance the simulation.' })
  const provisioned = resourcesReady && subscription === 'confirmed'
  return {
    region, checkedAt: now(), account: { id: '123456789012', productionAccess: profile.access === 'production', sendingEnabled: profile.sendingEnabled, enforcementStatus: profile.health.toUpperCase(), quota: { max24HourSend: profile.dailyQuota, maxSendRate: profile.maxSendRate, sentLast24Hours: profile.sent24h } },
    domains: state.domains.filter(domain => domain.regionId === region).map(domain => ({ name: domain.name, verificationStatus: domain.status === 'verified' ? 'SUCCESS' : domain.status === 'issue' ? 'FAILED' : 'PENDING', sendingEnabled: domain.status === 'verified' })), identitiesTruncated: false,
    resources: { transactional: set('transactional'), marketing: set('marketing'), eventDestinationName: 'opensend-demo-events', topic: { name: 'opensend-demo-feedback', arn: resourcesReady ? `arn:aws:sns:${region}:123456789012:opensend-demo-feedback` : null, exists: resourcesReady, owned: resourcesReady, policyReady: resourcesReady, subscription, rawMessageDelivery: subscription === 'confirmed' ? false : null, subscriptionsTruncated: false, staleSubscriptions: 0 } },
    feedbackUrl: 'https://demo.example.invalid/v1/events/ses', status: blockers.length ? 'blocked' : provisioned ? 'ready' : 'needs_provisioning', provisioned, blockers,
    warnings: [{ code: 'DEMO_SIMULATION', message: 'Simulated discovery only. No AWS resources, DNS records, subscriptions, or email are changed.' }],
  }
}
function regionSetup(state: DemoState): NonNullable<DemoState['regionSetup']> {
  if (!state.regionSetup) {
    const reports = Object.fromEntries(state.regions.map(region => [region.id, demoDiscovery(state, region.id, true)]))
    state.regionSetup = { catalog: { defaultRegion: state.regions[0]!.id, data: state.regions.map((region, index) => ({ region: region.id, enabled: true, isDefault: index === 0, discoveryStatus: reports[region.id]!.status, lastDiscoveredAt: reports[region.id]!.checkedAt, provisionJobId: null, provisionStatus: null, provisionError: null })) }, reports }
  }
  return state.regionSetup
}
function enabledRegion(state: DemoState, region: string): RegionCatalogEntry {
  const row = regionSetup(state).catalog.data.find(row => row.region === region)
  if (!row?.enabled) throw new ApiError('Enable this SES region before continuing.', 'REGION_NOT_CONFIGURED', { region: 'This region is disabled or not configured.' })
  return row
}
function saveDiscovery(state: DemoState, report: SesDiscovery) {
  const setup = regionSetup(state)
  setup.reports[report.region] = report
  const row = setup.catalog.data.find(row => row.region === report.region)!
  row.discoveryStatus = report.status; row.lastDiscoveredAt = report.checkedAt
  return report
}
function catalog(state: DemoState, advance = false): RegionCatalog {
  const setup = regionSetup(state)
  for (const row of setup.catalog.data) {
    // Only catalog polling advances explicitly queued demo jobs; discovery never provisions.
    if (advance && row.provisionStatus === 'pending') {
      row.provisionStatus = 'running'
      saveDiscovery(state, demoDiscovery(state, row.region, true, 'pending'))
    } else if (advance && row.provisionStatus === 'running') {
      row.provisionStatus = 'completed'
      saveDiscovery(state, demoDiscovery(state, row.region, true, 'confirmed'))
    }
    if (row.lastDiscoveredAt && Date.now() - Date.parse(row.lastDiscoveredAt) >= DISCOVERY_TTL) row.discoveryStatus = 'stale'
  }
  return setup.catalog
}
const invalid = (field: string, message: string): never => { throw new ApiError(message, 'validation', { [field]: message }) }
function text(value: unknown, field: string, max = 200, optional = false): string {
  if (typeof value !== 'string') return invalid(field, `${field} must be text.`)
  const result = value.trim()
  if (!optional && !result) return invalid(field, `${field} is required.`)
  if (result.length > max) return invalid(field, `${field} must be ${max} characters or fewer.`)
  return result
}
function email(value: unknown, field = 'email'): string {
  const result = text(value, field, 254).toLowerCase()
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result)) return invalid(field, 'Enter a valid email address.')
  return result
}
function domainName(value: unknown): string {
  const result = text(value, 'name', 253).toLowerCase()
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(result)) return invalid('name', 'Enter a valid domain name without a protocol or path.')
  return result
}
function find<T extends { id: string }>(items: T[], value: string, label: string): T {
  const item = items.find(row => row.id === value)
  if (!item) throw new ApiError(`${label} “${value}” was not found.`, 'not_found')
  return item
}
function checkRegion(state: DemoState, regionId: string) { return find(state.regions, regionId, 'Region') }
function filterRegion(state: DemoState, regionId?: string) { if (regionId !== undefined) checkRegion(state, regionId) }
function page<T>(items: T[], input: PageRequest = {}, searchable: (item: T) => string = () => '', facets?: Record<string, number>): PageResult<T> {
  const current = input.page ?? 1
  const size = input.pageSize ?? 20
  if (!Number.isInteger(current) || current < 1) invalid('page', 'Page must be a positive integer.')
  if (!Number.isInteger(size) || size < 1 || size > 1000) invalid('pageSize', 'Page size must be between 1 and 1000.')
  const search = text(input.search ?? '', 'search', 1000, true).toLowerCase()
  const filtered = search ? items.filter(item => searchable(item).toLowerCase().includes(search)) : items
  return { items: filtered.slice((current - 1) * size, current * size), total: filtered.length, page: current, pageSize: size, ...(facets ? { facets } : {}) }
}
function validateListIds(state: DemoState, input: unknown): string[] {
  if (!Array.isArray(input) || !input.every((value: unknown) => typeof value === 'string')) return invalid('listIds', 'List membership must be an array of list IDs.')
  const ids = [...new Set(input as string[])]
  ids.forEach(value => find(state.lists, value, 'List'))
  return ids
}
function country(value: unknown, optional = false): string {
  const result = text(value, 'country', 2, optional).toUpperCase()
  if (result && !/^[A-Z]{2}$/.test(result)) invalid('country', 'Use a two-letter country code.')
  return result
}
function validateSegment(state: DemoState, input: SegmentInput): SegmentInput {
  const name = text(input.name, 'name')
  if (input.match !== 'all' && input.match !== 'any') invalid('match', 'Choose all or any rules.')
  if (!Array.isArray(input.rules) || input.rules.length < 1 || input.rules.length > 20) invalid('rules', 'Add between 1 and 20 rules.')
  const ids = new Set<string>()
  const rules = input.rules.map((rule, index): SegmentRule => {
    const field = `rules.${index}`
    const ruleId = text(rule.id, `${field}.id`)
    if (ids.has(ruleId)) invalid(`${field}.id`, 'Rule IDs must be unique.')
    ids.add(ruleId)
    if (!['status', 'country', 'listId', 'lastOpenedAt'].includes(rule.field)) invalid(field, 'Choose a supported rule field.')
    let value = text(rule.value, `${field}.value`)
    if (rule.field === 'lastOpenedAt') {
      if (rule.operator !== 'within_days' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 3650) invalid(field, 'Last opened requires within_days and 1–3650 days.')
    } else {
      if (rule.operator !== 'is' && rule.operator !== 'is_not') invalid(field, 'This field supports is or is_not.')
      if (rule.field === 'status' && !CONTACT_STATUSES.includes(value)) invalid(field, 'Choose a valid contact status.')
      if (rule.field === 'country') value = country(value)
      if (rule.field === 'listId') find(state.lists, value, 'List')
    }
    return { id: ruleId, field: rule.field, operator: rule.operator, value }
  })
  return { ...(input.id ? { id: input.id } : {}), name, match: input.match, rules }
}
function matchesRule(contact: Contact, rule: SegmentRule, time: number): boolean {
  if (rule.field === 'lastOpenedAt') {
    if (!contact.lastOpenedAt) return false
    const opened = Date.parse(contact.lastOpenedAt)
    return opened <= time && opened >= time - Number(rule.value) * 86_400_000
  }
  const matches = rule.field === 'listId' ? contact.listIds.includes(rule.value) : contact[rule.field] === rule.value
  return rule.operator === 'is_not' ? !matches : matches
}
function segmentContacts(state: DemoState, segment: SegmentInput): Contact[] {
  const time = Date.now()
  return state.contacts.filter(contact => segment.match === 'all' ? segment.rules.every(rule => matchesRule(contact, rule, time)) : segment.rules.some(rule => matchesRule(contact, rule, time)))
}
function audience(contacts: Contact[]): AudiencePreview {
  return { matched: contacts.length, eligible: contacts.filter(c => c.status === 'subscribed').length, suppressed: contacts.filter(c => c.status === 'suppressed').length, unsubscribed: contacts.filter(c => c.status === 'unsubscribed').length, contacts }
}
function campaignAudience(state: DemoState, listId: string, segmentId: string | null): AudiencePreview {
  find(state.lists, listId, 'List')
  const contacts = segmentId ? segmentContacts(state, find(state.segments, segmentId, 'Segment')) : state.contacts
  return audience(contacts.filter(contact => contact.listIds.includes(listId)))
}
function listTotals(state: DemoState, list: AudienceList): AudienceList {
  const result = audience(state.contacts.filter(contact => contact.listIds.includes(list.id)))
  return { ...list, total: result.matched, subscribed: result.eligible, unsubscribed: result.unsubscribed, suppressed: result.suppressed }
}
function segmentTotals(state: DemoState, segment: Segment): Segment {
  const result = audience(segmentContacts(state, segment))
  return { ...segment, matched: result.matched, eligible: result.eligible }
}
function campaignTotals(state: DemoState, campaign: Campaign): Campaign {
  return { ...campaign, archivedAt: campaign.archivedAt ?? null, ...(campaign.status === 'sent' ? {} : { recipients: campaignAudience(state, campaign.listId, campaign.segmentId).eligible }) }
}
function requireUnarchived(campaign: Campaign) {
  if (campaign.archivedAt != null) throw new ApiError('Restore this campaign before editing, reviewing, testing, or sending it.', 'CAMPAIGN_ARCHIVED', {}, undefined, 409)
}
function validateSender(state: DemoState, campaign: CampaignInput) {
  const senderDomain = campaign.fromEmail.split('@')[1]
  if (!state.domains.some(domain => domain.regionId === campaign.regionId && domain.status === 'verified' && domain.name === senderDomain)) invalid('fromEmail', 'Verify the sender domain in this region before sending.')
}
function validateEditor(value: unknown): CampaignEditorMetadata | null {
  if (value === null) return null
  const ancestors = new Set<object>()
  let nodes = 0
  let characters = 0
  function copy(value: unknown, depth: number): unknown {
    if (depth > 50) invalid('editor', 'Editor data must be no more than 50 levels deep.')
    if (++nodes > 5000) invalid('editor', 'Editor data must contain no more than 5,000 values.')
    if (typeof value === 'string') {
      characters += value.length
      if (characters > 262_144) invalid('editor', 'Editor data must serialize to 262,144 characters or fewer.')
      return value
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
    if (typeof value !== 'object') return invalid('editor', 'Editor data must contain only plain JSON values.')
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid('editor', 'Editor data must contain only plain JSON objects and arrays.')
    if (ancestors.has(value)) invalid('editor', 'Editor data cannot contain circular references.')
    ancestors.add(value)
    const keys = Reflect.ownKeys(value)
    if (keys.length > 5001 || (array && value.length > 5000)) invalid('editor', 'Editor data must contain no more than 5,000 values.')
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null)
    let entries = 0
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string') return invalid('editor', 'Editor data cannot contain symbol keys.')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!descriptor.enumerable || !('value' in descriptor)) invalid('editor', 'Editor data cannot contain accessors or hidden properties.')
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid('editor', 'Editor arrays cannot contain named properties.')
      if (!array) characters += key.length
      if (characters > 262_144) invalid('editor', 'Editor data must serialize to 262,144 characters or fewer.')
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true })
      entries++
    }
    if (array && entries !== value.length) invalid('editor', 'Editor arrays cannot contain empty slots.')
    ancestors.delete(value)
    return result
  }
  // Copy inert JSON only; never call toJSON, an accessor, an editor, or a renderer.
  const clean = copy(value, 0)
  if (!isRecord(clean) || clean.format !== 'react-email' || clean.version !== 1) return invalid('editor', 'Editor data must use react-email format version 1.')
  if (!isRecord(clean.document) || clean.document.type !== 'doc' || (Object.hasOwn(clean.document, 'content') && !Array.isArray(clean.document.content))) invalid('editor', 'Editor document must have type “doc” and an optional content array.')
  const serialized = JSON.stringify(clean)
  if (serialized.length > 262_144) invalid('editor', 'Editor data must serialize to 262,144 characters or fewer.')
  return JSON.parse(serialized) as CampaignEditorMetadata
}
function validEditor(value: unknown): boolean {
  if (value === undefined) return true
  try { validateEditor(value); return true } catch { return false }
}
function validateCampaign(state: DemoState, input: CampaignInput): CampaignInput {
  enabledRegion(state, input.regionId)
  checkRegion(state, input.regionId)
  find(state.lists, input.listId, 'List')
  if (input.segmentId !== null) find(state.segments, input.segmentId, 'Segment')
  return { ...(input.id ? { id: input.id } : {}), regionId: input.regionId, name: text(input.name, 'name'), subject: text(input.subject, 'subject', 998), previewText: text(input.previewText, 'previewText', 200, true), fromName: text(input.fromName, 'fromName'), fromEmail: email(input.fromEmail, 'fromEmail'), listId: input.listId, segmentId: input.segmentId, html: text(input.html, 'html', 500_000), ...(input.editor !== undefined ? { editor: validateEditor(input.editor) } : {}) }
}
function validDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6] ?? 0) < 60 && Number(match[8] ?? 0) < 24 && Number(match[9] ?? 0) < 60 && Number.isFinite(Date.parse(value))
}
function delay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('The operation was aborted.', 'AbortError')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 120)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

// Validate persisted structure and references before admitting it into the adapter.
// Corrupt or obsolete snapshots are reset as a whole, never partially merged.
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function validSnapshot(value: unknown): value is DemoState {
  if (!isRecord(value) || value.version !== 1) return false
  const arrays = ['regions', 'contacts', 'lists', 'segments', 'emails', 'campaigns', 'domains', 'keys', 'webhooks']
  if (!arrays.every(key => Array.isArray(value[key]) && value[key].every(isRecord))) return false
  const rows = (key: string) => value[key] as Record<string, unknown>[]
  const strings = (row: Record<string, unknown>, keys: string[]) => keys.every(key => typeof row[key] === 'string')
  const numbers = (row: Record<string, unknown>, keys: string[]) => keys.every(key => typeof row[key] === 'number' && Number.isFinite(row[key]))
  const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
  const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
  const records = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every(isRecord)
  if (!arrays.every(key => rows(key).every(row => typeof row.id === 'string') && new Set(rows(key).map(row => row.id)).size === rows(key).length)) return false
  const references = (key: string, ref: unknown) => rows(key).some(row => row.id === ref)
  if (value.regionSetup !== undefined) {
    const setup = value.regionSetup
    const nullableString = (v: unknown) => v === null || typeof v === 'string'
    const flag = (v: unknown) => v === null || typeof v === 'boolean'
    const nullableNumber = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v))
    const issues = (v: unknown) => records(v) && v.every(issue => strings(issue, ['code', 'message']))
    const set = (v: unknown) => isRecord(v) && strings(v, ['name']) && ['exists', 'owned', 'sendingEnabled', 'eventDestinationExists', 'eventWired'].every(key => flag(v[key]))
    if (!isRecord(setup) || !isRecord(setup.catalog) || !isRecord(setup.reports)) return false
    const catalog = setup.catalog
    if (!records(catalog.data)) return false
    if (!references('regions', catalog.defaultRegion) || catalog.data.length !== rows('regions').length || new Set(catalog.data.map(row => row.region)).size !== catalog.data.length || !catalog.data.every(row => references('regions', row.region) && typeof row.enabled === 'boolean' && row.isDefault === (row.region === catalog.defaultRegion) && (row.region !== catalog.defaultRegion || row.enabled) && ['not_discovered', 'stale', 'ready', 'needs_provisioning', 'blocked'].includes(String(row.discoveryStatus)) && (row.lastDiscoveredAt === null || date(row.lastDiscoveredAt)) && nullableString(row.provisionJobId) && nullableString(row.provisionError) && (row.provisionStatus === null || ['pending', 'running', 'completed', 'failed'].includes(String(row.provisionStatus))))) return false
    for (const [region, report] of Object.entries(setup.reports)) {
      if (!references('regions', region) || !isRecord(report) || report.region !== region || !date(report.checkedAt) || !['ready', 'needs_provisioning', 'blocked'].includes(String(report.status)) || typeof report.provisioned !== 'boolean' || typeof report.identitiesTruncated !== 'boolean' || !nullableString(report.feedbackUrl) || !issues(report.blockers) || !issues(report.warnings)) return false
      if (report.account !== null && (!isRecord(report.account) || !strings(report.account, ['id']) || !flag(report.account.productionAccess) || !flag(report.account.sendingEnabled) || !nullableString(report.account.enforcementStatus) || !isRecord(report.account.quota) || !['max24HourSend', 'maxSendRate', 'sentLast24Hours'].every(key => nullableNumber((report.account as Record<string, any>).quota[key])))) return false
      if (!records(report.domains) || !report.domains.every(domain => strings(domain, ['name']) && nullableString(domain.verificationStatus) && flag(domain.sendingEnabled))) return false
      if (!isRecord(report.resources) || !set(report.resources.transactional) || !set(report.resources.marketing) || !strings(report.resources, ['eventDestinationName']) || !isRecord(report.resources.topic)) return false
      const topic = report.resources.topic
      if (!strings(topic, ['name']) || !nullableString(topic.arn) || !['exists', 'owned', 'policyReady', 'rawMessageDelivery'].every(key => flag(topic[key])) || !['unknown', 'missing', 'pending', 'confirmed'].includes(String(topic.subscription)) || typeof topic.subscriptionsTruncated !== 'boolean' || typeof topic.staleSubscriptions !== 'number' || !Number.isInteger(topic.staleSubscriptions)) return false
    }
  }
  const workspace = value.workspace
  if (!isRecord(workspace) || !strings(workspace, ['id', 'name', 'accountId', 'role']) || !records(workspace.members) || !workspace.members.every(member => strings(member, ['id', 'name', 'email', 'role']))) return false
  if (!rows('regions').length || !rows('regions').every(row => strings(row, ['name', 'access', 'health', 'ipPool']) && ['production', 'sandbox'].includes(String(row.access)) && ['healthy', 'probation', 'shutdown'].includes(String(row.health)) && numbers(row, ['sent24h', 'dailyQuota', 'maxSendRate', 'bounceRate', 'complaintRate']) && typeof row.sendingEnabled === 'boolean' && typeof row.vdmEnabled === 'boolean' && stringArray(row.suppression))) return false
  if (!rows('lists').every(row => strings(row, ['name']) && numbers(row, ['total', 'subscribed', 'unsubscribed', 'suppressed']) && date(row.createdAt))) return false
  if (!rows('contacts').every(row => strings(row, ['email', 'name', 'country', 'status']) && CONTACT_STATUSES.includes(String(row.status)) && stringArray(row.listIds) && row.listIds.every(ref => references('lists', ref)) && date(row.createdAt) && (row.lastOpenedAt === null || date(row.lastOpenedAt)) && isRecord(row.consent) && strings(row.consent, ['source']) && (row.consent.at === null || date(row.consent.at)))) return false
  if (!rows('segments').every(row => strings(row, ['name']) && ['all', 'any'].includes(String(row.match)) && date(row.updatedAt) && numbers(row, ['matched', 'eligible']) && records(row.rules) && row.rules.length > 0 && row.rules.every(rule => strings(rule, ['id', 'field', 'operator', 'value']) && ['status', 'country', 'listId', 'lastOpenedAt'].includes(String(rule.field)) && ['is', 'is_not', 'within_days'].includes(String(rule.operator)) && (rule.field !== 'listId' || references('lists', rule.value))))) return false
  if (!rows('emails').every(row => strings(row, ['to', 'from', 'subject', 'html']) && references('regions', row.regionId) && ['transactional', 'marketing'].includes(String(row.stream)) && ['delivered', 'bounced', 'complaint', 'deferred', 'rejected'].includes(String(row.status)) && date(row.sentAt) && records(row.events) && row.events.every(event => strings(event, ['id', 'type', 'description']) && date(event.at)))) return false
  if (!rows('campaigns').every(row => strings(row, ['name', 'subject', 'previewText', 'fromName', 'fromEmail', 'html', 'timezone']) && references('regions', row.regionId) && references('lists', row.listId) && (row.segmentId === null || references('segments', row.segmentId)) && ['draft', 'scheduled', 'sent'].includes(String(row.status)) && date(row.createdAt) && date(row.updatedAt) && (row.scheduledAt === null || date(row.scheduledAt)) && (row.archivedAt === undefined || row.archivedAt === null || date(row.archivedAt)) && numbers(row, ['recipients', 'delivered', 'bounced', 'complaints']) && validEditor(row.editor))) return false
  if (!rows('domains').every(row => strings(row, ['name']) && references('regions', row.regionId) && ['verified', 'pending', 'issue'].includes(String(row.status)) && ['verified', 'pending'].includes(String(row.mailFromStatus)) && date(row.createdAt) && records(row.records) && row.records.every(record => strings(record, ['id', 'name', 'value']) && ['TXT', 'CNAME', 'MX'].includes(String(record.type)) && ['verified', 'pending'].includes(String(record.status))))) return false
  if (!rows('keys').every(row => strings(row, ['name', 'prefix']) && String(row.prefix).startsWith('demo_') && ['send', 'read'].includes(String(row.permission)) && stringArray(row.domains) && row.domains.every(name => rows('domains').some(domain => domain.name === name)) && date(row.createdAt) && (row.lastUsedAt === null || date(row.lastUsedAt)))) return false
  return rows('webhooks').every(row => strings(row, ['name', 'url', 'secretHint']) && String(row.secretHint).startsWith('demo_') && ['active', 'paused'].includes(String(row.status)) && (row.regionIds === 'all' || (stringArray(row.regionIds) && row.regionIds.length > 0 && row.regionIds.every(ref => references('regions', ref)))) && stringArray(row.events) && row.events.length > 0 && row.events.every(event => EVENTS.includes(event as WebhookEvent)) && records(row.deliveries) && row.deliveries.every(delivery => strings(delivery, ['id']) && date(delivery.at) && references('regions', delivery.regionId) && EVENTS.includes(delivery.event as WebhookEvent) && numbers(delivery, ['response', 'attempts']) && ['delivered', 'retry_pending'].includes(String(delivery.status)) && isRecord(delivery.payload)))
}

export function createMockApi(): OpenSendApi {
  let state = createSeed()
  let storage: Storage | undefined
  let storageError = false
  try {
    // A non-browser runtime can use the same adapter in memory for direct checks.
    storage = typeof localStorage === 'undefined' ? undefined : localStorage
    const stored = storage?.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed: unknown = JSON.parse(stored)
        // Preserve legacy restrictions by resolving IDs, never by defaulting missing domains to all.
        if (isRecord(parsed) && Array.isArray(parsed.keys) && Array.isArray(parsed.domains)) {
          const domains = parsed.domains.filter(isRecord)
          for (const key of parsed.keys.filter(isRecord)) {
            if (Object.hasOwn(key, 'domains')) continue
            if (key.domainId === null) key.domains = []
            else {
              const domain = domains.find(domain => domain.id === key.domainId)
              if (typeof domain?.name === 'string') key.domains = [domain.name]
            }
            if (Array.isArray(key.domains)) delete key.domainId
          }
        }
        if (!validSnapshot(parsed)) throw new Error('Invalid demo snapshot')
        state = parsed
      } catch {
        console.warn('OpenSend demo data was invalid or outdated. Using a fresh demo dataset.')
      }
    }
  } catch { storageError = true }
  async function run<T>(signal: AbortSignal | undefined, mutate: boolean, operation: (draft: DemoState) => T): Promise<T> {
    await delay(signal)
    if (storageError) throw new ApiError('Demo storage is unavailable. Allow local storage and reload to continue.', 'unavailable')
    const draft = clone(state)
    const result = operation(draft)
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (mutate) {
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(draft)) }
      catch { throw new ApiError('Could not save demo changes to local storage. Free storage space or enable local storage, then try again.', 'unavailable') }
      state = draft
    }
    return clone(result)
  }
  return {
    mode: 'demo',
    regions: {
      list: signal => run(signal, true, s => catalog(s, true)),
      configure: (region, input, signal) => run(signal, true, s => {
        if (region.length > 32 || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) || /^(cn-|us-gov-|us-iso)/.test(region)) invalid('region', 'Enter a commercial AWS region ID, such as ap-southeast-1.')
        if (!isRecord(input) || Object.keys(input).some(key => !['enabled', 'makeDefault'].includes(key)) || (input.enabled !== undefined && typeof input.enabled !== 'boolean') || (input.makeDefault !== undefined && typeof input.makeDefault !== 'boolean') || (input.enabled === undefined && input.makeDefault !== true)) invalid('region', 'Choose enabled or makeDefault.')
        const setup = regionSetup(s)
        let row = setup.catalog.data.find(row => row.region === region)
        if (input.enabled === false) {
          if (setup.catalog.defaultRegion === region || input.makeDefault) throw new ApiError('Choose another default region before disabling this one.', 'REGION_DEFAULT_REQUIRED')
          if (s.emails.some(email => email.regionId === region && ['queued', 'attempting', 'acceptance_unknown'].includes(email.status)) || s.campaigns.some(campaign => campaign.regionId === region && ['scheduled', 'sending'].includes(campaign.status)) || (row?.provisionStatus && ['pending', 'running'].includes(row.provisionStatus))) throw new ApiError('This region has queued, in-flight, or uncertain work. Resolve it before disabling the region.', 'REGION_IN_USE')
        }
        if (!row) {
          if (setup.catalog.data.length >= 40) throw new ApiError('At most 40 SES regions may be configured.', 'REGION_LIMIT_EXCEEDED')
          // Keep internal quota/history profiles; configuration never grants production access.
          s.regions.push({ id: region, name: CONNECTABLE_REGIONS[region] ?? region, access: 'sandbox', health: 'healthy', sendingEnabled: true, sent24h: 0, dailyQuota: 200, maxSendRate: 1, bounceRate: 0, complaintRate: 0, suppression: ['BOUNCE', 'COMPLAINT'], ipPool: 'Shared', vdmEnabled: false })
          row = { region, enabled: false, isDefault: false, discoveryStatus: 'not_discovered', lastDiscoveredAt: null, provisionJobId: null, provisionStatus: null, provisionError: null }
          setup.catalog.data.push(row)
        }
        if (input.enabled !== undefined) row.enabled = input.enabled
        if (input.makeDefault) {
          row.enabled = true; setup.catalog.defaultRegion = region
          setup.catalog.data.forEach(entry => { entry.isDefault = entry.region === region })
        }
        return catalog(s)
      }),
      discover: (region, options, signal) => run(signal, true, s => {
        enabledRegion(s, region)
        const cached = regionSetup(s).reports[region]
        if (cached && !options?.refresh && Date.now() - Date.parse(cached.checkedAt) < DISCOVERY_TTL) return cached
        // Read-only simulation: refresh account observations while retaining resource state.
        return saveDiscovery(s, demoDiscovery(s, region, cached?.resources.transactional.exists === true && cached.resources.marketing.exists === true && cached.resources.topic.exists === true, cached?.resources.topic.subscription ?? 'missing'))
      }),
      provision: (region, signal) => run(signal, true, s => {
        const row = enabledRegion(s, region)
        if (row.provisionJobId && (row.provisionStatus === 'pending' || row.provisionStatus === 'running')) return { jobId: row.provisionJobId, status: row.provisionStatus }
        row.provisionJobId = id('demo_job'); row.provisionStatus = 'pending'; row.provisionError = null
        return { jobId: row.provisionJobId, status: 'pending' as const }
      }),
    },
    workspace: {
      get: signal => run(signal, false, s => s.workspace),
      update: (input, signal) => run(signal, true, s => { s.workspace.name = text(input.name, 'name', 100); return s.workspace }),
    },
    overview: {
      get: (input, signal) => run(signal, false, s => {
        checkRegion(s, input.regionId)
        if (!['24h', '7d', '30d'].includes(input.range)) invalid('range', 'Choose 24h, 7d, or 30d.')
        if (input.stream !== undefined && !['transactional', 'marketing'].includes(input.stream)) invalid('stream', 'Choose a valid email stream.')
        const duration = (input.range === '24h' ? 1 : input.range === '7d' ? 7 : 30) * 86_400_000
        const end = Date.now()
        const start = end - duration
        const all = s.emails.filter(e => e.regionId === input.regionId && (!input.stream || e.stream === input.stream))
        const emails = all.filter(e => Date.parse(e.sentAt) >= start && Date.parse(e.sentAt) <= end)
        const count = (status: Email['status']) => emails.filter(e => e.status === status).length
        const buckets = input.range === '24h' ? 24 : input.range === '7d' ? 7 : 30
        const points = Array.from({ length: buckets }, (_, i) => {
          const from = start + i * duration / buckets
          const to = start + (i + 1) * duration / buckets
          const rows = emails.filter(e => Date.parse(e.sentAt) >= from && (i === buckets - 1 ? Date.parse(e.sentAt) <= to : Date.parse(e.sentAt) < to))
          return { at: new Date(from).toISOString(), sent: rows.length, delivered: rows.filter(e => e.status === 'delivered').length, bounced: rows.filter(e => e.status === 'bounced').length, complaints: rows.filter(e => e.status === 'complaint').length }
        })
        return { periodStart: new Date(start).toISOString(), periodEnd: new Date(end).toISOString(), sent: emails.length, delivered: count('delivered'), bounced: count('bounced'), complaints: count('complaint'), deferred: count('deferred'), previousSent: all.filter(e => Date.parse(e.sentAt) >= start - duration && Date.parse(e.sentAt) < start).length, points, streams: (['transactional', 'marketing'] as const).map(name => ({ name, sent: emails.filter(e => e.stream === name).length })), recentCampaigns: s.campaigns.filter(c => c.regionId === input.regionId && c.archivedAt == null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4).map(c => campaignTotals(s, c)) }
      }),
    },
    emails: {
      list: (input, signal) => run(signal, false, s => { filterRegion(s, input.regionId); const rows = s.emails.filter(e => (!input.regionId || e.regionId === input.regionId) && (!input.status || e.status === input.status) && (!input.stream || e.stream === input.stream)).sort((a, b) => b.sentAt.localeCompare(a.sentAt)); return page(rows, input, e => `${e.id} ${e.to} ${e.from} ${e.subject}`) }),
      get: (emailId, signal) => run(signal, false, s => find(s.emails, emailId, 'Email')),
    },
    campaigns: {
      list: (input, signal) => run(signal, false, s => { filterRegion(s, input.regionId); return page(s.campaigns.filter(c => (c.archivedAt != null) === (input.archived === true) && (!input.regionId || c.regionId === input.regionId) && (!input.status || c.status === input.status) && (!input.listId || c.listId === input.listId) && (!input.segmentId || c.segmentId === input.segmentId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(c => campaignTotals(s, c)), input, c => `${c.name} ${c.subject}`) }),
      get: (campaignId, signal) => run(signal, false, s => campaignTotals(s, find(s.campaigns, campaignId, 'Campaign'))),
      setArchived: (input, signal) => run(signal, true, s => {
        const campaign = find(s.campaigns, input.id, 'Campaign')
        if (typeof input.archived !== 'boolean') invalid('archived', 'Choose whether to archive or restore the campaign.')
        if (input.archived && ['scheduled', 'sending'].includes(campaign.status)) throw new ApiError('Scheduled or sending campaigns cannot be archived.', 'CAMPAIGN_ACTIVE', {}, undefined, 409)
        if ((campaign.archivedAt != null) !== input.archived) {
          campaign.updatedAt = now()
          campaign.archivedAt = input.archived ? campaign.updatedAt : null
        }
        return campaignTotals(s, campaign)
      }),
      save: (input, signal) => run(signal, true, s => {
        const existing = input.id ? find(s.campaigns, input.id, 'Campaign') : undefined
        if (existing) requireUnarchived(existing)
        if (existing && existing.status !== 'draft') throw new ApiError('Only draft campaigns can be edited.', 'conflict')
        if (existing && existing.regionId !== input.regionId) invalid('regionId', 'A campaign cannot be moved between regions.')
        const clean = validateCampaign(s, input)
        const campaign: Campaign = { id: existing?.id ?? id('cmp'), status: 'draft', createdAt: existing?.createdAt ?? now(), updatedAt: now(), scheduledAt: null, archivedAt: existing?.archivedAt ?? null, timezone: existing?.timezone ?? 'UTC', recipients: 0, delivered: 0, bounced: 0, complaints: 0, ...(existing?.editor !== undefined ? { editor: existing.editor } : {}), ...clean }
        campaign.recipients = campaignAudience(s, campaign.listId, campaign.segmentId).eligible
        if (existing) Object.assign(existing, campaign)
        else s.campaigns.push(campaign)
        return campaign
      }),
      audience: (input, signal) => run(signal, false, s => campaignAudience(s, input.listId, input.segmentId)),
      send: (input, signal) => run(signal, true, s => {
        const campaign = find(s.campaigns, input.id, 'Campaign')
        requireUnarchived(campaign)
        if (campaign.status !== 'draft') throw new ApiError('This campaign has already been sent or scheduled.', 'conflict')
        if (input.mode !== 'now' && input.mode !== 'schedule') invalid('mode', 'Choose send now or schedule.')
        const timezone = text(input.timezone, 'timezone', 100)
        try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format() } catch { invalid('timezone', 'Choose a valid IANA timezone.') }
        let scheduledAt: string | null = null
        if (input.mode === 'schedule') {
          const value = text(input.scheduledAt, 'scheduledAt', 50)
          const timestamp = Date.parse(value)
          if (!validDateTime(value) || timestamp <= Date.now()) invalid('scheduledAt', 'Schedule a valid future date and time, including its timezone.')
          scheduledAt = new Date(timestamp).toISOString()
        }
        validateCampaign(s, campaign)
        const region = checkRegion(s, campaign.regionId)
        if (region.access === 'sandbox') throw new ApiError('Campaign sending is unavailable in sandbox regions. Choose a production region.', 'validation', { regionId: 'Sandbox regions cannot send campaigns.' })
        if (!region.sendingEnabled || region.health === 'shutdown') throw new ApiError('Sending is disabled in this region.', 'conflict')
        validateSender(s, campaign)
        const result = campaignAudience(s, campaign.listId, campaign.segmentId)
        if (result.eligible === 0) invalid('listId', 'This audience has no subscribed, eligible contacts.')
        if (region.sent24h + result.eligible > region.dailyQuota) throw new ApiError('The campaign exceeds the remaining regional daily sending quota.', 'conflict')
        campaign.status = input.mode === 'now' ? 'sent' : 'scheduled'
        campaign.scheduledAt = scheduledAt
        campaign.timezone = timezone
        campaign.recipients = result.eligible
        campaign.updatedAt = now()
        if (input.mode === 'now') {
          campaign.delivered = result.eligible
          region.sent24h += result.eligible
          for (const contact of result.contacts.filter(c => c.status === 'subscribed')) {
            const emailId = id('em')
            s.emails.push({ id: emailId, regionId: campaign.regionId, to: contact.email, from: campaign.fromEmail, subject: campaign.subject, html: campaign.html, stream: 'marketing', status: 'delivered', sentAt: campaign.updatedAt, events: [{ id: `${emailId}_send`, type: 'send', at: campaign.updatedAt, description: 'Demo campaign send simulated; no email was transmitted.' }, { id: `${emailId}_delivered`, type: 'delivered', at: campaign.updatedAt, description: 'Demo delivery simulated.' }] })
          }
        }
        return campaign
      }),
      test: (input, signal) => run(signal, false, s => {
        const campaign = find(s.campaigns, input.id, 'Campaign')
        requireUnarchived(campaign)
        const to = email(input.to, 'to')
        enabledRegion(s, campaign.regionId)
        const region = checkRegion(s, campaign.regionId)
        if (!region.sendingEnabled || region.health === 'shutdown') throw new ApiError('Sending is disabled in this region.', 'conflict')
        if (region.access === 'sandbox' && !s.domains.some(d => d.regionId === region.id && d.status === 'verified' && d.name === to.split('@')[1])) invalid('to', 'Sandbox test recipients must use a domain verified in this region.')
        validateSender(s, campaign)
        return { accepted: true }
      }),
    },
    contacts: {
      list: (input, signal) => run(signal, false, s => {
        filterRegion(s, input.regionId)
        if (input.listId) find(s.lists, input.listId, 'List')
        const contacts = input.segmentId ? segmentContacts(s, find(s.segments, input.segmentId, 'Segment')) : s.contacts
        return page(contacts.filter(c => (!input.status || c.status === input.status) && (!input.listId || c.listIds.includes(input.listId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), input, c => `${c.email} ${c.name} ${c.country}`)
      }),
      get: (contactId, signal) => run(signal, false, s => find(s.contacts, contactId, 'Contact')),
      save: (input: ContactInput, signal) => run(signal, true, s => {
        const existing = input.id ? find(s.contacts, input.id, 'Contact') : undefined
        const address = email(input.email)
        if (s.contacts.some(c => c.email.toLowerCase() === address && c.id !== existing?.id)) throw new ApiError('A contact with this email already exists.', 'conflict', { email: 'This email is already in your audience.' })
        if (!CONTACT_STATUSES.includes(input.status)) invalid('status', 'Choose a valid subscription status.')
        if (existing?.status === 'suppressed' && input.status !== 'suppressed') throw new ApiError('Suppressed contacts cannot be re-subscribed through contact editing.', 'conflict', { status: 'The contact remains suppressed.' })
        const contact: Contact = { id: existing?.id ?? id('con'), email: address, name: text(input.name, 'name', 200, true), country: country(input.country, true), status: input.status, listIds: validateListIds(s, input.listIds), createdAt: existing?.createdAt ?? now(), lastOpenedAt: existing?.lastOpenedAt ?? null, consent: input.status === 'subscribed' && existing?.status !== 'subscribed' ? { source: 'manual_opt_in', at: now() } : existing?.consent ?? { source: 'manual_entry', at: null }, ...(input.status === 'suppressed' ? { suppressionReason: existing?.suppressionReason ?? 'Manually suppressed' } : {}) }
        if (existing) Object.assign(existing, contact)
        else s.contacts.push(contact)
        return contact
      }),
      import: (input, signal) => run(signal, true, s => {
        find(s.lists, input.listId, 'List')
        if (!Array.isArray(input.rows) || input.rows.length === 0 || input.rows.length > 10000) invalid('rows', 'Import between 1 and 10,000 contact rows.')
        const result = { created: 0, matched: 0, skipped: 0, issues: [] as { row: number; message: string }[] }
        const seen = new Set<string>()
        input.rows.forEach((row, index) => {
          try {
            if (!row || typeof row !== 'object') invalid('row', 'Each import row must contain an email address.')
            const address = email(row.email)
            const name = text(row.name ?? '', 'name', 200, true)
            const countryCode = country(row.country ?? '', true)
            if (row.subscribed !== undefined && typeof row.subscribed !== 'boolean') invalid('subscribed', 'Subscription consent must be true or false.')
            if (seen.has(address)) { result.skipped++; result.issues.push({ row: index + 1, message: 'Duplicate email in this import.' }); return }
            seen.add(address)
            const existing = s.contacts.find(c => c.email.toLowerCase() === address)
            if (existing) {
              if (!existing.listIds.includes(input.listId)) existing.listIds.push(input.listId)
              if (name) existing.name = name
              if (countryCode) existing.country = countryCode
              // Import never changes an existing contact's subscription or suppression.
              result.matched++
            } else {
              s.contacts.push({ id: id('con'), email: address, name, country: countryCode, status: row.subscribed === true ? 'subscribed' : 'unsubscribed', listIds: [input.listId], createdAt: now(), lastOpenedAt: null, consent: { source: row.subscribed === true ? 'import_opt_in' : 'import_without_consent', at: row.subscribed === true ? now() : null } })
              result.created++
            }
          } catch (error) {
            if (!(error instanceof ApiError)) throw error
            result.skipped++
            result.issues.push({ row: index + 1, message: error.message })
          }
        })
        return result
      }),
    },
    lists: {
      list: (input = {}, signal) => run(signal, false, s => page(s.lists.map(list => listTotals(s, list)), input, list => list.name)),
      get: (listId, signal) => run(signal, false, s => listTotals(s, find(s.lists, listId, 'List'))),
      create: (input, signal) => run(signal, true, s => {
        const name = text(input.name, 'name')
        if (s.lists.some(list => list.name.toLowerCase() === name.toLowerCase())) throw new ApiError('A list with this name already exists.', 'conflict', { name: 'Choose a unique list name.' })
        const list: AudienceList = { id: id('list'), name, total: 0, subscribed: 0, unsubscribed: 0, suppressed: 0, createdAt: now() }
        s.lists.push(list)
        return list
      }),
    },
    segments: {
      list: (input = {}, signal) => run(signal, false, s => page(s.segments.map(segment => segmentTotals(s, segment)), input, segment => segment.name)),
      get: (segmentId, signal) => run(signal, false, s => segmentTotals(s, find(s.segments, segmentId, 'Segment'))),
      save: (input, signal) => run(signal, true, s => {
        const existing = input.id ? find(s.segments, input.id, 'Segment') : undefined
        const clean = validateSegment(s, input)
        if (s.segments.some(segment => segment.id !== existing?.id && segment.name.toLowerCase() === clean.name.toLowerCase())) throw new ApiError('A segment with this name already exists.', 'conflict', { name: 'Choose a unique segment name.' })
        const segment = segmentTotals(s, { id: existing?.id ?? id('seg'), name: clean.name, match: clean.match, rules: clean.rules, updatedAt: now(), matched: 0, eligible: 0 })
        if (existing) Object.assign(existing, segment)
        else s.segments.push(segment)
        return segment
      }),
      preview: (input, signal) => run(signal, false, s => audience(segmentContacts(s, validateSegment(s, input)))),
    },
    keys: {
      list: (signal, _cursor, includeRevoked = true) => run(signal, false, s => s.keys.filter(key => includeRevoked || !key.revokedAt)),
      create: (input, signal) => run(signal, true, s => {
        const name = text(input.name, 'name', 100)
        if (input.permission !== 'send' && input.permission !== 'read') invalid('permission', 'Choose send or read permission.')
        if (!Array.isArray(input.domains) || !input.domains.every(name => typeof name === 'string' && s.domains.some(domain => domain.name === name))) invalid('domains', 'Choose connected domain hostnames.')
        const secret = `demo_key_${crypto.randomUUID().replaceAll('-', '')}`
        const key = { id: id('key'), name, prefix: secret.slice(0, 17), permission: input.permission, domains: [...input.domains], createdAt: now(), lastUsedAt: null }
        s.keys.push(key)
        return { key, secret }
      }),
      revoke: (keyId, signal) => run(signal, true, s => { const key = find(s.keys, keyId, 'API key'); key.revokedAt ??= now() }),
    },
    domains: {
      list: (input, signal) => run(signal, false, s => { filterRegion(s, input.regionId); return page(s.domains.filter(domain => (!input.regionId || domain.regionId === input.regionId) && (!input.status || domain.status === input.status)), input, domain => domain.name) }),
      get: (domainId, signal) => run(signal, false, s => find(s.domains, domainId, 'Domain')),
      create: (input, signal) => run(signal, true, s => {
        checkRegion(s, input.regionId)
        const name = domainName(input.name)
        if (s.domains.some(domain => domain.regionId === input.regionId && domain.name === name)) throw new ApiError('This domain already exists in this region.', 'conflict', { name: 'This domain is already connected.' })
        const domainId = id('dom')
        const domain: Domain = { id: domainId, name, regionId: input.regionId, status: 'pending', mailFromStatus: 'pending', createdAt: now(), records: [{ id: `${domainId}_dkim`, type: 'CNAME', name: `demo_key._domainkey.${name}`, value: 'demo_key.dkim.example.invalid', status: 'pending' }, { id: `${domainId}_spf`, type: 'TXT', name: `send.${name}`, value: 'v=spf1 -all', status: 'pending' }, { id: `${domainId}_mx`, type: 'MX', name: `send.${name}`, value: '10 demo-feedback.example.invalid', status: 'pending' }] }
        s.domains.push(domain)
        return domain
      }),
      verify: (domainId, signal) => run(signal, true, s => {
        const domain = find(s.domains, domainId, 'Domain')
        // Deterministic simulation only: no DNS lookup, AWS call, or external mutation.
        domain.status = 'verified'; domain.mailFromStatus = 'verified'
        domain.records.forEach(record => { record.status = 'verified' })
        return domain
      }),
    },
    webhooks: {
      list: signal => run(signal, false, s => s.webhooks),
      get: (webhookId, signal) => run(signal, false, s => find(s.webhooks, webhookId, 'Webhook')),
      save: (input, signal) => run(signal, true, s => {
        const existing = input.id ? find(s.webhooks, input.id, 'Webhook') : undefined
        const name = text(input.name, 'name')
        const url = text(input.url, 'url', 2048)
        try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.') || parsed.username || parsed.password || parsed.hash) invalid('url', 'Enter an HTTPS endpoint without credentials or a fragment.') } catch { invalid('url', 'Enter a valid HTTPS webhook URL.') }
        if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > EVENTS.length || !input.events.every(event => EVENTS.includes(event))) invalid('events', 'Select between one and six supported webhook events.')
        const events = [...new Set(input.events)]
        let regionIds: string[] | 'all' = 'all'
        if (input.regionIds !== 'all') {
          if (!Array.isArray(input.regionIds) || input.regionIds.length === 0) invalid('regionIds', 'Select at least one region or all regions.')
          regionIds = [...new Set(input.regionIds)]
          regionIds.forEach(regionId => checkRegion(s, regionId))
        }
        const webhook: Webhook = { id: existing?.id ?? id('wh'), name, url, events, regionIds, status: existing?.status ?? 'active', secretHint: existing?.secretHint ?? `demo_wh_…${crypto.randomUUID().slice(0, 8)}`, deliveries: existing?.deliveries ?? [] }
        if (existing) Object.assign(existing, webhook)
        else s.webhooks.push(webhook)
        return webhook
      }),
      setStatus: (webhookId, status, signal) => run(signal, true, s => {
        const webhook = find(s.webhooks, webhookId, 'Webhook')
        if (status !== 'active' && status !== 'paused') invalid('status', 'Choose active or paused.')
        webhook.status = status
        return webhook
      }),
      test: (webhookId, signal) => run(signal, true, s => {
        const webhook = find(s.webhooks, webhookId, 'Webhook')
        if (webhook.status !== 'active') throw new ApiError('Resume this endpoint before testing delivery.', 'conflict')
        const regionId = webhook.regionIds === 'all' ? s.regions[0]!.id : webhook.regionIds[0]!
        const event = webhook.events[0]!
        const delivery: WebhookDelivery = { id: id('del'), at: now(), regionId, event, response: 200, attempts: 1, status: 'delivered', payload: { demo: true, event, regionId, message: 'Simulated webhook test; no HTTP request was made.' } }
        webhook.deliveries.unshift(delivery)
        return delivery
      }),
      retry: (webhookId, deliveryId, signal) => run(signal, true, s => {
        const webhook = find(s.webhooks, webhookId, 'Webhook')
        const delivery = find(webhook.deliveries, deliveryId, 'Webhook delivery')
        if (webhook.status !== 'active') throw new ApiError('Resume this endpoint before retrying delivery.', 'conflict')
        if (delivery.status !== 'retry_pending') throw new ApiError('Only pending deliveries can be retried.', 'conflict')
        delivery.attempts++; delivery.response = 200; delivery.status = 'delivered'; delivery.at = now()
        webhook.deliveries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        return delivery
      }),
      rotate: (webhookId, signal) => run(signal, true, s => {
        const webhook = find(s.webhooks, webhookId, 'Webhook')
        const secret = `demo_wh_${crypto.randomUUID().replaceAll('-', '')}`
        webhook.secretHint = `demo_wh_…${secret.slice(-8)}`
        return { secret }
      }),
      remove: (webhookId, signal) => run(signal, true, s => { find(s.webhooks, webhookId, 'Webhook'); s.webhooks = s.webhooks.filter(webhook => webhook.id !== webhookId) }),
    },
  }
}
