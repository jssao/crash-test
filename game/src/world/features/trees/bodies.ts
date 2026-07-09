// SPDX-License-Identifier: MIT
//
// Renderer-free physics assembly for the 'trees' world feature: 3 size classes the car can crash
// into. No `three` import anywhere in this file -- shared verbatim by the browser feature (./index.ts)
// and the headless sim test (game/sim/features-trees.test.mjs), same convention as world/bodies.ts.
//
// - Sapling: 1 dynamic capsule trunk, root pinned to a static anchor by a SPHERICAL joint (cone
//   limit + spring bends it under push); a force/torque threshold, polled per-step (same technique
//   as game/src/damage/welds.ts, since box3d joint-break EVENTS only report for awake joints -- see
//   feature.ts's contract doc and tests/joint-break-events.test.ts), snaps the joint at moderate
//   impact -- the freed trunk then topples under its residual angular velocity + gravity.
// - Mid: 1 heavy dynamic trunk, root WELD joint with a HIGH break threshold -- only a fast car fells
//   it, and the (still-simulated, never despawned) fallen trunk is itself a hazard.
// - Large: STATIC trunk (never moves -- the deliberately-immovable anchor) + 2-3 dynamic branches,
//   each welded on with a LOWER break threshold so they snap off dramatically on impact.
//
// Every dynamic body is created, given its shape + joint, then put to sleep (spawn-asleep discipline,
// same as world/bodies.ts) -- a car impact (or a neighboring body waking it via contact) wakes it.

import { Body, BodyType, Shape, SphericalJoint, WeldJoint, World } from '../../../../../src/ts/index.js';
import { quatFromAxisAngle, rotateVector, type Q4, type V3 } from '../../../vehicle/mathUtil';
import {
	FAR_LARGE_SITES,
	FAR_MID_SITES,
	FAR_SAPLING_SITES,
	IDENTITY_Q,
	LARGE_BRANCH_FORCE_THRESHOLD_N,
	LARGE_BRANCH_FRICTION,
	LARGE_BRANCH_LAYOUT,
	LARGE_BRANCH_LENGTH_M,
	LARGE_BRANCH_MASS_KG,
	LARGE_BRANCH_RADIUS_M,
	LARGE_BRANCH_TORQUE_THRESHOLD_NM,
	LARGE_SITES,
	LARGE_TRUNK_FRICTION,
	LARGE_TRUNK_HEIGHT_M,
	LARGE_TRUNK_RADIUS_M,
	LARGE_WELD_ANGULAR_HERTZ,
	LARGE_WELD_DAMPING_RATIO,
	LARGE_WELD_LINEAR_HERTZ,
	MID_FORCE_THRESHOLD_N,
	MID_FRICTION,
	MID_MASS_KG,
	MID_SITES,
	MID_TORQUE_THRESHOLD_NM,
	MID_TRUNK_HEIGHT_M,
	MID_TRUNK_RADIUS_M,
	MID_WELD_ANGULAR_HERTZ,
	MID_WELD_DAMPING_RATIO,
	MID_WELD_LINEAR_HERTZ,
	SAPLING_CONE_LIMIT_RAD,
	SAPLING_FORCE_THRESHOLD_N,
	SAPLING_FRICTION,
	SAPLING_MASS_KG,
	SAPLING_SITES,
	SAPLING_SPRING_DAMPING_RATIO,
	SAPLING_SPRING_HERTZ,
	SAPLING_TORQUE_THRESHOLD_NM,
	SAPLING_TRUNK_HEIGHT_M,
	SAPLING_TRUNK_RADIUS_M,
	type TreeSiteXZ,
} from './tuning';

/** Volume of a capsule (cylinder + 2 hemispherical caps), given the two end-cap centers' separation
 * (NOT the overall length -- the hemispheres add `radius` beyond each center). */
function capsuleVolume(radius: number, capToCapLength: number): number {
	return Math.PI * radius * radius * capToCapLength + (4 / 3) * Math.PI * radius ** 3;
}

/** The spherical joint's cone/twist limits are defined about the joint FRAME's local z-axis (see
 * src/ts/joint.ts's module doc), but a tree trunk's "upright" axis is Y -- this constant rotation
 * (applied to BOTH frameA and frameB) remaps local z to world Y, so "swing away from the frame's
 * z-axis" reads as "the trunk tips away from vertical", exactly like vehicle/mathUtil.ts's
 * WHEEL_FRAME_A_ROTATION/WHEEL_FRAME_B_ROTATION remap a joint's native axis convention elsewhere. */
const UP_TO_JOINT_Z_ROTATION: Q4 = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);

/** World-space unit direction for a branch yaw (degrees, about world +Y) -- see tuning.ts's
 * LARGE_BRANCH_LAYOUT doc comment: direction(yaw) = (cos(yaw), 0, -sin(yaw)). */
function branchDirection(yawDeg: number): V3 {
	const yawQ = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, (yawDeg * Math.PI) / 180);
	return rotateVector(yawQ, { x: 1, y: 0, z: 0 });
}

function branchYawQuat(yawDeg: number): Q4 {
	return quatFromAxisAngle({ x: 0, y: 1, z: 0 }, (yawDeg * Math.PI) / 180);
}

// =================================================================================================
// Sapling
// =================================================================================================

export interface SaplingTree {
	readonly kind: 'sapling';
	readonly id: string;
	readonly spawnPos: V3;
	readonly anchor: Body;
	trunk: Body;
	joint: SphericalJoint | null;
	/** True once the joint has snapped (trunk is a free falling/toppled body thereafter). */
	broken: boolean;
}

function buildSaplingTrunk(world: World, pos: V3): { trunk: Body; shape: Shape } {
	const r = SAPLING_TRUNK_RADIUS_M;
	const capLen = SAPLING_TRUNK_HEIGHT_M - 2 * r;
	const density = SAPLING_MASS_KG / capsuleVolume(r, capLen);
	const trunk = world.createBody({ type: BodyType.Dynamic, position: pos, rotation: IDENTITY_Q });
	const shape = trunk.createCapsuleShape({
		center1: { x: 0, y: r, z: 0 },
		center2: { x: 0, y: SAPLING_TRUNK_HEIGHT_M - r, z: 0 },
		radius: r,
		density,
		friction: SAPLING_FRICTION,
	});
	trunk.applyMassFromShapes();
	return { trunk, shape };
}

function attachSaplingJoint(world: World, anchor: Body, trunk: Body): SphericalJoint {
	const frame = { position: { x: 0, y: 0, z: 0 }, rotation: UP_TO_JOINT_Z_ROTATION };
	return world.createSphericalJoint(anchor, trunk, {
		frameA: frame,
		frameB: frame,
		enableConeLimit: true,
		coneAngle: SAPLING_CONE_LIMIT_RAD,
		enableSpring: true,
		hertz: SAPLING_SPRING_HERTZ,
		dampingRatio: SAPLING_SPRING_DAMPING_RATIO,
	});
}

function buildSapling(world: World, id: string, site: TreeSiteXZ): SaplingTree {
	const pos: V3 = { x: site.x, y: 0, z: site.z };
	const anchor = world.createBody({ type: BodyType.Static, position: pos, rotation: IDENTITY_Q });
	const { trunk } = buildSaplingTrunk(world, pos);
	const joint = attachSaplingJoint(world, anchor, trunk);
	trunk.setAwake(false);
	return { kind: 'sapling', id, spawnPos: pos, anchor, trunk, joint, broken: false };
}

/** Idempotent: if the joint already snapped, destroys the (now free-flying/settled) old trunk and
 * rebuilds a fresh one + joint; otherwise just teleports the intact trunk back (cheaper, matches
 * world/bodies.ts's resetDestructibleWorld() teleport-and-sleep approach). */
function resetSapling(world: World, s: SaplingTree): void {
	if (s.broken || !s.joint) {
		s.trunk.destroy();
		const { trunk } = buildSaplingTrunk(world, s.spawnPos);
		s.trunk = trunk;
		s.joint = attachSaplingJoint(world, s.anchor, trunk);
		s.broken = false;
	} else {
		s.trunk.setTransform(s.spawnPos, IDENTITY_Q);
		s.trunk.setLinearVelocity({ x: 0, y: 0, z: 0 });
		s.trunk.setAngularVelocity({ x: 0, y: 0, z: 0 });
	}
	s.trunk.setAwake(false);
}

/** Polls each intact sapling joint's constraint force/torque and snaps it past threshold -- direct
 * per-step polling (not world.jointEvents(), which only reports for awake joints and would otherwise
 * need extra userData plumbing) -- same technique as game/src/damage/welds.ts. */
function pollSaplingBreaks(saplings: readonly SaplingTree[]): void {
	for (const s of saplings) {
		if (s.broken || !s.joint) continue;
		const f = s.joint.getConstraintForce();
		const forceMag = Math.hypot(f.x, f.y, f.z);
		const t = s.joint.getConstraintTorque();
		const torqueMag = Math.hypot(t.x, t.y, t.z);
		if (forceMag > SAPLING_FORCE_THRESHOLD_N || torqueMag > SAPLING_TORQUE_THRESHOLD_NM) {
			s.joint.destroy();
			s.joint = null;
			s.broken = true;
		}
	}
}

// =================================================================================================
// Mid tree
// =================================================================================================

export interface MidTree {
	readonly kind: 'mid';
	readonly id: string;
	readonly spawnPos: V3;
	readonly anchor: Body;
	trunk: Body;
	joint: WeldJoint | null;
	broken: boolean;
}

function buildMidTrunk(world: World, pos: V3): Body {
	const r = MID_TRUNK_RADIUS_M;
	const capLen = MID_TRUNK_HEIGHT_M - 2 * r;
	const density = MID_MASS_KG / capsuleVolume(r, capLen);
	const trunk = world.createBody({ type: BodyType.Dynamic, position: pos, rotation: IDENTITY_Q });
	trunk.createCapsuleShape({
		center1: { x: 0, y: r, z: 0 },
		center2: { x: 0, y: MID_TRUNK_HEIGHT_M - r, z: 0 },
		radius: r,
		density,
		friction: MID_FRICTION,
	});
	trunk.applyMassFromShapes();
	return trunk;
}

function attachMidJoint(world: World, anchor: Body, trunk: Body): WeldJoint {
	return world.createWeldJoint(anchor, trunk, {
		linearHertz: MID_WELD_LINEAR_HERTZ,
		angularHertz: MID_WELD_ANGULAR_HERTZ,
		linearDampingRatio: MID_WELD_DAMPING_RATIO,
		angularDampingRatio: MID_WELD_DAMPING_RATIO,
	});
}

function buildMid(world: World, id: string, site: TreeSiteXZ): MidTree {
	const pos: V3 = { x: site.x, y: 0, z: site.z };
	const anchor = world.createBody({ type: BodyType.Static, position: pos, rotation: IDENTITY_Q });
	const trunk = buildMidTrunk(world, pos);
	const joint = attachMidJoint(world, anchor, trunk);
	trunk.setAwake(false);
	return { kind: 'mid', id, spawnPos: pos, anchor, trunk, joint, broken: false };
}

function resetMid(world: World, m: MidTree): void {
	if (m.broken || !m.joint) {
		m.trunk.destroy();
		m.trunk = buildMidTrunk(world, m.spawnPos);
		m.joint = attachMidJoint(world, m.anchor, m.trunk);
		m.broken = false;
	} else {
		m.trunk.setTransform(m.spawnPos, IDENTITY_Q);
		m.trunk.setLinearVelocity({ x: 0, y: 0, z: 0 });
		m.trunk.setAngularVelocity({ x: 0, y: 0, z: 0 });
	}
	m.trunk.setAwake(false);
}

function pollMidBreaks(mids: readonly MidTree[]): void {
	for (const m of mids) {
		if (m.broken || !m.joint) continue;
		const f = m.joint.getConstraintForce();
		const forceMag = Math.hypot(f.x, f.y, f.z);
		const t = m.joint.getConstraintTorque();
		const torqueMag = Math.hypot(t.x, t.y, t.z);
		if (forceMag > MID_FORCE_THRESHOLD_N || torqueMag > MID_TORQUE_THRESHOLD_NM) {
			m.joint.destroy();
			m.joint = null;
			m.broken = true;
		}
	}
}

// =================================================================================================
// Large tree (static trunk + welded dynamic branches)
// =================================================================================================

export interface LargeBranch {
	readonly index: number;
	readonly spawnPos: V3;
	readonly spawnRot: Q4;
	body: Body;
	joint: WeldJoint | null;
	broken: boolean;
}

export interface LargeTree {
	readonly kind: 'large';
	readonly id: string;
	readonly spawnPos: V3;
	readonly trunk: Body; // static, never destroyed/moved
	readonly branches: LargeBranch[];
}

function buildBranchBody(world: World, spawnPos: V3, spawnRot: Q4): Body {
	const r = LARGE_BRANCH_RADIUS_M;
	const density = LARGE_BRANCH_MASS_KG / capsuleVolume(r, LARGE_BRANCH_LENGTH_M);
	const body = world.createBody({ type: BodyType.Dynamic, position: spawnPos, rotation: spawnRot });
	body.createCapsuleShape({
		center1: { x: 0, y: 0, z: 0 },
		center2: { x: LARGE_BRANCH_LENGTH_M, y: 0, z: 0 },
		radius: r,
		density,
		friction: LARGE_BRANCH_FRICTION,
	});
	body.applyMassFromShapes();
	return body;
}

function attachBranchJoint(world: World, trunk: Body, branch: Body, trunkLocalAttach: V3, yawDeg: number): WeldJoint {
	return world.createWeldJoint(trunk, branch, {
		frameA: { position: trunkLocalAttach, rotation: branchYawQuat(yawDeg) },
		frameB: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_Q },
		linearHertz: LARGE_WELD_LINEAR_HERTZ,
		angularHertz: LARGE_WELD_ANGULAR_HERTZ,
		linearDampingRatio: LARGE_WELD_DAMPING_RATIO,
		angularDampingRatio: LARGE_WELD_DAMPING_RATIO,
	});
}

function buildLarge(world: World, id: string, site: TreeSiteXZ): LargeTree {
	const pos: V3 = { x: site.x, y: 0, z: site.z };
	const trunk = world.createBody({ type: BodyType.Static, position: pos, rotation: IDENTITY_Q });
	trunk.createCapsuleShape({
		center1: { x: 0, y: LARGE_TRUNK_RADIUS_M, z: 0 },
		center2: { x: 0, y: LARGE_TRUNK_HEIGHT_M - LARGE_TRUNK_RADIUS_M, z: 0 },
		radius: LARGE_TRUNK_RADIUS_M,
		density: 1,
		friction: LARGE_TRUNK_FRICTION,
	});

	const branches: LargeBranch[] = [];
	for (let i = 0; i < LARGE_BRANCH_LAYOUT.length; i++) {
		const { heightM, yawDeg } = LARGE_BRANCH_LAYOUT[i];
		const dir = branchDirection(yawDeg);
		const trunkLocalAttach: V3 = { x: dir.x * LARGE_TRUNK_RADIUS_M, y: heightM, z: dir.z * LARGE_TRUNK_RADIUS_M };
		const spawnPos: V3 = { x: pos.x + trunkLocalAttach.x, y: pos.y + trunkLocalAttach.y, z: pos.z + trunkLocalAttach.z };
		const spawnRot = branchYawQuat(yawDeg);
		const body = buildBranchBody(world, spawnPos, spawnRot);
		const joint = attachBranchJoint(world, trunk, body, trunkLocalAttach, yawDeg);
		body.setAwake(false);
		branches.push({ index: i, spawnPos, spawnRot, body, joint, broken: false });
	}

	return { kind: 'large', id, spawnPos: pos, trunk, branches };
}

function resetLarge(world: World, l: LargeTree): void {
	// Trunk is static and never touched by anything (no joint references it that could break) --
	// nothing to reset there.
	for (const b of l.branches) {
		if (b.broken || !b.joint) {
			b.body.destroy();
			const { heightM, yawDeg } = LARGE_BRANCH_LAYOUT[b.index];
			b.body = buildBranchBody(world, b.spawnPos, b.spawnRot);
			const dir = branchDirection(yawDeg);
			const trunkLocalAttach: V3 = { x: dir.x * LARGE_TRUNK_RADIUS_M, y: heightM, z: dir.z * LARGE_TRUNK_RADIUS_M };
			b.joint = attachBranchJoint(world, l.trunk, b.body, trunkLocalAttach, yawDeg);
			b.broken = false;
		} else {
			b.body.setTransform(b.spawnPos, b.spawnRot);
			b.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
			b.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		}
		b.body.setAwake(false);
	}
}

function pollLargeBreaks(larges: readonly LargeTree[]): void {
	for (const l of larges) {
		for (const b of l.branches) {
			if (b.broken || !b.joint) continue;
			const f = b.joint.getConstraintForce();
			const forceMag = Math.hypot(f.x, f.y, f.z);
			const t = b.joint.getConstraintTorque();
			const torqueMag = Math.hypot(t.x, t.y, t.z);
			if (forceMag > LARGE_BRANCH_FORCE_THRESHOLD_N || torqueMag > LARGE_BRANCH_TORQUE_THRESHOLD_NM) {
				b.joint.destroy();
				b.joint = null;
				b.broken = true;
			}
		}
	}
}

// =================================================================================================
// Whole-feature assembly
// =================================================================================================

export interface TreesWorld {
	readonly saplings: SaplingTree[];
	readonly mids: MidTree[];
	readonly larges: LargeTree[];
}

/** Builds every tree (west-zone slalom + mid/large groves + the sparse far line -- see tuning.ts's
 * doc comment for the exact placement/clearance rationale), all spawned asleep. Deterministic: every
 * site/id is a fixed literal, no Math.random anywhere (feature contract warning #3). */
export function createTreesWorld(world: World): TreesWorld {
	const saplings: SaplingTree[] = [];
	const mids: MidTree[] = [];
	const larges: LargeTree[] = [];

	SAPLING_SITES.forEach((site, i) => saplings.push(buildSapling(world, `sapling-${i}`, site)));
	MID_SITES.forEach((site, i) => mids.push(buildMid(world, `mid-${i}`, site)));
	LARGE_SITES.forEach((site, i) => larges.push(buildLarge(world, `large-${i}`, site)));

	FAR_SAPLING_SITES.forEach((site, i) => saplings.push(buildSapling(world, `far-sapling-${i}`, site)));
	FAR_MID_SITES.forEach((site, i) => mids.push(buildMid(world, `far-mid-${i}`, site)));
	FAR_LARGE_SITES.forEach((site, i) => larges.push(buildLarge(world, `far-large-${i}`, site)));

	return { saplings, mids, larges };
}

/** Call once per fixed step, AFTER world.step() -- polls every intact joint's constraint force/torque
 * and snaps whichever crossed its break threshold this step. */
export function stepTreesWorld(trees: TreesWorld): void {
	pollSaplingBreaks(trees.saplings);
	pollMidBreaks(trees.mids);
	pollLargeBreaks(trees.larges);
}

/** Full world reset (Shift+R): rebuilds any broken tree part fresh, teleports+resleeps every intact
 * one back to its spawn pose -- same idempotent shape as world/bodies.ts's resetDestructibleWorld(),
 * extended to cover the "was this part destroyed by a break?" case those bodies never hit. */
export function resetTreesWorld(world: World, trees: TreesWorld): void {
	for (const s of trees.saplings) resetSapling(world, s);
	for (const m of trees.mids) resetMid(world, m);
	for (const l of trees.larges) resetLarge(world, l);
}

/** Total live physics bodies owned by this feature (anchors + trunks + branches) -- feature
 * contract's "bodyCount() honest". */
export function treesBodyCount(trees: TreesWorld): number {
	let n = 0;
	n += trees.saplings.length * 2; // anchor + trunk
	n += trees.mids.length * 2; // anchor + trunk
	for (const l of trees.larges) n += 1 + l.branches.length; // static trunk + branches
	return n;
}
