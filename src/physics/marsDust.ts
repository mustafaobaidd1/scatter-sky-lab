/**
 * Optical properties of Martian dust from Mie theory over a lognormal size distribution.
 *
 * Refractive indices: Wolff et al. (2009), "Wavelength dependence of dust aerosol single scattering
 * albedo as observed by the Compact Reconnaissance Imaging Spectrometer", JGR 114, E00D04 —
 * visible values as tabulated in the open data of Ranjan, Wordsworth & Sasselov (2017,
 * github.com/sukritranjan/ranjanwordsworthsasselov2016). Size distribution: effective radius
 * 1.5 µm, effective variance 0.3 (Wolff et al. 2006, 2009; Lemmon et al. 2004).
 *
 * Mie theory treats the grains as spheres. Real dust is irregular; the forward diffraction peak,
 * which produces the blue aureole, depends mostly on projected size and is well represented.
 */
import { mieSphere } from './mie';

/** λ (µm), n, k from Wolff et al. (2009). */
export const WOLFF_2009_INDEX: readonly [number, number, number][] = [
  [0.263, 1.48777, 0.0133],
  [0.321, 1.49413, 0.0127],
  [0.44, 1.49915, 0.00767169],
  [0.46, 1.49948, 0.00714722],
  [0.5, 1.5, 0.00548876],
  [0.6, 1.49905, 0.00168097],
  [0.63, 1.49813, 0.00125609],
  [0.7, 1.4967, 0.000936538],
  [0.8, 1.49532, 0.00106115],
];

/** Refractive index at λ (nm): n linear, k log-linear between tabulated wavelengths. */
export function dustIndex(lambdaNm: number): { n: number; k: number } {
  const um = lambdaNm / 1000;
  const t = WOLFF_2009_INDEX;
  if (um <= t[0][0]) return { n: t[0][1], k: t[0][2] };
  if (um >= t[t.length - 1][0]) return { n: t[t.length - 1][1], k: t[t.length - 1][2] };
  let i = 0;
  while (t[i + 1][0] < um) i++;
  const f = (um - t[i][0]) / (t[i + 1][0] - t[i][0]);
  return {
    n: t[i][1] + f * (t[i + 1][1] - t[i][1]),
    k: Math.exp(Math.log(t[i][2]) + f * (Math.log(t[i + 1][2]) - Math.log(t[i][2]))),
  };
}

export const DUST_EFFECTIVE_RADIUS = 1.5; // µm
export const DUST_EFFECTIVE_VARIANCE = 0.3;

/** Number of scattering angles in the phase table; θ_j = π (j / (N − 1))². */
export const PHASE_ANGLES = 181;

export function phaseAngle(j: number): number {
  const u = j / (PHASE_ANGLES - 1);
  return Math.PI * u * u;
}

/** Table coordinate u ∈ [0, 1] of scattering angle θ (inverse of phaseAngle). */
export function phaseCoord(theta: number): number {
  return Math.sqrt(Math.min(Math.PI, Math.max(0, theta)) / Math.PI);
}

export interface DustOptics {
  /** Wavelengths (nm). */
  lambdas: Float64Array;
  /** Area-weighted mean extinction efficiency ⟨Q_ext⟩ at each λ. */
  qext: Float64Array;
  /** Single-scattering albedo. */
  ssa: Float64Array;
  /** Asymmetry parameter. */
  g: Float64Array;
  /** Phase function, normalised to 1 over 4π sr: phase[i * PHASE_ANGLES + j] at λ_i, θ_j. */
  phase: Float64Array;
}

export interface DustOpticsOptions {
  radii?: number;
  effectiveRadius?: number;
  effectiveVariance?: number;
  onProgress?: (fraction: number) => void;
}

/**
 * Computes dust optics on a wavelength grid by integrating Mie results over a lognormal number
 * distribution n(ln r) ∝ exp(−(ln r − ln r_g)² / 2σ²), with σ² = ln(1 + v_eff) and
 * r_g = r_eff / (1 + v_eff)^{5/2}. Radii are log-spaced from r_g·e^{−3.5σ} to r_g·e^{+5σ} (the
 * upper tail matters for cross-section weighting).
 */
export function computeDustOptics(
  lambdas: ArrayLike<number>,
  options: DustOpticsOptions = {},
): DustOptics {
  const nr = options.radii ?? 72;
  const reff = options.effectiveRadius ?? DUST_EFFECTIVE_RADIUS;
  const veff = options.effectiveVariance ?? DUST_EFFECTIVE_VARIANCE;
  const sigma = Math.sqrt(Math.log(1 + veff));
  const rg = reff / Math.pow(1 + veff, 2.5);
  const lnMin = Math.log(rg) - 3.5 * sigma;
  const lnMax = Math.log(rg) + 5 * sigma;
  const dln = (lnMax - lnMin) / (nr - 1);

  const mus = new Float64Array(PHASE_ANGLES);
  for (let j = 0; j < PHASE_ANGLES; j++) mus[j] = Math.cos(phaseAngle(j));

  const nl = lambdas.length;
  const out: DustOptics = {
    lambdas: Float64Array.from(lambdas),
    qext: new Float64Array(nl),
    ssa: new Float64Array(nl),
    g: new Float64Array(nl),
    phase: new Float64Array(nl * PHASE_ANGLES),
  };

  for (let i = 0; i < nl; i++) {
    const lambdaUm = lambdas[i] / 1000;
    const { n, k } = dustIndex(lambdas[i]);
    let area = 0; // Σ w π r²
    let cext = 0;
    let csca = 0;
    let gsca = 0;
    const acc = new Float64Array(PHASE_ANGLES);
    for (let j = 0; j < nr; j++) {
      const lnr = lnMin + j * dln;
      const r = Math.exp(lnr);
      const z = (lnr - Math.log(rg)) / sigma;
      const trap = j === 0 || j === nr - 1 ? 0.5 : 1;
      const w = trap * Math.exp(-0.5 * z * z) * dln; // number weight per ln r (unnormalised)
      const x = (2 * Math.PI * r) / lambdaUm;
      const res = mieSphere(x, n, k, mus);
      const geo = Math.PI * r * r;
      area += w * geo;
      cext += w * geo * res.qext;
      csca += w * geo * res.qsca;
      gsca += w * geo * res.qsca * res.g;
      // Intensity per particle is |S|²/k²; k² = (2π/λ)², so weight by λ² (constant per λ).
      for (let a = 0; a < PHASE_ANGLES; a++) acc[a] += w * res.intensity[a];
    }
    const k2 = Math.pow((2 * Math.PI) / lambdaUm, 2);
    out.qext[i] = cext / area;
    out.ssa[i] = csca / cext;
    out.g[i] = gsca / csca;
    for (let a = 0; a < PHASE_ANGLES; a++) out.phase[i * PHASE_ANGLES + a] = acc[a] / (k2 * csca);
    options.onProgress?.((i + 1) / nl);
  }
  return out;
}

/** Phase function at scattering-angle cosine μ for wavelength index i (linear in table coord). */
export function dustPhase(optics: DustOptics, i: number, mu: number): number {
  const u = phaseCoord(Math.acos(Math.min(1, Math.max(-1, mu))));
  const x = u * (PHASE_ANGLES - 1);
  const j = Math.min(PHASE_ANGLES - 2, Math.floor(x));
  const t = x - j;
  const base = i * PHASE_ANGLES;
  return optics.phase[base + j] * (1 - t) + optics.phase[base + j + 1] * t;
}

/** Linear interpolation of dust optics onto another wavelength grid. */
export function resampleDustOptics(src: DustOptics, lambdas: ArrayLike<number>): DustOptics {
  const nl = lambdas.length;
  const out: DustOptics = {
    lambdas: Float64Array.from(lambdas),
    qext: new Float64Array(nl),
    ssa: new Float64Array(nl),
    g: new Float64Array(nl),
    phase: new Float64Array(nl * PHASE_ANGLES),
  };
  const sl = src.lambdas;
  for (let i = 0; i < nl; i++) {
    const l = lambdas[i];
    let j = 0;
    while (j < sl.length - 2 && sl[j + 1] < l) j++;
    const t = Math.min(1, Math.max(0, (l - sl[j]) / (sl[j + 1] - sl[j])));
    out.qext[i] = src.qext[j] * (1 - t) + src.qext[j + 1] * t;
    out.ssa[i] = src.ssa[j] * (1 - t) + src.ssa[j + 1] * t;
    out.g[i] = src.g[j] * (1 - t) + src.g[j + 1] * t;
    for (let a = 0; a < PHASE_ANGLES; a++) {
      out.phase[i * PHASE_ANGLES + a] =
        src.phase[j * PHASE_ANGLES + a] * (1 - t) + src.phase[(j + 1) * PHASE_ANGLES + a] * t;
    }
  }
  return out;
}
