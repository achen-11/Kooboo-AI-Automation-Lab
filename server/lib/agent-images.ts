import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import type { Screenshot } from '../../shared/types.js';

/** Composes actual pixels locally. Never navigates to or changes the evaluated site. */
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)
  );

export async function contactSheet(
  shots: Screenshot[],
  get: (shot: Screenshot) => string,
  signal: AbortSignal
): Promise<Buffer> {
  signal.throwIfAborted();
  const browser = await chromium.launch({ headless: true, timeout: 30000 });
  const close = () => {
    void browser.close().catch(() => {});
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    const width = shots[0]?.viewport === 'mobile' ? 300 : 480;
    const columns = Math.min(shots.length, shots[0]?.viewport === 'mobile' ? 3 : 2);
    const page = await browser.newPage({
      viewport: { width: columns * (width + 12), height: 900 },
      deviceScaleFactor: 1,
    });
    const cards = shots
      .map(
        (shot, index) =>
          `<figure><figcaption>${index + 1}. ${escapeHtml(shot.id)} · y=${
            shot.pageY ?? '?'
          }</figcaption><img src="data:image/png;base64,${get(shot)}"></figure>`
      )
      .join('');
    await page.setContent(
      `<style>body{margin:0;background:#eee;font:14px Arial}main{display:grid;grid-template-columns:repeat(${columns},${width}px);gap:12px}figure{margin:0}figcaption{padding:8px 2px;overflow-wrap:anywhere}img{display:block;width:100%;height:auto}</style><main>${cards}</main>`,
      { waitUntil: 'load', timeout: 30000 }
    );
    await page.evaluate(() =>
      Promise.all(Array.from(document.images).map((image) => image.decode()))
    );
    const pixels = await page.screenshot({ type: 'png', fullPage: true, timeout: 30000 });
    signal.throwIfAborted();
    return pixels;
  } finally {
    signal.removeEventListener('abort', close);
    await browser.close().catch(() => {});
  }
}

export const imageHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
