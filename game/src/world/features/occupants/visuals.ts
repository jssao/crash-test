// SPDX-License-Identifier: MIT
//
// Three.js visuals for one seated ragdoll occupant: one low-poly capsule mesh per limb/torso/pelvis
// part + a sphere for the head (simple, face-less material per the task spec), matched 1:1 to the
// physics capsule dims (tuning.ts's PART_DIMS). Bridges the renderer-free bodies (./physics.ts) to
// THREE the same way game/src/world/visuals.ts bridges the destructible world's bodies, and reuses the
// exact InterpolatedTransform pattern game/src/scene/wheels.ts / game/src/world/visuals.ts already use
// for render-time fixed-step interpolation.

import * as THREE from 'three';
import { InterpolatedTransform } from '../../../core/loop';
import type { Occupant } from './physics';
import { PART_DIMS, PART_KEYS, SHIRT_COLOR_SEED, baseOf, type PartKey, type SeatKey } from './tuning';

const SKIN_COLOR = 0xd8a878;
const PANTS_COLOR = 0x2a2a30;

function colorFor(part: PartKey, seatKey: SeatKey): number {
	const base = baseOf(part);
	if (base === 'head') return SKIN_COLOR;
	if (base === 'torso' || base === 'upperArm' || base === 'forearm') return SHIRT_COLOR_SEED[seatKey];
	return PANTS_COLOR; // pelvis, thigh, shin
}

function geometryFor(part: PartKey): THREE.BufferGeometry {
	const base = baseOf(part);
	const dims = PART_DIMS[base];
	if (base === 'head') return new THREE.SphereGeometry(dims.radius, 12, 8);
	// three.js CapsuleGeometry(radius, length, capSubdivisions, radialSegments) -- `length` is the
	// cylindrical section length (distance between the two hemisphere centers), matching this part's
	// capsule shape's own center1/center2 spacing (2*halfLen) exactly -- see physics.ts's
	// createCapsulePart(). Its long axis is local Y by default, same convention the physics capsule
	// uses (center1=(0,-halfLen,0), center2=(0,halfLen,0)).
	return new THREE.CapsuleGeometry(dims.radius, dims.halfLen * 2, 4, 8);
}

export interface OccupantVisual {
	group: THREE.Group;
	parts: Record<PartKey, { mesh: THREE.Mesh; transform: InterpolatedTransform }>;
}

export function buildOccupantVisual(occupant: Occupant, seatKey: SeatKey): OccupantVisual {
	const group = new THREE.Group();
	group.name = `Occupant_${seatKey}`;

	const materialCache = new Map<number, THREE.MeshStandardMaterial>();
	const materialFor = (color: number) => {
		let mat = materialCache.get(color);
		if (!mat) {
			mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0 });
			materialCache.set(color, mat);
		}
		return mat;
	};

	const parts = {} as Record<PartKey, { mesh: THREE.Mesh; transform: InterpolatedTransform }>;
	for (const key of PART_KEYS) {
		const mesh = new THREE.Mesh(geometryFor(key), materialFor(colorFor(key, seatKey)));
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		const t = occupant.parts[key].body.getTransform();
		mesh.position.set(t.position.x, t.position.y, t.position.z);
		mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
		group.add(mesh);
		const transform = new InterpolatedTransform();
		transform.sample(t.position, t.rotation);
		transform.sample(t.position, t.rotation);
		parts[key] = { mesh, transform };
	}

	return { group, parts };
}

/** Call once per fixed physics step (after physics.ts's pollOccupantRestraint()). */
export function sampleOccupantVisual(occupant: Occupant, visual: OccupantVisual): void {
	for (const key of PART_KEYS) {
		const t = occupant.parts[key].body.getTransform();
		visual.parts[key].transform.sample(t.position, t.rotation);
	}
}

/** Call once per render frame with the accumulator's interpolation alpha. */
export function applyOccupantVisual(visual: OccupantVisual, alpha: number): void {
	for (const key of PART_KEYS) visual.parts[key].transform.applyTo(visual.parts[key].mesh, alpha);
}

export function disposeOccupantVisual(visual: OccupantVisual): void {
	for (const key of PART_KEYS) visual.parts[key].mesh.geometry.dispose();
}
