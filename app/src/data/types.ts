export type RegionId = string
export type ISODate = string
export type Stream = 'transactional' | 'marketing'
export type EmailStatus = 'delivered' | 'bounced' | 'complaint' | 'deferred' | 'rejected'
export type ContactStatus = 'subscribed' | 'unsubscribed' | 'suppressed'
export type CampaignStatus = 'draft' | 'scheduled' | 'sent'
export type WebhookEvent = 'send' | 'delivered' | 'bounced' | 'complaint' | 'rejected' | 'delivery_delayed'
export type TimeRange = '24h' | '7d' | '30d'
export interface PageRequest { page?: number; pageSize?: number; search?: string; regionId?: RegionId; status?: string; stream?: string; listId?: string; segmentId?: string }
export interface PageResult<T> { items: T[]; total: number; page: number; pageSize: number; facets?: Record<string, number> }
export interface Region { id: RegionId; name: string; access: 'production' | 'sandbox'; health: 'healthy' | 'probation' | 'shutdown'; sendingEnabled: boolean; sent24h: number; dailyQuota: number; maxSendRate: number; bounceRate: number; complaintRate: number; suppression: string[]; ipPool: string; vdmEnabled: boolean }
export interface Workspace { id: string; name: string; accountId: string; role: string; members: { id: string; name: string; email: string; role: string }[] }
export interface EmailEvent { id: string; type: string; at: ISODate; description: string; diagnostic?: string }
export interface Email { id: string; regionId: RegionId; to: string; from: string; subject: string; stream: Stream; status: EmailStatus; sentAt: ISODate; html: string; events: EmailEvent[] }
export interface ChartPoint { at: ISODate; sent: number; delivered: number; bounced: number; complaints: number }
export interface Overview { periodStart: ISODate; periodEnd: ISODate; sent: number; delivered: number; bounced: number; complaints: number; deferred: number; previousSent: number; points: ChartPoint[]; streams: { name: Stream; sent: number }[]; recentCampaigns: Campaign[] }
export interface Contact { id: string; email: string; name: string; country: string; status: ContactStatus; listIds: string[]; createdAt: ISODate; lastOpenedAt: ISODate | null; consent: { source: string; at: ISODate | null }; suppressionReason?: string }
export interface ContactInput { id?: string; email: string; name: string; country: string; status: ContactStatus; listIds: string[] }
export interface AudienceList { id: string; name: string; total: number; subscribed: number; unsubscribed: number; suppressed: number; createdAt: ISODate }
export interface SegmentRule { id: string; field: 'status' | 'country' | 'listId' | 'lastOpenedAt'; operator: 'is' | 'is_not' | 'within_days'; value: string }
export interface Segment { id: string; name: string; match: 'all' | 'any'; rules: SegmentRule[]; matched: number; eligible: number; updatedAt: ISODate }
export type SegmentInput = Pick<Segment, 'name' | 'match' | 'rules'> & { id?: string }
export interface AudiencePreview { matched: number; suppressed: number; unsubscribed: number; eligible: number; contacts: Contact[] }
export interface Campaign { id: string; regionId: RegionId; name: string; subject: string; previewText: string; fromName: string; fromEmail: string; listId: string; segmentId: string | null; html: string; status: CampaignStatus; createdAt: ISODate; updatedAt: ISODate; scheduledAt: ISODate | null; timezone: string; recipients: number; delivered: number; bounced: number; complaints: number }
export type CampaignInput = Pick<Campaign, 'regionId' | 'name' | 'subject' | 'previewText' | 'fromName' | 'fromEmail' | 'listId' | 'segmentId' | 'html'> & { id?: string }
export interface SendCampaignInput { id: string; mode: 'now' | 'schedule'; scheduledAt?: ISODate; timezone: string }
export interface ApiKey { id: string; name: string; prefix: string; permission: 'send' | 'read'; domainId: string | null; createdAt: ISODate; lastUsedAt: ISODate | null }
export interface ApiKeyInput { name: string; permission: 'send' | 'read'; domainId: string | null }
export interface CreatedApiKey { key: ApiKey; secret: string }
export interface DnsRecord { id: string; type: 'TXT' | 'CNAME' | 'MX'; name: string; value: string; status: 'verified' | 'pending' }
export interface Domain { id: string; regionId: RegionId; name: string; status: 'verified' | 'pending' | 'issue'; mailFromStatus: 'verified' | 'pending'; records: DnsRecord[]; createdAt: ISODate }
export interface WebhookDelivery { id: string; at: ISODate; regionId: RegionId; event: WebhookEvent; response: number; attempts: number; status: 'delivered' | 'retry_pending'; payload: Record<string, unknown> }
export interface Webhook { id: string; name: string; url: string; regionIds: RegionId[] | 'all'; events: WebhookEvent[]; status: 'active' | 'paused'; secretHint: string; deliveries: WebhookDelivery[] }
export type WebhookInput = Pick<Webhook, 'name' | 'url' | 'regionIds' | 'events'> & { id?: string }
export interface ImportRow { email: string; name?: string; country?: string; subscribed?: boolean }
export interface ImportResult { created: number; matched: number; skipped: number; issues: { row: number; message: string }[] }
export class ApiError extends Error {
  constructor(message: string, public code: 'validation' | 'not_found' | 'conflict' | 'unavailable' = 'validation', public fields: Record<string, string> = {}) { super(message); this.name = 'ApiError' }
}

// The UI depends on this boundary, never on fixture data or a transport implementation.
// Dates cross the boundary as ISO-8601 strings; rates are ratios, not formatted percentages.
export interface OpenSendApi {
  readonly mode: 'demo' | 'live'
  regions: { list(signal?: AbortSignal): Promise<Region[]>; connect(id: string, signal?: AbortSignal): Promise<Region> }
  workspace: { get(signal?: AbortSignal): Promise<Workspace>; update(input: { name: string }, signal?: AbortSignal): Promise<Workspace> }
  overview: { get(input: { regionId: string; range: TimeRange; stream?: Stream }, signal?: AbortSignal): Promise<Overview> }
  emails: { list(input: PageRequest, signal?: AbortSignal): Promise<PageResult<Email>>; get(id: string, signal?: AbortSignal): Promise<Email> }
  campaigns: { list(input: PageRequest, signal?: AbortSignal): Promise<PageResult<Campaign>>; get(id: string, signal?: AbortSignal): Promise<Campaign>; save(input: CampaignInput, signal?: AbortSignal): Promise<Campaign>; audience(input: { listId: string; segmentId: string | null }, signal?: AbortSignal): Promise<AudiencePreview>; send(input: SendCampaignInput, signal?: AbortSignal): Promise<Campaign>; test(input: { id: string; to: string }, signal?: AbortSignal): Promise<{ accepted: boolean }> }
  contacts: { list(input: PageRequest, signal?: AbortSignal): Promise<PageResult<Contact>>; get(id: string, signal?: AbortSignal): Promise<Contact>; save(input: ContactInput, signal?: AbortSignal): Promise<Contact>; import(input: { listId: string; rows: ImportRow[] }, signal?: AbortSignal): Promise<ImportResult> }
  lists: { list(input?: PageRequest, signal?: AbortSignal): Promise<PageResult<AudienceList>>; get(id: string, signal?: AbortSignal): Promise<AudienceList>; create(input: { name: string }, signal?: AbortSignal): Promise<AudienceList> }
  segments: { list(input?: PageRequest, signal?: AbortSignal): Promise<PageResult<Segment>>; get(id: string, signal?: AbortSignal): Promise<Segment>; save(input: SegmentInput, signal?: AbortSignal): Promise<Segment>; preview(input: SegmentInput, signal?: AbortSignal): Promise<AudiencePreview> }
  keys: { list(signal?: AbortSignal): Promise<ApiKey[]>; create(input: ApiKeyInput, signal?: AbortSignal): Promise<CreatedApiKey>; revoke(id: string, signal?: AbortSignal): Promise<void> }
  domains: { list(input: PageRequest, signal?: AbortSignal): Promise<PageResult<Domain>>; get(id: string, signal?: AbortSignal): Promise<Domain>; create(input: { regionId: string; name: string }, signal?: AbortSignal): Promise<Domain>; verify(id: string, signal?: AbortSignal): Promise<Domain> }
  webhooks: { list(signal?: AbortSignal): Promise<Webhook[]>; get(id: string, signal?: AbortSignal): Promise<Webhook>; save(input: WebhookInput, signal?: AbortSignal): Promise<Webhook>; setStatus(id: string, status: 'active' | 'paused', signal?: AbortSignal): Promise<Webhook>; test(id: string, signal?: AbortSignal): Promise<WebhookDelivery>; retry(id: string, deliveryId: string, signal?: AbortSignal): Promise<WebhookDelivery>; rotate(id: string, signal?: AbortSignal): Promise<{ secret: string }>; remove(id: string, signal?: AbortSignal): Promise<void> }
}
