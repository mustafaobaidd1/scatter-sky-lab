/**
 * Procedural horizon: three ridgelines of low hills at fixed distances from the observer, each a
 * small sum of sines in azimuth (integer frequencies keep them seamless around the horizon).
 * The same constants are used by the GLSL shader (see shaders/sky.frag.glsl, RIDGE_*).
 */

export interface RidgeLayer {
  /** Horizontal distance from the observer, km. */
  distance: number;
  /** Base height, km. */
  base: number;
  /** Gaussian hills: [centre azimuth deg, width deg, height km]. */
  bumps: readonly [number, number, number][];
  /** Small detail: [amplitude km, integer frequency, phase rad]. */
  terms: readonly [number, number, number][];
  /** Normal tilt toward the sky (slope of the hillside facing the observer), radians. */
  slope: number;
}

/**
 * Art-directed so the default view (toward 255°, west-southwest) frames a notch where the sun can
 * set, with near slopes on either side, rolling hills behind and hazy peaks far away.
 */
export const RIDGES: readonly RidgeLayer[] = [
  {
    distance: 1.2,
    base: 0.0055,
    bumps: [
      [185, 22, 0.0415],
      [330, 22, 0.0369],
      [140, 35, 0.0323],
      [40, 45, 0.0369],
      [90, 20, 0.0231],
    ],
    terms: [
      [0.00277, 7, 2.0],
      [0.00231, 11, 4.0],
      [0.00115, 23, 1.3],
    ],
    slope: 0.35,
  },
  {
    distance: 5,
    base: 0.0278,
    bumps: [
      [228, 14, 0.1041],
      [288, 18, 0.1111],
      [175, 30, 0.1527],
      [350, 35, 0.1736],
      [110, 28, 0.1389],
    ],
    terms: [
      [0.01111, 13, 3.3],
      [0.00556, 29, 2.2],
    ],
    slope: 0.3,
  },
  {
    distance: 25,
    base: 0.1172,
    bumps: [
      [212, 8, 1.2656],
      [240, 7, 0.7735],
      [300, 10, 1.0546],
      [160, 18, 1.4063],
      [30, 25, 1.5469],
      [95, 15, 1.2656],
    ],
    terms: [
      [0.03906, 9, 0.2],
      [0.01563, 19, 5.6],
    ],
    slope: 0.25,
  },
];

/** Height of the eye above the ground at the viewer's feet, km. */
export const FLOOR_DEPTH = 0.002;

/** Below this elevation (radians) the view meets the ground at the viewer's feet. */
export const FLOOR_ELEVATION = -0.35;

/** Angular band below a ridge line over which hilltops round off toward the sky, radians. */
export const RIM_ANGLE = 0.012;

/** Observer altitudes (km) over which the hills fade out as the view lifts off the ground. */
export const HILL_FADE_START = 0.6;
export const HILL_FADE_END = 2.5;

/** Azimuth (degrees) of the notch in the horizon where the default sun sets. */
export const HORIZON_DIP_AZIMUTH = 255;

export function ridgeHeight(layer: RidgeLayer, azimuthRad: number): number {
  const azDeg = (azimuthRad * 180) / Math.PI;
  let h = layer.base;
  for (const [c, w, a] of layer.bumps) {
    const d = ((((azDeg - c + 540) % 360) + 360) % 360) - 180; // wrapped difference, degrees
    h += a * Math.exp(-0.5 * (d / w) * (d / w));
  }
  for (const [a, f, p] of layer.terms) h += a * (0.5 + 0.5 * Math.sin(f * azimuthRad + p));
  return h;
}

/** Elevation angle (radians) of a ridge seen from altitude `altitude` (km) on a planet of radius R. */
export function ridgeElevation(
  layer: RidgeLayer,
  azimuthRad: number,
  altitude: number,
  R: number,
): number {
  const drop = (layer.distance * layer.distance) / (2 * R);
  return Math.atan2(ridgeHeight(layer, azimuthRad) - altitude - drop, layer.distance);
}

/** 1 near the ground, fading to 0 between HILL_FADE_START and HILL_FADE_END. */
export function hillWeight(altitude: number): number {
  const t = Math.min(
    1,
    Math.max(0, (altitude - HILL_FADE_START) / (HILL_FADE_END - HILL_FADE_START)),
  );
  return 1 - t * t * (3 - 2 * t);
}
