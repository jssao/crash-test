// SPDX-License-Identifier: MIT
//
// Three.js visuals for the 'buildings' feature: one mesh per piece (box or capsule), using the
// procedural/flat materials from ./materials.ts. Mirrors world/visuals.ts's bridge pattern (renderer-
// free physics <-> THREE), one InterpolatedTransform per piece for render-time blending. Footing
// pieces (static, half-buried foundations) get no mesh -- nothing to see.

import * as THREE from 'three';
import { InterpolatedTransform } from '../../../core/loop';
import { buildBuildingsMaterials, disposeBuildingsMaterials, type BuildingsMaterialSet } from './materials';
import type { Piece, Structure } from './structures';

export interface PieceVisual {
	readonly mesh: THREE.Mesh;
	readonly transform: InterpolatedTransform;
	readonly piece: Piece;
}

export interface BuildingsVisualBundle {
	readonly visuals: PieceVisual[];
	readonly materials: BuildingsMaterialSet;
	readonly group: THREE.Group;
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

	return { visuals, materials, group };
}

/** Call once per fixed physics step, after world.step(). */
export function sampleBuildingsVisuals(bundle: BuildingsVisualBundle): void {
	for (const v of bundle.visuals) {
		const t = v.piece.body.getTransform();
		v.transform.sample(t.position, t.rotation);
	}
}

/** Call once per render frame with the accumulator's interpolation alpha. */
export function applyBuildingsVisuals(bundle: BuildingsVisualBundle, alpha: number): void {
	for (const v of bundle.visuals) v.transform.applyTo(v.mesh, alpha);
}

/** After a reset (structures.ts's resetStructure()), double-sample every transform from the NEW pose
 * so render-time lerp doesn't visibly interpolate from the old (pre-reset) position across one frame
 * (same trick as world/visuals.ts's resnapDestructibleVisuals()). */
export function resnapBuildingsVisuals(bundle: BuildingsVisualBundle): void {
	for (const v of bundle.visuals) {
		const t = v.piece.body.getTransform();
		v.transform.sample(t.position, t.rotation);
		v.transform.sample(t.position, t.rotation);
	}
}

export function disposeBuildingsVisuals(bundle: BuildingsVisualBundle): void {
	for (const v of bundle.visuals) v.mesh.geometry.dispose();
	disposeBuildingsMaterials(bundle.materials);
}
