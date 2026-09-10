import { z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { sql } from 'drizzle-orm';

export type Database = NodePgDatabase;
export type DbExecutor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;
export type Mode = 'live' | 'test';
export type Permission = 'read' | 'send' | 'manage';
export interface Actor { workspaceId: string; environment: Mode; permissions: Permission[]; domains: string[]; keyId: string; credential?: 'dashboard' | 'apiKey' | 'mcp' | 'agentToken'; email?: string; name?: string; }
export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}
export interface Config {
  workspaceId: string;
  authSecret: string;
  previousAuthSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  allowedEmails: string[];
  allowedDomains: string[];
  publicUrl: string;
  sesFeedbackUrl?: string;
  regions: string[];
  liveEnabled: boolean;
  encryptionKey: string;
  previousEncryptionKey?: string;
  awsAccountId?: string;
  snsTopicArns: string[];
  webhookAllowedHosts: string[];
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  configurationSets: { transactional: string; marketing: string };
}
export interface RenderedImage { data: Uint8Array; mimeType: 'image/png'; }
export interface PublicImage { data: Uint8Array; contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; }
export interface Runtime { db: Database; storage: Storage; config: Config; wake?: () => Promise<void>; renderHtmlImage?: (html: string) => Promise<RenderedImage>; importPublicImage?: (url: string) => Promise<PublicImage>; }
export type AppEnv = { Bindings: Runtime; Variables: { actor: Actor; requestId: string; serverTimings: { name: string; durationMs: number }[] } };
export type App = OpenAPIHono<AppEnv>;
export type Ctx = Context<AppEnv>;
export type JobHandler = (runtime: Runtime, payload: Record<string, unknown>, job: { id: string; attempts: number; workspaceId: string; environment: Mode }) => Promise<void>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public field?: string, public retryable = false) { super(message); }
}
export const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), field: z.string().optional(), retryable: z.boolean() }) }).openapi('ApiError');
export const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 422, 429, 500, 503].map(status => [status, { description: 'Request failed; use error.code and requestId to diagnose.', content: { 'application/json': { schema: ErrorSchema } } }]));
export const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
export const IdParams = z.object({ id: z.string().min(1).max(120) });
export const PageQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
export const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } }, required: true });
export const response = <T extends z.ZodType>(schema: T, description = 'Success') => ({ description, content: { 'application/json': { schema } } });
export const page = <T extends z.ZodType>(schema: T) => z.object({ data: z.array(schema), nextCursor: z.string().nullable() });
export function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
export function actor(c: Ctx, permission: Permission = 'read'): Actor {
  const value = c.get('actor');
  if (!value || (!value.permissions.includes('manage') && !value.permissions.includes(permission))) throw new ApiError(403, 'PERMISSION_DENIED', `This operation requires ${permission} permission.`);
  return value;
}
export function region(runtime: Runtime, value: string) {
  if (!runtime.config.regions.includes(value)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'The requested region is not configured for this deployment.', 'region');
  return value;
}
export function getSes(runtime: Runtime, selectedRegion: string): SESv2Client {
  region(runtime, selectedRegion);
  if (!runtime.config.liveEnabled || !runtime.config.aws) throw new ApiError(503, 'SES_NOT_CONFIGURED', 'Live SES access is disabled or AWS credentials are missing.');
  return new SESv2Client({ region: selectedRegion, credentials: runtime.config.aws, maxAttempts: 1, requestHandler: new FetchHttpHandler({ requestTimeout: 15000 }) });
}
export function log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) {
  // Callers supply operation/IDs/codes, never request bodies, tokens, addresses or arbitrary provider errors.
  console[level](JSON.stringify({ level, timestamp: new Date().toISOString(), ...fields }));
}
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
} as const;
export function applySecurityHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return headers;
}
export function secureResponse(response: Response): Response {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: applySecurityHeaders(new Headers(response.headers)) });
}
export function publicFailureBucket(path: string, status: number): 'auth' | 'unsubscribe' | 'ses' | null {
  if (status < 400 || status >= 500) return null;
  if (path === '/v1/events/ses') return 'ses';
  if (/^\/unsubscribe(?:\/|$)/.test(path)) return 'unsubscribe';
  return status === 401 && /^\/v1(?:\/|$)/.test(path) ? 'auth' : null;
}
export async function publicFailureAllowed(runtime: Runtime, bucket: 'auth' | 'unsubscribe' | 'ses', peer: string): Promise<boolean> {
  const keyId = `public:${bucket}:${peer}`;
  const budget = await runtime.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
    VALUES (${runtime.config.workspaceId}, ${keyId}, date_trunc('minute', now()), 1)
    ON CONFLICT (workspace_id, key_id) DO UPDATE SET
      used = CASE WHEN api_request_budgets.window_start = excluded.window_start THEN least(api_request_budgets.used + 1, 41) ELSE 1 END,
      window_start = excluded.window_start RETURNING used`);
  return budget.rows[0]!.used <= 40;
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
