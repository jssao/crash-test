// SPDX-License-Identifier: MIT
//
// Car-paint/glass material polish (visual layer only — no geometry, no physics, no body counts
// touched). Re-tunes the two Mustang-65 material families that read wrong against the je_gray_02
// forest-daylight HDRI (buildScene.ts):
//
//  1. Body paint ("CarPrimaryColor"/"Car Secondary"): the split asset authors these as a plain flat
//     color factor (near-black dark green) with no clearcoat, and three.js's GLTFLoader builds them as
//     bare MeshStandardMaterials with the glTF metalness default -- which reads as a flat, matte panel
//     outdoors instead of lacquered automotive paint. Fix: upgrade every paint material to
//     MeshPhysicalMaterial (if it isn't already) and give all of them the SAME clearcoat/metalness/
//     roughness/envMapIntensity tuning -> a deep, glossy classic-Mustang finish.
//
//  2. Glass ("TransparentGlass"/"refract glass" — the windshield + rear-window panes; door windows
//     share the first material). This asset carries NO KHR_materials_transmission, so the panes load as
//     OPAQUE MeshStandardMaterials (an undefaulted white factor -> a solid white windshield if left
//     alone). We give them plain, universally-reliable alpha blending (transparent=true, a real
//     opacity + a cool dark tint) -- occupants are visible through the glass at the tuned opacity on
//     every frame/run/tier, with no offscreen-render-target dependency to be flaky (the same reason the
//     legacy CarConcept transmission pipeline was abandoned: it rendered non-deterministically opaque
//     on this project's SwiftShader verify pipeline).
//
// Deliberately does NOT touch: geometry, body counts, mesh identities (materials are mutated in
// place or swapped 1:1 by reference so carDeformables.ts's per-mesh bindings and the shatter-time
// material clone in main.ts keep working unchanged), or any non-paint/non-glass material (Mechanical,
// Interior*, Hardware, lights, wheels/tires — those are handled by ./car.ts's existing logic or left
// as authored).
import * as THREE from 'three';

/** The Mustang-65 asset's two body-paint materials (dark-green primary + secondary, both authored as a
 * near-black flat color factor). The regex form is kept so a future asset with variant-suffixed paint
 * names (e.g. the legacy "Paint 1 Graphite") still matches by widening this one constant. */
const PAINT_NAME_RE = /^(CarPrimaryColor|Car Secondary|Paint [12]\b)/;
/** The Mustang-65 asset's glass materials (windshield/rear-window panes; door windows share the first).
 * This asset carries NO KHR_materials_transmission, so these load as opaque MeshStandardMaterials and
 * MUST be re-tuned to real transparency here (tuneGlass) or the windshield renders as a solid pane. */
const GLASS_NAMES = new Set(['TransparentGlass', 'refract glass', 'Glass']);

/**
 * Upgrades a MeshStandardMaterial to MeshPhysicalMaterial, preserving the handful of properties the
 * source paint materials actually use (flat color factor only — no textures on any Paint material in
 * this GLB). No-op (returns the same instance) if already MeshPhysicalMaterial (true for "Paint 2
 * Graphite", which loads as Physical already thanks to its iridescence extension).
 */
function toPhysical(mat: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  const asPhysical = mat as unknown as THREE.MeshPhysicalMaterial;
  if (asPhysical.isMeshPhysicalMaterial) return asPhysical;

  const physical = new THREE.MeshPhysicalMaterial({
    name: mat.name,
    color: mat.color.clone(),
    map: mat.map,
    roughness: mat.roughness,
    metalness: mat.metalness,
    side: mat.side,
  });
  mat.dispose();
  return physical;
}

/** Subtle, shared tuning for every body-paint material (see module doc comment #1). At metalness
 * near 1 (the glTF default this GLB relies on) the surface has almost no diffuse term at all, so its
 * apparent color is ALMOST ENTIRELY the environment reflection -- under je_gray_02's bright sky +
 * green forest canopy that reads as a washed-out olive/silver car, not a black one (verified directly
 * in screenshots). Backing metalness off lets the material's own near-black base color show through
 * as the dominant tone, with metal flake/clearcoat only adding highlights on top -- "black car with
 * reflections" instead of "reflection-colored car". */
function tunePaint(mat: THREE.MeshPhysicalMaterial): void {
  mat.metalness = 0.35;
  mat.roughness = 0.42;
  mat.clearcoat = 0.4;
  mat.clearcoatRoughness = 0.18;
  mat.envMapIntensity = 0.65;
  mat.needsUpdate = true;
}

/** Rebalances the shared glass material toward "occupants visible" (see module doc comment #2):
 * drops transmission, uses plain alpha blending instead. */
function tuneGlass(mat: THREE.MeshPhysicalMaterial): void {
  if ('transmission' in mat) (mat as unknown as { transmission: number }).transmission = 0;
  mat.transparent = true;
  mat.opacity = 0.38; // low enough that the seated occupants read clearly through the windshield
  mat.color = new THREE.Color(0x1c2630); // cool dark tint (the Mustang glass factor is undefaulted white)
  mat.roughness = 0.1;
  mat.metalness = 0;
  mat.envMapIntensity = 0.7;
  mat.depthWrite = false; // avoid this transparent pane occluding whatever renders behind it next frame
  mat.needsUpdate = true;
}

/**
 * Runs the polish pass over every mesh under `root`. Call once, right after the GLB loads (see
 * car.ts's loadCar()) — BEFORE main.ts's registerCarDeformables()/applyGlassShatterMaterial ever see
 * these meshes, so every downstream consumer (crumple, panel visuals, glass shatter) captures the
 * already-tuned materials, not the raw GLB ones.
 */
export function polishCarMaterials(root: THREE.Object3D): void {
  const paintUpgrades = new Map<THREE.Material, THREE.MeshPhysicalMaterial>();

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;

    const isArray = Array.isArray(mesh.material);
    const materials = isArray ? (mesh.material as THREE.Material[]) : [mesh.material as THREE.Material];

    const next = materials.map((mat) => {
      if (!mat || !mat.name) return mat;

      if (PAINT_NAME_RE.test(mat.name)) {
        let physical = paintUpgrades.get(mat);
        if (!physical) {
          physical = toPhysical(mat as THREE.MeshStandardMaterial);
          tunePaint(physical);
          paintUpgrades.set(mat, physical);
        }
        return physical;
      }

      if (GLASS_NAMES.has(mat.name)) {
        tuneGlass(mat as THREE.MeshPhysicalMaterial);
        return mat;
      }

      return mat;
    });

    mesh.material = isArray ? next : next[0];
  });
}
