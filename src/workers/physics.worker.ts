/// <reference lib="webworker" />
/**
 * Physics worker: builds atmosphere tables off the main thread and, when WebGL2 is unavailable,
 * renders CPU frames row by row (a newer frame request supersedes the one in progress).
 */
import type { AtmosphereConfig, SpectralAtmosphere } from '../physics/atmosphere';
import type { ToneMap } from '../physics/tonemap';
import type { Scene, Vec3 } from '../physics/sky';
import { TableBuilder, type TablesStage } from '../app/tables';
import type { CameraBasis } from '../render/camera';
import { renderRows } from '../render/cpuRender';

export type WorkerRequest =
  | { type: 'tables'; id: number; config: AtmosphereConfig }
  | {
      type: 'render';
      id: number;
      config: AtmosphereConfig;
      frame: {
        basis: CameraBasis;
        width: number;
        height: number;
        steps: number;
        sunDir: Vec3;
        altitude: number;
        exposure: number;
        toneMap: ToneMap;
      };
    };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: TablesStage; fraction: number }
  | {
      type: 'tables';
      id: number;
      lut: {
        width: number;
        height: number;
        bottomRadius: number;
        topRadius: number;
        data: Float32Array;
      };
      irradiance: { muS: Float64Array; values: Float64Array; n: number };
      dust: {
        lambdas: Float64Array;
        qext: Float64Array;
        ssa: Float64Array;
        g: Float64Array;
        phase: Float64Array;
      } | null;
      ms: number;
    }
  | {
      type: 'rows';
      id: number;
      y0: number;
      y1: number;
      width: number;
      height: number;
      pixels: Uint8ClampedArray;
    }
  | { type: 'frameDone'; id: number; ms: number }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const builder = new TableBuilder();
let latestRender = 0;
let cached: {
  key: string;
  scene: Omit<Scene, 'altitude' | 'sunDir'> & { atm: SpectralAtmosphere };
} | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function sceneFor(config: AtmosphereConfig, id: number) {
  const key = JSON.stringify(config);
  if (!cached || cached.key !== key) {
    const t = builder.build(config, (stage, fraction) =>
      post({ type: 'progress', id, stage, fraction }),
    );
    cached = { key, scene: { atm: t.atm, lut: t.lut, irradiance: t.irradiance } };
  }
  return cached.scene;
}

async function render(req: Extract<WorkerRequest, { type: 'render' }>) {
  latestRender = req.id;
  const t0 = performance.now();
  const base = sceneFor(req.config, req.id);
  const f = req.frame;
  const scene: Scene = { ...base, altitude: f.altitude, sunDir: f.sunDir };
  const rowsPerChunk = Math.max(1, Math.floor(4000 / f.width));
  for (let y0 = 0; y0 < f.height; y0 += rowsPerChunk) {
    if (latestRender !== req.id) return; // superseded
    const y1 = Math.min(f.height, y0 + rowsPerChunk);
    const pixels = new Uint8ClampedArray(f.width * (y1 - y0) * 4);
    renderRows(
      {
        scene,
        basis: f.basis,
        width: f.width,
        height: f.height,
        exposure: f.exposure,
        steps: f.steps,
        toneMap: f.toneMap,
      },
      y0,
      y1,
      pixels,
      y0,
    );
    post({ type: 'rows', id: req.id, y0, y1, width: f.width, height: f.height, pixels }, [
      pixels.buffer,
    ]);
    await new Promise((r) => setTimeout(r, 0)); // let newer requests in
  }
  post({ type: 'frameDone', id: req.id, ms: performance.now() - t0 });
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'tables') {
      const t0 = performance.now();
      const t = builder.build(req.config, (stage, fraction) =>
        post({ type: 'progress', id: req.id, stage, fraction }),
      );
      const lutData = new Float32Array(t.lut.data);
      const muS = new Float64Array(t.irradiance.muS);
      const values = new Float64Array(t.irradiance.values);
      const dust = t.dust
        ? {
            lambdas: new Float64Array(t.dust.lambdas),
            qext: new Float64Array(t.dust.qext),
            ssa: new Float64Array(t.dust.ssa),
            g: new Float64Array(t.dust.g),
            phase: new Float64Array(t.dust.phase),
          }
        : null;
      const transfer: Transferable[] = [lutData.buffer, muS.buffer, values.buffer];
      if (dust) transfer.push(dust.phase.buffer);
      post(
        {
          type: 'tables',
          id: req.id,
          lut: {
            width: t.lut.width,
            height: t.lut.height,
            bottomRadius: t.lut.bottomRadius,
            topRadius: t.lut.topRadius,
            data: lutData,
          },
          irradiance: { muS, values, n: t.irradiance.n },
          dust,
          ms: performance.now() - t0,
        },
        transfer,
      );
    } else if (req.type === 'render') {
      void render(req).catch((err: unknown) =>
        post({ type: 'error', id: req.id, message: String(err) }),
      );
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: String(err) });
  }
};
