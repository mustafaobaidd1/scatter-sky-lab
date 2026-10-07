import { expect, type Page } from '@playwright/test';

/** Shape of the app's test hook (window.__scatter). */
export interface ScatterHook {
  state: Record<string, number | string | boolean>;
  set(patch: Record<string, unknown>): void;
  renderNow(): Promise<void>;
  readPixel(u: number, v: number): [number, number, number] | null;
  compareWithCpu(u: number, v: number): { gpu: number[]; cpu: number[] } | null;
  screenOf(elevation: number, azimuth: number): { x: number; y: number } | null;
  loseContext(): boolean;
}

declare global {
  interface Window {
    __scatter: ScatterHook;
  }
}

/** Loads the app at a small render scale (software WebGL in CI is slow) and waits until ready. */
export async function open(page: Page, query = 'scale=0.25'): Promise<void> {
  await page.goto(`./?${query}`);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
}

export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => window.__scatter.renderNow());
}

export async function pixelAtScreen(page: Page, x: number, y: number): Promise<number[]> {
  const box = await page.locator('#stage').boundingBox();
  if (!box) throw new Error('no stage');
  const px = await page.evaluate(
    ([u, v]) => window.__scatter.readPixel(u, v),
    [x / box.width, y / box.height],
  );
  if (!px) throw new Error('no pixel');
  return px;
}

/** Mean HSV saturation of the rendered image over a grid of points in the given region. */
export async function meanSaturation(page: Page, top = 0.12, bottom = 0.45): Promise<number> {
  return page.evaluate(
    ([t, b]) => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 3; j++) {
          const p = window.__scatter.readPixel(0.15 + i * 0.12, t + ((b - t) * j) / 2);
          if (!p) continue;
          const max = Math.max(...p);
          const min = Math.min(...p);
          sum += max > 0 ? (max - min) / max : 0;
          n++;
        }
      }
      return sum / n;
    },
    [top, bottom],
  );
}

export function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
