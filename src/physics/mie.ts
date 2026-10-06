/**
 * Lorenz–Mie scattering by a homogeneous sphere.
 *
 * Follows the BHMIE algorithm of Bohren & Huffman (1983), "Absorption and Scattering of Light by
 * Small Particles", Appendix A (with B. T. Draine's corrections): logarithmic derivative D_n by
 * downward recurrence, Riccati–Bessel functions by upward recurrence, series truncated at
 * x + 4x^{1/3} + 2 terms. Complex refractive index m = n + ik with k ≥ 0 for absorption.
 * Unlike BHMIE, the amplitude functions are evaluated on an arbitrary list of angles.
 */

export interface MieResult {
  qext: number;
  qsca: number;
  qback: number;
  /** Asymmetry parameter ⟨cos θ⟩. */
  g: number;
  /** ½(|S1|² + |S2|²) at each requested angle (dimensionless, Bohren & Huffman normalisation). */
  intensity: Float64Array;
}

/**
 * @param x size parameter 2πr/λ (> 0)
 * @param n real part of the relative refractive index
 * @param k imaginary part (≥ 0, absorbing)
 * @param mus cosines of the scattering angles at which to evaluate the phase function
 */
export function mieSphere(x: number, n: number, k: number, mus: ArrayLike<number> = []): MieResult {
  if (!(x > 0) || !Number.isFinite(x))
    throw new RangeError('size parameter must be a positive number');
  if (!(n > 0) || k < 0) throw new RangeError('refractive index must have n > 0 and k ≥ 0');

  const nang = mus.length;
  // y = m·x
  const yr = n * x;
  const yi = k * x;
  const ymod = Math.hypot(yr, yi);
  const xstop = x + 4 * Math.cbrt(x) + 2;
  const nstop = Math.round(xstop);
  // BHMIE starts the downward recurrence 15 terms above max(xstop, |mx|). That converges too
  // slowly when n is close to |mx| (Wiscombe case m = 1.33, x = 100 is off by 2e-5), so start
  // with a margin that grows with |mx|.
  const nmx = Math.round(Math.max(xstop, ymod) + 16 + 8 * Math.cbrt(ymod));

  // D_n(y) by downward recurrence from D_nmx = 0: D_{n-1} = n/y − 1/(D_n + n/y).
  const dRe = new Float64Array(nmx + 1);
  const dIm = new Float64Array(nmx + 1);
  const inv = 1 / (yr * yr + yi * yi); // 1/y = conj(y)/|y|²
  const iyRe = yr * inv;
  const iyIm = -yi * inv;
  for (let j = nmx; j >= 2; j--) {
    // en/y
    const ar = j * iyRe;
    const ai = j * iyIm;
    // D_j + en/y
    const br = dRe[j] + ar;
    const bi = dIm[j] + ai;
    const bm = br * br + bi * bi;
    // en/y − 1/b
    dRe[j - 1] = ar - br / bm;
    dIm[j - 1] = ai + bi / bm;
  }

  // Riccati–Bessel ψ and χ with real argument, upward recurrence.
  let psi0 = Math.cos(x);
  let psi1 = Math.sin(x);
  let chi0 = -Math.sin(x);
  let chi1 = Math.cos(x);
  // ξ_{n-1} = ψ_{n-1} − iχ_{n-1}
  let xi1r = psi1;
  let xi1i = -chi1;

  // Angular functions π_n, plus amplitude sums.
  const pi0 = new Float64Array(nang);
  const pi1 = new Float64Array(nang).fill(1);
  const s1r = new Float64Array(nang);
  const s1i = new Float64Array(nang);
  const s2r = new Float64Array(nang);
  const s2i = new Float64Array(nang);

  // m and 1/m for the a_n, b_n formulas.
  const mm = n * n + k * k;
  const imRe = n / mm;
  const imIm = -k / mm;

  let qsca = 0;
  let gsum = 0;
  let an1r = 0;
  let an1i = 0;
  let bn1r = 0;
  let bn1i = 0;
  // Forward (θ = 0) and backward (θ = π) amplitudes for Qext and Qback.
  let s1fr = 0;
  let sbr = 0;
  let sbi = 0;

  for (let j = 1; j <= nstop; j++) {
    const en = j;
    const fn = (2 * en + 1) / (en * (en + 1));
    const psi = ((2 * en - 1) * psi1) / x - psi0;
    const chi = ((2 * en - 1) * chi1) / x - chi0;
    const xir = psi;
    const xii = -chi;

    // a_n = [(D_n/m + n/x) ψ_n − ψ_{n−1}] / [(D_n/m + n/x) ξ_n − ξ_{n−1}]
    const dmr = dRe[j] * imRe - dIm[j] * imIm + en / x;
    const dmi = dRe[j] * imIm + dIm[j] * imRe;
    let numr = dmr * psi - psi1;
    let numi = dmi * psi;
    let denr = dmr * xir - dmi * xii - xi1r;
    let deni = dmr * xii + dmi * xir - xi1i;
    let dm = denr * denr + deni * deni;
    const anr = (numr * denr + numi * deni) / dm;
    const ani = (numi * denr - numr * deni) / dm;

    // b_n = [(m D_n + n/x) ψ_n − ψ_{n−1}] / [(m D_n + n/x) ξ_n − ξ_{n−1}]
    const mdr = n * dRe[j] - k * dIm[j] + en / x;
    const mdi = n * dIm[j] + k * dRe[j];
    numr = mdr * psi - psi1;
    numi = mdi * psi;
    denr = mdr * xir - mdi * xii - xi1r;
    deni = mdr * xii + mdi * xir - xi1i;
    dm = denr * denr + deni * deni;
    const bnr = (numr * denr + numi * deni) / dm;
    const bni = (numi * denr - numr * deni) / dm;

    qsca += (2 * en + 1) * (anr * anr + ani * ani + bnr * bnr + bni * bni);
    gsum += ((2 * en + 1) / (en * (en + 1))) * (anr * bnr + ani * bni);
    if (j > 1) {
      gsum += (((en - 1) * (en + 1)) / en) * (an1r * anr + an1i * ani + bn1r * bnr + bn1i * bni);
    }
    an1r = anr;
    an1i = ani;
    bn1r = bnr;
    bn1i = bni;

    // Forward: π_n(1) = τ_n(1) = n(n+1)/2 → S1(0) = Σ (2n+1)/2 (a_n + b_n).
    s1fr += ((2 * en + 1) / 2) * (anr + bnr);
    // Backward: π_n(−1) = −τ_n(−1) = (−1)^{n+1} n(n+1)/2 → S1(π) = Σ (2n+1)/2 (−1)^{n+1}(a_n − b_n).
    const sign = j % 2 === 1 ? 1 : -1;
    sbr += ((2 * en + 1) / 2) * sign * (anr - bnr);
    sbi += ((2 * en + 1) / 2) * sign * (ani - bni);

    for (let a = 0; a < nang; a++) {
      const mu = mus[a];
      const p = pi1[a];
      const t = en * mu * p - (en + 1) * pi0[a];
      s1r[a] += fn * (anr * p + bnr * t);
      s1i[a] += fn * (ani * p + bni * t);
      s2r[a] += fn * (anr * t + bnr * p);
      s2i[a] += fn * (ani * t + bni * p);
      // π_{n+1} = ((2n+1) μ π_n − (n+1) π_{n−1}) / n
      pi1[a] = ((2 * en + 1) * mu * p - (en + 1) * pi0[a]) / en;
      pi0[a] = p;
    }

    psi0 = psi1;
    psi1 = psi;
    chi0 = chi1;
    chi1 = chi;
    xi1r = psi1;
    xi1i = -chi1;
  }

  const g = (2 * gsum) / qsca;
  const intensity = new Float64Array(nang);
  for (let a = 0; a < nang; a++) {
    intensity[a] = 0.5 * (s1r[a] * s1r[a] + s1i[a] * s1i[a] + s2r[a] * s2r[a] + s2i[a] * s2i[a]);
  }
  return {
    qext: (4 / (x * x)) * s1fr,
    qsca: (2 / (x * x)) * qsca,
    qback: (4 * (sbr * sbr + sbi * sbi)) / (x * x),
    g,
    intensity,
  };
}
