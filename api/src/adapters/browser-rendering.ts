import type { RenderedImage } from '../core.js';

const WIDTH = 720;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function browserImageRenderer(binding: BrowserRun) {
  return async (html: string): Promise<RenderedImage> => {
    const response = await binding.quickAction('screenshot', {
      // No scrollPage: it only drives JS scroll/lazy-load handlers, and with JS disabled Browser Run now
      // hangs on it until actionTimeout. captureBeyondViewport already captures the full email.
      // Browser Run retries a timed-out action once, so 10 s bounds a failure at ~21 s.
      html, viewport: { width: WIDTH, height: 900, deviceScaleFactor: 1 }, selector: 'body > table',
      setJavaScriptEnabled: false, cacheTTL: 0, actionTimeout: 10_000,
      screenshotOptions: { type: 'png', encoding: 'binary', captureBeyondViewport: true },
    });
    if (!response.ok) throw new Error(`Browser Rendering returned HTTP ${response.status}.`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('Rendered campaign preview exceeds the image size limit.');
    return { data, mimeType: 'image/png' };
  };
}
