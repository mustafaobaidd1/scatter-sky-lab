import { describe, expect, it } from 'vitest';
import { mieSphere } from './mie';
import {
  computeDustOptics,
  dustIndex,
  dustPhase,
  PHASE_ANGLES,
  phaseAngle,
  phaseCoord,
} from './marsDust';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/**
 * Reference values: Bohren & Huffman (1983) BHMIE sample case (x = 2π·0.525/0.6328, m = 1.55) and
 * W. J. Wiscombe's MIEV0 test cases (NCAR TN-140, 1979), as collected in the test suite of
 * miepython (S. Prahl), https://miepython.readthedocs.io/en/latest/10_basic_tests.html.
 * Absorption is written m = n + ik here (Bohren–Huffman convention); miepython writes n − ik.
 */
describe('Mie scattering vs published reference values', () => {
  const xBH = (2 * Math.PI * 0.525) / 0.6328;

  it('Bohren–Huffman sample: m = 1.55, x = 5.213', () => {
    const r = mieSphere(xBH, 1.55, 0);
    expect(r.qext).toBeCloseTo(3.10543, 5);
    expect(r.qsca).toBeCloseTo(3.10543, 5);
    expect(r.qback).toBeCloseTo(2.92534, 5);
    expect(r.g).toBeCloseTo(0.63314, 5);
  });

  it('absorbing sphere: m = 1.55 + 0.1i, x = 5.213', () => {
    const r = mieSphere(xBH, 1.55, 0.1);
    expect(r.qext).toBeCloseTo(2.86165188243, 7);
    expect(r.qsca).toBeCloseTo(1.66424911991, 7);
    expect(r.qback).toBeCloseTo(0.2059953408, 7);
    expect(r.g).toBeCloseTo(0.80128972639, 7);
  });

  it('absorbing sphere: m = 1.5 + 0.5i, x = 2.5', () => {
    const r = mieSphere(2.5, 1.5, 0.5);
    expect(r.qext).toBeCloseTo(2.562873497454734, 7);
    expect(r.qsca).toBeCloseTo(1.097071819088392, 7);
    expect(r.qback).toBeCloseTo(0.123586468179818, 7);
    expect(r.g).toBeCloseTo(0.748905978948507, 7);
  });

  it.each([
    // [m.re, m.im, x, qsca, g] — MIEV0 test cases 7, 9, 10, 14, 17, 18
    [0.75, 0, 10, 2.232265, 0.896473],
    [1.33, 1e-5, 1, 0.093923, 0.184517],
    [1.33, 1e-5, 100, 2.096594, 0.868959],
    [1.5, 1, 1, 0.6634538, 0.192136],
    [10, 10, 1, 2.049405, -0.110664],
    [10, 10, 100, 1.836785, 0.556215],
  ])('Wiscombe MIEV0: m = %f + %fi, x = %f', (n, k, x, qsca, g) => {
    const r = mieSphere(x, n, k);
    expect(r.qsca).toBeCloseTo(qsca, 5);
    expect(r.g).toBeCloseTo(g, 5);
  });

  it('old MIEV0 cases: m = 1.5, x = 10 and 100', () => {
    expect(mieSphere(10, 1.5, 0).qsca).toBeCloseTo(2.882, 3);
    expect(mieSphere(100, 1.5, 0).qsca).toBeCloseTo(2.0944, 3);
  });

  it('approaches the Rayleigh limit Q_sca = (8/3) x⁴ |(m² − 1)/(m² + 2)|² for small x', () => {
    const x = 0.01;
    const m = 1.5;
    const k = (m * m - 1) / (m * m + 2);
    expect(rel(mieSphere(x, m, 0).qsca, (8 / 3) * x ** 4 * k * k)).toBeLessThan(1e-3);
  });

  it('conserves energy: ∫ ½(|S1|² + |S2|²) dΩ = π x² Q_sca, and Q_ext ≥ Q_sca', () => {
    const n = 4000;
    const mus = new Float64Array(n);
    for (let i = 0; i < n; i++) mus[i] = -1 + (2 * (i + 0.5)) / n;
    for (const [x, m, k] of [
      [3, 1.5, 0],
      [8, 1.5, 0.01],
    ]) {
      const r = mieSphere(x, m, k, mus);
      let s = 0;
      for (let i = 0; i < n; i++) s += r.intensity[i] * 2 * Math.PI * (2 / n);
      expect(rel(s, Math.PI * x * x * r.qsca)).toBeLessThan(1e-4);
      expect(r.qext).toBeGreaterThanOrEqual(r.qsca);
    }
  });

  it('rejects invalid input', () => {
    expect(() => mieSphere(0, 1.5, 0)).toThrow();
    expect(() => mieSphere(1, -1, 0)).toThrow();
    expect(() => mieSphere(1, 1.5, -0.1)).toThrow();
    expect(() => mieSphere(Number.NaN, 1.5, 0)).toThrow();
  });
});

describe('Martian dust optics (Mie over a lognormal distribution, r_eff = 1.5 µm)', () => {
  const lambdas = [440, 550, 670];
  const optics = computeDustOptics(lambdas, { radii: 48 });

  it('interpolates the Wolff et al. (2009) refractive index', () => {
    expect(dustIndex(500).n).toBe(1.5);
    expect(dustIndex(500).k).toBeCloseTo(0.00548876, 12);
    const k550 = dustIndex(550).k;
    expect(k550).toBeLessThan(0.00548876);
    expect(k550).toBeGreaterThan(0.00168097);
  });

  it('normalises each phase function to 1 over the sphere', () => {
    for (let i = 0; i < lambdas.length; i++) {
      let s = 0;
      const n = 20000;
      for (let k = 0; k < n; k++) {
        const theta = (Math.PI * (k + 0.5)) / n;
        s += dustPhase(optics, i, Math.cos(theta)) * 2 * Math.PI * Math.sin(theta) * (Math.PI / n);
      }
      expect(s).toBeCloseTo(1, 2);
    }
  });

  it('absorbs blue more than red (ω rises with wavelength) — the butterscotch sky', () => {
    expect(optics.ssa[0]).toBeLessThan(optics.ssa[1]);
    expect(optics.ssa[1]).toBeLessThan(optics.ssa[2]);
    expect(optics.ssa[0]).toBeGreaterThan(0.7);
    expect(optics.ssa[0]).toBeLessThan(0.9);
    expect(optics.ssa[2]).toBeGreaterThan(0.95);
  });

  it('gives ω ≈ 0.975 at 650 nm, the Wolff et al. (2009) value used by Chen-Chen et al. (2019)', () => {
    const at650 = computeDustOptics([650], { radii: 48 });
    expect(Math.abs(at650.ssa[0] - 0.975)).toBeLessThan(0.015);
  });

  it('scatters blue into a narrower, stronger forward peak than red — the blue sunset', () => {
    const near = Math.cos((3 * Math.PI) / 180);
    const wide = Math.cos((40 * Math.PI) / 180);
    expect(dustPhase(optics, 0, near)).toBeGreaterThan(1.3 * dustPhase(optics, 2, near));
    expect(dustPhase(optics, 0, wide)).toBeLessThan(dustPhase(optics, 2, wide));
  });

  it('has large-particle extinction efficiency near 2–3', () => {
    for (const q of optics.qext) {
      expect(q).toBeGreaterThan(2);
      expect(q).toBeLessThan(3.2);
    }
  });

  it('maps table coordinates and angles consistently', () => {
    for (let j = 0; j < PHASE_ANGLES; j += 17) {
      expect(phaseCoord(phaseAngle(j))).toBeCloseTo(j / (PHASE_ANGLES - 1), 12);
    }
  });
});
