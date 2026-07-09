// SPDX-License-Identifier: MIT
//
// Detaches the 4 wheel node groups (WheelFrontL/R, WheelRearL/R -- each already carries its rim/
// brake-pad/brake-disc children per car-map.ts) from the loaded car hierarchy and re-parents them
// directly under the scene, so each can be driven independently from its own physics wheel body's
// transform every frame instead of riding the chassis's single transform.

import * as THREE from 'three';
import { CAR_MAP } from '../assets/car-map';
import type { WheelKey } from '../vehicle/vehicle';
import { InterpolatedTransform } from '../core/loop';

const WHEEL_NODE_NAMES: Record<WheelKey, string> = {
	fl: CAR_MAP.wheels.frontLeft.node,
	fr: CAR_MAP.wheels.frontRight.node,
	rl: CAR_MAP.wheels.rearLeft.node,
	rr: CAR_MAP.wheels.rearRight.node,
};

/** The steered (front) wheels. Their authored GLB pose has the wheels TURNED (~30 deg -- the
 * CarConcept model is posed as a show car with cocked front wheels), so their preserved
 * `initialWorldQuat` bakes in a steering yaw that would leave them permanently cocked even at zero
 * physics steer. neutralizeSteerYaw() below removes that baked heading for these wheels only. */
const STEERED_WHEELS: ReadonlySet<WheelKey> = new Set<WheelKey>(['fl', 'fr']);

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Removes the yaw-about-world-up (steering heading) component from a wheel's authored orientation via
 * a swing/twist split about world up, keeping the swing (camber/roll/spin-phase) and discarding the
 * twist (heading). At spawn the chassis is upright so world up IS the steer axis -- so this leaves the
 * front wheels pointing straight ahead, matching the (already-straight) rear wheels, and the physics
 * steering delta then rotates them from that neutral pose. Returns a new quaternion.
 */
function neutralizeSteerYaw(q: THREE.Quaternion): THREE.Quaternion {
	// twist = the rotation about world up embedded in q (project onto the up axis, normalize).
	const twist = new THREE.Quaternion(0, q.y * WORLD_UP.y, 0, q.w);
	const len = Math.hypot(twist.y, twist.w);
	if (len < 1e-8) return q.clone(); // q is a 180deg flip perpendicular to up; nothing to remove
	twist.set(0, twist.y / len, 0, twist.w / len);
	// q = swing * twist  =>  swing = q * twist^-1  (twist applied first, then swing).
	return q.clone().multiply(twist.invert());
}

export interface WheelVisual {
	object: THREE.Object3D;
	transform: InterpolatedTransform;
	/**
	 * The wheel mesh's own authored world orientation at load time, preserved so we apply the
	 * physics body's rotation as a DELTA on top of it rather than replacing it outright -- this way
	 * whatever local orientation convention the GLB authored the wheel node with (which this project
	 * has no independent way to verify without opening the asset in a DCC tool) survives, and only
	 * the physics-driven spin/steer rotation gets added on top of it. See mathUtil.ts's wheel-joint
	 * frame doc comments for the physics-side convention this is layered onto.
	 */
	initialWorldQuat: THREE.Quaternion;
}

/** Finds each wheel group node by name (car-map.ts), detaches it from the car hierarchy, and
 * re-parents it under `scene` directly, preserving its current world transform at detach time. */
export function detachWheelVisuals(carRoot: THREE.Object3D, scene: THREE.Scene): Record<WheelKey, WheelVisual> {
	const result = {} as Record<WheelKey, WheelVisual>;
	for (const key of Object.keys(WHEEL_NODE_NAMES) as WheelKey[]) {
		const nodeName = WHEEL_NODE_NAMES[key];
		const object = carRoot.getObjectByName(nodeName);
		if (!object) {
			console.warn(`[wheels] expected wheel node "${nodeName}" not found in loaded car scene`);
			continue;
		}
		const worldPos = new THREE.Vector3();
		const worldQuat = new THREE.Quaternion();
		const worldScale = new THREE.Vector3();
		object.updateWorldMatrix(true, false);
		object.matrixWorld.decompose(worldPos, worldQuat, worldScale);

		// Front (steered) wheels are authored turned; strip that baked heading so they sit straight at
		// zero physics steer (rear wheels are already straight, so they pass through unchanged).
		const baseQuat = STEERED_WHEELS.has(key) ? neutralizeSteerYaw(worldQuat) : worldQuat.clone();

		scene.attach(object); // re-parents while preserving world transform
		object.position.copy(worldPos);
		object.quaternion.copy(baseQuat);
		object.scale.copy(worldScale);

		result[key] = { object, transform: new InterpolatedTransform(), initialWorldQuat: baseQuat.clone() };
	}
	return result;
}

const scratchDelta = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

/** Applies one wheel visual's interpolated physics transform (position direct, rotation as a delta
 * on top of its preserved authored orientation) for the current render frame. */
export function applyWheelVisual(visual: WheelVisual, spawnBodyQuat: THREE.Quaternion, alpha: number): void {
	visual.transform.lerpPosition(scratchPos, alpha);
	visual.transform.lerpQuaternion(scratchQuat, alpha);
	// delta = currentBodyQuat * inverse(spawnBodyQuat) -- the rotation the physics body has
	// undergone since spawn, expressed in world space, then applied on top of the mesh's original
	// (authored) world orientation.
	scratchDelta.copy(spawnBodyQuat).invert();
	scratchDelta.premultiply(scratchQuat);
	visual.object.position.copy(scratchPos);
	visual.object.quaternion.copy(scratchDelta).multiply(visual.initialWorldQuat);
}
