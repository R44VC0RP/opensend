import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import dns from 'node:dns';
import { request } from 'node:https';
import { isIPv4, type LookupFunction } from 'node:net';
import { loadConfig } from '../config.js';
import { ApiError, log } from '../core.js';
import type { Runtime, WebhookFetch } from '../core.js';
import { s3Storage } from './storage.js';

// Node can reach loopback, RFC1918, link-local (cloud metadata), CGNAT, ULA and other non-global
// ranges, so a webhook host is checked at connect time, after DNS, where rebinding cannot help.
const v4 = (ip: string) => ip.split('.').map(Number) as [number, number, number, number];
const nonGlobalV4 = (ip: string) => {
  const [a, b] = v4(ip);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
};
export function isGlobalAddress(ip: string): boolean {
  if (isIPv4(ip)) return !nonGlobalV4(ip);
  const lower = ip.toLowerCase().replace(/%.*$/, '');
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isGlobalAddress(mapped[1]!);
  if (lower === '::' || lower === '::1' || lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:')) return false;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00 || first === 0x2002 || first === 0x0100 || lower.startsWith('2001:db8:'));
}
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses.filter(entry => isGlobalAddress(entry.address));
    if (!list.length) return callback(new ApiError(422, 'WEBHOOK_ADDRESS_BLOCKED', 'The webhook host resolves only to private or reserved addresses.'), '');
    if (options.all) callback(null, list); else callback(null, list[0]!.address, list[0]!.family);
  });
};
export const nodeWebhookFetch: WebhookFetch = (url, init) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const req = request(target, { method: init.method, headers: init.headers, lookup: guardedLookup, signal: init.signal }, response => {
    response.resume(); resolve({ status: response.statusCode ?? 0 });
  });
  req.on('error', reject);
  req.end(init.body);
});
export function postgresConnection(connectionString: string | undefined) {
  if (!connectionString) throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL is required.');
  let url: URL; try { url = new URL(connectionString); } catch { throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL must be a PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL must use PostgreSQL.');
  const local = ['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(url.hostname);
  if (!local && url.searchParams.get('sslmode') !== 'verify-full') throw new ApiError(503, 'DATABASE_TLS_REQUIRED', 'Remote PostgreSQL requires sslmode=verify-full. Only local development database hosts may omit TLS.');
  // libpq accepts "system" as a CA-store selector; node-postgres treats it as a filename.
  // Use Node's trusted CA store instead, retaining verify-full certificate/hostname checks.
  if (url.searchParams.get('sslrootcert') === 'system') { url.searchParams.delete('sslrootcert'); connectionString = url.toString(); }
  return { connectionString, connectionTimeoutMillis: 10000 };
}
export function nodeRuntime(env: Record<string, string | undefined>): { runtime: Runtime; close: () => Promise<void> } {
  const pool = new Pool({ ...postgresConnection(env.DATABASE_URL), max: 10, idleTimeoutMillis: 30000 });
  // pg evicts failed idle clients, but an unhandled pool error also terminates Node.
  // Keep the API/runner alive to reconnect; never log the error's client/config data.
  pool.on('error', () => log('error', { code: 'POSTGRES_POOL_ERROR', message: 'An idle PostgreSQL connection failed; the pool will reconnect.' }));
  return { runtime: { db: drizzle(pool), storage: s3Storage(env), config: loadConfig(env), webhookFetch: nodeWebhookFetch }, close: () => pool.end() };
}
