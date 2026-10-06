/** Physical constants used across the model. SI units unless the name says otherwise. */

/** Boltzmann constant, J/K (exact in SI since 2019). */
export const BOLTZMANN = 1.380649e-23;

/**
 * Avogadro's number as used by Bodhaine et al. (1999), taken from Cohen & Taylor (1995).
 * Kept at that value so the Rayleigh validation reproduces their Table 3 like-for-like.
 */
export const AVOGADRO = 6.0221367e23;

/**
 * Molecular number density of standard air (288.15 K, 1013.25 hPa), m^-3.
 * Bodhaine et al. (1999), Appendix: 2.546899e19 cm^-3.
 */
export const STANDARD_AIR_NUMBER_DENSITY = 2.546899e25;

/** Standard sea-level pressure, Pa. */
export const STANDARD_PRESSURE = 101325;

/** One Dobson unit in molecules per m^2 (Loschmidt constant × 10 µm). */
export const DOBSON_UNIT = 2.6867811e20;

/** Maximum luminous efficacy of radiation for photopic vision, lm/W. */
export const LUMINOUS_EFFICACY = 683;

/** Atomic mass unit, kg. */
export const ATOMIC_MASS_UNIT = 1.66053907e-27;

/** Degrees ↔ radians. */
export const DEG = Math.PI / 180;
