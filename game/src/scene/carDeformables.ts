// SPDX-License-Identifier: MIT
//
// Browser-only glue: extracts real GLB mesh geometry (chassis shell + the 5 panels + glass) and
// registers it with the damage system's crumple registry (game/src/damage/crumple.ts, renderer-free),
// then syncs the deformed positions/normals back into each THREE.BufferGeometry every fixed step. Call
// registerCarDeformables() AFTER detachWheelVisuals() (game/src/scene/wheels.ts) so wheel meshes are
// already out of car.root's subtree and don't get swept up as "chassis shell".
//
// COORDINATE FRAMES: crumple.ts registers each mesh in the LOCAL FRAME of whatever body it's
// `attachedTo` ('chassis' or a PanelKey -- see system.ts's transformFor()). A mesh's raw geometry
// attribute is in that MESH's OWN local space, which can be several transform levels below car.root.
// At registration time (right after load, before any physics step -- car.root/carAnchor sit at an
// identity transform then, per buildScene()'s doc comment), each mesh's `matrixWorld` therefore equals
// its transform relative to car.root's own space (the "visual model" space, wheel-bottoms ~Y=0 per
// car-map.ts's axisConvention). That's a FIXED baked matrix (car-map hierarchies don't animate), used
// to convert mesh-local <-> visual-model-space once at registration. From visual-model space:
//   chassis-local Y = visual-model Y - CHASSIS_ORIGIN_HEIGHT_M (X/Z unchanged)          -- for
//   chassis/glass meshes (car.root's own render transform each frame IS the chassis transform,
//   SAME rotation, so this is a pure translation)
//   panel-local = inverse(panel.nodeWorldQuat).rotate(chassis-local - panel.localCenter)  -- for panel
//   meshes. A panel body's transform equals chassisTransform * translate(localCenter) * rotate
//   (nodeWorldQuat) while rigidly welded (panels.ts's createPanels() doc comment: the body's rest
//   rotation matches the mesh's ACTUAL authored orientation, chassisRot * nodeWorldQuat, not bare
//   chassisRot) -- so converting a chassis-local point into this body's own local frame needs that
//   extra un-rotate, not just a translation. Once loosened/broken, the panel mesh is reparented and
//   driven directly by its own body (panelVisuals.ts), so this same PANEL-LOCAL registration frame
//   remains correct forever (crumple.ts's positions are always in "that body's local frame", never
//   "car.root's frame").

import * as THREE from 'three';
import { CAR_MAP } from '../assets/car-map';
import { CHASSIS_ORIGIN_HEIGHT_M } from '../vehicle/tuning';
import { registerDeformable, type DamageSystem } from '../damage/system';
import { PANEL_KEYS, PANEL_NODE_NAMES, type PanelHandle, type PanelKey } from '../damage/panels';
import type { DeformableMeshHandle } from '../damage/crumple';
import { structuralFieldFor, type StructuralCrushState } from './structuralCrush';

/** Each panel's GLB node world rotation (car-map.ts's PanelNode.worldQuat), as a THREE.Quaternion --
 * the same rigid chassis-local orientation offset panels.ts's createPanels() spawns/welds the panel
 * BODY at, needed here to convert between "chassis-local" and "that panel body's own local" frames. */
const PANEL_WORLD_QUAT: Record<PanelKey, THREE.Quaternion> = (() => {
	const out = {} as Record<PanelKey, THREE.Quaternion>;
	for (const key of PANEL_KEYS) {
		const q = CAR_MAP.panels[PANEL_NODE_NAMES[key]].worldQuat;
		out[key] = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
	}
	return out;
})();

interface Binding {
	mesh: THREE.Mesh;
	handle: DeformableMeshHandle;
	/** Registration-time mesh-local -> visual-model-space matrix (fixed, baked once). */
	forwardMatrix: THREE.Matrix4;
	inverseMatrix: THREE.Matrix4;
	attachedTo: 'chassis' | PanelKey;
}

export interface CarDeformableBindings {
	bindings: Binding[];
}

function findPanelAncestor(object: THREE.Object3D, panelNodeNames: Set<string>): string | null {
	let cur: THREE.Object3D | null = object;
	while (cur) {
		if (panelNodeNames.has(cur.name)) return cur.name;
		cur = cur.parent;
	}
	return null;
}

/** Registers every mesh under `carRoot` (call AFTER detachWheelVisuals()) with the damage system's
 * crumple registry: the 5 panel nodes' own meshes (kind='panel'), car-map.ts's glassMeshNodes
 * (kind='glass', chassis-attached), everything else (kind='chassis'). */
export function registerCarDeformables(system: DamageSystem, carRoot: THREE.Object3D, panels: Record<PanelKey, PanelHandle>): CarDeformableBindings {
	const panelNodeNameToKey = new Map<string, PanelKey>();
	for (const key of PANEL_KEYS) panelNodeNameToKey.set(PANEL_NODE_NAMES[key], key);
	const panelNodeNames = new Set(panelNodeNameToKey.keys());
	const glassNames = new Set(CAR_MAP.glassMeshNodes);

	carRoot.updateWorldMatrix(true, true);

	const bindings: Binding[] = [];
	let autoId = 0;

	carRoot.traverse((object) => {
		const mesh = object as THREE.Mesh;
		if (!mesh.isMesh || !mesh.geometry) return;
		const posAttr = mesh.geometry.getAttribute('position');
		if (!posAttr) return;

		const panelAncestorName = findPanelAncestor(mesh, panelNodeNames);
		const isGlass = glassNames.has(mesh.name) || (mesh.parent && glassNames.has(mesh.parent.name));

		let kind: 'chassis' | 'panel' | 'glass';
		let attachedTo: 'chassis' | PanelKey;
		if (panelAncestorName) {
			kind = 'panel';
			attachedTo = panelNodeNameToKey.get(panelAncestorName)!;
		} else if (isGlass) {
			kind = 'glass';
			attachedTo = 'chassis';
		} else {
			kind = 'chassis';
			attachedTo = 'chassis';
		}

		const forwardMatrix = mesh.matrixWorld.clone(); // mesh-local -> visual-model-space (car.root space)
		const inverseMatrix = forwardMatrix.clone().invert();

		const vertexCount = posAttr.count;
		const basePositions = new Float32Array(vertexCount * 3);
		const v = new THREE.Vector3();
		const localCenter = attachedTo === 'chassis' ? null : panels[attachedTo].localCenter;
		// inverse(nodeWorldQuat): chassis-local -> that panel BODY's own local frame (see this module's
		// COORDINATE FRAMES doc comment) -- null for chassis/glass meshes, which need no extra rotation.
		const invPanelQuat = attachedTo === 'chassis' ? null : PANEL_WORLD_QUAT[attachedTo].clone().invert();
		for (let i = 0; i < vertexCount; i++) {
			v.fromBufferAttribute(posAttr, i);
			v.applyMatrix4(forwardMatrix); // -> visual-model space
			v.y -= CHASSIS_ORIGIN_HEIGHT_M; // -> chassis-local
			if (localCenter) {
				v.x -= localCenter.x;
				v.y -= localCenter.y;
				v.z -= localCenter.z;
				v.applyQuaternion(invPanelQuat!); // -> panel BODY's own local frame
			}
			basePositions[i * 3] = v.x;
			basePositions[i * 3 + 1] = v.y;
			basePositions[i * 3 + 2] = v.z;
		}

		const indexAttr = mesh.geometry.getIndex();
		const indices = indexAttr ? Uint32Array.from(indexAttr.array as ArrayLike<number>) : null;

		const id = `${kind}-${mesh.name || 'mesh'}-${autoId++}`;
		const handle = registerDeformable(system, id, kind, attachedTo, basePositions, indices);

		// GLTFLoader can share the same BufferGeometry/attribute arrays across multiple mesh nodes that
		// reference the same underlying mesh definition -- clone the position/normal attributes here so
		// deforming THIS mesh instance can never contaminate another node reusing the same geometry.
		// (Cloning the ARRAY, not replacing it with zeros -- the original authored positions must
		// survive; the crumple registry's own `positions` starts as a copy of `basePositions`, i.e.
		// identical to this mesh's original shape, so the first sync just writes back the same values.)
		const clonedPosArray = (posAttr.array as Float32Array).slice();
		mesh.geometry.setAttribute('position', new THREE.BufferAttribute(clonedPosArray, 3));
		if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
		const normAttr = mesh.geometry.getAttribute('normal');
		const clonedNormArray = (normAttr.array as Float32Array).slice();
		mesh.geometry.setAttribute('normal', new THREE.BufferAttribute(clonedNormArray, 3));

		bindings.push({ mesh, handle, forwardMatrix, inverseMatrix, attachedTo });
	});

	return { bindings };
}

const scratchV = new THREE.Vector3();

/**
 * Body-local position of vertex `i` with the structural-crush field (scene/structuralCrush.ts)
 * folded in, written into `out`. COMBINE RULE: x/y displacements ADD (contact dents + structural
 * buckle stack), but along z -- the crush axis both passes push on -- the DEEPER of the two wins,
 * not the sum: the contact-dent pipeline already caves the barrier-facing surface by ~the mechanical
 * crush depth, and the structural compaction encodes that same total shortening as a field, so
 * summing them would double-crush the nose face (~0.84m on a 0.42m crash).
 */
function combinedBodyLocal(handle: DeformableMeshHandle, sOff: Float32Array, i: number, out: THREE.Vector3): void {
	const cx = handle.offsets[i * 3];
	const cy = handle.offsets[i * 3 + 1];
	const cz = handle.offsets[i * 3 + 2];
	const sz = sOff[i * 3 + 2];
	out.set(
		handle.basePositions[i * 3] + cx + sOff[i * 3],
		handle.basePositions[i * 3 + 1] + cy + sOff[i * 3 + 1],
		handle.basePositions[i * 3 + 2] + (Math.abs(cz) >= Math.abs(sz) ? cz : sz),
	);
}

/** Writes each registered mesh's current (possibly deformed) positions/normals back into its
 * THREE.BufferGeometry, converting from the crumple registry's body-local frame back to mesh-local
 * space via the registration-time inverse matrix. Call once per fixed step (cheap: only iterates
 * meshes that were actually part of the damage system, and BufferAttribute uploads are the only real
 * cost, same as any other skinned/morph-target mesh).
 *
 * `struct` (optional): the structural-crush visual state (scene/structuralCrush.ts) -- meshes with an
 * ACTIVE field get the combined (crumple + structural) positions and THREE-side recomputed normals
 * (version-gated: only when the field actually rebuilt since this mesh's last sync, so the steady
 * post-crash state costs nothing extra). Passing null keeps the exact pre-structural behavior. */
export function syncCarDeformablesToThree(bindings: CarDeformableBindings, panels: Record<PanelKey, PanelHandle>, struct: StructuralCrushState | null = null): void {
	for (const b of bindings.bindings) {
		const { handle, mesh, inverseMatrix, attachedTo } = b;
		const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
		const localCenter = attachedTo === 'chassis' ? null : panels[attachedTo].localCenter;
		// Forward nodeWorldQuat: panel BODY's own local frame -> chassis-local (see this module's
		// COORDINATE FRAMES doc comment) -- the exact inverse of registerCarDeformables()'s conversion.
		const panelQuat = attachedTo === 'chassis' ? null : PANEL_WORLD_QUAT[attachedTo];
		const sf = struct ? structuralFieldFor(struct, handle) : null;
		const sOff = sf && sf.active && sf.offsets ? sf.offsets : null;
		for (let i = 0; i < handle.vertexCount; i++) {
			if (sOff) combinedBodyLocal(handle, sOff, i, scratchV);
			else scratchV.set(handle.positions[i * 3], handle.positions[i * 3 + 1], handle.positions[i * 3 + 2]);
			if (localCenter) {
				scratchV.applyQuaternion(panelQuat!); // -> chassis-local, panel-centered
				scratchV.x += localCenter.x;
				scratchV.y += localCenter.y;
				scratchV.z += localCenter.z;
			}
			scratchV.y += CHASSIS_ORIGIN_HEIGHT_M;
			scratchV.applyMatrix4(inverseMatrix);
			posAttr.setXYZ(i, scratchV.x, scratchV.y, scratchV.z);
		}
		posAttr.needsUpdate = true;

		if (sOff) {
			// Structural field active: registry normals don't know about it -- recompute THREE-side
			// from the final combined positions, but only when the field rebuilt since this mesh's
			// last sync (the field converges within the crash's ~1s window, then this never runs).
			if (sf!.lastSyncedVersion !== struct!.version) {
				mesh.geometry.computeVertexNormals();
				sf!.lastSyncedVersion = struct!.version;
			}
		} else if (handle.normals) {
			const normAttr = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
			// Normals only need the ROTATION part of the forward/inverse transform (no translation);
			// THREE.Vector3.transformDirection uses the upper 3x3 -- exactly what we want here since
			// the local-frame registration/deformation math never introduced any non-uniform scale.
			// Panel normals additionally need the same panel-body-local -> chassis-local un-rotation
			// applied to positions above (panelQuat), BEFORE inverseMatrix's rotation -- omitting it
			// would leave panel normals rotated by the panel's ~90deg node offset relative to the mesh.
			for (let i = 0; i < handle.vertexCount; i++) {
				scratchV.set(handle.normals[i * 3], handle.normals[i * 3 + 1], handle.normals[i * 3 + 2]);
				if (panelQuat) scratchV.applyQuaternion(panelQuat);
				scratchV.transformDirection(inverseMatrix);
				normAttr.setXYZ(i, scratchV.x, scratchV.y, scratchV.z);
			}
			normAttr.needsUpdate = true;
		}

		mesh.geometry.computeBoundingSphere();
	}
}

/** Diagnostic (verify-harness eyes-on support): for each binding, the max distance (m) between what
 * the THREE geometry currently renders and what the crumple registry (+ the structural field, when
 * one is passed) says it should render -- the same body-local -> mesh-local conversion
 * syncCarDeformablesToThree() writes. ~0 everywhere proves the sync actually reached the rendered
 * meshes; a large error pinpoints a binding whose geometry is stale/shared/replaced. */
export function checkCarDeformablesSync(bindings: CarDeformableBindings, panels: Record<PanelKey, PanelHandle>, struct: StructuralCrushState | null = null): { id: string; maxErrorM: number }[] {
	const out: { id: string; maxErrorM: number }[] = [];
	const rendered = new THREE.Vector3();
	for (const b of bindings.bindings) {
		const { handle, mesh, inverseMatrix, attachedTo } = b;
		const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
		const localCenter = attachedTo === 'chassis' ? null : panels[attachedTo].localCenter;
		const panelQuat = attachedTo === 'chassis' ? null : PANEL_WORLD_QUAT[attachedTo];
		const sf = struct ? structuralFieldFor(struct, handle) : null;
		const sOff = sf && sf.active && sf.offsets ? sf.offsets : null;
		let maxErrorM = 0;
		for (let i = 0; i < handle.vertexCount; i++) {
			if (sOff) combinedBodyLocal(handle, sOff, i, scratchV);
			else scratchV.set(handle.positions[i * 3], handle.positions[i * 3 + 1], handle.positions[i * 3 + 2]);
			if (localCenter) {
				scratchV.applyQuaternion(panelQuat!);
				scratchV.x += localCenter.x;
				scratchV.y += localCenter.y;
				scratchV.z += localCenter.z;
			}
			scratchV.y += CHASSIS_ORIGIN_HEIGHT_M;
			scratchV.applyMatrix4(inverseMatrix);
			rendered.fromBufferAttribute(posAttr, i);
			const err = rendered.distanceTo(scratchV);
			if (err > maxErrorM) maxErrorM = err;
		}
		out.push({ id: handle.id, maxErrorM });
	}
	return out;
}
