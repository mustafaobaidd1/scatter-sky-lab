/** Guided story: six short steps from a blue noon to a blue Martian sunset. */
import type { SkyView } from '../app/skyView';
import type { SimState, Store } from '../app/state';
import { AEROSOL_PRESETS } from '../physics/aerosol';
import { MARS_DUST_TAU_DEFAULT } from '../physics/planets';
import { dirFromAngles } from '../physics/sky';
import { interpolateSamples } from '../physics/spectral';
import { RENDER_GRID } from '../app/tables';
import { pitchForHorizon } from '../render/camera';
import { HORIZON_DIP_AZIMUTH } from '../render/terrain';
import { fmt, prefersReducedMotion } from './dom';
import { icons } from './icons';
import { renderWhyViolet } from './whyViolet';

interface Ctx {
  view: SkyView;
  store: Store;
  /** Horizon position (fraction of the height from the bottom) clear of the bottom chrome. */
  horizon: () => number;
}

interface Step {
  title: string;
  body: (c: Ctx) => string;
  target: (c: Ctx) => Partial<SimState>;
  extra?: 'violet' | 'ozone';
}

const AZ = HORIZON_DIP_AZIMUTH;
const clean = AEROSOL_PRESETS.clean.troposphere;
const urban = AEROSOL_PRESETS.urban.troposphere;
const earth = (): Partial<SimState> => ({
  planet: 'earth',
  rayleighExponent: 4,
  ozone: true,
  aerosolPreset: 'clean',
  aerosolTau: clean.tau550,
  aerosolAngstrom: clean.angstrom,
  altitude: 0.002,
  exposureEv: 0,
});

function horizonPitch(c: Ctx, fov: number, offset = 0): number {
  const [w, h] = c.view.size;
  return pitchForHorizon(fov, w, h, Math.max(0.04, c.horizon() + offset));
}

function zenithDominant(c: Ctx): string {
  const p = c.view.probe([0, 1, 0]);
  const d = p?.stats.dominant;
  return d && !d.complementary ? `${Math.round(d.wavelength)} nm` : 'close to white';
}

function zenithPeak(c: Ctx): string {
  const p = c.view.probe([0, 1, 0]);
  if (!p) return 'about 450 nm';
  let best = 0;
  for (let i = 1; i < p.radiance.length; i++) if (p.radiance[i] > p.radiance[best]) best = i;
  return `${Math.round(p.lambdas[best])} nm`;
}

function blueRedRatio(c: Ctx): string {
  const atm = c.view.atmosphere;
  if (!atm) return '5';
  return fmt(
    interpolateSamples(RENDER_GRID, atm.molSca, 450) /
      interpolateSamples(RENDER_GRID, atm.molSca, 650),
    1,
  );
}

export const STEPS: Step[] = [
  {
    title: 'A blue sky at noon',
    target: () => ({
      ...earth(),
      sunElevation: 62,
      sunAzimuth: AZ,
      yaw: AZ - 120,
      pitch: 26,
      fov: 90,
    }),
    body: (c) =>
      `<p>Sunlight holds every colour. Air molecules scatter a little of it out of the beam in all directions, but unevenly: the Rayleigh cross-section falls as λ⁻⁴, so 450 nm blue is scattered <strong>${blueRedRatio(c)}×</strong> as strongly as 650 nm red.</p><p>Look away from the Sun: that scattered light <em>is</em> the sky.</p>`,
  },
  {
    title: 'Why not violet?',
    target: () => ({
      ...earth(),
      sunElevation: 62,
      sunAzimuth: AZ,
      yaw: AZ - 120,
      pitch: 26,
      fov: 90,
    }),
    extra: 'violet',
    body: (c) =>
      `<p>Air scatters violet even more than blue: right now the zenith spectrum peaks at <strong>${zenithPeak(c)}</strong>. Yet the sky looks pale blue. Sunlight holds less violet than blue to begin with, the eye barely responds below 430 nm, and it sums every wavelength: the mixture's dominant wavelength is <strong>${zenithDominant(c)}</strong>.</p>`,
  },
  {
    title: 'Sunset: the long way through',
    target: (c) => ({
      ...earth(),
      sunElevation: 1.3,
      sunAzimuth: AZ,
      yaw: AZ,
      pitch: horizonPitch(c, 90),
      fov: 90,
    }),
    body: (c) =>
      `<p>Low in the sky, sunlight crosses <strong>${fmt(c.view.airMass(c.store.get().sunElevation), 0)}×</strong> as much air as from the zenith. Blue is scattered out along the way, so the light that survives, and the sky it lights, turns orange and red.</p><p>Drag the Sun up and down to watch it happen.</p>`,
  },
  {
    title: 'Haze turns the sky white',
    target: (c) => ({
      ...earth(),
      aerosolPreset: 'urban',
      aerosolTau: urban.tau550,
      aerosolAngstrom: urban.angstrom,
      sunElevation: 24,
      sunAzimuth: AZ,
      yaw: AZ - 25,
      pitch: horizonPitch(c, 90) + 6,
      fov: 90,
    }),
    body: () =>
      `<p>Aerosol particles are about the size of a wavelength. They scatter all colours almost equally (Ångström exponent ≈ ${fmt(urban.angstrom, 1)}, against ≈ 4 for molecules) and mostly forward, so a hazy sky is pale, whitest around the Sun.</p><p>Try the other presets under <strong>Experiments</strong>.</p>`,
  },
  {
    title: 'Ozone and the blue hour',
    target: (c) => ({
      ...earth(),
      sunElevation: -4.5,
      sunAzimuth: AZ,
      yaw: AZ,
      pitch: horizonPitch(c, 110, -0.08),
      fov: 110,
    }),
    extra: 'ozone',
    body: (c) =>
      `<p>After sunset the zenith is lit by sunlight that skimmed the horizon and lost its blue. Ozone's Chappuis band absorbs orange light near 600 nm and keeps the twilight zenith blue: dominant wavelength now <strong>${zenithDominant(c)}</strong>.</p><p>Switch ozone off and the zenith turns yellowish grey.</p>`,
  },
  {
    title: 'Blue sunsets on Mars',
    target: (c) => ({
      planet: 'mars',
      marsDustTau: MARS_DUST_TAU_DEFAULT,
      rayleighExponent: 4,
      altitude: 0.002,
      sunElevation: 2.6,
      sunAzimuth: AZ,
      yaw: AZ,
      pitch: horizonPitch(c, 70),
      fov: 70,
      exposureEv: -1.5,
    }),
    body: () =>
      `<p>Mars's thin CO₂ air scatters almost nothing; fine dust (≈ 1.5 µm) colours its sky. The dust absorbs blue, so the daytime sky is butterscotch, but it diffracts blue light into a narrow cone around the Sun: Martian sunsets glow blue.</p>`,
  },
];

export interface StoryController {
  open(index?: number): void;
  close(): void;
  get active(): boolean;
  refresh(): void;
}

export function mountStory(
  host: HTMLElement,
  store: Store,
  view: SkyView,
  horizon: () => number,
  onActiveChange: (active: boolean) => void,
): StoryController {
  const ctx: Ctx = { view, store, horizon };
  let index = 0;
  let active = false;
  let timer = 0;

  const render = () => {
    const step = STEPS[index];
    host.innerHTML = `
      <div class="story__top">
        <span class="story__step">Story · ${index + 1} of ${STEPS.length}</span>
        <div class="story__dots" role="group" aria-label="Story steps">
          ${STEPS.map((s, i) => `<button class="story__dot" type="button" data-step="${i}" aria-label="Step ${i + 1}: ${s.title}"${i === index ? ' aria-current="step"' : ''}></button>`).join('')}
        </div>
        <button class="icon-btn" type="button" data-exit aria-label="Exit the story">${icons.close}</button>
      </div>
      <h2 id="story-title">${step.title}</h2>
      <div class="story__text">${step.body(ctx)}</div>
      ${step.extra === 'violet' ? '<div class="story__extra" id="story-violet"></div>' : ''}
      ${
        step.extra === 'ozone'
          ? `<div class="story__extra"><button class="switch" type="button" role="switch" id="story-ozone" aria-checked="${store.get().ozone}"><span class="switch__label">Ozone layer<small>${store.get().ozone ? '300 Dobson units' : 'Switched off'}</small></span><span class="switch__track" aria-hidden="true"></span></button></div>`
          : ''
      }
      <div class="story__nav">
        <button class="btn" type="button" data-prev ${index === 0 ? 'disabled' : ''}>${icons.back}Back</button>
        ${
          index < STEPS.length - 1
            ? `<button class="btn btn--primary" type="button" data-next data-primary>Next${icons.next}</button>`
            : `<button class="btn btn--primary" type="button" data-exit data-primary>Keep exploring</button>`
        }
      </div>`;
    host
      .querySelectorAll<HTMLButtonElement>('[data-step]')
      .forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.step))));
    host.querySelector('[data-prev]')?.addEventListener('click', () => go(index - 1));
    host.querySelector('[data-next]')?.addEventListener('click', () => go(index + 1));
    host.querySelectorAll('[data-exit]').forEach((b) => b.addEventListener('click', () => close()));
    host
      .querySelector('#story-ozone')
      ?.addEventListener('click', () => store.set({ ozone: !store.get().ozone }));
    const violet = host.querySelector<HTMLElement>('#story-violet');
    if (violet) renderWhyViolet(violet, view);
  };

  const refreshText = () => {
    if (!active) return;
    const text = host.querySelector('.story__text');
    if (text) text.innerHTML = STEPS[index].body(ctx);
    const oz = host.querySelector<HTMLButtonElement>('#story-ozone');
    if (oz) {
      oz.setAttribute('aria-checked', String(store.get().ozone));
      const small = oz.querySelector('small');
      if (small) small.textContent = store.get().ozone ? '300 Dobson units' : 'Switched off';
    }
    const violet = host.querySelector<HTMLElement>('#story-violet');
    if (violet) renderWhyViolet(violet, view);
  };

  const go = (i: number) => {
    index = Math.max(0, Math.min(STEPS.length - 1, i));
    render(); // lay out the card first: the camera frames the horizon above it on narrow screens
    const target = STEPS[index].target(ctx);
    store.animateTo(target, prefersReducedMotion() ? 0 : 1400, () => refreshText());
    host.querySelector<HTMLElement>('[data-primary]')?.focus({ preventScroll: true });
  };

  const close = () => {
    if (!active) return;
    active = false;
    host.hidden = true;
    onActiveChange(false);
  };

  store.subscribe(() => {
    if (!active) return;
    clearTimeout(timer);
    timer = window.setTimeout(refreshText, 250);
  });

  return {
    open(i = 0) {
      active = true;
      host.hidden = false;
      onActiveChange(true);
      go(i);
    },
    close,
    get active() {
      return active;
    },
    refresh: refreshText,
  };
}

/** Direction used by tests and the Mars step: just beside the sun. */
export function besideSun(s: SimState, degrees = 3) {
  return dirFromAngles(s.sunElevation + degrees, s.sunAzimuth);
}
