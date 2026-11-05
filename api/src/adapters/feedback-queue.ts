import type { FeedbackItem, Runtime } from '../core.js';

// Verified provider feedback (and simulated callbacks) leave the request path through the
// feedback queue in batches of at most 100 messages; the queue consumer ingests them in bulk.
export function feedbackSink(queue: Queue<FeedbackItem>): NonNullable<Runtime['feedback']> {
  return { enqueue: async items => { for (let i = 0; i < items.length; i += 100) await queue.sendBatch(items.slice(i, i + 100).map(body => ({ body }))); } };
}

export function settleFeedbackMessage(message: Pick<Message, 'attempts' | 'retry' | 'ack'>, outcome?: { ok: boolean; error?: string }) {
  if (outcome?.ok) return message.ack();
  if (outcome?.error === 'SES_EMAIL_NOT_FOUND') {
    // Allow one short dispatch/feedback race, not a full retry chain for an unknown message.
    return message.attempts === 1 ? message.retry({ delaySeconds: 15 }) : message.ack();
  }
  message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) });
}
