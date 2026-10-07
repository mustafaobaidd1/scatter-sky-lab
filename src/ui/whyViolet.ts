/**
 * "Why not violet?": the zenith sky spectrum from the model (it peaks toward violet), sunlight,
 * and the same sky weighted by the eye's luminous efficiency ȳ(λ); swatches compare the colour
 * of the whole spectrum with the colour of its peak wavelength.
 */
import type { SkyView } from '../app/skyView';
import { CIE_Y_5NM } from '../physics/data/cie';
import { spectralSwatch, toHex } from '../physics/colour';
import { sampleTable } from '../physics/spectral';
import { spectrumChart } from './charts';
import { fmt } from './dom';

export function renderWhyViolet(host: HTMLElement, view: SkyView): void {
  const p = view.probe([0, 1, 0]);
  if (!p) {
    host.innerHTML = '<p class="note">Waiting for the atmosphere…</p>';
    return;
  }
  const n = p.lambdas.length;
  const sky = p.radiance;
  const eye = new Float64Array(n);
  let peak = p.lambdas[0];
  let peakV = -1;
  for (let i = 0; i < n; i++) {
    eye[i] = sky[i] * sampleTable(CIE_Y_5NM, p.lambdas[i]);
    if (sky[i] > peakV) {
      peakV = sky[i];
      peak = p.lambdas[i];
    }
  }
  const dom = p.stats.dominant;
  const domText =
    dom && !dom.complementary ? `${Math.round(dom.wavelength)} nm` : 'none (near white)';
  const perceived = toHex(p.display);
  const peakHex = toHex(spectralSwatch(peak));
  host.innerHTML = `
    ${spectrumChart({
      lambdas: p.lambdas,
      series: [
        { values: sky, label: 'Sky at the zenith', style: 'fill' },
        { values: p.solar, label: 'Sunlight', style: 'dash' },
        { values: eye, label: 'Sky × eye sensitivity', style: 'thin' },
      ],
      title: 'Why the sky is not violet',
      desc: `The zenith spectrum peaks at ${Math.round(peak)} nm, but weighted by the eye's sensitivity it peaks near ${Math.round(argmax(p.lambdas, eye))} nm; the mixture looks pale blue.`,
    })}
    <div class="legend" aria-hidden="true">
      <span><i></i>Zenith sky</span><span><i class="dash"></i>Sunlight</span><span><i style="opacity:.7;border-top-width:1px"></i>× eye sensitivity ȳ</span>
    </div>
    <div class="swatch-row">
      <div class="swatch" style="background:${perceived}" role="img" aria-label="Colour of the whole zenith spectrum"></div>
      <dl class="readouts">
        <dt>Seen colour</dt><dd>dominant ${domText}</dd>
        <dt>Spectrum peak</dt><dd>${Math.round(peak)} nm <span class="swatch-inline" style="display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;background:${peakHex}"></span></dd>
        <dt>Purity</dt><dd>${dom ? fmt(dom.purity * 100, 0) + ' %' : '—'}</dd>
      </dl>
    </div>
    <p class="note">Air scatters violet most strongly, and this sky's spectrum peaks near ${Math.round(peak)} nm. But sunlight holds less violet than blue to begin with, the eye is barely sensitive below 430 nm, and it sums every wavelength, so the mixture looks <strong>pale blue</strong>, not violet.</p>`;
}

function argmax(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] > ys[best]) best = i;
  return xs[best];
}
