import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { QualityPreset } from './quality';

export interface EnvironmentBundle {
  /** The equirect HDR texture used for both scene.environment (via PMREM) and
   * scene.background (rendered directly, sharp — not the blurred PMREM copy). */
  hdrTexture: THREE.DataTexture;
  pmremTexture: THREE.Texture;
  /**
   * Re-bakes scene.environment's PMREM texture using a DIFFERENT renderer (G5 quality-cycling: Q can
   * swap the whole WebGLRenderer to flip antialias, see main.ts's applyQuality()). The PMREM-baked
   * texture is a GPU-side WebGLRenderTarget owned by whichever renderer's PMREMGenerator produced it
   * — unlike hdrTexture (a plain DataTexture with real CPU-side pixels, safely reusable across any
   * renderer), that GPU resource does NOT survive its owning renderer being disposed. Verified
   * directly: skipping this rebake after a renderer swap left the whole scene lit by the directional
   * sun alone (no IBL/ambient contribution), rendering everything off-axis from the sun very dark —
   * this function is the fix, called once right after a renderer swap.
   */
  rebake: (renderer: THREE.WebGLRenderer) => void;
  dispose: () => void;
}

/**
 * Loads the derelict-airfield HDRI, PMREM-bakes it for IBL (scene.environment),
 * and uses the same equirect texture directly as scene.background so the sky/
 * horizon reads sharp (a blurred PMREM background would look like fog — we use
 * scene.backgroundBlurriness=0 and real exponential Fog (see buildScene.ts)
 * instead for horizon blending, which is cheaper than a full ground-projected
 * skybox and adequate at this camera-orbit distance).
 */
export async function loadEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  url: string,
  quality: QualityPreset,
): Promise<EnvironmentBundle> {
  const loader = new HDRLoader();
  const hdrTexture = await loader.loadAsync(url);
  hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
  // HDR equirect data is linear scene-referred light, never sRGB-tag it.
  hdrTexture.colorSpace = THREE.NoColorSpace;

  let pmremTexture = bakePmrem(renderer, hdrTexture);
  scene.environment = pmremTexture;
  scene.environmentIntensity = 1.0;
  scene.background = hdrTexture;
  scene.backgroundBlurriness = 0;
  scene.backgroundIntensity = 1.0;

  void quality; // reserved: lower envMapSize tiers could re-bake at smaller RT size later

  return {
    hdrTexture,
    get pmremTexture() {
      return pmremTexture;
    },
    rebake: (newRenderer: THREE.WebGLRenderer) => {
      const old = pmremTexture;
      pmremTexture = bakePmrem(newRenderer, hdrTexture);
      scene.environment = pmremTexture;
      old.dispose();
    },
    dispose: () => {
      hdrTexture.dispose();
      pmremTexture.dispose();
    },
  };
}

function bakePmrem(renderer: THREE.WebGLRenderer, hdrTexture: THREE.DataTexture): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromEquirectangular(hdrTexture);
  pmrem.dispose();
  return envRT.texture;
}
