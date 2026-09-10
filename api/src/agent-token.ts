import { z } from '@hono/zod-openapi';
import { Buffer } from 'node:buffer';
import type { Config, Mode, Permission } from './core.js';

const Payload = z.object({
  v: z.literal(1), grant: z.string().regex(/^mcp_[A-Za-z0-9_-]{1,200}$/), environment: z.enum(['live', 'test']),
  permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3), domains: z.array(z.string()).max(50),
  exp: z.number().int().positive(), nonce: z.string().regex(/^[0-9a-f]{32}$/),
}).strict();
export type AgentTokenPayload = z.infer<typeof Payload>;

const encoder = new TextEncoder();
const encode = (value: Uint8Array | string) => Buffer.from(typeof value === 'string' ? encoder.encode(value) : value).toString('base64url');
const decode = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
async function key(secret: string) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
const signed = (payload: string) => `opensend-agent-token-v1:${payload}`;

export async function createAgentToken(config: Config, input: { grant: string; environment: Mode; permissions: Permission[]; domains: string[]; expiresAt: string }) {
  const payload = encode(JSON.stringify(Payload.parse({ v: 1, grant: input.grant, environment: input.environment, permissions: input.permissions, domains: input.domains, exp: Date.parse(input.expiresAt), nonce: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') })));
  const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(config.authSecret), encoder.encode(signed(payload)))));
  return `os_agent_${payload}.${signature}`;
}

export async function verifyAgentToken(config: Config, token: string): Promise<AgentTokenPayload | null> {
  const match = token.match(/^os_agent_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
  if (!match || token.length > 16 * 1024) return null;
  const valid = await Promise.any([config.authSecret, config.previousAuthSecret].filter((secret): secret is string => Boolean(secret)).map(async secret =>
    await crypto.subtle.verify('HMAC', await key(secret), decode(match[2]!), encoder.encode(signed(match[1]!))) ? true : Promise.reject())).catch(() => false);
  if (!valid) return null;
  try {
    const payload = Payload.parse(JSON.parse(new TextDecoder().decode(decode(match[1]!))));
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}
