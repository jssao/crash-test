import * as THREE from 'three';
import { buildAsphaltTextures } from './proceduralAsphalt';

export interface GroundBundle {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
}

/** Large asphalt/concrete play-area ground plane, receiving shadows. */
export function buildGround(worldSize = 200, repeats = 40): GroundBundle {
  const { map, roughnessMap, normalMap } = buildAsphaltTextures(1024);
  map.repeat.set(repeats, repeats);
  roughnessMap.repeat.set(repeats, repeats);
  normalMap.repeat.set(repeats, repeats);

  const material = new THREE.MeshStandardMaterial({
    map,
    roughnessMap,
    normalMap,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.6, 0.6),
  });

  const geometry = new THREE.PlaneGeometry(worldSize, worldSize, 1, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.name = 'GroundPlane';

  return { mesh, material };
}
