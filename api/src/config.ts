import { hkdfSync } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './core.js';
import type { Config } from './core.js';

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(v => v === '' ? undefined : v, schema.optional());
const values = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  PREVIOUS_BETTER_AUTH_SECRET: optional(z.string().min(32)),
  GOOGLE_CLIENT_ID: optional(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: optional(z.string().min(1)),
  AUTH_ALLOWED_EMAILS: z.string().default(''),
  AUTH_ALLOWED_DOMAINS: z.string().default(''),
  // Upgrade-only decryption input for pre-Google installations. Never used as the new encryption key.
  ENCRYPTION_KEY: optional(z.string().regex(/^[a-f0-9]{64}$/i)),
  PUBLIC_URL: z.string().url(),
  SES_FEEDBACK_URL: optional(z.string().url().max(2048)),
  DEFAULT_SES_REGION: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/).default('us-east-1'),
  ENABLE_LIVE_SES: z.enum(['true', 'false']).default('false'),
  AWS_ACCESS_KEY_ID: optional(z.string()), AWS_SECRET_ACCESS_KEY: optional(z.string()), AWS_SESSION_TOKEN: optional(z.string()),
  WEBHOOK_ALLOWED_HOSTS: z.string().default(''),
  OPENCODE_URL: optional(z.string().url()), OPENCODE_TOKEN: optional(z.string()),
  OPENCODE_USERNAME: z.string().default('opencode'), OPENCODE_PASSWORD: optional(z.string()),
  OPENCODE_DIRECTORY: z.string().default('/workspaces/opensend-templates'), OPENCODE_AGENT: z.string().default('opensend-author'),
  TEMPLATE_S3_BUCKET: optional(z.string()), TEMPLATE_S3_REGION: optional(z.string()), TEMPLATE_S3_ACCESS_KEY_ID: optional(z.string()), TEMPLATE_S3_SECRET_ACCESS_KEY: optional(z.string()),
  CRM_DATABASE_URL: optional(z.string()), CRM_CONTACTS_VIEW: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/).default('public.opensend_contacts'), CRM_LIST_ID: optional(z.string()), CRM_SYNC_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
});
const list = (value: string) => [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
// Separate from Better Auth's signing/encryption uses even though installers manage one root secret.
export function deriveEncryptionKey(secret: string): string {
  return Buffer.from(hkdfSync('sha256', secret, 'opensend:keys:v1', 'webhook-encryption', 32)).toString('hex');
}
export function loadConfig(input: Record<string, unknown>): Config {
  const parsed = values.safeParse(input);
  if (!parsed.success) throw new ApiError(503, 'CONFIG_INVALID', `Missing or invalid server configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}.`);
  const v = parsed.data;
  if (Boolean(v.GOOGLE_CLIENT_ID) !== Boolean(v.GOOGLE_CLIENT_SECRET)) throw new ApiError(503, 'CONFIG_INVALID', 'Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.');
  if (v.PREVIOUS_BETTER_AUTH_SECRET && v.ENCRYPTION_KEY) throw new ApiError(503, 'CONFIG_INVALID', 'Finish the legacy ENCRYPTION_KEY upgrade before configuring PREVIOUS_BETTER_AUTH_SECRET.');
  const allowedEmails = list(v.AUTH_ALLOWED_EMAILS).map(e => e.toLowerCase());
  const allowedDomains = list(v.AUTH_ALLOWED_DOMAINS).map(d => d.toLowerCase());
  if (allowedEmails.some(e => !z.email().safeParse(e).success) || allowedDomains.some(d => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d))) throw new ApiError(503, 'CONFIG_INVALID', 'Use exact email addresses and domain names in the authentication allowlists, without wildcards or URLs.');
  const regions = [v.DEFAULT_SES_REGION];
  if (v.OPENCODE_URL) { const host = new URL(v.OPENCODE_URL); if (host.username || host.password || host.search || host.hash || !['','/'].includes(host.pathname) || (host.protocol !== 'https:' && !(host.protocol === 'http:' && ['localhost','127.0.0.1'].includes(host.hostname)))) throw new ApiError(503, 'CONFIG_INVALID', 'OPENCODE_URL requires a canonical HTTPS origin, or localhost HTTP.'); }
  if (v.TEMPLATE_S3_BUCKET && (!v.TEMPLATE_S3_ACCESS_KEY_ID || !v.TEMPLATE_S3_SECRET_ACCESS_KEY)) throw new ApiError(503, 'CONFIG_INVALID', 'Template S3 storage requires its access key and secret.');
  if (v.CRM_DATABASE_URL && !v.CRM_LIST_ID) throw new ApiError(503, 'CONFIG_INVALID', 'CRM sync requires CRM_LIST_ID.');
  const url = new URL(v.PUBLIC_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must use HTTPS, except for localhost development.');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must be a canonical origin without credentials, a path, query or fragment.');
  return {
    // Retained internal storage namespace, not an installation setting or browser-provided tenant ID.
    workspaceId: 'default', authSecret: v.BETTER_AUTH_SECRET, previousAuthSecret: v.PREVIOUS_BETTER_AUTH_SECRET,
    googleClientId: v.GOOGLE_CLIENT_ID, googleClientSecret: v.GOOGLE_CLIENT_SECRET, allowedEmails, allowedDomains,
    encryptionKey: deriveEncryptionKey(v.BETTER_AUTH_SECRET),
    previousEncryptionKey: v.PREVIOUS_BETTER_AUTH_SECRET ? deriveEncryptionKey(v.PREVIOUS_BETTER_AUTH_SECRET) : v.ENCRYPTION_KEY,
    publicUrl: url.origin, sesFeedbackUrl: v.SES_FEEDBACK_URL, regions, liveEnabled: v.ENABLE_LIVE_SES === 'true',
    aws: v.AWS_ACCESS_KEY_ID && v.AWS_SECRET_ACCESS_KEY ? { accessKeyId: v.AWS_ACCESS_KEY_ID, secretAccessKey: v.AWS_SECRET_ACCESS_KEY, sessionToken: v.AWS_SESSION_TOKEN } : undefined,
    // Resource names and trusted feedback bindings are hydrated from persisted setup state.
    snsTopicArns: [], webhookAllowedHosts: list(v.WEBHOOK_ALLOWED_HOSTS).map(h => h.toLowerCase()),
    configurationSets: { transactional: '', marketing: '' },
    templateS3: v.TEMPLATE_S3_BUCKET ? { S3_BUCKET: v.TEMPLATE_S3_BUCKET, S3_REGION: v.TEMPLATE_S3_REGION, S3_ACCESS_KEY_ID: v.TEMPLATE_S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: v.TEMPLATE_S3_SECRET_ACCESS_KEY } : undefined,
    openCode: v.OPENCODE_URL ? { url: v.OPENCODE_URL, token: v.OPENCODE_TOKEN, username: v.OPENCODE_USERNAME, password: v.OPENCODE_PASSWORD, directory: v.OPENCODE_DIRECTORY, agent: v.OPENCODE_AGENT } : undefined,
    crm: v.CRM_DATABASE_URL ? { url: v.CRM_DATABASE_URL, view: v.CRM_CONTACTS_VIEW, listId: v.CRM_LIST_ID!, intervalMinutes: v.CRM_SYNC_MINUTES } : undefined,
    workerConcurrency: v.WORKER_CONCURRENCY,
  };
}
