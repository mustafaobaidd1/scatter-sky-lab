/**
 * Rayleigh scattering by air and CO2 from first principles, following
 * B. A. Bodhaine, N. B. Wood, E. G. Dutton, J. R. Slusser (1999), "On Rayleigh optical depth
 * calculations", J. Atmos. Oceanic Technol. 16, 1854–1861 (equation numbers below are theirs).
 */
import { AVOGADRO, STANDARD_AIR_NUMBER_DENSITY } from './constants';

/** Refractive index of dry air (288.15 K, 1013.25 hPa) minus one. Eqs. (18)–(19). */
export function airRefractivity(lambdaNm: number, co2PartsPerVolume = 360e-6): number {
  const s2 = 1 / ((lambdaNm / 1000) * (lambdaNm / 1000)); // µm^-2
  const n300 = (8060.51 + 2480990 / (132.274 - s2) + 17455.7 / (39.32957 - s2)) * 1e-8;
  return n300 * (1 + 0.54 * (co2PartsPerVolume - 0.0003));
}

/** King correction factor of dry air, Bates (1984) via Eqs. (5), (6), (23). */
export function airKingFactor(lambdaNm: number, co2PartsPerVolume = 360e-6): number {
  const l2 = (lambdaNm / 1000) * (lambdaNm / 1000);
  const fN2 = 1.034 + 3.17e-4 / l2;
  const fO2 = 1.096 + 1.385e-3 / l2 + 1.448e-4 / (l2 * l2);
  const cCo2 = co2PartsPerVolume * 100; // percent
  return (78.084 * fN2 + 20.946 * fO2 + 0.934 * 1.0 + cCo2 * 1.15) / (78.084 + 20.946 + 0.934 + cCo2);
}

/** Depolarisation ratio ρ from a King factor F = (6 + 3ρ)/(6 − 7ρ). */
export function depolarisationFromKing(f: number): number {
  return (6 * (f - 1)) / (3 + 7 * f);
}

/**
 * Scattering cross-section per molecule, m², Eq. (22):
 *   σ = 24π³ (n² − 1)² / (λ⁴ Ns² (n² + 2)²) · F
 * with n and Ns both at 288.15 K and 1013.25 hPa (σ itself is independent of T and p).
 */
export function crossSectionFromIndex(lambdaNm: number, refractivity: number, kingFactor: number): number {
  const n = 1 + refractivity;
  const n2 = n * n;
  const l = lambdaNm * 1e-9;
  const Ns = STANDARD_AIR_NUMBER_DENSITY;
  return ((24 * Math.PI ** 3 * (n2 - 1) ** 2) / (l ** 4 * Ns * Ns * (n2 + 2) ** 2)) * kingFactor;
}

export function airCrossSection(lambdaNm: number, co2PartsPerVolume = 360e-6): number {
  return crossSectionFromIndex(
    lambdaNm,
    airRefractivity(lambdaNm, co2PartsPerVolume),
    airKingFactor(lambdaNm, co2PartsPerVolume),
  );
}

/** Refractive index of CO2 minus one at 288.15 K, 1013.25 hPa (Owens 1967), Eq. (27). */
export function co2Refractivity(lambdaNm: number): number {
  const s2 = 1 / ((lambdaNm / 1000) * (lambdaNm / 1000));
  return (22822.1 + 117.8 * s2 + 2406030 / (130 - s2) + 15997 / (38.9 - s2)) * 1e-8;
}

/** CO2 cross-section per molecule, m², with the King factor 1.15 recommended by Bates (1984). */
export function co2CrossSection(lambdaNm: number): number {
  return crossSectionFromIndex(lambdaNm, co2Refractivity(lambdaNm), 1.15);
}

/** Mean molecular weight of dry air, g/mol, Eq. (17) fit: 15.0556·CO2 + 28.9595. */
export function airMolecularWeight(co2PartsPerVolume = 360e-6): number {
  return 15.0556 * co2PartsPerVolume + 28.9595;
}

/** Gravity at height z (m) and latitude φ (deg), cm s^-2 → returned in m s^-2. Eqs. (10)–(11). */
export function gravity(latitudeDeg: number, z: number): number {
  const c2 = Math.cos((2 * latitudeDeg * Math.PI) / 180);
  const g0 = 980.616 * (1 - 0.0026373 * c2 + 0.0000059 * c2 * c2);
  const g =
    g0 -
    (3.085462e-4 + 2.27e-7 * c2) * z +
    (7.254e-11 + 1.0e-13 * c2) * z * z -
    (1.517e-17 + 6e-20 * c2) * z * z * z;
  return g / 100;
}

/**
 * Column number density of air above a site, molecules m^-2 (Eq. 25 without σ):
 * P·A / (m_a·g) with g evaluated at the mass-weighted column altitude z_c = 0.73737 z + 5517.56.
 */
export function airColumn(pressurePa = 101325, latitudeDeg = 45, siteAltitude = 0, co2 = 360e-6): number {
  const zc = 0.73737 * siteAltitude + 5517.56;
  const m = airMolecularWeight(co2) / 1000 / AVOGADRO; // kg per molecule
  return pressurePa / (m * gravity(latitudeDeg, zc));
}

/** Rayleigh optical depth of a column of air (sea level, 45° N by default). */
export function airOpticalDepth(lambdaNm: number, pressurePa = 101325, latitudeDeg = 45): number {
  return airCrossSection(lambdaNm) * airColumn(pressurePa, latitudeDeg);
}

/**
 * The volume scattering coefficient used by many real-time renderers (Nishita et al. 1993,
 * Bruneton & Neyret 2008, Hillaire 2020): β = 8π³(n² − 1)²/(3Nλ⁴) · (6 + 3ρ)/(6 − 7ρ) with a
 * constant n = 1.0003, N = 2.546e25 m^-3 and ρ = 0.035. Exposed only to document where those
 * widely copied constants come from; the simulation uses the physical cross-section above.
 */
export function renderingRayleighBeta(lambdaNm: number, n = 1.0003, N = 2.546e25, rho = 0.035): number {
  const l = lambdaNm * 1e-9;
  return ((8 * Math.PI ** 3 * (n * n - 1) ** 2) / (3 * N * l ** 4)) * ((6 + 3 * rho) / (6 - 7 * rho));
}

/**
 * Rayleigh phase function with molecular anisotropy (Chandrasekhar 1950):
 *   P(μ) = 3/(16π) · [(1 + 3γ) + (1 − γ) μ²] / (1 + 2γ),   γ = ρ / (2 − ρ).
 * Normalised so that ∫ P dΩ = 1.
 */
export function rayleighPhase(mu: number, gamma: number): number {
  return ((3 / (16 * Math.PI)) * (1 + 3 * gamma + (1 - gamma) * mu * mu)) / (1 + 2 * gamma);
}

/** γ used for the phase function: from the King factor of air at 550 nm (≈ 0.0144). */
export const RAYLEIGH_GAMMA = (() => {
  const rho = depolarisationFromKing(airKingFactor(550));
  return rho / (2 - rho);
})();
