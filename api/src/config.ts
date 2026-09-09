import { z } from 'zod';
import { ApiError } from './core.js';
import type { Config } from './core.js';
const values = z.object({
  ADMIN_API_KEY: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
  PREVIOUS_ENCRYPTION_KEY: z.preprocess(v => v === '' ? undefined : v, z.string().regex(/^[a-f0-9]{64}$/i).optional()),
  AWS_ACCOUNT_ID: z.preprocess(v => v === '' ? undefined : v, z.string().regex(/^\d{12}$/).optional()),
  WORKSPACE_ID: z.string().min(1).max(100).default('default'),
  PUBLIC_URL: z.string().url(),
  SES_REGIONS: z.string().default('us-east-1'),
  ENABLE_LIVE_SES: z.enum(['true', 'false']).default('false'),
  AWS_ACCESS_KEY_ID: z.string().optional(), AWS_SECRET_ACCESS_KEY: z.string().optional(), AWS_SESSION_TOKEN: z.string().optional(),
  SES_TRANSACTIONAL_CONFIGURATION_SET: z.string().default('opensend-transactional'),
  SES_MARKETING_CONFIGURATION_SET: z.string().default('opensend-marketing'),
  SNS_TOPIC_ARNS: z.string().default(''), WEBHOOK_ALLOWED_HOSTS: z.string().default(''),
});
const list = (value: string) => [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
export function loadConfig(input: Record<string, unknown>): Config {
  const parsed = values.safeParse(input);
  if (!parsed.success) throw new ApiError(503, 'CONFIG_INVALID', `Missing or invalid server configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}.`);
  const v = parsed.data;
  const regions = list(v.SES_REGIONS);
  if (list(v.SNS_TOPIC_ARNS).length && !v.AWS_ACCOUNT_ID) throw new ApiError(503, 'CONFIG_INVALID', 'AWS_ACCOUNT_ID is required when SNS_TOPIC_ARNS is configured.');
  if (!regions.length || regions.some(r => !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(r))) throw new ApiError(503, 'CONFIG_INVALID', 'SES_REGIONS must contain valid comma-separated AWS regions.');
  const url = new URL(v.PUBLIC_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must use HTTPS, except for localhost development.');
  if (url.username || url.password || url.search || url.hash) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must not contain credentials, a query, or a fragment.');
  return {
    workspaceId: v.WORKSPACE_ID, adminToken: v.ADMIN_API_KEY, encryptionKey: v.ENCRYPTION_KEY,
    previousEncryptionKey: v.PREVIOUS_ENCRYPTION_KEY, awsAccountId: v.AWS_ACCOUNT_ID,
    publicUrl: v.PUBLIC_URL.replace(/\/$/, ''), regions, liveEnabled: v.ENABLE_LIVE_SES === 'true',
    aws: v.AWS_ACCESS_KEY_ID && v.AWS_SECRET_ACCESS_KEY ? { accessKeyId: v.AWS_ACCESS_KEY_ID, secretAccessKey: v.AWS_SECRET_ACCESS_KEY, sessionToken: v.AWS_SESSION_TOKEN } : undefined,
    snsTopicArns: list(v.SNS_TOPIC_ARNS), webhookAllowedHosts: list(v.WEBHOOK_ALLOWED_HOSTS).map(h => h.toLowerCase()),
    configurationSets: { transactional: v.SES_TRANSACTIONAL_CONFIGURATION_SET, marketing: v.SES_MARKETING_CONFIGURATION_SET },
  };
}
