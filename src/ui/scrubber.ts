/**
 * The sun-elevation scrubber: left is high sun, right is night, like an afternoon running into
 * evening. The track is non-linear so the low-sun range (where the colours change) gets most of
 * the travel.
 */
import { sunPhase, type Store } from '../app/state';
import { fmt, paintRange } from './dom';

/** (track position 0–1, solar elevation in degrees) knots, piecewise linear. */
const KNOTS: [number, number][] = [
  [0, 75],
  [0.25, 30],
  [0.5, 8],
  [0.72, 0],
  [0.86, -6],
  [1, -18],
];

export function elevationAt(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 0; i < KNOTS.length - 1; i++) {
    const [t0, e0] = KNOTS[i];
    const [t1, e1] = KNOTS[i + 1];
    if (x <= t1) return e0 + ((x - t0) / (t1 - t0)) * (e1 - e0);
  }
  return KNOTS[KNOTS.length - 1][1];
}

export function trackAt(elevation: number): number {
  const e = Math.min(KNOTS[0][1], Math.max(KNOTS[KNOTS.length - 1][1], elevation));
  for (let i = 0; i < KNOTS.length - 1; i++) {
    const [t0, e0] = KNOTS[i];
    const [t1, e1] = KNOTS[i + 1];
    if (e >= e1) return t0 + ((e0 - e) / (e0 - e1)) * (t1 - t0);
  }
  return 1;
}

export function describeSun(elevation: number): string {
  const e = fmt(elevation, 1);
  const where = elevation >= 0 ? 'above' : 'below';
  return `Sun ${e.replace('−', '')}° ${where} the horizon, ${sunPhase(elevation)}`;
}

export function mountScrubber(host: HTMLElement, store: Store, onUse: () => void): () => void {
  const ticks: [number, string, string?][] = [
    [0, 'High sun'],
    [trackAt(1), 'Golden hour'],
    [trackAt(-5), 'Blue hour', 'wide'],
    [1, 'Night'],
  ];
  host.innerHTML = `
    <div class="scrubber__head">
      <label class="scrubber__label" for="sun-elevation">Sun elevation</label>
      <output class="scrubber__value" id="sun-elevation-value" for="sun-elevation"></output>
    </div>
    <div class="scrubber__track">
      <input class="range" id="sun-elevation" type="range" min="0" max="1000" step="1" />
      <div class="scrubber__ticks" aria-hidden="true">
        ${ticks
          .map(
            ([t, label, cls]) =>
              `<span class="${cls ? 'tick--' + cls : ''}" style="left:${(t * 100).toFixed(2)}%">${label}</span>`,
          )
          .join('')}
      </div>
    </div>`;
  const input = host.querySelector<HTMLInputElement>('#sun-elevation')!;
  const output = host.querySelector<HTMLOutputElement>('#sun-elevation-value')!;
  let dragging = false;

  const sync = () => {
    const e = store.get().sunElevation;
    if (!dragging) input.value = String(Math.round(trackAt(e) * 1000));
    output.textContent = `${fmt(e, 1)}° · ${sunPhase(e)}`;
    input.setAttribute('aria-valuetext', describeSun(e));
    paintRange(input);
  };
  input.addEventListener('input', () => {
    dragging = true;
    store.set({ sunElevation: Math.round(elevationAt(Number(input.value) / 1000) * 100) / 100 });
    onUse();
  });
  input.addEventListener('change', () => {
    dragging = false;
    sync();
  });
  const unsub = store.subscribe((_s, changed) => {
    if (changed.has('sunElevation')) sync();
  });
  sync();
  return unsub;
}
