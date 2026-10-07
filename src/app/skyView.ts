/**
 * Owns the renderer (WebGL2, or the CPU fallback), the atmosphere tables, frame scheduling with
 * dynamic resolution, exposure metering and the spectrum probe.
 */
import { colourStats, type ColourStats } from '../physics/analysis';
import { buildAtmosphere, type SpectralAtmosphere } from '../physics/atmosphere';
import { cmfWeights, radianceToXyz, type Vec3 as ColourVec3 } from '../physics/colour';
import { lookupColumns, type ColumnLut } from '../physics/lut';
import type { DustOptics } from '../physics/marsDust';
import { dirFromAngles, type IrradianceTable, type Scene, type Vec3 } from '../physics/sky';
import { interpolateSamples } from '../physics/spectral';
import { cameraBasis, project, rayThrough, type CameraBasis } from '../render/camera';
import { radianceToDisplay } from '../render/cpuRender';
import { meterView, type ExposureResult } from '../render/exposure';
import { packAtmosphere } from '../render/gpuData';
import { shadeDirection, type SampleKind } from '../render/shade';
import { hillWeight } from '../render/terrain';
import { createContext, WebGLSkyRenderer, type RendererStatus } from '../render/webglRenderer';
import { PhysicsClient } from './physicsClient';
import { atmosphereConfig, profileKey, spectralKey, type SimState, type Store } from './state';
import { PROBE_GRID, RENDER_GRID, type TablesStage } from './tables';

export type RendererKind = 'webgl' | 'cpu';

export type ViewStatus =
  | { phase: 'loading'; step: 'shaders' | TablesStage | 'first-frame'; fraction?: number }
  | { phase: 'ready' }
  | { phase: 'updating' }
  | { phase: 'lost' }
  | { phase: 'error'; message: string };

export interface ProbeResult {
  direction: Vec3;
  elevation: number;
  azimuth: number;
  lambdas: Float64Array;
  radiance: Float64Array;
  rayleigh: Float64Array;
  aerosol: Float64Array;
  surface: Float64Array;
  sun: Float64Array;
  solar: Float64Array;
  kind: SampleKind;
  stats: ColourStats;
  display: ColourVec3;
  shares: { rayleigh: number; aerosol: number; surface: number; sun: number };
}

export interface FrameInfo {
  basis: CameraBasis;
  cssWidth: number;
  cssHeight: number;
  exposure: ExposureResult | null;
  scale: number;
  renderer: RendererKind;
}

interface Options {
  glCanvas: HTMLCanvasElement;
  cpuCanvas: HTMLCanvasElement;
  store: Store;
  forceCpu: boolean;
  /** Fixed render scale for tests (?scale=). */
  fixedScale: number | null;
  onStatus: (s: ViewStatus) => void;
  onFrame: (info: FrameInfo) => void;
  onRenderer: (kind: RendererKind, reason: string | null) => void;
}

interface AtmosphereBundle {
  key: string;
  profile: string;
  atm: SpectralAtmosphere;
  probeAtm: SpectralAtmosphere;
  lut: ColumnLut;
  irradiance: IrradianceTable;
  probeIrradiance: IrradianceTable;
}

const MAX_DPR = 2;
const FINAL_STEPS = 48;
const INTERACTIVE_STEPS = 24;

export class SkyView {
  private renderer: WebGLSkyRenderer | null = null;
  kind: RendererKind = 'webgl';
  private physics: PhysicsClient;
  private bundle: AtmosphereBundle | null = null;
  private dust: DustOptics | null = null;
  private tablesFor = '';
  private raf = 0;
  private finalTimer = 0;
  private wantFinal = false;
  private interactiveUntil = 0;
  private scale = 0.75;
  private lastFrameTime = 0;
  private exposure: ExposureResult | null = null;
  private exposureDirtyAt = 0;
  private exposureMeteredAt = 0;
  private cssSize = [1, 1];
  private dpr = 1;
  private cpuCtx: CanvasRenderingContext2D | null = null;
  private cpuImage: ImageData | null = null;
  private cpuBusy = false;
  private cpuQueued = false;
  private firstFrameDone = false;
  private destroyed = false;
  private unsub: () => void;
  basis: CameraBasis | null = null;

  constructor(private readonly opts: Options) {
    this.physics = new PhysicsClient((stage, fraction) => {
      if (!this.firstFrameDone) opts.onStatus({ phase: 'loading', step: stage, fraction });
    });
    this.unsub = opts.store.subscribe((s, changed) => this.onState(s, changed));
  }

  async start(): Promise<void> {
    const o = this.opts;
    let reason: string | null = null;
    // Build the tables in the worker while the shader compiles.
    const tables = this.refreshTables(true);
    if (!o.forceCpu) {
      const gl = createContext(o.glCanvas);
      if (!gl) reason = 'WebGL2 is not available in this browser';
      else {
        this.renderer = new WebGLSkyRenderer(o.glCanvas, gl, (s, d) => this.onRendererStatus(s, d));
        o.onStatus({ phase: 'loading', step: 'shaders' });
        try {
          await this.renderer.init();
        } catch (err) {
          console.warn('[scatter] WebGL2 shader failed; using the CPU renderer.', err);
          reason = 'the sky shader could not be compiled on this device';
          this.renderer = null;
        }
      }
    } else reason = 'forced by ?renderer=cpu';
    if (!this.renderer) this.useCpu(reason);
    else o.onRenderer('webgl', null);
    this.resize();
    await tables;
    if (this.bundle)
      this.renderer?.setAtmosphere(
        packAtmosphere(this.bundle.atm, this.bundle.lut, this.bundle.irradiance),
      );
    this.requestFinal();
  }

  private useCpu(reason: string | null) {
    this.kind = 'cpu';
    this.opts.glCanvas.hidden = true;
    this.opts.cpuCanvas.hidden = false;
    this.cpuCtx = this.opts.cpuCanvas.getContext('2d');
    this.opts.onRenderer('cpu', reason);
  }

  private onRendererStatus(s: RendererStatus, detail?: string) {
    if (s === 'lost') this.opts.onStatus({ phase: 'lost' });
    else if (s === 'ready' && this.firstFrameDone) {
      this.opts.onStatus({ phase: 'ready' });
      if (this.bundle)
        this.renderer?.setAtmosphere(
          packAtmosphere(this.bundle.atm, this.bundle.lut, this.bundle.irradiance),
        );
      this.requestFinal();
    } else if (s === 'failed' && this.firstFrameDone) {
      this.renderer = null;
      this.useCpu(`the WebGL renderer failed (${detail ?? 'unknown'})`);
      this.requestFinal();
    }
  }

  /** Builds or refreshes the atmosphere for the current state. */
  private async refreshTables(initial = false): Promise<void> {
    const s = this.opts.store.get();
    const key = spectralKey(s);
    const profile = profileKey(s);
    if (key === this.tablesFor) return;
    this.tablesFor = key;
    const config = atmosphereConfig(s);

    // Spectral changes on the same vertical profile: update coefficients now with the current
    // LUT (it only depends on the profiles); the skylight table follows from the worker.
    if (this.bundle && this.bundle.profile === profile && (s.planet === 'earth' || this.dust)) {
      this.applyBundle({
        ...this.bundle,
        key,
        atm: buildAtmosphere(config, RENDER_GRID, this.dust),
        probeAtm: buildAtmosphere(config, PROBE_GRID, this.dust),
      });
    } else if (!initial) this.opts.onStatus({ phase: 'updating' });

    try {
      const t = await this.physics.requestTables(config);
      if (this.destroyed) return;
      if (t.dust) this.dust = t.dust;
      const latest = this.opts.store.get();
      if (spectralKey(latest) !== key) return; // superseded by a newer request
      const atm = buildAtmosphere(config, RENDER_GRID, this.dust);
      const probeAtm = buildAtmosphere(config, PROBE_GRID, this.dust);
      this.applyBundle({
        key,
        profile,
        atm,
        probeAtm,
        lut: t.lut,
        irradiance: t.irradiance,
        probeIrradiance: resampleIrradiance(t.irradiance, RENDER_GRID, PROBE_GRID),
      });
      if (this.firstFrameDone) this.opts.onStatus({ phase: 'ready' });
    } catch (err) {
      this.opts.onStatus({
        phase: 'error',
        message: `The atmosphere tables could not be built: ${String(err)}`,
      });
    }
  }

  private applyBundle(b: AtmosphereBundle) {
    this.bundle = b;
    this.renderer?.setAtmosphere(packAtmosphere(b.atm, b.lut, b.irradiance));
    this.exposureDirtyAt = performance.now();
    this.requestFinal();
  }

  private onState(_s: SimState, changed: ReadonlySet<keyof SimState>) {
    const spectral: (keyof SimState)[] = [
      'planet',
      'rayleighExponent',
      'ozone',
      'aerosolPreset',
      'aerosolTau',
      'aerosolAngstrom',
      'marsDustTau',
    ];
    if (spectral.some((k) => changed.has(k))) void this.refreshTables();
    this.exposureDirtyAt = performance.now();
    this.requestInteractive();
  }

  /** Marks the view as being manipulated: render quickly now, refine when it settles. */
  requestInteractive(): void {
    this.interactiveUntil = performance.now() + 140;
    this.schedule();
    clearTimeout(this.finalTimer);
    this.finalTimer = window.setTimeout(() => this.requestFinal(), 160);
  }

  requestFinal(): void {
    this.wantFinal = true;
    this.schedule();
  }

  private schedule() {
    if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  resize(): void {
    const c = this.opts.glCanvas.parentElement ?? document.body;
    const rect = c.getBoundingClientRect();
    this.cssSize = [Math.max(1, rect.width), Math.max(1, rect.height)];
    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    if (this.kind === 'webgl') {
      this.opts.glCanvas.width = Math.round(this.cssSize[0] * this.dpr);
      this.opts.glCanvas.height = Math.round(this.cssSize[1] * this.dpr);
    }
    this.exposureDirtyAt = performance.now();
    this.requestFinal();
  }

  /** Current camera basis for the CSS viewport. */
  currentBasis(): CameraBasis {
    const s = this.opts.store.get();
    return cameraBasis(
      { yaw: s.yaw, pitch: s.pitch, fov: s.fov },
      this.cssSize[0],
      this.cssSize[1],
    );
  }

  private scene(atm?: SpectralAtmosphere, irr?: IrradianceTable): Scene | null {
    const b = this.bundle;
    if (!b) return null;
    const s = this.opts.store.get();
    return {
      atm: atm ?? b.atm,
      lut: b.lut,
      irradiance: irr ?? b.irradiance,
      altitude: s.altitude,
      sunDir: dirFromAngles(s.sunElevation, s.sunAzimuth),
    };
  }

  private meter(basis: CameraBasis, now: number, interactive: boolean) {
    const s = this.opts.store.get();
    const stale = this.exposureDirtyAt > this.exposureMeteredAt;
    if (!this.exposure || (stale && (!interactive || now - this.exposureMeteredAt > 90))) {
      const scene = this.scene();
      if (!scene) return;
      this.exposure = meterView(scene, basis, s.exposureEv, 5, 4);
      this.exposureMeteredAt = now;
    }
  }

  private frame(now: number) {
    this.raf = 0;
    if (!this.bundle || this.destroyed) return;
    const interactive = now < this.interactiveUntil && !this.opts.fixedScale;
    const final = !interactive && this.wantFinal;
    if (!interactive && !final) return;
    const s = this.opts.store.get();
    const basis = this.currentBasis();
    this.basis = basis;
    this.meter(basis, now, interactive);
    if (!this.exposure) return;

    if (this.kind === 'webgl' && this.renderer) {
      // Dynamic resolution: adapt to the interval between consecutive interactive frames.
      if (interactive && this.lastFrameTime > 0) {
        const dt = now - this.lastFrameTime;
        if (dt > 26) this.scale = Math.max(0.3, this.scale * 0.85);
        else if (dt < 15) this.scale = Math.min(1, this.scale * 1.06);
      }
      const scale = this.opts.fixedScale ?? (final ? 1 : this.scale);
      const ok = this.renderer.render({
        basis: cameraBasis(
          { yaw: s.yaw, pitch: s.pitch, fov: s.fov },
          this.opts.glCanvas.width,
          this.opts.glCanvas.height,
        ),
        width: this.opts.glCanvas.width,
        height: this.opts.glCanvas.height,
        scale,
        steps: final ? FINAL_STEPS : INTERACTIVE_STEPS,
        sunDir: dirFromAngles(s.sunElevation, s.sunAzimuth),
        altitude: s.altitude,
        exposure: this.exposure.exposure,
        toneMap: s.toneMap,
        hillWeight: hillWeight(s.altitude),
      });
      if (!ok) return;
      this.lastFrameTime = interactive ? now : 0;
      if (final) this.wantFinal = false;
      this.afterFrame(basis, scale);
    } else if (this.kind === 'cpu') {
      this.renderCpu(final, basis);
    }
    if (interactive) this.schedule();
  }

  private afterFrame(basis: CameraBasis, scale: number) {
    if (!this.firstFrameDone) {
      this.firstFrameDone = true;
      this.opts.onStatus({ phase: 'ready' });
    }
    this.opts.onFrame({
      basis,
      cssWidth: this.cssSize[0],
      cssHeight: this.cssSize[1],
      exposure: this.exposure,
      scale,
      renderer: this.kind,
    });
  }

  private renderCpu(final: boolean, basis: CameraBasis) {
    if (this.cpuBusy) {
      this.cpuQueued = true;
      return;
    }
    const s = this.opts.store.get();
    const target = final ? 4.5 : 9; // CSS pixels per rendered pixel
    const w = Math.max(48, Math.min(360, Math.round(this.cssSize[0] / target)));
    const h = Math.max(32, Math.round((w * this.cssSize[1]) / this.cssSize[0]));
    const canvas = this.opts.cpuCanvas;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      this.cpuImage = null;
    }
    if (!this.cpuImage) this.cpuImage = new ImageData(w, h);
    const image = this.cpuImage;
    this.cpuBusy = true;
    if (final) this.wantFinal = false;
    const frameBasis = cameraBasis({ yaw: s.yaw, pitch: s.pitch, fov: s.fov }, w, h);
    this.physics.render(
      atmosphereConfig(s),
      {
        basis: frameBasis,
        width: w,
        height: h,
        steps: final ? 32 : 16,
        sunDir: dirFromAngles(s.sunElevation, s.sunAzimuth),
        altitude: s.altitude,
        exposure: this.exposure!.exposure,
        toneMap: s.toneMap,
      },
      (rows) => {
        if (rows.width !== image.width) return;
        image.data.set(rows.pixels, rows.y0 * rows.width * 4);
        this.cpuCtx?.putImageData(image, 0, 0, 0, rows.y0, rows.width, rows.y1 - rows.y0);
      },
      () => {
        this.cpuBusy = false;
        this.afterFrame(basis, w / this.cssSize[0]);
        if (this.cpuQueued) {
          this.cpuQueued = false;
          this.requestFinal();
        }
      },
    );
  }

  /** Renders a final frame now (tests and screenshots); resolves when it is on screen. */
  async renderNow(): Promise<void> {
    if (!this.bundle) await this.refreshTables();
    this.wantFinal = true;
    this.interactiveUntil = 0;
    if (this.kind === 'webgl') {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.frame(performance.now());
      return;
    }
    await new Promise<void>((resolve) => {
      const check = () => (this.cpuBusy || this.wantFinal ? setTimeout(check, 30) : resolve());
      this.schedule();
      setTimeout(check, 30);
    });
  }

  readPixel(u: number, v: number): [number, number, number] | null {
    if (this.kind === 'webgl') return this.renderer?.readPixel(u, v) ?? null;
    const c = this.opts.cpuCanvas;
    const ctx = this.cpuCtx;
    if (!ctx) return null;
    const d = ctx.getImageData(
      Math.min(c.width - 1, Math.floor(u * c.width)),
      Math.min(c.height - 1, Math.floor(v * c.height)),
      1,
      1,
    ).data;
    return [d[0], d[1], d[2]];
  }

  /** Screen position (CSS px) of a world direction. */
  screenOf(d: Vec3): { x: number; y: number } | null {
    return project(this.currentBasis(), d, this.cssSize[0], this.cssSize[1]);
  }

  directionAt(x: number, y: number): Vec3 {
    const b = this.currentBasis();
    return rayThrough(b, (2 * x) / this.cssSize[0] - 1, 1 - (2 * y) / this.cssSize[1]);
  }

  get size(): [number, number] {
    return [this.cssSize[0], this.cssSize[1]];
  }

  get currentExposure(): ExposureResult | null {
    return this.exposure;
  }

  get atmosphere(): SpectralAtmosphere | null {
    return this.bundle?.atm ?? null;
  }

  /** Spectral radiance and colorimetry for a view direction, on the 5 nm probe grid. */
  probe(direction: Vec3): ProbeResult | null {
    const b = this.bundle;
    const scene = this.scene(b?.probeAtm, b?.probeIrradiance);
    if (!b || !scene || !this.exposure) return null;
    const s = this.opts.store.get();
    const basis = this.currentBasis();
    const res = shadeDirection(scene, direction, {
      steps: 96,
      pixelAngle: (2 * basis.tanY) / this.cssSize[1],
    });
    const stats = colourStats(PROBE_GRID, res.radiance);
    const w = cmfWeights(PROBE_GRID);
    const Y = (a: Float64Array) => radianceToXyz(a, w)[1];
    const total = Math.max(1e-30, stats.luminance);
    const el = (Math.asin(Math.max(-1, Math.min(1, direction[1]))) * 180) / Math.PI;
    let az = (Math.atan2(direction[0], direction[2]) * 180) / Math.PI;
    if (az < 0) az += 360;
    return {
      direction,
      elevation: el,
      azimuth: az,
      lambdas: PROBE_GRID,
      radiance: res.radiance,
      rayleigh: res.rayleigh,
      aerosol: res.aerosol,
      surface: res.surface,
      sun: res.sun,
      solar: b.probeAtm.solar,
      kind: res.kind,
      stats,
      display: radianceToDisplay(res.radiance, w, this.exposure.exposure, s.toneMap),
      shares: {
        rayleigh: Y(res.rayleigh) / total,
        aerosol: Y(res.aerosol) / total,
        surface: Y(res.surface) / total,
        sun: Y(res.sun) / total,
      },
    };
  }

  /**
   * Relative air mass toward the sun at the given elevation: the molecular column along the slant
   * path divided by the vertical one, from the same table the renderer uses.
   */
  airMass(elevationDeg: number): number {
    const b = this.bundle;
    if (!b) return 1;
    const r = b.atm.bottomRadius + this.opts.store.get().altitude;
    const mu = Math.sin((Math.max(0, elevationDeg) * Math.PI) / 180);
    const slant = lookupColumns(b.lut, r, mu, new Float64Array(4))[0];
    const zenith = lookupColumns(b.lut, r, 1, new Float64Array(4))[0];
    return zenith > 0 ? slant / zenith : 1;
  }

  simulateContextLoss(): boolean {
    return this.renderer?.simulateContextLoss() ?? false;
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.finalTimer);
    this.unsub();
    this.renderer?.dispose();
  }
}

/** Linear interpolation of a skylight table onto another wavelength grid (smooth in λ). */
function resampleIrradiance(
  t: IrradianceTable,
  from: Float64Array,
  to: Float64Array,
): IrradianceTable {
  const rows = t.muS.length;
  const values = new Float64Array(rows * to.length);
  for (let m = 0; m < rows; m++) {
    const row = t.values.subarray(m * t.n, (m + 1) * t.n);
    for (let i = 0; i < to.length; i++)
      values[m * to.length + i] = interpolateSamples(from, row, to[i]);
  }
  return { muS: t.muS, values, n: to.length };
}
