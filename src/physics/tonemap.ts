import type { Vec3 } from './colour';
import { srgbEncode } from './colour';

/*
 * AgX filmic tone mapping, ported from three.js (MIT, © three.js authors), whose implementation
 * follows Filament (Apache-2.0) and Blender's AgX, with the polynomial fit of the AgX base contrast
 * curve by Benjamin Wrensch (iolite-engine.com/blog_posts/minimal_agx_implementation).
 * The same constants are used in the GLSL composite shader so CPU and GPU images agree.
 *
 * Input: scene-referred linear sRGB already multiplied by the exposure.
 * Output: display-referred linear sRGB in [0, 1].
 */

// Matrices are written column by column exactly as in the GLSL `mat3(col0, col1, col2)`.
const SRGB_TO_REC2020 = [0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.088, 0.0433, 0.0113, 0.8956];
const REC2020_TO_SRGB = [
  1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187,
];
const AGX_INSET = [
  0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591,
  0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859,
];
const AGX_OUTSET = [
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323,
  1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257,
  1.2519364065950405,
];
export const AGX_MIN_EV = -12.47393;
export const AGX_MAX_EV = 4.026069;

function mulCols(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

function contrast(x: number): number {
  const x2 = x * x;
  const x4 = x2 * x2;
  return (
    15.5 * x4 * x2 -
    40.14 * x4 * x +
    31.96 * x4 -
    6.868 * x2 * x +
    0.4298 * x2 +
    0.1191 * x -
    0.00232
  );
}

export function agx(rgb: Vec3): Vec3 {
  let c = mulCols(SRGB_TO_REC2020, rgb);
  c = mulCols(AGX_INSET, c);
  const enc = (v: number) => {
    const l = Math.log2(Math.max(v, 1e-10));
    const n = Math.min(1, Math.max(0, (l - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)));
    return contrast(n);
  };
  c = [enc(c[0]), enc(c[1]), enc(c[2])];
  c = mulCols(AGX_OUTSET, c);
  c = [
    Math.pow(Math.max(0, c[0]), 2.2),
    Math.pow(Math.max(0, c[1]), 2.2),
    Math.pow(Math.max(0, c[2]), 2.2),
  ];
  c = mulCols(REC2020_TO_SRGB, c);
  return [
    Math.min(1, Math.max(0, c[0])),
    Math.min(1, Math.max(0, c[1])),
    Math.min(1, Math.max(0, c[2])),
  ];
}

/** Linear sRGB (scene units, e.g. cd/m²) → encoded display sRGB after exposure and AgX. */
export function displayColour(linearRgb: Vec3, exposure: number): Vec3 {
  const t = agx([linearRgb[0] * exposure, linearRgb[1] * exposure, linearRgb[2] * exposure]);
  return [srgbEncode(t[0]), srgbEncode(t[1]), srgbEncode(t[2])];
}
