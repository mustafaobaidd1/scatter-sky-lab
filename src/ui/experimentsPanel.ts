/** Experiments: scattering law, why not violet, aerosols, ozone, planet. */
import type { SkyView } from '../app/skyView';
import type { SimState, Store } from '../app/state';
import { AEROSOL_PRESETS, type AerosolPresetId } from '../physics/aerosol';
import { interpolateSamples } from '../physics/spectral';
import { RENDER_GRID } from '../app/tables';
import { fmt, paintRange } from './dom';
import { renderWhyViolet } from './whyViolet';

export interface ExperimentsPanel {
  refresh(): void;
}

const PRESET_ORDER: AerosolPresetId[] = ['clean', 'urban', 'dust', 'smoke', 'volcanic'];

function superscriptExponent(p: number): string {
  const map: Record<string, string> = {
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '4': '⁴',
    '5': '⁵',
    '6': '⁶',
    '7': '⁷',
    '8': '⁸',
    '9': '⁹',
    '.': '·',
  };
  const s = (Math.round(p * 10) / 10).toString();
  return p === 0 ? '⁰' : '⁻' + [...s].map((c) => map[c] ?? c).join('');
}

export function mountExperiments(host: HTMLElement, store: Store, view: SkyView): ExperimentsPanel {
  host.innerHTML = `
    <div class="section">
      <h3 class="section__title"><span id="law-label">Scattering law</span><output id="law-value" for="law"></output></h3>
      <input class="range" id="law" type="range" min="0" max="4" step="0.05" aria-labelledby="law-label" />
      <div class="range-scale" aria-hidden="true"><span>λ⁰ · all colours</span><span>λ⁻⁴ · real air</span></div>
      <p class="note" id="law-note"></p>
      <div class="chips" role="group" aria-label="Scattering law shortcuts">
        <button class="chip" type="button" data-law="0" aria-pressed="false">λ⁰ — grey sky</button>
        <button class="chip" type="button" data-law="4" aria-pressed="false">λ⁻⁴ — real air</button>
      </div>
    </div>
    <div class="section">
      <h3 class="section__title">Why not violet?</h3>
      <div id="violet"></div>
    </div>
    <div class="section" id="aerosol-earth">
      <h3 class="section__title">Aerosols</h3>
      <div class="chips" role="radiogroup" aria-label="Aerosol preset">
        ${PRESET_ORDER.map((id) => `<button class="chip" type="button" role="radio" data-preset="${id}" aria-checked="false">${AEROSOL_PRESETS[id].label}</button>`).join('')}
      </div>
      <p class="note" id="preset-note"></p>
      <label class="section__title" for="tau"><span>Optical depth τ₅₅₀</span><output id="tau-value" for="tau"></output></label>
      <input class="range" id="tau" type="range" min="0" max="2" step="0.01" />
      <label class="section__title" for="alpha"><span>Ångström exponent α</span><output id="alpha-value" for="alpha"></output></label>
      <input class="range" id="alpha" type="range" min="0" max="2.5" step="0.05" />
      <div class="range-scale" aria-hidden="true"><span>large particles</span><span>small particles</span></div>
    </div>
    <div class="section" id="aerosol-mars" hidden>
      <h3 class="section__title">Martian dust</h3>
      <label class="section__title" for="dust"><span>Dust optical depth τ₅₅₀</span><output id="dust-value" for="dust"></output></label>
      <input class="range" id="dust" type="range" min="0.1" max="2.5" step="0.01" />
      <p class="note">Mie theory for 1.5 µm grains with the refractive index of Wolff et al. (2009): the dust absorbs blue but diffracts it into a narrow cone around the Sun.</p>
    </div>
    <div class="section">
      <button class="switch" type="button" role="switch" id="ozone" aria-checked="true">
        <span class="switch__label">Ozone layer<small id="ozone-note">300 Dobson units, peak at 25 km</small></span>
        <span class="switch__track" aria-hidden="true"></span>
      </button>
    </div>
    <div class="section">
      <h3 class="section__title" id="planet-label">Planet</h3>
      <div class="segmented" role="radiogroup" aria-labelledby="planet-label">
        <button class="chip" type="button" role="radio" data-planet="earth" aria-checked="true">Earth</button>
        <button class="chip" type="button" role="radio" data-planet="mars" aria-checked="false">Mars</button>
      </div>
    </div>`;

  const $ = <T extends Element>(sel: string) => host.querySelector(sel) as T;
  const law = $<HTMLInputElement>('#law');
  const tau = $<HTMLInputElement>('#tau');
  const alpha = $<HTMLInputElement>('#alpha');
  const dust = $<HTMLInputElement>('#dust');
  const ozone = $<HTMLButtonElement>('#ozone');
  const violet = $<HTMLElement>('#violet');

  law.addEventListener('input', () => store.set({ rayleighExponent: Number(law.value) }));
  host
    .querySelectorAll<HTMLButtonElement>('[data-law]')
    .forEach((b) =>
      b.addEventListener('click', () => store.set({ rayleighExponent: Number(b.dataset.law) })),
    );
  tau.addEventListener('input', () => store.set({ aerosolTau: Number(tau.value) }));
  alpha.addEventListener('input', () => store.set({ aerosolAngstrom: Number(alpha.value) }));
  dust.addEventListener('input', () => store.set({ marsDustTau: Number(dust.value) }));
  ozone.addEventListener('click', () => store.set({ ozone: !store.get().ozone }));
  host.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.preset as AerosolPresetId;
      const t = AEROSOL_PRESETS[id].troposphere;
      store.set({ aerosolPreset: id, aerosolTau: t.tau550, aerosolAngstrom: t.angstrom });
    }),
  );
  host
    .querySelectorAll<HTMLButtonElement>('[data-planet]')
    .forEach((b) =>
      b.addEventListener('click', () =>
        store.set({ planet: b.dataset.planet as SimState['planet'] }),
      ),
    );
  // Arrow keys move between radio options inside a radiogroup.
  host.querySelectorAll<HTMLElement>('[role="radiogroup"]').forEach((g) =>
    g.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const items = [...g.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const next =
        items[
          (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? items.length - 1 : 1)) % items.length
        ];
      next.focus();
      next.click();
    }),
  );

  let violetTimer = 0;
  const refresh = () => {
    const s = store.get();
    if (document.activeElement !== law) law.value = String(s.rayleighExponent);
    paintRange(law);
    $<HTMLOutputElement>('#law-value').textContent = `λ${superscriptExponent(s.rayleighExponent)}`;
    const atm = view.atmosphere;
    if (atm) {
      const ratio =
        interpolateSamples(RENDER_GRID, atm.molSca, 450) /
        interpolateSamples(RENDER_GRID, atm.molSca, 650);
      $<HTMLElement>('#law-note').innerHTML =
        s.rayleighExponent > 0.05
          ? `450 nm blue is scattered <strong>${fmt(ratio, 1)}×</strong> as strongly as 650 nm red.`
          : 'All wavelengths are scattered equally: the sky takes the colour of sunlight.';
    }
    host
      .querySelectorAll<HTMLButtonElement>('[data-law]')
      .forEach((b) =>
        b.setAttribute(
          'aria-pressed',
          String(Math.abs(Number(b.dataset.law) - s.rayleighExponent) < 0.01),
        ),
      );
    const mars = s.planet === 'mars';
    $<HTMLElement>('#aerosol-earth').hidden = mars;
    $<HTMLElement>('#aerosol-mars').hidden = !mars;
    host
      .querySelectorAll<HTMLButtonElement>('[data-preset]')
      .forEach((b) => b.setAttribute('aria-checked', String(b.dataset.preset === s.aerosolPreset)));
    const preset = AEROSOL_PRESETS[s.aerosolPreset];
    const custom =
      Math.abs(s.aerosolTau - preset.troposphere.tau550) > 0.005 ||
      Math.abs(s.aerosolAngstrom - preset.troposphere.angstrom) > 0.01;
    $<HTMLElement>('#preset-note').textContent = custom
      ? `${preset.label}, adjusted: particle optics (single-scattering albedo, asymmetry, height) stay those of the preset.`
      : preset.blurb;
    if (document.activeElement !== tau) tau.value = String(s.aerosolTau);
    if (document.activeElement !== alpha) alpha.value = String(s.aerosolAngstrom);
    if (document.activeElement !== dust) dust.value = String(s.marsDustTau);
    paintRange(tau);
    paintRange(alpha);
    paintRange(dust);
    $<HTMLOutputElement>('#tau-value').textContent = fmt(s.aerosolTau, 2);
    $<HTMLOutputElement>('#alpha-value').textContent = fmt(s.aerosolAngstrom, 2);
    $<HTMLOutputElement>('#dust-value').textContent = fmt(s.marsDustTau, 2);
    ozone.setAttribute('aria-checked', String(s.ozone && !mars));
    ozone.disabled = mars;
    $<HTMLElement>('#ozone-note').textContent = mars
      ? 'Mars has almost no ozone'
      : s.ozone
        ? '300 Dobson units, peak at 25 km'
        : 'Switched off';
    host
      .querySelectorAll<HTMLButtonElement>('[data-planet]')
      .forEach((b) => b.setAttribute('aria-checked', String(b.dataset.planet === s.planet)));
    clearTimeout(violetTimer);
    violetTimer = window.setTimeout(() => {
      if (!host.closest('[hidden]')) renderWhyViolet(violet, view);
    }, 120);
  };
  store.subscribe(() => refresh());
  refresh();
  return { refresh };
}
