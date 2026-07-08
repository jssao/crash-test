import * as THREE from 'three';
import type { QualityPreset } from '../render/quality';
import { loadEnvironment } from '../render/environment';
import { createSun } from '../render/sun';
import { buildGround } from './ground';
import { loadCar, type CarBundle } from './car';
import { CAR_MAP } from '../assets/car-map';

export interface SceneBundle {
  scene: THREE.Scene;
  car: CarBundle;
  carFocus: THREE.Vector3;
  sunLight: THREE.DirectionalLight;
  updateSunQuality: (q: QualityPreset) => void;
}

const HDRI_URL = 'assets/hdri/derelict_airfield_01_2k.hdr';
const CAR_URL = 'assets/car/CarConcept.glb';

export async function buildScene(renderer: THREE.WebGLRenderer, quality: QualityPreset): Promise<SceneBundle> {
  const scene = new THREE.Scene();

  // Car root sits at the origin; wheel bottoms are already ~Y=0 in the source
  // file (car-map.ts axisConvention note), so no vertical offset is needed.
  const carAnchor = new THREE.Object3D();
  scene.add(carAnchor);

  await loadEnvironment(renderer, scene, HDRI_URL, quality);

  const ground = buildGround(200, 40);
  scene.add(ground.mesh);

  const sun = createSun(quality, carAnchor);
  scene.add(sun.light);
  scene.add(sun.light.target);

  const car = await loadCar(CAR_URL);
  car.root.position.set(0, 0, 0);
  carAnchor.add(car.root);

  // Focus point roughly at the car's visual center (half height), used by the
  // orbit camera and as the shadow-target anchor.
  const carFocus = new THREE.Vector3(0, CAR_MAP.overallDimsMm.height / 1000 / 2, 0);

  return { scene, car, carFocus, sunLight: sun.light, updateSunQuality: sun.update };
}
