/** Spectrum probe: the spectral radiance reaching the eye from one direction. */
import type { ProbeResult, SkyView } from '../app/skyView';
import type { Store } from '../app/state';
import { toHex } from '../physics/colour';
import { dirFromAngles, type Vec3 } from '../physics/sky';
import { niceTicks, spectrumChart } from './charts';
import { fmt } from './dom';
import { icons } from './icons';

export interface ProbePanel {
  probe(dir: Vec3): ProbeResult | null;
  clear(): void;
  refresh(): void;
  get direction(): Vec3 | null;
}

const KIND_LABEL: Record<string, string> = {
  sky: 'sky',
  terrain: 'hillside',
  ground: 'ground',
  sun: 'solar disc',
  space: 'space',
};

function angleTo(a: Vec3, b: Vec3): number {
  const c = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return (Math.acos(c) * 180) / Math.PI;
}

export function mountProbe(
  host: HTMLElement,
  store: Store,
  view: SkyView,
  onDirection: (dir: Vec3 | null) => void,
  announce: (msg: string) => void,
): ProbePanel {
  let dir: Vec3 | null = null;
  let timer = 0;

  const presets: [string, () => Vec3][] = [
    ['Zenith', () => [0, 1, 0]],
    [
      'Toward the sun',
      () => dirFromAngles(Math.max(1.5, store.get().sunElevation + 6), store.get().sunAzimuth),
    ],
    ['Horizon, opposite', () => dirFromAngles(3, store.get().sunAzimuth + 180)],
    ['View centre', () => view.currentBasis().forward],
  ];

  const renderEmpty = () => {
    host.innerHTML = `
      <div class="probe-empty">
        ${icons.probe}
        <p>Tap the sky to read its spectrum</p>
        <span class="note">or pick a point:</span>
      </div>
      <div class="probe-presets" role="group" aria-label="Probe a preset direction">
        ${presets.map(([label], i) => `<button class="btn" type="button" data-preset="${i}">${label}</button>`).join('')}
      </div>`;
    bindPresets();
  };

  const bindPresets = () => {
    host.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        const d = presets[Number(b.dataset.preset)][1]();
        probe(d);
      }),
    );
  };

  const render = (r: ProbeResult) => {
    const s = store.get();
    const sun = dirFromAngles(s.sunElevation, s.sunAzimuth);
    const fromSun = angleTo(r.direction, sun);
    let max = 0;
    for (const v of r.radiance) max = Math.max(max, v);
    const unit = max >= 1 ? 1 : 1000;
    const unitLabel = unit === 1 ? 'W m⁻² sr⁻¹ nm⁻¹' : 'mW m⁻² sr⁻¹ nm⁻¹';
    const scaled = r.radiance.map((v) => v * unit);
    const ticks = niceTicks(max * unit, 3);
    const top = Math.max(max * unit * 1.06, ticks[ticks.length - 1] || 1e-9);
    const dom = r.stats.dominant;
    const domText = !dom
      ? '—'
      : dom.complementary
        ? `${Number.isFinite(dom.wavelength) ? Math.round(dom.wavelength) + ' nm (complementary)' : 'purple'}`
        : `${Math.round(dom.wavelength)} nm`;
    const sh = r.shares;
    const pct = (v: number) => `${fmt(Math.max(0, v) * 100, v > 0 && v < 0.1 ? 1 : 0)} %`;
    const hex = toHex(r.display);
    const lum = r.stats.luminance;
    const lumText =
      lum >= 100 ? Math.round(lum).toLocaleString('en-US') : lum >= 1 ? fmt(lum, 1) : fmt(lum, 3);
    host.innerHTML = `
      <p class="probe-where">${KIND_LABEL[r.kind] ?? r.kind} · elevation ${fmt(r.elevation, 1)}° · ${fmt(fromSun, 0)}° from the sun</p>
      ${spectrumChart({
        lambdas: r.lambdas,
        series: [
          { values: scaled, label: 'Radiance', style: 'fill', scale: 1 / top },
          { values: r.solar, label: 'Sunlight (scaled)', style: 'dash' },
        ],
        yTicks: ticks,
        yLabel: unitLabel,
        title: 'Spectral radiance at the probe',
        desc: `Spectral radiance from 380 to 720 nm, peak ${fmt(max * unit, 2)} ${unitLabel}, with the solar spectrum scaled for comparison.`,
      })}
      <div class="legend" aria-hidden="true"><span><i></i>Radiance reaching the eye</span><span><i class="dash"></i>Sunlight (scaled)</span></div>
      <div class="swatch-row">
        <div class="swatch" style="background:${hex}" role="img" aria-label="Perceived colour ${hex}"></div>
        <dl class="readouts">
          <dt>Luminance</dt><dd>${lumText} cd/m²</dd>
          <dt>Chromaticity</dt><dd>x ${fmt(r.stats.xy[0], 3)}, y ${fmt(r.stats.xy[1], 3)}</dd>
          <dt>Dominant λ</dt><dd>${domText}</dd>
          <dt>Purity</dt><dd>${dom ? pct(dom.purity) : '—'}</dd>
        </dl>
      </div>
      <h3 class="section__title">Where the light comes from</h3>
      <div class="shares" role="img" aria-label="Rayleigh ${pct(sh.rayleigh)}, aerosol ${pct(sh.aerosol)}, surface ${pct(sh.surface)}, solar disc ${pct(sh.sun)}">
        <span class="share-rayleigh" style="width:${sh.rayleigh * 100}%"></span><span class="share-aerosol" style="width:${sh.aerosol * 100}%"></span><span class="share-surface" style="width:${sh.surface * 100}%"></span><span class="share-sun" style="width:${sh.sun * 100}%"></span>
      </div>
      <div class="share-legend">
        <div><i class="share-rayleigh"></i>Rayleigh (molecules)<b>${pct(sh.rayleigh)}</b></div>
        <div><i class="share-aerosol"></i>${s.planet === 'mars' ? 'Dust' : 'Aerosol'} (Mie)<b>${pct(sh.aerosol)}</b></div>
        <div><i class="share-surface"></i>Ground and hills<b>${pct(sh.surface)}</b></div>
        <div><i class="share-sun"></i>Solar disc<b>${pct(sh.sun)}</b></div>
      </div>
      <p class="note">Shares of luminance, single scattering. The probe integrates at 5 nm; the image uses 16 wavelengths.</p>
      <div class="probe-presets" role="group" aria-label="Probe a preset direction">
        ${presets.map(([label], i) => `<button class="btn" type="button" data-preset="${i}">${label}</button>`).join('')}
      </div>
      <p style="margin:10px 0 0"><button class="btn" type="button" id="probe-clear">Clear probe</button></p>`;
    bindPresets();
    host.querySelector('#probe-clear')?.addEventListener('click', () => clear());
  };

  const probe = (d: Vec3) => {
    dir = d;
    onDirection(d);
    const r = view.probe(d);
    if (r) {
      render(r);
      const dom = r.stats.dominant;
      announce(
        `Probe: ${KIND_LABEL[r.kind] ?? r.kind} at ${fmt(r.elevation, 0)} degrees elevation, ` +
          (dom && !dom.complementary
            ? `dominant wavelength ${Math.round(dom.wavelength)} nanometres, `
            : '') +
          `Rayleigh ${Math.round(r.shares.rayleigh * 100)} percent, aerosol ${Math.round(r.shares.aerosol * 100)} percent.`,
      );
    }
    return r;
  };

  const clear = () => {
    dir = null;
    onDirection(null);
    renderEmpty();
  };

  store.subscribe(() => {
    if (!dir) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!dir) return;
      const r = view.probe(dir);
      if (r) render(r);
    }, 160);
  });

  renderEmpty();
  return {
    probe,
    clear,
    refresh() {
      if (dir) {
        const r = view.probe(dir);
        if (r) render(r);
      }
    },
    get direction() {
      return dir;
    },
  };
}
