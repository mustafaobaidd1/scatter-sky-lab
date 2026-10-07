import './styles/main.css';
import { SkyView, type ViewStatus } from './app/skyView';
import { defaultState, sunPhase, Store } from './app/state';
import { AEROSOL_PRESETS } from './physics/aerosol';
import { dirFromAngles } from './physics/sky';
import { pitchForHorizon } from './render/camera';
import { fmt } from './ui/dom';
import { icons } from './ui/icons';
import { buildLayout, type PanelId } from './ui/layout';
import { mountExperiments } from './ui/experimentsPanel';
import { mountProbe } from './ui/probePanel';
import { mountScrubber, describeSun } from './ui/scrubber';
import { mountStage } from './ui/stage';
import { mountStory, STEPS } from './ui/story';
import { formatAltitude, mountView } from './ui/viewPanel';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');
const params = new URLSearchParams(location.search);
const forceCpu = params.get('renderer') === 'cpu';
const fixedScaleParam = Number(params.get('scale'));
const fixedScale = fixedScaleParam > 0 && fixedScaleParam <= 1 ? fixedScaleParam : null;

const ui = buildLayout(root);
const store = new Store(defaultState());

// ------------------------------------------------------------------------------------------------
// Status, loader and banners

const loaderText = ui.loader.querySelector<HTMLElement>('#loader-text')!;
const loaderBar = ui.loader.querySelector<HTMLElement>('#loader-bar')!;
const STEP_TEXT: Record<string, [string, number]> = {
  shaders: ['Compiling the spectral shader…', 0.15],
  mie: ['Computing Mie scattering for Martian dust…', 0.3],
  lut: ['Precomputing the transmittance table…', 0.45],
  irradiance: ['Integrating skylight…', 0.7],
  'first-frame': ['Rendering the first frame…', 0.9],
};
let ready = false;

function showBanner(html: string, dismissable: boolean) {
  ui.banner.innerHTML = `<p>${html}</p>${
    dismissable
      ? `<button class="icon-btn" type="button" aria-label="Dismiss this message">${icons.close}</button>`
      : ''
  }`;
  ui.banner.hidden = false;
  ui.banner.querySelector('button')?.addEventListener('click', () => (ui.banner.hidden = true));
}

const debug = params.has('debug');
function onStatus(s: ViewStatus) {
  if (debug) console.info(`[scatter] ${performance.now().toFixed(0)} ms`, JSON.stringify(s));
  if (s.phase === 'loading') {
    const [text, base] = STEP_TEXT[s.step] ?? ['Preparing the sky…', 0.1];
    loaderText.textContent = text;
    const f = s.fraction ?? 0;
    loaderBar.style.width = `${Math.round((base + (s.step === 'mie' ? f * 0.12 : 0)) * 100)}%`;
  } else if (s.phase === 'ready') {
    loaderBar.style.width = '100%';
    ui.loader.classList.add('is-done');
    ui.loader.setAttribute('aria-hidden', 'true');
    for (const c of [ui.glCanvas, ui.cpuCanvas]) c.classList.add('is-visible');
    ui.root.classList.remove('is-updating');
    if (lostBanner) {
      ui.banner.hidden = true;
      lostBanner = false;
    }
    if (!ready) {
      ready = true;
      document.documentElement.dataset.ready = 'true';
      stage.update();
    }
  } else if (s.phase === 'updating') {
    ui.root.classList.add('is-updating');
  } else if (s.phase === 'lost') {
    lostBanner = true;
    showBanner('The graphics context was lost. Restoring the renderer…', false);
  } else if (s.phase === 'error') {
    ui.loader.classList.remove('is-done');
    ui.loader.classList.add('loader--error');
    ui.loader.innerHTML = `<p>${s.message}</p><button class="btn btn--primary" type="button" id="reload">Reload</button>`;
    ui.loader.querySelector('#reload')?.addEventListener('click', () => location.reload());
  }
}
let lostBanner = false;

const view = new SkyView({
  glCanvas: ui.glCanvas,
  cpuCanvas: ui.cpuCanvas,
  store,
  forceCpu,
  fixedScale,
  onStatus,
  onFrame: (info) => {
    stage.update(info);
    viewPanel.onFrame(info);
    ui.status.textContent =
      info.renderer === 'webgl'
        ? `WebGL2 · 16 λ · ${Math.round(info.scale * 100)} %`
        : `CPU · 16 λ · ${Math.round(info.cssWidth * info.scale)} px`;
  },
  onRenderer: (kind, reason) => {
    document.documentElement.dataset.renderer = kind;
    if (kind === 'cpu') {
      showBanner(
        forceCpu
          ? 'CPU reference renderer (<code>?renderer=cpu</code>): the same physics at reduced resolution.'
          : `WebGL2 is unavailable here (${reason ?? 'unknown reason'}), so the sky is drawn on the CPU at reduced resolution. The physics is the same; motion is slower.`,
        true,
      );
    }
  },
});

// ------------------------------------------------------------------------------------------------
// Live region and the canvas description

let liveTimer = 0;
function announce(msg: string) {
  clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => (ui.live.textContent = msg), 250);
}

let labelTimer = 0;
function describeScene() {
  const s = store.get();
  const where =
    s.planet === 'mars'
      ? `Mars, dust optical depth ${fmt(s.marsDustTau, 2)}`
      : `Earth, ${AEROSOL_PRESETS[s.aerosolPreset].label.toLowerCase()}, ozone ${s.ozone ? 'on' : 'off'}${s.rayleighExponent < 3.95 ? `, scattering law λ to the minus ${fmt(s.rayleighExponent, 1)}` : ''}`;
  const label = `Simulated sky. ${describeSun(s.sunElevation)}, azimuth ${Math.round(s.sunAzimuth)} degrees. ${where}. Viewed from ${formatAltitude(s.altitude)}, looking toward azimuth ${Math.round(s.yaw)} degrees.`;
  ui.glCanvas.setAttribute('aria-label', label);
  ui.cpuCanvas.setAttribute('aria-label', label);
}
store.subscribe((s, changed) => {
  clearTimeout(labelTimer);
  labelTimer = window.setTimeout(describeScene, 300);
  if (changed.has('sunElevation') && !store.tweening) announce(`${describeSun(s.sunElevation)}.`);
});

// ------------------------------------------------------------------------------------------------
// Controls

const stage = mountStage(ui, store, view, {
  onProbe: (dir) => {
    openPanel('probe');
    probePanel.probe(dir);
  },
  onFirstUse: () => {},
  onToggleProbe: () => openPanel(openId === 'probe' ? null : 'probe'),
  onEscape: () => {
    if (ui.how.open) return;
    if (openId) openPanel(null);
    else if (story.active) story.close();
  },
  onStoryStep: (i) => {
    if (i < STEPS.length) story.open(i);
  },
});
mountScrubber(ui.scrubber, store, () => stage.hideHint());

const experiments = mountExperiments(ui.panelBodies.experiments, store, view);
const probePanel = mountProbe(
  ui.panelBodies.probe,
  store,
  view,
  (d) => stage.setProbeDirection(d),
  announce,
);
const viewPanel = mountView(ui.panelBodies.view, store, view);

let openId: PanelId | null = null;
function openPanel(id: PanelId | null) {
  openId = id;
  for (const p of Object.keys(ui.panels) as PanelId[]) {
    ui.panels[p].hidden = p !== id;
    ui.dockButtons[p].setAttribute('aria-expanded', String(p === id));
  }
  ui.root.classList.toggle('has-panel', id !== null);
  ui.root.classList.toggle('has-sheet', id !== null || story.active);
  if (id === 'experiments') experiments.refresh();
  if (id === 'probe') probePanel.refresh();
}
for (const p of Object.keys(ui.panels) as PanelId[]) {
  ui.dockButtons[p].addEventListener('click', () => openPanel(openId === p ? null : p));
  ui.panels[p].querySelector('[data-close]')?.addEventListener('click', () => {
    openPanel(null);
    ui.dockButtons[p].focus();
  });
}

const story = mountStory(ui.story, store, view, horizonFraction, (active) => {
  ui.dockButtons.story.setAttribute('aria-pressed', String(active));
  ui.root.classList.toggle('has-sheet', active || openId !== null);
  if (active) stage.hideHint();
});
ui.dockButtons.story.addEventListener('click', () =>
  story.active ? story.close() : story.open(0),
);

let howLoaded: Promise<void> | null = null;
ui.how.innerHTML = `<div class="how__head"><h2 id="how-title">How it works</h2><button class="icon-btn" type="button" data-close aria-label="Close how it works">${icons.close}</button></div><div class="how__body"><p>Loading the equations…</p></div>`;
ui.how.querySelector('[data-close]')?.addEventListener('click', () => ui.how.close());
ui.how.addEventListener('click', (e) => {
  if (e.target === ui.how) ui.how.close(); // click on the backdrop
});
ui.dockButtons.how.addEventListener('click', () => {
  ui.how.showModal();
  howLoaded ??= import('./ui/howItWorks')
    .then((mod) => mod.renderHowItWorks(ui.how, view))
    .catch(() => {
      howLoaded = null;
      const body = ui.how.querySelector('.how__body');
      if (body)
        body.innerHTML =
          '<p>The explanation could not be loaded. Check your connection and try again.</p>';
    });
});

// ------------------------------------------------------------------------------------------------
// Start

/**
 * Fraction of the stage height, from the bottom, where the horizon sits clear of the bottom chrome
 * (the scrubber, and on narrow layouts the story or panel sheet).
 */
function horizonFraction(): number {
  const stageRect = ui.stage.getBoundingClientRect();
  const narrow = matchMedia('(max-width: 1023px)').matches;
  const chrome: HTMLElement[] = [
    ui.scrubber,
    ...(narrow ? [ui.story, ...Object.values(ui.panels)] : []),
  ];
  let top = stageRect.bottom;
  for (const el of chrome) {
    if (el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top > stageRect.top) top = Math.min(top, r.top);
  }
  const clearance = stageRect.bottom - top + 48;
  return Math.min(0.62, Math.max(0.2, clearance / stageRect.height));
}

function frameHorizon() {
  const [w, h] = view.size;
  store.set({ pitch: pitchForHorizon(store.get().fov, w, h, horizonFraction()) });
}

new ResizeObserver(() => {
  view.resize();
  stage.update();
}).observe(ui.stage);

view
  .start()
  .then(() => {
    frameHorizon();
    describeScene();
    if (params.get('story')) story.open(Math.max(0, Number(params.get('story')) - 1));
  })
  .catch((err: unknown) =>
    onStatus({ phase: 'error', message: `The sky could not start: ${String(err)}` }),
  );

// Test and automation hook (also handy in the console).
Object.assign(window, {
  __scatter: {
    store,
    view,
    get state() {
      return store.get();
    },
    set: (patch: Parameters<Store['set']>[0]) => store.set(patch),
    renderNow: () => view.renderNow(),
    readPixel: (u: number, v: number) => view.readPixel(u, v),
    compareWithCpu: (u: number, v: number) => view.compareWithCpu(u, v),
    screenOf: (elevation: number, azimuth: number) =>
      view.screenOf(dirFromAngles(elevation, azimuth)),
    probe: (elevation: number, azimuth: number) => {
      openPanel('probe');
      const r = probePanel.probe(dirFromAngles(elevation, azimuth));
      return (
        r && {
          kind: r.kind,
          luminance: r.stats.luminance,
          dominant: r.stats.dominant,
          shares: r.shares,
        }
      );
    },
    loseContext: () => view.simulateContextLoss(),
    phase: () => sunPhase(store.get().sunElevation),
  },
});
