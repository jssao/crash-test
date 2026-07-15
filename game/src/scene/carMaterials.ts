// SPDX-License-Identifier: MIT
//
// Car-paint/glass/headlight-lens material polish (visual layer only — no geometry, no physics, no
// body counts touched). Re-tunes the material families that read wrong against the je_gray_02
// forest-daylight HDRI (buildScene.ts):
//
//  1. Body paint: the source asset authors this as a plain flat color factor with no (or an
//     under-specified) clearcoat, and three.js's GLTFLoader builds it with the glTF metalness default
//     -- which reads as a flat, matte panel outdoors instead of lacquered automotive paint (or, for the
//     Volvo S90's "Car Paint" material -- baseColorFactor [0,0,0,1] with NO metallicFactor, i.e. the
//     glTF-default metalness of 1.0 -- as a near-total void-black silhouette: a fully-metallic surface's
//     reflectance (F0) IS its base color, so pure-black + fully-metallic reflects almost nothing at
//     all). Fix: upgrade every paint material to MeshPhysicalMaterial (if it isn't already) and give
//     all of them the SAME clearcoat/metalness/roughness/envMapIntensity tuning -> a deep, glossy dark
//     metallic finish, plus zero out KHR_materials_anisotropy (see tunePaint()'s doc comment — this is
//     also the fix for the white speckled-patch defect on hood/roof/trunk).
//
//  2. Glass (structural window panes: windshield/rear window/quarter glass/sunroof, + door windows and
//     the rearview mirror baked into the body-shell/door meshes). Whichever material name(s) the active
//     CAR_MAP.glassMaterials records with transmissionFactor===0 (i.e. matched purely by the analyze
//     script's per-car allowlist, not because the source asset actually authored real transmission) load
//     as OPAQUE MeshStandardMaterials (often an undefaulted white factor -> a solid white windshield if
//     left alone). We give these plain, universally-reliable alpha blending (transparent=true, a real
//     opacity + a cool dark tint) -- occupants are visible through the glass at the tuned opacity on
//     every frame/run/tier, with no offscreen-render-target dependency to be flaky (the same reason the
//     legacy CarConcept transmission pipeline was abandoned: it rendered non-deterministically opaque
//     on this project's SwiftShader verify pipeline). Materials with a REAL KHR_materials_transmission
//     extension (transmissionFactor===1 in CAR_MAP.glassMaterials) are left alone -- three's GLTFLoader
//     already builds those correctly.
//
//  3. Headlight-lens glass (CAR_MAP.headlightLensMaterialNames — the S90's "Glass headlights" material,
//     used by the main headlight/running-light/foglight lenses): authors NO pbrMetallicRoughness block
//     at all, so every factor falls to the glTF default (baseColor white, metallicFactor 1.0,
//     roughnessFactor 1.0) -- a fully-metallic, fully-rough, colorless cap that reads as plain white and
//     hides the reflector/emitter geometry behind it. Fix: a DIFFERENT treatment than #2 above (a lit
//     lens, not a tinted window) -- glossy, mostly see-through, warm emissive so the cluster reads as a
//     functioning light rather than a blank white lens.
//
// Deliberately does NOT touch: geometry, body counts, mesh identities (materials are mutated in
// place or swapped 1:1 by reference so carDeformables.ts's per-mesh bindings and the shatter-time
// material clone in main.ts keep working unchanged), or any non-paint/non-glass/non-headlight-lens
// material (Mechanical, Interior*, Hardware, other lights, wheels/tires — those are handled by
// ./car.ts's existing logic or left as authored).
import * as THREE from 'three';
import { CAR_MAP } from '../assets/car-map';

/** Body-paint material names for the ACTIVE car GLB, resolved by scripts/analyze-car.mjs from the
 * actual materials list (see that script's per-car CONFIG.paintMaterialMatch) — NOT a hand-maintained
 * regex. This is what silently broke when the Mustang→S90 swap landed: a hardcoded
 * `/^(CarPrimaryColor|Car Secondary|Paint [12]\b)/` never matched the S90's "Car Paint" material, so
 * tunePaint() never ran and the paint rendered near-black everywhere (R005/R001, 2026-07-15). */
const PAINT_NAMES = new Set(CAR_MAP.paintMaterialNames);
/** Structural window-pane glass for the active GLB: exactly the glassMaterials entries with
 * transmissionFactor===0 — i.e. matched only via the analyze script's config allowlist because the
 * source asset didn't author a real KHR_materials_transmission extension (see tuneGlass()'s doc
 * comment above). Materials that DO carry a real transmission extension (factor 1) are left untouched;
 * three's GLTFLoader already builds those as proper transmissive MeshPhysicalMaterials. */
const GLASS_NAMES = new Set(CAR_MAP.glassMaterials.filter((g) => g.transmissionFactor === 0).map((g) => g.name));
/** Headlight/running-light/foglight lens glass for the active GLB (empty for assets with no dedicated
 * lens material) — see tuneHeadlightLens()'s doc comment. */
const HEADLIGHT_LENS_NAMES = new Set(CAR_MAP.headlightLensMaterialNames);

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
 * near 1 (the glTF default several source GLBs rely on) a material's reflectance (F0) IS its base
 * color -- so a near-black/pure-black base color at high metalness reflects almost nothing at all
 * (confirmed directly against the raw GLB: "Car Paint" authors baseColorFactor [0,0,0,1] with no
 * metallicFactor at all, i.e. the glTF-default 1.0 -- exactly the combination that renders as a
 * void-black silhouette). Backing metalness off toward the dielectric end blends in the physically-based ~4%
 * colorless Fresnel reflectance every dielectric surface has REGARDLESS of its base color, so the
 * body reads with clear environment reflections/highlights even over a literally-black base color --
 * "glossy black car with reflections" instead of "void-black car" (or, for a near-black-but-not-zero
 * base color, "reflection-colored car"). Clearcoat adds a second, glossier reflective layer on top
 * (the automotive-lacquer look).
 *
 * anisotropy=0: the S90's "Car Paint" material carries KHR_materials_anisotropy (strength 0.136)
 * from the source GLB, which three.js's anisotropy shading falls back to using per-pixel screen-space
 * derivative tangents when the mesh carries no authored TANGENT attribute (true here for every paint
 * mesh). Confirmed via direct GLB inspection: Hood/Trunk/DoorL/DoorR/DoorRL/DoorRR don't even carry a
 * UV attribute (TEXCOORD_0), so THREE.BufferGeometry.computeTangents() (which requires UV) can't run
 * on them at all -- an anisotropy fix that relied on computed tangents would leave hood+trunk (2 of
 * the 3 reported speckle locations) unfixed. Zeroing anisotropy on the shared material sidesteps the
 * missing-tangent-basis problem entirely and is a no-op for any asset (e.g. the Mustang paint) that
 * never authored anisotropy in the first place. */
function tunePaint(mat: THREE.MeshPhysicalMaterial): void {
  // Albedo floor for literally-black paint: real "black" automotive paint still diffuses ~1-2% of
  // incident light (that's what lets body curvature read in shade), but the S90 authors baseColor as
  // EXACTLY [0,0,0] -- zero diffuse forever, so on the main driving page's dimmer airfield HDRI the
  // body collapsed to a silhouette even after the metalness fix (verified in this pass's first
  // screenshot round: crash-lab/model-viewer's brighter studio HDRI carried the specular alone, the
  // driving page didn't). Lift ONLY a near-zero authored color up to a very dark charcoal; any
  // genuinely-colored paint (e.g. the Mustang's dark green) passes through untouched.
  if (mat.color.r < 0.012 && mat.color.g < 0.012 && mat.color.b < 0.012) mat.color.setHex(0x1a1c1e);
  mat.metalness = 0.35;
  mat.roughness = 0.36;
  mat.clearcoat = 0.7;
  mat.clearcoatRoughness = 0.12;
  mat.envMapIntensity = 0.85;
  if ('anisotropy' in mat) (mat as unknown as { anisotropy: number }).anisotropy = 0;
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

/** Rebalances the headlight/running-light/foglight lens glass toward "reads as a lit lamp" (see module
 * doc comment #3): unlike tuneGlass() above, this is NOT a dark tinted window -- it's a warm, glossy,
 * mostly see-through lens with its own emissive glow, so the headlight cluster reads as a light rather
 * than a blank white cap. Left as MeshStandardMaterial (no clearcoat/transmission authored on this
 * material, so GLTFLoader never upgrades it to Physical) -- emissive + emissiveIntensity are valid on
 * MeshStandardMaterial too. */
function tuneHeadlightLens(mat: THREE.MeshStandardMaterial): void {
  mat.color = new THREE.Color(0xfff6e6); // warm-white lens tint, not the undefaulted flat white
  mat.roughness = 0.12; // glossy lens surface
  mat.metalness = 0;
  mat.transparent = true;
  mat.opacity = 0.6; // lets the chrome reflector/emitter geometry behind the lens read through
  mat.emissive = new THREE.Color(0xffc97a); // warm halogen-ish glow
  mat.emissiveIntensity = 1.6;
  mat.envMapIntensity = 0.8;
  mat.depthWrite = false; // avoid occluding the reflector/emitter geometry sharing this mesh
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

      if (PAINT_NAMES.has(mat.name)) {
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

      if (HEADLIGHT_LENS_NAMES.has(mat.name)) {
        tuneHeadlightLens(mat as THREE.MeshStandardMaterial);
        return mat;
      }

      return mat;
    });

    mesh.material = isArray ? next : next[0];
  });
}
