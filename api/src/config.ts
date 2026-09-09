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
  AWS_ACCOUNT_ID: optional(z.string().regex(/^\d{12}$/)),
  PUBLIC_URL: z.string().url(),
  SES_REGIONS: z.string().default('us-east-1'),
  ENABLE_LIVE_SES: z.enum(['true', 'false']).default('false'),
  AWS_ACCESS_KEY_ID: optional(z.string()), AWS_SECRET_ACCESS_KEY: optional(z.string()), AWS_SESSION_TOKEN: optional(z.string()),
  SES_TRANSACTIONAL_CONFIGURATION_SET: z.string().default('opensend-transactional'),
  SES_MARKETING_CONFIGURATION_SET: z.string().default('opensend-marketing'),
  SNS_TOPIC_ARNS: z.string().default(''), WEBHOOK_ALLOWED_HOSTS: z.string().default(''),
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
  const regions = list(v.SES_REGIONS);
  if (list(v.SNS_TOPIC_ARNS).length && !v.AWS_ACCOUNT_ID) throw new ApiError(503, 'CONFIG_INVALID', 'AWS_ACCOUNT_ID is required when SNS_TOPIC_ARNS is configured.');
  if (!regions.length || regions.some(r => !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(r))) throw new ApiError(503, 'CONFIG_INVALID', 'SES_REGIONS must contain valid comma-separated AWS regions.');
  const url = new URL(v.PUBLIC_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must use HTTPS, except for localhost development.');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must be a canonical origin without credentials, a path, query or fragment.');
  return {
    // Retained internal storage namespace, not an installation setting or browser-provided tenant ID.
    workspaceId: 'default', authSecret: v.BETTER_AUTH_SECRET, previousAuthSecret: v.PREVIOUS_BETTER_AUTH_SECRET,
    googleClientId: v.GOOGLE_CLIENT_ID, googleClientSecret: v.GOOGLE_CLIENT_SECRET, allowedEmails, allowedDomains,
    encryptionKey: deriveEncryptionKey(v.BETTER_AUTH_SECRET),
    previousEncryptionKey: v.PREVIOUS_BETTER_AUTH_SECRET ? deriveEncryptionKey(v.PREVIOUS_BETTER_AUTH_SECRET) : v.ENCRYPTION_KEY,
    awsAccountId: v.AWS_ACCOUNT_ID, publicUrl: url.origin, regions, liveEnabled: v.ENABLE_LIVE_SES === 'true',
    aws: v.AWS_ACCESS_KEY_ID && v.AWS_SECRET_ACCESS_KEY ? { accessKeyId: v.AWS_ACCESS_KEY_ID, secretAccessKey: v.AWS_SECRET_ACCESS_KEY, sessionToken: v.AWS_SESSION_TOKEN } : undefined,
    snsTopicArns: list(v.SNS_TOPIC_ARNS), webhookAllowedHosts: list(v.WEBHOOK_ALLOWED_HOSTS).map(h => h.toLowerCase()),
    configurationSets: { transactional: v.SES_TRANSACTIONAL_CONFIGURATION_SET, marketing: v.SES_MARKETING_CONFIGURATION_SET },
  };
}
