import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { log } from './core.js';
import { postgresConnection } from './adapters/node.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadConfig } from './config.js';
import { reencryptWebhookSecrets } from './operations.js';
import { ensureRegionSettings } from './ses-region-state.js';

const config = loadConfig(process.env);

const client = new Client(postgresConnection(process.env.DATABASE_URL));
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock(78291344)');
  // Google-only installations have one internal namespace. Never silently strand an older tenant.
  const scopedTables = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'workspace_id'");
  for (const { table_name } of scopedTables.rows) {
    const table = table_name.replaceAll('"', '""');
    const foreign = await client.query(`SELECT 1 FROM public."${table}" WHERE workspace_id <> $1 LIMIT 1`, [config.workspaceId]);
    if (foreign.rowCount) throw new Error('LEGACY_WORKSPACE_MIGRATION_REQUIRED: non-default workspace data requires an explicit migration plan before this upgrade. No data was modified.');
  }
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
  await ensureRegionSettings(drizzle(client), config);
  const rekeyed = await reencryptWebhookSecrets(drizzle(client), config);
  if (rekeyed.conflicted) throw new Error('SECRET_REKEY_CONFLICT: concurrent changes occurred; rerun migrate before removing the previous secret.');
  log('info', { code: 'WEBHOOK_SECRETS_REKEYED', ...rekeyed });
} finally { await client.end(); }
