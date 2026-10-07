import { expect, test } from '@playwright/test';
import { distance, meanSaturation, open, pixelAtScreen, settle } from './helpers';

test.describe('the sky responds to the sun', () => {
  test('dragging the sun changes the rendered colour at the zenith', async ({ page }) => {
    await open(page);
    // A wide view that shows both the zenith and a sun at 20°.
    await page.evaluate(() => window.__scatter.set({ fov: 120, pitch: 44, sunElevation: 20 }));
    await settle(page);
    const az = (await page.evaluate(() => window.__scatter.state.yaw)) as number;
    const zenith = await page.evaluate((a) => window.__scatter.screenOf(89.5, a), az);
    expect(zenith).not.toBeNull();
    const before = await pixelAtScreen(page, zenith!.x, zenith!.y);

    const handle = page.locator('#sun-handle');
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    const sunAz = (await page.evaluate(() => window.__scatter.state.sunAzimuth)) as number;
    const target = (await page.evaluate((a) => window.__scatter.screenOf(-3, a), sunAz))!;
    const stage = (await page.locator('#stage').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x + target.x, stage.y + target.y, { steps: 8 });
    await page.mouse.up();

    const elevation = (await page.evaluate(() => window.__scatter.state.sunElevation)) as number;
    expect(elevation).toBeLessThan(0);
    await settle(page);
    const after = await pixelAtScreen(page, zenith!.x, zenith!.y);
    expect(distance(before, after)).toBeGreaterThan(8);
    // Just after sunset the zenith is lit by sunlight that crossed the horizon and lost its blue:
    // its red share rises (deeper in twilight, ozone turns it blue again).
    const redShare = (p: number[]) => p[0] / (p[0] + p[1] + p[2]);
    expect(redShare(after)).toBeGreaterThan(redShare(before));
  });

  test('the scrubber and the arrow keys move the sun', async ({ page }) => {
    await open(page);
    const start = (await page.evaluate(() => window.__scatter.state.sunElevation)) as number;
    await page.locator('body').press('ArrowUp');
    await page.locator('body').press('ArrowUp');
    await page.locator('body').press('Shift+ArrowUp');
    const raised = (await page.evaluate(() => window.__scatter.state.sunElevation)) as number;
    expect(raised).toBeCloseTo(start + 6, 5);
    const slider = page.getByRole('slider', { name: 'Sun elevation' });
    await slider.fill('900');
    const late = (await page.evaluate(() => window.__scatter.state.sunElevation)) as number;
    expect(late).toBeLessThan(-6);
    await expect(page.locator('#sun-elevation-value')).toContainText('twilight');
  });
});

test('switching the scattering law to λ⁰ makes the sky neutral', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const s = window.__scatter.state;
    window.__scatter.set({
      sunElevation: 60,
      yaw: ((s.sunAzimuth as number) + 240) % 360,
      pitch: 30,
      fov: 90,
    });
  });
  await settle(page);
  const blue = await meanSaturation(page);
  await page.getByRole('button', { name: 'Experiments' }).click();
  await page.getByRole('button', { name: /λ⁰ — grey sky/ }).click();
  await settle(page);
  const grey = await meanSaturation(page);
  expect(blue).toBeGreaterThan(0.15);
  expect(grey).toBeLessThan(0.07);
});

test('tapping the sky shows its spectrum in the probe', async ({ page }) => {
  await open(page);
  const stage = (await page.locator('#stage').boundingBox())!;
  await page.mouse.click(stage.x + stage.width * 0.3, stage.y + stage.height * 0.32);
  const probe = page.locator('#panel-probe');
  await expect(probe).toBeVisible();
  await expect(probe.getByRole('img', { name: /Spectral radiance/ })).toBeVisible();
  const points = await probe.locator('svg.chart polyline').first().getAttribute('points');
  expect(points!.trim().split(/\s+/).length).toBeGreaterThanOrEqual(60);
  await expect(probe).toContainText('Rayleigh');
  await expect(probe).toContainText('cd/m²');
  await expect(page.locator('#probe-marker')).toBeVisible();
});

test('the probe keyboard presets work without a pointer', async ({ page }) => {
  await open(page);
  await page.keyboard.press('p');
  const probe = page.locator('#panel-probe');
  await expect(probe).toContainText('Tap the sky to read its spectrum');
  await probe.getByRole('button', { name: 'Zenith' }).click();
  await expect(probe).toContainText('Dominant λ');
});

test('the WebGL image matches the CPU reference', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__scatter.set({ fov: 100, pitch: 30 }));
  await settle(page);
  let worst = 0;
  for (const [u, v] of [
    [0.2, 0.15],
    [0.5, 0.3],
    [0.8, 0.2],
    [0.35, 0.5],
    [0.65, 0.45],
  ]) {
    const r = await page.evaluate(([a, b]) => window.__scatter.compareWithCpu(a, b), [u, v]);
    expect(r).not.toBeNull();
    worst = Math.max(worst, ...r!.gpu.map((g, i) => Math.abs(g - r!.cpu[i])));
  }
  expect(worst).toBeLessThanOrEqual(3);
});

test('the CPU fallback renders when WebGL2 is not used', async ({ page }) => {
  await open(page, 'renderer=cpu');
  await expect(page.locator('html')).toHaveAttribute('data-renderer', 'cpu');
  await expect(page.locator('#banner')).toContainText('CPU');
  await expect(page.locator('#sky-cpu')).toBeVisible();
  const pixels = await page.evaluate(() =>
    [0.1, 0.4, 0.7].flatMap((v) => [0.2, 0.8].map((u) => window.__scatter.readPixel(u, v))),
  );
  const brightness = pixels.map((p) => (p ? p[0] + p[1] + p[2] : 0));
  expect(Math.max(...brightness) - Math.min(...brightness)).toBeGreaterThan(30);
});

test('a lost WebGL context is restored', async ({ page }) => {
  await open(page);
  const lost = await page.evaluate(() => window.__scatter.loseContext());
  test.skip(!lost, 'WEBGL_lose_context is not available');
  await expect(page.locator('#banner')).toContainText('lost');
  await expect(page.locator('#banner')).toBeHidden({ timeout: 30_000 });
  await settle(page);
  const px = await page.evaluate(() => window.__scatter.readPixel(0.5, 0.2));
  expect(px).not.toBeNull();
});

test('the story walks through its steps and can be left at any time', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Story' }).click();
  const story = page.locator('#story');
  await expect(story.getByRole('heading', { name: 'A blue sky at noon' })).toBeVisible();
  await story.getByRole('button', { name: 'Next' }).click();
  await expect(story.getByRole('heading', { name: 'Why not violet?' })).toBeVisible();
  await page.keyboard.press('3');
  await expect(story.getByRole('heading', { name: 'Sunset: the long way through' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(story).toBeHidden();
});

test('under reduced motion the story jumps without animating', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  // No decorative pulse around the sun.
  await expect(page.locator('.sun-pulse')).toHaveCount(1);
  await expect(page.locator('.sun-pulse')).toBeHidden();
  await page.getByRole('button', { name: 'Story' }).click();
  const elevation = (await page.evaluate(() => window.__scatter.state.sunElevation)) as number;
  expect(elevation).toBe(62);
});

test('How it works opens with typeset equations and validation', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'How it works' }).click();
  const dialog = page.getByRole('dialog', { name: 'How it works' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.katex').first()).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText('Bodhaine');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('Mars can be selected and its sky is butterscotch at noon', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Experiments' }).click();
  await page.getByRole('radio', { name: 'Mars' }).click();
  await expect(page.locator('#aerosol-mars')).toBeVisible();
  // Look away from the Sun, whose aureole saturates to white.
  await page.evaluate(() => {
    const s = window.__scatter.state;
    window.__scatter.set({
      sunElevation: 60,
      yaw: ((s.sunAzimuth as number) + 150) % 360,
      pitch: 35,
      fov: 90,
    });
  });
  await expect(page.locator('#app')).not.toHaveClass(/is-updating/, { timeout: 30_000 });
  await settle(page);
  const px = await page.evaluate(() => window.__scatter.readPixel(0.5, 0.25));
  expect(px).not.toBeNull();
  // Butterscotch: clearly more red than blue.
  expect(px![0] - px![2]).toBeGreaterThan(12);
});
