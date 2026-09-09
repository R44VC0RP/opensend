import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadConfig } from '../config.js';
import { ApiError } from '../core.js';
import type { Runtime } from '../core.js';
import { s3Storage } from './storage.js';
export function nodeRuntime(env: NodeJS.ProcessEnv): { runtime: Runtime; close: () => Promise<void> } {
  if (!env.DATABASE_URL) throw new ApiError(503, 'CONFIG_INVALID', 'DATABASE_URL is required.');
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
  return { runtime: { db: drizzle(pool), storage: s3Storage(env), config: loadConfig(env) }, close: () => pool.end() };
}
