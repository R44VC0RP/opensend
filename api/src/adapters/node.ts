import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadConfig } from '../config.js';
import { ApiError, log } from '../core.js';
import type { Runtime } from '../core.js';
import { s3Storage } from './storage.js';
export function postgresConnection(connectionString: string | undefined) {
  if (!connectionString) throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL is required.');
  let url: URL; try { url = new URL(connectionString); } catch { throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL must be a PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL must use PostgreSQL.');
  const local = ['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(url.hostname);
  if (!local && url.searchParams.get('sslmode') !== 'verify-full') throw new ApiError(503, 'DATABASE_TLS_REQUIRED', 'Remote PostgreSQL requires sslmode=verify-full. Only local development database hosts may omit TLS.');
  return { connectionString, connectionTimeoutMillis: 10000 };
}
export function nodeRuntime(env: Record<string, string | undefined>): { runtime: Runtime; close: () => Promise<void> } {
  const pool = new Pool({ ...postgresConnection(env.DATABASE_URL), max: 10, idleTimeoutMillis: 30000 });
  // pg evicts failed idle clients, but an unhandled pool error also terminates Node.
  // Keep the API/runner alive to reconnect; never log the error's client/config data.
  pool.on('error', () => log('error', { code: 'POSTGRES_POOL_ERROR', message: 'An idle PostgreSQL connection failed; the pool will reconnect.' }));
  return { runtime: { db: drizzle(pool), storage: s3Storage(env), config: loadConfig(env) }, close: () => pool.end() };
}
