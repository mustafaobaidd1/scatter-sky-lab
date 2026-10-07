import { describe, expect, it } from 'vitest';
import { irradianceTexels, toHalf, toHalfArray, xyzToSrgbGlsl } from './gpuData';

describe('half-float encoding', () => {
  it.each([
    [0, 0x0000],
    [1, 0x3c00],
    [0.5, 0x3800],
    [-2, 0xc000],
    [0.1, 0x2e66],
    [65504, 0x7bff],
    [6.103515625e-5, 0x0400],
    [5.960464477539063e-8, 0x0001],
  ])('encodes %f as 0x%s', (v, bits) => {
    expect(toHalf(v)).toBe(bits);
  });

  it('saturates instead of producing infinities, and keeps NaN as NaN', () => {
    expect(toHalf(1e9)).toBe(0x7bff);
    expect(toHalf(-1e9)).toBe(0xfbff);
    expect(toHalf(Number.NaN) & 0x7c00).toBe(0x7c00);
    expect(toHalfArray([1, 2]).length).toBe(2);
  });
});

describe('texture packing', () => {
  it('groups irradiance wavelengths four to a texel row', () => {
    const values = new Float64Array(3 * 16).map((_, i) => i);
    const tex = irradianceTexels({ muS: new Float64Array(3), values, n: 16 });
    // row g = 1 (wavelengths 4..7), column m = 2 → values[2*16 + 4..7]
    expect(Array.from(tex.slice((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4))).toEqual([36, 37, 38, 39]);
  });

  it('writes the XYZ→sRGB matrix as nine GLSL column literals', () => {
    expect(xyzToSrgbGlsl().split(',').length).toBe(9);
  });
});
