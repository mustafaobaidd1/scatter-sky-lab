/** Packs an atmosphere and the scene constants into the uniform/texture layout of sky.frag.glsl. */
import { cmfWeights, XYZ_TO_LINEAR_SRGB } from '../physics/colour';
import { LUMINOUS_EFFICACY } from '../physics/constants';
import type { SpectralAtmosphere } from '../physics/atmosphere';
import type { ColumnLut } from '../physics/lut';
import { PHASE_ANGLES } from '../physics/marsDust';
import { limbDarkeningExponent, type IrradianceTable } from '../physics/sky';
import { FLOOR_DEPTH, FLOOR_ELEVATION, RIDGES, RIM_ANGLE } from './terrain';

export const GPU_WAVELENGTHS = 16;

export interface GpuAtmosphere {
  vectors: Record<string, Float32Array>;
  scalars: Record<string, number | number[]>;
  lut: ColumnLut;
  irradiance: IrradianceTable;
  /** Phase table PHASE_ANGLES × 16 (row per wavelength) or null for Earth. */
  dustPhase: Float32Array | null;
}

function vec4s(values: ArrayLike<number>): Float32Array {
  if (values.length !== GPU_WAVELENGTHS) throw new Error(`expected ${GPU_WAVELENGTHS} wavelengths`);
  return Float32Array.from(values as ArrayLike<number>);
}

export function packAtmosphere(
  atm: SpectralAtmosphere,
  lut: ColumnLut,
  irradiance: IrradianceTable,
): GpuAtmosphere {
  const w = cmfWeights(atm.lambdas);
  const scale = (a: Float64Array) => a.map((v) => v * LUMINOUS_EFFICACY);
  const ld = atm.lambdas.map((l) => limbDarkeningExponent(l));
  const profA = atm.profileA;
  const profB = atm.profileB;
  const vectors: Record<string, Float32Array> = {
    uMolSca: vec4s(atm.molSca),
    uAExt: vec4s(atm.aExt),
    uASca: vec4s(atm.aSca),
    uAG: vec4s(atm.aPhaseG),
    uBExt: vec4s(atm.bExt),
    uBSca: vec4s(atm.bSca),
    uBG: vec4s(atm.bPhaseG),
    uOzone: vec4s(atm.ozoneAbs),
    uSolar: vec4s(atm.solar),
    uAlbedo: vec4s(atm.albedo),
    uLdExp: vec4s(ld),
    uCmfX: vec4s(scale(w.x)),
    uCmfY: vec4s(scale(w.y)),
    uCmfZ: vec4s(scale(w.z)),
  };
  const alpha = atm.sunAngularRadius;
  const scalars: Record<string, number | number[]> = {
    uBottomR: atm.bottomRadius,
    uTopR: atm.topRadius,
    uMolInvH: 1 / atm.molScaleHeight,
    uProfA:
      profA.kind === 'exponential'
        ? [0, 1 / profA.scaleHeight, 0]
        : [1, 1 / profA.width, profA.centre],
    uProfB: !profB
      ? [0, 0, 0, 0]
      : profB.kind === 'exponential'
        ? [0, 1 / profB.scaleHeight, 0, 1]
        : [1, 1 / profB.width, profB.centre, 1],
    uRayleighGamma: atm.rayleighGamma,
    uSunAngR: alpha,
    uSunOmega: 2 * Math.PI * (1 - Math.cos(alpha)),
    uDust: atm.dust ? 1 : 0,
  };
  let dustPhase: Float32Array | null = null;
  if (atm.dust) {
    dustPhase = new Float32Array(PHASE_ANGLES * GPU_WAVELENGTHS);
    dustPhase.set(atm.dust.phase);
  }
  return { vectors, scalars, lut, irradiance, dustPhase };
}

/** Terrain constants (static). */
export function terrainUniforms() {
  const ridge = new Float32Array(12);
  const bump = new Float32Array(18 * 3);
  const term = new Float32Array(9 * 3);
  RIDGES.forEach((r, k) => {
    ridge.set([r.distance, r.base, r.slope, 0], k * 4);
    r.bumps.slice(0, 6).forEach((b, j) => bump.set(b, (k * 6 + j) * 3));
    r.terms.slice(0, 3).forEach((t, j) => term.set(t, (k * 3 + j) * 3));
  });
  return {
    uRidge: ridge,
    uBump: bump,
    uTerm: term,
    uFloorDepth: FLOOR_DEPTH,
    uFloorElevation: FLOOR_ELEVATION,
    uRimAngle: RIM_ANGLE,
  };
}

/** The XYZ → linear sRGB matrix as GLSL mat3 column literals. */
export function xyzToSrgbGlsl(): string {
  const m = XYZ_TO_LINEAR_SRGB; // row-major
  const cols = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  return cols.map((v) => v.toPrecision(10)).join(', ');
}

// --- half floats --------------------------------------------------------------------------------

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE 754 binary16 from a number (round to nearest even, saturating to ±65504). */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | (mant ? 0x7e00 : 0x7c00);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7bff; // saturate to max finite
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  if ((half & 0x7c00) === 0x7c00) return sign | 0x7bff;
  return sign | half;
}

export function toHalfArray(values: ArrayLike<number>): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = toHalf(values[i]);
  return out;
}

/** Irradiance table as an IRR_N × 4 RGBA image (row g holds wavelengths 4g … 4g + 3). */
export function irradianceTexels(table: IrradianceTable): Float32Array {
  const rows = table.muS.length;
  const out = new Float32Array(rows * 4 * 4);
  for (let g = 0; g < 4; g++) {
    for (let m = 0; m < rows; m++) {
      for (let c = 0; c < 4; c++)
        out[(g * rows + m) * 4 + c] = table.values[m * table.n + g * 4 + c];
    }
  }
  return out;
}
