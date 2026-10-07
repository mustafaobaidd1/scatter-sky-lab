import { describe, expect, it } from 'vitest';
import validation from '../generated/validation.json';
import { airOpticalDepth } from './rayleigh';
import { colourStats } from './analysis';
import { buildAtmosphere, DEFAULT_CONFIG } from './atmosphere';
import { buildColumnLut } from './lut';
import { dirFromAngles, traceRay } from './sky';
import { wavelengthGrid } from './spectral';

/** The numbers shown in the README and the How-it-works panel must match the current code. */
describe('recorded validation results (npm run validate) are current', () => {
  it('Rayleigh optical depths', () => {
    for (const r of validation.rayleigh) {
      expect(Math.abs(airOpticalDepth(r.nm) - r.tauModel)).toBeLessThan(1e-6);
    }
  });

  it('noon zenith colour', () => {
    const grid = wavelengthGrid(16);
    const atm = buildAtmosphere(DEFAULT_CONFIG, grid);
    const scene = {
      atm,
      lut: buildColumnLut(atm),
      irradiance: null,
      altitude: 0.002,
      sunDir: dirFromAngles(60, 180),
    };
    const r = traceRay(scene, dirFromAngles(90, 180), { steps: 64, useLut: true });
    const c = colourStats(
      grid,
      r.rayleigh.map((v, i) => v + r.aerosol[i]),
    );
    expect(
      Math.abs(c.dominant!.wavelength - validation.qualitative.noonZenith.dominant!),
    ).toBeLessThan(0.1);
    expect(Math.abs(c.dominant!.purity - validation.qualitative.noonZenith.purity)).toBeLessThan(
      0.001,
    );
  });
});
