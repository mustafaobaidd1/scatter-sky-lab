/**
 * Main-thread side of the physics worker. Table requests are coalesced (one in flight; only the
 * newest pending configuration is sent next). Falls back to building on the main thread if a
 * worker cannot be created.
 */
import type { AtmosphereConfig } from '../physics/atmosphere';
import type { ColumnLut } from '../physics/lut';
import type { DustOptics } from '../physics/marsDust';
import type { IrradianceTable } from '../physics/sky';
import type { WorkerRequest, WorkerResponse } from '../workers/physics.worker';
import { TableBuilder, type Tables, type TablesStage } from './tables';

type RenderFrame = Extract<WorkerRequest, { type: 'render' }>['frame'];

export interface RowsHandler {
  (rows: {
    y0: number;
    y1: number;
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
  }): void;
}

export class PhysicsClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private inFlight: {
    id: number;
    resolve: (t: Tables) => void;
    reject: (e: Error) => void;
  } | null = null;
  private pending: {
    config: AtmosphereConfig;
    waiters: { resolve: (t: Tables) => void; reject: (e: Error) => void }[];
  } | null = null;
  private renderHandlers = new Map<number, { onRows: RowsHandler; onDone: (ms: number) => void }>();
  private fallback: TableBuilder | null = null;

  constructor(private readonly onProgress: (stage: TablesStage, fraction: number) => void) {
    try {
      this.worker = new Worker(new URL('../workers/physics.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
      this.worker.onerror = () => {
        // A worker that fails to start (e.g. blocked) degrades to main-thread builds.
        this.worker = null;
        this.fallback = new TableBuilder();
      };
    } catch {
      this.worker = null;
      this.fallback = new TableBuilder();
    }
  }

  /** Resolves with tables for the newest configuration requested (older requests share it). */
  requestTables(config: AtmosphereConfig): Promise<Tables> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        try {
          this.fallback ??= new TableBuilder();
          const t = this.fallback.build(config, this.onProgress);
          resolve({ lut: t.lut, irradiance: t.irradiance, dust: t.dust });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      if (this.inFlight) {
        if (this.pending) this.pending.config = config;
        else this.pending = { config, waiters: [] };
        this.pending.waiters.push({ resolve, reject });
        return;
      }
      this.send(config, { resolve, reject });
    });
  }

  private send(
    config: AtmosphereConfig,
    waiter: { resolve: (t: Tables) => void; reject: (e: Error) => void },
  ) {
    const id = this.nextId++;
    this.inFlight = { id, ...waiter };
    this.worker?.postMessage({ type: 'tables', id, config } satisfies WorkerRequest);
  }

  render(
    config: AtmosphereConfig,
    frame: RenderFrame,
    onRows: RowsHandler,
    onDone: (ms: number) => void,
  ): number {
    const id = this.nextId++;
    this.renderHandlers.clear();
    this.renderHandlers.set(id, { onRows, onDone });
    this.worker?.postMessage({ type: 'render', id, config, frame } satisfies WorkerRequest);
    return id;
  }

  get hasWorker(): boolean {
    return this.worker !== null;
  }

  private handle(msg: WorkerResponse) {
    switch (msg.type) {
      case 'progress':
        this.onProgress(msg.stage, msg.fraction);
        break;
      case 'tables': {
        const lut: ColumnLut = { ...msg.lut };
        const irradiance: IrradianceTable = { ...msg.irradiance };
        const dust: DustOptics | null = msg.dust ? { ...msg.dust } : null;
        const tables = { lut, irradiance, dust };
        const done = this.inFlight;
        this.inFlight = null;
        if (this.pending) {
          const next = this.pending;
          this.pending = null;
          // Earlier callers get these tables now; the newest configuration follows.
          done?.resolve(tables);
          const [first, ...rest] = next.waiters;
          this.send(next.config, {
            resolve: (t) => {
              first.resolve(t);
              for (const w of rest) w.resolve(t);
            },
            reject: (e) => {
              first.reject(e);
              for (const w of rest) w.reject(e);
            },
          });
        } else done?.resolve(tables);
        break;
      }
      case 'rows':
        this.renderHandlers.get(msg.id)?.onRows(msg);
        break;
      case 'frameDone':
        this.renderHandlers.get(msg.id)?.onDone(msg.ms);
        break;
      case 'error':
        if (this.inFlight?.id === msg.id) {
          this.inFlight.reject(new Error(msg.message));
          this.inFlight = null;
        }
        break;
    }
  }
}
