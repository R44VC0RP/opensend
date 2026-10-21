import { Buffer } from 'node:buffer';
import { ApiError, log, type Config, type FeedbackItem, type Runtime } from '../core.js';
import { ingestFeedbackBatch } from '../operations.js';
import { cloudflareEventToFeedback, cloudflareSendError, CloudflareSendError, type CloudflareEmailSender, type CloudflareMessage } from '../providers.js';

const API = 'https://api.cloudflare.com/client/v4';
type ApiEnvelope<T> = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T };

/** Workers `send_email` binding (named EMAIL). Thrown errors carry an E_* code; messages are discarded. */
export function bindingSender(binding: SendEmail): CloudflareEmailSender {
  return { send: async message => {
    try { return { messageId: (await binding.send(message as EmailMessageBuilder)).messageId }; }
    catch (error) { throw cloudflareSendError((error as { code?: unknown } | null)?.code); }
  } };
}

// REST failures mapped onto the binding's E_* codes. Only codes and status are kept: provider messages can
// contain addresses. A 5xx, network failure or timeout may have been accepted and is never resent.
function restError(status: number, body: ApiEnvelope<unknown> | null): CloudflareSendError {
  const codes = (body?.errors ?? []).map(error => error.code), text = (body?.errors ?? []).map(error => String(error.message ?? '')).join(' ');
  // Wording-based and unclassified mappings record only numeric codes and status (never messages) so they can be confirmed later.
  const evidence = (classification: string) => log('warn', { code: 'CLOUDFLARE_REST_ERROR_CODES', classification, status, providerCodes: codes.filter(code => typeof code === 'number').slice(0, 10) });
  if (status === 429 || codes.includes(10004)) { const daily = /daily/i.test(text); evidence(daily ? 'daily_limit' : 'rate_limit'); return cloudflareSendError(daily ? 'E_DAILY_LIMIT_EXCEEDED' : 'E_RATE_LIMIT_EXCEEDED', status); }
  if (codes.includes(10200)) return cloudflareSendError('E_CONTENT_TOO_LARGE', status);
  if (status === 403 && codes.includes(10203)) return cloudflareSendError('E_SENDING_DISABLED', status);
  if (status === 401 || status === 403) return cloudflareSendError('E_UNAUTHORIZED', status);
  if (status === 404) return cloudflareSendError('E_NOT_FOUND', status);
  if (status === 400 && /suppress/i.test(text)) { evidence('suppressed'); return cloudflareSendError('E_RECIPIENT_SUPPRESSED', status); }
  if (status >= 400 && status < 500) { evidence('unclassified'); return cloudflareSendError('E_VALIDATION_ERROR', status); }
  return cloudflareSendError('E_INTERNAL_SERVER_ERROR', status);
}
async function call<T>(config: { accountId: string; apiToken: string }, path: string, body: unknown, timeoutMs = 15000): Promise<{ status: number; body: ApiEnvelope<T> | null }> {
  const response = await fetch(`${API}/accounts/${config.accountId}${path}`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const parsed = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  return { status: response.status, body: parsed };
}

/** Cloudflare Email Sending REST API for Node/Docker (or a Worker without the binding). */
export function restSender(config: { accountId: string; apiToken: string }): CloudflareEmailSender {
  return { send: async (message: CloudflareMessage) => {
    // REST uses snake_case, {address, name} and base64 attachment content; the binding takes the camelCase builder and bytes.
    const { from, replyTo, attachments, ...rest } = message;
    const body = { ...rest, from: typeof from === 'string' ? from : { address: from.email, name: from.name }, ...(replyTo ? { reply_to: replyTo } : {}),
      ...(attachments ? { attachments: attachments.map(({ content, contentId, ...part }) => ({ ...part, content: Buffer.from(content).toString('base64'), ...(contentId ? { content_id: contentId } : {}) })) } : {}) };
    let result: Awaited<ReturnType<typeof call<{ message_id?: string }>>>;
    try { result = await call<{ message_id?: string }>(config, '/email/sending/send', body); }
    catch { throw cloudflareSendError('E_NETWORK'); }
    if (result.status < 200 || result.status >= 300 || result.body?.success === false) throw restError(result.status >= 300 ? result.status : 500, result.body);
    return { messageId: typeof result.body?.result?.message_id === 'string' ? result.body.result.message_id : '' };
  } };
}

/** The configured live transport, if any: the binding when present, else REST with an account ID and API token. */
export function cloudflareSender(config: Config, binding?: SendEmail): CloudflareEmailSender | undefined {
  if (binding) return bindingSender(binding);
  const { accountId, apiToken } = config.cloudflare ?? {};
  return accountId && apiToken ? restSender({ accountId, apiToken }) : undefined;
}

/**
 * Translates and ingests one batch of Cloudflare delivery events. Returns one decision per input: invalid
 * events (wrong type or account, missing ids) are acknowledged and logged, never retried; ingestion
 * failures are retried exactly like the opensend-feedback consumer.
 */
export async function ingestCloudflareEvents(runtime: Runtime, bodies: unknown[]): Promise<('ack' | 'retry')[]> {
  const decisions: ('ack' | 'retry')[] = bodies.map(() => 'ack');
  const items: { index: number; item: FeedbackItem }[] = [];
  for (const [index, body] of bodies.entries()) {
    try { items.push({ index, item: cloudflareEventToFeedback(body, runtime.config) }); }
    catch (error) { log('warn', { code: 'CLOUDFLARE_EVENT_REJECTED', message: error instanceof ApiError ? error.message : 'Unreadable Cloudflare event.' }); }
  }
  if (!items.length) return decisions;
  const outcomes = await ingestFeedbackBatch(runtime, items.map(entry => entry.item));
  for (const [position, entry] of items.entries()) if (!outcomes[position]?.ok) decisions[entry.index] = 'retry';
  log('info', { code: 'CLOUDFLARE_EVENT_BATCH', size: bodies.length, ingested: items.length, failed: decisions.filter(decision => decision === 'retry').length });
  return decisions;
}

type Pulled = { lease_id: string; body: unknown; attempts?: number };
/**
 * Node/Docker: pulls delivery events from the event subscription queue with an HTTP pull consumer until
 * `stopped()`. Errors are logged and retried with a pause; they never stop the runner.
 */
export async function pullCloudflareEvents(runtime: Runtime, resolve: (runtime: Runtime) => Promise<Runtime>, stopped: () => boolean) {
  const { accountId, apiToken, eventsQueueId } = runtime.config.cloudflare ?? {};
  if (!accountId || !apiToken || !eventsQueueId) return;
  const config = { accountId, apiToken }, queue = `/queues/${eventsQueueId}/messages`;
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
  log('info', { code: 'CLOUDFLARE_EVENTS_PULL_READY' });
  while (!stopped()) {
    try {
      const pulled = await call<{ messages?: Pulled[] }>(config, `${queue}/pull`, { batch_size: 100, visibility_timeout_ms: 60000 });
      if (pulled.status !== 200 || pulled.body?.success === false) throw new ApiError(503, 'CLOUDFLARE_EVENTS_PULL_FAILED', `Queue pull returned HTTP ${pulled.status}.`, undefined, true);
      const messages = (pulled.body?.result?.messages ?? []).filter(message => typeof message?.lease_id === 'string');
      if (!messages.length) { await pause(5000); continue; }
      const decisions = await ingestCloudflareEvents(await resolve(runtime), messages.map(message => message.body));
      const acks = messages.filter((_, index) => decisions[index] === 'ack').map(message => ({ lease_id: message.lease_id }));
      const retries = messages.filter((_, index) => decisions[index] === 'retry').map(message => ({ lease_id: message.lease_id, delay_seconds: Math.min(300, 15 * 2 ** Math.min(5, message.attempts ?? 0)) }));
      const acked = await call(config, `${queue}/ack`, { acks, retries });
      if (acked.status !== 200) log('warn', { code: 'CLOUDFLARE_EVENTS_ACK_FAILED', status: acked.status, message: 'Unacknowledged events return after their visibility timeout and deduplicate.' });
    } catch (error) {
      log('warn', { code: error instanceof ApiError ? error.code : 'CLOUDFLARE_EVENTS_PULL_FAILED', message: error instanceof ApiError ? error.message : 'Cloudflare event pull failed; retrying.' });
      await pause(10000);
    }
  }
}
