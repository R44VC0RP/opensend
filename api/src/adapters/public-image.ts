import { isIP } from 'node:net';
import { ApiError, type PublicImage } from '../core.js';

const MAX_BYTES = 8 * 1024 * 1024;
const types = new Set<PublicImage['contentType']>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function publicImageUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(422, 'PUBLIC_IMAGE_URL_INVALID', 'Provide a public HTTPS image URL.', 'url'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(host) || host === 'metadata.google.internal') throw new ApiError(422, 'PUBLIC_IMAGE_URL_INVALID', 'Image imports require a public HTTPS DNS name without credentials, fragments, IP literals or custom ports.', 'url');
  return url.toString();
}

export function publicImageImporter() {
  return async (value: string): Promise<PublicImage> => {
    let response: Response;
    try { response = await fetch(publicImageUrl(value), { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' } }); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, 'PUBLIC_IMAGE_FETCH_FAILED', 'The public image could not be downloaded.', undefined, true); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ApiError(422, 'PUBLIC_IMAGE_REDIRECT_NOT_ALLOWED', 'Use the image’s final HTTPS URL; redirects are not followed.', 'url'); }
    if (!response.ok) { await response.body?.cancel(); throw new ApiError(422, 'PUBLIC_IMAGE_FETCH_FAILED', `The public image returned HTTP ${response.status}.`, 'url'); }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() as PublicImage['contentType'] | undefined;
    if (!contentType || !types.has(contentType)) { await response.body?.cancel(); throw new ApiError(422, 'PUBLIC_IMAGE_TYPE_UNSUPPORTED', 'The URL must return PNG, JPEG, GIF or WebP image bytes.', 'url'); }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new ApiError(413, 'PUBLIC_IMAGE_TOO_LARGE', 'Imported images must be at most 8 MiB.'); }
    if (!response.body) throw new ApiError(422, 'PUBLIC_IMAGE_EMPTY', 'The public image response was empty.', 'url');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; size += chunk.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new ApiError(413, 'PUBLIC_IMAGE_TOO_LARGE', 'Imported images must be at most 8 MiB.'); } chunks.push(chunk); }
    } finally { reader.releaseLock(); }
    if (!size) throw new ApiError(422, 'PUBLIC_IMAGE_EMPTY', 'The public image response was empty.', 'url');
    const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return { data, contentType };
  };
}
