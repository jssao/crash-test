// SPDX-License-Identifier: MIT
//
// Reversible render-mode overlay for the currently-displayed model. The viewer shows exactly one model
// at a time, so this simply mutates that model's meshes and can always fully revert them before
// switching model or mode — no per-mesh material cloning (which would be heavy for the GLB car).
//
//   shaded    — the model's own PBR materials, untouched.
//   wireframe — flips material.wireframe on every mesh material (shows real triangulation, still lit).
//   normals   — swaps a shared MeshNormalMaterial in (inspect normals / surfacing), originals restored.
//
// Materials are shared across catalog models, so wireframe=true on a shared material would "leak" to
// another model that reuses it — revert() (called on every model/mode change before the next apply)
// resets exactly the materials/meshes touched, so a leak can never outlive the current selection.

import * as THREE from 'three';

export type RenderMode = 'shaded' | 'wireframe' | 'normals';

export interface RenderModes {
  readonly mode: RenderMode;
  /** Point at a new display object (reverts the previous one, re-applies the current mode). */
  setTarget(object: THREE.Object3D | null): void;
  /** Change mode on the current target. */
  setMode(mode: RenderMode): void;
  dispose(): void;
}

export function createRenderModes(): RenderModes {
  const normalMat = new THREE.MeshNormalMaterial();
  let target: THREE.Object3D | null = null;
  let mode: RenderMode = 'shaded';

  const wireTouched = new Set<THREE.Material>();
  const savedMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  function revert(): void {
    for (const m of wireTouched) (m as THREE.Material & { wireframe?: boolean }).wireframe = false;
    wireTouched.clear();
    for (const [mesh, mat] of savedMaterials) mesh.material = mat;
    savedMaterials.clear();
  }

  function apply(): void {
    if (!target || mode === 'shaded') return;
    target.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mode === 'wireframe') {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (mat && 'wireframe' in mat) {
            (mat as THREE.Material & { wireframe: boolean }).wireframe = true;
            wireTouched.add(mat);
          }
        }
      } else {
        savedMaterials.set(mesh, mesh.material);
        mesh.material = normalMat;
      }
    });
  }

  return {
    get mode() {
      return mode;
    },
    setTarget(object) {
      revert();
      target = object;
      apply();
    },
    setMode(next) {
      revert();
      mode = next;
      apply();
    },
    dispose() {
      revert();
      normalMat.dispose();
    },
  };
}
