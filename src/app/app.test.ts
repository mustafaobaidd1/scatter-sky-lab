import { describe, expect, it } from 'vitest';
import { formatAltitude, horizonDip } from '../ui/viewPanel';
import { describeSun, elevationAt, trackAt } from '../ui/scrubber';
import {
  atmosphereConfig,
  clampState,
  defaultState,
  profileKey,
  spectralKey,
  Store,
  sunPhase,
} from './state';

describe('sun-elevation scrubber', () => {
  it('maps the track to elevation monotonically and back', () => {
    let prev = Infinity;
    for (let t = 0; t <= 1; t += 0.01) {
      const e = elevationAt(t);
      expect(e).toBeLessThan(prev);
      expect(trackAt(e)).toBeCloseTo(t, 9);
      prev = e;
    }
    expect(elevationAt(0)).toBe(75);
    expect(elevationAt(1)).toBe(-18);
  });

  it('describes the sun for screen readers', () => {
    expect(describeSun(5)).toBe('Sun 5.0° above the horizon, golden hour');
    expect(describeSun(-5)).toBe('Sun 5.0° below the horizon, blue hour');
  });
});

describe('light phases by solar elevation', () => {
  it.each([
    [60, 'high sun'],
    [20, 'daylight'],
    [3, 'golden hour'],
    [-3, 'golden hour'],
    [-5, 'blue hour'],
    [-9, 'nautical twilight'],
    [-15, 'astronomical twilight'],
  ])('%f° is %s', (e, phase) => {
    expect(sunPhase(e)).toBe(phase);
  });
});

describe('state', () => {
  it('clamps values into their physical ranges and wraps angles', () => {
    const s = clampState({
      ...defaultState(),
      sunElevation: 120,
      sunAzimuth: -30,
      pitch: 95,
      altitude: 5000,
      fov: 0,
    });
    expect(s.sunElevation).toBe(90);
    expect(s.sunAzimuth).toBe(330);
    expect(s.pitch).toBe(89);
    expect(s.altitude).toBe(400);
    expect(s.fov).toBe(1);
  });

  it('notifies subscribers with the set of changed keys', () => {
    const store = new Store(defaultState());
    const seen: string[][] = [];
    store.subscribe((_s, changed) => seen.push([...changed]));
    store.set({ sunElevation: 30 });
    store.set({ sunElevation: 30 }); // no change, no notification
    store.animateTo({ planet: 'mars', fov: 50 }, 0);
    expect(seen).toEqual([['sunElevation'], ['planet'], ['fov']]);
    expect(store.get().planet).toBe('mars');
  });

  it('keys tables on what they depend on', () => {
    const s = defaultState();
    expect(profileKey(s)).toBe('earth:clean');
    expect(profileKey({ ...s, aerosolTau: 0.9 })).toBe('earth:clean');
    expect(spectralKey({ ...s, aerosolTau: 0.9 })).not.toBe(spectralKey(s));
    expect(spectralKey({ ...s, sunElevation: 40 })).toBe(spectralKey(s));
    expect(atmosphereConfig(s).planet).toBe('earth');
  });
});

describe('view helpers', () => {
  it('formats altitudes', () => {
    expect(formatAltitude(0.002)).toBe('2 m');
    expect(formatAltitude(1.25)).toBe('1.3 km');
    expect(formatAltitude(400)).toBe('400 km');
  });

  it('computes the horizon dip, about 10° at 100 km and 20° at 400 km on Earth', () => {
    expect(horizonDip(100, 6371)).toBeCloseTo(10.1, 1);
    expect(horizonDip(400, 6371)).toBeCloseTo(19.8, 1);
    expect(horizonDip(0, 6371)).toBe(0);
  });
});
