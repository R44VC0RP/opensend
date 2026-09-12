import type { FeedbackItem, Runtime } from '../core.js';

// Verified provider feedback (and test-mode simulated callbacks) leave the request path through the
// feedback queue in batches of at most 100 messages; the queue consumer ingests them in bulk.
export function feedbackSink(queue: Queue<FeedbackItem>): NonNullable<Runtime['feedback']> {
  return { enqueue: async items => { for (let i = 0; i < items.length; i += 100) await queue.sendBatch(items.slice(i, i + 100).map(body => ({ body }))); } };
}
