/**
 * Single scattering of sunlight along view rays (CPU reference implementation).
 *
 *   L(λ) = ∫₀^d T(0,t;λ) · E☉(λ) · T☉(t;λ) · Σ_k β_k(λ) ρ_k(h(t)) P_k(θ, λ) dt  [+ T(0,d) L_ground]
 *
 * with T the transmittance along the view ray, T☉ the transmittance from the sample point to the
 * Sun (zero in the planet's shadow, softened over the solar disc), β_k ρ_k the scattering
 * coefficient of constituent k at height h and P_k its phase function. Each quadrature step uses
 * the closed form for constant extinction σ_t and source J over the step,
 * ∫ e^{−σ_t s} J ds = J (1 − e^{−σ_t Δt}) / σ_t (Hillaire 2020).
 * Lengths in km, radiance in W m^-2 sr^-1 nm^-1.
 */
import { cornetteShanks } from './aerosol';
import type { SpectralAtmosphere } from './atmosphere';
import { DEG } from './constants';
import { dustPhase } from './marsDust';
import { type ColumnLut, densities, distanceToTop, integrateColumns, lookupColumns } from './lut';
import { rayleighPhase } from './rayleigh';

export type Vec3 = [number, number, number];

/** Unit direction from elevation and azimuth (degrees). x = east, y = up, z = north. */
export function dirFromAngles(elevationDeg: number, azimuthDeg: number): Vec3 {
  const e = elevationDeg * DEG;
  const a = azimuthDeg * DEG;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

/** Elevation and azimuth (degrees, azimuth in [0, 360)) of a direction. */
export function anglesFromDir(d: Vec3): { elevation: number; azimuth: number } {
  const elevation = Math.asin(Math.min(1, Math.max(-1, d[1]))) / DEG;
  let azimuth = Math.atan2(d[0], d[2]) / DEG;
  if (azimuth < 0) azimuth += 360;
  return { elevation, azimuth };
}

export interface IrradianceTable {
  /** Sun zenith cosines at which the table is sampled (ascending). */
  muS: Float64Array;
  /** Diffuse sky irradiance on horizontal ground, W m^-2 nm^-1: values[m * n + i]. */
  values: Float64Array;
  n: number;
}

export interface Scene {
  atm: SpectralAtmosphere;
  lut: ColumnLut;
  irradiance: IrradianceTable | null;
  /** Observer altitude, km. */
  altitude: number;
  /** Unit vector toward the Sun. */
  sunDir: Vec3;
}

export interface TraceOptions {
  /** Quadrature samples along the view ray. */
  steps: number;
  /** Use the precomputed column table for sunlight (fast) or integrate numerically (reference). */
  useLut: boolean;
  /** Samples for the sunward integral when useLut is false. */
  sunSteps?: number;
  /** Stop the ray at this distance (a terrain hit), km. */
  tMax?: number;
  /** Ignore the planet sphere (terrain rays: the terrain model replaces the ground). */
  ignoreGround?: boolean;
}

export interface TraceResult {
  /** Light scattered by molecules into the ray. */
  rayleigh: Float64Array;
  /** Light scattered by aerosols (both layers) into the ray. */
  aerosol: Float64Array;
  /** Transmittance from the observer to the end of the ray. */
  transmittance: Float64Array;
  /** The ray ends on the planet's surface. */
  hitGround: boolean;
  /** The ray never enters the atmosphere (observer in space looking away). */
  missed: boolean;
  /** Distance travelled, km. */
  length: number;
  /** Radius and sun zenith cosine at the end point (for surface shading). */
  endRadius: number;
  endMuS: number;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Fraction of the solar disc above the horizon at radius r for sun zenith cosine μs
 * (Bruneton 2017): 0 in the planet's shadow, 1 in full sunlight.
 */
export function sunVisibility(r: number, muS: number, bottom: number, alpha: number): number {
  const sinH = bottom / r;
  const cosH = -Math.sqrt(Math.max(0, 1 - sinH * sinH));
  return smoothstep(-sinH * alpha, sinH * alpha, muS - cosH);
}

/** Spectral transmittance toward the Sun from radius r (including the shadow term). */
export function sunTransmittance(
  atm: SpectralAtmosphere,
  lut: ColumnLut | null,
  r: number,
  muS: number,
  out: Float64Array,
  sunSteps = 64,
): Float64Array {
  const vis = sunVisibility(r, muS, atm.bottomRadius, atm.sunAngularRadius);
  if (vis <= 0) return out.fill(0);
  const col = new Float64Array(4);
  if (lut) lookupColumns(lut, r, muS, col);
  else integrateColumns(atm, r, muS, distanceToTop(r, muS, atm.topRadius), sunSteps, col);
  for (let i = 0; i < atm.n; i++) {
    const tau =
      atm.molSca[i] * col[0] +
      atm.aExt[i] * col[1] +
      atm.bExt[i] * col[2] +
      atm.ozoneAbs[i] * col[3];
    out[i] = vis * Math.exp(-tau);
  }
  return out;
}

/** Ray–sphere intersection parameters for the observer at radius r0 = R + h, zenith cosine μ. */
export function rayExtent(
  atm: SpectralAtmosphere,
  altitude: number,
  mu: number,
  ignoreGround = false,
) {
  const R = atm.bottomRadius;
  const Ht = atm.topRadius - R;
  const h = Math.max(0, altitude);
  const r0 = R + h;
  const b = r0 * mu;
  const cGround = h * (2 * R + h); // r0² − R², exact for small h
  const cTop = (h - Ht) * (2 * R + h + Ht); // r0² − top²
  const discT = b * b - cTop;
  if (discT < 0) return { t0: 0, t1: 0, hitGround: false, missed: true, r0, b, cGround };
  const sq = Math.sqrt(discT);
  let t0 = 0;
  const t1Top = -b + sq;
  if (cTop > 0) {
    // Observer above the atmosphere.
    t0 = -b - sq;
    if (t1Top <= 0) return { t0: 0, t1: 0, hitGround: false, missed: true, r0, b, cGround };
  }
  let t1 = t1Top;
  let hitGround = false;
  const discG = b * b - cGround;
  if (discG >= 0 && !ignoreGround && b < 0) {
    // Smaller root in the cancellation-free form c / (−b + √disc) (matters in fp32 on the GPU).
    const tg = cGround / (-b + Math.sqrt(discG));
    if (tg > 0 && tg < t1) {
      t1 = tg;
      hitGround = true;
    }
  }
  return { t0: Math.max(0, t0), t1, hitGround, missed: false, r0, b, cGround };
}

export function traceRay(scene: Scene, dir: Vec3, opts: TraceOptions): TraceResult {
  const { atm } = scene;
  const n = atm.n;
  const res: TraceResult = {
    rayleigh: new Float64Array(n),
    aerosol: new Float64Array(n),
    transmittance: new Float64Array(n).fill(1),
    hitGround: false,
    missed: false,
    length: 0,
    endRadius: atm.bottomRadius + scene.altitude,
    endMuS: scene.sunDir[1],
  };
  const mu0 = dir[1];
  const ext = rayExtent(atm, scene.altitude, mu0, opts.ignoreGround ?? false);
  if (ext.missed) {
    res.missed = true;
    return res;
  }
  let t0 = ext.t0;
  let t1 = ext.t1;
  res.hitGround = ext.hitGround;
  if (opts.tMax !== undefined && opts.tMax < t1) {
    t1 = Math.max(t0, opts.tMax);
    res.hitGround = false;
  }
  const R = atm.bottomRadius;
  const { r0, b, cGround } = ext;
  const s = scene.sunDir;
  const nu = dir[0] * s[0] + dir[1] * s[1] + dir[2] * s[2]; // cos(scattering angle)
  const os = r0 * s[1]; // dot(observer, sun)

  // Phase functions (wavelength independent for molecules).
  const pR = rayleighPhase(nu, atm.rayleighGamma);
  const pA = new Float64Array(n);
  const pB = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pA[i] = atm.dust ? dustPhase(atm.dust, i, nu) : cornetteShanks(nu, atm.aPhaseG[i]);
    pB[i] = cornetteShanks(nu, atm.bPhaseG[i]);
  }

  const dens = new Float64Array(4);
  const tSun = new Float64Array(n);
  const T = res.transmittance;
  const step = (t: number, dt: number) => {
    const q = cGround + t * t + 2 * r0 * mu0 * t; // r(t)² − R²
    const r = Math.sqrt(R * R + Math.max(0, q));
    const h = Math.max(0, q) / (r + R);
    const muS = (os + t * nu) / r;
    densities(atm, h, dens);
    sunTransmittance(atm, opts.useLut ? scene.lut : null, r, muS, tSun, opts.sunSteps ?? 64);
    for (let i = 0; i < n; i++) {
      const sigma =
        atm.molSca[i] * dens[0] +
        atm.aExt[i] * dens[1] +
        atm.bExt[i] * dens[2] +
        atm.ozoneAbs[i] * dens[3];
      const tr = Math.exp(-sigma * dt);
      const f = sigma > 1e-12 ? (1 - tr) / sigma : dt;
      const e = atm.solar[i] * tSun[i] * T[i] * f;
      res.rayleigh[i] += e * atm.molSca[i] * dens[0] * pR;
      res.aerosol[i] += e * (atm.aSca[i] * dens[1] * pA[i] + atm.bSca[i] * dens[2] * pB[i]);
      T[i] *= tr;
    }
  };

  // Quadrature: quadratic spacing away from the ray's lowest point, marched in increasing t.
  const tLow = Math.min(t1, Math.max(t0, -b));
  const lenA = tLow - t0;
  const lenB = t1 - tLow;
  const total = t1 - t0;
  if (total > 0) {
    const nA = lenA > 1e-9 ? Math.max(2, Math.round((opts.steps * lenA) / total)) : 0;
    const nB = lenB > 1e-9 ? Math.max(2, opts.steps - nA) : 0;
    for (let k = nA - 1; k >= 0; k--) {
      const u = (k + 0.5) / nA;
      step(tLow - lenA * u * u, (lenA * 2 * u) / nA);
    }
    for (let k = 0; k < nB; k++) {
      const u = (k + 0.5) / nB;
      step(tLow + lenB * u * u, (lenB * 2 * u) / nB);
    }
  }
  res.length = t1;
  const qEnd = cGround + t1 * t1 + 2 * r0 * mu0 * t1;
  res.endRadius = Math.sqrt(R * R + Math.max(0, qEnd));
  res.endMuS = (os + t1 * nu) / res.endRadius;
  return res;
}

/** Sun zenith cosine of irradiance-table row m: μs = −0.25 + 1.25 (m / (M − 1))². */
export function irradianceMu(m: number, rows: number): number {
  const u = m / (rows - 1);
  return -0.25 + 1.25 * u * u;
}

/**
 * Diffuse sky irradiance (per λ) on horizontal ground for sun zenith cosine μs, interpolated
 * linearly in the table coordinate u = √((μs + 0.25) / 1.25), as GL_LINEAR does on the GPU.
 */
export function skyIrradianceAt(
  table: IrradianceTable | null,
  muS: number,
  out: Float64Array,
): Float64Array {
  if (!table) return out.fill(0);
  const rows = table.muS.length;
  const u = Math.sqrt(Math.min(1, Math.max(0, (muS + 0.25) / 1.25)));
  const x = u * (rows - 1);
  const j = Math.min(rows - 2, Math.floor(x));
  const t = x - j;
  for (let i = 0; i < table.n; i++) {
    out[i] = table.values[j * table.n + i] * (1 - t) + table.values[(j + 1) * table.n + i] * t;
  }
  return out;
}

/**
 * Radiance leaving a Lambertian surface element with unit normal `normal` at radius r:
 * albedo/π × (direct sunlight × cos + diffuse skylight × sky-view factor).
 * The diffuse term uses the irradiance table for the local sun zenith cosine.
 */
export function surfaceRadiance(
  scene: Scene,
  r: number,
  localUp: Vec3,
  normal: Vec3,
  out: Float64Array,
): Float64Array {
  const { atm } = scene;
  const s = scene.sunDir;
  const muS = localUp[0] * s[0] + localUp[1] * s[1] + localUp[2] * s[2];
  const cosI = Math.max(0, normal[0] * s[0] + normal[1] * s[1] + normal[2] * s[2]);
  const skyView =
    0.5 * (1 + normal[0] * localUp[0] + normal[1] * localUp[1] + normal[2] * localUp[2]);
  const tSun = sunTransmittance(atm, scene.lut, r, muS, new Float64Array(atm.n));
  const eSky = skyIrradianceAt(scene.irradiance, muS, new Float64Array(atm.n));
  for (let i = 0; i < atm.n; i++) {
    out[i] = (atm.albedo[i] / Math.PI) * (atm.solar[i] * tSun[i] * cosI + eSky[i] * skyView);
  }
  return out;
}

/** Hestroffer & Magnan (1998) limb-darkening exponent: I(μ)/I(1) = μ^α, α = −0.023 + 0.292/λ[µm]. */
export function limbDarkeningExponent(lambdaNm: number): number {
  return -0.023 + 0.292 / (lambdaNm / 1000);
}

/**
 * Radiance of the solar disc at angular distance θ from its centre (θ < α), before atmospheric
 * attenuation: E☉/Ω · (a + 2)/2 · μ'^a with μ' = √(1 − (θ/α)²); integrates to E☉ over the disc.
 */
export function sunDiscRadiance(
  atm: SpectralAtmosphere,
  theta: number,
  out: Float64Array,
): Float64Array {
  const alpha = atm.sunAngularRadius;
  const omega = 2 * Math.PI * (1 - Math.cos(alpha));
  const x = Math.min(1, theta / alpha);
  const muP = Math.sqrt(Math.max(0, 1 - x * x));
  for (let i = 0; i < atm.n; i++) {
    const a = limbDarkeningExponent(atm.lambdas[i]);
    out[i] = theta >= alpha ? 0 : (atm.solar[i] / omega) * ((a + 2) / 2) * Math.pow(muP, a);
  }
  return out;
}

/**
 * Builds the diffuse-skylight table by integrating single-scattered sky radiance over the
 * upper hemisphere at the ground: E(μs) = ∫∫ L(μ, φ) μ dμ dφ.
 */
export function buildIrradianceTable(
  atm: SpectralAtmosphere,
  lut: ColumnLut,
  samples = 24,
  zenithBands = 8,
  azimuths = 8,
): IrradianceTable {
  const n = atm.n;
  const muS = new Float64Array(samples);
  const values = new Float64Array(samples * n);
  for (let m = 0; m < samples; m++) {
    // Denser sampling near the horizon, where skylight changes fastest.
    muS[m] = irradianceMu(m, samples);
    const sunDir: Vec3 = [Math.sqrt(Math.max(0, 1 - muS[m] * muS[m])), muS[m], 0];
    const scene: Scene = { atm, lut, irradiance: null, altitude: 0.002, sunDir };
    for (let zb = 0; zb < zenithBands; zb++) {
      const mu = (zb + 0.5) / zenithBands; // midpoint in μ = cos θ
      const sinT = Math.sqrt(1 - mu * mu);
      for (let az = 0; az < azimuths; az++) {
        // Symmetric about the solar vertical: integrate φ ∈ [0, π] and double.
        const phi = (Math.PI * (az + 0.5)) / azimuths;
        const dir: Vec3 = [sinT * Math.cos(phi), mu, sinT * Math.sin(phi)];
        const tr = traceRay(scene, dir, { steps: 16, useLut: true });
        const w = mu * (1 / zenithBands) * (Math.PI / azimuths) * 2;
        for (let i = 0; i < n; i++) values[m * n + i] += w * (tr.rayleigh[i] + tr.aerosol[i]);
      }
    }
  }
  return { muS, values, n };
}
