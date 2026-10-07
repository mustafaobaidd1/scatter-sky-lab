/**
 * Exposure: a light meter over the current view, like a camera's evaluative metering.
 *
 * The log-average luminance L̄ over a grid of view directions (the solar disc excluded, terrain and
 * ground down-weighted like a photographer metering a skyscape) is mapped to a display "key" with
 * the lightness-perception curve of Krawczyk, Myszkowski & Seidel (2005),
 * a = 1.03 − 2 / (2 + log10(L̄ + 1)), so bright noon skies are shown bright and twilight stays dim
 * instead of being normalised to mid grey. exposure = KEY_SCALE · a / L̄ · 2^compensation.
 */
import { cmfWeights, radianceToXyz } from '../physics/colour';
import type { Scene } from '../physics/sky';
import { type CameraBasis, rayThrough } from './camera';
import { shadeDirection } from './shade';

export interface ExposureResult {
  /** Multiplier from luminance (cd/m²) to display-linear units. */
  exposure: number;
  /** Log-average metered luminance, cd/m². */
  meteredLuminance: number;
  key: number;
}

/** Floor of the meter so night scenes are not amplified without limit (cd/m²). */
export const METER_FLOOR = 0.002;

/** Scales Krawczyk's key (designed for Reinhard's curve) to the AgX curve used here. */
export const KEY_SCALE = 0.7;

/**
 * Weights of the meter by what a direction sees. Black space is ignored; from high altitude the
 * planet's ground and limb are the subject (the thin air above is almost black), so above 20 km
 * the ground weighs fully and the sky little.
 */
function meterWeight(kind: string, altitude: number): number {
  const high = altitude > 20;
  if (kind === 'space') return 0;
  if (kind === 'ground') return high ? 1 : 0.15;
  if (kind === 'terrain') return 0.15;
  return high ? 0.1 : 1;
}

export function keyFor(luminance: number): number {
  return KEY_SCALE * (1.03 - 2 / (2 + Math.log10(luminance + 1)));
}

export function meterView(
  scene: Scene,
  basis: CameraBasis,
  compensationEv = 0,
  columns = 6,
  rows = 4,
): ExposureResult {
  const w = cmfWeights(scene.atm.lambdas);
  let sumLog = 0;
  let total = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const x = ((i + 0.5) / columns) * 2 - 1;
      const y = ((j + 0.5) / rows) * 2 - 1;
      const res = shadeDirection(scene, rayThrough(basis, x * 0.92, y * 0.92), {
        steps: 16,
        pixelAngle: 0,
      });
      const l = res.radiance.map((v, k) => v - res.sun[k]);
      const Y = radianceToXyz(l, w)[1];
      const wt = meterWeight(res.kind, scene.altitude);
      sumLog += wt * Math.log(Math.max(Y, 0) + METER_FLOOR);
      total += wt;
    }
  }
  const meteredLuminance = total > 0 ? Math.exp(sumLog / total) : METER_FLOOR;
  const key = keyFor(meteredLuminance);
  let exposure = (key / meteredLuminance) * Math.pow(2, compensationEv);

  // Zoomed on the Sun (its disc spans more than ~1/12 of the view): expose for the disc instead,
  // so its limb darkening and colour are visible rather than clipped to white.
  const sunRadius = scene.atm.sunAngularRadius;
  const halfView = Math.atan(Math.min(basis.tanX, basis.tanY));
  const s = scene.sunDir;
  const f = basis.forward;
  const offAxis = Math.acos(Math.min(1, s[0] * f[0] + s[1] * f[1] + s[2] * f[2]));
  if (sunRadius / halfView > 1 / 12 && offAxis < halfView) {
    const disc = shadeDirection(scene, s, { steps: 16, pixelAngle: 0 });
    if (disc.kind === 'sun') {
      const Yd = radianceToXyz(disc.radiance, w)[1];
      exposure = Math.min(exposure, (1.2 / Yd) * Math.pow(2, compensationEv));
    }
  }
  return { exposure, meteredLuminance, key };
}
