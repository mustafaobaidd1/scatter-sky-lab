/**
 * Per-direction spectral shading: sky, terrain ridges, planet ground and the solar disc.
 * This is the CPU reference of the GLSL shader (src/render/shaders/sky.frag.glsl), which mirrors
 * its structure. Radiance in W m^-2 sr^-1 nm^-1 on the atmosphere's wavelength grid.
 */
import {
  anglesFromDir,
  dirFromAngles,
  sunDiscRadiance,
  surfaceRadiance,
  traceRay,
  type Scene,
  type Vec3,
} from '../physics/sky';
import {
  FLOOR_DEPTH,
  FLOOR_ELEVATION,
  hillWeight,
  RIDGES,
  ridgeElevation,
  ridgeHeight,
  RIM_ANGLE,
} from './terrain';

export type SampleKind = 'sky' | 'terrain' | 'ground' | 'sun' | 'space';

export interface ShadeResult {
  radiance: Float64Array;
  /** Contributions (sum to radiance): molecular and aerosol in-scatter, surfaces, solar disc. */
  rayleigh: Float64Array;
  aerosol: Float64Array;
  surface: Float64Array;
  sun: Float64Array;
  /** What dominates the pixel. */
  kind: SampleKind;
}

export interface ShadeOptions {
  /** Quadrature samples for long rays (sky, ground from altitude). */
  steps: number;
  /** Angular size of a pixel (radians), for anti-aliased edges. 0 = point sample. */
  pixelAngle: number;
}

function blank(n: number): ShadeResult {
  return {
    radiance: new Float64Array(n),
    rayleigh: new Float64Array(n),
    aerosol: new Float64Array(n),
    surface: new Float64Array(n),
    sun: new Float64Array(n),
    kind: 'sky',
  };
}

function accumulate(into: ShadeResult, from: ShadeResult, w: number) {
  for (let i = 0; i < into.radiance.length; i++) {
    into.rayleigh[i] += w * from.rayleigh[i];
    into.aerosol[i] += w * from.aerosol[i];
    into.surface[i] += w * from.surface[i];
    into.sun[i] += w * from.sun[i];
  }
}

/** Radiance along a ray that ignores terrain: atmosphere, then ground or space (+ sun disc). */
function shadeOpen(scene: Scene, dir: Vec3, opts: ShadeOptions): ShadeResult {
  const { atm } = scene;
  const out = blank(atm.n);
  const tr = traceRay(scene, dir, { steps: opts.steps, useLut: true });
  out.rayleigh.set(tr.rayleigh);
  out.aerosol.set(tr.aerosol);
  if (tr.hitGround) {
    out.kind = 'ground';
    const r0 = atm.bottomRadius + scene.altitude;
    const p: Vec3 = [dir[0] * tr.length, r0 + dir[1] * tr.length, dir[2] * tr.length];
    const len = Math.hypot(p[0], p[1], p[2]);
    const up: Vec3 = [p[0] / len, p[1] / len, p[2] / len];
    surfaceRadiance(scene, atm.bottomRadius, up, up, out.surface);
    for (let i = 0; i < atm.n; i++) out.surface[i] *= tr.transmittance[i];
    return out;
  }
  if (tr.missed) out.kind = 'space';
  const s = scene.sunDir;
  const cosT = Math.min(1, dir[0] * s[0] + dir[1] * s[1] + dir[2] * s[2]);
  const theta = Math.acos(cosT);
  const alpha = atm.sunAngularRadius;
  const halfPx = Math.max(opts.pixelAngle * 0.5, 1e-7);
  if (theta < alpha + halfPx) {
    const coverage =
      opts.pixelAngle > 0 ? Math.min(1, Math.max(0, (alpha - theta) / opts.pixelAngle + 0.5)) : 1;
    sunDiscRadiance(atm, Math.min(theta, alpha * 0.999), out.sun);
    for (let i = 0; i < atm.n; i++) out.sun[i] *= tr.transmittance[i] * coverage;
    if (coverage > 0.5) out.kind = 'sun';
  }
  return out;
}

/**
 * Radiance of a ray that hits terrain layer `k` at distance `t` (km): either the hillside facing
 * the observer (`onFloor` false) or the valley floor in front of it. `rim` ∈ [0, 1] bends the
 * hillside normal toward the sky near the ridge line, where convex hilltops see more sky.
 */
function shadeRidge(
  scene: Scene,
  dir: Vec3,
  k: number,
  t: number,
  opts: ShadeOptions,
  onFloor: boolean,
  rim: number,
): ShadeResult {
  const { atm } = scene;
  const out = blank(atm.n);
  out.kind = 'terrain';
  const steps = Math.max(8, Math.min(opts.steps, Math.round(opts.steps * 0.4)));
  const tr = traceRay(scene, dir, { steps, useLut: true, tMax: t, ignoreGround: true });
  out.rayleigh.set(tr.rayleigh);
  out.aerosol.set(tr.aerosol);
  const layer = RIDGES[k];
  // Hillside facing the observer, tilted toward the sky; flat valley floor when looking down.
  const hx = -dir[0];
  const hz = -dir[2];
  const hl = Math.hypot(hx, hz) || 1;
  const tilt = onFloor ? Math.PI / 2 : layer.slope + rim * (Math.PI / 2 - layer.slope) * 0.6;
  const s = Math.sin(tilt);
  const c = Math.cos(tilt);
  const normal: Vec3 = [(hx / hl) * c, s, (hz / hl) * c];
  surfaceRadiance(
    scene,
    atm.bottomRadius + Math.max(0, scene.altitude),
    [0, 1, 0],
    normal,
    out.surface,
  );
  for (let i = 0; i < atm.n; i++) out.surface[i] *= tr.transmittance[i];
  return out;
}

export function shadeDirection(scene: Scene, dir: Vec3, opts: ShadeOptions): ShadeResult {
  const { atm } = scene;
  const n = atm.n;
  const result = blank(n);
  const { elevation, azimuth } = anglesFromDir(dir);
  const elev = (elevation * Math.PI) / 180;
  const az = (azimuth * Math.PI) / 180;
  const px = Math.max(opts.pixelAngle, 1e-6);
  let remaining = 1;
  let dominant: SampleKind | null = null;
  let dominantWeight = 0;

  // Terrain ridges, front to back. Looking steeply down (below FLOOR_ELEVATION) the near hillside
  // gives way to the ground at the viewer's feet, FLOOR_DEPTH below the eye.
  const hw = hillWeight(scene.altitude);
  if (hw > 0) {
    const tFloor =
      elev < FLOOR_ELEVATION
        ? (FLOOR_DEPTH + Math.max(0, scene.altitude)) / Math.sin(-elev)
        : Infinity;
    for (let k = 0; k < RIDGES.length && remaining > 1e-6; k++) {
      const ridge = ridgeElevation(RIDGES[k], az, scene.altitude, atm.bottomRadius);
      const cov = hw * Math.min(1, Math.max(0, (ridge - elev) / px + 0.5));
      if (cov <= 0) continue;
      let tHill = RIDGES[k].distance / Math.max(0.05, Math.cos(elev));
      if (k === 0) {
        // The near hillside rises from the viewer's feet to the ridge, so rays further below the
        // ridge line meet it closer: s = h_eye / (H/d − tan ε).
        const rise = ridgeHeight(RIDGES[0], az) / RIDGES[0].distance - Math.tan(elev);
        const eye = Math.max(FLOOR_DEPTH, scene.altitude);
        if (rise > 0) tHill = Math.min(tHill, eye / rise / Math.max(0.05, Math.cos(elev)));
      }
      const onFloor = tFloor < tHill;
      const rim = Math.min(1, Math.max(0, 1 - (ridge - elev) / RIM_ANGLE));
      const r = shadeRidge(
        scene,
        dir,
        k,
        Math.min(tHill, tFloor),
        opts,
        onFloor,
        onFloor ? 0 : rim,
      );
      const w = remaining * cov;
      accumulate(result, r, w);
      if (w > dominantWeight) {
        dominant = r.kind;
        dominantWeight = w;
      }
      remaining *= 1 - cov;
    }
  }

  if (remaining > 1e-6) {
    // Planet limb: blend a ray just above and just below the horizon on edge pixels.
    // Horizon dip = acos(R / r0) = atan(√(r0² − R²) / R), written without cancellation.
    const R = atm.bottomRadius;
    const h0 = Math.max(0, scene.altitude);
    const horizon = -Math.atan(Math.sqrt(h0 * (2 * R + h0)) / R);
    const below = Math.min(1, Math.max(0, (horizon - elev) / px + 0.5));
    if (below > 0 && below < 1) {
      const upDir = dirFromAngles(((horizon + 0.5 * px) * 180) / Math.PI, azimuth);
      const downDir = dirFromAngles(((horizon - 0.5 * px) * 180) / Math.PI, azimuth);
      const a = shadeOpen(scene, upDir, opts);
      const b = shadeOpen(scene, downDir, opts);
      accumulate(result, a, remaining * (1 - below));
      accumulate(result, b, remaining * below);
      if (remaining > dominantWeight) dominant = below > 0.5 ? b.kind : a.kind;
    } else {
      const o = shadeOpen(scene, dir, opts);
      accumulate(result, o, remaining);
      if (remaining > dominantWeight) dominant = o.kind;
    }
  }

  for (let i = 0; i < n; i++) {
    result.radiance[i] = result.rayleigh[i] + result.aerosol[i] + result.surface[i] + result.sun[i];
  }
  result.kind = dominant ?? 'sky';
  return result;
}
