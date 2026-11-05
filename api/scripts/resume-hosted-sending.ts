import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { postgresConnection } from '../src/adapters/node.js';
import { resumeHostedSending } from '../src/states.js';
import { log } from '../src/core.js';

const [wid, ...extra] = process.argv.slice(2);
if (!wid || extra.length) throw new Error('Supply exactly one reviewed workspace ID.');
const db = new Client(postgresConnection(process.env.DATABASE_URL));
await db.connect();
try {
  const result = await drizzle(db).execute(resumeHostedSending(wid));
  if (!result.rowCount) throw new Error('No paused Hosted connection for this workspace.');
  log('info', { code: 'HOSTED_SENDING_RESUMED', workspaceId: wid });
} finally { await db.end(); }
