import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';

const db = new Client(postgresConnection(process.env.DATABASE_URL));
await db.connect();
try {
  const decisions = await db.query(`SELECT policy_version,decision,count(*) AS domains FROM domain_placement_shadow GROUP BY 1,2 ORDER BY 1,2`);
  const reasons = await db.query(`SELECT policy_version,reason,count(*) AS domains FROM domain_placement_shadow,
    jsonb_array_elements_text(reasons) AS r(reason) GROUP BY 1,2 ORDER BY 1,3 DESC,2`);
  const recent = await db.query(`SELECT d.name,p.policy_version,p.score,p.decision,p.reasons,p.recorded_at
    FROM domain_placement_shadow p JOIN operation_domains d ON d.id=p.domain_id ORDER BY p.recorded_at DESC LIMIT 50`);
  console.log(JSON.stringify({decisions:decisions.rows,reasons:reasons.rows,recent:recent.rows},null,2));
} finally { await db.end(); }
