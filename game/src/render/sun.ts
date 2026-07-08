import * as THREE from 'three';
import type { QualityPreset } from './quality';

/**
 * Approximate sun direction for `derelict_airfield_01_2k.hdr`, derived by
 * finding the brightest equirectangular texel (scripts/analyze-car.mjs sibling
 * analysis, run once against the .hdr with three's HDRLoader.parse — pure JS,
 * no DOM needed) and inverting three's `equirectUv()` convention
 * (u = atan2(dz,dx)/2π + 0.5, v = asin(dy)/π + 0.5, with the texture's default
 * flipY accounted for): brightest texel ~ (u=0.600, row-from-top=0.399) ->
 * elevation ~18° above horizon, azimuth ~36° in the XZ plane. This matches the
 * HDRI's own description ("partly cloudy morning sun") — low, warm, long
 * shadows. Verified visually against the rendered background (screenshot),
 * not from this math alone: adjust here if the shadow direction and the
 * bright sky/cloud region in scene.background ever disagree.
 */
export const APPROX_SUN_DIRECTION = new THREE.Vector3(0.768, 0.312, 0.560).normalize();

export interface SunBundle {
  light: THREE.DirectionalLight;
  update: (q: QualityPreset) => void;
}

/**
 * A single well-tuned directional shadow (not CSM — the play area for this
 * milestone is one orbiting-camera scene around the car, not an open-world
 * traversal, so a tightly-fit ortho frustum beats cascades on cost/benefit).
 * Biggest acne lever is texel density: keep the frustum as tight as the scene
 * allows, prefer normalBias over raw bias.
 */
export function createSun(quality: QualityPreset, target: THREE.Object3D): SunBundle {
  const light = new THREE.DirectionalLight(0xfff4e0, 3.2);
  const distance = 40;
  light.position.copy(APPROX_SUN_DIRECTION).multiplyScalar(distance);
  light.target = target;

  light.castShadow = true;
  light.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);

  const halfExtent = 14; // covers the ground area around the car + orbit camera
  const cam = light.shadow.camera as THREE.OrthographicCamera;
  cam.left = -halfExtent;
  cam.right = halfExtent;
  cam.top = halfExtent;
  cam.bottom = -halfExtent;
  cam.near = distance - 25;
  cam.far = distance + 25;
  cam.updateProjectionMatrix();

  light.shadow.bias = -0.0003;
  light.shadow.normalBias = 0.02;
  light.shadow.intensity = 1.0;

  function update(q: QualityPreset) {
    light.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    light.shadow.map?.dispose();
    light.shadow.map = null;
    cam.updateProjectionMatrix();
  }

  return { light, update };
}
