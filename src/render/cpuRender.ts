/** CPU renderer: the reference image path, also the fallback when WebGL2 is unavailable. */
import {
  cmfWeights,
  radianceToXyz,
  srgbEncode,
  xyzToLinearSrgb,
  type CmfWeights,
  type Vec3,
} from '../physics/colour';
import type { Scene } from '../physics/sky';
import { toneMap, type ToneMap } from '../physics/tonemap';
import { type CameraBasis, pixelAngle, pixelRay } from './camera';
import { shadeDirection } from './shade';

/** Display sRGB (0–1, encoded) of a spectral radiance: XYZ → linear sRGB → exposure → tone map → sRGB. */
export function radianceToDisplay(
  radiance: ArrayLike<number>,
  w: CmfWeights,
  exposure: number,
  kind: ToneMap = 'filmic',
): Vec3 {
  const rgb = xyzToLinearSrgb(radianceToXyz(radiance, w));
  const t = toneMap([rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure], kind);
  return [srgbEncode(t[0]), srgbEncode(t[1]), srgbEncode(t[2])];
}

/** Interleaved gradient noise (Jimenez 2014) in [0, 1): the same dither as the shader. */
export function ign(x: number, y: number): number {
  const v = 52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1);
  return v - Math.floor(v);
}

export interface CpuFrame {
  scene: Scene;
  basis: CameraBasis;
  width: number;
  height: number;
  exposure: number;
  steps: number;
  toneMap: ToneMap;
}

/**
 * Renders rows [y0, y1) into an RGBA8 buffer. `rowOffset` is the frame row stored at the start of
 * `out` (0 when `out` holds the whole frame).
 */
export function renderRows(
  frame: CpuFrame,
  y0: number,
  y1: number,
  out: Uint8ClampedArray,
  rowOffset = 0,
): void {
  const { scene, basis, width, height, exposure, steps, toneMap: kind } = frame;
  const w = cmfWeights(scene.atm.lambdas);
  const pa = pixelAngle(basis, height);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const dir = pixelRay(basis, x, y, width, height);
      const res = shadeDirection(scene, dir, { steps, pixelAngle: pa });
      const c = radianceToDisplay(res.radiance, w, exposure, kind);
      const d = (ign(x, y) - 0.5) / 255;
      const o = ((y - rowOffset) * width + x) * 4;
      out[o] = Math.round((c[0] + d) * 255);
      out[o + 1] = Math.round((c[1] + d) * 255);
      out[o + 2] = Math.round((c[2] + d) * 255);
      out[o + 3] = 255;
    }
  }
}
