import { describe, expect, it } from 'vitest';
import { colourStats } from './analysis';
import {
  buildAtmosphere,
  DEFAULT_CONFIG,
  verticalOpticalDepths,
  type AtmosphereConfig,
} from './atmosphere';
import { AEROSOL_PRESETS, type AerosolPresetId } from './aerosol';
import { cmfWeights, spectrumToXyz } from './colour';
import { buildColumnLut, integrateColumns, distanceToTop, lookupColumns } from './lut';
import { computeDustOptics } from './marsDust';
import {
  buildIrradianceTable,
  dirFromAngles,
  sunDiscRadiance,
  traceRay,
  type Scene,
  type Vec3,
} from './sky';
import { wavelengthGrid } from './spectral';

const GRID = wavelengthGrid(16);
const DUST = computeDustOptics(wavelengthGrid(18), { radii: 40 });

function scene(
  cfg: Partial<AtmosphereConfig>,
  sunElevation: number,
  altitude = 0.002,
  grid = GRID,
): Scene {
  const atm = buildAtmosphere({ ...DEFAULT_CONFIG, ...cfg }, grid, DUST);
  const lut = buildColumnLut(atm);
  return { atm, lut, irradiance: null, altitude, sunDir: dirFromAngles(sunElevation, 180) };
}

function skyColour(sc: Scene, elevation: number, azimuthFromSun: number, steps = 64) {
  const r = traceRay(sc, dirFromAngles(elevation, 180 + azimuthFromSun), { steps, useLut: true });
  const L = r.rayleigh.map((v, i) => v + r.aerosol[i]);
  return colourStats(sc.atm.lambdas, L);
}

describe('transmittance', () => {
  it('at the zenith equals exp(−τ_R − τ_aerosol − τ_O3) for every wavelength and preset', () => {
    for (const preset of Object.keys(AEROSOL_PRESETS) as AerosolPresetId[]) {
      const sc = scene({ aerosolPreset: preset }, 45, 0);
      const ray = traceRay(sc, [0, 1, 0], { steps: 128, useLut: false });
      const col = lookupColumns(sc.lut, sc.atm.bottomRadius, 1, new Float64Array(4));
      for (let i = 0; i < GRID.length; i++) {
        const t = verticalOpticalDepths(sc.atm, i);
        const expected = Math.exp(-(t.rayleigh + t.aerosol + t.ozone));
        expect(Math.abs(ray.transmittance[i] / expected - 1)).toBeLessThan(2e-3);
        const a = sc.atm;
        const fromLut = Math.exp(
          -(
            a.molSca[i] * col[0] +
            a.aExt[i] * col[1] +
            a.bExt[i] * col[2] +
            a.ozoneAbs[i] * col[3]
          ),
        );
        expect(Math.abs(fromLut / expected - 1)).toBeLessThan(2e-3);
      }
    }
  });

  it('gives the Rayleigh optical depth of Bodhaine et al. (1999) for the Earth model', () => {
    const sc = scene({}, 45, 0, new Float64Array([400, 550, 700]));
    const ref = [0.36022, 0.097069, 0.036424];
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(verticalOpticalDepths(sc.atm, i).rayleigh / ref[i] - 1)).toBeLessThan(1e-3);
    }
  });

  it('LUT optical depths match a fine direct integration (within 1 % or 0.004, i.e. ≤ 0.4 % in T)', () => {
    const sc = scene({ aerosolPreset: 'volcanic' }, 45, 0);
    const { atm, lut } = sc;
    const R = atm.bottomRadius;
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    const tau = (col: Float64Array, i: number) =>
      atm.molSca[i] * col[0] +
      atm.aExt[i] * col[1] +
      atm.bExt[i] * col[2] +
      atm.ozoneAbs[i] * col[3];
    let checked = 0;
    for (const h of [0, 0.3, 2, 7, 15, 22, 30, 45, 60, 90]) {
      for (const mu of [1, 0.6, 0.25, 0.08, 0.02, 0, -0.03, -0.08, -0.12]) {
        const r = R + h;
        const muH = -Math.sqrt(Math.max(0, 1 - (R / r) ** 2));
        if (mu < muH + 1e-4) continue; // below the horizon: not tabulated
        lookupColumns(lut, r, mu, a);
        integrateColumns(atm, r, mu, distanceToTop(r, mu, atm.topRadius), 4000, b);
        for (let i = 0; i < GRID.length; i++) {
          const ref = tau(b, i);
          expect(Math.abs(tau(a, i) - ref)).toBeLessThan(Math.max(0.004, 0.01 * ref));
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });
});

describe('radiance is finite and non-negative everywhere', () => {
  it('over planets, presets, sun positions, altitudes and view directions', () => {
    const configs: Partial<AtmosphereConfig>[] = [
      ...(Object.keys(AEROSOL_PRESETS) as AerosolPresetId[]).map((p) => ({ aerosolPreset: p })),
      { rayleighExponent: 0, ozone: false },
      { planet: 'mars' as const },
    ];
    let checked = 0;
    for (const cfg of configs) {
      const base = scene(cfg, 0);
      base.irradiance = buildIrradianceTable(base.atm, base.lut, 6, 3, 3);
      for (const altitude of [0, 12, 120, 400]) {
        for (const sunEl of [-18, -5, 0, 3, 30, 90]) {
          const sc: Scene = { ...base, altitude, sunDir: dirFromAngles(sunEl, 180) };
          for (let e = -90; e <= 90; e += 30) {
            for (let az = 0; az < 360; az += 60) {
              const r = traceRay(sc, dirFromAngles(e, az), { steps: 12, useLut: true });
              for (let i = 0; i < GRID.length; i++) {
                for (const v of [r.rayleigh[i], r.aerosol[i], r.transmittance[i]]) {
                  expect(Number.isFinite(v) && v >= 0).toBe(true);
                }
              }
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  }, 60_000);
});

describe('colour pipeline', () => {
  it('maps CIE D65 to equal linear-sRGB components (16 samples and 5 nm)', async () => {
    const { CIE_D65_5NM } = await import('./data/cie');
    const { hatAverage } = await import('./spectral');
    const { xyzToLinearSrgb } = await import('./colour');
    for (const [grid, tol] of [
      [wavelengthGrid(69), 0.004],
      [GRID, 0.02],
    ] as const) {
      const d65 = hatAverage(CIE_D65_5NM, grid);
      const rgb = xyzToLinearSrgb(spectrumToXyz(d65, cmfWeights(grid)));
      const m = (rgb[0] + rgb[1] + rgb[2]) / 3;
      for (const c of rgb) expect(Math.abs(c / m - 1)).toBeLessThan(tol);
    }
  });

  it('orders monochromatic hues: CIELAB hue angle falls monotonically from 450 to 650 nm', async () => {
    const { spectralChromaticity, xyzToLab, labToLch, D65_XYZ } = await import('./colour');
    let prev = Infinity;
    for (let l = 450; l <= 650; l += 10) {
      const [x, y] = spectralChromaticity(l);
      const h = labToLch(xyzToLab([x / y, 1, (1 - x - y) / y], D65_XYZ)).h;
      expect(h).toBeLessThan(prev);
      prev = h;
    }
  });

  it('16 spectral samples reproduce the 5 nm reference sky colour (ΔE*ab < 1.5)', () => {
    const fine = wavelengthGrid(69);
    for (const [cfg, sunEl, el, az] of [
      [{}, 60, 90, 0],
      [{}, 1, 2, 10],
      [{ aerosolPreset: 'smoke' as const }, 20, 40, 60],
      [{ planet: 'mars' as const }, 2, 4, 2],
    ] as const) {
      const coarse = skyColour(scene(cfg, sunEl), el, az);
      const ref = skyColour(scene(cfg, sunEl, 0.002, fine), el, az);
      const dE = Math.hypot(coarse.a - ref.a, coarse.b - ref.b);
      expect(dE).toBeLessThan(1.5);
      expect(Math.abs(coarse.luminance / ref.luminance - 1)).toBeLessThan(0.02);
    }
  });

  it('the at-rest fast path (LUT, 48 steps) agrees with the reference (direct sun integral, 256 steps)', () => {
    for (const [cfg, sunEl, el, az] of [
      [{}, 45, 70, 30],
      [{}, 0.5, 1.5, 8],
      [{}, -4, 89, 0],
      [{ aerosolPreset: 'volcanic' as const }, -2, 20, 0],
    ] as const) {
      const sc = scene(cfg, sunEl);
      const dir = dirFromAngles(el, 180 + az);
      const fast = traceRay(sc, dir, { steps: 48, useLut: true });
      const ref = traceRay(sc, dir, { steps: 256, useLut: false, sunSteps: 256 });
      const f = colourStats(
        GRID,
        fast.rayleigh.map((v, i) => v + fast.aerosol[i]),
      );
      const r = colourStats(
        GRID,
        ref.rayleigh.map((v, i) => v + ref.aerosol[i]),
      );
      expect(Math.abs(f.luminance / r.luminance - 1)).toBeLessThan(0.03);
      expect(Math.hypot(f.a - r.a, f.b - r.b)).toBeLessThan(1.5);
    }
  });
});

describe('qualitative physics (thresholds)', () => {
  it('noon zenith is sky blue: dominant wavelength 465–490 nm', () => {
    const c = skyColour(scene({}, 60), 90, 0);
    expect(c.dominant?.complementary).toBe(false);
    expect(c.dominant!.wavelength).toBeGreaterThan(465);
    expect(c.dominant!.wavelength).toBeLessThan(490);
    expect(c.dominant!.purity).toBeGreaterThan(0.1);
  });

  it('the horizon beside a setting sun is red-orange: dominant wavelength 580–620 nm, purity > 0.6', () => {
    const c = skyColour(scene({}, 0.5), 1.5, 8);
    expect(c.dominant!.wavelength).toBeGreaterThan(580);
    expect(c.dominant!.wavelength).toBeLessThan(620);
    expect(c.dominant!.purity).toBeGreaterThan(0.6);
  });

  it('with λ⁰ molecular scattering the noon sky is near-neutral', () => {
    const blue = skyColour(scene({}, 60), 90, 0);
    const grey = skyColour(scene({ rayleighExponent: 0 }, 60), 90, 0);
    expect(grey.dominant!.purity).toBeLessThan(0.08);
    expect(grey.chroma).toBeLessThan(10);
    expect(grey.dominant!.purity).toBeLessThan(0.4 * blue.dominant!.purity);
  });

  it('ozone keeps the twilight zenith blue; without it the zenith turns yellowish', () => {
    const withO3 = skyColour(scene({}, -4), 89, 0);
    const noO3 = skyColour(scene({ ozone: false }, -4), 89, 0);
    expect(withO3.b).toBeLessThan(-5);
    expect(noO3.b).toBeGreaterThan(3);
    expect(noO3.dominant!.wavelength).toBeGreaterThan(570);
  });

  it('the Martian noon sky is butterscotch: dominant wavelength 572–600 nm, CIELAB hue 50–95°', () => {
    const c = skyColour(scene({ planet: 'mars' }, 60), 90, 0);
    expect(c.dominant!.wavelength).toBeGreaterThan(572);
    expect(c.dominant!.wavelength).toBeLessThan(600);
    expect(c.hue).toBeGreaterThan(50);
    expect(c.hue).toBeLessThan(95);
  });

  it('around a setting sun on Mars the sky is bluish, while 40° away it stays butterscotch', () => {
    const sc = scene({ planet: 'mars' }, 2);
    const near = skyColour(sc, 4, 2);
    const far = skyColour(sc, 20, 40);
    expect(near.b).toBeLessThan(0);
    expect(near.dominant!.wavelength).toBeLessThan(500);
    expect(far.b).toBeGreaterThan(5);
  });
});

describe('sun disc', () => {
  it('integrates to the solar irradiance over the disc (limb darkening normalised)', () => {
    const sc = scene({}, 30);
    const alpha = sc.atm.sunAngularRadius;
    const out = new Float64Array(GRID.length);
    const sums = new Float64Array(GRID.length);
    const n = 4000;
    for (let k = 0; k < n; k++) {
      const theta = (alpha * (k + 0.5)) / n;
      sunDiscRadiance(sc.atm, theta, out);
      const dOmega = 2 * Math.PI * Math.sin(theta) * (alpha / n);
      for (let i = 0; i < GRID.length; i++) sums[i] += out[i] * dOmega;
    }
    for (let i = 0; i < GRID.length; i++) expect(sums[i] / sc.atm.solar[i]).toBeCloseTo(1, 3);
  });

  it('is darker and redder at the limb than at the centre', () => {
    const sc = scene({}, 30);
    const centre = sunDiscRadiance(sc.atm, 0, new Float64Array(GRID.length));
    const limb = sunDiscRadiance(
      sc.atm,
      sc.atm.sunAngularRadius * 0.95,
      new Float64Array(GRID.length),
    );
    const blueRatio = limb[1] / centre[1];
    const redRatio = limb[14] / centre[14];
    expect(blueRatio).toBeLessThan(redRatio);
    expect(redRatio).toBeLessThan(1);
  });
});

describe('geometry', () => {
  it('converts angles to unit directions', () => {
    const d: Vec3 = dirFromAngles(30, 90);
    expect(Math.hypot(...d)).toBeCloseTo(1, 12);
    expect(d[1]).toBeCloseTo(0.5, 12);
    expect(d[0]).toBeCloseTo(Math.cos(Math.PI / 6), 12);
  });
});
