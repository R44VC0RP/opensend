import { getTableColumns, sql } from 'drizzle-orm';
import { id,type DbExecutor } from './core.js';
import { mailMessages,mailAttachments } from './db/mailbox.js';
import { mailboxEventCtes } from './mailbox-events.js';
import { ADDRESS,normalizeSubject,threadSummaryConflict } from './mailbox-store.js';

type Incoming=Omit<typeof mailMessages.$inferInsert,'threadId'> & {receivedAt:string;subject:string;envelopeTo:string[]};

/** The caller has locked this workspace's ingest and address lanes in a preceding statement.
 * Its READ COMMITTED snapshot now sees the previous writer. Each modifying CTE consumes RETURNING
 * rows (not a reread of a table modified by a sibling). All AWS I/O precedes this transaction. */
export async function storeIncoming(tx:DbExecutor,m:Incoming,files:(typeof mailAttachments.$inferInsert)[]) {
  const columns=getTableColumns(mailMessages);
  const fields=Object.entries(m).filter(([,value])=>value!==undefined).map(([key,value])=>[columns[key as keyof typeof columns].name,value] as const);
  const names=fields.map(([name])=>sql.identifier(name));
  const candidates=[...new Set([m.inReplyTo,...[...(m.references??[])].reverse(),m.messageId].filter((s):s is string=>!!s))].slice(0,101);
  const recipients=m.envelopeTo.map((addr,n)=>({addr,n,valid:ADDRESS.test(addr)}));
  const result=await tx.execute<{n:number}>(sql`WITH input AS MATERIALIZED (
    SELECT x.* FROM jsonb_populate_record(NULL::mail_messages,${JSON.stringify(Object.fromEntries(fields))}::jsonb) x
    JOIN mail_receipts r ON r.workspace_id=x.workspace_id AND r.ses_message_id=x.ses_message_id AND r.status='pending'
    WHERE NOT EXISTS (SELECT 1 FROM mail_messages existing WHERE existing.id=x.id)
  ), known AS MATERIALIZED (
    SELECT old.* FROM input x JOIN mail_message_ids i USING(workspace_id,environment,message_id)
    JOIN mail_messages old ON old.id=i.mail_message_id AND old.workspace_id=x.workspace_id AND old.environment=x.environment AND old.direction='inbound'
    WHERE old.from_address=x.from_address AND old.subject=x.subject AND old.text IS NOT DISTINCT FROM x.text AND old.html IS NOT DISTINCT FROM x.html
    AND old.attachment_count=x.attachment_count AND ARRAY(SELECT sha256 FROM mail_attachments WHERE message_id=old.id ORDER BY sha256)=ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(files.map(f=>f.sha256).sort())}::jsonb))
  ), thread AS (
    INSERT INTO mail_threads AS t(id,workspace_id,environment,subject,message_count,last_message_at)
    SELECT coalesce(parent.thread_id,${id('thr')}),x.workspace_id,x.environment,${normalizeSubject(m.subject).slice(0,998)},1,x.received_at FROM input x
    LEFT JOIN LATERAL (SELECT coalesce(i.thread_id,provider.thread_id) AS thread_id FROM jsonb_array_elements_text(${JSON.stringify(candidates)}::jsonb) WITH ORDINALITY refs(ref,n)
      LEFT JOIN mail_message_ids i ON i.workspace_id=x.workspace_id AND i.environment=x.environment AND i.message_id=ref
      LEFT JOIN LATERAL (SELECT p.thread_id FROM sending_emails e JOIN mail_messages p ON p.sending_email_id=e.id AND p.workspace_id=e.workspace_id AND p.environment=e.environment
        WHERE i.thread_id IS NULL AND e.workspace_id=x.workspace_id AND e.environment=x.environment AND e.provider_id=split_part(ref,'@',1)
        AND ref=e.provider_id||'@'||CASE e.region WHEN 'us-east-1' THEN 'email' ELSE e.region END||'.amazonses.com') provider ON true
      WHERE coalesce(i.thread_id,provider.thread_id) IS NOT NULL ORDER BY n LIMIT 1) parent ON true
    WHERE NOT EXISTS(SELECT 1 FROM known) ON CONFLICT(id) DO UPDATE SET message_count=t.message_count+1,last_message_at=greatest(t.last_message_at,excluded.last_message_at) RETURNING id
  ), stored AS (INSERT INTO mail_messages(${sql.join(names,sql`,`)},thread_id) SELECT ${sql.join(names.map(name=>sql`x.${name}`),sql`,`)},thread.id FROM input x,thread RETURNING *
  ), files AS (INSERT INTO mail_attachments(id,workspace_id,environment,message_id,filename,content_type,size_bytes,content_id,disposition,sha256,bucket,storage_key)
    SELECT f.id,s.workspace_id,s.environment,s.id,f.filename,f."contentType",f."sizeBytes",f."contentId",f.disposition,f.sha256,f.bucket,f."storageKey" FROM stored s CROSS JOIN jsonb_to_recordset(${JSON.stringify(files)}::jsonb) f(id text,filename text,"contentType" text,"sizeBytes" int,"contentId" text,disposition text,sha256 text,bucket text,"storageKey" text)
  ), indexed AS (INSERT INTO mail_message_ids(workspace_id,environment,message_id,mail_message_id,thread_id) SELECT workspace_id,environment,message_id,id,thread_id FROM stored WHERE message_id IS NOT NULL ON CONFLICT DO NOTHING
  ), target AS MATERIALIZED (SELECT * FROM stored UNION ALL SELECT * FROM known), routes AS MATERIALIZED (
    SELECT addr,base,n,d.id AS domain,d.catch_all,r.valid,o.owner,o.receives,rule.id AS ruled
    FROM target x CROSS JOIN jsonb_to_recordset(${JSON.stringify(recipients)}::jsonb) r(addr text,n int,valid boolean)
    JOIN mailbox_domains d ON d.workspace_id=x.workspace_id AND d.environment=x.environment AND coalesce(d.receiving_host,d.name)=split_part(addr,'@',2) AND (d.status='active' OR (d.receiving_host IS NULL AND d.status IN ('waiting_for_mx','provisioning')))
    CROSS JOIN LATERAL (SELECT regexp_replace(addr,'[+][^@]*@','@') AS base) plus
    LEFT JOIN LATERAL (SELECT b.id AS owner,a.kind<>'public' AND (b.expires_at IS NULL OR (b.created_at<=least(x.received_at,${m.receivedAt}::timestamptz) AND b.expires_at>greatest(statement_timestamp(),least(x.received_at,${m.receivedAt}::timestamptz)))) AS receives
      FROM mailbox_addresses a JOIN mailboxes b ON b.id=a.mailbox_id WHERE a.workspace_id=x.workspace_id AND a.environment=x.environment AND a.address IN(addr,base) ORDER BY (a.address=addr) DESC LIMIT 1) o ON true
    LEFT JOIN LATERAL (SELECT b.id FROM mailboxes b WHERE o.owner IS NULL AND b.domain_id=d.id AND b.expires_at IS NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(b.rules) t(pattern) WHERE addr LIKE replace(replace(replace(replace(pattern,'!','!!'),'%','!%'),'_','!_'),'*','%') ESCAPE '!') ORDER BY b.created_at,b.id LIMIT 1) rule ON true
  ), misses AS (SELECT * FROM routes WHERE owner IS NULL AND ruled IS NULL AND valid AND catch_all='create_mailbox' AND NOT ${m.spam??false}),
  boxes AS (INSERT INTO mailboxes(id,domain_id,address,workspace_id,environment,origin)
    SELECT 'mbx_'||replace(gen_random_uuid()::text,'-',''),domain,addr,${m.workspaceId},${m.environment},'auto' FROM misses r WHERE NOT EXISTS(SELECT 1 FROM misses earlier WHERE earlier.addr=r.base AND earlier.n<r.n) RETURNING *
  ), addresses AS (INSERT INTO mailbox_addresses(workspace_id,environment,address,mailbox_id,kind) SELECT workspace_id,environment,address,id,'primary' FROM boxes),
  resolved AS (SELECT r.addr,CASE WHEN r.owner IS NOT NULL THEN CASE WHEN r.receives THEN r.owner END ELSE coalesce(base.id,r.ruled,exact.id) END AS box
    FROM routes r LEFT JOIN boxes exact ON exact.address=r.addr LEFT JOIN (boxes base JOIN misses earlier ON earlier.addr=base.address) ON base.address=r.base AND earlier.n<r.n),
  unrouted AS (INSERT INTO mail_unrouted(workspace_id,environment,message_id,address) SELECT x.workspace_id,x.environment,x.id,r.addr FROM target x,resolved r WHERE r.box IS NULL ON CONFLICT DO NOTHING),
  added AS (INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,environment,thread_id,direction,read,received_at)
    SELECT DISTINCT r.box,x.id,x.workspace_id,x.environment,x.thread_id,'inbound',false,x.received_at FROM target x,resolved r WHERE r.box IS NOT NULL ON CONFLICT DO NOTHING RETURNING *),
  summaries AS (INSERT INTO mailbox_threads AS t(mailbox_id,thread_id,workspace_id,environment,subject,snippet,participants,message_count,unread_count,last_message_at,last_inbound_at,spam,labels)
    SELECT a.mailbox_id,x.thread_id,x.workspace_id,x.environment,x.subject,x.snippet,(SELECT coalesce(jsonb_agg(p ORDER BY n),'[]') FROM (SELECT * FROM (SELECT DISTINCT ON(lower(p->>'address')) p,n FROM jsonb_array_elements(jsonb_build_array(jsonb_build_object('name',x.from_name,'address',x.from_address))||x."to"||x.cc) WITH ORDINALITY v(p,n) WHERE p->>'address'<>'' ORDER BY lower(p->>'address'),n) first_seen ORDER BY n LIMIT 20) limited),1,1,x.received_at,x.received_at,x.spam,CASE WHEN x.spam THEN ARRAY['spam'] ELSE ARRAY[]::text[] END FROM target x JOIN added a ON a.message_id=x.id ORDER BY a.mailbox_id ${threadSummaryConflict} RETURNING mailbox_id),
  done AS (UPDATE mail_receipts SET status='processed',processed_at=now(),error=NULL WHERE workspace_id=${m.workspaceId} AND ses_message_id=${m.sesMessageId} AND status='pending'),
  ${mailboxEventCtes(sql`SELECT workspace_id,environment,'message.stored' AS type,NULL::text AS mailbox_id,thread_id,id AS message_id,'{}'::jsonb AS data,1 AS ord FROM stored
    UNION ALL SELECT workspace_id,environment,'address.created',id,NULL,NULL,'{"origin":"auto"}'::jsonb,2 FROM boxes
    UNION ALL SELECT x.workspace_id,x.environment,'message.received',s.mailbox_id,x.thread_id,x.id,jsonb_build_object('from',jsonb_build_object('name',x.from_name,'address',x.from_address),'subject',x.subject,'snippet',x.snippet,'attachmentCount',x.attachment_count,'spam',x.spam,'automated',x.automated),3 FROM target x,summaries s`)} SELECT count(*)::int AS n FROM queued`);
  return result.rows[0]!.n;
}
