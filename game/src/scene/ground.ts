import * as THREE from 'three';
import { buildAsphaltTextures } from './proceduralAsphalt';
import { APRON } from '../world/terrain/heightfield';

export interface GroundBundle {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
}

/** Large asphalt/concrete play-area ground plane, receiving shadows. Retained for reference / any
 * flat-ground fallback; the game now uses the terrain mesh (world/terrain) + the apron pad below. */
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

/**
 * The paved asphalt apron: a flat pad over the hard-flat APRON zone (spawn + legacy destructibles +
 * ramps), sitting a few cm above the (identically flat, h=0) terrain there so it reads as a real
 * paved lot rather than z-fighting the terrain grass. Uses the existing procedural asphalt so the pad
 * matches the look the game already shipped for the play area.
 */
export function buildAsphaltApron(): GroundBundle {
  const { map, roughnessMap, normalMap } = buildAsphaltTextures(1024);
  // One texture tile per ~5m of pad.
  const repeatsX = (APRON.halfX * 2) / 5;
  const repeatsZ = (APRON.halfZ * 2) / 5;
  for (const t of [map, roughnessMap, normalMap]) t.repeat.set(repeatsX, repeatsZ);

  const material = new THREE.MeshStandardMaterial({
    map,
    roughnessMap,
    normalMap,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.6, 0.6),
  });

  // Slightly inset from the apron half-extents so the terrain grass laps the rounded corners.
  const geometry = new THREE.PlaneGeometry(APRON.halfX * 2 - 2, APRON.halfZ * 2 - 2, 1, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(APRON.cx, 0.03, APRON.cz);
  mesh.receiveShadow = true;
  mesh.name = 'AsphaltApron';

  return { mesh, material };
}
