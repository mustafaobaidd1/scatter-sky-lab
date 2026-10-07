/**
 * WebGL2 renderer: one full-screen spectral pass into an RGBA8 target (at a dynamic resolution
 * scale), then a bilinear blit to the canvas. Tables come from the CPU (column LUT, skylight,
 * Mars dust phase function) as half-float textures. Handles context loss and restore.
 */
import type { ToneMap } from '../physics/tonemap';
import { AGX_LOOK_POWER, AGX_LOOK_SATURATION, AGX_MAX_EV, AGX_MIN_EV } from '../physics/tonemap';
import { PHASE_ANGLES } from '../physics/marsDust';
import type { Vec3 } from '../physics/sky';
import type { CameraBasis } from './camera';
import {
  type GpuAtmosphere,
  GPU_WAVELENGTHS,
  irradianceTexels,
  terrainUniforms,
  toHalfArray,
  xyzToSrgbGlsl,
} from './gpuData';
import blitSource from './shaders/blit.frag.glsl?raw';
import skySource from './shaders/sky.frag.glsl?raw';
import vertexSource from './shaders/fullscreen.vert.glsl?raw';

export interface GpuFrame {
  basis: CameraBasis;
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  /** Render resolution as a fraction of the canvas (dynamic resolution). */
  scale: number;
  steps: number;
  sunDir: Vec3;
  /** Observer altitude, km. */
  altitude: number;
  exposure: number;
  toneMap: ToneMap;
  hillWeight: number;
}

export type RendererStatus = 'compiling' | 'ready' | 'lost' | 'failed';

interface Programs {
  sky: WebGLProgram;
  blit: WebGLProgram;
}

/** Returns a WebGL2 context or null (no WebGL2, or the float/half-float textures we need are missing). */
export function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  return gl;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

export class WebGLSkyRenderer {
  readonly gl: WebGL2RenderingContext;
  private programs: Programs | null = null;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private blitImage: WebGLUniformLocation | null = null;
  private lutTex: WebGLTexture | null = null;
  private irrTex: WebGLTexture | null = null;
  private dustTex: WebGLTexture | null = null;
  private target: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private targetSize = [0, 0];
  private atmosphere: GpuAtmosphere | null = null;
  private atmosphereDirty = true;
  status: RendererStatus = 'compiling';
  /** Size of the last rendered image in pixels. */
  lastRenderSize: [number, number] = [0, 0];

  constructor(
    readonly canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    private readonly onStatus: (status: RendererStatus, detail?: string) => void,
  ) {
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.handleLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleRestored, false);
  }

  private setStatus(status: RendererStatus, detail?: string) {
    this.status = status;
    this.onStatus(status, detail);
  }

  /** Compiles and links the programs; uses KHR_parallel_shader_compile to stay responsive. */
  async init(): Promise<void> {
    const gl = this.gl;
    this.setStatus('compiling');
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    const defines = [
      `#define LUT_W ${(256).toFixed(1)}`,
      `#define LUT_H ${(128).toFixed(1)}`,
      `#define IRR_N ${this.atmosphere ? this.atmosphere.irradiance.muS.length.toFixed(1) : '24.0'}`,
      `#define PHASE_N ${PHASE_ANGLES.toFixed(1)}`,
      `#define AGX_MIN_EV ${AGX_MIN_EV.toFixed(6)}`,
      `#define AGX_MAX_EV ${AGX_MAX_EV.toFixed(6)}`,
      `#define AGX_LOOK_POWER ${AGX_LOOK_POWER.toFixed(4)}`,
      `#define AGX_LOOK_SATURATION ${AGX_LOOK_SATURATION.toFixed(4)}`,
      `#define XYZ_TO_SRGB_COLS ${xyzToSrgbGlsl()}`,
    ].join('\n');
    const skyFrag = skySource.replace('#define PI ', `${defines}\n#define PI `);
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fsSky = compileShader(gl, gl.FRAGMENT_SHADER, skyFrag);
    const fsBlit = compileShader(gl, gl.FRAGMENT_SHADER, blitSource);
    const link = (fs: WebGLShader) => {
      const p = gl.createProgram();
      if (!p) throw new Error('could not create program');
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      return p;
    };
    const sky = link(fsSky);
    const blit = link(fsBlit);
    if (parallel) {
      const done = (p: WebGLProgram) =>
        gl.getProgramParameter(p, parallel.COMPLETION_STATUS_KHR) as boolean;
      while (!(done(sky) && done(blit))) {
        await new Promise((r) => setTimeout(r, 16));
        if (gl.isContextLost()) return;
      }
    }
    for (const [p, fs, name] of [
      [sky, fsSky, 'sky'],
      [blit, fsBlit, 'blit'],
    ] as const) {
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(p) || 'unknown error';
        this.setStatus('failed', `${name} shader: ${log}`);
        throw new Error(`${name} shader failed: ${log}`);
      }
    }
    gl.deleteShader(vs);
    gl.deleteShader(fsSky);
    gl.deleteShader(fsBlit);
    this.programs = { sky, blit };
    this.uniforms.clear();
    this.blitImage = gl.getUniformLocation(blit, 'uImage');
    this.vao = gl.createVertexArray();
    this.atmosphereDirty = true;
    this.setStatus('ready');
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.programs) return null;
    if (!this.uniforms.has(name))
      this.uniforms.set(name, this.gl.getUniformLocation(this.programs.sky, name));
    return this.uniforms.get(name) ?? null;
  }

  setAtmosphere(atm: GpuAtmosphere): void {
    this.atmosphere = atm;
    this.atmosphereDirty = true;
  }

  private createTexture(
    width: number,
    height: number,
    internal: number,
    format: number,
    data: Uint16Array,
  ): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('could not create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, gl.HALF_FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private uploadAtmosphere(): void {
    const gl = this.gl;
    const atm = this.atmosphere;
    if (!atm || !this.programs) return;
    for (const t of [this.lutTex, this.irrTex, this.dustTex]) if (t) gl.deleteTexture(t);
    this.lutTex = this.createTexture(
      atm.lut.width,
      atm.lut.height,
      gl.RGBA16F,
      gl.RGBA,
      toHalfArray(atm.lut.data),
    );
    const rows = atm.irradiance.muS.length;
    this.irrTex = this.createTexture(
      rows,
      4,
      gl.RGBA16F,
      gl.RGBA,
      toHalfArray(irradianceTexels(atm.irradiance)),
    );
    this.dustTex = atm.dustPhase
      ? this.createTexture(
          PHASE_ANGLES,
          GPU_WAVELENGTHS,
          gl.R16F,
          gl.RED,
          toHalfArray(atm.dustPhase),
        )
      : this.createTexture(1, 1, gl.R16F, gl.RED, new Uint16Array(1));

    gl.useProgram(this.programs.sky);
    for (const [name, v] of Object.entries(atm.vectors)) gl.uniform4fv(this.u(name), v);
    for (const [name, v] of Object.entries(atm.scalars)) {
      const loc = this.u(name);
      if (name === 'uDust') gl.uniform1i(loc, v as number);
      else if (Array.isArray(v)) {
        if (v.length === 3) gl.uniform3fv(loc, v);
        else gl.uniform4fv(loc, v);
      } else gl.uniform1f(loc, v);
    }
    const t = terrainUniforms();
    gl.uniform4fv(this.u('uRidge'), t.uRidge);
    gl.uniform3fv(this.u('uBump'), t.uBump);
    gl.uniform3fv(this.u('uTerm'), t.uTerm);
    gl.uniform1f(this.u('uFloorDepth'), t.uFloorDepth);
    gl.uniform1f(this.u('uFloorElevation'), t.uFloorElevation);
    gl.uniform1f(this.u('uRimAngle'), t.uRimAngle);
    gl.uniform1i(this.u('uLut'), 0);
    gl.uniform1i(this.u('uIrradiance'), 1);
    gl.uniform1i(this.u('uDustPhase'), 2);
    this.atmosphereDirty = false;
  }

  private ensureTarget(w: number, h: number) {
    const gl = this.gl;
    if (this.target && this.targetSize[0] === w && this.targetSize[1] === h) return;
    if (this.target) gl.deleteTexture(this.target);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
    this.targetSize = [w, h];
  }

  /** Renders a frame. Returns false when the renderer cannot draw (not ready or context lost). */
  render(frame: GpuFrame): boolean {
    const gl = this.gl;
    if (this.status !== 'ready' || !this.programs || gl.isContextLost() || !this.atmosphere)
      return false;
    if (this.atmosphereDirty) this.uploadAtmosphere();
    const w = Math.max(1, Math.round(frame.width * frame.scale));
    const h = Math.max(1, Math.round(frame.height * frame.scale));
    this.ensureTarget(w, h);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.programs.sky);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.irrTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.dustTex);
    const b = frame.basis;
    gl.uniform3fv(this.u('uCamF'), b.forward);
    gl.uniform3fv(this.u('uCamR'), b.right);
    gl.uniform3fv(this.u('uCamU'), b.up);
    gl.uniform2f(this.u('uTan'), b.tanX, b.tanY);
    gl.uniform2f(this.u('uResolution'), w, h);
    gl.uniform1f(this.u('uPixelAngle'), (2 * b.tanY) / h);
    gl.uniform1i(this.u('uSteps'), Math.max(4, Math.min(128, Math.round(frame.steps))));
    gl.uniform3fv(this.u('uSunDir'), frame.sunDir);
    gl.uniform1f(this.u('uAltitude'), frame.altitude);
    gl.uniform1f(this.u('uExposure'), frame.exposure);
    gl.uniform1i(this.u('uToneMap'), frame.toneMap === 'neutral' ? 1 : 0);
    gl.uniform1f(this.u('uHillWeight'), frame.hillWeight);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, frame.width, frame.height);
    gl.useProgram(this.programs.blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.uniform1i(this.blitImage, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.lastRenderSize = [w, h];
    return true;
  }

  /** Reads an RGB pixel of the last rendered image at a position in [0, 1]² (y down). */
  readPixel(u: number, v: number): [number, number, number] | null {
    const gl = this.gl;
    if (!this.fbo || gl.isContextLost()) return null;
    const [w, h] = this.lastRenderSize;
    const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor((1 - v) * h)));
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [px[0], px[1], px[2]];
  }

  private handleLost = (e: Event) => {
    e.preventDefault();
    this.programs = null;
    this.target = null;
    this.fbo = null;
    this.lutTex = this.irrTex = this.dustTex = null;
    this.targetSize = [0, 0];
    this.setStatus('lost');
  };

  private handleRestored = () => {
    this.init().catch((err: unknown) => this.setStatus('failed', String(err)));
  };

  /** Simulates a context loss and restore (for testing the recovery path). */
  simulateContextLoss(restoreAfterMs = 400): boolean {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), restoreAfterMs);
    return true;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestored);
  }
}
