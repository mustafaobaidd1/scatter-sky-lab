import type { Vec3 } from './colour';
import { srgbEncode } from './colour';

/*
 * Display transforms. Input: scene-referred linear sRGB already multiplied by the exposure.
 * Output: display-referred linear sRGB in [0, 1]. The GLSL composite uses identical constants.
 *
 * 'filmic' — AgX, ported from three.js (MIT, © three.js authors; after Filament, Apache-2.0, and
 *   Troy Sobotka's AgX), with the polynomial sigmoid and the ASC-CDL look step of Benjamin
 *   Wrensch's minimal AgX (MIT, iolite-engine.com). The look is tuned for skies (power 1.15,
 *   saturation 1.7; Wrensch's "Punchy" preset is 1.35 and 1.4): base AgX greys mid-tone blues,
 *   and this keeps a noon sky blue and the Martian aureole visibly blue. Log-space sigmoid with a
 *   toe and a shoulder; very bright colours roll off toward white like film.
 * 'neutral' — Khronos PBR Neutral (Apache-2.0): leaves colours below 0.76 untouched, so mid-tone
 *   chromaticities are reproduced exactly, and compresses highlights toward white.
 */
export type ToneMap = 'filmic' | 'neutral';

// Matrices written column by column, exactly as GLSL `mat3(col0, col1, col2)`.
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
export const AGX_LOOK_POWER = 1.15;
export const AGX_LOOK_SATURATION = 1.7;

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

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function agx(rgb: Vec3): Vec3 {
  let c = mulCols(AGX_INSET, mulCols(SRGB_TO_REC2020, rgb));
  const enc = (v: number) =>
    contrast(clamp01((Math.log2(Math.max(v, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)));
  c = [enc(c[0]), enc(c[1]), enc(c[2])];
  // Look (ASC CDL): power, then saturation around Rec. 709 luma.
  c = [
    Math.pow(Math.max(0, c[0]), AGX_LOOK_POWER),
    Math.pow(Math.max(0, c[1]), AGX_LOOK_POWER),
    Math.pow(Math.max(0, c[2]), AGX_LOOK_POWER),
  ];
  const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  c = [
    luma + AGX_LOOK_SATURATION * (c[0] - luma),
    luma + AGX_LOOK_SATURATION * (c[1] - luma),
    luma + AGX_LOOK_SATURATION * (c[2] - luma),
  ];
  c = mulCols(AGX_OUTSET, c);
  c = [
    Math.pow(Math.max(0, c[0]), 2.2),
    Math.pow(Math.max(0, c[1]), 2.2),
    Math.pow(Math.max(0, c[2]), 2.2),
  ];
  c = mulCols(REC2020_TO_SRGB, c);
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

export function neutral(rgb: Vec3): Vec3 {
  const start = 0.8 - 0.04;
  const desaturation = 0.15;
  const x = Math.min(rgb[0], rgb[1], rgb[2]);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  let c: Vec3 = [rgb[0] - offset, rgb[1] - offset, rgb[2] - offset];
  const peak = Math.max(c[0], c[1], c[2]);
  if (peak < start) return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
  const d = 1 - start;
  const newPeak = 1 - (d * d) / (peak + d - start);
  c = [(c[0] * newPeak) / peak, (c[1] * newPeak) / peak, (c[2] * newPeak) / peak];
  const g = 1 - 1 / (desaturation * (peak - newPeak) + 1);
  return [
    clamp01(c[0] * (1 - g) + newPeak * g),
    clamp01(c[1] * (1 - g) + newPeak * g),
    clamp01(c[2] * (1 - g) + newPeak * g),
  ];
}

export function toneMap(rgb: Vec3, kind: ToneMap): Vec3 {
  return kind === 'neutral' ? neutral(rgb) : agx(rgb);
}

/** Linear sRGB (scene units, e.g. cd/m²) → encoded display sRGB after exposure and tone mapping. */
export function displayColour(linearRgb: Vec3, exposure: number, kind: ToneMap = 'filmic'): Vec3 {
  const t = toneMap(
    [linearRgb[0] * exposure, linearRgb[1] * exposure, linearRgb[2] * exposure],
    kind,
  );
  return [srgbEncode(t[0]), srgbEncode(t[1]), srgbEncode(t[2])];
}
