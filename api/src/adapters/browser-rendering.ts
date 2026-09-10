import type { RenderedImage } from '../core.js';

const WIDTH = 720;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function browserImageRenderer(binding: BrowserRun) {
  return async (html: string): Promise<RenderedImage> => {
    const response = await binding.quickAction('screenshot', {
      html, viewport: { width: WIDTH, height: 900, deviceScaleFactor: 1 }, scrollPage: true,
      setJavaScriptEnabled: false, cacheTTL: 0, actionTimeout: 20_000,
      screenshotOptions: { type: 'png', encoding: 'binary', fullPage: true, captureBeyondViewport: true },
    });
    if (!response.ok) throw new Error(`Browser Rendering returned HTTP ${response.status}.`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('Rendered campaign preview exceeds the image size limit.');
    return { data, mimeType: 'image/png' };
  };
}
