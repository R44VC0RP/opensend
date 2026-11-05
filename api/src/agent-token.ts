import { z } from '@hono/zod-openapi';
import { Buffer } from 'node:buffer';
import { hkdfSync } from 'node:crypto';
import type { Config, Permission } from './core.js';

const Payload = z.object({
  v: z.literal([3, 4]), id: z.string().regex(/^agt_[0-9a-f]{32}$/), grant: z.string().regex(/^mcp_[A-Za-z0-9_-]{1,200}$/),
  permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3), domains: z.array(z.string()).max(50),
  exp: z.number().int().positive(), nonce: z.string().regex(/^[0-9a-f]{32}$/),
}).strict();
export type AgentTokenPayload = z.infer<typeof Payload>;

const encoder = new TextEncoder();
const encode = (value: Uint8Array | string) => Buffer.from(typeof value === 'string' ? encoder.encode(value) : value).toString('base64url');
const decode = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
function key(secret: string, version: AgentTokenPayload['v']) {
  // Remove the v3 verification path 24 hours after the last v3 issuer stops (maximum agent-token lifetime).
  const material = version === 3 ? encoder.encode(secret) : hkdfSync('sha256', secret, 'opensend:keys:v1', 'agent-token:v1', 32);
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, version === 3 ? ['verify'] : ['sign', 'verify']);
}
const signed = (payload: string) => `opensend-agent-token-v1:${payload}`;

export async function createAgentToken(config: Config, input: { id: string; grant: string; permissions: Permission[]; domains: string[]; expiresAt: string }) {
  const payload = encode(JSON.stringify(Payload.parse({ v: 4, id: input.id, grant: input.grant, permissions: input.permissions, domains: input.domains, exp: Date.parse(input.expiresAt), nonce: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') })));
  const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(config.authSecret, 4), encoder.encode(signed(payload)))));
  return `os_agent_${payload}.${signature}`;
}

export async function verifyAgentToken(config: Config, token: string): Promise<AgentTokenPayload | null> {
  const match = token.match(/^os_agent_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
  if (!match || token.length > 16 * 1024) return null;
  try {
    const payload = Payload.parse(JSON.parse(new TextDecoder().decode(decode(match[1]!))));
    if (payload.exp <= Date.now()) return null;
    const valid = await crypto.subtle.verify('HMAC', await key(config.authSecret, payload.v), decode(match[2]!), encoder.encode(signed(match[1]!)));
    return valid ? payload : null;
  } catch { return null; }
}
