import { z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { sql } from 'drizzle-orm';
import { workspaceCredentials, type ReadyConnection } from './provider-credentials.js';

export type Database = NodePgDatabase;
export type DbExecutor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
export type Permission = 'read' | 'send' | 'manage';
export interface Actor {
  workspaceId: string; permissions: Permission[]; domains: string[]; keyId: string; credential?: 'dashboard' | 'apiKey' | 'mcp' | 'agentToken'; email?: string; name?: string;
  role?: string;
  // Number of emails queued per region, for a bounded post-commit wake.
  dispatchTargets?: Map<string, { count: number; priority: boolean }>;
  dispatchAccount?: { aws_account_id: string; kind: ReadyConnection['kind'] };
  // Orchestration jobs this request committed that must not wait for a coalesced wake (campaign launches).
  wakeJobs?: number;
}
export interface Storage {
  // Identity for reusable immutable bytes only, never pending request-bound I/O.
  readonly cacheScope?: object;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}
export interface Config {
  /** Requests per minute per credential. */
  apiRateLimitPerMinute: number;
  workspaceId: string;
  authSecret: string;
  previousAuthSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  allowedEmails: string[];
  allowedDomains: string[];
  defaultWorkspaceOwners: '*' | string[];
  multiTenant: boolean;
  regionalSending?: boolean;
  byoTemplateUrl?: string;
  byoV2?: boolean;
  byoV5TemplateUrl?: string;
  domainConnect?: { privateKey: import('node:crypto').KeyObject; keyId: string };
  /** Regions offered for MX shared sending; defaults to us-east-2. */
  sharedRegions?: string[];
  hostedSendCaps: { firstWeek: number; secondWeek: number; mature: number };
  publicUrl: string;
  sesFeedbackUrl?: string;
  regions: string[];
  liveEnabled: boolean;
  simulatedSes: { latencyMs: number; maxSendRate: number; deliveryDelayMs: number };
  // Pacing target relative to the provider quota: factor (1.1 aims 10% above) and an optional absolute live rate.
  dispatch: { rateFactor: number; targetRate?: number; dailyHeadroomPercent: number };
  encryptionKey: string;
  previousEncryptionKey?: string;
  awsAccountId?: string;
  snsTopicArns: string[];
  // Subset of snsTopicArns that carries SES inbound receipt notifications for mailboxes.
  inboundTopicArns?: string[];
  reputationAlertUrl?: string;
  // Opt-in Jev content screen for live transactional sends with `screen: true`; undefined without TYPESAFE_API_KEY.
  screen?: { apiKey: string; model: string; mode: 'reject' | 'flag'; threshold: number };
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  configurationSets: { transactional: string; marketing: string };
}
export interface RenderedImage { data: Uint8Array; mimeType: 'image/png'; }
export interface PublicImage { data: Uint8Array; contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; }
export type FeedbackItem = { region: string; topicArn: string; messageId: string; message: Record<string, unknown> };
export interface Runtime {
  db: Database; storage: Storage; config: Config;
  wake?: (readyJobs?: number, immediate?: 'webhook') => Promise<void>;
  deferNudge?: (work: (runtime: Runtime) => Promise<void>) => void;
  // Nudges the long-lived dispatcher for one account/region after queued mail commits. Dispatch
  // never depends on it: the dispatcher also polls and the scheduler pings it every minute.
  dispatch?: (region: string, accountId?: string, emails?: number, kind?: ReadyConnection['kind'], priority?: boolean) => Promise<void>;
  // Verified provider feedback (and simulated callbacks) leave the request path through this
  // sink and are ingested in batches, never through the sending jobs table.
  feedback?: { enqueue: (items: FeedbackItem[]) => Promise<void> };
  renderHtmlImage?: (html: string) => Promise<RenderedImage>; importPublicImage?: (url: string) => Promise<PublicImage>;
  // Outbound webhook transport. Node supplies a connect-time guard against private addresses
  // (see adapters/node.ts); Workers use plain fetch, which cannot reach them.
  webhookFetch?: WebhookFetch;
}
export type WebhookFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;
export type MailboxAccess = { keyId: string; workspaceId: string; admin: boolean; mailboxIds: string[] | null; permissions: ('read' | 'send' | 'modify')[] };
export type AppEnv = { Bindings: Runtime; Variables: { actor: Actor; requestId: string; serverTimings: { name: string; durationMs: number }[]; mailboxAccess?: MailboxAccess } };
export type App = OpenAPIHono<AppEnv>;
export type Ctx = Context<AppEnv>;
export type ClaimedWebhook = { delivery_id: string; generation: number; event_id: string; payload: unknown; synthetic: boolean; webhook_id: string; url: string; encrypted_secret: string; encrypted_headers: string | null };
export type JobHandler = (runtime: Runtime, payload: Record<string, unknown>, job: { id: string; attempts: number; workspaceId: string;
  webhook?: ClaimedWebhook | null; recordWithSettlement?: (ctes: import('drizzle-orm').SQL) => void }) => Promise<void>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string, public retryable = false, public resetAt?: string) { super(message); }
}
export const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), field: z.string().optional(), retryable: z.boolean(), resetAt: z.iso.datetime().optional().describe('Next capacity change for a Hosted rolling send limit.') }) }).openapi('ApiError');
export const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 422, 429, 500, 503].map(status => [status, { description: 'Request failed; use error.code and requestId to diagnose.', content: { 'application/json': { schema: ErrorSchema } } }]));
export const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
export const IdParams = z.object({ id: z.string().min(1).max(120) });
export const PageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
export const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } }, required: true });
export const response = <T extends z.ZodType>(schema: T, description = 'Success') => ({ description, content: { 'application/json': { schema } } });
export const page = <T extends z.ZodType>(schema: T) => z.object({ data: z.array(schema), nextCursor: z.string().nullable() });
export function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
export function actor(c: Ctx, action: Permission | 'editContent' = 'read'): Actor {
  const value = c.get('actor');
  // Dashboard roles include content editing. A scoped machine grant is still bounded by its
  // original permission contract: send alone does not delegate contact or template management.
  const permission = action === 'editContent' ? (c.env.config.multiTenant && value?.credential === 'dashboard' ? 'send' : 'manage') : action;
  if (!value || (!value.permissions.includes('manage') && !value.permissions.includes(permission))) throw new ApiError(403, 'PERMISSION_DENIED', `This operation requires ${permission} permission.`);
  return value;
}
export function senderDomainAllowed(allowed: readonly string[], candidate: string) {
  const domain = candidate.toLowerCase();
  return !allowed.length || allowed.some(value => { const parent = value.toLowerCase(); return domain === parent || domain.endsWith(`.${parent}`); });
}
export function region(runtime: Runtime, value: string) {
  if (!runtime.config.regions.includes(value)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'The requested region is not configured for this deployment.', 'region');
  return value;
}
// Runtime identities are invocation-local in Workers; never reuse an I/O client
// across requests. Node drains also receive a fresh resolved runtime.
const sesClients = new WeakMap<Runtime, Map<string, SESv2Client>>();
export const isSimulatedSes = (runtime: Runtime) => !runtime.config.liveEnabled || !runtime.config.aws;
export function assertSesConfigured(runtime: Runtime) {
  if (isSimulatedSes(runtime)) throw new ApiError(503, 'SES_NOT_CONFIGURED', 'Live SES access is disabled or AWS credentials are missing.');
}
export function getSes(runtime: Runtime, selectedRegion: string, connection?: ReadyConnection, runClients?: Map<string, SESv2Client>): SESv2Client {
  region(runtime, selectedRegion);
  assertSesConfigured(runtime);
  let clients = runClients ?? sesClients.get(runtime);
  if (!clients) { clients = new Map(); sesClients.set(runtime, clients); }
  // The dispatcher leases the connection alongside the mail. One shared-account client can
  // sign for all Hosted tenants (TenantName is on the command); BYO role rotations must get
  // a new provider. Never put a request-bound client or pending STS promise across invocations.
  const key = runClients && connection
    ? JSON.stringify([selectedRegion, connection.kind, connection.aws_account_id, connection.role_arn, connection.external_id])
    : connection ? `${selectedRegion}:${connection.id}:${connection.identitySession?.name??''}:${connection.identitySession?.purpose??''}` : selectedRegion;
  let client = clients.get(key);
  if (!client) { client = new SESv2Client({ region: selectedRegion, ...(runtime.config.multiTenant ? { credentials: () => workspaceCredentials(runtime, selectedRegion, connection), ignoreConfiguredEndpointUrls: true } : { credentials: runtime.config.aws }), maxAttempts: 1, cacheMiddleware: !!runClients, requestHandler: new FetchHttpHandler({ requestTimeout: 15000 }) }); clients.set(key, client); }
  return client;
}
export function log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) {
  // Callers supply operation/IDs/codes, never request bodies, tokens, addresses or arbitrary provider errors.
  console[level](JSON.stringify({ level, timestamp: new Date().toISOString(), ...fields }));
}
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
} as const;
export function applySecurityHeaders(headers: Headers): Headers {
  // Route-specific policies (notably OAuth form redirects) take precedence.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return headers;
}
export function secureResponse(response: Response): Response {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: applySecurityHeaders(new Headers(response.headers)) });
}
export function hasSessionCookie(headers: Headers): boolean {
  const cookie = headers.get('cookie');
  return Boolean(cookie && /(?:^|;\s*)(?:__Secure-)?opensend\.session_token(?:\.\d+)?=[^;\s]/.test(cookie));
}
export function publicFailureBucket(path: string, status: number, headers?: Headers): 'auth' | 'unsubscribe' | null {
  // SNS callers share egress addresses; reject untrusted topics/signatures without charging that pool.
  if (status < 400 || status >= 500 || path === '/v1/events/ses') return null;
  if (/^\/unsubscribe(?:\/|$)/.test(path)) return 'unsubscribe';
  if (status !== 401 || !/^\/v1(?:\/|$)/.test(path)) return null;
  return headers && !headers.has('authorization') && !hasSessionCookie(headers) ? null : 'auth';
}
export async function publicFailureAllowed(runtime: Runtime, bucket: 'auth' | 'unsubscribe', peer: string): Promise<boolean> {
  const keyId = `public:${bucket}:${peer}`;
  const budget = await runtime.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
    VALUES (${runtime.config.workspaceId}, ${keyId}, date_trunc('minute', now()), 1)
    ON CONFLICT (workspace_id, key_id) DO UPDATE SET
      used = CASE WHEN api_request_budgets.window_start = excluded.window_start THEN least(api_request_budgets.used + 1, 41) ELSE 1 END,
      window_start = excluded.window_start RETURNING used`);
  return budget.rows[0]!.used <= 40;
}
// All credentials and image-producing routes share one atomic workspace counter.
export async function chargeRenderBudget(c: Ctx, workspaceId: string) {
  const limit = 30;
  const budget = await c.env.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
    VALUES (${workspaceId}, 'render:images', date_trunc('minute', now()), 1)
    ON CONFLICT (workspace_id, key_id) DO UPDATE SET
      used = CASE WHEN excluded.window_start > api_request_budgets.window_start THEN 1 ELSE least(api_request_budgets.used + 1, ${limit + 1}) END,
      window_start = greatest(api_request_budgets.window_start, excluded.window_start) RETURNING used`);
  if (budget.rows[0]!.used > limit) {
    c.header('Retry-After', '60');
    throw new ApiError(429, 'RENDER_RATE_LIMITED', `This workspace allows ${limit} image previews and imports per minute. Retry after the window resets.`, undefined, true);
  }
}
export async function timed<T>(c: Ctx, name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await work(); }
  finally { c.get('serverTimings').push({ name, durationMs: performance.now() - start }); }
}
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
export function randomSecret(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}
export function notFound(entity: string): never { throw new ApiError(404, 'NOT_FOUND', `${entity} was not found.`); }
export const redactCapabilityText = (value: string) => value.replace(/u_[0-9a-f]{64}/g, '[redacted]');
export function redactCapabilityData(value: Record<string, unknown>): Record<string, unknown> {
  const redact = (item: unknown): unknown => {
    if (typeof item === 'string') return redactCapabilityText(item);
    if (Array.isArray(item)) return item.map(redact);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [redactCapabilityText(key), redact(child)]));
    return item;
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactCapabilityText(key), redact(item)]));
}
export function admissionDenied(): Response {
  const requestId = id('req');
  log('warn', { requestId, code: 'ADMISSION_RATE_LIMITED', operation: 'admission' });
  return secureResponse(Response.json({ error: { code: 'ADMISSION_RATE_LIMITED', message: 'Too many requests from this connection. Retry after one minute.', requestId, retryable: true } }, { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60', 'cache-control': 'no-store' } }));
}
export function publicFailureDenied(): Response {
  const requestId = id('req');
  log('warn', { requestId, code: 'PUBLIC_RATE_LIMITED', operation: 'public-failure' });
  return secureResponse(Response.json({ error: { code: 'PUBLIC_RATE_LIMITED', message: 'Too many failed public requests from this connection. Retry after one minute.', requestId, retryable: true } }, { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60', 'cache-control': 'no-store' } }));
}
