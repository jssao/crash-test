import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { QualityPreset } from './quality';

export interface EnvironmentBundle {
  /** The equirect HDR texture used for both scene.environment (via PMREM) and
   * scene.background (rendered directly, sharp — not the blurred PMREM copy). */
  hdrTexture: THREE.DataTexture;
  pmremTexture: THREE.Texture;
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

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromEquirectangular(hdrTexture);

  scene.environment = envRT.texture;
  scene.environmentIntensity = 1.0;
  scene.background = hdrTexture;
  scene.backgroundBlurriness = 0;
  scene.backgroundIntensity = 1.0;

  pmrem.dispose();

  void quality; // reserved: lower envMapSize tiers could re-bake at smaller RT size later

  return {
    hdrTexture,
    pmremTexture: envRT.texture,
    dispose: () => {
      hdrTexture.dispose();
      envRT.texture.dispose();
    },
  };
}
