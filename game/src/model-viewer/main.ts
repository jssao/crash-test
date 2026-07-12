// SPDX-License-Identifier: MIT
//
// Model Viewer page entry (model-viewer.html). A game-asset inspector for every model the crash sandbox
// builds — the GLB car, destructible props, trees, buildings, ragdoll occupants, and each engine-bay
// part. Each model is isolated on a neutral-lit pedestal with an orbit/zoom camera, render modes
// (shaded / wireframe / normals), poly-count stats, a 1 m scale grid, a bounding box, camera preset
// views, and a filterable list. Reuses the game's own renderer/environment/sun building blocks
// (render/*) and its real model builders (via ./catalog.ts), so what you see here is byte-for-byte the
// geometry the game ships. Independent third page alongside index.html and crash-lab.html.

import * as THREE from 'three';
import { init, World } from '../../../src/ts/index.js';
import { createRenderer } from '../render/createRenderer';
import { loadEnvironment } from '../render/environment';
import { createSun } from '../render/sun';
import { buildGround } from '../scene/ground';
import { QUALITY_PRESETS, detectDefaultQuality } from '../render/quality';
import { createOrbitController, type CameraPreset } from './orbit';
import { createViewerUI } from './ui';
import { createViewerControls, type ToggleKey } from './controls';
import { createRenderModes, type RenderMode } from './rendermodes';
import { buildCatalog } from './catalog';
import type { ModelEntry } from './types';

// Neutral studio-gray HDRI (also used by the crash lab) — even, low-contrast light that shows a
// model's own form/materials honestly, which is what a viewer wants (the game itself uses the warmer
// derelict-airfield sky).
const HDRI_URL = 'assets/hdri/je_gray_02_2k.hdr';
const DARK_BG = new THREE.Color(0x0f1216);

function setLoading(frac: number, text: string): void {
  const fill = document.getElementById('hud-loading-fill');
  const status = document.getElementById('hud-loading-status');
  if (fill) fill.style.width = `${Math.round(frac * 100)}%`;
  if (status) status.textContent = text;
}
function hideLoading(): void {
  document.getElementById('hud-loading')?.classList.add('hud-loading-hidden');
}

async function main(): Promise<void> {
  const appEl = document.getElementById('app')!;
  const uiEl = document.getElementById('ui')!;

  const quality = QUALITY_PRESETS[detectDefaultQuality()];

  const canvas = document.createElement('canvas');
  appEl.appendChild(canvas);
  const { renderer } = createRenderer(canvas, quality);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 500);

  setLoading(0.1, 'loading environment…');
  const scene = new THREE.Scene();
  await loadEnvironment(renderer, scene, HDRI_URL, quality);
  const envBg = scene.background; // the HDRI sky, toggled on/off by the Environment control

  const ground = buildGround(120, 24);
  scene.add(ground.mesh);
  const sunTarget = new THREE.Object3D();
  scene.add(sunTarget);
  const sun = createSun(quality, sunTarget);
  scene.add(sun.light);
  scene.add(sun.light.target);

  // Turntable: selected model is parented here at the origin; the camera (not the model) auto-spins.
  const turntable = new THREE.Group();
  turntable.name = 'Turntable';
  scene.add(turntable);

  setLoading(0.25, 'starting physics engine…');
  const native = await init();
  const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });

  setLoading(0.4, 'building models…');
  const { entries } = await buildCatalog(world);

  // ---- Viewer state + helpers -----------------------------------------------------------------
  const orbit = createOrbitController(appEl);
  const renderModes = createRenderModes();
  const ui = createViewerUI(uiEl);
  ui.setEntries(entries);

  const state = { grid: false, bbox: false, ground: true, env: true, autorotate: true };

  let currentHolder: THREE.Group | null = null;
  let selectedIndex = -1;
  const _box = new THREE.Box3();
  const _center = new THREE.Vector3();
  const _size = new THREE.Vector3();
  const currentSize = new THREE.Vector3(1, 1, 1);

  let gridHelper: THREE.GridHelper | null = null;
  let bboxHelper: THREE.Box3Helper | null = null;

  function refreshGrid(): void {
    if (gridHelper) {
      scene.remove(gridHelper);
      gridHelper.geometry.dispose();
      (gridHelper.material as THREE.Material).dispose();
      gridHelper = null;
    }
    if (!state.grid) return;
    // 1 m cells, extent scaled to the model's footprint (so a fuse box and a large tree both read).
    const size = THREE.MathUtils.clamp(Math.ceil(Math.max(currentSize.x, currentSize.z, 1)) * 2, 4, 40);
    gridHelper = new THREE.GridHelper(size, size, 0x4fa8ff, 0x38424f);
    const mat = gridHelper.material as THREE.Material;
    mat.transparent = true;
    mat.opacity = 0.55;
    gridHelper.position.y = 0.002; // above the ground plane, no z-fight
    scene.add(gridHelper);
  }

  function refreshBbox(): void {
    if (bboxHelper) {
      scene.remove(bboxHelper);
      bboxHelper.geometry.dispose();
      (bboxHelper.material as THREE.Material).dispose();
      bboxHelper = null;
    }
    if (!state.bbox || !currentHolder) return;
    _box.setFromObject(currentHolder);
    bboxHelper = new THREE.Box3Helper(_box.clone(), new THREE.Color(0x4fa8ff));
    scene.add(bboxHelper);
  }

  function showModel(index: number): void {
    if (index < 0 || index >= entries.length) return;
    selectedIndex = index;
    const e: ModelEntry = entries[index];

    if (currentHolder) {
      turntable.remove(currentHolder);
      currentHolder = null;
    }
    const holder = new THREE.Group();
    holder.add(e.object);
    turntable.add(holder);
    currentHolder = holder;

    // Recenter over the pedestal and rest the base on y=0 (robust to whatever baked offset the source
    // object carries, idempotent on reselect since the bounds are already centered the second time).
    e.object.updateMatrixWorld(true);
    _box.setFromObject(e.object);
    if (!_box.isEmpty()) {
      _box.getCenter(_center);
      _box.getSize(_size);
      e.object.position.x -= _center.x;
      e.object.position.z -= _center.z;
      e.object.position.y -= _box.min.y;
    }
    currentSize.copy(_size);

    renderModes.setTarget(e.object);
    orbit.frame(new THREE.Vector3(0, _size.y * 0.5, 0), Math.max(_size.length() * 0.9, 1.2));
    refreshGrid();
    refreshBbox();
    ui.select(index);
  }

  // ---- Control wiring --------------------------------------------------------------------------
  function applyRenderMode(mode: RenderMode): void {
    renderModes.setMode(mode);
    controls.setRenderMode(mode);
  }

  function setToggle(key: ToggleKey, value: boolean): void {
    switch (key) {
      case 'autorotate':
        state.autorotate = value;
        orbit.setSpinEnabled(value);
        break;
      case 'grid':
        state.grid = value;
        refreshGrid();
        break;
      case 'bbox':
        state.bbox = value;
        refreshBbox();
        break;
      case 'ground':
        state.ground = value;
        ground.mesh.visible = value;
        break;
      case 'env':
        state.env = value;
        scene.background = value ? envBg : DARK_BG;
        break;
    }
    controls.setToggle(key, value);
  }

  const controls = createViewerControls(uiEl, {
    onRenderMode: applyRenderMode,
    onToggle: setToggle,
    onPreset: (p) => orbit.setPreset(p),
    onReset: () => orbit.reset(),
    onSpinRate: (r) => orbit.setSpinRate(r),
  });

  ui.onSelect(showModel);

  // ---- Keyboard shortcuts ----------------------------------------------------------------------
  const presetKeys: Record<string, CameraPreset> = { '1': 'front', '2': 'back', '3': 'top', '4': 'left', '5': 'right', '6': 'iso' };
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return; // don't hijack the filter box / slider
    const k = e.key.toLowerCase();
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      showModel((selectedIndex + 1) % entries.length);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      showModel((selectedIndex - 1 + entries.length) % entries.length);
    } else if (k === 'w') {
      applyRenderMode(renderModes.mode === 'wireframe' ? 'shaded' : 'wireframe');
    } else if (k === 'n') {
      applyRenderMode(renderModes.mode === 'normals' ? 'shaded' : 'normals');
    } else if (k === 'g') {
      setToggle('grid', !state.grid);
    } else if (k === 'b') {
      setToggle('bbox', !state.bbox);
    } else if (k === ' ') {
      e.preventDefault();
      setToggle('autorotate', !state.autorotate);
    } else if (k === 'r') {
      orbit.reset();
    } else if (presetKeys[e.key]) {
      orbit.setPreset(presetKeys[e.key]);
    }
  });

  // Automation/debug hook (mirrors the game's window.__GAME__): lets a scripted screenshot pass drive
  // the viewer without synthesizing clicks.
  (window as unknown as { __VIEWER__: unknown }).__VIEWER__ = {
    count: entries.length,
    labels: entries.map((e) => e.label),
    select: showModel,
    setRenderMode: applyRenderMode,
    toggle: setToggle,
    preset: (p: CameraPreset) => orbit.setPreset(p),
    reset: () => orbit.reset(),
  };

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  let last = performance.now();
  renderer.setAnimationLoop((t) => {
    const dt = Math.min((t - last) / 1000, 0.1);
    last = t;
    orbit.update(camera, dt);
    renderer.render(scene, camera);
  });

  if (entries.length > 0) showModel(0);
  setLoading(1, 'ready');
  hideLoading();
}

main().catch((err) => {
  console.error('[model-viewer] fatal init error:', err);
  setLoading(1, `FATAL: ${(err as Error).message}`);
});
