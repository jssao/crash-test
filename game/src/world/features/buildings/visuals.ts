// SPDX-License-Identifier: MIT
//
// Three.js visuals for the 'buildings' feature: one mesh per piece (box or capsule), using the
// procedural/flat materials from ./materials.ts. Mirrors world/visuals.ts's bridge pattern (renderer-
// free physics <-> THREE), one InterpolatedTransform per piece for render-time blending. Footing
// pieces (static, half-buried foundations) get no mesh -- nothing to see.
//
// FRACTURE (docs/loom/d1-fracture-material-spec.md): a piece that SNAPS into fragments has its body
// destroyed (structures.ts's fracturePiece()); its mesh is hidden (never sampled again -- reading a
// destroyed body is a wasm trap, feature.ts warning #1) and each fragment gets its own box mesh in a
// slightly LIGHTER "splintered" material variant (a cheap deterministic color-lightened clone of the
// parent material -- no CanvasTexture needed, keeps the headless-guard story trivial since this whole
// module is browser-only anyway). Fragment visuals are created by spawnFragmentVisuals() (the feature
// index feeds it each step's PieceFractureEvents), pruned when their fragment despawns, and cleared
// wholesale on reset.

import * as THREE from 'three';
import { InterpolatedTransform } from '../../../core/loop';
import type { FractureFragment } from '../fracture';
import { buildBuildingsMaterials, disposeBuildingsMaterials, type BuildingsMaterialSet } from './materials';
import type { Piece, PieceFractureEvent, Structure } from './structures';

export interface PieceVisual {
	readonly mesh: THREE.Mesh;
	readonly transform: InterpolatedTransform;
	readonly piece: Piece;
}

export interface FragmentVisual {
	readonly mesh: THREE.Mesh;
	readonly transform: InterpolatedTransform;
	readonly fragment: FractureFragment;
}

export interface BuildingsVisualBundle {
	readonly visuals: PieceVisual[];
	readonly materials: BuildingsMaterialSet;
	readonly group: THREE.Group;
	/** Live fracture-fragment meshes (see module doc) -- pruned as fragments despawn/reset. */
	readonly fragmentVisuals: FragmentVisual[];
	/** Lighter "splintered wood / broken gypsum" variants for fragment meshes, cloned lazily from the
	 * base material set (one clone per material, shared by every fragment). */
	readonly splinterMaterials: Map<string, THREE.MeshStandardMaterial>;
}

function materialFor(materials: BuildingsMaterialSet, piece: Piece): THREE.MeshStandardMaterial {
	switch (piece.material) {
		case 'wood':
			return materials.wood;
		case 'drywall':
			return materials.drywall;
		case 'brick':
			return materials.brick;
		case 'pipe':
			return materials.pipe;
	}
}

function geometryFor(piece: Piece): THREE.BufferGeometry {
	if (piece.kind === 'pipe' && piece.capsule) {
		return new THREE.CapsuleGeometry(piece.capsule.radius, piece.capsule.halfLength * 2, 4, 8);
	}
	const half = piece.half!;
	return new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
}

export function buildBuildingsVisuals(structures: readonly Structure[]): BuildingsVisualBundle {
	const materials = buildBuildingsMaterials();
	const group = new THREE.Group();
	group.name = 'Buildings';

	const visuals: PieceVisual[] = [];
	for (const structure of structures) {
		for (const piece of structure.pieces) {
			if (piece.kind === 'footing') continue;
			const geometry = geometryFor(piece);
			const mesh = new THREE.Mesh(geometry, materialFor(materials, piece));
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			const t = piece.body.getTransform();
			mesh.position.set(t.position.x, t.position.y, t.position.z);
			mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
			group.add(mesh);
			const transform = new InterpolatedTransform();
			transform.sample(t.position, t.rotation);
			transform.sample(t.position, t.rotation);
			visuals.push({ mesh, transform, piece });
		}
	}

	return { visuals, materials, group, fragmentVisuals: [], splinterMaterials: new Map() };
}

/** Splintered-end material variant for fragments: the parent material cloned with its color
 * lightened toward exposed raw wood / broken gypsum core -- cheap, deterministic. */
function splinterMaterialFor(bundle: BuildingsVisualBundle, piece: Piece): THREE.MeshStandardMaterial {
	const key = piece.material;
	let mat = bundle.splinterMaterials.get(key);
	if (!mat) {
		mat = materialFor(bundle.materials, piece).clone();
		mat.color = mat.color.clone().lerp(new THREE.Color(0xf2e4c2), 0.4);
		bundle.splinterMaterials.set(key, mat);
	}
	return mat;
}

/** Consumes one step's PieceFractureEvents: hides the snapped parent's mesh and spawns one box mesh
 * per fragment (physics-matched half extents, splintered material variant). */
export function spawnFragmentVisuals(bundle: BuildingsVisualBundle, events: readonly PieceFractureEvent[]): void {
	for (const ev of events) {
		const parent = bundle.visuals.find((v) => v.piece === ev.piece);
		if (parent) parent.mesh.visible = false;
		for (const frag of ev.fragments) {
			if (frag.kind !== 'box' || !frag.halfExtents) continue; // buildings fragments are always boxes
			const geometry = new THREE.BoxGeometry(frag.halfExtents.x * 2, frag.halfExtents.y * 2, frag.halfExtents.z * 2);
			const mesh = new THREE.Mesh(geometry, splinterMaterialFor(bundle, ev.piece));
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			const t = frag.body.getTransform();
			mesh.position.set(t.position.x, t.position.y, t.position.z);
			mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
			bundle.group.add(mesh);
			const transform = new InterpolatedTransform();
			transform.sample(t.position, t.rotation);
			transform.sample(t.position, t.rotation);
			bundle.fragmentVisuals.push({ mesh, transform, fragment: frag });
		}
	}
}

function removeFragmentVisual(bundle: BuildingsVisualBundle, v: FragmentVisual): void {
	bundle.group.remove(v.mesh);
	v.mesh.geometry.dispose(); // material is the shared splinter variant -- disposed at teardown only
}

/** Call once per fixed physics step, after world.step(). Skips FRACTURED pieces (body destroyed --
 * see module doc) and prunes fragment visuals whose fragment has despawned. */
export function sampleBuildingsVisuals(bundle: BuildingsVisualBundle): void {
	for (const v of bundle.visuals) {
		if (v.piece.fractured) continue;
		const t = v.piece.body.getTransform();
		v.transform.sample(t.position, t.rotation);
	}
	for (let i = bundle.fragmentVisuals.length - 1; i >= 0; i--) {
		const v = bundle.fragmentVisuals[i];
		if (v.fragment.despawned) {
			removeFragmentVisual(bundle, v);
			bundle.fragmentVisuals.splice(i, 1);
			continue;
		}
		const t = v.fragment.body.getTransform();
		v.transform.sample(t.position, t.rotation);
	}
}

/** Call once per render frame with the accumulator's interpolation alpha. */
export function applyBuildingsVisuals(bundle: BuildingsVisualBundle, alpha: number): void {
	for (const v of bundle.visuals) {
		if (v.piece.fractured) continue;
		v.transform.applyTo(v.mesh, alpha);
	}
	for (const v of bundle.fragmentVisuals) {
		if (!v.fragment.despawned) v.transform.applyTo(v.mesh, alpha);
	}
}

/** After a reset (structures.ts's resetStructure()), double-sample every transform from the NEW pose
 * so render-time lerp doesn't visibly interpolate from the old (pre-reset) position across one frame
 * (same trick as world/visuals.ts's resnapDestructibleVisuals()). Reset rebuilt every fractured piece,
 * so all parent meshes come back visible and every fragment visual is dropped (the feature index has
 * already destroyed the fragment bodies). */
export function resnapBuildingsVisuals(bundle: BuildingsVisualBundle): void {
	for (const v of bundle.fragmentVisuals) removeFragmentVisual(bundle, v);
	bundle.fragmentVisuals.length = 0;
	for (const v of bundle.visuals) {
		v.mesh.visible = true;
		const t = v.piece.body.getTransform();
		v.transform.sample(t.position, t.rotation);
		v.transform.sample(t.position, t.rotation);
		v.mesh.position.set(t.position.x, t.position.y, t.position.z);
		v.mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	}
}

export function disposeBuildingsVisuals(bundle: BuildingsVisualBundle): void {
	for (const v of bundle.fragmentVisuals) removeFragmentVisual(bundle, v);
	bundle.fragmentVisuals.length = 0;
	for (const mat of bundle.splinterMaterials.values()) mat.dispose();
	for (const v of bundle.visuals) v.mesh.geometry.dispose();
	disposeBuildingsMaterials(bundle.materials);
}
