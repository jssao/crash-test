import * as THREE from 'three';
import type { QualityPreset } from './quality';

export interface RendererBundle {
  renderer: THREE.WebGLRenderer;
  setQuality: (q: QualityPreset) => void;
}

/**
 * WebGL2 renderer, tuned for realistic outdoor PBR + HDRI:
 * - outputColorSpace = SRGBColorSpace (the r152+ default; renderer stays linear
 *   internally, converts once on output).
 * - toneMapping = AgXToneMapping. Chosen over ACESFilmic after comparing both
 *   against the derelict-airfield HDRI: ACES pushed the sun-lit clouds/paint
 *   highlights toward a warm orange/white hue shift that read as "artificially
 *   cinematic" for a bright open-air runway; AgX kept sky blue and the graphite
 *   paint's specular highlights closer to physically-plausible white/neutral
 *   while still rolling off highlights softly (no HDR clipping). See render/README
 *   note in this file's history — verified by screenshot, not by code alone.
 * - shadowMap enabled, PCFShadowMap (PCFSoftShadowMap is deprecated since r182
 *   and PCFShadowMap is soft by default now — do not port old bias values blindly).
 * - antialias:true on the canvas — this project renders directly to the default
 *   framebuffer (no offscreen HDR post-processing yet), so canvas MSAA is the
 *   correct, sufficient AA path. Once post-processing needs an offscreen HDR
 *   RT, this MUST be swapped for RT `samples` + SMAA (canvas antialias does
 *   nothing on an offscreen WebGLRenderTarget).
 */
export function createRenderer(canvas: HTMLCanvasElement, quality: QualityPreset): RendererBundle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: quality.antialias,
    powerPreference: 'high-performance',
    stencil: false,
  });

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));

  function setQuality(q: QualityPreset) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap));
  }

  return { renderer, setQuality };
}
