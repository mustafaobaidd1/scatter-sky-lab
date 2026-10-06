/**
 * Precomputed optical-length table ("transmittance LUT").
 *
 * Bruneton (2017) and Hillaire (2020) precompute transmittance to the top of the atmosphere as a
 * function of (r, μ). Because every constituent here has a fixed vertical profile, the
 * wavelength-independent part of that integral — the column of each constituent along the ray —
 * can be stored instead (4 channels: molecules, aerosol A, aerosol B, ozone, in km of
 * relative-density path). Transmittance at any wavelength is then
 *   T(λ) = exp(−[β_R(λ) D_R + β_A(λ) D_A + β_B(λ) D_B + β_O3(λ) D_O3]),
 * so the spectral experiments (λ^−p, aerosol load, ozone on/off) never need a rebuild.
 * The texture parametrisation is Bruneton's (2017), so rays near the horizon get most texels.
 */
import { profileDensity } from './aerosol';
import {
  OZONE_CENTRE,
  OZONE_HALF_WIDTH,
  ozoneDensity,
  type SpectralAtmosphere,
} from './atmosphere';

export const LUT_WIDTH = 256; // μ
export const LUT_HEIGHT = 128; // r (64 rows leave ~1.7 km between rows at 30 km: too coarse for the 20 km sulfate layer)

export interface ColumnLut {
  width: number;
  height: number;
  bottomRadius: number;
  topRadius: number;
  /** RGBA float data, row-major from r = bottom (row 0) to r = top, μ from zenith (col 0). */
  data: Float32Array;
}

/** Relative densities of the four constituents at altitude h (km). */
export function densities(atm: SpectralAtmosphere, h: number, out: Float64Array): Float64Array {
  out[0] = Math.exp(-Math.max(h, 0) / atm.molScaleHeight);
  out[1] = profileDensity(atm.profileA, h);
  out[2] = atm.profileB ? profileDensity(atm.profileB, h) : 0;
  out[3] = ozoneDensity(h);
  return out;
}

/** Distance from radius r along zenith cosine μ to the top-of-atmosphere sphere. */
export function distanceToTop(r: number, mu: number, top: number): number {
  const disc = r * r * (mu * mu - 1) + top * top;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
}

/**
 * Columns along a ray from radius r with zenith cosine μ up to distance d, integrated with the
 * midpoint rule on a grid that is quadratic away from the ray's lowest point (where the density
 * is highest). `steps` samples in total.
 */
export function integrateColumns(
  atm: SpectralAtmosphere,
  r: number,
  mu: number,
  d: number,
  steps: number,
  out: Float64Array,
): Float64Array {
  out[0] = out[1] = out[2] = out[3] = 0;
  if (d <= 0) return out;
  const R = atm.bottomRadius;
  // Profile parameters hoisted out of the loop (this runs ~3 million times per table).
  const invHm = 1 / atm.molScaleHeight;
  const pA = atm.profileA;
  const aExp = pA.kind === 'exponential';
  const aInv = aExp ? 1 / pA.scaleHeight : 1 / pA.width;
  const aCentre = aExp ? 0 : pA.centre;
  const pB = atm.profileB;
  const hasB = pB !== null;
  const bExp = hasB && pB.kind === 'exponential';
  const bInv = !hasB ? 0 : pB.kind === 'exponential' ? 1 / pB.scaleHeight : 1 / pB.width;
  const bCentre = hasB && pB.kind === 'gaussian' ? pB.centre : 0;
  const q0 = r * r - R * R;
  const tLow = Math.min(d, Math.max(0, -r * mu));
  const lenA = tLow;
  const lenB = d - tLow;
  const nA = lenA > 0 ? Math.max(2, Math.round((steps * lenA) / d)) : 0;
  const nB = Math.max(2, steps - nA);
  let c0 = 0;
  let c1 = 0;
  let c2 = 0;
  let c3 = 0;
  for (let seg = 0; seg < 2; seg++) {
    const count = seg === 0 ? nA : nB;
    const len = seg === 0 ? lenA : lenB;
    const sign = seg === 0 ? -1 : 1;
    for (let k = 0; k < count; k++) {
      const u = (k + 0.5) / count;
      const t = tLow + sign * len * u * u;
      const dt = (len * 2 * u) / count;
      const q = Math.max(0, q0 + t * t + 2 * r * mu * t);
      const h = q / (Math.sqrt(R * R + q) + R);
      c0 += Math.exp(-h * invHm) * dt;
      if (aExp) c1 += Math.exp(-h * aInv) * dt;
      else {
        const z = (h - aCentre) * aInv;
        c1 += Math.exp(-0.5 * z * z) * dt;
      }
      if (hasB) {
        if (bExp) c2 += Math.exp(-h * bInv) * dt;
        else {
          const z = (h - bCentre) * bInv;
          c2 += Math.exp(-0.5 * z * z) * dt;
        }
      }
      const o = 1 - Math.abs(h - OZONE_CENTRE) / OZONE_HALF_WIDTH;
      if (o > 0) c3 += o * dt;
    }
  }
  out[0] = c0;
  out[1] = c1;
  out[2] = c2;
  out[3] = c3;
  return out;
}

/** Texture coordinates (texel-centre convention) for a ray at radius r, zenith cosine μ. */
export function lutCoords(r: number, mu: number, bottom: number, top: number): [number, number] {
  const H = Math.sqrt(top * top - bottom * bottom);
  const rho = Math.sqrt(Math.max(0, r * r - bottom * bottom));
  const d = distanceToTop(r, mu, top);
  const dMin = top - r;
  const dMax = rho + H;
  const xMu = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0;
  const xR = rho / H;
  return [
    0.5 / LUT_WIDTH + Math.min(1, Math.max(0, xMu)) * (1 - 1 / LUT_WIDTH),
    0.5 / LUT_HEIGHT + Math.min(1, Math.max(0, xR)) * (1 - 1 / LUT_HEIGHT),
  ];
}

export function buildColumnLut(atm: SpectralAtmosphere, steps = 96): ColumnLut {
  const W = LUT_WIDTH;
  const Hh = LUT_HEIGHT;
  const bottom = atm.bottomRadius;
  const top = atm.topRadius;
  const H = Math.sqrt(top * top - bottom * bottom);
  const data = new Float32Array(W * Hh * 4);
  const col = new Float64Array(4);
  for (let j = 0; j < Hh; j++) {
    const rho = (H * j) / (Hh - 1);
    const r = Math.sqrt(rho * rho + bottom * bottom);
    const dMin = top - r;
    const dMax = rho + H;
    for (let i = 0; i < W; i++) {
      const d = dMin + ((dMax - dMin) * i) / (W - 1);
      const mu = d === 0 ? 1 : Math.min(1, Math.max(-1, (H * H - rho * rho - d * d) / (2 * r * d)));
      integrateColumns(atm, r, mu, d, steps, col);
      const o = (j * W + i) * 4;
      data[o] = col[0];
      data[o + 1] = col[1];
      data[o + 2] = col[2];
      data[o + 3] = col[3];
    }
  }
  return { width: W, height: Hh, bottomRadius: bottom, topRadius: top, data };
}

/** Bilinear lookup (GL_LINEAR + CLAMP_TO_EDGE semantics) of the columns to the top. */
export function lookupColumns(
  lut: ColumnLut,
  r: number,
  mu: number,
  out: Float64Array,
): Float64Array {
  const [u, v] = lutCoords(r, mu, lut.bottomRadius, lut.topRadius);
  const W = lut.width;
  const Hh = lut.height;
  const s = Math.min(W - 1, Math.max(0, u * W - 0.5));
  const t = Math.min(Hh - 1, Math.max(0, v * Hh - 0.5));
  const i0 = Math.min(W - 2, Math.floor(s));
  const j0 = Math.min(Hh - 2, Math.floor(t));
  const fs = s - i0;
  const ft = t - j0;
  const d = lut.data;
  for (let c = 0; c < 4; c++) {
    const a = d[(j0 * W + i0) * 4 + c];
    const b = d[(j0 * W + i0 + 1) * 4 + c];
    const e = d[((j0 + 1) * W + i0) * 4 + c];
    const f = d[((j0 + 1) * W + i0 + 1) * 4 + c];
    out[c] = (a * (1 - fs) + b * fs) * (1 - ft) + (e * (1 - fs) + f * fs) * ft;
  }
  return out;
}
