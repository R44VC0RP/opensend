import type { FeedbackItem, Runtime } from '../core.js';

// Verified provider feedback (and simulated callbacks) leave the request path through the
// feedback queue in batches of at most 100 messages; the queue consumer ingests them in bulk.
export function feedbackSink(queue: Queue<FeedbackItem>): NonNullable<Runtime['feedback']> {
  return { enqueue: async items => { for (let i = 0; i < items.length; i += 100) await queue.sendBatch(items.slice(i, i + 100).map(body => ({ body }))); } };
}

// Signal already-committed jobs immediately. Never coalesce a later commit into a wake
// which may already have drained the queue. Delayed retry reservations are separate.
export function workWake(queue: Queue, concurrency: number): NonNullable<Runtime['wake']> {
  return async (readyJobs = 1) => {
    const count = Math.min(8, Math.max(1, Math.ceil(readyJobs / concurrency)));
    if (count === 1) await queue.send({ kind: 'wake' });
    else await queue.sendBatch(Array.from({ length: count }, () => ({ body: { kind: 'wake' } })));
  };
}

const invalidFeedback = new Set(['SES_INVALID_EVENT', 'SES_UNSUPPORTED_EVENT', 'SES_ACCOUNT_MISMATCH', 'SES_ENVIRONMENT_MISMATCH', 'SIMULATED_FEEDBACK_FORBIDDEN', 'SIMULATED_FEEDBACK_UNSUPPORTED']);
export function settleFeedbackMessage(message: Pick<Message, 'attempts' | 'retry' | 'ack'>, outcome?: { ok: boolean; error?: string }) {
  if (outcome?.ok || (outcome?.error && invalidFeedback.has(outcome.error))) return message.ack();
  if (outcome?.error === 'SES_FEEDBACK_UNMATCHED') {
    // Allow one short dispatch/feedback race, not a full retry chain for an unknown message.
    return message.attempts === 1 ? message.retry({ delaySeconds: 15 }) : message.ack();
  }
  message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) });
}
