/**
 * Spectral sampling.
 *
 * All source data live on a 5 nm grid from 360 to 830 nm. The renderer works with a small set of
 * sample wavelengths (16 by default, 380–720 nm). A sampled spectrum is interpreted as piecewise
 * linear between samples (constant beyond the end samples), so:
 *   - tabulated inputs (solar irradiance, ozone cross-section) are reduced to the samples by a
 *     hat-weighted average, which avoids aliasing narrow lines, and
 *   - converting a sampled spectrum to CIE XYZ uses weights W_i = ∫ cmf(λ) φ_i(λ) dλ, where φ_i is
 *     the linear-interpolation basis function of sample i.
 */

export const DATA_START = 360;
export const DATA_STEP = 5;
export const DATA_COUNT = 95;
export const DATA_END = DATA_START + DATA_STEP * (DATA_COUNT - 1); // 830

/** Fine integration step used for all numerical spectral integrals, nm. */
const SUB_STEP = 0.5;

/** Linear interpolation of a 5 nm data table at wavelength λ (nm), clamped to the table range. */
export function sampleTable(table: readonly number[], lambda: number): number {
  const x = (lambda - DATA_START) / DATA_STEP;
  if (x <= 0) return table[0];
  if (x >= DATA_COUNT - 1) return table[DATA_COUNT - 1];
  const i = Math.floor(x);
  const t = x - i;
  return table[i] * (1 - t) + table[i + 1] * t;
}

/** `count` evenly spaced wavelengths from `min` to `max` inclusive, nm. */
export function wavelengthGrid(count: number, min = 380, max = 720): Float64Array {
  if (!(count >= 2) || !Number.isInteger(count)) throw new RangeError('count must be an integer ≥ 2');
  if (!(max > min)) throw new RangeError('max must exceed min');
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = min + ((max - min) * i) / (count - 1);
  return out;
}

/**
 * Value of the linear-interpolation basis function φ_i at λ for a sorted sample grid.
 * Beyond the first/last sample the end functions extend as constants (φ_0 = 1 below the grid,
 * φ_last = 1 above it), so Σ_i φ_i(λ) = 1 everywhere.
 */
export function basisValue(grid: ArrayLike<number>, i: number, lambda: number): number {
  const n = grid.length;
  const li = grid[i];
  if (lambda === li) return 1;
  if (lambda < li) {
    if (i === 0) return 1;
    const lo = grid[i - 1];
    return lambda <= lo ? 0 : (lambda - lo) / (li - lo);
  }
  if (i === n - 1) return 1;
  const hi = grid[i + 1];
  return lambda >= hi ? 0 : (hi - lambda) / (hi - li);
}

/**
 * Hat-weighted average of a 5 nm table around each sample wavelength. The hat for sample i spans
 * its neighbours (the end hats are mirrored), clipped to the data range.
 */
export function hatAverage(table: readonly number[], grid: ArrayLike<number>): Float64Array {
  const n = grid.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const li = grid[i];
    const left = i > 0 ? li - grid[i - 1] : grid[1] - grid[0];
    const right = i < n - 1 ? grid[i + 1] - li : grid[n - 1] - grid[n - 2];
    const a = Math.max(DATA_START, li - left);
    const b = Math.min(DATA_END, li + right);
    let num = 0;
    let den = 0;
    const steps = Math.max(2, Math.ceil((b - a) / SUB_STEP));
    const h = (b - a) / steps;
    for (let k = 0; k <= steps; k++) {
      const l = a + k * h;
      const w = l < li ? 1 - (li - l) / left : 1 - (l - li) / right;
      const trap = k === 0 || k === steps ? 0.5 : 1;
      num += trap * w * sampleTable(table, l);
      den += trap * w;
    }
    out[i] = den > 0 ? num / den : sampleTable(table, li);
  }
  return out;
}

/**
 * Integration weights W_i = ∫ f(λ) φ_i(λ) dλ over the data range, for a 5 nm table f (e.g. a
 * colour-matching function). Then ∫ f(λ) S(λ) dλ ≈ Σ_i W_i S_i for a spectrum sampled on `grid`.
 */
export function basisIntegrals(table: readonly number[], grid: ArrayLike<number>): Float64Array {
  const n = grid.length;
  const out = new Float64Array(n);
  const steps = Math.round((DATA_END - DATA_START) / SUB_STEP);
  // Walk the fine grid once; for each point only two basis functions are non-zero.
  for (let k = 0; k <= steps; k++) {
    const l = DATA_START + k * SUB_STEP;
    const f = sampleTable(table, l) * SUB_STEP * (k === 0 || k === steps ? 0.5 : 1);
    if (l <= grid[0]) {
      out[0] += f;
      continue;
    }
    if (l >= grid[n - 1]) {
      out[n - 1] += f;
      continue;
    }
    let j = 0;
    while (grid[j + 1] < l) j++;
    const t = (l - grid[j]) / (grid[j + 1] - grid[j]);
    out[j] += f * (1 - t);
    out[j + 1] += f * t;
  }
  return out;
}

/** Linear interpolation of a sampled spectrum (constant beyond the ends). */
export function interpolateSamples(
  grid: ArrayLike<number>,
  values: ArrayLike<number>,
  lambda: number,
): number {
  const n = grid.length;
  if (lambda <= grid[0]) return values[0];
  if (lambda >= grid[n - 1]) return values[n - 1];
  let j = 0;
  while (grid[j + 1] < lambda) j++;
  const t = (lambda - grid[j]) / (grid[j + 1] - grid[j]);
  return values[j] * (1 - t) + values[j + 1] * t;
}
