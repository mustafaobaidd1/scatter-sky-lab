import { AVOGADRO, STANDARD_AIR_NUMBER_DENSITY } from './constants';
import { airColumn, airCrossSection, co2CrossSection } from './rayleigh';

export type PlanetId = 'earth' | 'mars';

export interface Planet {
  id: PlanetId;
  name: string;
  /** Mean radius, km. */
  radius: number;
  /** Height of the modelled atmosphere's upper boundary above the ground, km. */
  atmosphereHeight: number;
  /** Scale height of the molecular (Rayleigh) density, km. */
  molecularScaleHeight: number;
  /** Vertical column of gas molecules above the ground, m^-2. */
  molecularColumn: number;
  /** Rayleigh cross-section per molecule of the gas mixture, m². */
  molecularCrossSection: (lambdaNm: number) => number;
  /** Mean distance to the Sun, astronomical units. */
  sunDistanceAu: number;
  /** Default ozone column, Dobson units. */
  ozoneDU: number;
  /** Spectral ground albedo (a simple illustrative curve, not a measured spectrum). */
  groundAlbedo: (lambdaNm: number) => number;
}

/** Angular radius of the Sun seen from 1 AU: R☉ / 1 au = 695 700 km / 149 597 870.7 km. */
export const SUN_ANGULAR_RADIUS_1AU = 695700 / 149597870.7;

const earthColumn = airColumn(); // Bodhaine et al. (1999): sea level, 1013.25 hPa, 45° N

export const EARTH: Planet = {
  id: 'earth',
  name: 'Earth',
  radius: 6371.0,
  atmosphereHeight: 100,
  // Chosen so that N_s · H equals the column: the sea-level density is standard air
  // (288.15 K, 1013.25 hPa) and the optical depth equals Bodhaine's. H = kT/(m g) ≈ 8.45 km.
  molecularScaleHeight: earthColumn / STANDARD_AIR_NUMBER_DENSITY / 1000,
  molecularColumn: earthColumn,
  molecularCrossSection: (l) => airCrossSection(l),
  sunDistanceAu: 1,
  ozoneDU: 300,
  // Scrub and grass: dark, with a faint green bump and the start of the vegetation red edge.
  groundAlbedo: (l) =>
    0.045 + 0.025 * Math.exp(-0.5 * ((l - 555) / 35) ** 2) + 0.08 * Math.max(0, (l - 690) / 60),
};

/**
 * Mars, from the NASA NSSDC Mars fact sheet: mean radius 3389.5 km, surface pressure 6.36 mb,
 * scale height 11.0 km, mean molecular weight 43.49 g/mol, surface gravity 3.73 m/s²,
 * semimajor axis 1.52366 AU, 95.1 % CO2.
 */
const MARS_PRESSURE = 636; // Pa
const MARS_MOLAR_MASS = 43.49e-3; // kg/mol
const MARS_GRAVITY = 3.73;
const marsColumn = MARS_PRESSURE / ((MARS_MOLAR_MASS / AVOGADRO) * MARS_GRAVITY);

export const MARS: Planet = {
  id: 'mars',
  name: 'Mars',
  radius: 3389.5,
  atmosphereHeight: 100,
  molecularScaleHeight: 11.0,
  molecularColumn: marsColumn,
  // 95.1 % CO2; the remaining N2, Ar, O2 scatter roughly like air.
  molecularCrossSection: (l) => 0.951 * co2CrossSection(l) + 0.049 * airCrossSection(l),
  sunDistanceAu: 1.52366,
  ozoneDU: 0,
  // Rusty regolith: very dark in the blue, bright in the red.
  groundAlbedo: (l) => 0.04 + 0.26 * Math.pow(Math.min(1, Math.max(0, (l - 400) / 320)), 1.6),
};

export const PLANETS: Record<PlanetId, Planet> = { earth: EARTH, mars: MARS };

/** Mars dust: scale height 11.6 km (Lemmon et al. 2004), optical depth defined at 550 nm. */
export const MARS_DUST_SCALE_HEIGHT = 11.6;
export const MARS_DUST_TAU_DEFAULT = 0.6;
