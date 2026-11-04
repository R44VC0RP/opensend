import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, inArray, isNull, sql,type SQLWrapper } from 'drizzle-orm';
import { SESClient, CreateReceiptRuleCommand, CreateReceiptRuleSetCommand, DeleteReceiptRuleCommand, DescribeActiveReceiptRuleSetCommand, DescribeReceiptRuleSetCommand, SetActiveReceiptRuleSetCommand, UpdateReceiptRuleCommand, type ReceiptRule } from '@aws-sdk/client-ses';
import { S3Client, CopyObjectCommand, CreateBucketCommand, HeadBucketCommand, PutBucketLifecycleConfigurationCommand, PutBucketPolicyCommand, PutBucketTaggingCommand, PutPublicAccessBlockCommand } from '@aws-sdk/client-s3';
import { SNSClient, CreateTopicCommand, ListSubscriptionsByTopicCommand, ListTagsForResourceCommand, SetTopicAttributesCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { ApiError, assertSesConfigured, log, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { jobs } from './db/core.js';
import { mailboxDomains, mailboxRegions,type MxReport } from './db/mailbox.js';
import { enqueue, MAX_ATTEMPTS } from './jobs.js';
import { checkMx } from './mailbox-dns.js';
import { copyWorkspaceRaw } from './mailbox-mime.js';
import { getRegionSettings } from './ses-region-state.js';
import { awsError, feedbackUrl, POOL_INSTALLATION, setupResources } from './ses-setup.js';
import { platformCredentials, workspaceConnection, workspaceCredentials,type ReadyConnection } from './provider-credentials.js';

const OWNER_TAG = 'opensend:installation-id';
const PURPOSE_TAG = 'opensend:purpose';
const PURPOSE = 'mailbox-inbound';
const RULE_CAPACITY = 500; // SES receipt-rule recipient quota.
export const STAGING_PREFIX = 'staging/';
export const workspacePrefix = (wid:string, kind:'raw'|'att') => `workspaces/${wid}/${kind}/`;
export function assertMailboxKey(wid:string,key:string,kind:'raw'|'att') {
  if (!key.startsWith(workspacePrefix(wid,kind)) || key.split('/').some(s=>!s || s==='.' || s==='..')) throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','The object is not in this workspace.');
}
const RAW_RETENTION_DAYS = 90;

export function mailboxResources(installationId: string, region: string, account?:string) {
  const prefix = setupResources(installationId).topicName.replace(/-feedback$/, '');
  return { prefix, topicName: `${prefix}-inbound`, bucket: `${prefix}${installationId===POOL_INSTALLATION?`-${account}`:''}-mail-${region}`, ruleSetName: `${prefix}-inbound`, rulePrefix: `${prefix}-inbound-` };
}

function awsConfig(region:string, credentials:NonNullable<Runtime['config']['aws']>) {
  return { region, credentials, ignoreConfiguredEndpointUrls: true, maxAttempts: 2, requestHandler: new FetchHttpHandler({ requestTimeout: 15000 }) };
}
export function storageBinding(wid:string,region:string|SQLWrapper,bucket:string|SQLWrapper) {
  return sql<ReadyConnection|null>`(SELECT to_jsonb(matched) FROM (
      SELECT 'shared' AS kind,NULL AS id,aws_account_id,NULL AS role_arn,NULL::uuid AS external_id FROM provider_pool_regions
      WHERE region=${region} AND inbound_bucket=${bucket}
      UNION ALL SELECT c.kind,c.id,c.aws_account_id,c.role_arn,c.external_id FROM provider_connections c JOIN mailbox_regions r
      ON r.workspace_id=c.workspace_id AND r.region=c.region AND r.account_id=c.aws_account_id
      WHERE c.workspace_id=${wid} AND c.region=${region} AND c.kind='byo' AND c.status='ready' AND r.bucket=${bucket}) matched)`;
}
export async function mailboxS3(runtime: Runtime, wid:string, region: string, bucket:string, db:DbExecutor=runtime.db, resolved?:ReadyConnection|null) {
  let credentials=platformCredentials(runtime);
  if (runtime.config.multiTenant) {
    const binding=resolved===undefined ? (await db.execute<{binding:ReadyConnection|null}>(sql`SELECT ${storageBinding(wid,region,bucket)} AS binding`)).rows[0]!.binding : resolved;
    if (!binding) throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','The mailbox storage connection is unavailable.');
    credentials=await workspaceCredentials(runtime,region,binding);
  }
  return new S3Client({ ...awsConfig(region, credentials), maxAttempts: 3 });
}

/** Upgrade old single-tenant objects on first read. Never sign a legacy key or touch it on MX. */
export async function readableMailboxKey(runtime:Runtime,wid:string,region:string,bucket:string,key:string,kind:'raw'|'att',db:DbExecutor=runtime.db,client?:S3Client) {
  if (!runtime.config.multiTenant && !key.startsWith('workspaces/')) {
    const raw=kind==='raw';
    if (!(raw ? /^raw\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/ : /^att\/msg_[a-f0-9]{32}\/matt_[a-f0-9]{32}$/).test(key)) throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','Unknown legacy object key.');
    const dest=workspacePrefix(wid,kind)+key.slice(4)+(raw?'.eml':'');
    const binding=raw ? sql`SELECT envelope_to FROM mail_messages WHERE workspace_id=${wid} AND region=${region} AND raw_bucket=${bucket} AND raw_key=${key} AND raw_key='raw/'||ses_message_id` : sql`SELECT 1 FROM mail_attachments WHERE workspace_id=${wid} AND bucket=${bucket} AND storage_key=${key} AND storage_key='att/'||message_id||'/'||id`;
    const row=(await db.execute<{envelope_to:string[]}>(binding)).rows[0];
    if (!row) throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','Unknown legacy mailbox object.');
    const s3=client ?? await mailboxS3(runtime,wid,region,bucket,db);
    try { if(raw) await copyWorkspaceRaw(s3,region,bucket,key,dest,row.envelope_to,'legacy-raw');else await s3.send(new CopyObjectCommand({Bucket:bucket,Key:dest,CopySource:`${bucket}/${key}`})); }
    finally {if(!client)s3.destroy();}
    // A raw download must continue to expire with its original, not 90 days from its last download.
    if(!raw) await db.execute(sql`UPDATE mail_attachments SET storage_key=${dest} WHERE workspace_id=${wid} AND bucket=${bucket} AND storage_key=${key}`);
    key=dest;
  }
  assertMailboxKey(wid,key,kind);
  return key;
}

// SES control-plane actions (including receipt rules) are limited to one request per second.
function pacedSes(client: SESClient, signal: AbortSignal) {
  let last = -Infinity; let queue: Promise<unknown> = Promise.resolve();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <T = unknown>(label: string, command: any): Promise<T> => {
    const run = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = 1000 - (performance.now() - last);
        if (wait > 0) await delay(Math.ceil(wait), undefined, { signal });
        try { return await client.send(command, { abortSignal: signal }) as T; }
        catch (error) {
          if (attempt < 2 && /Throttl|TooManyRequests/.test(error instanceof Error ? error.name : '')) { await delay(1000 * 2 ** attempt, undefined, { signal }); continue; }
          throw step(label, error);
        } finally { last = performance.now(); }
      }
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
}
// Name the failing AWS action so an IAM gap is obvious from the stored error.
type StepError = ApiError & { awsName?: string };
function step(label: string, error: unknown): StepError {
  if (error instanceof ApiError) return error;
  const mapped = awsError(error), name = errorName(error);
  const result: StepError = new ApiError(mapped.status, mapped.code, `${mapped.message} (${label}${name ? `: ${name}` : ''})`, mapped.field, mapped.retryable);
  result.awsName = name;
  return result;
}
async function aws<T>(label: string, work: () => Promise<T>): Promise<T> { try { return await work(); } catch (error) { throw step(label, error); } }
const tags = (installationId: string) => [{ Key: OWNER_TAG, Value: installationId }, { Key: PURPOSE_TAG, Value: PURPOSE }];
const errorName = (error: unknown) => error instanceof Error ? error.name : '';
const httpStatus = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

function ruleSourceArn(region: string, account: string, rulePrefix: string) { return `arn:aws:ses:${region}:${account}:receipt-rule-set/*:receipt-rule/${rulePrefix}*`; }
function bucketPolicy(bucket: string, region: string, account: string, rulePrefix: string) {
  return { Version: '2012-10-17', Statement: [
    { Sid: 'OpenSendSesInbound', Effect: 'Allow', Principal: { Service: 'ses.amazonaws.com' }, Action: 's3:PutObject', Resource: `arn:aws:s3:::${bucket}/${STAGING_PREFIX}*`, Condition: { StringEquals: { 'AWS:SourceAccount': account }, ArnLike: { 'AWS:SourceArn': ruleSourceArn(region, account, rulePrefix) } } },
    { Sid: 'OpenSendTlsOnly', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
  ] };
}
function topicPolicy(topicArn: string, region: string, account: string, rulePrefix: string) {
  return { Version: '2012-10-17', Statement: [
    { Sid: 'OpenSendOwner', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: ['sns:GetTopicAttributes', 'sns:SetTopicAttributes', 'sns:AddPermission', 'sns:RemovePermission', 'sns:DeleteTopic', 'sns:Subscribe', 'sns:ListSubscriptionsByTopic', 'sns:Publish'], Resource: topicArn },
    { Sid: 'OpenSendSesInbound', Effect: 'Allow', Principal: { Service: 'ses.amazonaws.com' }, Action: 'sns:Publish', Resource: topicArn, Condition: { StringEquals: { 'AWS:SourceAccount': account }, ArnLike: { 'AWS:SourceArn': ruleSourceArn(region, account, rulePrefix) } } },
  ] };
}

export type RegionResources = { account: string; bucket: string; topicArn: string; ruleSetName: string };

/** Idempotently creates the OpenSend-owned bucket, SNS topic + HTTPS subscription and ensures an active receipt rule set. */
type Clients = { sts: STSClient; s3: S3Client; sns: SNSClient; ses: ReturnType<typeof pacedSes> };
async function ensureRegion(runtime: Runtime, region: string, installationId: string, signal: AbortSignal, { sts, s3, sns, ses }: Clients, register:(account:string,bucket:string,arn:string)=>Promise<void>, knownAccount?:string): Promise<RegionResources & { rules: ReceiptRule[] }> {
  const endpoint = feedbackUrl(runtime.config);
  {
    const account = knownAccount ?? (await aws('sts:GetCallerIdentity', () => sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal }))).Account;
    if (!account || !/^\d{12}$/.test(account)) throw new ApiError(503, 'AWS_ACCOUNT_UNKNOWN', 'STS did not return a valid AWS account identity.');
    if (runtime.config.awsAccountId && runtime.config.awsAccountId !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'Mailboxes must use the same AWS account as the provisioned SES region.');
    const names = mailboxResources(installationId, region,account);

    // Bucket: a 403 on HeadBucket means another AWS account owns the name.
    let exists = true;
    try { await s3.send(new HeadBucketCommand({ Bucket: names.bucket,ExpectedBucketOwner:account }), { abortSignal: signal }); }
    catch (error) {
      if (httpStatus(error) === 404 || errorName(error) === 'NotFound') exists = false;
      else if (httpStatus(error) === 403) throw new ApiError(409, 'MAILBOX_BUCKET_CONFLICT', `The S3 bucket name ${names.bucket} is owned by another AWS account.`);
      else throw step('s3:HeadBucket', error);
    }
    if (!exists) {
      try { await s3.send(new CreateBucketCommand({ Bucket: names.bucket, ObjectOwnership: 'BucketOwnerEnforced', ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }) }), { abortSignal: signal }); }
      catch (error) { if (errorName(error) !== 'BucketAlreadyOwnedByYou') throw errorName(error) === 'BucketAlreadyExists' ? new ApiError(409, 'MAILBOX_BUCKET_CONFLICT', `The S3 bucket name ${names.bucket} is taken.`) : step('s3:CreateBucket', error); }
    }
    await aws('s3:PutBucketTagging', () => s3.send(new PutBucketTaggingCommand({ Bucket: names.bucket, Tagging: { TagSet: tags(installationId) } }), { abortSignal: signal }));
    await aws('s3:PutPublicAccessBlock', () => s3.send(new PutPublicAccessBlockCommand({ Bucket: names.bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }), { abortSignal: signal }));
    await aws('s3:PutBucketPolicy', () => s3.send(new PutBucketPolicyCommand({ Bucket: names.bucket, Policy: JSON.stringify(bucketPolicy(names.bucket, region, account, names.rulePrefix)) }), { abortSignal: signal }));
    await aws('s3:PutLifecycleConfiguration', () => s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket: names.bucket, LifecycleConfiguration: { Rules: [
      { ID:'opensend-staging',Status:'Enabled',Filter:{Prefix:STAGING_PREFIX},Expiration:{Days:3} },
      { ID: 'opensend-raw-retention', Status: 'Enabled', Filter: { Tag:{Key:'opensend-kind',Value:'raw'} }, Expiration: { Days: RAW_RETENTION_DAYS } },
      { ID:'opensend-legacy-raw',Status:'Enabled',Filter:{Prefix:'raw/'},Expiration:{Days:RAW_RETENTION_DAYS} },
      ...(installationId!==POOL_INSTALLATION ? [{ID:'opensend-legacy-downloads',Status:'Enabled' as const,Filter:{Tag:{Key:'opensend-kind',Value:'legacy-raw'}},Expiration:{Days:1}}] : []),
      { ID: 'opensend-abort-uploads', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
    ] } }), { abortSignal: signal }));

    // Topic: CreateTopic is idempotent, so ownership is proven by tags, never by name alone.
    const expectedTopic = `arn:aws:sns:${region}:${account}:${names.topicName}`;
    const created = await aws('sns:CreateTopic', () => sns.send(new CreateTopicCommand({ Name: names.topicName, Tags: tags(installationId) }), { abortSignal: signal }));
    if (created.TopicArn !== expectedTopic) throw new ApiError(409, 'RESOURCE_OWNERSHIP_CONFLICT', 'SNS did not return the expected inbound topic ARN.');
    const topicTags = await aws('sns:ListTagsForResource', () => sns.send(new ListTagsForResourceCommand({ ResourceArn: expectedTopic }), { abortSignal: signal }));
    if (!tags(installationId).every(tag => topicTags.Tags?.some(value => value.Key === tag.Key && value.Value === tag.Value))) throw new ApiError(409, 'RESOURCE_OWNERSHIP_CONFLICT', 'The inbound SNS topic exists without this installation’s ownership tags.');
    await aws('sns:SetTopicAttributes', () => sns.send(new SetTopicAttributesCommand({ TopicArn: expectedTopic, AttributeName: 'Policy', AttributeValue: JSON.stringify(topicPolicy(expectedTopic, region, account, names.rulePrefix)) }), { abortSignal: signal }));

    // Trust the topic before subscribing so the signed confirmation passes the ingress allowlist.
    await register(account,names.bucket,expectedTopic);
    const subscriptions = await aws('sns:ListSubscriptionsByTopic', () => sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: expectedTopic }), { abortSignal: signal }));
    const subscription=subscriptions.Subscriptions?.find(sub => sub.Protocol === 'https' && sub.Endpoint === endpoint);
    const subscribed=subscription ?? await aws('sns:Subscribe', () => sns.send(new SubscribeCommand({ TopicArn: expectedTopic, Protocol: 'https', Endpoint: endpoint, ReturnSubscriptionArn: false, Attributes: { RawMessageDelivery: 'false' } }), { abortSignal: signal }));
    if (installationId===POOL_INSTALLATION && !subscribed.SubscriptionArn?.startsWith(expectedTopic+':')) throw new ApiError(503,'INBOUND_CONFIRMATION_PENDING','Waiting for confirmation of the inbound SNS subscription.',undefined,true);

    // One receipt rule set is active per account and region. Join an existing one; never replace it.
    let active = await ses<{ Metadata?: { Name?: string }; Rules?: ReceiptRule[] }>('ses:DescribeActiveReceiptRuleSet', new DescribeActiveReceiptRuleSetCommand({}));
    if (!active.Metadata?.Name) {
      try { await ses('ses:CreateReceiptRuleSet', new CreateReceiptRuleSetCommand({ RuleSetName: names.ruleSetName })); }
      catch (error) { if ((error as StepError).awsName !== 'AlreadyExistsException') throw error; }
      await ses('ses:SetActiveReceiptRuleSet', new SetActiveReceiptRuleSetCommand({ RuleSetName: names.ruleSetName }));
      active = await ses('ses:DescribeReceiptRuleSet', new DescribeReceiptRuleSetCommand({ RuleSetName: names.ruleSetName }));
      if (!active.Metadata?.Name) active = { Metadata: { Name: names.ruleSetName }, Rules: active.Rules ?? [] };
    }
    return { account, bucket: names.bucket, topicArn: expectedTopic, ruleSetName: active.Metadata!.Name!, rules: active.Rules ?? [] };
  }
}

function ruleFor(name: string, recipients: string[], resources: RegionResources): ReceiptRule {
  return { Name: name, Enabled: true, TlsPolicy: 'Optional', ScanEnabled: true, Recipients: [...recipients].sort(), Actions: [{ S3Action: { BucketName: resources.bucket, ObjectKeyPrefix: STAGING_PREFIX, TopicArn: resources.topicArn } }] };
}
function ruleMatches(rule: ReceiptRule, expected: ReceiptRule) {
  const action = rule.Actions?.length === 1 ? rule.Actions[0]!.S3Action : undefined;
  const want = expected.Actions![0]!.S3Action!;
  return rule.Enabled === true && rule.ScanEnabled === true && rule.TlsPolicy === 'Optional' && JSON.stringify([...(rule.Recipients ?? [])].sort()) === JSON.stringify(expected.Recipients)
    && action?.BucketName === want.BucketName && action?.ObjectKeyPrefix === want.ObjectKeyPrefix && action?.TopicArn === want.TopicArn && !action?.KmsKeyArn;
}

/** Platform maintenance only: customer identities share one regional catch-all rule. */
export async function preparePoolReceiving(runtime:Runtime,region:string,account:string,register:(account:string,bucket:string,arn:string)=>Promise<void>) {
  assertSesConfigured(runtime);
  const config=awsConfig(region,platformCredentials(runtime)),signal=AbortSignal.timeout(90000);
  const ses=new SESClient(config),clients={ses:pacedSes(ses,signal),s3:new S3Client(config),sns:new SNSClient(config),sts:new STSClient(config)};
  try {
    const resources=await ensureRegion(runtime,region,POOL_INSTALLATION,signal,clients,register,account);
    const rule=ruleFor(mailboxResources(POOL_INSTALLATION,region,account).rulePrefix+'all',[],resources);
    const existing=resources.rules.find(r=>r.Name===rule.Name);
    if (!existing) {
      const after=resources.rules.at(-1)?.Name;
      if(resources.rules.length && !after)throw new ApiError(503,'RECEIPT_RULE_ORDER_UNKNOWN','SES did not identify the last active rule; refusing to insert ahead of it.',undefined,true);
      await clients.ses('ses:CreateReceiptRule',new CreateReceiptRuleCommand({RuleSetName:resources.ruleSetName,Rule:rule,After:after}));
    }
    else if (!ruleMatches(existing,rule)) await clients.ses('ses:UpdateReceiptRule',new UpdateReceiptRuleCommand({RuleSetName:resources.ruleSetName,Rule:rule}));
    return resources.bucket;
  } finally { ses.destroy(); clients.s3.destroy(); clients.sns.destroy(); clients.sts.destroy(); }
}

/**
 * Makes the OpenSend receipt rules accept exactly the domains whose mailbox state wants mail.
 * Rules are packed up to the SES recipient quota. A rule is deleted instead of emptied:
 * a receipt rule with no recipients matches every address on every domain.
 */
export async function reconcileRegion(runtime: Runtime, region: string, workspaceId:string): Promise<void> {
  assertSesConfigured(runtime);
  const scoped={...runtime,config:{...runtime.config,workspaceId}};
  const connection=runtime.config.multiTenant ? await workspaceConnection(scoped,region) : undefined;
  if (connection?.kind==='shared') return; // Pool preparation is never a per-domain operation.
  const config = awsConfig(region,connection ? await workspaceCredentials(scoped,region,connection) : platformCredentials(runtime));
  await runtime.db.insert(mailboxRegions).values({ workspaceId, region }).onConflictDoNothing();
  // The lease must expire before the job's own lease (3 minutes), so a retry of a run that died can take over
  // instead of failing as busy. A normal run takes seconds; the abort below keeps a live run inside the lease.
  const [lease] = await runtime.db.update(mailboxRegions).set({ reconcileLeaseUntil: sql`now() + interval '2 minutes'` })
    .where(and(eq(mailboxRegions.workspaceId, workspaceId), eq(mailboxRegions.region, region), sql`(${mailboxRegions.reconcileLeaseUntil} IS NULL OR ${mailboxRegions.reconcileLeaseUntil} < now())`)).returning({ region: mailboxRegions.region });
  if (!lease) throw new ApiError(503, 'MAILBOX_RECONCILE_BUSY', 'Another mailbox setup run owns this region; retrying.', undefined, true);
  const signal = AbortSignal.timeout(100000);
  const sesClient = new SESClient(config);
  const clients = { sts: new STSClient(config), s3: new S3Client(config), sns: new SNSClient(config), ses: pacedSes(sesClient, signal) };
  try {
    const settings = await getRegionSettings(runtime.db, workspaceId);
    const resources = { ...await ensureRegion({...runtime,config:{...runtime.config,awsAccountId:connection?.aws_account_id ?? runtime.config.awsAccountId}}, region, settings.installationId, signal, clients,async(account,bucket,arn)=>{
      await runtime.db.update(mailboxRegions).set({ accountId:account,bucket,topicArn:arn,updatedAt:new Date().toISOString() }).where(and(eq(mailboxRegions.workspaceId,workspaceId),eq(mailboxRegions.region,region)));
    }), ses: clients.ses };
    const names = mailboxResources(settings.installationId, region);
    const rows = await runtime.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, workspaceId), eq(mailboxDomains.region, region),connection ? sql`EXISTS (SELECT 1 FROM domain_claims dc JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name WHERE dc.connection_id=${connection.id} AND dc.receiving_name=${mailboxDomains.receivingHost} AND dc.workspace_id=${workspaceId} AND d.id=${mailboxDomains.domainId} AND d.region=${region})` : undefined));
    // Self-hosted wildcard rows are covered by their parent. BYO rules list only MX-proven hostnames.
    const receiving = rows.filter(row => !row.parentId && ['provisioning', 'waiting_for_mx', 'active'].includes(row.status));
    const desired = new Set(connection ? rows.map(row=>row.receivingHost!) : receiving.flatMap(row => row.acceptSubdomains ? [row.name, `.${row.name}`] : [row.name]));
    const ours = resources.rules.filter(rule => rule.Name?.startsWith(names.rulePrefix)).sort((a, b) => a.Name!.localeCompare(b.Name!));
    const current = new Set(ours.flatMap(rule => rule.Recipients ?? []));
    const pending = [...desired].filter(name => !current.has(name)).sort();
    const plan = ours.map(rule => {
      const kept = (rule.Recipients ?? []).filter(name => desired.has(name));
      while (kept.length < RULE_CAPACITY && pending.length) kept.push(pending.shift()!);
      return { name: rule.Name!, existing: rule, recipients: kept };
    });
    let next = ours.reduce((max, rule) => Math.max(max, Number(rule.Name!.slice(names.rulePrefix.length)) || 0), 0);
    while (pending.length) plan.push({ name: `${names.rulePrefix}${String(++next).padStart(3, '0')}`, existing: undefined as unknown as ReceiptRule, recipients: pending.splice(0, RULE_CAPACITY) });
    let after = resources.rules.at(-1)?.Name;
    for (const item of plan) {
      const rule = ruleFor(item.name, item.recipients, resources);
      if (!item.recipients.length) { if (item.existing) await resources.ses('ses:DeleteReceiptRule', new DeleteReceiptRuleCommand({ RuleSetName: resources.ruleSetName, RuleName: item.name })); continue; }
      if (!item.existing) { await resources.ses('ses:CreateReceiptRule', new CreateReceiptRuleCommand({ RuleSetName: resources.ruleSetName, Rule: rule, ...(after ? { After: after } : {}) })); after = item.name; }
      else if (!ruleMatches(item.existing, rule)) await resources.ses('ses:UpdateReceiptRule', new UpdateReceiptRuleCommand({ RuleSetName: resources.ruleSetName, Rule: rule }));
    }
    const now = new Date().toISOString();
    await runtime.db.update(mailboxRegions).set({ ruleSetName: resources.ruleSetName, lastReconciledAt: now, lastError: null, updatedAt: now }).where(and(eq(mailboxRegions.workspaceId, workspaceId), eq(mailboxRegions.region, region)));
    if (connection) {
      // DNS can move while AWS is working. Activate only still-claimed hosts in the rule we installed.
      await runtime.db.execute(sql`WITH activated AS (
        UPDATE mailbox_domains m SET status='active',last_error=NULL,updated_at=now(),enabled_at=now()
        FROM domain_claims dc JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name
        WHERE dc.connection_id=${connection.id} AND dc.workspace_id=${workspaceId} AND d.region=${region}
          AND dc.receiving_name=m.receiving_host AND m.domain_id=d.id AND m.workspace_id=d.workspace_id AND m.status<>'active'
          AND m.receiving_host IN (SELECT jsonb_array_elements_text(${JSON.stringify([...desired])}::jsonb)) RETURNING dc.token
      ) UPDATE domain_claims SET readiness=jsonb_set(readiness,'{receiving}','"verified"') WHERE token IN (SELECT token FROM activated)`);
      return;
    }
    for (const row of rows) {
      if (row.parentId) continue;
      if (row.status === 'disabling') { await runtime.db.update(mailboxDomains).set({ status: 'disabled', lastError: null, updatedAt: now }).where(and(eq(mailboxDomains.id, row.id), eq(mailboxDomains.status, 'disabling'))); continue; }
      if (row.status !== 'provisioning') continue;
      const mx = await checkMx(row.name, region);
      await runtime.db.update(mailboxDomains).set({ status: mx.state === 'active' ? 'active' : 'waiting_for_mx', mx, checkedAt: mx.checkedAt, enabledAt: row.enabledAt ?? now, lastError: null, updatedAt: now })
        .where(and(eq(mailboxDomains.id, row.id), eq(mailboxDomains.status, row.status)));
    }
    log('info', { code: 'MAILBOX_REGION_RECONCILED', region, domains: desired.size, rules: plan.filter(item => item.recipients.length).length });
  } finally {
    clients.sts.destroy(); clients.s3.destroy(); clients.sns.destroy(); sesClient.destroy();
    await runtime.db.update(mailboxRegions).set({ reconcileLeaseUntil: null }).where(and(eq(mailboxRegions.workspaceId, workspaceId), eq(mailboxRegions.region, region)));
  }
}

/** Queue one reconcile per region unless one is already waiting (a running one may have read older state). */
export async function queueReconcile(db: DbExecutor, workspaceId: string, region: string) {
  const [waiting] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, 'mailbox.reconcile'), eq(jobs.status, 'pending'), sql`${jobs.payload}->>'region' = ${region}`)).limit(1);
  if (waiting) return waiting.id;
  return enqueue(db, { type: 'mailbox.reconcile', workspaceId, payload: { region } });
}

const reconcileJob: JobHandler = async (runtime, payload, job) => {
  const region = typeof payload.region === 'string' ? payload.region : '';
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid mailbox reconcile job.');
  try { await reconcileRegion(runtime, region,job.workspaceId); }
  catch (error) {
    const failure = error instanceof ApiError ? error : new ApiError(503, 'MAILBOX_SETUP_FAILED', 'Mailbox setup could not complete; it will be retried.', undefined, true);
    const final = !failure.retryable || job.attempts >= MAX_ATTEMPTS;
    const message = `${failure.code}: ${failure.message}`.slice(0, 500);
    if (failure.code !== 'MAILBOX_RECONCILE_BUSY') {
      const now = new Date().toISOString();
      await runtime.db.update(mailboxRegions).set({ lastError: message, updatedAt: now }).where(and(eq(mailboxRegions.workspaceId, job.workspaceId), eq(mailboxRegions.region, region)));
      await runtime.db.update(mailboxDomains).set({ lastError: message, ...(final ? { status: 'failed' as const } : {}), updatedAt: now })
        .where(and(eq(mailboxDomains.workspaceId, job.workspaceId), eq(mailboxDomains.region, region), inArray(mailboxDomains.status, ['provisioning', 'disabling'])));
    }
    throw failure;
  }
};

/** Self-hosted legacy routes have no domain_claims row. Keep their last good observation on outages too. */
export async function saveMailboxMx(db:DbExecutor,wid:string,domainId:string,mx:MxReport) {
  if (mx.state==='error') return;
  const active=mx.state==='active';
  const mixed=mx.state==='mixed';
  const hold=sql`(status='active' AND NOT ${active} AND (${mixed} OR mx_misses<2))`;
  await db.execute(sql`UPDATE mailbox_domains SET mx=CASE WHEN ${hold} THEN mx ELSE ${JSON.stringify(mx)}::jsonb END,
    checked_at=${mx.checkedAt},updated_at=now(),mx_misses=CASE WHEN ${hold} AND NOT ${mixed} THEN mx_misses+1 ELSE 0 END,
    status=CASE WHEN status NOT IN ('waiting_for_mx','active') OR ${hold} THEN status WHEN ${active} THEN 'active' ELSE 'waiting_for_mx' END
    WHERE workspace_id=${wid} AND domain_id=${domainId} AND parent_id IS NULL`);
}
/** Hourly: refresh MX state for receiving domains so status follows DNS changes. */
export async function refreshMailboxDns(runtime: Runtime, limit = 50) {
  if (runtime.config.multiTenant) {
    // Rotate a bounded batch (never-checked first) across the hour, without reopening SES verification.
    const batch=Math.max(1,Math.min(50,limit));
    await runtime.db.execute(sql`WITH due AS (SELECT dc.token,dc.workspace_id,d.id,j.created_at FROM domain_claims dc
      JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id AND pc.status='ready'
      JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name AND d.region=pc.region
      LEFT JOIN jobs j ON j.id='domain.mx:'||dc.token WHERE dc.readiness IS NOT NULL AND (j.id IS NULL OR (j.status NOT IN ('pending','running') AND j.created_at<=now()-interval '50 minutes'))
      ORDER BY j.created_at NULLS FIRST,dc.token LIMIT ${batch})
      INSERT INTO jobs(id,type,workspace_id,payload,available_at)
      SELECT 'domain.mx:'||token,'domain.mx',workspace_id,jsonb_build_object('domainId',id,'token',token),
        now()+interval '1 hour'*(row_number() OVER(ORDER BY created_at NULLS FIRST,token)-1)/${batch} FROM due
      ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,created_at=now(),lease_until=NULL,last_error=NULL WHERE jobs.status NOT IN ('pending','running')`);
    return;
  }
  const rows = await runtime.db.select().from(mailboxDomains).where(and(isNull(mailboxDomains.parentId), inArray(mailboxDomains.status, ['waiting_for_mx', 'active']), sql`(${mailboxDomains.checkedAt} IS NULL OR ${mailboxDomains.checkedAt} < now() - interval '50 minutes')`)).limit(limit);
  for (const row of rows) {
    const mx = await checkMx(row.name, row.region);
    await saveMailboxMx(runtime.db,row.workspaceId,row.domainId,mx);
  }
}

export const mailboxSetupJobs: Record<string, JobHandler> = { 'mailbox.reconcile': reconcileJob };
