// SPDX-License-Identifier: MIT
//
// Materials for the 'buildings' feature: reuses the shared procedural PBR wood/brick builders
// (../../materials.ts, imported READ-ONLY per the feature's design brief) for studs/planks/bricks, and
// adds two small local flat-color materials (drywall, galvanized pipe) that module doesn't provide --
// no canvas noise needed for these two (a plain matte panel / a plain metal pipe reads fine at the
// sizes these pieces render at, and keeps this feature's own material surface small).

import * as THREE from 'three';
import { buildBrickMaterial, buildWoodMaterial } from '../../materials';

export interface BuildingsMaterialSet {
	wood: THREE.MeshStandardMaterial;
	brick: THREE.MeshStandardMaterial;
	drywall: THREE.MeshStandardMaterial;
	pipe: THREE.MeshStandardMaterial;
}

export function buildBuildingsMaterials(): BuildingsMaterialSet {
	const wood = buildWoodMaterial().material;
	const brick = buildBrickMaterial().material;
	const drywall = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.92, metalness: 0.0 });
	const pipe = new THREE.MeshStandardMaterial({ color: 0x9aa1a6, roughness: 0.35, metalness: 0.85 });
	return { wood, brick, drywall, pipe };
}

export function disposeBuildingsMaterials(materials: BuildingsMaterialSet): void {
	materials.wood.dispose();
	materials.brick.dispose();
	materials.drywall.dispose();
	materials.pipe.dispose();
}
