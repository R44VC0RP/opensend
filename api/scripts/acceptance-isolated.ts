import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { serve } from '@hono/node-server';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { drain } from '../src/dispatch.js';
import { ensureRegionSettings } from '../src/ses-region-state.js';
import type { Runtime } from '../src/core.js';

// Dedicated disposable PostgreSQL and in-memory object storage. Never reads .env.
const suffix = randomBytes(6).toString('hex'),
  container = `opensend-acceptance-${suffix}`,
  password = randomBytes(24).toString('hex');
let pool: Pool | undefined,
  server: ReturnType<typeof serve> | undefined,
  stop = false;
try {
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=opensend_acceptance',
      '-p',
      '127.0.0.1::5432',
      'postgres:17-alpine',
    ],
    { stdio: 'pipe' },
  );
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  const database = `postgresql://postgres:${password}@127.0.0.1:${port}/opensend_acceptance`;
  pool = new Pool({ connectionString: database, max: 20 });
  for (let n = 0; ; n++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      if (n === 60) throw new Error('Synthetic PostgreSQL did not start.');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((n) => /^\d+_[a-z_]+\.sql$/.test(n)).sort())
    await pool.query(await readFile(new URL(name, directory), 'utf8'));
  const environment = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    AUTH_MODE: 'google',
    GOOGLE_CLIENT_ID: 'synthetic',
    GOOGLE_CLIENT_SECRET: 'synthetic',
    AUTH_ALLOWED_EMAILS: 'operator@example.com',
    AUTH_ALLOWED_DOMAINS: 'example.com',
    ENABLE_LIVE_SES: 'false',
    WEBHOOK_ALLOWED_HOSTS: 'example.com',
    DATABASE_URL: database,
    PUBLIC_URL: 'http://127.0.0.1:0',
  };
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const runtime: Runtime = {
    db: drizzle(pool),
    config: loadConfig(environment),
    storage: {
      async put(key, body, contentType) {
        objects.set(key, { body: body.slice(), contentType });
      },
      async get(key) {
        return objects.get(key) ?? null;
      },
      async delete(key) {
        objects.delete(key);
      },
    },
  };
  await ensureRegionSettings(runtime.db, runtime.config);
  const app = createApp();
  server = serve({ fetch: (r) => app.fetch(r, runtime), hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind.');
  const base = `http://127.0.0.1:${address.port}`;
  runtime.config.publicUrl = base;
  const workers = Array.from({ length: 8 }, async () => {
    while (!stop) {
      try {
        if (!(await drain(runtime))) await new Promise((r) => setTimeout(r, 50));
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--test', ...process.argv.slice(2), 'api.acceptance.test.ts'],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        ...environment,
        PUBLIC_URL: base,
        API_BASE_URL: base,
        OPENSEND_ISOLATED_ACCEPTANCE: '1',
        OPENSEND_SCALE_BENCHMARK: process.env.OPENSEND_SCALE_BENCHMARK ?? '0',
      },
      stdio: 'inherit',
    },
  );
  process.exitCode = await new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
  stop = true;
  await Promise.all(workers);
  console.log(JSON.stringify({ fixturePeakRssKiB: process.resourceUsage().maxRSS }));
} finally {
  stop = true;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (pool) await pool.end();
  try {
    execFileSync('docker', ['stop', container], { stdio: 'pipe' });
  } catch {
    /* Container may already have exited. */
  }
}
