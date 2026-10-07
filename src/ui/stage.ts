/**
 * Direct manipulation on the sky: drag the sun, drag the sky to look around, tap to probe,
 * pinch or wheel to zoom, and the keyboard equivalents.
 */
import type { FrameInfo, SkyView } from '../app/skyView';
import { SUN_ELEVATION_MAX, SUN_ELEVATION_MIN, type Store } from '../app/state';
import { anglesFromDir, dirFromAngles, type Vec3 } from '../physics/sky';
import type { Layout } from './layout';
import { describeSun } from './scrubber';

export interface StageCallbacks {
  onProbe: (dir: Vec3) => void;
  onFirstUse: () => void;
  onToggleProbe: () => void;
  onEscape: () => void;
  onStoryStep: (index: number) => void;
}

export interface StageControls {
  update(info?: FrameInfo): void;
  setProbeDirection(dir: Vec3 | null): void;
  hideHint(): void;
}

const TAP_SLOP = 6;

export function mountStage(
  layout: Layout,
  store: Store,
  view: SkyView,
  cb: StageCallbacks,
): StageControls {
  const { stage, sunHandle, hint, sunOffscreen, probeMarker } = layout;
  let probeDir: Vec3 | null = null;
  let hintGone = false;

  const hideHint = () => {
    if (hintGone) return;
    hintGone = true;
    hint.classList.add('is-gone');
    sunHandle.querySelector('.sun-pulse')?.remove();
    cb.onFirstUse();
  };

  const degPerPixel = () => {
    const b = view.currentBasis();
    return ((2 * Math.atan(b.tanY)) / view.size[1]) * (180 / Math.PI);
  };

  /** Region of the stage not covered by the brand card, dock or scrubber. */
  const safeArea = (w: number, h: number) => {
    const stageRect = stage.getBoundingClientRect();
    let top = 16;
    let bottom = h - 16;
    for (const el of [layout.root.querySelector('.brand'), layout.dock]) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.top - stageRect.top < h / 2) top = Math.max(top, r.bottom - stageRect.top + 12);
      else bottom = Math.min(bottom, r.top - stageRect.top - 12);
    }
    const sc = layout.scrubber.getBoundingClientRect();
    if (sc.height > 0) bottom = Math.min(bottom, sc.top - stageRect.top - 12);
    return { left: 16, right: w - 96, top, bottom: Math.max(top + 60, bottom - 44) };
  };

  // --- placement ----------------------------------------------------------------------------
  const update = () => {
    const s = store.get();
    const [w, h] = view.size;
    const sun = dirFromAngles(s.sunElevation, s.sunAzimuth);
    const p = view.screenOf(sun);
    const margin = 6;
    const onScreen =
      p !== null && p.x > margin && p.x < w - margin && p.y > margin && p.y < h - margin;
    sunHandle.classList.toggle('is-hidden', !onScreen);
    sunHandle.setAttribute(
      'aria-label',
      `Sun: ${describeSun(s.sunElevation)}, azimuth ${Math.round(s.sunAzimuth)}°`,
    );
    if (onScreen && p) {
      sunHandle.style.transform = `translate(${p.x}px, ${p.y}px)`;
      const right = p.x < w - 190;
      hint.style.transform = right
        ? `translate(${p.x + 32}px, ${p.y - 17}px)`
        : `translate(${p.x - 32}px, ${p.y - 17}px) translateX(-100%)`;
    }
    hint.hidden = !onScreen || hintGone;
    // Off-screen sun: a button on the nearest edge, pointing toward it.
    if (!onScreen) {
      const b = view.currentBasis();
      const fx = sun[0] * b.right[0] + sun[1] * b.right[1] + sun[2] * b.right[2];
      const fy = sun[0] * b.up[0] + sun[1] * b.up[1] + sun[2] * b.up[2];
      const angle = Math.atan2(-fy, fx); // screen angle (y down)
      // Keep the button inside a rectangle clear of the header, dock and scrubber.
      const safe = safeArea(w, h);
      const cx = (safe.left + safe.right) / 2;
      const cy = (safe.top + safe.bottom) / 2;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const tx = dx !== 0 ? (safe.right - safe.left) / 2 / Math.abs(dx) : Infinity;
      const ty = dy !== 0 ? (safe.bottom - safe.top) / 2 / Math.abs(dy) : Infinity;
      const t = Math.min(tx, ty);
      sunOffscreen.hidden = false;
      sunOffscreen.style.left = `${cx + dx * t - 40}px`;
      sunOffscreen.style.top = `${cy + dy * t - 22}px`;
      const arrow = sunOffscreen.querySelector('svg');
      if (arrow) arrow.style.transform = `rotate(${(angle * 180) / Math.PI + 90}deg)`;
      sunOffscreen.setAttribute('aria-label', `Look at the sun (${describeSun(s.sunElevation)})`);
    } else sunOffscreen.hidden = true;
    // Probe marker
    if (probeDir) {
      const q = view.screenOf(probeDir);
      const visible = q !== null && q.x >= 0 && q.x <= w && q.y >= 0 && q.y <= h;
      probeMarker.hidden = !visible;
      if (visible && q) probeMarker.style.transform = `translate(${q.x}px, ${q.y}px)`;
    } else probeMarker.hidden = true;
  };

  sunOffscreen.addEventListener('click', () => {
    const s = store.get();
    store.set({ yaw: s.sunAzimuth, pitch: Math.max(-30, Math.min(70, s.sunElevation - 10)) });
  });

  // --- sun drag -------------------------------------------------------------------------------
  let sunDrag: { id: number; dx: number; dy: number } | null = null;
  sunHandle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const s = store.get();
    const p = view.screenOf(dirFromAngles(s.sunElevation, s.sunAzimuth));
    const r = stage.getBoundingClientRect();
    sunDrag = {
      id: e.pointerId,
      dx: e.clientX - r.left - (p?.x ?? 0),
      dy: e.clientY - r.top - (p?.y ?? 0),
    };
    sunHandle.setPointerCapture(e.pointerId);
    sunHandle.classList.add('is-active');
    store.cancelTween();
    hideHint();
  });
  sunHandle.addEventListener('pointermove', (e) => {
    if (!sunDrag || e.pointerId !== sunDrag.id) return;
    const r = stage.getBoundingClientRect();
    const dir = view.directionAt(e.clientX - r.left - sunDrag.dx, e.clientY - r.top - sunDrag.dy);
    const a = anglesFromDir(dir);
    store.set({
      sunElevation: Math.min(SUN_ELEVATION_MAX, Math.max(SUN_ELEVATION_MIN, a.elevation)),
      sunAzimuth: a.azimuth,
    });
  });
  const endSunDrag = (e: PointerEvent) => {
    if (!sunDrag || e.pointerId !== sunDrag.id) return;
    sunDrag = null;
    sunHandle.classList.remove('is-active');
  };
  sunHandle.addEventListener('pointerup', endSunDrag);
  sunHandle.addEventListener('pointercancel', endSunDrag);

  // --- look, tap, pinch -------------------------------------------------------------------------
  const pointers = new Map<number, { x: number; y: number }>();
  let look: {
    id: number;
    x0: number;
    y0: number;
    yaw0: number;
    pitch0: number;
    moved: boolean;
    t0: number;
  } | null = null;
  let pinch: { d0: number; fov0: number } | null = null;

  const local = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  stage.addEventListener('pointerdown', (e) => {
    if (e.target !== stage && !(e.target as Element).classList?.contains('sky')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    stage.setPointerCapture(e.pointerId);
    store.cancelTween();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), fov0: store.get().fov };
      look = null;
      return;
    }
    const s = store.get();
    look = {
      id: e.pointerId,
      x0: p.x,
      y0: p.y,
      yaw0: s.yaw,
      pitch0: s.pitch,
      moved: false,
      t0: performance.now(),
    };
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 10) store.set({ fov: pinch.fov0 * (pinch.d0 / d) });
      return;
    }
    if (!look || e.pointerId !== look.id) return;
    const dx = p.x - look.x0;
    const dy = p.y - look.y0;
    if (!look.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    look.moved = true;
    stage.classList.add('is-dragging');
    const k = degPerPixel();
    store.set({ yaw: look.yaw0 - dx * k, pitch: look.pitch0 + dy * k });
  });

  const endPointer = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (look && e.pointerId === look.id) {
      const tap = !look.moved && performance.now() - look.t0 < 600 && e.type === 'pointerup';
      if (tap) {
        const p = local(e);
        cb.onProbe(view.directionAt(p.x, p.y));
      }
      look = null;
    }
    if (pointers.size === 0) stage.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      store.set({ fov: store.get().fov * Math.exp(e.deltaY * 0.0012) });
    },
    { passive: false },
  );

  // --- keyboard ---------------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    const typing =
      tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t?.isContentEditable;
    if (e.key === 'Escape') {
      cb.onEscape();
      return;
    }
    if (typing || layout.how.open) return;
    const s = store.get();
    const big = e.shiftKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
        store.set({ sunElevation: s.sunElevation + (big ? 5 : 0.5) });
        hideHint();
        break;
      case 'ArrowDown':
        store.set({ sunElevation: s.sunElevation - (big ? 5 : 0.5) });
        hideHint();
        break;
      case 'ArrowLeft':
        store.set({ sunAzimuth: s.sunAzimuth - (big ? 10 : 1) });
        hideHint();
        break;
      case 'ArrowRight':
        store.set({ sunAzimuth: s.sunAzimuth + (big ? 10 : 1) });
        hideHint();
        break;
      case 'w':
      case 'W':
        store.set({ pitch: s.pitch + (big ? 10 : 2) });
        break;
      case 's':
      case 'S':
        store.set({ pitch: s.pitch - (big ? 10 : 2) });
        break;
      case 'a':
      case 'A':
        store.set({ yaw: s.yaw - (big ? 15 : 3) });
        break;
      case 'd':
      case 'D':
        store.set({ yaw: s.yaw + (big ? 15 : 3) });
        break;
      case '+':
      case '=':
        store.set({ fov: s.fov / 1.15 });
        break;
      case '-':
      case '_':
        store.set({ fov: s.fov * 1.15 });
        break;
      case 'p':
      case 'P':
        cb.onToggleProbe();
        break;
      default:
        if (/^[1-6]$/.test(e.key)) cb.onStoryStep(Number(e.key) - 1);
        else handled = false;
    }
    if (handled) e.preventDefault();
  });

  return {
    update,
    setProbeDirection(dir) {
      probeDir = dir;
      update();
    },
    hideHint,
  };
}
