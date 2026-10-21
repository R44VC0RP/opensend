import { ApiError, digest, type Runtime } from './core.js';
import type { EmailSnapshot } from './db/sending.js';
import { formattedSender } from './sending.js';

// Opt-in content screen for live transactional mail (`screen: true`): asks Jev, TypeSafe AI's decision
// model, how likely a message is advertising smuggled into a transactional template (for example a
// gambling ad set as a workspace name in an invitation). The dispatcher decides what to do with the score.

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_BODY = 8000;
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const DEADLINE_MS = 45000;
const QUESTIONS = {
  spam: {
    type: 'noul',
    instructions: 'Is `email` spam: unsolicited advertising, a gambling, adult, loan or scam promotion, or a contact/website/QR pitch for an unrelated business, smuggled into a transactional message (for example an ad placed where a workspace name, person name or product name belongs)?',
    criteria: {
      true: 'The message exists to advertise or lure the recipient to a third-party site, contact or offer unrelated to the sending service',
      false: 'A genuine transactional message: invitation, receipt, code, notification or similar, even if a name in it is unusual',
    },
  },
};

export type ScreenResult = { spam: number; model: string };
// Bulk invitations repeat identical content, so one verdict serves every copy for an hour.
// Insertion order is age order: the first key is always the oldest entry.
const cache = new Map<string, { expires: number; result: Promise<ScreenResult> }>();

const textOf = (html: string) => html.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
function body(snapshot: EmailSnapshot) {
  // Stored-template sends keep only rendered MIME; screen its text rather than nothing.
  const source = snapshot.text ?? (snapshot.html ? textOf(snapshot.html) : snapshot.raw ? textOf(snapshot.raw) : '');
  return source.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY);
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function evaluate(apiKey: string, model: string, state: unknown): Promise<ScreenResult> {
  // One deadline covers every attempt so a slow classifier cannot outlast the dispatcher's lease.
  const deadline = Date.now() + DEADLINE_MS;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state, questions: QUESTIONS }), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch {
      throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier could not be reached.', undefined, true);
    }
    if (response.ok) {
      const parsed = await response.json().catch(() => null) as { model?: unknown; answers?: { spam?: { noul?: unknown } } } | null;
      const spam = parsed?.answers?.spam?.noul;
      if (typeof spam !== 'number' || !Number.isFinite(spam)) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier returned no spam score.', undefined, true);
      return { spam, model: typeof parsed?.model === 'string' ? parsed.model : model };
    }
    // The body may quote the message, so it is discarded, never logged.
    await response.body?.cancel().catch(() => undefined);
    const wait = 1000 * 2 ** attempt + Math.random() * 500;
    if ((response.status === 429 || response.status >= 500) && attempt < 4 && Date.now() + wait < deadline) { await sleep(wait); continue; }
    throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', `The content classifier failed with HTTP ${response.status}.`, undefined, true);
  }
}

/** Spam probability for one snapshot, or null when the installation has no classifier configured. */
export async function screenSnapshot(runtime: Runtime, snapshot: EmailSnapshot): Promise<ScreenResult | null> {
  const settings = runtime.config.screen;
  if (!settings) return null;
  const from = formattedSender(snapshot.from, snapshot.fromName), text = body(snapshot);
  const key = await digest(`${settings.model}|${from}|${snapshot.subject}|${text}`);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.result;
  if (hit) cache.delete(key);
  const state = { now: new Date(now).toISOString(), email: { from, subject: snapshot.subject, body: text }, signals: { recipients: snapshot.to.length + snapshot.cc.length + snapshot.bcc.length } };
  // Concurrent copies share one request; failures are not cached so the next copy retries.
  const result = evaluate(settings.apiKey, settings.model, state);
  const entry = { expires: now + TTL_MS, result };
  cache.set(key, entry);
  result.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return result;
}
