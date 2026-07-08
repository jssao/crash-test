import * as THREE from 'three';
import { createRenderer } from './render/createRenderer';
import { QUALITY_PRESETS, detectDefaultQuality, type QualityLevel } from './render/quality';
import { buildScene } from './scene/buildScene';
import { createOrbitUpdater } from './scene/cameraOrbit';

declare global {
  interface Window {
    __GAME__?: {
      ready: boolean;
      quality: QualityLevel;
      setFixedAngle: (radians: number | null) => void;
      renderer: THREE.WebGLRenderer;
    };
  }
}

async function main() {
  const appEl = document.getElementById('app')!;
  const hudEl = document.getElementById('hud')!;
  const canvas = document.createElement('canvas');
  appEl.appendChild(canvas);

  const qualityLevel: QualityLevel = (new URLSearchParams(location.search).get('quality') as QualityLevel) || detectDefaultQuality();
  const quality = QUALITY_PRESETS[qualityLevel];

  const { renderer } = createRenderer(canvas, quality);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);

  let fixedAngle: number | null = null;
  window.__GAME__ = {
    ready: false,
    quality: qualityLevel,
    setFixedAngle: (radians) => { fixedAngle = radians; },
    renderer,
  };

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  const { scene, car, carFocus } = await buildScene(renderer, quality);
  void car;

  resize();

  const updateOrbit = createOrbitUpdater(camera, {
    radius: 7.2,
    height: 2.2,
    angularSpeed: 0.12,
    targetHeight: 0.55,
  });

  const timer = new THREE.Timer();
  timer.connect(document);
  let frameCount = 0;
  let fpsAccum = 0;
  let fpsTimer = 0;
  let fps = 0;

  window.__GAME__.ready = true;

  renderer.setAnimationLoop((timestamp: number) => {
    timer.update(timestamp);
    const dt = timer.getDelta();
    const elapsed = fixedAngle !== null ? fixedAngle / 0.12 : timer.getElapsed();
    updateOrbit(elapsed, carFocus);

    renderer.render(scene, camera);

    frameCount++;
    fpsAccum += dt;
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      fps = Math.round(fpsAccum > 0 ? 1 / (fpsAccum / frameCount) : 0);
      hudEl.textContent = `quality: ${qualityLevel}\nfps: ${fps}\ndraw calls: ${renderer.info.render.calls}\ntriangles: ${renderer.info.render.triangles}`;
      frameCount = 0;
      fpsAccum = 0;
      fpsTimer = 0;
    }
  });
}

main().catch((err) => {
  console.error('[game] fatal init error:', err);
  const hudEl = document.getElementById('hud');
  if (hudEl) hudEl.textContent = `FATAL: ${(err as Error).message}`;
});
