import * as THREE from 'three';
import type { QualityPreset } from '../render/quality';
import { loadEnvironment } from '../render/environment';
import { createSun } from '../render/sun';
import { buildAsphaltApron } from './ground';
import { buildTerrainMesh, type TerrainMeshBundle } from '../world/terrain/terrainMesh';
import { loadCar, type CarBundle } from './car';
import { CAR_MAP } from '../assets/car-map';

export interface SceneBundle {
  scene: THREE.Scene;
  car: CarBundle;
  carFocus: THREE.Vector3;
  sunLight: THREE.DirectionalLight;
  updateSunQuality: (q: QualityPreset) => void;
  /** Moves the sun light + its shadow target to follow the car's (x,z), keeping the tight shadow
   * frustum around the car everywhere in the now-400m world (the old fixed origin-centred frustum
   * only covered ~14m around spawn, so the car lost its shadow the moment it drove out onto the dirt
   * road/forest). Called once per render frame from main.ts. At spawn (0,0) this is identical to the
   * previous fixed behaviour, so existing verify screenshots are unaffected. */
  updateSunFollow: (x: number, z: number) => void;
  /** Re-bakes the IBL environment map for a DIFFERENT renderer -- see render/environment.ts's
   * EnvironmentBundle.rebake() doc comment for why this is required after a Q-cycle renderer swap
   * (main.ts's applyQuality()), not merely a nice-to-have. */
  rebakeEnvironment: (renderer: THREE.WebGLRenderer) => void;
}

// Forest/rural daylight HDRI (Poly Haven "J&E Gray 02", CC0): a sunny outdoor sky with a real
// directional sun -- reads far better over the new terrain/forest than the old industrial airfield.
const HDRI_URL = 'assets/hdri/je_gray_02_2k.hdr';
const CAR_URL = 'assets/car/volvo-s90.glb';

// Sun direction for je_gray_02, measured from its brightest equirect texel the same way sun.ts derives
// the airfield's (azimuth ~36deg, elevation ~21deg) -- almost the same azimuth as the airfield the
// stock createSun() light is tuned for, just a touch higher, so shadows stay consistent with the sky.
const SUN_DIR = new THREE.Vector3(0.754, 0.364, 0.547).normalize();
const SUN_DISTANCE = 40; // matches createSun()'s internal light distance

export async function buildScene(renderer: THREE.WebGLRenderer, quality: QualityPreset): Promise<SceneBundle> {
  const scene = new THREE.Scene();

  const carAnchor = new THREE.Object3D();
  scene.add(carAnchor);

  const environment = await loadEnvironment(renderer, scene, HDRI_URL, quality);

  // Atmospheric depth: linear haze so the 400m terrain's far edges fade into the sky rather than
  // ending in a hard line (the horizon treatment environment.ts's doc comment always intended). The
  // car is only ~6m from the chase camera, so it is never fogged.
  scene.fog = new THREE.Fog(0xc4ccd2, 70, 250);

  // ---- Ground: real terrain (height-field-derived mesh, multi-zone PBR blend) + the flat asphalt
  // apron pad over the spawn/destructibles play area. ----
  const terrain: TerrainMeshBundle = buildTerrainMesh(quality.level === 'low' ? 4 : 8, quality.level === 'low' ? 192 : 256);
  scene.add(terrain.mesh);
  const apron = buildAsphaltApron();
  scene.add(apron.mesh);

  // ---- Sun: its own follow target (NOT carAnchor -- moving carAnchor would move the car, whose root
  // is its child). Overriding the light position to SUN_DIR aligns the shadow with the new HDRI. ----
  const sunTarget = new THREE.Object3D();
  scene.add(sunTarget);
  const sun = createSun(quality, sunTarget);
  sun.light.position.copy(SUN_DIR).multiplyScalar(SUN_DISTANCE);
  scene.add(sun.light);
  scene.add(sun.light.target);

  const updateSunFollow = (x: number, z: number) => {
    sunTarget.position.set(x, 0, z);
    sun.light.position.set(x + SUN_DIR.x * SUN_DISTANCE, SUN_DIR.y * SUN_DISTANCE, z + SUN_DIR.z * SUN_DISTANCE);
  };

  const car = await loadCar(CAR_URL);
  car.root.position.set(0, 0, 0);
  carAnchor.add(car.root);

  const carFocus = new THREE.Vector3(0, CAR_MAP.overallDimsMm.height / 1000 / 2, 0);

  return {
    scene,
    car,
    carFocus,
    sunLight: sun.light,
    updateSunQuality: sun.update,
    updateSunFollow,
    rebakeEnvironment: environment.rebake,
  };
}
