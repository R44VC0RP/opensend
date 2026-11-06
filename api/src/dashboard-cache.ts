import { digest } from './core.js';

const TTL_SECONDS = 60;
const memoryCache = new Map<string, { expires: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
// Per-isolate memory first, then the colo-wide Workers Cache API when present (absent on Node).
// Concurrent identical requests in one isolate share a single database query.
export async function cachedDashboardRead<T>(origin: string, scope: string, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const key = JSON.stringify([origin,scope]);
  const now = Date.now(), memory = memoryCache.get(key);
  if (memory && memory.expires > now) return { value: memory.value as T, hit: true };
  const pending = inflight.get(key);
  if (pending) return { value: await pending as T, hit: true };
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const request = new Request(`${origin}/__cache/dashboard/${await digest(key)}`);
  const remember = (value: unknown, expires: number) => {
    if (memoryCache.size >= 500) memoryCache.delete(memoryCache.keys().next().value!);
    memoryCache.set(key, { expires, value });
  };
  if (cache) {
    const hit = await cache.match(request).catch(() => undefined);
    const expires = Number(hit?.headers.get('x-opensend-expires'));
    if (hit && expires > Date.now()) { const value = await hit.json(); remember(value,expires); return { value, hit: true }; }
  }
  const work = compute();
  inflight.set(key, work);
  try {
    const value = await work;
    const expires = Date.now() + TTL_SECONDS * 1000;
    remember(value,expires);
    if (cache) await cache.put(request, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${TTL_SECONDS}`, 'x-opensend-expires': String(expires) } })).catch(() => undefined);
    return { value, hit: false };
  } finally { inflight.delete(key); }
}
