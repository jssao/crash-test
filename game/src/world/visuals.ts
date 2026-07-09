// SPDX-License-Identifier: MIT
//
// Three.js visuals for the destructible world (G4 spec): one mesh per dynamic body (wallBlock/crate/
// pole = box, barrel = 12-gon cylinder) plus the 2 static ramp meshes, all using the procedural PBR
// materials from ./materials.ts. Bridges the renderer-free physics bodies (./bodies.ts) to THREE the
// same way game/src/scene/carDeformables.ts / panelVisuals.ts bridge the car's own bodies.

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { InterpolatedTransform } from '../core/loop';
import type { DestructibleBody, DestructibleWorld, RampBody } from './bodies';
import { wedgeHullPoints } from './bodies';
import { buildDestructibleMaterials, disposeDestructibleMaterials, type DestructibleMaterialSets } from './materials';

export interface DestructibleVisual {
	readonly mesh: THREE.Mesh;
	readonly transform: InterpolatedTransform;
}

export interface DestructibleVisualBundle {
	/** Aligned 1:1 with DestructibleWorld.bodies. */
	readonly visuals: DestructibleVisual[];
	readonly materials: DestructibleMaterialSets;
	readonly group: THREE.Group;
}

function materialFor(materials: DestructibleMaterialSets, kind: DestructibleBody['material']): THREE.MeshStandardMaterial {
	switch (kind) {
		case 'concrete':
			return materials.concrete.material;
		case 'brick':
			return materials.brick.material;
		case 'wood':
			return materials.wood.material;
		case 'barrelBlue':
			return materials.barrelBlue.material;
		case 'barrelRust':
			return materials.barrelRust.material;
	}
}

function geometryFor(body: DestructibleBody): THREE.BufferGeometry {
	if (body.kind === 'barrel') {
		const r = body.radius!;
		const h = body.height!;
		const sides = body.sides!;
		const geo = new THREE.CylinderGeometry(r, r, h, sides);
		return geo;
	}
	const half = body.halfExtents!;
	return new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2, 1, body.kind === 'wallBlock' ? 1 : 1, 1);
}

/** Builds one mesh + InterpolatedTransform per dynamic destructible body, and the 2 static ramp
 * meshes (added directly to `group`, no per-frame transform needed since ramps never move). Adds
 * everything to a fresh THREE.Group (returned) that the caller adds to the scene once. */
export function buildDestructibleVisuals(world: DestructibleWorld): DestructibleVisualBundle {
	const materials = buildDestructibleMaterials();
	const group = new THREE.Group();
	group.name = 'DestructibleWorld';

	const visuals: DestructibleVisual[] = [];
	for (const body of world.bodies) {
		const geometry = geometryFor(body);
		const mesh = new THREE.Mesh(geometry, materialFor(materials, body.material));
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		const t = body.body.getTransform();
		mesh.position.set(t.position.x, t.position.y, t.position.z);
		mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
		group.add(mesh);
		const transform = new InterpolatedTransform();
		transform.sample(t.position, t.rotation);
		transform.sample(t.position, t.rotation);
		visuals.push({ mesh, transform });
	}

	for (const ramp of world.ramps) {
		group.add(buildRampMesh(ramp, materials));
	}

	return { visuals, materials, group };
}

function buildRampMesh(ramp: RampBody, materials: DestructibleMaterialSets): THREE.Mesh {
	const flat = wedgeHullPoints(ramp.width, ramp.length, ramp.height);
	const points: THREE.Vector3[] = [];
	for (let i = 0; i < flat.length; i += 3) points.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
	const geometry = new ConvexGeometry(points);
	geometry.computeVertexNormals();
	const mesh = new THREE.Mesh(geometry, materials.concrete.material);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	const t = ramp.body.getTransform();
	mesh.position.set(t.position.x, t.position.y, t.position.z);
	mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	return mesh;
}

/** Call once per fixed physics step (samples every dynamic body's CURRENT transform into its
 * InterpolatedTransform for render-time blending -- same pattern as main.ts's per-wheel/per-panel
 * sampling in doFixedStep()). */
export function sampleDestructibleVisuals(world: DestructibleWorld, bundle: DestructibleVisualBundle): void {
	for (let i = 0; i < world.bodies.length; i++) {
		const t = world.bodies[i].body.getTransform();
		bundle.visuals[i].transform.sample(t.position, t.rotation);
	}
}

/** Call once per render frame with the accumulator's interpolation alpha. */
export function applyDestructibleVisuals(bundle: DestructibleVisualBundle, alpha: number): void {
	for (const v of bundle.visuals) v.transform.applyTo(v.mesh, alpha);
}

/** After a teleport-reset (Shift+R, see world/bodies.ts's resetDestructibleWorld()), double-sample
 * every transform from the NEW pose so the render-time lerp doesn't visibly interpolate from the old
 * position to the new one across a single frame (same trick as main.ts's doReset()). */
export function resnapDestructibleVisuals(world: DestructibleWorld, bundle: DestructibleVisualBundle): void {
	for (let i = 0; i < world.bodies.length; i++) {
		const t = world.bodies[i].body.getTransform();
		bundle.visuals[i].transform.sample(t.position, t.rotation);
		bundle.visuals[i].transform.sample(t.position, t.rotation);
	}
}

export function disposeDestructibleVisuals(bundle: DestructibleVisualBundle): void {
	for (const v of bundle.visuals) v.mesh.geometry.dispose();
	for (const child of bundle.group.children) {
		const mesh = child as THREE.Mesh;
		if (mesh.isMesh) mesh.geometry.dispose();
	}
	disposeDestructibleMaterials(bundle.materials);
}
