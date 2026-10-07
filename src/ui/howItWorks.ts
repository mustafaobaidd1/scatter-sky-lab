/** "How it works": model, equations, approximations and validation. Loaded on first open. */
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { SkyView } from '../app/skyView';
import validation from '../generated/validation.json';
import { icons } from './icons';

const tex = (s: string, display = true) =>
  katex.renderToString(s, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
const eq = (s: string) => `<div class="eq">${tex(s)}</div>`;
const inl = (s: string) => tex(s, false);

export function renderHowItWorks(dialog: HTMLDialogElement, _view: SkyView): void {
  const v = validation;
  const q = v.qualitative;
  dialog.innerHTML = `
    <div class="how__head">
      <h2 id="how-title">How it works</h2>
      <button class="icon-btn" type="button" data-close aria-label="Close how it works">${icons.close}</button>
    </div>
    <div class="how__body">
      <p><strong>What this is.</strong> An educational, physically based simulation: single scattering of
      sunlight by air molecules and aerosols, with ozone absorption, computed at 16 wavelengths between
      380 and 720 nm and turned into colour with the CIE 1931 observer. The scattering physics is checked
      against published values (below); the scenery, exposure and tone mapping are illustrative choices.</p>

      <h3>1 · Light scattered into the eye</h3>
      <p>For each pixel the renderer marches along the view ray and adds up sunlight scattered toward the
      eye, attenuated on the way in and on the way out (the single-scattering integral):</p>
      ${eq(String.raw`L(\lambda)=\int_0^{d} T(0,t;\lambda)\,E_\odot(\lambda)\,T_\odot(t;\lambda)\sum_k \beta_k(\lambda)\,\rho_k\!\big(h(t)\big)\,P_k(\theta,\lambda)\,dt\;+\;T(0,d;\lambda)\,L_{\mathrm{ground}}`)}
      ${eq(String.raw`T(a,b;\lambda)=\exp\!\Big(-\!\int_a^b \sum_k \beta^{\mathrm{ext}}_k(\lambda)\,\rho_k\big(h(s)\big)\,ds\Big)`)}
      <p>${inl(String.raw`E_\odot`)} is the extraterrestrial solar spectrum (ASTM G173), ${inl(String.raw`T_\odot`)}
      the transmittance from the scattering point to the Sun (zero in the planet's shadow, softened across the
      solar disc), ${inl(String.raw`\beta_k\rho_k`)} the scattering coefficient of molecules, aerosols and
      ozone at height ${inl('h')}, and ${inl('P_k')} their phase functions. The integral uses 48 samples
      (24 while you drag), spaced quadratically away from the lowest point of the ray, with the exact
      solution for constant extinction within each step.</p>

      <h3>2 · Molecules: Rayleigh scattering</h3>
      <p>The cross-section of standard air follows Bodhaine et al. (1999):</p>
      ${eq(String.raw`\sigma(\lambda)=\frac{24\pi^3}{\lambda^4 N_s^2}\left(\frac{n_s^2-1}{n_s^2+2}\right)^{\!2} F_K(\lambda)`)}
      <p>with the refractive index ${inl('n_s')} of Peck &amp; Reeder (1972), ${inl(String.raw`N_s = 2.546899\times10^{19}\ \mathrm{cm^{-3}}`)}
      and the King factor ${inl('F_K')} of Bates (1984), which corrects for the anisotropy of N₂ and O₂ (≈ 1.049
      at 550 nm). The λ⁻⁴ law is why blue is scattered so much more than red; dispersion of ${inl('n_s')} makes
      the effective exponent about 4.08. The phase function includes depolarisation:</p>
      ${eq(String.raw`P_R(\theta)=\frac{3}{16\pi}\,\frac{(1+3\gamma)+(1-\gamma)\cos^2\theta}{1+2\gamma},\qquad \gamma=\frac{\rho}{2-\rho}`)}
      <p>Density falls as ${inl(String.raw`e^{-h/H}`)} with ${inl(String.raw`H = 8.45`)} km, chosen so the column equals
      Bodhaine's. Many real-time renderers use 5.8, 13.6 and 33.1 × 10⁻⁶ m⁻¹ at 680, 550 and 440 nm; those
      numbers come from rounding ${inl('n')} to 1.0003 with a depolarisation of 0.035 and are
      ${Math.round((v.renderingConstants[1].ratio - 1) * 100)} % above the physical sea-level values used here.</p>
      <table>
        <thead><tr><th>λ (nm)</th><th>τ, Bodhaine et al.</th><th>τ, this model</th><th>difference</th></tr></thead>
        <tbody>${v.rayleigh
          .map(
            (r) =>
              `<tr><td>${r.nm}</td><td>${r.tauRef}</td><td>${r.tauModel}</td><td>${r.tauDiffPercent >= 0 ? '+' : ''}${r.tauDiffPercent} %</td></tr>`,
          )
          .join('')}</tbody>
      </table>

      <h3>3 · Aerosols and dust: Mie scattering</h3>
      <p>Earth's aerosol layers follow the Ångström law, with single-scattering albedo ${inl(String.raw`\omega(\lambda)`)}
      and asymmetry ${inl(String.raw`g(\lambda)`)} rounded from the AERONET climatology (Dubovik et al. 2002):</p>
      ${eq(String.raw`\tau(\lambda)=\tau_{550}\left(\frac{\lambda}{550\ \mathrm{nm}}\right)^{-\alpha},\qquad P_{CS}(\theta)=\frac{3}{8\pi}\frac{(1-g^2)(1+\cos^2\theta)}{(2+g^2)(1+g^2-2g\cos\theta)^{3/2}}`)}
      <p>The Cornette–Shanks parameter is solved so that its mean cosine equals the measured asymmetry. The
      volcanic preset adds a sulfate layer centred at 20 km (post-Pinatubo, τ ≈ 0.15). On Mars, the dust's
      optical properties come from Mie theory (Bohren &amp; Huffman's algorithm) over a lognormal size
      distribution (${inl(String.raw`r_{\mathrm{eff}}=1.5\ \mu\mathrm m,\ v_{\mathrm{eff}}=0.3`)}) with the refractive
      index of Wolff et al. (2009). The dust absorbs blue (${inl(String.raw`\omega_{440}=`)} ${v.dust.ssa440},
      ${inl(String.raw`\omega_{670}=`)} ${v.dust.ssa670}), but its diffraction peak is narrower and stronger in blue: 3° from
      the Sun its phase function is ${v.dust.forwardPeakRatio3deg}× higher at 440 nm than at 670 nm, which near the Sun
      outweighs the absorption. That is the blue sunset.</p>

      <h3>4 · Ozone</h3>
      <p>300 Dobson units in a layer peaking at 25 km absorb with the cross-sections of Serdyuchenko et al. (2014,
      223 K). The Chappuis band near 600 nm barely matters at noon, but at twilight sunlight reaches the zenith
      after a long grazing path through the ozone layer, which removes orange and keeps the blue hour blue.</p>

      <h3>5 · Precomputed transmittance</h3>
      <p>Sunlight reaching every sample point needs its own transmittance integral. As in Bruneton (2017) and
      Hillaire (2020) it comes from a precomputed table indexed by radius and zenith angle, but the table stores
      the <em>columns</em> ${inl(String.raw`D_k=\int\rho_k\,ds`)} of each constituent rather than spectral transmittance,
      so ${inl(String.raw`T(\lambda)=\exp(-\sum_k\beta_k(\lambda)D_k)`)} for any wavelength and any experiment without a rebuild.
      Accuracy against a 4000-step integral: ${v.lutWorstRelativePercent} % worst case where τ &gt; 0.1.</p>

      <h3>6 · The Sun</h3>
      <p>The disc (0.27° radius from Earth, 0.17° from Mars) uses the wavelength-dependent limb darkening of
      Hestroffer &amp; Magnan (1998), ${inl(String.raw`I(\mu)/I(1)=\mu^{\,\alpha(\lambda)}`)} with ${inl(String.raw`\alpha=-0.023+0.292/\lambda[\mu\mathrm m]`)},
      normalised so the disc delivers exactly the solar irradiance. Zoom on the Sun in the View panel to see its
      darker, redder limb and its reddening near the horizon.</p>

      <h3>7 · From spectrum to pixel</h3>
      ${eq(String.raw`X=683\int L(\lambda)\,\bar x(\lambda)\,d\lambda,\quad Y=683\int L\,\bar y\,d\lambda,\quad Z=683\int L\,\bar z\,d\lambda`)}
      <p>The 16 samples are treated as a piecewise-linear spectrum, so the integrals become fixed weights per
      sample. XYZ (with Y in cd/m²) goes to linear sRGB (D65), is scaled by an exposure from a sky-weighted light
      meter (key after Krawczyk et al. 2005, so bright skies look bright and twilight stays dim), and passes
      through AgX, a filmic curve, with a look tuned for skies (more saturation, less contrast than its
      "Punchy" preset) before sRGB encoding. The Neutral option (Khronos PBR Neutral) instead passes mid-tones almost linearly, keeping their hue, and compresses only the highlights. 16 samples reproduce the 5 nm reference to
      ΔE*ab ≤ ${Math.max(...v.sampling.map((s) => s.deltaE))}.</p>

      <h3>8 · What is approximated</h3>
      <ul>
        <li><strong>Single scattering only.</strong> Light scattered twice or more is ignored, so the horizon and
        deep twilight are darker and slightly more saturated than in reality.</li>
        <li><strong>No polarisation and no refraction</strong>: the setting Sun is not flattened and appears a
        little later than in reality.</li>
        <li><strong>Idealised profiles</strong>: exponential air and aerosols, a triangular ozone layer, a smooth
        spherical planet. The hills, the ground albedos and skylight on surfaces are simplified scenery.</li>
        <li><strong>Martian dust as spheres</strong>; real grains are irregular (the forward peak that makes the
        blue sunset is the part spheres represent best).</li>
        <li><strong>Perception</strong>: exposure and tone mapping are display choices, not measurements.</li>
      </ul>

      <h3>9 · Validation</h3>
      <table>
        <thead><tr><th>Check</th><th>Expected</th><th>Model</th></tr></thead>
        <tbody>
          <tr><td>Zenith transmittance = exp(−τ<sub>R</sub>−τ<sub>A</sub>−τ<sub>O₃</sub>)</td><td>identity</td><td>worst ${v.zenithTransmittanceWorstPercent} %</td></tr>
          <tr><td>D65 white → equal linear sRGB</td><td>equal</td><td>${v.d65BalancePercent} %</td></tr>
          <tr><td>Horizon air mass, √(πR/2H)</td><td>${v.chapmanHorizon}</td><td>${v.airMass[3].model}</td></tr>
          ${v.mie.map((m) => `<tr><td>Mie ${m.case}: Q<sub>sca</sub></td><td>${m.qscaRef}</td><td>${m.qsca}</td></tr>`).join('')}
          <tr><td>Martian dust ω at 650 nm (Wolff et al. 2009)</td><td>${v.dust.ssa650Ref}</td><td>${v.dust.ssa650}</td></tr>
          <tr><td>Noon zenith: dominant wavelength</td><td>blue, 465–490 nm</td><td>${q.noonZenith.dominant} nm</td></tr>
          <tr><td>Horizon beside a setting Sun</td><td>orange-red, 580–620 nm</td><td>${q.sunsetHorizon.dominant} nm</td></tr>
          <tr><td>λ⁰ sky: purity</td><td>near neutral</td><td>${(q.lambda0Zenith.purity * 100).toFixed(1)} %</td></tr>
          <tr><td>Blue-hour zenith with / without ozone</td><td>blue / yellowish</td><td>${q.blueHourZenithOzone.dominant} / ${q.blueHourZenithNoOzone.dominant} nm</td></tr>
          <tr><td>Mars: noon zenith</td><td>butterscotch</td><td>${q.marsNoonZenith.dominant} nm</td></tr>
          <tr><td>Mars: 3° from the setting Sun</td><td>bluish</td><td>${q.marsBesideSettingSun.dominant} nm</td></tr>
        </tbody>
      </table>
      <p>All values are produced by <code>npm run validate</code> (${v.generated}); the unit tests assert them with
      tolerances. The WebGL shader is tested against the CPU reference to within 1/255 per channel.</p>

      <h3>Data and credits</h3>
      <ul>
        <li>CIE 1931 2° colour-matching functions and illuminant D65: CIE (2019), CC BY-SA 4.0.</li>
        <li>Solar spectrum: ASTM G173-03 extraterrestrial column, U.S. DOE National Laboratory of the Rockies (NREL).</li>
        <li>Ozone cross-sections: Serdyuchenko, Gorshelev, Weber, Chehade &amp; Burrows (2014), IUP Bremen.</li>
        <li>Rayleigh method: Bodhaine, Wood, Dutton &amp; Slusser (1999); Bates (1984); Peck &amp; Reeder (1972).</li>
        <li>Aerosol optics: Dubovik et al. (2002). Mars dust: Wolff et al. (2009); Lemmon et al. (2004). Mars data: NASA NSSDC.</li>
        <li>Mie algorithm: Bohren &amp; Huffman (1983); test cases from Wiscombe (1979).</li>
        <li>Precomputed transmittance parametrisation: Bruneton (2017); Hillaire (2020).</li>
        <li>AgX tone mapping: three.js (MIT), Filament (Apache-2.0), B. Wrensch (MIT). Fonts: Fraunces and Inter (OFL).</li>
      </ul>
    </div>`;
  dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
}
