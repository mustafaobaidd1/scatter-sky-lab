import {
  chromaticity,
  cmfWeights,
  D65_XYZ,
  dominantWavelength,
  labToLch,
  radianceToXyz,
  type DominantWavelength,
  type Vec3,
  xyzToLab,
} from './colour';

export interface ColourStats {
  xyz: Vec3;
  /** Luminance, cd/m². */
  luminance: number;
  xy: [number, number];
  /** CIELAB hue angle (degrees) and chroma relative to D65 at the colour's own luminance. */
  hue: number;
  chroma: number;
  a: number;
  b: number;
  dominant: DominantWavelength | null;
}

const weightCache = new WeakMap<Float64Array, ReturnType<typeof cmfWeights>>();

/** Colorimetric summary of a spectral radiance sampled on `lambdas`. */
export function colourStats(lambdas: Float64Array, radiance: ArrayLike<number>): ColourStats {
  let w = weightCache.get(lambdas);
  if (!w) {
    w = cmfWeights(lambdas);
    weightCache.set(lambdas, w);
  }
  const xyz = radianceToXyz(radiance, w);
  const Y = Math.max(xyz[1], 1e-30);
  const white: Vec3 = [D65_XYZ[0] * Y, Y, D65_XYZ[2] * Y];
  const lab = xyzToLab(xyz, white);
  const lch = labToLch(lab);
  const xy = chromaticity(xyz);
  return {
    xyz,
    luminance: xyz[1],
    xy,
    hue: lch.h,
    chroma: lch.C,
    a: lab[1],
    b: lab[2],
    dominant: dominantWavelength(xy),
  };
}
