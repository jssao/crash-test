// SPDX-License-Identifier: MIT
//
// Builds the browsable model catalog by calling the game's REAL procedural/GLB model builders — no
// geometry is duplicated or re-authored here. Most builders (destructibles, trees, buildings,
// occupants) read their mesh transforms straight off live box3d bodies at build time, so this needs a
// physics World (passed in, already init()'d). We spawn every world body once, build its visuals, then
// lift out one representative display object per model — the bodies are never stepped, they exist only
// so the builders have transforms to read. The car (GLB) and the engine-bay parts (pure shape builders)
// need no physics at all.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { World } from '../../../src/ts/index.js';
import type { ModelEntry, ModelStats } from './types';

import { loadCar } from '../scene/car';
import { CAR_MAP } from '../assets/car-map';
import { createDestructibleWorld } from '../world/bodies';
import { buildDestructibleVisuals } from '../world/visuals';
import { createTreesWorld } from '../world/features/trees/bodies';
import { buildTreesVisuals } from '../world/features/trees/visuals';
import { buildAllStructures } from '../world/features/buildings/structures';
import { buildBuildingsVisuals } from '../world/features/buildings/visuals';
import { createVehicle } from '../vehicle/vehicle';
import { createOccupant } from '../world/features/occupants/physics';
import { buildOccupantVisual } from '../world/features/occupants/visuals';
import { SHAPE_BUILDERS } from '../world/features/cardetail/shapes';
import { buildCarDetailMaterials } from '../world/features/cardetail/materials';
import { CAR_DETAIL_SPECS } from '../world/features/cardetail/tuning';

const CAR_URL = 'assets/car/volvo-s90.glb';
const CONCEPT_URL = 'assets/car/CarConcept.glb';

/** "1.83 × 1.30 × 4.52 m" from an object's axis-aligned bounds (world units = meters). */
function describeDims(object: THREE.Object3D): string {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return '';
  const s = new THREE.Vector3();
  box.getSize(s);
  const f = (n: number) => n.toFixed(n < 10 ? 2 : 1);
  return `${f(s.x)} × ${f(s.y)} × ${f(s.z)} m`;
}

/** castShadow/receiveShadow every mesh under an object (some builders set it, some don't — belt +
 * braces so every catalog model grounds itself with a shadow on the pedestal). */
function enableShadows(object: THREE.Object3D): void {
  object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

/** Triangle/vertex/mesh/material counts — the numbers that matter for a game asset. Triangles come
 * from the index (or raw position count / 3 for non-indexed geometry); materials are counted unique by
 * reference (so a model sharing one material across 60 pieces reads as 1, which is the honest draw-cost
 * signal). */
function computeStats(object: THREE.Object3D): ModelStats {
  let triangles = 0;
  let vertices = 0;
  let meshes = 0;
  const materials = new Set<THREE.Material>();
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshes++;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (pos) vertices += pos.count;
    if (geo.index) triangles += geo.index.count / 3;
    else if (pos) triangles += pos.count / 3;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if (m) materials.add(m);
  });
  return { triangles: Math.round(triangles), vertices, meshes, materials: materials.size };
}

function entry(id: string, label: string, category: string, object: THREE.Object3D, note?: string): ModelEntry {
  enableShadows(object);
  return { id, label, category, object, dims: describeDims(object), note, stats: computeStats(object) };
}

export interface Catalog {
  entries: ModelEntry[];
}

export async function buildCatalog(world: World): Promise<Catalog> {
  const entries: ModelEntry[] = [];
  const warn = (where: string, e: unknown) => console.warn(`[model-viewer] ${where} failed:`, e);

  // ---- Vehicle (GLB) --------------------------------------------------------------------------
  try {
    const car = await loadCar(CAR_URL);
    const mm = CAR_MAP.overallDimsMm;
    entries.push({
      id: 'car-volvo-s90',
      label: 'Volvo S90 (full car)',
      category: 'Vehicle',
      object: car.root,
      dims: `${(mm.width / 1000).toFixed(2)} × ${(mm.height / 1000).toFixed(2)} × ${(mm.length / 1000).toFixed(2)} m`,
      note: 'GLB · body + glass + wheels',
      stats: computeStats(car.root),
    });
  } catch (e) {
    warn('car (volvo-s90)', e);
  }
  try {
    // Bonus concept model in the asset folder — plain load (not the game's logo-sanitize/variant path,
    // which is keyed to the S90's CAR_MAP). Guarded so a missing/odd file never breaks the catalog.
    const gltf = await new GLTFLoader().loadAsync(CONCEPT_URL);
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    entries.push(entry('car-concept', 'Concept car', 'Vehicle', gltf.scene, 'GLB'));
  } catch (e) {
    warn('car (concept)', e);
  }

  // ---- Props (destructible world) -------------------------------------------------------------
  try {
    const dw = createDestructibleWorld(world);
    const dvis = buildDestructibleVisuals(dw);
    const rep = (pred: (b: (typeof dw.bodies)[number]) => boolean): THREE.Object3D | null => {
      const i = dw.bodies.findIndex(pred);
      return i >= 0 ? dvis.visuals[i].mesh.clone() : null;
    };
    const props: Array<[string, string, THREE.Object3D | null, string]> = [
      ['prop-wall-concrete', 'Concrete wall block', rep((b) => b.kind === 'wallBlock' && b.material === 'concrete'), 'concrete'],
      ['prop-wall-brick', 'Brick wall block', rep((b) => b.kind === 'wallBlock' && b.material === 'brick'), 'brick'],
      ['prop-crate', 'Wooden crate', rep((b) => b.kind === 'crate'), 'wood'],
      ['prop-barrel-blue', 'Blue barrel', rep((b) => b.material === 'barrelBlue'), '12-gon drum'],
      ['prop-barrel-rust', 'Rusted barrel', rep((b) => b.material === 'barrelRust'), '12-gon drum · explosive'],
      ['prop-pole', 'Utility pole', rep((b) => b.kind === 'pole'), 'wood'],
    ];
    for (const [id, label, obj, note] of props) {
      if (obj) entries.push(entry(id, label, 'Props', obj, note));
    }
    // Ramps live in dw.ramps and were appended to the visual group right after the body meshes.
    const rampMeshes = dvis.group.children.slice(dw.bodies.length, dw.bodies.length + dw.ramps.length);
    dw.ramps.forEach((ramp, i) => {
      const mesh = rampMeshes[i];
      if (mesh) entries.push(entry(`prop-ramp-${ramp.id}`, `Ramp (${ramp.id})`, 'Props', mesh.clone(), `${ramp.angleDeg}° · concrete`));
    });
  } catch (e) {
    warn('props', e);
  }

  // ---- Trees (as they appear in-game: GLB models scaled to each physics size class) ------------
  try {
    const trees = createTreesWorld(world);
    const tvis = buildTreesVisuals(trees);
    // Force the clone visible — buildTreesVisuals() seeds group.visible from the in-game distance-LOD
    // (from spawn), so a tree spawned past the cull radius would otherwise clone in hidden here.
    const treeClone = (g: THREE.Object3D): THREE.Object3D => {
      const c = g.clone();
      c.visible = true;
      return c;
    };
    if (tvis.saplings[0]) entries.push(entry('tree-sapling', 'Sapling (in-game)', 'Trees', treeClone(tvis.saplings[0].group), 'GLB · scaled to sapling class'));
    if (tvis.mids[0]) entries.push(entry('tree-mid', 'Mid tree (in-game)', 'Trees', treeClone(tvis.mids[0].group), 'GLB · scaled to mid class'));
    if (tvis.larges[0]) entries.push(entry('tree-large', 'Large tree (in-game)', 'Trees', treeClone(tvis.larges[0].group), 'GLB · scaled to large class'));
  } catch (e) {
    warn('trees', e);
  }

  // ---- Tree pack (the raw optimized GLBs at native scale — one per converted source tree) ------
  try {
    const loader = new GLTFLoader();
    const packNames = ['tree_005', 'tree_004', 'tree_022', 'tree_014', 'tree_013', 'tree_012'];
    const loaded = await Promise.all(
      packNames.map(async (name) => {
        try {
          const gltf = await loader.loadAsync(`assets/trees/models/${name}.glb`);
          return { name, scene: gltf.scene };
        } catch {
          return null;
        }
      }),
    );
    for (const item of loaded) {
      if (item) entries.push(entry(`treepack-${item.name}`, item.name, 'Tree pack', item.scene, 'optimized GLB · native scale'));
    }
  } catch (e) {
    warn('tree pack', e);
  }

  // ---- Structures (buildings) ------------------------------------------------------------------
  try {
    const structures = buildAllStructures(world);
    const labelFor: Record<string, string> = { shed: 'Shed', 'house-corner': 'House corner', 'brick-wall': 'Brick wall' };
    let fenceShown = false;
    for (const s of structures) {
      let label = labelFor[s.id];
      if (!label) {
        if (fenceShown) continue; // one fence example is enough
        label = 'Fence line';
        fenceShown = true;
      }
      // Per-structure visuals: its own group of piece meshes, positioned in world space (recentered on
      // mount). Materials are rebuilt per call — a few extra shared materials, negligible for a viewer.
      const bundle = buildBuildingsVisuals([s]);
      entries.push(entry(`struct-${s.id}`, label, 'Structures', bundle.group, `${s.pieces.length} pieces`));
    }
  } catch (e) {
    warn('structures', e);
  }

  // ---- Occupant (ragdoll) ----------------------------------------------------------------------
  try {
    const vehicle = createVehicle(world);
    const occ = createOccupant(world, vehicle.chassis, 0, 'frontLeft', vehicle.spawnPosition, vehicle.spawnRotation);
    const visual = buildOccupantVisual(occ, 'frontLeft');
    entries.push(entry('occupant', 'Ragdoll occupant', 'Occupants', visual.group.clone(), '11 capsule/sphere parts'));
  } catch (e) {
    warn('occupant', e);
  }

  // ---- Engine-bay parts (pure shape builders — no physics) -------------------------------------
  try {
    const mats = buildCarDetailMaterials();
    for (const spec of CAR_DETAIL_SPECS) {
      const builder = SHAPE_BUILDERS[spec.id];
      if (!builder) continue;
      const mesh = builder(spec, mats);
      // Same canonical-frame -> spec-axis wrapper rotation the game's buildMeshFor() applies, so parts
      // read in their installed orientation.
      if (spec.phys === 'capsuleZ') mesh.rotateX(Math.PI / 2);
      else if (spec.phys === 'capsuleX') mesh.rotateZ(Math.PI / 2);
      entries.push(entry(`part-${spec.id}`, spec.label, 'Engine bay', mesh, `${spec.matKey} · ${spec.strength}`));
    }
  } catch (e) {
    warn('engine-bay parts', e);
  }

  return { entries };
}
