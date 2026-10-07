// Captures README screenshots and the social preview image from the production build.
// Usage: npm run build && npm run screenshots
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

/** Each shot opens the app (optionally with a query), waits for it, then sets up a scene. */
const shots = [
  {
    file: 'docs/screenshots/desktop.png',
    width: 1440,
    height: 900,
    scale: 1,
    // Sunset, with the probe reading the glowing horizon beside the sun.
    setup: async (page) => {
      await page.evaluate(() => window.__scatter.set({ sunElevation: 1.6 }));
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const s = window.__scatter.state;
        window.__scatter.probe(3, s.sunAzimuth - 9);
      });
    },
  },
  { file: 'docs/screenshots/tablet.png', width: 834, height: 1112, scale: 1, query: 'story=5' },
  { file: 'docs/screenshots/mobile.png', width: 390, height: 844, scale: 2, query: 'story=6' },
  {
    file: 'public/og-image.png',
    width: 1200,
    height: 630,
    scale: 1,
    setup: async (page) => {
      await page.evaluate(() => window.__scatter.set({ sunElevation: 1.8 }));
      await page.evaluate(() => document.querySelector('#hint')?.classList.add('is-gone'));
    },
  },
];

const server = await preview();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('Preview server did not report a URL');

try {
  await mkdir('docs/screenshots', { recursive: true });
  // Use the real GPU through ANGLE/Direct3D on Windows; elsewhere Chromium's default.
  const args = ['--ignore-gpu-blocklist'];
  if (process.platform === 'win32') args.push('--use-angle=d3d11');
  const browser = await chromium.launch({ args });
  for (const shot of shots) {
    const page = await browser.newPage({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: shot.scale,
    });
    await page.goto(url + (shot.query ? `?${shot.query}` : ''));
    await page.waitForSelector('html[data-ready="true"]', { timeout: 60_000 });
    if (shot.setup) await shot.setup(page);
    // Let story transitions finish, then render a settled frame.
    await page.waitForTimeout(Number(process.env.SHOT_DELAY ?? 2500));
    await page.evaluate(() => {
      // Programmatic focus (e.g. the story's Next button) shows a ring; keep README images clean.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return window.__scatter.renderNow();
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot.file });
    await page.close();
    console.log(`saved ${shot.file}`);
  }
  await browser.close();
} finally {
  await server.close();
}
