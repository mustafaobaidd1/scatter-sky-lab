import { describe, expect, it } from 'vitest';
import { buildAtmosphere, DEFAULT_CONFIG } from '../physics/atmosphere';
import { buildColumnLut } from '../physics/lut';
import { dirFromAngles, type Scene } from '../physics/sky';
import { wavelengthGrid } from '../physics/spectral';
import { cameraBasis, pitchForHorizon, pixelAngle, pixelRay, project, rayThrough } from './camera';
import { keyFor, meterView } from './exposure';
import { shadeDirection } from './shade';
import { HORIZON_DIP_AZIMUTH, hillWeight, RIDGES, ridgeElevation, ridgeHeight } from './terrain';

describe('camera', () => {
  it('projects a ray back to the screen point it came from', () => {
    const b = cameraBasis({ yaw: 210, pitch: 17, fov: 90 }, 1440, 900);
    for (const [x, y] of [
      [0, 0],
      [0.5, -0.3],
      [-0.9, 0.8],
    ]) {
      const d = rayThrough(b, x, y);
      const p = project(b, d, 1440, 900)!;
      expect(p.x).toBeCloseTo(((x + 1) / 2) * 1440, 6);
      expect(p.y).toBeCloseTo(((1 - y) / 2) * 900, 6);
    }
    expect(project(b, [-b.forward[0], -b.forward[1], -b.forward[2]], 1440, 900)).toBeNull();
  });

  it('applies the field of view to the larger screen dimension', () => {
    const wide = cameraBasis({ yaw: 0, pitch: 0, fov: 90 }, 1600, 900);
    const tall = cameraBasis({ yaw: 0, pitch: 0, fov: 90 }, 900, 1600);
    expect(wide.tanX).toBeCloseTo(1, 12);
    expect(tall.tanY).toBeCloseTo(1, 12);
    expect(pixelAngle(tall, 1600)).toBeCloseTo(2 / 1600, 12);
  });

  it('frames the horizon at the requested height', () => {
    const W = 1440;
    const H = 900;
    for (const f of [0.2, 0.35]) {
      const pitch = pitchForHorizon(90, W, H, f);
      const b = cameraBasis({ yaw: 0, pitch, fov: 90 }, W, H);
      const p = project(b, dirFromAngles(0, 0), W, H)!;
      expect(H - p.y).toBeCloseTo(f * H, 3);
    }
  });

  it('gives unit pixel rays through pixel centres', () => {
    const b = cameraBasis({ yaw: 30, pitch: -10, fov: 60 }, 64, 48);
    const d = pixelRay(b, 0, 0, 64, 48);
    expect(Math.hypot(...d)).toBeCloseTo(1, 12);
  });
});

describe('terrain', () => {
  it('ridges are seamless around the horizon and stay low', () => {
    for (const r of RIDGES) {
      expect(ridgeHeight(r, 0.3)).toBeCloseTo(ridgeHeight(r, 0.3 + 2 * Math.PI), 9);
      for (let a = 0; a < 2 * Math.PI; a += 0.05) {
        const e = (ridgeElevation(r, a, 0.002, 6371) * 180) / Math.PI;
        expect(e).toBeGreaterThan(-0.5);
        expect(e).toBeLessThan(4.5);
      }
    }
  });

  it('opens a notch toward the default sunset azimuth', () => {
    const top = (azDeg: number) =>
      Math.max(...RIDGES.map((r) => ridgeElevation(r, (azDeg * Math.PI) / 180, 0.002, 6371)));
    const notch = top(HORIZON_DIP_AZIMUTH);
    for (let a = HORIZON_DIP_AZIMUTH - 45; a <= HORIZON_DIP_AZIMUTH + 45; a += 5) {
      expect(top(a)).toBeGreaterThanOrEqual(notch - 1e-3);
    }
    expect((notch * 180) / Math.PI).toBeLessThan(1);
  });

  it('fades the hills out as the observer climbs', () => {
    expect(hillWeight(0.002)).toBe(1);
    expect(hillWeight(1.5)).toBeGreaterThan(0);
    expect(hillWeight(1.5)).toBeLessThan(1);
    expect(hillWeight(3)).toBe(0);
  });
});

describe('exposure', () => {
  it('maps brighter scenes to a brighter display key (Krawczyk et al. 2005)', () => {
    expect(keyFor(0.01)).toBeLessThan(keyFor(1));
    expect(keyFor(1)).toBeLessThan(keyFor(3000));
    expect(keyFor(3000)).toBeLessThan(0.5);
  });

  it('meters a finite exposure for day, twilight and orbit, ignoring black space', () => {
    const atm = buildAtmosphere(DEFAULT_CONFIG, wavelengthGrid(16));
    const lut = buildColumnLut(atm);
    const exposures: number[] = [];
    for (const [sun, alt, pitch] of [
      [30, 0.002, 20],
      [-5, 0.002, 20],
      [20, 400, -15],
    ]) {
      const scene: Scene = {
        atm,
        lut,
        irradiance: null,
        altitude: alt,
        sunDir: dirFromAngles(sun, 180),
      };
      const r = meterView(scene, cameraBasis({ yaw: 180, pitch, fov: 90 }, 320, 200), 0, 4, 3);
      expect(Number.isFinite(r.exposure) && r.exposure > 0).toBe(true);
      exposures.push(r.exposure);
    }
    // Twilight is metered far more sensitively than daylight.
    expect(exposures[1]).toBeGreaterThan(10 * exposures[0]);
  });
});

describe('shading', () => {
  it('reports what a direction sees: sky, terrain, ground, sun or space', () => {
    const atm = buildAtmosphere(DEFAULT_CONFIG, wavelengthGrid(16));
    const lut = buildColumnLut(atm);
    const sunDir = dirFromAngles(20, 180);
    const ground: Scene = { atm, lut, irradiance: null, altitude: 0.002, sunDir };
    expect(shadeDirection(ground, dirFromAngles(45, 0), { steps: 12, pixelAngle: 0 }).kind).toBe(
      'sky',
    );
    expect(shadeDirection(ground, dirFromAngles(-5, 0), { steps: 12, pixelAngle: 0 }).kind).toBe(
      'terrain',
    );
    expect(shadeDirection(ground, sunDir, { steps: 12, pixelAngle: 0 }).kind).toBe('sun');
    const orbit: Scene = { ...ground, altitude: 400 };
    expect(shadeDirection(orbit, dirFromAngles(-60, 0), { steps: 12, pixelAngle: 0 }).kind).toBe(
      'ground',
    );
    expect(shadeDirection(orbit, dirFromAngles(60, 0), { steps: 12, pixelAngle: 0 }).kind).toBe(
      'space',
    );
  });
});
