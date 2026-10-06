import { describe, expect, it } from 'vitest';
import {
  airColumn,
  airCrossSection,
  airKingFactor,
  airOpticalDepth,
  co2CrossSection,
  depolarisationFromKing,
  rayleighPhase,
  RAYLEIGH_GAMMA,
  renderingRayleighBeta,
} from './rayleigh';
import { STANDARD_AIR_NUMBER_DENSITY } from './constants';

/**
 * Bodhaine et al. (1999), Table 3: dry air with 360 ppm CO2; τ at sea level, 1013.25 mb, 45° N.
 * Columns: wavelength (µm), cross-section (cm²), τ_R, King factor.
 */
const BODHAINE_TABLE_3: [number, number, number, number][] = [
  [0.4, 1.6738e-26, 0.36022, 1.05126],
  [0.44, 1.1273e-26, 0.24261, 1.0503],
  [0.45, 1.0274e-26, 0.22111, 1.05011],
  [0.5, 6.6614e-27, 0.14336, 1.04935],
  [0.55, 4.5105e-27, 0.097069, 1.04882],
  [0.6, 3.164e-27, 0.068092, 1.04844],
  [0.65, 2.2856e-27, 0.049188, 1.04815],
  [0.68, 1.9035e-27, 0.040963, 1.04802],
  [0.7, 1.6926e-27, 0.036424, 1.04793],
];

describe('Rayleigh scattering of air vs Bodhaine et al. (1999) Table 3', () => {
  it.each(BODHAINE_TABLE_3)(
    'at %s µm: cross-section, King factor and optical depth',
    (um, sigma, tau, king) => {
      const nm = um * 1000;
      expect(airKingFactor(nm)).toBeCloseTo(king, 4);
      // Cross-section in cm² (1 m² = 1e4 cm²); agreement to 0.1 %.
      expect(Math.abs(airCrossSection(nm) * 1e4 - sigma) / sigma).toBeLessThan(1e-3);
      expect(Math.abs(airOpticalDepth(nm) - tau) / tau).toBeLessThan(1e-3);
    },
  );

  it('reproduces the column of Eq. (30): 2.1520e25 molecules cm^-2 at sea level, 45° N', () => {
    expect(airColumn() / 1e4).toBeCloseTo(2.152e25, -21);
  });

  it('follows λ^-4.0x: the effective exponent between 440 and 680 nm is ≈ 4.08', () => {
    const p = Math.log(airCrossSection(440) / airCrossSection(680)) / Math.log(680 / 440);
    expect(p).toBeGreaterThan(4.05);
    expect(p).toBeLessThan(4.12);
  });
});

describe('the scattering coefficients widely used in real-time rendering', () => {
  // Bruneton & Neyret (2008) / Hillaire (2020) Table 1: 5.802, 13.558, 33.1 ×10^-6 m^-1.
  const RENDERING = [
    [680, 5.802e-6],
    [550, 13.558e-6],
    [440, 33.1e-6],
  ] as const;

  it.each(RENDERING)(
    'are reproduced at %i nm by n = 1.0003, N = 2.546e25, ρ = 0.035',
    (nm, beta) => {
      expect(Math.abs(renderingRayleighBeta(nm) - beta) / beta).toBeLessThan(2e-3);
    },
  );

  it.each(RENDERING)(
    'are 15–20 %% above the first-principles sea-level value at %i nm',
    (nm, beta) => {
      const physical = airCrossSection(nm) * STANDARD_AIR_NUMBER_DENSITY; // 288.15 K, 1013.25 hPa
      const ratio = beta / physical;
      expect(ratio).toBeGreaterThan(1.14);
      expect(ratio).toBeLessThan(1.21);
    },
  );
});

describe('CO2 (Mars) Rayleigh cross-section', () => {
  it('is 2.4–2.7× that of air at 550 nm (larger polarisability and King factor 1.15)', () => {
    const r = co2CrossSection(550) / airCrossSection(550);
    expect(r).toBeGreaterThan(2.4);
    expect(r).toBeLessThan(2.7);
  });
});

describe('Rayleigh phase function', () => {
  it('integrates to 1 over the sphere', () => {
    let s = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const mu = -1 + (2 * (i + 0.5)) / n;
      s += rayleighPhase(mu, RAYLEIGH_GAMMA) * 2 * Math.PI * (2 / n);
    }
    expect(s).toBeCloseTo(1, 6);
  });

  it('uses a depolarisation ratio near 0.028 (γ ≈ 0.0144)', () => {
    expect(depolarisationFromKing(airKingFactor(550))).toBeCloseTo(0.0283, 3);
    expect(RAYLEIGH_GAMMA).toBeCloseTo(0.0144, 3);
  });
});
