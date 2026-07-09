// SPDX-License-Identifier: MIT
//
// Renderer-free helpers shared by every 'buildings' structure builder (./structures.ts): box/capsule
// spawning + a weld-with-thresholds helper that stores enough of a "spec" to destroy-and-recreate the
// joint on reset (see index.ts's reset('world') -- structures never destroy BODIES, only joints, so
// getTransform() is always safe to call on any body this feature owns, per feature.ts's warning #1).

import { Body, BodyType, Shape, World, type Transform } from '../../../../../src/ts/index.js';
import { IDENTITY_Q, rotateVector, sub, type Q4, type V3 } from '../../../vehicle/mathUtil';

export function boxVolume(half: V3): number {
	return 8 * half.x * half.y * half.z;
}

/** Capsule volume: a cylinder of the given radius/length plus a full sphere (the two half-sphere
 * caps) of the same radius. `length` is the straight distance between the two hemisphere centers. */
export function capsuleVolume(radius: number, length: number): number {
	return Math.PI * radius * radius * length + (4 / 3) * Math.PI * radius * radius * radius;
}

function invQuat(q: Q4): Q4 {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** World-space offset -> the equivalent offset expressed in a body's local (unrotated) frame. */
function worldToLocalOffset(bodyRot: Q4, worldOffset: V3): V3 {
	return rotateVector(invQuat(bodyRot), worldOffset);
}

/** Per-body settle damping applied at spawn to every dynamic destructible so freed debris stops
 * pirouetting (playtest issue #1). See tuning.ts's DEBRIS SETTLE DAMPING block. */
export interface SettleDamping {
	readonly angularDamping: number;
	readonly linearDamping: number;
}

export function spawnDynamicBox(
	world: World,
	pos: V3,
	rot: Q4,
	half: V3,
	massKg: number,
	friction: number,
	restitution = 0,
	damping?: SettleDamping,
): { body: Body; shape: Shape } {
	const body = world.createBody({
		type: BodyType.Dynamic,
		position: pos,
		rotation: rot,
		angularDamping: damping?.angularDamping ?? 0,
		linearDamping: damping?.linearDamping ?? 0,
	});
	const density = massKg / boxVolume(half);
	const shape = body.createBoxShape({ halfExtents: half, density, friction, restitution });
	body.applyMassFromShapes();
	return { body, shape };
}

export function spawnStaticBox(world: World, pos: V3, rot: Q4, half: V3, friction = 0.85): { body: Body; shape: Shape } {
	const body = world.createBody({ type: BodyType.Static, position: pos, rotation: rot });
	const shape = body.createBoxShape({ halfExtents: half, density: 1, friction });
	return { body, shape };
}

/** Vertical capsule (local endpoints on the Y axis), body origin at the capsule's own center. */
export function spawnDynamicCapsuleVertical(
	world: World,
	pos: V3,
	halfLength: number,
	radius: number,
	massKg: number,
	friction: number,
	restitution = 0,
	damping?: SettleDamping,
	rollingResistance = 0,
): { body: Body; shape: Shape } {
	const body = world.createBody({
		type: BodyType.Dynamic,
		position: pos,
		rotation: IDENTITY_Q,
		angularDamping: damping?.angularDamping ?? 0,
		linearDamping: damping?.linearDamping ?? 0,
	});
	const density = massKg / capsuleVolume(radius, halfLength * 2);
	const shape = body.createCapsuleShape({
		center1: { x: 0, y: -halfLength, z: 0 },
		center2: { x: 0, y: halfLength, z: 0 },
		radius,
		density,
		friction,
		restitution,
		rollingResistance,
	});
	body.applyMassFromShapes();
	return { body, shape };
}

/** A weld "spec" (bodies + local frames + break thresholds) -- kept around (rather than just the live
 * Joint) so index.ts's reset('world') can destroy a broken joint's remains and recreate it identically
 * without needing to recompute anchor geometry. */
export interface WeldSpec {
	bodyA: Body;
	bodyB: Body;
	frameA: Transform;
	frameB: Transform;
	forceThresholdN: number;
	torqueThresholdNm: number;
}

/** Builds a WeldSpec anchored at `anchorWorld` (a point in world space, e.g. the contact face between
 * the two bodies) and creates the live rigid (max-stiffness) weld joint for it. */
export function weldAt(
	world: World,
	bodyA: Body,
	posA: V3,
	rotA: Q4,
	bodyB: Body,
	posB: V3,
	rotB: Q4,
	anchorWorld: V3,
	forceThresholdN: number,
	torqueThresholdNm: number,
): { joint: ReturnType<World['createWeldJoint']>; spec: WeldSpec } {
	const frameA: Transform = { position: worldToLocalOffset(rotA, sub(anchorWorld, posA)), rotation: IDENTITY_Q };
	const frameB: Transform = { position: worldToLocalOffset(rotB, sub(anchorWorld, posB)), rotation: IDENTITY_Q };
	const spec: WeldSpec = { bodyA, bodyB, frameA, frameB, forceThresholdN, torqueThresholdNm };
	const joint = world.createWeldJoint(bodyA, bodyB, {
		frameA,
		frameB,
		linearHertz: 0,
		angularHertz: 0,
		linearDampingRatio: 1,
		angularDampingRatio: 1,
	});
	joint.setForceThreshold(forceThresholdN);
	joint.setTorqueThreshold(torqueThresholdNm);
	return { joint, spec };
}

/** Recreates a joint from a stored spec (reset('world') path -- see index.ts). */
export function rebuildWeld(world: World, spec: WeldSpec): ReturnType<World['createWeldJoint']> {
	const joint = world.createWeldJoint(spec.bodyA, spec.bodyB, {
		frameA: spec.frameA,
		frameB: spec.frameB,
		linearHertz: 0,
		angularHertz: 0,
		linearDampingRatio: 1,
		angularDampingRatio: 1,
	});
	joint.setForceThreshold(spec.forceThresholdN);
	joint.setTorqueThreshold(spec.torqueThresholdNm);
	return joint;
}
