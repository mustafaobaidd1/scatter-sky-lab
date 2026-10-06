import { CIE_X_5NM, CIE_Y_5NM, CIE_Z_5NM } from './data/cie';
import { LUMINOUS_EFFICACY } from './constants';
import { basisIntegrals, sampleTable } from './spectral';

export type Vec3 = [number, number, number];

/** CIE 1931 2° integration weights for a sample grid: XYZ = Σ_i W_i · S(λ_i). */
export interface CmfWeights {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}

export function cmfWeights(grid: ArrayLike<number>): CmfWeights {
  return {
    x: basisIntegrals(CIE_X_5NM, grid),
    y: basisIntegrals(CIE_Y_5NM, grid),
    z: basisIntegrals(CIE_Z_5NM, grid),
  };
}

/** ∫ S(λ) cmf(λ) dλ for a sampled spectrum. Units: (units of S) × nm. */
export function spectrumToXyz(values: ArrayLike<number>, w: CmfWeights): Vec3 {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let i = 0; i < values.length; i++) {
    const s = values[i];
    X += w.x[i] * s;
    Y += w.y[i] * s;
    Z += w.z[i] * s;
  }
  return [X, Y, Z];
}

/**
 * Photometric XYZ in cd/m² for a spectral radiance sampled in W m^-2 sr^-1 nm^-1
 * (Y is then the luminance).
 */
export function radianceToXyz(values: ArrayLike<number>, w: CmfWeights): Vec3 {
  const [X, Y, Z] = spectrumToXyz(values, w);
  return [X * LUMINOUS_EFFICACY, Y * LUMINOUS_EFFICACY, Z * LUMINOUS_EFFICACY];
}

type Mat3 = [number, number, number, number, number, number, number, number, number];

function mul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0) throw new Error('singular matrix');
  const s = 1 / det;
  return [
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ];
}

/** Builds the RGB→XYZ matrix of an RGB space from its primaries and white chromaticities. */
export function rgbToXyzMatrix(
  r: [number, number],
  g: [number, number],
  b: [number, number],
  white: [number, number],
): Mat3 {
  const col = (p: [number, number]): Vec3 => [p[0] / p[1], 1, (1 - p[0] - p[1]) / p[1]];
  const R = col(r);
  const G = col(g);
  const B = col(b);
  const P: Mat3 = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
  const W = col(white);
  const S = mul(invert(P), W);
  return [
    P[0] * S[0],
    P[1] * S[1],
    P[2] * S[2],
    P[3] * S[0],
    P[4] * S[1],
    P[5] * S[2],
    P[6] * S[0],
    P[7] * S[1],
    P[8] * S[2],
  ];
}

/** sRGB / Rec. 709 primaries and the D65 white point (IEC 61966-2-1). */
export const D65_WHITE: [number, number] = [0.3127, 0.329];
export const LINEAR_SRGB_TO_XYZ = rgbToXyzMatrix([0.64, 0.33], [0.3, 0.6], [0.15, 0.06], D65_WHITE);
export const XYZ_TO_LINEAR_SRGB = invert(LINEAR_SRGB_TO_XYZ);

export function xyzToLinearSrgb(xyz: Vec3): Vec3 {
  return mul(XYZ_TO_LINEAR_SRGB, xyz);
}

export function linearSrgbToXyz(rgb: Vec3): Vec3 {
  return mul(LINEAR_SRGB_TO_XYZ, rgb);
}

/** sRGB opto-electronic transfer function (linear → encoded), input clamped to [0, 1]. */
export function srgbEncode(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function chromaticity(xyz: Vec3): [number, number] {
  const s = xyz[0] + xyz[1] + xyz[2];
  if (!(s > 0)) return [D65_WHITE[0], D65_WHITE[1]];
  return [xyz[0] / s, xyz[1] / s];
}

/** CIELAB relative to a white with the given XYZ (Y of the white normalises lightness). */
export function xyzToLab(xyz: Vec3, white: Vec3): Vec3 {
  const d = 6 / 29;
  const f = (t: number) => (t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29);
  const fx = f(xyz[0] / white[0]);
  const fy = f(xyz[1] / white[1]);
  const fz = f(xyz[2] / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Chroma and hue angle (degrees, 0–360) of a CIELAB colour. */
export function labToLch(lab: Vec3): { L: number; C: number; h: number } {
  const C = Math.hypot(lab[1], lab[2]);
  let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L: lab[0], C, h };
}

/** XYZ of the D65 white point with Y = 1. */
export const D65_XYZ: Vec3 = [
  D65_WHITE[0] / D65_WHITE[1],
  1,
  (1 - D65_WHITE[0] - D65_WHITE[1]) / D65_WHITE[1],
];

/** Chromaticity of monochromatic light at λ (nm), from the 5 nm CMF table. */
export function spectralChromaticity(lambda: number): [number, number] {
  const X = sampleTable(CIE_X_5NM, lambda);
  const Y = sampleTable(CIE_Y_5NM, lambda);
  const Z = sampleTable(CIE_Z_5NM, lambda);
  const s = X + Y + Z;
  return [X / s, Y / s];
}

let locus: { lambda: number; x: number; y: number }[] | null = null;

/** Spectral locus sampled every 1 nm from 380 to 700 nm. */
function spectralLocus() {
  if (!locus) {
    locus = [];
    for (let l = 380; l <= 700; l++) {
      const [x, y] = spectralChromaticity(l);
      locus.push({ lambda: l, x, y });
    }
  }
  return locus;
}

export interface DominantWavelength {
  /** Dominant wavelength in nm, or the complementary wavelength for purples. */
  wavelength: number;
  /** True if the colour lies toward the purple line and `wavelength` is complementary. */
  complementary: boolean;
  /** Excitation purity, 0 (white) to 1 (spectral). */
  purity: number;
}

/**
 * Dominant wavelength and excitation purity of a chromaticity relative to a white point
 * (CIE 15 definition: intersect the line from white through the colour with the spectral locus).
 */
export function dominantWavelength(
  xy: [number, number],
  white: [number, number] = D65_WHITE,
): DominantWavelength | null {
  const dx = xy[0] - white[0];
  const dy = xy[1] - white[1];
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return null;
  const pts = spectralLocus();
  const hit = (sx: number, sy: number) => {
    // Ray W + t·(sx, sy), t > 0, against each locus segment.
    let best: { t: number; lambda: number } | null = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = sx * ey - sy * ex;
      if (Math.abs(den) < 1e-14) continue;
      const wx = a.x - white[0];
      const wy = a.y - white[1];
      const t = (wx * ey - wy * ex) / den;
      const u = (wx * sy - wy * sx) / den;
      if (t > 0 && u >= 0 && u <= 1 && (!best || t < best.t)) {
        best = { t, lambda: a.lambda + u * (b.lambda - a.lambda) };
      }
    }
    return best;
  };
  const forward = hit(dx / dist, dy / dist);
  if (forward) {
    return {
      wavelength: forward.lambda,
      complementary: false,
      purity: Math.min(1, dist / forward.t),
    };
  }
  // Toward the purple line: purity is measured to the purple line, wavelength is complementary.
  const back = hit(-dx / dist, -dy / dist);
  const a = pts[0];
  const b = pts[pts.length - 1];
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const den = (dx / dist) * ey - (dy / dist) * ex;
  const tPurple =
    Math.abs(den) > 1e-14 ? ((a.x - white[0]) * ey - (a.y - white[1]) * ex) / den : dist;
  return {
    wavelength: back ? back.lambda : NaN,
    complementary: true,
    purity: Math.min(1, dist / Math.max(tPurple, dist)),
  };
}

/**
 * A displayable sRGB colour (0–1, encoded) for monochromatic light at λ, used to paint spectral
 * gradients in charts: the chromaticity is desaturated toward white just enough to fit the gamut
 * and the brightest channel is set to 1. It is a hue cue, not a colorimetric match.
 */
export function spectralSwatch(lambda: number): Vec3 {
  const [x, y] = spectralChromaticity(lambda);
  const xyz: Vec3 = [x / y, 1, (1 - x - y) / y];
  const rgb = xyzToLinearSrgb(xyz);
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  const lifted: Vec3 = min < 0 ? [rgb[0] - min, rgb[1] - min, rgb[2] - min] : rgb;
  const max = Math.max(lifted[0], lifted[1], lifted[2]);
  return [srgbEncode(lifted[0] / max), srgbEncode(lifted[1] / max), srgbEncode(lifted[2] / max)];
}

export function toHex(rgb: Vec3): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}
