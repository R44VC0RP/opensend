import type { AgentTokenSummary, ApiKey, AudienceList, Campaign, CampaignTemplate, Contact, Domain, Email, McpConnection, RegionCatalog, SesDiscovery, Segment, Webhook, Workspace } from './types'

// Legacy profiles stay internal to demo persistence and campaign quota simulation.
export interface DemoRegionProfile { id: string; name: string; access: 'production' | 'sandbox'; health: 'healthy' | 'probation' | 'shutdown'; sendingEnabled: boolean; sent24h: number; dailyQuota: number; maxSendRate: number; bounceRate: number; complaintRate: number; suppression: string[]; ipPool: string; vdmEnabled: boolean }

export interface DemoAttachment { id: string; filename: string; contentType: string; size: number; disposition: 'attachment' | 'inline'; contentId?: string; content: string }

export interface DemoState {
  version: 1
  workspace: Workspace
  regions: DemoRegionProfile[]
  regionSetup?: { catalog: RegionCatalog; reports: Record<string, SesDiscovery> }
  contacts: Contact[]
  lists: AudienceList[]
  segments: Segment[]
  emails: Email[]
  campaigns: Campaign[]
  attachments?: DemoAttachment[]
  templateAssets?: DemoAttachment[]
  templates?: CampaignTemplate[]
  domains: Domain[]
  keys: ApiKey[]
  agentTokens?: AgentTokenSummary[]
  mcpConnections?: McpConnection[]
  webhooks: Webhook[]
}

export function createSeed(now = Date.now()): DemoState {
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString()
  const regions: DemoRegionProfile[] = [
    { id: 'us-east-1', name: 'US East (N. Virginia)', access: 'production', health: 'healthy', sendingEnabled: true, sent24h: 18204, dailyQuota: 50000, maxSendRate: 14, bounceRate: 0.0024, complaintRate: 0.0001, suppression: ['BOUNCE', 'COMPLAINT'], ipPool: 'Shared', vdmEnabled: true },
    { id: 'eu-west-1', name: 'Europe (Ireland)', access: 'production', health: 'healthy', sendingEnabled: true, sent24h: 8240, dailyQuota: 100000, maxSendRate: 28, bounceRate: 0.0018, complaintRate: 0.0001, suppression: ['BOUNCE', 'COMPLAINT'], ipPool: 'Shared', vdmEnabled: true },
    { id: 'us-west-2', name: 'US West (Oregon)', access: 'sandbox', health: 'healthy', sendingEnabled: true, sent24h: 12, dailyQuota: 200, maxSendRate: 1, bounceRate: 0, complaintRate: 0, suppression: ['BOUNCE', 'COMPLAINT'], ipPool: 'Shared', vdmEnabled: false },
  ]
  const lists: AudienceList[] = [
    { id: 'list_newsletter', name: 'Newsletter', total: 0, subscribed: 0, unsubscribed: 0, suppressed: 0, createdAt: ago(90 * 24) },
    { id: 'list_customers', name: 'Customers', total: 0, subscribed: 0, unsubscribed: 0, suppressed: 0, createdAt: ago(80 * 24) },
    { id: 'list_digest', name: 'Weekly digest', total: 0, subscribed: 0, unsubscribed: 0, suppressed: 0, createdAt: ago(60 * 24) },
  ]
  const firstNames = ['Alex', 'Jordan', 'Sam', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Cameron', 'Drew', 'Quinn', 'Robin', 'Sage', 'Charlie', 'Blake']
  const lastNames = ['Chen', 'Wilson', 'Patel', 'Rivera']
  const contacts: Contact[] = Array.from({ length: 64 }, (_, i) => {
    const first = firstNames[i % firstNames.length]!
    const last = lastNames[Math.floor(i / firstNames.length)]!
    const status = i === 0 || i % 17 === 0 ? 'suppressed' : i % 11 === 0 ? 'unsubscribed' : 'subscribed'
    return { id: i === 0 ? 'con_alex' : `con_${first.toLowerCase()}_${last.toLowerCase()}`, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, name: `${first} ${last}`, country: ['US', 'GB', 'DE', 'CA', 'FR', 'AU'][i % 6]!, status, listIds: ['list_newsletter', ...(i % 2 === 0 ? ['list_customers'] : []), ...(i % 3 === 0 ? ['list_digest'] : [])], createdAt: ago((90 - i) * 24), lastOpenedAt: i % 7 === 0 ? null : ago((i % 40) * 24 + 2), consent: { source: 'demo_seed', at: ago((90 - i) * 24) }, ...(status === 'suppressed' ? { suppressionReason: i === 0 ? 'Hard bounce: mailbox does not exist' : 'Recipient complaint' } : {}) }
  })
  const segments: Segment[] = [
    { id: 'seg_engaged', name: 'Engaged subscribers', match: 'all', rules: [{ id: 'rule_engaged_status', field: 'status', operator: 'is', value: 'subscribed' }, { id: 'rule_engaged_open', field: 'lastOpenedAt', operator: 'within_days', value: '30' }], matched: 0, eligible: 0, updatedAt: ago(24) },
    { id: 'seg_us', name: 'US subscribers', match: 'all', rules: [{ id: 'rule_us_country', field: 'country', operator: 'is', value: 'US' }, { id: 'rule_us_status', field: 'status', operator: 'is', value: 'subscribed' }], matched: 0, eligible: 0, updatedAt: ago(48) },
    { id: 'seg_customers', name: 'Customers or digest readers', match: 'any', rules: [{ id: 'rule_customers_list', field: 'listId', operator: 'is', value: 'list_customers' }, { id: 'rule_digest_list', field: 'listId', operator: 'is', value: 'list_digest' }], matched: 0, eligible: 0, updatedAt: ago(72) },
  ]
  const emails: Email[] = Array.from({ length: 48 }, (_, i) => {
    const contact = contacts[i]!
    const status = i === 0 || i === 23 ? 'bounced' : i === 13 ? 'complaint' : i === 19 || i === 38 ? 'deferred' : i === 31 ? 'rejected' : 'delivered'
    const id = i === 0 ? 'em_invoice' : `em_activity_${String(i).padStart(2, '0')}`
    const sentAt = ago(i * 3.2 + 0.15)
    const subject = ['Your invoice is ready', 'Welcome to Acme', 'Your weekly digest', 'Your order has shipped', 'September product update', 'Reset your password'][i % 6]!
    return { id, regionId: i % 4 === 3 ? 'eu-west-1' : 'us-east-1', to: contact.email, from: 'hello@acme.com', subject, stream: i % 3 === 2 ? 'marketing' : 'transactional', status, sentAt, html: `<h1>${subject}</h1><p>Hi ${contact.name},</p><p>This is a simulated email from the OpenSend demo. No message was sent.</p><p>The Acme team</p>`, events: [{ id: `${id}_send`, type: 'send', at: sentAt, description: 'Demo message accepted for delivery.' }, { id: `${id}_${status}`, type: status, at: new Date(Date.parse(sentAt) + 1000).toISOString(), description: status === 'bounced' ? 'Permanent delivery failure. Recipient added to suppression list.' : `Demo delivery event: ${status}.`, ...(status === 'bounced' ? { diagnostic: 'smtp; 550 5.1.1 The email account does not exist.' } : {}) }] }
  })
  const campaigns: Campaign[] = [
    { id: 'cmp_followup', name: 'September follow-up', status: 'draft', regionId: 'us-east-1', listId: 'list_newsletter', segmentId: 'seg_engaged' },
    { id: 'cmp_update', name: 'September product update', status: 'sent', regionId: 'us-east-1', listId: 'list_newsletter', segmentId: null },
    { id: 'cmp_digest', name: 'Weekly digest', status: 'sent', regionId: 'us-east-1', listId: 'list_digest', segmentId: null },
    { id: 'cmp_customers', name: 'Customer appreciation', status: 'draft', regionId: 'us-east-1', listId: 'list_customers', segmentId: null },
    { id: 'cmp_europe', name: 'European product notes', status: 'draft', regionId: 'eu-west-1', listId: 'list_newsletter', segmentId: null },
    { id: 'cmp_sandbox', name: 'Sandbox preview', status: 'draft', regionId: 'us-west-2', listId: 'list_newsletter', segmentId: null },
  ].map((value, i) => {
    const status = value.status as Campaign['status']
    const deliveredEmails = value.id === 'cmp_update' ? emails.filter(e => e.regionId === 'us-east-1' && e.stream === 'marketing') : value.id === 'cmp_digest' ? emails.filter(e => e.regionId === 'us-east-1' && e.stream === 'transactional').slice(0, 8) : []
    return { ...value, status, subject: value.name, previewText: 'The latest news and updates from Acme.', fromName: 'Acme', fromEmail: value.regionId === 'eu-west-1' ? 'hello@acme.eu' : 'hello@acme.com', html: `<h1>${value.name}</h1><p>Here is what is new at Acme.</p><p>This is a demo campaign. No email will be sent.</p>`, createdAt: ago((15 + i) * 24), updatedAt: ago((i + 1) * 8), scheduledAt: null, timezone: 'UTC', recipients: deliveredEmails.length, delivered: deliveredEmails.filter(e => e.status === 'delivered').length, bounced: deliveredEmails.filter(e => e.status === 'bounced').length, complaints: deliveredEmails.filter(e => e.status === 'complaint').length }
  })
  const templateDraft = { name: 'Product announcement', description: 'A reusable product-news layout.', subject: 'What’s new at Acme', previewText: 'A quick look at the latest release.', fromName: 'Acme', replyTo: [], tracking: true, defaults: {}, html: '<h1>Product announcement</h1><p>Share what changed and why it matters.</p><p><a href="https://example.com" data-button="true">Learn more</a></p>', attachments: [] }
  const templates: CampaignTemplate[] = [{ id: 'tpl_product', url: '/templates/tpl_product', revision: 1, draft: templateDraft, published: structuredClone(templateDraft), publishedRevision: 1, archivedAt: null, createdAt: ago(30 * 24), updatedAt: ago(24) }]
  const domains: Domain[] = [
    { id: 'dom_acme', name: 'acme.com', regionId: 'us-east-1', status: 'verified' },
    { id: 'dom_mail', name: 'mail.acme.com', regionId: 'us-east-1', status: 'verified' },
    { id: 'dom_europe', name: 'acme.eu', regionId: 'eu-west-1', status: 'pending' },
  ].map(value => ({ ...value, status: value.status as Domain['status'], mailFromStatus: value.status === 'verified' ? 'verified' : 'pending', createdAt: ago(45 * 24), records: [{ id: `${value.id}_dkim`, type: 'CNAME', name: `demo_key._domainkey.${value.name}`, value: 'demo_key.dkim.example.invalid', status: value.status === 'verified' ? 'verified' : 'pending' }, { id: `${value.id}_spf`, type: 'TXT', name: `send.${value.name}`, value: 'v=spf1 -all', status: value.status === 'verified' ? 'verified' : 'pending' }, { id: `${value.id}_mx`, type: 'MX', name: `send.${value.name}`, value: '10 demo-feedback.example.invalid', status: value.status === 'verified' ? 'verified' : 'pending' }] }))
  const keys: ApiKey[] = [
    { id: 'key_production', name: 'Production application', prefix: 'demo_prod_', permission: 'send', domains: ['acme.com'], createdAt: ago(30 * 24), lastUsedAt: ago(1) },
    { id: 'key_analytics', name: 'Analytics dashboard', prefix: 'demo_read_', permission: 'read', domains: [], createdAt: ago(14 * 24), lastUsedAt: ago(3) },
  ]
  const agentTokens: AgentTokenSummary[] = [{ id: 'agt_demo_import', grantId: 'mcp_demo_opencode', environment: 'test', permissions: ['read', 'manage'], domains: [], purpose: 'Import customer contacts', expiresAt: new Date(now + 3_600_000).toISOString(), createdAt: ago(0.25), lastUsedAt: ago(0.1), revokedAt: null }]
  const mcpConnections: McpConnection[] = [{ id: 'mcp_demo_opencode', clientId: 'demo-opencode', name: 'OpenCode', userEmail: 'ryan@example.com', scopes: ['opensend:read', 'opensend:send', 'opensend:manage', 'offline_access'], createdAt: ago(14 * 24), updatedAt: ago(2) }]
  const webhooks: Webhook[] = [
    { id: 'wh_pipeline', name: 'Event pipeline', url: 'https://api.example.com/webhooks/email', regionIds: 'all', events: ['send', 'delivered', 'bounced', 'complaint', 'rejected', 'delivery_delayed'], status: 'active', secretHint: 'demo_wh_…pipeline', deliveries: [{ id: 'del_pipeline_success', at: ago(0.5), regionId: 'us-east-1', event: 'delivered', response: 200, attempts: 1, status: 'delivered', payload: { demo: true, event: 'delivered', emailId: 'em_activity_01' } }, { id: 'del_pipeline_pending', at: ago(2), regionId: 'eu-west-1', event: 'bounced', response: 503, attempts: 1, status: 'retry_pending', payload: { demo: true, event: 'bounced', emailId: 'em_activity_23' } }] },
    { id: 'wh_bounces', name: 'Bounce monitoring', url: 'https://monitor.example.com/events', regionIds: ['us-east-1'], events: ['bounced', 'complaint'], status: 'active', secretHint: 'demo_wh_…bounces', deliveries: [] },
    { id: 'wh_warehouse', name: 'Data warehouse', url: 'https://data.example.com/email-events', regionIds: ['eu-west-1'], events: ['delivered'], status: 'paused', secretHint: 'demo_wh_…warehouse', deliveries: [] },
  ]
  return { version: 1, workspace: { id: 'workspace_acme', name: 'Acme', accountId: 'demo_123456789012', role: 'Owner', members: [{ id: 'member_ryan', name: 'Ryan', email: 'ryan@example.com', role: 'Owner' }, { id: 'member_jordan', name: 'Jordan Wilson', email: 'jordan@example.com', role: 'Admin' }] }, regions, contacts, lists, segments, emails, campaigns, templates, templateAssets: [], domains, keys, agentTokens, mcpConnections, webhooks }
}
