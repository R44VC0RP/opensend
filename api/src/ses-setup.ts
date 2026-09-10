import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from '@hono/zod-openapi';
import { SESv2Client, GetAccountCommand, ListEmailIdentitiesCommand, GetConfigurationSetCommand, GetConfigurationSetEventDestinationsCommand, CreateConfigurationSetCommand, CreateConfigurationSetEventDestinationCommand, UpdateConfigurationSetEventDestinationCommand, PutConfigurationSetSuppressionOptionsCommand } from '@aws-sdk/client-sesv2';
import { SNSClient, GetTopicAttributesCommand, ListTagsForResourceCommand, ListSubscriptionsByTopicCommand, GetSubscriptionAttributesCommand, CreateTopicCommand, SetTopicAttributesCommand, SubscribeCommand, SetSubscriptionAttributesCommand } from '@aws-sdk/client-sns';
import type { Subscription } from '@aws-sdk/client-sns';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { ApiError, log } from './core.js';
import type { Config, Runtime } from './core.js';

const flag = z.boolean().nullable();
const issue = z.object({ code: z.string(), message: z.string() });
export const AutoValidationModeSchema = z.enum(['inherit', 'off', 'managed', 'medium', 'high', 'unknown']);
export type AutoValidationMode = z.infer<typeof AutoValidationModeSchema>;
const setSchema = z.object({ name: z.string(), exists: flag, owned: flag, sendingEnabled: flag, eventDestinationExists: flag, eventWired: flag, autoValidation: AutoValidationModeSchema.nullable() });
export const SesDiscoverySchema = z.object({
  region: z.string(), checkedAt: z.string(),
  account: z.object({ id: z.string(), productionAccess: flag, sendingEnabled: flag, enforcementStatus: z.string().nullable(), quota: z.object({ max24HourSend: z.number().nullable(), maxSendRate: z.number().nullable(), sentLast24Hours: z.number().nullable() }) }).nullable(),
  domains: z.array(z.object({ name: z.string(), verificationStatus: z.string().nullable(), sendingEnabled: flag })),
  identitiesTruncated: z.boolean(),
  resources: z.object({
    transactional: setSchema, marketing: setSchema, eventDestinationName: z.string(),
    topic: z.object({ name: z.string(), arn: z.string().nullable(), exists: flag, owned: flag, policyReady: flag, subscription: z.enum(['unknown', 'missing', 'pending', 'confirmed']), rawMessageDelivery: flag, subscriptionsTruncated: z.boolean(), staleSubscriptions: z.number().int() }),
  }),
  feedbackUrl: z.string().nullable(), status: z.enum(['ready', 'needs_provisioning', 'blocked']), provisioned: z.boolean(),
  blockers: z.array(issue), warnings: z.array(issue),
}).openapi('SesDiscovery');
export type SesDiscovery = z.infer<typeof SesDiscoverySchema>;
export type SesSetupOptions = { region: string; installationId: string };
export type SesProvisionOptions = SesSetupOptions & { registerTopic: (accountId: string, topicArn: string) => Promise<void> };

// OPEN/CLICK destinations support tracking-enabled sends; per-message tracking overrides
// in sending.ts still disable instrumentation when tracking:false. Consent stays in OpenSend.
const EVENTS = ['SEND', 'DELIVERY', 'BOUNCE', 'COMPLAINT', 'REJECT', 'RENDERING_FAILURE', 'DELIVERY_DELAY', 'OPEN', 'CLICK'] as const;
const OWNER_TAG = 'opensend:installation-id';
const PURPOSE_TAG = 'opensend:purpose';
const PURPOSE = 'ses-feedback';
const LIMIT = 1000;
const DEFAULT_AUTO_VALIDATION = { transactional: 'off', marketing: 'managed' } as const;

function autoValidationMode(options: { ValidationOptions?: { ConditionThreshold?: { ConditionThresholdEnabled?: string; OverallConfidenceThreshold?: { ConfidenceVerdictThreshold?: string } } } } | undefined): AutoValidationMode {
  const condition = options?.ValidationOptions?.ConditionThreshold;
  if (!condition) return 'inherit';
  if (condition.ConditionThresholdEnabled === 'DISABLED') return 'off';
  const threshold = condition.OverallConfidenceThreshold?.ConfidenceVerdictThreshold?.toLowerCase();
  return condition.ConditionThresholdEnabled === 'ENABLED' && ['managed', 'medium', 'high'].includes(threshold ?? '') ? threshold as AutoValidationMode : 'unknown';
}

function validationInput(name: string, mode: Exclude<AutoValidationMode, 'inherit' | 'unknown'>) {
  return new PutConfigurationSetSuppressionOptionsCommand({ ConfigurationSetName: name, SuppressionScope: 'ACCOUNT', SuppressedReasons: ['BOUNCE', 'COMPLAINT'], ValidationOptions: { ConditionThreshold: mode === 'off' ? { ConditionThresholdEnabled: 'DISABLED' } : { ConditionThresholdEnabled: 'ENABLED', OverallConfidenceThreshold: { ConfidenceVerdictThreshold: mode.toUpperCase() as 'MANAGED' | 'MEDIUM' | 'HIGH' } } } });
}

export function setupResources(installationId: string): { transactional: string; marketing: string; topicName: string; eventDestinationName: string } {
  if (!installationId) throw new ApiError(503, 'INSTALLATION_ID_REQUIRED', 'The persisted installation ID is missing.');
  const prefix = `opensend-${createHash('sha256').update(installationId).digest('hex').slice(0, 20)}`;
  return { transactional: `${prefix}-transactional`, marketing: `${prefix}-marketing`, topicName: `${prefix}-feedback`, eventDestinationName: `${prefix}-events` };
}

// Raw configured identity for persisted discovery caches and queued-job target fencing.
export function feedbackTarget(config: Pick<Config, 'publicUrl' | 'sesFeedbackUrl'>): string {
  return config.sesFeedbackUrl ?? `${config.publicUrl.replace(/\/$/, '')}/v1/events/ses`;
}

// Deliberately no DNS requests: URL validation is not proof of endpoint reachability.
function feedbackUrl(config: Pick<Config, 'publicUrl' | 'sesFeedbackUrl'>): string {
  const field = config.sesFeedbackUrl !== undefined ? 'SES_FEEDBACK_URL' : 'PUBLIC_URL';
  const fail = () => new ApiError(422, 'PUBLIC_URL_REQUIRED', 'Configure SES_FEEDBACK_URL as a public HTTPS URL ending in /v1/events/ses, or PUBLIC_URL as a public HTTPS origin, before provisioning SNS feedback.', field);
  let url: URL;
  try { url = new URL(feedbackTarget(config)); } catch { throw fail(); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/events/ses') throw fail();
  // Hostnames reserved for development, local networks, documentation and metadata are not public origins.
  if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(host) || /(?:^|\.)example\.(?:com|net|org)$/.test(host) || host === 'metadata.google.internal') throw fail();
  if (isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) throw fail();
  }
  // Literal IPv6 is intentionally unsupported, including encoded/mapped private IPv4.
  if (host.includes(':') || host.startsWith('[')) throw fail();
  return `${url.origin}/v1/events/ses`;
}

function errorName(error: unknown): string { return error instanceof Error ? error.name : ''; }
function missing(error: unknown): boolean { return ['NotFoundException', 'NotFound', 'ResourceNotFoundException'].includes(errorName(error)); }
function collision(error: unknown): boolean { return ['AlreadyExistsException', 'AlreadyExists'].includes(errorName(error)); }
function awsError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const name = errorName(error);
  if (/Abort|Timeout/.test(name)) return new ApiError(503, 'AWS_SETUP_TIMEOUT', 'AWS setup timed out. Retry later.', undefined, true);
  if (/AccessDenied|AuthorizationError|Unauthorized/.test(name)) return new ApiError(403, 'AWS_ACCESS_DENIED', 'AWS denied a required SES, SNS or STS permission. Check the setup IAM policy.');
  if (/InvalidClientTokenId|UnrecognizedClient|ExpiredToken|SignatureDoesNotMatch|CredentialsProviderError|InvalidAccessKeyId/.test(name)) return new ApiError(503, 'AWS_CREDENTIALS_INVALID', 'AWS credentials are invalid or expired.');
  if (/Throttl|TooManyRequests|LimitExceeded/.test(name)) return new ApiError(503, 'AWS_THROTTLED', 'AWS rate-limited setup. Retry later.', undefined, true);
  log('error', { code: 'AWS_SETUP_FAILED', errorType: name || 'Unknown', stack: error instanceof Error ? error.stack?.split('\n').slice(1, 9).join('\n') : undefined });
  return new ApiError(503, 'AWS_SETUP_FAILED', 'AWS setup could not complete. Check regional service availability, network connectivity and the setup IAM policy.', undefined, true);
}
type SetupContext = { signal: AbortSignal; lastSesFinished: number; queue: Promise<void> };
function setupContext(): SetupContext { return { signal: AbortSignal.timeout(90000), lastSesFinished: -Infinity, queue: Promise.resolve() }; }

// SES control-plane APIs are limited to one request per second. Keep this gate local
// to the complete operation, including its nested discoveries and replacement clients.
function sesSend<T>(context: SetupContext, send: () => Promise<T>): Promise<T> {
  const run = context.queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      context.signal.throwIfAborted();
      let remaining: number;
      while ((remaining = 1000 - (performance.now() - context.lastSesFinished)) > 0) await delay(Math.ceil(remaining), undefined, { signal: context.signal });
      context.signal.throwIfAborted();
      try {
        try { return await send(); }
        finally { context.lastSesFinished = performance.now(); }
      } catch (error) {
        // Retry only explicit throttling, not arbitrary errors or ambiguous mutations.
        if (attempt >= 2 || !/Throttl|TooManyRequests/.test(errorName(error))) throw error;
        await delay(1000 * 2 ** attempt + Math.floor(Math.random() * 250), undefined, { signal: context.signal });
      }
    }
  });
  context.queue = run.then(() => undefined, () => undefined);
  return run;
}

function clients(runtime: Runtime, region: string, context: SetupContext) {
  const deadlineSignal = context.signal;
  if (!runtime.config.aws) throw new ApiError(503, 'AWS_NOT_CONFIGURED', 'Configure AWS access credentials to discover or provision SES.');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new ApiError(422, 'INVALID_REGION', 'Use a valid AWS region.', 'region');
  const config = { region, credentials: runtime.config.aws, ignoreConfiguredEndpointUrls: true, maxAttempts: 1, requestHandler: new FetchHttpHandler({ requestTimeout: 10000 }) };
  const result = { ses: new SESv2Client(config), sns: new SNSClient(config), sts: new STSClient(config) };
  const deadline = <Input extends object, Output>(next: (args: { input: Input }) => Promise<Output>) => async (args: { input: Input }) => {
    if (deadlineSignal.aborted) throw new ApiError(503, 'AWS_SETUP_TIMEOUT', 'The AWS setup time budget was exceeded. Retry later.', undefined, true);
    return next(args);
  };
  const paced = <Input extends object, Output>(next: (args: { input: Input }) => Promise<Output>) => (args: { input: Input }) => sesSend(context, () => next(args));
  result.ses.middlewareStack.add(paced, { step: 'initialize', priority: 'high', name: 'opensendSesPacing' });
  result.ses.middlewareStack.add(deadline, { step: 'initialize', name: 'opensendSetupDeadline' });
  result.sns.middlewareStack.add(deadline, { step: 'initialize', name: 'opensendSetupDeadline' });
  result.sts.middlewareStack.add(deadline, { step: 'initialize', name: 'opensendSetupDeadline' });
  return result;
}
type Clients = ReturnType<typeof clients>;
function tags(installationId: string) { return [{ Key: OWNER_TAG, Value: installationId }, { Key: PURPOSE_TAG, Value: PURPOSE }]; }
function owned(values: { Key?: string; Value?: string }[] | undefined, installationId: string) { return tags(installationId).every(t => values?.some(v => v.Key === t.Key && v.Value === t.Value)); }
function arns(account: string, region: string, names: ReturnType<typeof setupResources>) {
  return { topic: `arn:aws:sns:${region}:${account}:${names.topicName}`, sets: [names.transactional, names.marketing].map(name => `arn:aws:ses:${region}:${account}:configuration-set/${name}`) };
}
function topicPolicy(account: string, region: string, names: ReturnType<typeof setupResources>) {
  const arn = arns(account, region, names);
  // This dedicated, tagged topic has an exact managed policy. The owner principal is the
  // account (not root credentials); no public Principal or unrelated service grants.
  return { Version: '2012-10-17', Statement: [
    { Sid: 'OpenSendOwner', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: ['sns:GetTopicAttributes', 'sns:SetTopicAttributes', 'sns:AddPermission', 'sns:RemovePermission', 'sns:DeleteTopic', 'sns:Subscribe', 'sns:ListSubscriptionsByTopic', 'sns:Publish'], Resource: arn.topic },
    { Sid: 'OpenSendSesPublish', Effect: 'Allow', Principal: { Service: 'ses.amazonaws.com' }, Action: 'sns:Publish', Resource: arn.topic, Condition: { StringEquals: { 'AWS:SourceAccount': account, 'AWS:SourceArn': arn.sets } } },
  ] };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
  if (value !== null && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])));
  return JSON.stringify(value);
}
function policyObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function policyValues(value: unknown): unknown { return typeof value === 'string' ? [value] : value; }
function normalizedPolicy(value: unknown): unknown {
  if (!policyObject(value)) return value;
  const policy = { ...value };
  delete policy.Id; // Policy/statement identifiers do not grant or restrict permissions.
  const statements = policyObject(policy.Statement) ? [policy.Statement] : policy.Statement;
  if (Array.isArray(statements)) policy.Statement = statements.map(value => {
    if (!policyObject(value)) return value;
    const statement = { ...value };
    delete statement.Sid;
    for (const key of ['Action', 'Resource']) if (key in statement) statement[key] = policyValues(statement[key]);
    if (policyObject(statement.Principal)) {
      const principal = { ...statement.Principal };
      for (const key of ['AWS', 'Service']) if (key in principal) principal[key] = policyValues(principal[key]);
      if (Array.isArray(principal.AWS)) principal.AWS = principal.AWS.map(value => typeof value === 'string' && /^\d{12}$/.test(value) ? `arn:aws:iam::${value}:root` : value);
      statement.Principal = principal;
    }
    if (policyObject(statement.Condition)) statement.Condition = Object.fromEntries(Object.entries(statement.Condition).map(([operator, values]) => [operator,
      policyObject(values) ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, policyValues(value)])) : values,
    ]));
    return statement;
  });
  return policy;
}
function policyReady(policy: string | undefined, expected: ReturnType<typeof topicPolicy>): boolean {
  // Normalize only IAM representation equivalences, never drop statements, principals,
  // actions, resources, operators or condition keys/values (including unexpected ones).
  try { return !!policy && canonical(normalizedPolicy(JSON.parse(policy))) === canonical(normalizedPolicy(expected)); } catch { return false; }
}
function add(report: SesDiscovery, code: string, message: string, warning = false) { (warning ? report.warnings : report.blockers).push({ code, message }); }
function pending(subscription: Subscription): boolean { return subscription.SubscriptionArn === 'PendingConfirmation' || subscription.SubscriptionArn === 'pending confirmation'; }
function subscriptionArn(subscription: Subscription, topicArn: string): string | null {
  return subscription.SubscriptionArn?.startsWith(`${topicArn}:`) ? subscription.SubscriptionArn : null;
}

async function inspect(runtime: Runtime, options: SesSetupOptions, context: SetupContext = setupContext()): Promise<{ report: SesDiscovery; subscriptions: Subscription[] }> {
  const deadlineSignal = context.signal;
  const names = setupResources(options.installationId);
  const blankSet = (name: string) => ({ name, exists: null, owned: null, sendingEnabled: null, eventDestinationExists: null, eventWired: null, autoValidation: null });
  const report: SesDiscovery = {
    region: options.region, checkedAt: new Date().toISOString(), account: null, domains: [], identitiesTruncated: false,
    resources: { transactional: blankSet(names.transactional), marketing: blankSet(names.marketing), eventDestinationName: names.eventDestinationName, topic: { name: names.topicName, arn: null, exists: null, owned: null, policyReady: null, subscription: 'unknown', rawMessageDelivery: null, subscriptionsTruncated: false, staleSubscriptions: 0 } },
    feedbackUrl: null, status: 'blocked', provisioned: false, blockers: [], warnings: [],
  };
  try { report.feedbackUrl = feedbackUrl(runtime.config); } catch (error) { const e = awsError(error); add(report, e.code, e.message); }
  const subscriptions: Subscription[] = [];
  let c: Clients;
  try { c = clients(runtime, options.region, context); } catch (error) { const e = awsError(error); add(report, e.code, e.message); return { report, subscriptions }; }
  const attempt = async (operation: () => Promise<void>) => {
    try { await operation(); } catch (error) { const e = awsError(error); add(report, e.code, e.message); }
  };
  try {
    const identity = await c.sts.send(new GetCallerIdentityCommand({}), { abortSignal: deadlineSignal });
    if (!identity.Arn?.startsWith('arn:aws:')) { add(report, 'AWS_PARTITION_UNSUPPORTED', 'Only the commercial AWS partition is supported; China and GovCloud are not supported.'); return { report, subscriptions }; }
    if (!identity.Account || !/^\d{12}$/.test(identity.Account)) { add(report, 'AWS_ACCOUNT_UNKNOWN', 'STS did not return a valid AWS account identity.'); return { report, subscriptions }; }
    if (identity.Arn === `arn:aws:iam::${identity.Account}:root`) { add(report, 'AWS_ROOT_CREDENTIALS_UNSUPPORTED', 'Use a least-privilege IAM principal, not AWS root credentials.'); return { report, subscriptions }; }
    const accountId = identity.Account;
    report.account = { id: accountId, productionAccess: null, sendingEnabled: null, enforcementStatus: null, quota: { max24HourSend: null, maxSendRate: null, sentLast24Hours: null } };
    const topic = report.resources.topic;
    topic.arn = arns(accountId, options.region, names).topic;
    await Promise.all([
      attempt(async () => {
        const account = await c.ses.send(new GetAccountCommand({}), { abortSignal: deadlineSignal });
        report.account = { id: accountId, productionAccess: account.ProductionAccessEnabled ?? null, sendingEnabled: account.SendingEnabled ?? null, enforcementStatus: account.EnforcementStatus ?? null, quota: { max24HourSend: account.SendQuota?.Max24HourSend ?? null, maxSendRate: account.SendQuota?.MaxSendRate ?? null, sentLast24Hours: account.SendQuota?.SentLast24Hours ?? null } };
        if (account.ProductionAccessEnabled === undefined || account.SendingEnabled === undefined || !account.EnforcementStatus) add(report, 'AWS_STATE_UNKNOWN', 'SES returned incomplete account readiness information.');
        if (account.ProductionAccessEnabled === false) add(report, 'SES_SANDBOX', 'SES production access is not enabled in this region; sandbox recipient restrictions apply.');
        if (account.SendingEnabled === false) add(report, 'SES_SENDING_DISABLED', 'SES account sending is disabled.');
        if (account.EnforcementStatus && account.EnforcementStatus !== 'HEALTHY') add(report, 'SES_ACCOUNT_ENFORCEMENT', 'SES account enforcement status is not healthy.');
      }),
      attempt(async () => {
        let token: string | undefined; let count = 0; const seen = new Set<string>();
        do {
          const page = await c.ses.send(new ListEmailIdentitiesCommand({ PageSize: Math.min(100, LIMIT - count), NextToken: token }), { abortSignal: deadlineSignal });
          const identities = page.EmailIdentities ?? [];
          count += identities.length;
          for (const identity of identities.slice(0, Math.max(0, LIMIT - (count - identities.length)))) {
            if (identity.IdentityType === 'DOMAIN' && identity.IdentityName) report.domains.push({ name: identity.IdentityName, verificationStatus: identity.VerificationStatus ?? null, sendingEnabled: identity.SendingEnabled ?? null });
          }
          token = page.NextToken;
          if (token && (count >= LIMIT || seen.has(token) || seen.size >= 10)) { report.identitiesTruncated = true; add(report, 'SES_IDENTITIES_TRUNCATED', 'Identity discovery reached its pagination limit; readiness is uncertain.'); break; }
          if (token) seen.add(token);
        } while (token);
        if (!report.domains.some(d => d.verificationStatus === 'SUCCESS' && d.sendingEnabled === true)) add(report, 'SES_DOMAIN_REQUIRED', 'No verified, sending-enabled SES domain was discovered in this region.');
      }),
      ...(['transactional', 'marketing'] as const).map(kind => attempt(async () => {
        const set = report.resources[kind];
        let existing;
        try { existing = await c.ses.send(new GetConfigurationSetCommand({ ConfigurationSetName: set.name }), { abortSignal: deadlineSignal }); }
        catch (error) { if (!missing(error)) throw error; set.exists = false; set.owned = false; set.eventDestinationExists = false; set.eventWired = false; return; }
        set.exists = true; set.owned = owned(existing.Tags, options.installationId); set.sendingEnabled = existing.SendingOptions?.SendingEnabled ?? null; set.autoValidation = autoValidationMode(existing.SuppressionOptions);
        if (!set.owned) { add(report, 'RESOURCE_OWNERSHIP_CONFLICT', 'An expected SES configuration-set name belongs to another installation or has no ownership tags.'); return; }
        if (set.sendingEnabled === null) add(report, 'AWS_STATE_UNKNOWN', 'SES did not return the configuration set sending state.');
        if (set.sendingEnabled === false) add(report, 'SES_CONFIGURATION_SET_DISABLED', 'An installation configuration set has sending disabled; setup will not override that control.');
        const events = await c.ses.send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: set.name }), { abortSignal: deadlineSignal });
        const destination = events.EventDestinations?.find(d => d.Name === names.eventDestinationName);
        set.eventDestinationExists = !!destination;
        set.eventWired = !!destination && destination.Enabled === true && destination.SnsDestination?.TopicArn === topic.arn && canonical(destination.MatchingEventTypes ?? []) === canonical(EVENTS) && !destination.CloudWatchDestination && !destination.KinesisFirehoseDestination && !destination.EventBridgeDestination && !destination.PinpointDestination;
        if (events.EventDestinations?.some(d => d.Name !== names.eventDestinationName)) add(report, 'OTHER_EVENT_DESTINATIONS', 'Other event destinations exist and are left unchanged, including their tracking settings.', true);
      })),
      attempt(async () => {
        let attributes;
        try { attributes = (await c.sns.send(new GetTopicAttributesCommand({ TopicArn: topic.arn! }), { abortSignal: deadlineSignal })).Attributes; }
        catch (error) { if (!missing(error)) throw error; topic.exists = false; topic.owned = false; topic.policyReady = false; topic.subscription = 'missing'; return; }
        topic.exists = true;
        if (attributes?.TopicArn !== topic.arn || attributes.Owner !== accountId) throw new ApiError(409, 'RESOURCE_OWNERSHIP_CONFLICT', 'SNS returned a topic outside the expected account or ARN.');
        topic.owned = owned((await c.sns.send(new ListTagsForResourceCommand({ ResourceArn: topic.arn! }), { abortSignal: deadlineSignal })).Tags, options.installationId);
        if (!topic.owned) { add(report, 'RESOURCE_OWNERSHIP_CONFLICT', 'The expected SNS topic name belongs to another installation or has no ownership tags.'); return; }
        if (attributes.FifoTopic === 'true' || attributes.KmsMasterKeyId) { add(report, 'SNS_TOPIC_UNSUPPORTED', 'The feedback topic must be Standard and unencrypted by a customer-configured KMS key; setup will not modify these settings.'); return; }
        topic.policyReady = policyReady(attributes.Policy, topicPolicy(accountId, options.region, names));
        let token: string | undefined; const seen = new Set<string>();
        do {
          const page = await c.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topic.arn!, NextToken: token }), { abortSignal: deadlineSignal });
          subscriptions.push(...(page.Subscriptions ?? []).slice(0, LIMIT - subscriptions.length));
          token = page.NextToken;
          if (token && (subscriptions.length >= LIMIT || seen.has(token) || seen.size >= 10)) { topic.subscriptionsTruncated = true; add(report, 'SNS_SUBSCRIPTIONS_TRUNCATED', 'SNS subscription discovery reached its pagination limit; provisioning cannot safely add another subscription.'); break; }
          if (token) seen.add(token);
        } while (token);
        const matching = subscriptions.filter(s => s.Protocol === 'https' && s.Endpoint === report.feedbackUrl && s.TopicArn === topic.arn);
        topic.staleSubscriptions = subscriptions.filter(s => s.Protocol === 'https' && s.Endpoint !== report.feedbackUrl).length;
        if (topic.staleSubscriptions) add(report, 'STALE_FEEDBACK_SUBSCRIPTIONS', `The feedback topic has ${topic.staleSubscriptions} additional HTTPS subscription${topic.staleSubscriptions === 1 ? '' : 's'}.`, true);
        topic.subscription = topic.subscriptionsTruncated ? 'unknown' : 'missing';
        const rawStates: (boolean | null)[] = [];
        for (const sub of matching) {
          if (pending(sub)) { if (topic.subscription !== 'confirmed') topic.subscription = 'pending'; continue; }
          const arn = subscriptionArn(sub, topic.arn!);
          if (!arn) throw new ApiError(503, 'SNS_SUBSCRIPTION_UNKNOWN', 'SNS returned an unrecognized subscription state.');
          const attrs = (await c.sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: arn }), { abortSignal: deadlineSignal })).Attributes;
          if (attrs?.TopicArn !== topic.arn || attrs.Endpoint !== report.feedbackUrl || attrs.Protocol !== 'https' || attrs.Owner !== accountId) throw new ApiError(409, 'SNS_SUBSCRIPTION_OWNERSHIP_CONFLICT', 'The feedback subscription attributes do not match the expected account, topic or endpoint.');
          if (attrs.PendingConfirmation === 'true') { if (topic.subscription !== 'confirmed') topic.subscription = 'pending'; continue; }
          if (attrs.PendingConfirmation !== 'false') throw new ApiError(503, 'SNS_SUBSCRIPTION_UNKNOWN', 'SNS subscription confirmation could not be verified.');
          topic.subscription = 'confirmed';
          rawStates.push(attrs.RawMessageDelivery === 'true' ? true : attrs.RawMessageDelivery === 'false' ? false : null);
          if (attrs.FilterPolicy && attrs.FilterPolicy !== '{}') add(report, 'SNS_SUBSCRIPTION_FILTERED', 'The feedback subscription has a filter policy that may omit SES events; setup does not alter filters.');
        }
        topic.rawMessageDelivery = rawStates.includes(true) ? true : rawStates.length && rawStates.every(v => v === false) ? false : null;
        if (topic.subscription === 'pending') add(report, 'SNS_CONFIRMATION_PENDING', 'SNS is awaiting the signed HTTPS subscription confirmation. Check that the public feedback endpoint is reachable, then select the pending subscription in the SNS console and choose Request confirmation to resend.');
      }),
    ]);
    report.provisioned = report.resources.transactional.owned === true && report.resources.transactional.eventWired === true && report.resources.marketing.owned === true && report.resources.marketing.eventWired === true && topic.owned === true && topic.policyReady === true && topic.subscription === 'confirmed' && topic.rawMessageDelivery === false && !topic.subscriptionsTruncated && !report.blockers.some(b => b.code === 'SNS_SUBSCRIPTION_FILTERED' || b.code.startsWith('AWS_') || b.code === 'SNS_SUBSCRIPTION_UNKNOWN' || b.code === 'SNS_SUBSCRIPTION_OWNERSHIP_CONFLICT');
    report.status = report.blockers.length ? 'blocked' : report.provisioned ? 'ready' : 'needs_provisioning';
  } catch (error) { const e = awsError(error); add(report, e.code, e.message); }
  finally { c.ses.destroy(); c.sns.destroy(); c.sts.destroy(); }
  return { report, subscriptions };
}

/** AWS reads only. A resource is missing only after AWS explicitly reports NotFound. */
export async function discoverSes(runtime: Runtime, options: SesSetupOptions): Promise<SesDiscovery> { return (await inspect(runtime, options)).report; }

export function assertProvisionable(runtime: Runtime): void {
  feedbackUrl(runtime.config);
  if (!runtime.config.aws) throw new ApiError(503, 'AWS_NOT_CONFIGURED', 'Configure AWS access credentials to discover or provision SES.');
}

/** Explicit provisioning; caller persists the job and the topic trust before SNS Subscribe. */
export async function provisionSes(runtime: Runtime, options: SesProvisionOptions): Promise<SesDiscovery> {
  assertProvisionable(runtime); // Before any AWS mutation, including CreateTopic.
  const endpoint = feedbackUrl(runtime.config);
  const context = setupContext();
  const deadlineSignal = context.signal;
  const { report } = await inspect(runtime, options, context);
  const unsafe = report.blockers.find(b => !['SES_SANDBOX', 'SES_SENDING_DISABLED', 'SES_ACCOUNT_ENFORCEMENT', 'SES_DOMAIN_REQUIRED', 'SES_CONFIGURATION_SET_DISABLED', 'SNS_CONFIRMATION_PENDING'].includes(b.code));
  if (unsafe) throw new ApiError(unsafe.code === 'AWS_ACCESS_DENIED' ? 403 : unsafe.code.startsWith('AWS_') ? 503 : 409, unsafe.code, unsafe.message, undefined, ['AWS_THROTTLED', 'AWS_SETUP_TIMEOUT', 'AWS_SETUP_FAILED'].includes(unsafe.code));
  if (!report.account) throw new ApiError(503, 'AWS_ACCOUNT_UNKNOWN', 'AWS account identity must be verified before provisioning.');
  if (runtime.config.awsAccountId && runtime.config.awsAccountId !== report.account.id) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'This installation is already provisioned for another AWS account. Use matching credentials or a separate installation.');
  const names = setupResources(options.installationId);
  const accountId = report.account.id;
  const expected = arns(accountId, options.region, names);
  const c = clients(runtime, options.region, context);
  const assertSetOwned = async (name: string) => {
    const set = await c.ses.send(new GetConfigurationSetCommand({ ConfigurationSetName: name }), { abortSignal: deadlineSignal });
    if (!owned(set.Tags, options.installationId)) throw new ApiError(409, 'RESOURCE_OWNERSHIP_CONFLICT', 'Refusing to update an SES configuration set without this installation’s ownership tags.');
    return set;
  };
  const assertTopicOwned = async () => {
    const attrs = (await c.sns.send(new GetTopicAttributesCommand({ TopicArn: expected.topic }), { abortSignal: deadlineSignal })).Attributes;
    if (attrs?.TopicArn !== expected.topic || attrs.Owner !== accountId || !owned((await c.sns.send(new ListTagsForResourceCommand({ ResourceArn: expected.topic }), { abortSignal: deadlineSignal })).Tags, options.installationId)) throw new ApiError(409, 'RESOURCE_OWNERSHIP_CONFLICT', 'Refusing to update an SNS topic without the expected ARN, account and installation ownership tags.');
    if (attrs.FifoTopic === 'true' || attrs.KmsMasterKeyId) throw new ApiError(409, 'SNS_TOPIC_UNSUPPORTED', 'The owned SNS topic has unsupported FIFO or KMS settings.');
  };
  try {
    for (const kind of ['transactional', 'marketing'] as const) {
      if (report.resources[kind].exists === false) {
        try { await c.ses.send(new CreateConfigurationSetCommand({ ConfigurationSetName: names[kind], Tags: tags(options.installationId), SendingOptions: { SendingEnabled: true } }), { abortSignal: deadlineSignal }); }
        catch (error) { if (!collision(error)) throw error; }
      }
      const set = await assertSetOwned(names[kind]); // Recheck after create/AlreadyExists races; never adopt by name.
      if (!set.SuppressionOptions?.ValidationOptions) await c.ses.send(validationInput(names[kind], DEFAULT_AUTO_VALIDATION[kind]), { abortSignal: deadlineSignal });
    }
    if (report.resources.topic.exists === false) {
      // SNS CreateTopic is idempotent, so its success alone is not ownership evidence.
      const created = await c.sns.send(new CreateTopicCommand({ Name: names.topicName, Tags: tags(options.installationId) }), { abortSignal: deadlineSignal });
      if (created.TopicArn !== expected.topic) throw new ApiError(409, 'RESOURCE_OWNERSHIP_CONFLICT', 'SNS did not return the expected regional topic ARN.');
    }
    await assertTopicOwned();
    // Exact policy replacement is limited to this installation's dedicated topic.
    // Unrelated topics, event destinations and subscriptions are never overwritten.
    if (report.resources.topic.policyReady !== true) await c.sns.send(new SetTopicAttributesCommand({ TopicArn: expected.topic, AttributeName: 'Policy', AttributeValue: JSON.stringify(topicPolicy(accountId, options.region, names)) }), { abortSignal: deadlineSignal });
    for (const name of [names.transactional, names.marketing]) {
      await assertSetOwned(name);
      const destinations = await c.ses.send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: name }), { abortSignal: deadlineSignal });
      const input = { ConfigurationSetName: name, EventDestinationName: names.eventDestinationName, EventDestination: { Enabled: true, MatchingEventTypes: [...EVENTS], SnsDestination: { TopicArn: expected.topic } } };
      if (destinations.EventDestinations?.some(d => d.Name === names.eventDestinationName)) await c.ses.send(new UpdateConfigurationSetEventDestinationCommand(input), { abortSignal: deadlineSignal });
      else {
        try { await c.ses.send(new CreateConfigurationSetEventDestinationCommand(input), { abortSignal: deadlineSignal }); }
        catch (error) { if (!collision(error)) throw error; await assertSetOwned(name); await c.ses.send(new UpdateConfigurationSetEventDestinationCommand(input), { abortSignal: deadlineSignal }); }
      }
    }
    // Read again rather than relying on the earlier list after mutations or concurrent runs.
    const refreshed = await inspect(runtime, options, context);
    const subscriptionBlocker = refreshed.report.blockers.find(b => b.code.startsWith('AWS_') || b.code.startsWith('RESOURCE_') || b.code.startsWith('SNS_') && b.code !== 'SNS_CONFIRMATION_PENDING');
    if (subscriptionBlocker) throw new ApiError(subscriptionBlocker.code === 'AWS_ACCESS_DENIED' ? 403 : subscriptionBlocker.code.startsWith('AWS_') ? 503 : 409, subscriptionBlocker.code, subscriptionBlocker.message, undefined, ['AWS_THROTTLED', 'AWS_SETUP_TIMEOUT', 'AWS_SETUP_FAILED'].includes(subscriptionBlocker.code));
    await assertTopicOwned();
    await options.registerTopic(accountId, expected.topic);
    const matching = refreshed.subscriptions.filter(s => s.TopicArn === expected.topic && s.Protocol === 'https' && s.Endpoint === endpoint);
    if (!matching.length) await c.sns.send(new SubscribeCommand({ TopicArn: expected.topic, Protocol: 'https', Endpoint: endpoint, ReturnSubscriptionArn: true, Attributes: { RawMessageDelivery: 'false' } }), { abortSignal: deadlineSignal });
    else for (const sub of matching) {
      if (pending(sub)) continue; // Never create duplicate pending subscriptions on a rerun.
      const arn = subscriptionArn(sub, expected.topic);
      if (!arn) throw new ApiError(503, 'SNS_SUBSCRIPTION_UNKNOWN', 'SNS returned an unrecognized subscription state.');
      const attrs = (await c.sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: arn }), { abortSignal: deadlineSignal })).Attributes;
      if (attrs?.TopicArn !== expected.topic || attrs.Endpoint !== endpoint || attrs.Protocol !== 'https' || attrs.Owner !== accountId) throw new ApiError(409, 'SNS_SUBSCRIPTION_OWNERSHIP_CONFLICT', 'Refusing to modify an SNS subscription outside the expected account, topic and endpoint.');
      if (attrs.PendingConfirmation === 'false' && attrs.RawMessageDelivery !== 'false') await c.sns.send(new SetSubscriptionAttributesCommand({ SubscriptionArn: arn, AttributeName: 'RawMessageDelivery', AttributeValue: 'false' }), { abortSignal: deadlineSignal });
    }
  } catch (error) { throw awsError(error); }
  finally { c.ses.destroy(); c.sns.destroy(); c.sts.destroy(); }
  return (await inspect(runtime, options, context)).report;
}

export async function setAutoValidation(runtime: Runtime, options: SesSetupOptions, stream: 'transactional' | 'marketing', mode: 'off' | 'managed' | 'medium' | 'high'): Promise<void> {
  const context = setupContext();
  const c = clients(runtime, options.region, context);
  const name = setupResources(options.installationId)[stream];
  try {
    const set = await c.ses.send(new GetConfigurationSetCommand({ ConfigurationSetName: name }), { abortSignal: context.signal });
    if (!owned(set.Tags, options.installationId)) throw new ApiError(409, 'RESOURCE_OWNERSHIP_CONFLICT', 'Refusing to update an SES configuration set without this installation’s ownership tags.');
    await c.ses.send(validationInput(name, mode), { abortSignal: context.signal });
  } catch (error) { throw awsError(error); }
  finally { c.ses.destroy(); c.sns.destroy(); c.sts.destroy(); }
}
