/** Small SVG charts of spectra. */
import { spectralSwatch, toHex } from '../physics/colour';
import { fmt } from './dom';

export interface Series {
  values: ArrayLike<number>;
  label: string;
  style: 'fill' | 'line' | 'dash' | 'thin';
  /** Optional explicit scale; otherwise each series is normalised to its own maximum. */
  scale?: number;
}

export interface ChartOptions {
  lambdas: ArrayLike<number>;
  series: Series[];
  width?: number;
  height?: number;
  /** y-axis caption, e.g. units. */
  yLabel?: string;
  /** Tick values in data units for the first series (when it has an explicit scale). */
  yTicks?: number[];
  title: string;
  desc: string;
}

let gradientId = 0;

export function spectralGradient(id: string, min = 380, max = 720): string {
  const stops: string[] = [];
  for (let l = min; l <= max; l += 20) {
    stops.push(
      `<stop offset="${(((l - min) / (max - min)) * 100).toFixed(1)}%" stop-color="${toHex(spectralSwatch(l))}"/>`,
    );
  }
  return `<linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0">${stops.join('')}</linearGradient>`;
}

export function spectrumChart(o: ChartOptions): string {
  const W = o.width ?? 320;
  const H = o.height ?? 156;
  const left = 38;
  const right = W - 8;
  const top = o.yLabel ? 22 : 10;
  const bottom = H - 26;
  const lmin = 380;
  const lmax = 720;
  const x = (l: number) => left + ((l - lmin) / (lmax - lmin)) * (right - left);
  const gid = `spec-grad-${++gradientId}`;
  const parts: string[] = [];
  parts.push(`<defs>${spectralGradient(gid)}</defs>`);
  // grid + axes
  for (const l of [400, 500, 600, 700]) {
    parts.push(`<line class="grid" x1="${x(l)}" x2="${x(l)}" y1="${top}" y2="${bottom}"/>`);
    parts.push(`<text x="${x(l)}" y="${bottom + 14}" text-anchor="middle">${l}</text>`);
  }
  parts.push(`<line class="axis" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>`);
  parts.push(`<text x="${right}" y="${H - 1}" text-anchor="end">wavelength (nm)</text>`);
  const n = o.lambdas.length;
  for (const s of o.series) {
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, s.values[i]);
    const scale = s.scale ?? (max > 0 ? 1 / max : 1);
    const y = (v: number) => bottom - Math.min(1.05, Math.max(0, v * scale)) * (bottom - top);
    const pts: string[] = [];
    for (let i = 0; i < n; i++)
      pts.push(`${x(o.lambdas[i]).toFixed(1)},${y(s.values[i]).toFixed(1)}`);
    if (s.style === 'fill') {
      parts.push(
        `<polygon points="${x(o.lambdas[0]).toFixed(1)},${bottom} ${pts.join(' ')} ${x(o.lambdas[n - 1]).toFixed(1)},${bottom}" fill="url(#${gid})" fill-opacity="0.62"/>`,
      );
      parts.push(
        `<polyline points="${pts.join(' ')}" fill="none" stroke="#f6f4ef" stroke-width="1.8"/>`,
      );
    } else {
      const dash = s.style === 'dash' ? ' stroke-dasharray="4 3"' : '';
      const width = s.style === 'thin' ? 1.2 : 1.6;
      const opacity = s.style === 'thin' ? 0.75 : 0.95;
      parts.push(
        `<polyline points="${pts.join(' ')}" fill="none" stroke="#f6f4ef" stroke-opacity="${opacity}" stroke-width="${width}"${dash}/>`,
      );
    }
  }
  if (o.yTicks && o.series[0]?.scale) {
    const sc = o.series[0].scale;
    for (const t of o.yTicks) {
      const yy = bottom - t * sc * (bottom - top);
      parts.push(
        `<line class="grid" x1="${left}" x2="${right}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/>`,
      );
      parts.push(
        `<text x="${left - 5}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${formatTick(t)}</text>`,
      );
    }
  }
  if (o.yLabel) {
    parts.push(`<text x="0" y="10" text-anchor="start">${o.yLabel}</text>`);
  }
  const tid = `chart-t-${gradientId}`;
  const did = `chart-d-${gradientId}`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${tid} ${did}"><title id="${tid}">${o.title}</title><desc id="${did}">${o.desc}</desc>${parts.join('')}</svg>`;
}

function formatTick(v: number): string {
  if (v === 0) return '0';
  if (v >= 100) return Math.round(v).toString();
  if (v >= 1) return fmt(v, v >= 10 ? 0 : 1);
  const e = Math.floor(Math.log10(v));
  const m = v / Math.pow(10, e);
  return `${fmt(m, m % 1 === 0 ? 0 : 1)}e${e}`;
}

/** "Nice" tick values covering [0, max]. */
export function niceTicks(max: number, count = 3): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const ticks: number[] = [];
  for (let t = step; t <= max * 1.001; t += step) ticks.push(t);
  return ticks;
}
