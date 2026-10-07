/** View: observer altitude, field of view, exposure, tone mapping. */
import type { FrameInfo, SkyView } from '../app/skyView';
import {
  ALTITUDE_MAX,
  ALTITUDE_MIN,
  DEFAULT_FOV,
  FOV_MAX,
  FOV_MIN,
  type Store,
} from '../app/state';
import { PLANETS } from '../physics/planets';
import { pitchForHorizon } from '../render/camera';
import { fmt, paintRange, prefersReducedMotion } from './dom';
import { icons } from './icons';

export interface ViewPanel {
  onFrame(info: FrameInfo): void;
}

const altFromT = (t: number) => ALTITUDE_MIN * Math.pow(ALTITUDE_MAX / ALTITUDE_MIN, t);
const tFromAlt = (h: number) => Math.log(h / ALTITUDE_MIN) / Math.log(ALTITUDE_MAX / ALTITUDE_MIN);
const fovFromT = (t: number) => FOV_MIN * Math.pow(FOV_MAX / FOV_MIN, t);
const tFromFov = (f: number) => Math.log(f / FOV_MIN) / Math.log(FOV_MAX / FOV_MIN);

export function formatAltitude(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${fmt(km, 1)} km`;
  return `${Math.round(km)} km`;
}

/** Depression of the horizon below the horizontal at altitude h, degrees. */
export function horizonDip(h: number, R: number): number {
  return (Math.atan(Math.sqrt(h * (2 * R + h)) / R) * 180) / Math.PI;
}

const PRESETS: [string, number][] = [
  ['Ground', ALTITUDE_MIN],
  ['Airliner · 11 km', 11],
  ['Balloon · 35 km', 35],
  ['Kármán line · 100 km', 100],
  ['Orbit · 400 km', 400],
];

export function mountView(host: HTMLElement, store: Store, view: SkyView): ViewPanel {
  host.innerHTML = `
    <div class="section">
      <label class="section__title" for="altitude"><span>Observer altitude</span><output id="altitude-value" for="altitude"></output></label>
      <input class="range" id="altitude" type="range" min="0" max="1000" step="1" />
      <div class="range-scale" aria-hidden="true"><span>2 m</span><span>1 km</span><span>100 km</span></div>
      <div class="chips" role="group" aria-label="Altitude presets">
        ${PRESETS.map(([label], i) => `<button class="chip" type="button" data-alt="${i}">${label}</button>`).join('')}
      </div>
      <p class="note" id="altitude-note"></p>
    </div>
    <div class="section">
      <label class="section__title" for="fov"><span>Field of view</span><output id="fov-value" for="fov"></output></label>
      <input class="range" id="fov" type="range" min="0" max="1000" step="1" />
      <div class="chips">
        <button class="btn" type="button" id="zoom-sun">${icons.zoom}Zoom on the sun</button>
        <button class="btn" type="button" id="reset-view">${icons.reset}Reset view</button>
      </div>
    </div>
    <div class="section">
      <label class="section__title" for="exposure"><span>Exposure compensation</span><output id="exposure-value" for="exposure"></output></label>
      <input class="range" id="exposure" type="range" min="-3" max="3" step="0.1" />
      <p class="note" id="meter-note"></p>
    </div>
    <div class="section">
      <h3 class="section__title" id="tonemap-label">Tone mapping</h3>
      <div class="segmented" role="radiogroup" aria-labelledby="tonemap-label">
        <button class="chip" type="button" role="radio" data-tm="filmic" aria-checked="true">Filmic (AgX)</button>
        <button class="chip" type="button" role="radio" data-tm="neutral" aria-checked="false">Neutral</button>
      </div>
      <p class="note" id="tonemap-note"></p>
    </div>
    <div class="section">
      <h3 class="section__title">Renderer</h3>
      <p class="note" id="renderer-note">—</p>
    </div>`;
  const $ = <T extends Element>(sel: string) => host.querySelector(sel) as T;
  const altitude = $<HTMLInputElement>('#altitude');
  const fov = $<HTMLInputElement>('#fov');
  const exposure = $<HTMLInputElement>('#exposure');

  const setAltitude = (h: number, animate: boolean) => {
    const s = store.get();
    const R = PLANETS[s.planet].radius;
    const target = Math.min(ALTITUDE_MAX, Math.max(ALTITUDE_MIN, h));
    if (animate) {
      // Frame the horizon a little below the centre of the view.
      const [w, hh] = view.size;
      const framing = target < 1 ? pitchForHorizon(s.fov, w, hh, 0.2) : -horizonDip(target, R) + 12;
      store.animateTo({ altitude: target, pitch: framing }, prefersReducedMotion() ? 0 : 1100);
    } else {
      // Keep the horizon where it is on screen while dragging.
      const shift = horizonDip(target, R) - horizonDip(s.altitude, R);
      store.set({ altitude: target, pitch: s.pitch - shift });
    }
  };

  altitude.addEventListener('input', () =>
    setAltitude(altFromT(Number(altitude.value) / 1000), false),
  );
  host
    .querySelectorAll<HTMLButtonElement>('[data-alt]')
    .forEach((b) =>
      b.addEventListener('click', () => setAltitude(PRESETS[Number(b.dataset.alt)][1], true)),
    );
  fov.addEventListener('input', () => store.set({ fov: fovFromT(Number(fov.value) / 1000) }));
  exposure.addEventListener('input', () => store.set({ exposureEv: Number(exposure.value) }));
  $('#zoom-sun').addEventListener('click', () => {
    const s = store.get();
    store.animateTo(
      { fov: 2.5, yaw: s.sunAzimuth, pitch: s.sunElevation },
      prefersReducedMotion() ? 0 : 900,
    );
  });
  $('#reset-view').addEventListener('click', () => {
    const s = store.get();
    const [w, h] = view.size;
    store.animateTo(
      {
        fov: DEFAULT_FOV,
        yaw: s.sunAzimuth,
        pitch: pitchForHorizon(DEFAULT_FOV, w, h, 0.2),
        altitude: ALTITUDE_MIN,
        exposureEv: 0,
      },
      prefersReducedMotion() ? 0 : 900,
    );
  });
  host
    .querySelectorAll<HTMLButtonElement>('[data-tm]')
    .forEach((b) =>
      b.addEventListener('click', () =>
        store.set({ toneMap: b.dataset.tm as 'filmic' | 'neutral' }),
      ),
    );

  const refresh = () => {
    const s = store.get();
    if (document.activeElement !== altitude)
      altitude.value = String(Math.round(tFromAlt(s.altitude) * 1000));
    if (document.activeElement !== fov) fov.value = String(Math.round(tFromFov(s.fov) * 1000));
    if (document.activeElement !== exposure) exposure.value = String(s.exposureEv);
    paintRange(altitude);
    paintRange(fov);
    paintRange(exposure);
    $<HTMLOutputElement>('#altitude-value').textContent = formatAltitude(s.altitude);
    altitude.setAttribute('aria-valuetext', formatAltitude(s.altitude));
    $<HTMLOutputElement>('#fov-value').textContent =
      `${s.fov < 10 ? fmt(s.fov, 1) : Math.round(s.fov)}°`;
    fov.setAttribute('aria-valuetext', `${Math.round(s.fov * 10) / 10} degrees`);
    $<HTMLOutputElement>('#exposure-value').textContent =
      `${s.exposureEv > 0 ? '+' : ''}${fmt(s.exposureEv, 1)} EV`;
    const R = PLANETS[s.planet].radius;
    const top = PLANETS[s.planet].atmosphereHeight;
    $<HTMLElement>('#altitude-note').textContent =
      s.altitude > top
        ? `Above the modelled atmosphere (${top} km): it is a thin glowing shell at the limb, ${fmt(horizonDip(s.altitude, R), 1)}° below the horizontal.`
        : s.altitude > 3
          ? `The horizon lies ${fmt(horizonDip(s.altitude, R), 1)}° below the horizontal; ${fmt(100 * (1 - Math.exp(-s.altitude / PLANETS[s.planet].molecularScaleHeight)), 0)} % of the air is below you.`
          : 'Standing on low hills.';
    host
      .querySelectorAll<HTMLButtonElement>('[data-tm]')
      .forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tm === s.toneMap)));
    $<HTMLElement>('#tonemap-note').textContent =
      s.toneMap === 'filmic'
        ? 'AgX: a film-like curve that rolls bright colours off toward white, with a look tuned for skies.'
        : 'Khronos PBR Neutral: mid-tone colours are shown exactly; only highlights are compressed.';
  };
  store.subscribe(() => refresh());
  refresh();

  return {
    onFrame(info) {
      const e = info.exposure;
      if (e) {
        const L = e.meteredLuminance;
        const ev100 = Math.log2(Math.max(L, 1e-6) * 8);
        $<HTMLElement>('#meter-note').textContent =
          `Metered sky ${L >= 100 ? Math.round(L).toLocaleString('en-US') : fmt(L, L >= 1 ? 1 : 3)} cd/m² (EV₁₀₀ ${fmt(ev100, 1)}); brighter scenes are shown brighter.`;
      }
      $<HTMLElement>('#renderer-note').textContent =
        info.renderer === 'webgl'
          ? `WebGL2 · 16 wavelengths · ${Math.round(info.scale * 100)} % resolution`
          : `CPU fallback · 16 wavelengths · ${Math.round(info.cssWidth * info.scale)} px wide`;
    },
  };
}
