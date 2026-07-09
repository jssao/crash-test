import * as THREE from 'three';

export interface OrbitParams {
  radius: number;
  height: number;
  angularSpeed: number; // radians / second
  targetHeight: number;
}

/**
 * Placeholder for the eventual chase camera (camera/ module, G5): a slow,
 * smooth orbit around the car so the render/lighting/shadows can be judged
 * from every angle without any input wiring yet.
 */
export function createOrbitUpdater(camera: THREE.PerspectiveCamera, params: OrbitParams) {
  return function update(elapsedSeconds: number, focus: THREE.Vector3): void {
    const angle = elapsedSeconds * params.angularSpeed;
    camera.position.set(
      focus.x + Math.cos(angle) * params.radius,
      Math.max(focus.y + params.height, 0.4), // never clip below the ground plane
      focus.z + Math.sin(angle) * params.radius,
    );
    camera.lookAt(focus.x, focus.y + params.targetHeight, focus.z);
  };
}
