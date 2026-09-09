import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { log } from './core.js';
import { postgresConnection } from './adapters/node.js';

const client = new Client(postgresConnection(process.env.DATABASE_URL));
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock(78291344)');
  await client.query('CREATE TABLE IF NOT EXISTS opensend_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(n => /^\d+_[a-z_]+\.sql$/.test(n)).sort()) {
    const source = await readFile(new URL(name, directory), 'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    const previous = await client.query<{ checksum: string }>('SELECT checksum FROM opensend_migrations WHERE name = $1', [name]);
    if (previous.rowCount) {
      if (previous.rows[0]!.checksum !== hash) throw new Error(`MIGRATION_CHANGED: ${name} differs from the applied migration. Add a new migration instead.`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(source);
      await client.query('INSERT INTO opensend_migrations(name, checksum) VALUES ($1, $2)', [name, hash]);
      await client.query('COMMIT');
      log('info', { code: 'MIGRATION_APPLIED', migration: name });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
} finally { await client.end(); }
