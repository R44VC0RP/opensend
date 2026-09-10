export type RegionId = string
export type ISODate = string
export type Stream = 'transactional' | 'marketing'
export type AutoValidationMode = 'inherit' | 'off' | 'managed' | 'medium' | 'high' | 'unknown'
export type EmailStatus = 'queued' | 'attempting' | 'accepted' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'complaint' | 'deferred' | 'rejected' | 'rendering_failed' | 'delayed' | 'suppressed' | 'canceled' | 'acceptance_unknown' | 'simulated'
export type ContactStatus = 'unknown' | 'subscribed' | 'unsubscribed' | 'suppressed'
export type CampaignStatus = 'draft' | 'reviewed' | 'scheduled' | 'sending' | 'completed' | 'canceled' | 'sent'
export type WebhookEvent = 'send' | 'delivered' | 'bounced' | 'complaint' | 'rejected' | 'delivery_delayed' | 'email.sent' | 'email.delivered' | 'email.bounced' | 'email.complained' | 'email.rejected' | 'email.rendering_failed' | 'email.delivery_delayed' | 'email.opened' | 'email.clicked' | 'contact.subscription_changed'
export type TimeRange = '24h' | '7d' | '30d'
export interface PageRequest { page?: number; pageSize?: number; search?: string; regionId?: RegionId; status?: string; stream?: string; listId?: string; segmentId?: string; cursor?: string; to?: string; from?: string }
export interface PageResult<T> { items: T[]; total?: number; nextCursor?: string | null; page: number; pageSize: number; facets?: Record<string, number> }
export interface RegionCatalogEntry {
  region: string; enabled: boolean; isDefault: boolean
  discoveryStatus: 'not_discovered' | 'discovering' | 'stale' | 'ready' | 'needs_provisioning' | 'blocked'
  lastDiscoveredAt: string | null; provisionJobId: string | null
  provisionStatus: 'pending' | 'running' | 'completed' | 'failed' | null; provisionError: string | null
}
export interface RegionCatalog { defaultRegion: string; data: RegionCatalogEntry[] }
export interface RegionConfigureInput { enabled?: boolean; makeDefault?: boolean }
export interface RegionProvisionReceipt { jobId: string; status: 'pending' | 'running' }
export interface SesDiscovery {
  region: string; checkedAt: string
  account: { id: string; productionAccess: boolean | null; sendingEnabled: boolean | null; enforcementStatus: string | null; quota: { max24HourSend: number | null; maxSendRate: number | null; sentLast24Hours: number | null } } | null
  domains: { name: string; verificationStatus: string | null; sendingEnabled: boolean | null }[]
  identitiesTruncated: boolean
  resources: {
    transactional: SesConfigurationSet; marketing: SesConfigurationSet; eventDestinationName: string
    topic: { name: string; arn: string | null; exists: boolean | null; owned: boolean | null; policyReady: boolean | null; subscription: 'unknown' | 'missing' | 'pending' | 'confirmed'; rawMessageDelivery: boolean | null; subscriptionsTruncated: boolean; staleSubscriptions: number }
  }
  feedbackUrl: string | null; status: 'ready' | 'needs_provisioning' | 'blocked'; provisioned: boolean
  blockers: { code: string; message: string }[]; warnings: { code: string; message: string }[]
}
interface SesConfigurationSet { name: string; exists: boolean | null; owned: boolean | null; sendingEnabled: boolean | null; eventDestinationExists: boolean | null; eventWired: boolean | null; autoValidation: AutoValidationMode | null }
export interface Workspace { id: string; name: string; accountId?: string; role: string; members?: { id: string; name: string; email: string; role: string }[] }
export interface EmailEvent { id: string; type: string; at: ISODate; description: string; diagnostic?: string }
export interface Email { text?: string | null; eventsNextCursor?: string | null; fromName?: string; simulated?: boolean; attachments?: string[]; id: string; regionId: RegionId; to: string; from: string; subject: string; stream: Stream; status: EmailStatus; sentAt: ISODate; html: string; events: EmailEvent[] }
export interface ChartPoint { at: ISODate; sent: number; delivered: number; bounced: number; complaints: number }
export interface Overview { periodStart: ISODate; periodEnd: ISODate; sent: number; delivered: number; bounced: number; complaints: number; deferred: number; previousSent: number; points: ChartPoint[]; streams: { name: Stream; sent: number }[]; recentCampaigns: Campaign[] }
export interface Contact { properties?: Record<string, string | number | boolean | null>; id: string; email: string; name: string; country: string; status: ContactStatus; listIds: string[]; createdAt: ISODate; lastOpenedAt: ISODate | null; consent: { source: string; at: ISODate | null }; suppressionReason?: string }
export interface ContactInput { id?: string; email: string; name: string; country: string; status: ContactStatus; listIds: string[] }
export interface AudienceList { unknown?: number; id: string; name: string; total: number; subscribed: number; unsubscribed: number; suppressed: number; createdAt: ISODate }
export interface SegmentRule { id: string; field: 'status' | 'country' | 'listId' | 'lastOpenedAt'; operator: 'is' | 'is_not' | 'within_days'; value: string }
export interface Segment { rule?: Record<string, unknown>; id: string; name: string; match: 'all' | 'any'; rules: SegmentRule[]; matched: number; eligible: number; updatedAt: ISODate }
export type SegmentInput = Pick<Segment, 'name' | 'match' | 'rules' | 'rule'> & { id?: string }
export interface AudiencePreview { matched: number; suppressed: number; unsubscribed: number; eligible: number; contacts: Contact[] }
export type CampaignPreview = { html: string; text: string }
export interface Campaign { archivedAt?: ISODate | null; revision?: number; reviewId?: string | null; draft?: Record<string, any>; attachments?: string[]; id: string; regionId: RegionId; name: string; subject: string; previewText: string; fromName: string; fromEmail: string; listId: string; segmentId: string | null; html: string; status: CampaignStatus; createdAt: ISODate; updatedAt: ISODate; scheduledAt: ISODate | null; timezone: string; recipients: number; delivered: number; bounced: number; complaints: number }
export type CampaignInput = Pick<Campaign, 'regionId' | 'name' | 'subject' | 'previewText' | 'fromName' | 'fromEmail' | 'listId' | 'segmentId' | 'html'> & { id?: string; revision?: number; draft?: Record<string, any>; attachments?: string[]; idempotencyKey?: string }
export interface CampaignState { id: string; revision: number; updatedAt: ISODate; status: CampaignStatus; reviewId: string | null; scheduledAt: ISODate | null; archivedAt: ISODate | null }
export interface SendCampaignInput { reviewId?: string; revision?: number; id: string; mode: 'now' | 'schedule'; scheduledAt?: ISODate; timezone: string }
export interface ApiKey { environment?: 'live' | 'test'; revokedAt?: string | null; id: string; name: string; prefix: string; permission: 'send' | 'read'; domains: string[]; createdAt: ISODate; lastUsedAt: ISODate | null }
export interface ApiKeyInput { environment?: 'live' | 'test'; name: string; permission: 'send' | 'read'; domains: string[] }
export interface CreatedApiKey { key: ApiKey; secret: string }
export interface AgentTokenSummary { id: string; grantId: string; environment: 'live' | 'test'; permissions: ('read' | 'send' | 'manage')[]; domains: string[]; purpose: string; expiresAt: ISODate; createdAt: ISODate; lastUsedAt: ISODate | null; revokedAt: ISODate | null }
export interface McpConnection { id: string; clientId: string; name: string | null; userEmail: string; scopes: string[]; createdAt: ISODate; updatedAt: ISODate }
export interface DnsRecord { id: string; type: 'TXT' | 'CNAME' | 'MX'; name: string; value: string; status: 'verified' | 'pending' | 'not_checked' }
export interface Domain { dnsStatus?: 'available' | 'unavailable'; dnsUnavailableReason?: string | null; id: string; regionId: RegionId; name: string; status: 'verified' | 'pending' | 'issue'; mailFromDomain?: string | null; mailFromStatus: 'verified' | 'pending' | 'not_configured' | 'failed'; records: DnsRecord[]; createdAt: ISODate }
export interface WebhookDelivery { id: string; at: ISODate; regionId: RegionId; event: WebhookEvent; response: number | null; attempts: number; status: 'delivered' | 'retry_pending' | 'pending' | 'failed' | 'paused'; payload: Record<string, unknown> }
export interface Webhook { id: string; name: string; url: string; regionIds: RegionId[] | 'all'; events: WebhookEvent[]; status: 'active' | 'paused'; secretHint: string; deliveries: WebhookDelivery[]; nextCursor?: string | null }
export type WebhookInput = Pick<Webhook, 'name' | 'url' | 'regionIds' | 'events'> & { id?: string }
export interface ImportRow { email: string; name?: string; country?: string; subscribed?: boolean }
export interface ImportResult { created: number; matched: number; skipped: number; issues: { row: number; message: string }[] }
export class ApiError extends Error {
  constructor(message: string, public code: string = 'validation', public fields: Record<string, string> = {}, public requestId?: string, public status?: number) { super(`${message} [${code}]${requestId ? ` · Request ${requestId}` : ''}`); this.name = 'ApiError' }
}

// The UI depends on this boundary, never on fixture data or a transport implementation.
// Dates cross the boundary as ISO-8601 strings; rates are ratios, not formatted percentages.
export type CursorItems<T> = T[] & { nextCursor?: string | null }
export interface OpenSendApi {
  consentHistory?: (id: string, cursor?: string) => Promise<{items: ConsentEvent[]; nextCursor: string | null}>
  emailEvents?: (id: string, cursor?: string) => Promise<{items: EmailEvent[]; nextCursor: string | null}>
  readonly environment?: 'live' | 'test'
  review?: (id: string, revision: number) => Promise<CampaignReview>
  attachments?: { upload(file: File, inline?: {contentId: string}): Promise<Attachment>; get(id: string, signal?: AbortSignal): Promise<Attachment>; content(id: string, signal?: AbortSignal): Promise<{id: string; filename: string; contentType: string; content: string}>; remove(id: string): Promise<void> }
  imports?: { preview(input: {csv: string; mapping: Record<string, string>; listId?: string}): Promise<ImportPreview>; commit(id: string): Promise<ImportPreview> }
  consent?: (id: string, input: ConsentInput) => Promise<Contact>
  webhookDeliveries?: (id: string, cursor?: string) => Promise<{items: WebhookDelivery[]; nextCursor: string | null}>
  readonly mode: 'demo' | 'live'
  regions: { list(signal?: AbortSignal): Promise<RegionCatalog>; configure(region: string, input: RegionConfigureInput, signal?: AbortSignal): Promise<RegionCatalog>; discover(region: string, options?: { refresh?: boolean }, signal?: AbortSignal): Promise<SesDiscovery>; provision(region: string, signal?: AbortSignal): Promise<RegionProvisionReceipt>; updateAutoValidation(region: string, stream: Stream, mode: Exclude<AutoValidationMode, 'inherit' | 'unknown'>, signal?: AbortSignal): Promise<{stream: Stream; mode: AutoValidationMode}> }
  workspace: { get(signal?: AbortSignal): Promise<Workspace>; update(input: { name: string }, signal?: AbortSignal): Promise<Workspace> }
  overview: { get(input: { regionId: string; range: TimeRange; stream?: Stream }, signal?: AbortSignal): Promise<Overview> }
  emails: { list(input: PageRequest, signal?: AbortSignal): Promise<PageResult<Email>>; get(id: string, signal?: AbortSignal): Promise<Email> }
  campaigns: { list(input: PageRequest & { archived?: boolean }, signal?: AbortSignal): Promise<PageResult<Campaign>>; get(id: string, signal?: AbortSignal): Promise<Campaign>; state(id: string, signal?: AbortSignal): Promise<CampaignState>; preview(id: string, signal?: AbortSignal): Promise<CampaignPreview>; setArchived(input: { id: string; archived: boolean }, signal?: AbortSignal): Promise<Campaign>; save(input: CampaignInput, signal?: AbortSignal): Promise<Campaign>; audience(input: { listId: string; segmentId: string | null }, signal?: AbortSignal): Promise<AudiencePreview>; send(input: SendCampaignInput, signal?: AbortSignal): Promise<Campaign | CampaignSendReceipt>; test(input: { id: string; to: string }, signal?: AbortSignal): Promise<{ accepted: boolean; id?: string; status?: string; simulated?: boolean }> }
  contacts: { list(input: PageRequest, signal?: AbortSignal): Promise<PageResult<Contact>>; get(id: string, signal?: AbortSignal): Promise<Contact>; save(input: ContactInput, signal?: AbortSignal): Promise<Contact>; import(input: { listId: string; rows: ImportRow[] }, signal?: AbortSignal): Promise<ImportResult> }
  lists: { list(input?: PageRequest, signal?: AbortSignal): Promise<PageResult<AudienceList>>; get(id: string, signal?: AbortSignal): Promise<AudienceList>; create(input: { name: string }, signal?: AbortSignal): Promise<AudienceList>; remove(id: string, signal?: AbortSignal): Promise<void> }
  segments: { list(input?: PageRequest, signal?: AbortSignal): Promise<PageResult<Segment>>; get(id: string, signal?: AbortSignal): Promise<Segment>; save(input: SegmentInput, signal?: AbortSignal): Promise<Segment>; preview(input: SegmentInput, signal?: AbortSignal): Promise<AudiencePreview> }
  keys: { list(signal?: AbortSignal, cursor?: string, includeRevoked?: boolean): Promise<CursorItems<ApiKey>>; create(input: ApiKeyInput, signal?: AbortSignal): Promise<CreatedApiKey>; revoke(id: string, signal?: AbortSignal): Promise<void> }
  credentials: { agentTokens(includeInactive?: boolean, signal?: AbortSignal): Promise<AgentTokenSummary[]>; revokeAgentToken(id: string, signal?: AbortSignal): Promise<void>; mcpConnections(signal?: AbortSignal): Promise<McpConnection[]>; revokeMcpConnection(id: string, signal?: AbortSignal): Promise<void> }
  domains: { list(input: PageRequest & { refresh?: boolean }, signal?: AbortSignal): Promise<PageResult<Domain>>; get(id: string, signal?: AbortSignal): Promise<Domain>; create(input: { regionId: string; name: string }, signal?: AbortSignal): Promise<Domain>; configureMailFrom(id: string, mailFromDomain: string, signal?: AbortSignal): Promise<Domain>; verify(id: string, signal?: AbortSignal): Promise<Domain> }
  webhooks: { list(signal?: AbortSignal, cursor?: string): Promise<CursorItems<Webhook>>; get(id: string, signal?: AbortSignal): Promise<Webhook>; save(input: WebhookInput, signal?: AbortSignal): Promise<Webhook>; setStatus(id: string, status: 'active' | 'paused', signal?: AbortSignal): Promise<Webhook>; test(id: string, signal?: AbortSignal): Promise<WebhookDelivery>; retry(id: string, deliveryId: string, signal?: AbortSignal): Promise<WebhookDelivery>; rotate(id: string, signal?: AbortSignal): Promise<{ secret: string }>; remove(id: string, signal?: AbortSignal): Promise<void> }
}

export interface Identity { id: string; name: string | null; email: string | null; environment: "live" | "test"; permissions: string[] }
export interface CampaignReview extends AudiencePreview { id: string; revision: number }
export interface Attachment { disposition?: 'attachment' | 'inline'; contentId?: string | null; id: string; filename: string; contentType: string; size: number }
export interface ConsentInput { status: "subscribed" | "unsubscribed"; source?: string; evidence?: string; policyVersion?: string; occurredAt?: string; confirmResubscribe?: boolean }
export interface ConsentEvent { id: string; status: "subscribed" | "unsubscribed"; source: string; evidence: string | null; policyVersion: string | null; occurredAt: string }
export interface ImportPreview { id: string; status: "preview" | "committed"; imported: number; rows: {row: number; email: string; name?: string}[]; errors: {row: number; field: string; message: string}[] }

export interface CampaignSendReceipt { id: string; status: "scheduled" | "sending"; queued: number; scheduledAt: string | null; simulated: boolean }
