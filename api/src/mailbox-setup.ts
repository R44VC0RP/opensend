import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { SESClient, CreateReceiptRuleCommand, CreateReceiptRuleSetCommand, DeleteReceiptRuleCommand, DescribeActiveReceiptRuleSetCommand, DescribeReceiptRuleSetCommand, SetActiveReceiptRuleSetCommand, UpdateReceiptRuleCommand, type ReceiptRule } from '@aws-sdk/client-ses';
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketLifecycleConfigurationCommand, PutBucketPolicyCommand, PutBucketTaggingCommand, PutPublicAccessBlockCommand } from '@aws-sdk/client-s3';
import { SNSClient, CreateTopicCommand, ListSubscriptionsByTopicCommand, ListTagsForResourceCommand, SetTopicAttributesCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { ApiError, log, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { jobs } from './db/core.js';
import { mailboxDomains, mailboxRegions } from './db/mailbox.js';
import { enqueue, MAX_ATTEMPTS } from './jobs.js';
import { checkMx } from './mailbox-dns.js';
import { getRegionSettings } from './ses-region-state.js';
import { awsError, feedbackUrl, setupResources } from './ses-setup.js';

const OWNER_TAG = 'opensend:installation-id';
const PURPOSE_TAG = 'opensend:purpose';
const PURPOSE = 'mailbox-inbound';
const RULE_CAPACITY = 500; // SES receipt-rule recipient quota.
export const RAW_PREFIX = 'raw/';
export const ATTACHMENT_PREFIX = 'att/';
const RAW_RETENTION_DAYS = 90;

export function mailboxResources(installationId: string, region: string) {
  const prefix = setupResources(installationId).topicName.replace(/-feedback$/, '');
  return { prefix, topicName: `${prefix}-inbound`, bucket: `${prefix}-mail-${region}`, ruleSetName: `${prefix}-inbound`, rulePrefix: `${prefix}-inbound-` };
}

function awsConfig(runtime: Runtime, region: string) {
  if (!runtime.config.aws) throw new ApiError(503, 'AWS_NOT_CONFIGURED', 'Configure AWS access credentials to enable mailboxes.');
  return { region, credentials: runtime.config.aws, ignoreConfiguredEndpointUrls: true, maxAttempts: 2, requestHandler: new FetchHttpHandler({ requestTimeout: 15000 }) };
}
export function mailboxS3(runtime: Runtime, region: string) { return new S3Client({ ...awsConfig(runtime, region), maxAttempts: 3 }); }

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
    { Sid: 'OpenSendSesInbound', Effect: 'Allow', Principal: { Service: 'ses.amazonaws.com' }, Action: 's3:PutObject', Resource: `arn:aws:s3:::${bucket}/${RAW_PREFIX}*`, Condition: { StringEquals: { 'AWS:SourceAccount': account }, ArnLike: { 'AWS:SourceArn': ruleSourceArn(region, account, rulePrefix) } } },
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
async function ensureRegion(runtime: Runtime, region: string, installationId: string, signal: AbortSignal, { sts, s3, sns, ses }: Clients): Promise<RegionResources & { rules: ReceiptRule[] }> {
  const names = mailboxResources(installationId, region);
  const endpoint = feedbackUrl(runtime.config);
  {
    const identity = await aws('sts:GetCallerIdentity', () => sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal }));
    const account = identity.Account;
    if (!account || !/^\d{12}$/.test(account)) throw new ApiError(503, 'AWS_ACCOUNT_UNKNOWN', 'STS did not return a valid AWS account identity.');
    if (runtime.config.awsAccountId && runtime.config.awsAccountId !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'Mailboxes must use the same AWS account as the provisioned SES region.');

    // Bucket: a 403 on HeadBucket means another AWS account owns the name.
    let exists = true;
    try { await s3.send(new HeadBucketCommand({ Bucket: names.bucket }), { abortSignal: signal }); }
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
      { ID: 'opensend-raw-retention', Status: 'Enabled', Filter: { Prefix: RAW_PREFIX }, Expiration: { Days: RAW_RETENTION_DAYS } },
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
    await runtime.db.update(mailboxRegions).set({ accountId: account, bucket: names.bucket, topicArn: expectedTopic, updatedAt: new Date().toISOString() }).where(and(eq(mailboxRegions.workspaceId, runtime.config.workspaceId), eq(mailboxRegions.region, region)));
    const subscriptions = await aws('sns:ListSubscriptionsByTopic', () => sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: expectedTopic }), { abortSignal: signal }));
    if (!subscriptions.Subscriptions?.some(sub => sub.Protocol === 'https' && sub.Endpoint === endpoint)) {
      await aws('sns:Subscribe', () => sns.send(new SubscribeCommand({ TopicArn: expectedTopic, Protocol: 'https', Endpoint: endpoint, ReturnSubscriptionArn: true, Attributes: { RawMessageDelivery: 'false' } }), { abortSignal: signal }));
    }

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
  return { Name: name, Enabled: true, TlsPolicy: 'Optional', ScanEnabled: true, Recipients: [...recipients].sort(), Actions: [{ S3Action: { BucketName: resources.bucket, ObjectKeyPrefix: RAW_PREFIX, TopicArn: resources.topicArn } }] };
}
function ruleMatches(rule: ReceiptRule, expected: ReceiptRule) {
  const action = rule.Actions?.length === 1 ? rule.Actions[0]!.S3Action : undefined;
  const want = expected.Actions![0]!.S3Action!;
  return rule.Enabled === true && rule.ScanEnabled === true && rule.TlsPolicy === 'Optional' && JSON.stringify([...(rule.Recipients ?? [])].sort()) === JSON.stringify(expected.Recipients)
    && action?.BucketName === want.BucketName && action?.ObjectKeyPrefix === want.ObjectKeyPrefix && action?.TopicArn === want.TopicArn && !action?.KmsKeyArn;
}

/**
 * Makes the OpenSend receipt rules accept exactly the domains whose mailbox state wants mail.
 * Rules are packed up to the SES recipient quota. A rule is deleted instead of emptied:
 * a receipt rule with no recipients matches every address on every domain.
 */
export async function reconcileRegion(runtime: Runtime, region: string): Promise<void> {
  const workspaceId = runtime.config.workspaceId;
  await runtime.db.insert(mailboxRegions).values({ workspaceId, region }).onConflictDoNothing();
  const [lease] = await runtime.db.update(mailboxRegions).set({ reconcileLeaseUntil: sql`now() + interval '5 minutes'` })
    .where(and(eq(mailboxRegions.workspaceId, workspaceId), eq(mailboxRegions.region, region), sql`(${mailboxRegions.reconcileLeaseUntil} IS NULL OR ${mailboxRegions.reconcileLeaseUntil} < now())`)).returning({ region: mailboxRegions.region });
  if (!lease) throw new ApiError(503, 'MAILBOX_RECONCILE_BUSY', 'Another mailbox setup run owns this region; retrying.', undefined, true);
  const signal = AbortSignal.timeout(240000);
  const config = awsConfig(runtime, region);
  const sesClient = new SESClient(config);
  const clients = { sts: new STSClient(config), s3: new S3Client(config), sns: new SNSClient(config), ses: pacedSes(sesClient, signal) };
  try {
    const settings = await getRegionSettings(runtime.db, workspaceId);
    const resources = { ...await ensureRegion(runtime, region, settings.installationId, signal, clients), ses: clients.ses };
    const names = mailboxResources(settings.installationId, region);
    const rows = await runtime.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, workspaceId), eq(mailboxDomains.region, region)));
    const desired = new Set(rows.filter(row => ['provisioning', 'waiting_for_mx', 'active'].includes(row.status)).map(row => row.name));
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
    for (const row of rows) {
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
  return enqueue(db, { type: 'mailbox.reconcile', workspaceId, environment: 'live', payload: { region } });
}

const reconcileJob: JobHandler = async (runtime, payload, job) => {
  const region = typeof payload.region === 'string' ? payload.region : '';
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid mailbox reconcile job.');
  try { await reconcileRegion(runtime, region); }
  catch (error) {
    const failure = error instanceof ApiError ? error : new ApiError(503, 'MAILBOX_SETUP_FAILED', 'Mailbox setup could not complete; it will be retried.', undefined, true);
    const final = !failure.retryable || job.attempts >= MAX_ATTEMPTS;
    const message = `${failure.code}: ${failure.message}`.slice(0, 500);
    if (failure.code !== 'MAILBOX_RECONCILE_BUSY') {
      const now = new Date().toISOString();
      await runtime.db.update(mailboxRegions).set({ lastError: message, updatedAt: now }).where(and(eq(mailboxRegions.workspaceId, runtime.config.workspaceId), eq(mailboxRegions.region, region)));
      await runtime.db.update(mailboxDomains).set({ lastError: message, ...(final ? { status: 'failed' as const } : {}), updatedAt: now })
        .where(and(eq(mailboxDomains.workspaceId, runtime.config.workspaceId), eq(mailboxDomains.region, region), inArray(mailboxDomains.status, ['provisioning', 'disabling'])));
    }
    throw failure;
  }
};

/** Hourly: refresh MX state for receiving domains so status follows DNS changes. */
export async function refreshMailboxDns(runtime: Runtime, limit = 50) {
  const rows = await runtime.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, runtime.config.workspaceId), inArray(mailboxDomains.status, ['waiting_for_mx', 'active']), sql`(${mailboxDomains.checkedAt} IS NULL OR ${mailboxDomains.checkedAt} < now() - interval '50 minutes')`)).limit(limit);
  for (const row of rows) {
    const mx = await checkMx(row.name, row.region);
    if (mx.state === 'error') continue;
    await runtime.db.update(mailboxDomains).set({ mx, checkedAt: mx.checkedAt, status: mx.state === 'active' ? 'active' : 'waiting_for_mx', updatedAt: new Date().toISOString() }).where(and(eq(mailboxDomains.id, row.id), inArray(mailboxDomains.status, ['waiting_for_mx', 'active'])));
  }
}

export const mailboxSetupJobs: Record<string, JobHandler> = { 'mailbox.reconcile': reconcileJob };
