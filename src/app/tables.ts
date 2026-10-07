/**
 * Builds the atmosphere-dependent tables (column LUT, skylight table, Mars dust optics). Shared by
 * the physics worker and by the main-thread fallback used when workers are unavailable.
 */
import {
  buildAtmosphere,
  type AtmosphereConfig,
  type SpectralAtmosphere,
} from '../physics/atmosphere';
import { buildColumnLut, type ColumnLut } from '../physics/lut';
import { computeDustOptics, type DustOptics } from '../physics/marsDust';
import { buildIrradianceTable, type IrradianceTable } from '../physics/sky';
import { wavelengthGrid } from '../physics/spectral';

/** The renderer's 16 wavelengths, 380–720 nm. */
export const RENDER_GRID = wavelengthGrid(16);
/** The probe's 5 nm grid, 380–720 nm. */
export const PROBE_GRID = wavelengthGrid(69);
/** Mie computations for Mars dust run on a 10 nm grid and are interpolated. */
export const DUST_GRID = wavelengthGrid(35);

export type TablesStage = 'mie' | 'lut' | 'irradiance';

export interface Tables {
  lut: ColumnLut;
  irradiance: IrradianceTable;
  dust: DustOptics | null;
}

export class TableBuilder {
  private lutCache = new Map<string, ColumnLut>();
  private dust: DustOptics | null = null;

  /** Key of the vertical profiles (what the column LUT depends on). */
  static profileKey(config: AtmosphereConfig): string {
    return config.planet === 'mars' ? 'mars' : `earth:${config.aerosolPreset}`;
  }

  dustOptics(onProgress?: (stage: TablesStage, f: number) => void): DustOptics {
    if (!this.dust) {
      this.dust = computeDustOptics(DUST_GRID, {
        radii: 64,
        onProgress: (f) => onProgress?.('mie', f),
      });
    }
    return this.dust;
  }

  atmosphere(
    config: AtmosphereConfig,
    grid: Float64Array,
    onProgress?: (stage: TablesStage, f: number) => void,
  ) {
    const dust = config.planet === 'mars' ? this.dustOptics(onProgress) : null;
    return buildAtmosphere(config, grid, dust);
  }

  build(
    config: AtmosphereConfig,
    onProgress?: (stage: TablesStage, f: number) => void,
  ): Tables & { atm: SpectralAtmosphere } {
    const atm = this.atmosphere(config, RENDER_GRID, onProgress);
    const key = TableBuilder.profileKey(config);
    let lut = this.lutCache.get(key);
    if (!lut) {
      onProgress?.('lut', 0);
      lut = buildColumnLut(atm);
      this.lutCache.set(key, lut);
      if (this.lutCache.size > 8) this.lutCache.delete(this.lutCache.keys().next().value as string);
    }
    onProgress?.('irradiance', 0);
    const irradiance = buildIrradianceTable(atm, lut);
    return { atm, lut, irradiance, dust: atm.dust ? this.dust : null };
  }
}
