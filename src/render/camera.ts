/**
 * Pinhole camera at the observer. World axes: x = east, y = up, z = north; azimuth is measured
 * clockwise from north. The field of view applies to the larger screen dimension, so phones in
 * portrait see a tall sky and desktops a wide one.
 */
import { DEG } from '../physics/constants';
import { dirFromAngles, type Vec3 } from '../physics/sky';

export interface CameraState {
  /** Azimuth of the view centre, degrees. */
  yaw: number;
  /** Elevation of the view centre, degrees. */
  pitch: number;
  /** Field of view across the larger screen dimension, degrees. */
  fov: number;
}

export interface CameraBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** tan(half field of view) horizontally and vertically. */
  tanX: number;
  tanY: number;
}

export const PITCH_LIMIT = 89.5;

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function cameraBasis(cam: CameraState, width: number, height: number): CameraBasis {
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, cam.pitch));
  const forward = dirFromAngles(pitch, cam.yaw);
  const right = normalize(cross([0, 1, 0], forward));
  const up = cross(forward, right);
  const t = Math.tan((Math.max(0.5, Math.min(150, cam.fov)) * DEG) / 2);
  const aspect = width / height;
  const tanX = aspect >= 1 ? t : t * aspect;
  const tanY = aspect >= 1 ? t / aspect : t;
  return { forward, right, up, tanX, tanY };
}

/** Unit view direction through normalised device coordinates (x, y) ∈ [−1, 1]². */
export function rayThrough(b: CameraBasis, x: number, y: number): Vec3 {
  return normalize([
    b.forward[0] + x * b.tanX * b.right[0] + y * b.tanY * b.up[0],
    b.forward[1] + x * b.tanX * b.right[1] + y * b.tanY * b.up[1],
    b.forward[2] + x * b.tanX * b.right[2] + y * b.tanY * b.up[2],
  ]);
}

/** Direction through the centre of pixel (px, py) of a width × height image (y down). */
export function pixelRay(
  b: CameraBasis,
  px: number,
  py: number,
  width: number,
  height: number,
): Vec3 {
  return rayThrough(b, (2 * (px + 0.5)) / width - 1, 1 - (2 * (py + 0.5)) / height);
}

/** Screen position (CSS pixels, y down) of a world direction, or null when behind the camera. */
export function project(
  b: CameraBasis,
  d: Vec3,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const cz = d[0] * b.forward[0] + d[1] * b.forward[1] + d[2] * b.forward[2];
  if (cz <= 1e-6) return null;
  const cx = d[0] * b.right[0] + d[1] * b.right[1] + d[2] * b.right[2];
  const cy = d[0] * b.up[0] + d[1] * b.up[1] + d[2] * b.up[2];
  const x = cx / (cz * b.tanX);
  const y = cy / (cz * b.tanY);
  return { x: ((x + 1) / 2) * width, y: ((1 - y) / 2) * height };
}

/** Angular size of one pixel at the image centre, radians. */
export function pixelAngle(b: CameraBasis, height: number): number {
  return (2 * b.tanY) / height;
}

/** Pitch that puts the horizon at `fraction` of the screen height from the bottom. */
export function pitchForHorizon(
  fov: number,
  width: number,
  height: number,
  fraction = 0.3,
): number {
  const b = cameraBasis({ yaw: 0, pitch: 0, fov }, width, height);
  const y = 2 * fraction - 1; // NDC of the horizon (negative = below centre)
  return -Math.atan(y * b.tanY) / DEG;
}
