/**
 * Builds the spectral description of an atmosphere on a wavelength grid: per-wavelength
 * scattering/absorption coefficients for four constituents with fixed vertical profiles.
 *
 *   0  molecules (Rayleigh)        exponential, scale height H_R
 *   1  aerosol layer A             exponential (Earth boundary layer, or Mars dust)
 *   2  aerosol layer B             Gaussian layer (Earth stratospheric sulfate), optional
 *   3  ozone (absorption only)     tent: 0 at 10 km, peak at 25 km, 0 at 40 km
 *
 * Lengths are in km and coefficients in km^-1 at relative density 1.
 */
import {
  AEROSOL_PRESETS,
  type AerosolLayer,
  type AerosolPresetId,
  csParamFromAsymmetry,
  type LayerProfile,
  profileColumn,
  spectralParam,
} from './aerosol';
import { DOBSON_UNIT } from './constants';
import { OZONE_CROSS_SECTION_5NM } from './data/ozone';
import { SOLAR_IRRADIANCE_5NM } from './data/solar';
import { type DustOptics, resampleDustOptics } from './marsDust';
import {
  MARS_DUST_SCALE_HEIGHT,
  MARS_DUST_TAU_DEFAULT,
  type Planet,
  PLANETS,
  type PlanetId,
  SUN_ANGULAR_RADIUS_1AU,
} from './planets';
import { RAYLEIGH_GAMMA } from './rayleigh';
import { hatAverage } from './spectral';

export interface AtmosphereConfig {
  planet: PlanetId;
  /** Exponent p of the molecular scattering law λ^−p. 4 is physical; 0 scatters all colours equally. */
  rayleighExponent: number;
  /** Whether ozone absorption is included (Earth). */
  ozone: boolean;
  /** Ozone column in Dobson units when enabled (default: the planet's value). */
  ozoneDU?: number;
  /** Earth aerosol preset. */
  aerosolPreset: AerosolPresetId;
  /** Optional override of the preset's lower-layer optical depth at 550 nm. */
  aerosolTau?: number;
  /** Optional override of the preset's lower-layer Ångström exponent. */
  aerosolAngstrom?: number;
  /** Mars dust optical depth at 550 nm. */
  marsDustTau?: number;
}

export const DEFAULT_CONFIG: AtmosphereConfig = {
  planet: 'earth',
  rayleighExponent: 4,
  ozone: true,
  aerosolPreset: 'clean',
};

export const OZONE_CENTRE = 25; // km
export const OZONE_HALF_WIDTH = 15; // km

export interface SpectralAtmosphere {
  config: AtmosphereConfig;
  planet: Planet;
  lambdas: Float64Array;
  n: number;
  /** Planet radius and top-of-atmosphere radius, km. */
  bottomRadius: number;
  topRadius: number;
  molScaleHeight: number;
  profileA: LayerProfile;
  profileB: LayerProfile | null;
  /** Coefficients at relative density 1, km^-1. */
  molSca: Float64Array;
  aExt: Float64Array;
  aSca: Float64Array;
  /** Cornette–Shanks parameter per λ for layer A (unused when `dust` is set). */
  aPhaseG: Float64Array;
  bExt: Float64Array;
  bSca: Float64Array;
  bPhaseG: Float64Array;
  ozoneAbs: Float64Array;
  /** Top-of-atmosphere solar spectral irradiance at the planet's distance, W m^-2 nm^-1. */
  solar: Float64Array;
  albedo: Float64Array;
  rayleighGamma: number;
  sunAngularRadius: number;
  /** Mars dust optics resampled onto `lambdas` (tabulated Mie phase function), or null. */
  dust: DustOptics | null;
}

function layerArrays(layer: AerosolLayer, lambdas: Float64Array, tau: number, angstrom: number) {
  const n = lambdas.length;
  const ext = new Float64Array(n);
  const sca = new Float64Array(n);
  const g = new Float64Array(n);
  const column = profileColumn(layer.profile);
  for (let i = 0; i < n; i++) {
    const l = lambdas[i];
    ext[i] = (tau / column) * Math.pow(l / 550, -angstrom);
    sca[i] = ext[i] * spectralParam(layer.ssa440, layer.ssa670, l, 0, 1);
    g[i] = csParamFromAsymmetry(spectralParam(layer.g440, layer.g670, l, 0, 0.95));
  }
  return { ext, sca, g };
}

/**
 * @param dustOptics Mars dust Mie optics on any wavelength grid covering `lambdas` and 550 nm
 *   (required when config.planet === 'mars').
 */
export function buildAtmosphere(
  config: AtmosphereConfig,
  lambdas: Float64Array,
  dustOptics: DustOptics | null = null,
): SpectralAtmosphere {
  const planet = PLANETS[config.planet];
  const n = lambdas.length;
  const solar1au = hatAverage(SOLAR_IRRADIANCE_5NM, lambdas);
  const solar = solar1au.map((v) => v / (planet.sunDistanceAu * planet.sunDistanceAu));
  const ozoneSigma = hatAverage(OZONE_CROSS_SECTION_5NM, lambdas);

  // Molecules: β(λ) = N0 σ(λ) with N0 = column / H, then the optional λ^-p reshaping that keeps
  // β(550 nm) fixed and removes the dispersion of n and the King factor as p → 0.
  const H = planet.molecularScaleHeight;
  const N0 = planet.molecularColumn / (H * 1000); // m^-3
  const beta550 = N0 * planet.molecularCrossSection(550) * 1000; // km^-1
  const p = Math.min(4, Math.max(0, config.rayleighExponent));
  const molSca = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const l = lambdas[i];
    const physical = N0 * planet.molecularCrossSection(l) * 1000;
    const residual = physical / (beta550 * Math.pow(550 / l, 4));
    molSca[i] = beta550 * Math.pow(550 / l, p) * Math.pow(residual, p / 4);
  }

  // Ozone (tent profile with column = peak × 15 km).
  const du = config.ozone ? (config.ozoneDU ?? planet.ozoneDU) : 0;
  const ozonePeak = (du * DOBSON_UNIT) / (OZONE_HALF_WIDTH * 1000); // m^-3
  const ozoneAbs = new Float64Array(n);
  for (let i = 0; i < n; i++) ozoneAbs[i] = ozonePeak * ozoneSigma[i] * 1000;

  let profileA: LayerProfile;
  let profileB: LayerProfile | null = null;
  let a: { ext: Float64Array; sca: Float64Array; g: Float64Array };
  let b = { ext: new Float64Array(n), sca: new Float64Array(n), g: new Float64Array(n) };
  let dust: DustOptics | null = null;

  if (config.planet === 'mars') {
    if (!dustOptics) throw new Error('Mars needs dust optics');
    profileA = { kind: 'exponential', scaleHeight: MARS_DUST_SCALE_HEIGHT };
    const tau = config.marsDustTau ?? MARS_DUST_TAU_DEFAULT;
    dust = resampleDustOptics(dustOptics, lambdas);
    const ref = resampleDustOptics(dustOptics, [550]);
    const ext = new Float64Array(n);
    const sca = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ext[i] = (tau / MARS_DUST_SCALE_HEIGHT) * (dust.qext[i] / ref.qext[0]);
      sca[i] = ext[i] * dust.ssa[i];
    }
    a = { ext, sca, g: new Float64Array(n) };
  } else {
    const preset = AEROSOL_PRESETS[config.aerosolPreset];
    profileA = preset.troposphere.profile;
    a = layerArrays(
      preset.troposphere,
      lambdas,
      config.aerosolTau ?? preset.troposphere.tau550,
      config.aerosolAngstrom ?? preset.troposphere.angstrom,
    );
    if (preset.stratosphere) {
      profileB = preset.stratosphere.profile;
      b = layerArrays(
        preset.stratosphere,
        lambdas,
        preset.stratosphere.tau550,
        preset.stratosphere.angstrom,
      );
    }
  }

  const albedo = new Float64Array(n);
  for (let i = 0; i < n; i++) albedo[i] = planet.groundAlbedo(lambdas[i]);

  return {
    config,
    planet,
    lambdas,
    n,
    bottomRadius: planet.radius,
    topRadius: planet.radius + planet.atmosphereHeight,
    molScaleHeight: H,
    profileA,
    profileB,
    molSca,
    aExt: a.ext,
    aSca: a.sca,
    aPhaseG: a.g,
    bExt: b.ext,
    bSca: b.sca,
    bPhaseG: b.g,
    ozoneAbs,
    solar,
    albedo,
    rayleighGamma: RAYLEIGH_GAMMA,
    sunAngularRadius: SUN_ANGULAR_RADIUS_1AU / planet.sunDistanceAu,
    dust,
  };
}

/** Ozone tent profile: relative density 1 at 25 km, 0 below 10 km and above 40 km. */
export function ozoneDensity(h: number): number {
  return Math.max(0, 1 - Math.abs(h - OZONE_CENTRE) / OZONE_HALF_WIDTH);
}

/** Vertical optical depths per constituent at index i (for validation and the UI). */
export function verticalOpticalDepths(atm: SpectralAtmosphere, i: number) {
  const top = atm.topRadius - atm.bottomRadius;
  const mol = atm.molSca[i] * atm.molScaleHeight * (1 - Math.exp(-top / atm.molScaleHeight));
  const colA =
    atm.profileA.kind === 'exponential'
      ? atm.profileA.scaleHeight * (1 - Math.exp(-top / atm.profileA.scaleHeight))
      : profileColumn(atm.profileA);
  const colB = atm.profileB ? profileColumn(atm.profileB) : 0;
  return {
    rayleigh: mol,
    aerosol: atm.aExt[i] * colA + atm.bExt[i] * colB,
    ozone: atm.ozoneAbs[i] * OZONE_HALF_WIDTH,
  };
}
