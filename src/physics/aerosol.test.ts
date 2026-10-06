import { describe, expect, it } from 'vitest';
import {
  AEROSOL_PRESETS,
  cornetteShanks,
  csAsymmetry,
  csParamFromAsymmetry,
  henyeyGreenstein,
  profileColumn,
  profileDensity,
  spectralParam,
} from './aerosol';

function integrate(f: (mu: number) => number, n = 20000): { norm: number; mean: number } {
  let norm = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const mu = -1 + (2 * (i + 0.5)) / n;
    const w = f(mu) * 2 * Math.PI * (2 / n);
    norm += w;
    mean += w * mu;
  }
  return { norm, mean };
}

describe('aerosol phase functions', () => {
  it.each([0, 0.3, 0.7, 0.85])(
    'Henyey–Greenstein with g = %f is normalised with ⟨cos θ⟩ = g',
    (g) => {
      const r = integrate((mu) => henyeyGreenstein(mu, g));
      expect(r.norm).toBeCloseTo(1, 4);
      expect(r.mean).toBeCloseTo(g, 3);
    },
  );

  it.each([0, 0.3, 0.7, 0.85])(
    'Cornette–Shanks with g = %f is normalised; ⟨cos θ⟩ matches the closed form',
    (g) => {
      const r = integrate((mu) => cornetteShanks(mu, g));
      expect(r.norm).toBeCloseTo(1, 4);
      expect(r.mean).toBeCloseTo(csAsymmetry(g), 3);
    },
  );

  it('inverts the Cornette–Shanks asymmetry so presets can use measured ⟨cos θ⟩', () => {
    for (const a of [0.5, 0.65, 0.7, 0.75]) {
      expect(csAsymmetry(csParamFromAsymmetry(a))).toBeCloseTo(a, 8);
    }
    expect(csParamFromAsymmetry(0.7)).toBeLessThan(0.7);
  });
});

describe('aerosol presets and profiles', () => {
  it('interpolates spectral parameters linearly and clamps them', () => {
    expect(spectralParam(0.9, 0.8, 440, 0, 1)).toBeCloseTo(0.9, 12);
    expect(spectralParam(0.9, 0.8, 670, 0, 1)).toBeCloseTo(0.8, 12);
    expect(spectralParam(0.99, 1.0, 900, 0, 1)).toBe(1);
  });

  it('normalises layer columns so τ550 is the layer optical depth', () => {
    for (const p of [
      { kind: 'exponential' as const, scaleHeight: 1.2 },
      { kind: 'gaussian' as const, centre: 20, width: 2.5 },
    ]) {
      let s = 0;
      const dz = 0.001;
      for (let z = 0; z < 120; z += dz) s += profileDensity(p, z + dz / 2) * dz;
      expect(s).toBeCloseTo(profileColumn(p), 3);
    }
  });

  it('keeps every preset physically valid', () => {
    for (const preset of Object.values(AEROSOL_PRESETS)) {
      for (const layer of [preset.troposphere, preset.stratosphere]) {
        if (!layer) continue;
        expect(layer.tau550).toBeGreaterThan(0);
        expect(layer.ssa440).toBeLessThanOrEqual(1);
        expect(layer.ssa670).toBeLessThanOrEqual(1);
        expect(layer.g440).toBeGreaterThan(0);
        expect(layer.g670).toBeLessThan(1);
      }
    }
  });
});
