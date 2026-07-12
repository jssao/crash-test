// SPDX-License-Identifier: MIT
//
// A compact turntable orbit camera for the Model Viewer page (src/model-viewer/main.ts). Deliberately
// NOT the game's scene/cameraOrbit.ts UserOrbitController — that one is car-focused and does world
// sphere-cast occlusion pullback against a live physics world, neither of which a static isolated-model
// turntable wants. This is a self-contained spherical orbit: left-drag orbits (azimuth/polar), wheel
// zooms (radius), and it slowly auto-spins the azimuth after a short idle so a freshly-selected model
// shows itself off from every angle. It also exposes snap-to preset views (front/side/top/iso) and a
// reset, which the controls panel + keyboard shortcuts drive.

import * as THREE from 'three';

export type CameraPreset = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top';

export interface OrbitController {
  /** Recompute + apply the camera transform for this frame. */
  update(camera: THREE.PerspectiveCamera, dt: number): void;
  /** Re-frame on a new target point + distance (called when a model is selected). Keeps the current
   * azimuth/polar so the viewpoint feels continuous between models, and remembers the distance so
   * reset() can restore it after zooming. */
  frame(target: THREE.Vector3, radius: number): void;
  /** Snap azimuth/polar to a named view (keeps the current zoom distance). */
  setPreset(preset: CameraPreset): void;
  /** Snap back to the default 3/4 view AND the model's framed distance. */
  reset(): void;
  /** Enable/disable the idle auto-spin. */
  setSpinEnabled(on: boolean): void;
  /** Auto-spin speed in radians/sec. */
  setSpinRate(rate: number): void;
  dispose(): void;
}

const MIN_POLAR = 0.12; // just shy of straight-down (avoid gimbal flip)
const MAX_POLAR = Math.PI - 0.12; // just shy of straight-up
const IDLE_BEFORE_SPIN_S = 1.5; // seconds of no input before auto-spin resumes
const DEFAULT_AZIMUTH = Math.PI * 0.25; // 3/4 front view
const DEFAULT_POLAR = Math.PI * 0.42; // slightly above the horizon

const PRESETS: Record<CameraPreset, { az: number; polar: number }> = {
  iso: { az: DEFAULT_AZIMUTH, polar: DEFAULT_POLAR },
  front: { az: 0, polar: Math.PI * 0.5 },
  back: { az: Math.PI, polar: Math.PI * 0.5 },
  right: { az: Math.PI * 0.5, polar: Math.PI * 0.5 },
  left: { az: -Math.PI * 0.5, polar: Math.PI * 0.5 },
  top: { az: DEFAULT_AZIMUTH, polar: 0.16 },
};

export function createOrbitController(dom: HTMLElement): OrbitController {
  const target = new THREE.Vector3(0, 0.6, 0);
  let azimuth = DEFAULT_AZIMUTH;
  let polar = DEFAULT_POLAR;
  let radius = 6;
  let framedRadius = 6; // last frame() distance — what reset() restores zoom to
  let minRadius = 1;
  let maxRadius = 40;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let idleTimer = 0; // seconds since last user input
  let selected = false; // a model is shown (gates auto-spin)
  let spinEnabled = true;
  let spinRate = 0.28;

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    idleTimer = 0;
    dom.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    azimuth -= dx * 0.006;
    polar = THREE.MathUtils.clamp(polar - dy * 0.006, MIN_POLAR, MAX_POLAR);
    idleTimer = 0;
  }
  function onPointerUp(e: PointerEvent): void {
    dragging = false;
    idleTimer = 0;
    dom.releasePointerCapture?.(e.pointerId);
  }
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    radius = THREE.MathUtils.clamp(radius * Math.exp(e.deltaY * 0.0012), minRadius, maxRadius);
    idleTimer = 0;
  }

  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);
  dom.addEventListener('wheel', onWheel, { passive: false });

  return {
    frame(newTarget, newRadius) {
      target.copy(newTarget);
      radius = newRadius;
      framedRadius = newRadius;
      minRadius = Math.max(0.3, newRadius * 0.35);
      maxRadius = newRadius * 6;
      polar = DEFAULT_POLAR;
      idleTimer = 0;
      selected = true;
    },
    setPreset(preset) {
      const p = PRESETS[preset];
      azimuth = p.az;
      polar = p.polar;
      idleTimer = 0;
    },
    reset() {
      azimuth = DEFAULT_AZIMUTH;
      polar = DEFAULT_POLAR;
      radius = framedRadius;
      idleTimer = 0;
    },
    setSpinEnabled(on) {
      spinEnabled = on;
      idleTimer = 0;
    },
    setSpinRate(rate) {
      spinRate = rate;
    },
    update(camera, dt) {
      idleTimer += dt;
      if (selected && spinEnabled && !dragging && idleTimer > IDLE_BEFORE_SPIN_S) {
        azimuth += spinRate * dt;
      }
      const sinP = Math.sin(polar);
      camera.position.set(
        target.x + radius * sinP * Math.sin(azimuth),
        target.y + radius * Math.cos(polar),
        target.z + radius * sinP * Math.cos(azimuth),
      );
      camera.lookAt(target);
    },
    dispose() {
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerUp);
      dom.removeEventListener('wheel', onWheel);
    },
  };
}
