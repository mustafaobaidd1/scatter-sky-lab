/**
 * Aerosol optics: Ångström-law extinction, spectral single-scattering albedo and asymmetry, and
 * the Cornette–Shanks phase function.
 */

export type AerosolPresetId = 'clean' | 'urban' | 'dust' | 'smoke' | 'volcanic';

export type LayerProfile =
  | { kind: 'exponential'; scaleHeight: number } // km
  | { kind: 'gaussian'; centre: number; width: number }; // km (width = standard deviation)

export interface AerosolLayer {
  /** Optical depth of the whole layer at 550 nm. */
  tau550: number;
  /** Ångström exponent α: τ(λ) = τ550 · (λ / 550 nm)^−α. */
  angstrom: number;
  /** Single-scattering albedo at 440 and 670 nm (linear in λ between, extrapolated, clamped). */
  ssa440: number;
  ssa670: number;
  /** Asymmetry parameter ⟨cos θ⟩ at 440 and 670 nm. */
  g440: number;
  g670: number;
  profile: LayerProfile;
}

export interface AerosolPreset {
  id: AerosolPresetId;
  label: string;
  /** One-line description shown in the UI. */
  blurb: string;
  troposphere: AerosolLayer;
  stratosphere: AerosolLayer | null;
}

/**
 * Representative presets. Optical properties (α, ω, g) are rounded from the AERONET climatology of
 * Dubovik et al. (2002), J. Atmos. Sci. 59, 590–608, Table 1; loadings are typical of each
 * situation, not measurements of a particular day. The volcanic layer follows the post-Pinatubo
 * stratosphere (τ ≈ 0.1–0.15, r_eff ≈ 0.5 µm, non-absorbing sulfate; Russell et al. 1996).
 */
const CLEAN_TROPOSPHERE: AerosolLayer = {
  tau550: 0.06,
  angstrom: 1.2,
  ssa440: 0.97,
  ssa670: 0.96,
  g440: 0.7,
  g670: 0.63,
  profile: { kind: 'exponential', scaleHeight: 1.2 },
};

export const AEROSOL_PRESETS: Record<AerosolPresetId, AerosolPreset> = {
  clean: {
    id: 'clean',
    label: 'Clean air',
    blurb: 'Background continental aerosol, τ₅₅₀ = 0.06.',
    troposphere: CLEAN_TROPOSPHERE,
    stratosphere: null,
  },
  urban: {
    id: 'urban',
    label: 'Urban haze',
    blurb: 'Fine, slightly absorbing pollution (AERONET urban–industrial), τ₅₅₀ = 0.35.',
    troposphere: {
      tau550: 0.35,
      angstrom: 1.6,
      ssa440: 0.93,
      ssa670: 0.91,
      g440: 0.68,
      g670: 0.61,
      profile: { kind: 'exponential', scaleHeight: 1.5 },
    },
    stratosphere: null,
  },
  dust: {
    id: 'dust',
    label: 'Desert dust',
    blurb: 'Coarse mineral dust that absorbs blue (Cape Verde, Bahrain), τ₅₅₀ = 0.6.',
    troposphere: {
      tau550: 0.6,
      angstrom: 0.2,
      ssa440: 0.93,
      ssa670: 0.98,
      g440: 0.73,
      g670: 0.71,
      profile: { kind: 'exponential', scaleHeight: 3 },
    },
    stratosphere: null,
  },
  smoke: {
    id: 'smoke',
    label: 'Wildfire smoke',
    blurb: 'Dense fine smoke lofted to a few km (boreal forest fires), τ₅₅₀ = 1.2.',
    troposphere: {
      tau550: 1.2,
      angstrom: 1.9,
      ssa440: 0.94,
      ssa670: 0.935,
      g440: 0.69,
      g670: 0.61,
      profile: { kind: 'exponential', scaleHeight: 3 },
    },
    stratosphere: null,
  },
  volcanic: {
    id: 'volcanic',
    label: 'Volcanic sulfate',
    blurb:
      'Clean lower air plus a stratospheric sulfate veil at 20 km (post-Pinatubo), τ₅₅₀ = 0.15.',
    troposphere: CLEAN_TROPOSPHERE,
    stratosphere: {
      tau550: 0.15,
      angstrom: 1.0,
      ssa440: 1.0,
      ssa670: 1.0,
      g440: 0.72,
      g670: 0.66,
      profile: { kind: 'gaussian', centre: 20, width: 2.5 },
    },
  },
};

/** Linear interpolation in λ between the 440 and 670 nm values, clamped to [lo, hi]. */
export function spectralParam(
  v440: number,
  v670: number,
  lambdaNm: number,
  lo: number,
  hi: number,
): number {
  const t = (lambdaNm - 440) / (670 - 440);
  return Math.min(hi, Math.max(lo, v440 + (v670 - v440) * t));
}

/** Relative density of a layer profile at altitude h (km); 1 at the reference height. */
export function profileDensity(profile: LayerProfile, h: number): number {
  if (profile.kind === 'exponential') return Math.exp(-Math.max(h, 0) / profile.scaleHeight);
  const z = (h - profile.centre) / profile.width;
  return Math.exp(-0.5 * z * z);
}

/** Column integral of the relative density from the ground to infinity, km. */
export function profileColumn(profile: LayerProfile): number {
  if (profile.kind === 'exponential') return profile.scaleHeight;
  // Gaussian layers sit well above the ground (centre ≥ 4σ), so the full integral applies.
  return profile.width * Math.sqrt(2 * Math.PI);
}

/** Henyey–Greenstein phase function, normalised to 1 over the sphere. */
export function henyeyGreenstein(mu: number, g: number): number {
  const d = 1 + g * g - 2 * g * mu;
  return (1 - g * g) / (4 * Math.PI * d * Math.sqrt(d));
}

/**
 * Cornette & Shanks (1992) phase function, normalised to 1 over the sphere:
 *   P(μ) = 3/(8π) · (1 − g²)(1 + μ²) / ((2 + g²)(1 + g² − 2gμ)^{3/2}).
 * Its parameter g is not the asymmetry parameter; see csParamFromAsymmetry.
 */
export function cornetteShanks(mu: number, g: number): number {
  const d = 1 + g * g - 2 * g * mu;
  return ((3 / (8 * Math.PI)) * (1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * d * Math.sqrt(d));
}

/** Asymmetry ⟨cos θ⟩ of the Cornette–Shanks function with parameter g: 3g(4 + g²) / (5(2 + g²)). */
export function csAsymmetry(g: number): number {
  return (3 * g * (4 + g * g)) / (5 * (2 + g * g));
}

/** Inverts csAsymmetry by bisection, so presets can be specified by their measured ⟨cos θ⟩. */
export function csParamFromAsymmetry(asym: number): number {
  const target = Math.min(0.99, Math.max(0, asym));
  let lo = 0;
  let hi = 0.9999;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (csAsymmetry(mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
