// SPDX-License-Identifier: MIT
//
// Car-paint/glass material polish (visual layer only — no geometry, no physics, no body counts
// touched). The Khronos CarConcept GLB's materials were authored/tuned to look right under the OLD
// derelict-airfield HDRI; this file re-tunes the two material families that read wrong against the
// new je_gray_02 forest-daylight HDRI (buildScene.ts):
//
//  1. Body paint ("Paint 1 <variant>"/"Paint 2 <variant>"): the chosen "Torched Graphite" variant
//     ships with NO KHR_materials_clearcoat extension (confirmed by inspecting the GLB's material
//     JSON directly — unlike "Carmine"/"Pearly Swirly", which do carry clearcoat), so three.js's
//     GLTFLoader falls back to a plain MeshStandardMaterial for "Paint 1 Graphite" (no clearcoat
//     lobe possible at all) while "Paint 2 Graphite" happens to load as MeshPhysicalMaterial only
//     because it carries an (unrelated) iridescence extension. That inconsistency plus the metallic-
//     roughness defaults (metalness defaults to 1.0 when metallicFactor is omitted, per the glTF
//     spec — both graphite materials omit it) makes the body read as a flat, bare-metal-looking
//     panel outdoors instead of lacquered automotive paint. Fix: upgrade every paint material to
//     MeshPhysicalMaterial (if it isn't already) and give all of them the SAME clearcoat/metalness/
//     roughness/envMapIntensity tuning, independent of which variant happens to be active.
//
//  2. Glass ("Glass", shared by all 5 window meshes, KHR_materials_transmission factor 1): the GLB
//     ships this at roughness 0 / default ior 1.5 / transmission 1, which three.js renders via its
//     physically-based transmission pipeline (a pre-pass that renders the opaque scene -- INCLUDING
//     the seated occupants -- into an offscreen render target the glass then samples). In principle
//     that should already show the occupants through the glass. Empirically it does not read that
//     way (verify/car-paint.mjs's baseline screenshot: near-opaque dark glass, occupants hidden) --
//     and worse, across many repeated headless-Brave/SwiftShader runs the transmission pass turned
//     out to be outright NON-DETERMINISTIC (same material params, same camera, same quality tier:
//     sometimes clearly see-through, sometimes solid black), which points at a driver/pipeline
//     reliability problem with that offscreen multisampled half-float render target on this
//     project's own SwiftShader-based verify pipeline, not something tunable away with ior/
//     roughness. Rather than ship a "looks right 2 times out of 3" glass, this drops transmission
//     entirely (transmission=0) and uses plain, universally-reliable alpha blending instead
//     (transparent=true, a real opacity) -- the "lower tint/opacity" option the brief explicitly
//     offers as an alternative to transmission. It has no offscreen-render-target dependency, so it
//     can't be flaky: occupants are guaranteed visible at the tuned opacity on every frame/run/tier.
//
// Deliberately does NOT touch: geometry, body counts, mesh identities (materials are mutated in
// place or swapped 1:1 by reference so carDeformables.ts's per-mesh bindings and the shatter-time
// material clone in main.ts keep working unchanged), or any non-paint/non-glass material (Mechanical,
// Interior*, Hardware, lights, wheels/tires — those are handled by ./car.ts's existing logic or left
// as authored).
import * as THREE from 'three';

/** Matches "Paint 1 Graphite", "Paint 2 Carmine", "Paint 1 Pearl", etc. — every body-paint material
 * across every KHR_materials_variants option, not just the currently-chosen one, so this stays
 * correct if CAR_MAP.chosenVariantIndex ever changes. */
const PAINT_NAME_RE = /^Paint [12]\b/;
const GLASS_NAME = 'Glass';

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
  mat.opacity = 0.45;
  mat.roughness = 0.1;
  mat.envMapIntensity = 0.6;
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

      if (mat.name === GLASS_NAME) {
        tuneGlass(mat as THREE.MeshPhysicalMaterial);
        return mat;
      }

      return mat;
    });

    mesh.material = isArray ? next : next[0];
  });
}
