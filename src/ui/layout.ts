/** Builds the static DOM of the app and returns references to its parts. */
import { icons } from './icons';

export type PanelId = 'experiments' | 'probe' | 'view';

export interface Layout {
  root: HTMLElement;
  stage: HTMLElement;
  glCanvas: HTMLCanvasElement;
  cpuCanvas: HTMLCanvasElement;
  sunHandle: HTMLButtonElement;
  hint: HTMLElement;
  sunOffscreen: HTMLButtonElement;
  probeMarker: HTMLElement;
  dock: HTMLElement;
  dockButtons: Record<PanelId | 'story' | 'how', HTMLButtonElement>;
  panels: Record<PanelId, HTMLElement>;
  panelBodies: Record<PanelId, HTMLElement>;
  story: HTMLElement;
  scrubber: HTMLElement;
  status: HTMLElement;
  banner: HTMLElement;
  loader: HTMLElement;
  live: HTMLElement;
  how: HTMLDialogElement;
}

const PANEL_TITLES: Record<PanelId, string> = {
  experiments: 'Experiments',
  probe: 'Spectrum probe',
  view: 'View',
};

export function buildLayout(root: HTMLElement): Layout {
  root.innerHTML = `
    <div class="stage" id="stage">
      <canvas class="sky" id="sky-gl" role="img" aria-label="Simulated sky"></canvas>
      <canvas class="sky sky--cpu" id="sky-cpu" role="img" aria-label="Simulated sky" hidden></canvas>
      <div class="probe-marker" id="probe-marker" hidden></div>
      <button class="sun-handle is-hidden" id="sun-handle" type="button"
        aria-label="Sun" aria-describedby="sun-help" aria-roledescription="draggable sun">
        <span class="sun-pulse" aria-hidden="true"></span>
      </button>
      <p id="sun-help" class="sr-only">Drag the sun, or use the arrow keys to move it; hold Shift for larger steps.</p>
      <div class="hint" id="hint" aria-hidden="true">${icons.hand}<span>Drag the sun</span></div>
      <button class="sun-offscreen" id="sun-offscreen" type="button" hidden>${icons.arrowUp}<span>Sun</span></button>
    </div>

    <header class="brand glass">
      <h1>Scatter <span class="brand__tagline">why the sky is blue</span></h1>
      <nav class="brand__links" aria-label="Project links">
        <a href="https://mustafaobaidd1.github.io/">← Mustafa Obaid · Portfolio</a>
        <a href="https://github.com/mustafaobaidd1/scatter-sky-lab">Source code</a>
      </nav>
    </header>

    <nav class="dock glass" id="dock" aria-label="Tools">
      <button class="dock__btn" type="button" data-tool="story" aria-pressed="false">${icons.story}<span>Story</span></button>
      <button class="dock__btn" type="button" data-tool="experiments" aria-expanded="false" aria-controls="panel-experiments">${icons.experiments}<span>Experiments</span></button>
      <button class="dock__btn" type="button" data-tool="probe" aria-expanded="false" aria-controls="panel-probe">${icons.probe}<span>Probe</span></button>
      <button class="dock__btn" type="button" data-tool="view" aria-expanded="false" aria-controls="panel-view">${icons.view}<span>View</span></button>
      <button class="dock__btn" type="button" data-tool="how" aria-haspopup="dialog">${icons.info}<span>How it works</span></button>
    </nav>

    ${(Object.keys(PANEL_TITLES) as PanelId[])
      .map(
        (id) => `
      <section class="panel glass" id="panel-${id}" aria-labelledby="panel-${id}-title" hidden>
        <div class="panel__head">
          <h2 class="panel__title" id="panel-${id}-title">${PANEL_TITLES[id]}</h2>
          <button class="icon-btn" type="button" data-close="${id}" aria-label="Close ${PANEL_TITLES[id].toLowerCase()}">${icons.close}</button>
        </div>
        <div class="panel__body" id="panel-${id}-body"></div>
      </section>`,
      )
      .join('')}

    <section class="story glass" id="story" aria-labelledby="story-title" hidden></section>

    <div class="scrubber glass" id="scrubber"></div>
    <div class="status glass" id="status" aria-hidden="true"></div>
    <div class="banner glass" id="banner" role="status" hidden></div>
    <div class="loader glass" id="loader" role="status" aria-live="polite">
      <p id="loader-text">Preparing the sky…</p>
      <div class="loader__bar"><span id="loader-bar"></span></div>
    </div>
    <div class="sr-only" id="live" aria-live="polite"></div>
    <dialog class="how" id="how" aria-labelledby="how-title"></dialog>
  `;
  const q = <T extends Element>(sel: string) => root.querySelector(sel) as T;
  const dockButtons = {} as Layout['dockButtons'];
  root.querySelectorAll<HTMLButtonElement>('.dock__btn').forEach((b) => {
    dockButtons[b.dataset.tool as PanelId | 'story' | 'how'] = b;
  });
  const panels = {} as Record<PanelId, HTMLElement>;
  const panelBodies = {} as Record<PanelId, HTMLElement>;
  for (const id of Object.keys(PANEL_TITLES) as PanelId[]) {
    panels[id] = q(`#panel-${id}`);
    panelBodies[id] = q(`#panel-${id}-body`);
  }
  return {
    root,
    stage: q('#stage'),
    glCanvas: q('#sky-gl'),
    cpuCanvas: q('#sky-cpu'),
    sunHandle: q('#sun-handle'),
    hint: q('#hint'),
    sunOffscreen: q('#sun-offscreen'),
    probeMarker: q('#probe-marker'),
    dock: q('#dock'),
    dockButtons,
    panels,
    panelBodies,
    story: q('#story'),
    scrubber: q('#scrubber'),
    status: q('#status'),
    banner: q('#banner'),
    loader: q('#loader'),
    live: q('#live'),
    how: q('#how'),
  };
}
