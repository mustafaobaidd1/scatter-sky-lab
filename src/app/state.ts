/** Application state with change notification and parameter tweening. */
import { AEROSOL_PRESETS, type AerosolPresetId } from '../physics/aerosol';
import type { AtmosphereConfig } from '../physics/atmosphere';
import { MARS_DUST_TAU_DEFAULT, type PlanetId } from '../physics/planets';
import type { ToneMap } from '../physics/tonemap';
import { HORIZON_DIP_AZIMUTH } from '../render/terrain';

export interface SimState {
  planet: PlanetId;
  /** Sun elevation and azimuth, degrees. */
  sunElevation: number;
  sunAzimuth: number;
  /** Camera: azimuth and elevation of the view centre, field of view across the larger side. */
  yaw: number;
  pitch: number;
  fov: number;
  /** Observer altitude, km. */
  altitude: number;
  /** Exponent of the molecular scattering law λ^−p (4 physical). */
  rayleighExponent: number;
  ozone: boolean;
  aerosolPreset: AerosolPresetId;
  aerosolTau: number;
  aerosolAngstrom: number;
  marsDustTau: number;
  /** Exposure compensation, EV. */
  exposureEv: number;
  toneMap: ToneMap;
}

export const SUN_ELEVATION_MIN = -18;
export const SUN_ELEVATION_MAX = 90;
export const ALTITUDE_MIN = 0.002;
export const ALTITUDE_MAX = 400;
export const FOV_MIN = 1;
export const FOV_MAX = 120;
export const DEFAULT_FOV = 90;

export function defaultState(): SimState {
  return {
    planet: 'earth',
    sunElevation: 5,
    sunAzimuth: HORIZON_DIP_AZIMUTH,
    yaw: HORIZON_DIP_AZIMUTH,
    pitch: 14,
    fov: DEFAULT_FOV,
    altitude: ALTITUDE_MIN,
    rayleighExponent: 4,
    ozone: true,
    aerosolPreset: 'clean',
    aerosolTau: AEROSOL_PRESETS.clean.troposphere.tau550,
    aerosolAngstrom: AEROSOL_PRESETS.clean.troposphere.angstrom,
    marsDustTau: MARS_DUST_TAU_DEFAULT,
    exposureEv: 0,
    toneMap: 'filmic',
  };
}

export function atmosphereConfig(s: SimState): AtmosphereConfig {
  return {
    planet: s.planet,
    rayleighExponent: s.rayleighExponent,
    ozone: s.ozone,
    aerosolPreset: s.aerosolPreset,
    aerosolTau: s.aerosolTau,
    aerosolAngstrom: s.aerosolAngstrom,
    marsDustTau: s.marsDustTau,
  };
}

/** Key of everything that changes the column LUT (vertical profiles only). */
export function profileKey(s: SimState): string {
  return s.planet === 'mars' ? 'mars' : `earth:${s.aerosolPreset}`;
}

/** Key of everything that changes the spectral coefficients. */
export function spectralKey(s: SimState): string {
  return [
    profileKey(s),
    s.rayleighExponent.toFixed(4),
    s.ozone,
    s.aerosolTau.toFixed(4),
    s.aerosolAngstrom.toFixed(4),
    s.marsDustTau.toFixed(4),
  ].join('|');
}

export type Listener = (state: SimState, changed: ReadonlySet<keyof SimState>) => void;

const NUMERIC: (keyof SimState)[] = [
  'sunElevation',
  'sunAzimuth',
  'yaw',
  'pitch',
  'fov',
  'altitude',
  'rayleighExponent',
  'aerosolTau',
  'aerosolAngstrom',
  'marsDustTau',
  'exposureEv',
];
const ANGULAR = new Set<keyof SimState>(['sunAzimuth', 'yaw']);

function wrap360(a: number): number {
  return ((a % 360) + 360) % 360;
}

export function clampState(s: SimState): SimState {
  s.sunElevation = Math.min(SUN_ELEVATION_MAX, Math.max(SUN_ELEVATION_MIN, s.sunElevation));
  s.sunAzimuth = wrap360(s.sunAzimuth);
  s.yaw = wrap360(s.yaw);
  s.pitch = Math.min(89, Math.max(-89, s.pitch));
  s.fov = Math.min(FOV_MAX, Math.max(FOV_MIN, s.fov));
  s.altitude = Math.min(ALTITUDE_MAX, Math.max(ALTITUDE_MIN, s.altitude));
  s.rayleighExponent = Math.min(4, Math.max(0, s.rayleighExponent));
  s.aerosolTau = Math.min(3, Math.max(0, s.aerosolTau));
  s.aerosolAngstrom = Math.min(2.5, Math.max(0, s.aerosolAngstrom));
  s.marsDustTau = Math.min(3, Math.max(0.05, s.marsDustTau));
  s.exposureEv = Math.min(4, Math.max(-4, s.exposureEv));
  return s;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Store {
  private state: SimState;
  private listeners = new Set<Listener>();
  private tween: {
    from: SimState;
    to: Partial<SimState>;
    start: number;
    duration: number;
    raf: number;
  } | null = null;

  constructor(initial: SimState) {
    this.state = clampState({ ...initial });
  }

  get(): Readonly<SimState> {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Applies a change immediately (cancelling any running tween for those keys). */
  set(patch: Partial<SimState>): void {
    if (this.tween) {
      for (const k of Object.keys(patch) as (keyof SimState)[]) delete this.tween.to[k];
    }
    this.apply(patch);
  }

  private apply(patch: Partial<SimState>) {
    const next = clampState({ ...this.state, ...patch });
    const changed = new Set<keyof SimState>();
    for (const k of Object.keys(next) as (keyof SimState)[]) {
      if (next[k] !== this.state[k]) changed.add(k);
    }
    if (changed.size === 0) return;
    this.state = next;
    for (const fn of this.listeners) fn(this.state, changed);
  }

  get tweening(): boolean {
    return this.tween !== null;
  }

  /**
   * Animates numeric fields to their targets; discrete fields switch immediately.
   * duration 0 (reduced motion) applies everything at once.
   */
  animateTo(target: Partial<SimState>, duration: number, onDone?: () => void): void {
    this.cancelTween();
    const discrete: Partial<SimState> = {};
    const numeric: Partial<SimState> = {};
    for (const [k, v] of Object.entries(target) as [keyof SimState, never][]) {
      if (NUMERIC.includes(k)) (numeric as Record<string, unknown>)[k] = v;
      else (discrete as Record<string, unknown>)[k] = v;
    }
    this.apply(discrete);
    if (duration <= 0) {
      this.apply(numeric);
      onDone?.();
      return;
    }
    const from = { ...this.state };
    const tick = (now: number) => {
      if (!this.tween) return;
      const t = Math.min(1, (now - this.tween.start) / this.tween.duration);
      const e = easeInOut(t);
      const patch: Record<string, number> = {};
      for (const [k, v] of Object.entries(this.tween.to) as [keyof SimState, number][]) {
        const a = from[k] as number;
        let delta = v - a;
        if (ANGULAR.has(k)) delta = ((((delta + 180) % 360) + 360) % 360) - 180;
        patch[k] = a + delta * e;
      }
      this.apply(patch as Partial<SimState>);
      if (t < 1) this.tween.raf = requestAnimationFrame(tick);
      else {
        this.tween = null;
        onDone?.();
      }
    };
    this.tween = {
      from,
      to: numeric,
      start: performance.now(),
      duration,
      raf: requestAnimationFrame(tick),
    };
  }

  cancelTween(): void {
    if (this.tween) cancelAnimationFrame(this.tween.raf);
    this.tween = null;
  }
}

/**
 * Light phases defined by solar elevation (degrees): golden hour from +6° to −4° and blue hour
 * from −4° to −6° (the photographers' convention used e.g. by timeanddate.com), then nautical
 * (to −12°) and astronomical (to −18°) twilight.
 */
export function sunPhase(elevation: number): string {
  if (elevation >= 45) return 'high sun';
  if (elevation >= 6) return 'daylight';
  if (elevation >= -4) return 'golden hour';
  if (elevation >= -6) return 'blue hour';
  if (elevation >= -12) return 'nautical twilight';
  return 'astronomical twilight';
}
