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
import { dot, LOCAL_UP, quatFromAxisAngle, rotateVector, type Q4, type V3 } from '../../../vehicle/mathUtil';
import {
	fractureCapsuleTrunk,
	fractureSeed,
	MID_TRUNK_FRACTURE,
	tryConsumeFractureBudget,
	type FractureBudget,
	type FractureFragment,
	type FractureIdAllocator,
} from '../fracture';
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
	LARGE_TRUNK_MASS_KG,
	LARGE_TRUNK_RADIUS_M,
	LARGE_TRUNK_WELD_ANGULAR_HERTZ,
	LARGE_TRUNK_WELD_DAMPING_RATIO,
	LARGE_TRUNK_WELD_LINEAR_HERTZ,
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
// Entity ids + fracture (docs/loom/d1-fracture-material-spec.md). Every dynamic tree member gets a
// deterministic entity id (Body.setUserData) so its mass can live in the damage system's foreign-mass
// registry (spec §E: a 9kg sapling must not damage the car like a wall). Range map in
// world/tuning.ts's LEGACY_DESTRUCTIBLE_ENTITY_ID_BASE doc: trees own 46,000,000+.
// =================================================================================================

export const TREES_MEMBER_ENTITY_ID_BASE = 46_000_000;

const SAPLING_ID_OFFSET = 0;
const MID_ID_OFFSET = 1000;
const BRANCH_ID_OFFSET = 2000;

/** Large-tree trunk id, offset from that tree's `entityIdBase` -- createTreesWorld() spaces each
 * large tree's branch ids `entityIdBase + i*10` apart (branches occupy +0..+2, see LARGE_BRANCH_LAYOUT),
 * so +9 sits inside that same per-tree decade, clear of every branch AND the next large tree's base. */
const LARGE_TRUNK_ID_SUBOFFSET = 9;

/** Fracture wiring for stepTreesWorld() -- opt-in (the browser feature passes one; legacy sim tests
 * that call stepTreesWorld(trees) bare keep the old whole-trunk fell behavior byte-identical). */
export interface TreesFractureContext {
	world: World;
	/** Per-step fracture budget (<=1 event/step, spec §D) -- the CALLER resets it each fixed step. */
	budget: FractureBudget;
	idAllocator: FractureIdAllocator;
}

/** Nominal stump fraction for a mid-trunk snap (spec §C: break plane at base-third, stump ~30% of
 * trunk length; fracture.ts jitters it deterministically per member). */
const MID_STUMP_FRACTION = 0.3;
/** Release caps for the flying trunk piece -- a 200kg+ log should tumble, not rocket (same
 * impulse-proportional-release philosophy as buildings' clampDebrisVelocity). */
const MID_FRAGMENT_SPEED_CAP_MS = 12;
const MID_FRAGMENT_SPIN_CAP_RAD = 8;

// P015 fix: a sapling that breaks well past its own threshold SNAPS in half (stump + flyer, same
// fractureCapsuleTrunk() used by the mid tree) instead of the whole trunk popping free at the root --
// a soft/marginal break (barely over threshold) still topples whole, unchanged, since a light shove
// realistically pulls a sapling's shallow root out rather than snapping green wood.
/** How far OVER the break threshold (force or torque, whichever tripped it) counts as a "hard" break
 * that snaps the trunk in half -- 1.4 = 40% over threshold, per this task's brief. */
const SAPLING_FRACTURE_OVER_RATIO = 1.4;
/** Snap point: a thin sapling reads more convincingly snapping roughly a THIRD of the way up (close to
 * where a real green sapling actually splinters under a car hit) than at the mid tree's own base-third
 * convention -- same nominal-fraction-plus-jitter mechanism (fractureCapsuleTrunk jitters +/-10%). */
const SAPLING_STUMP_FRACTION = 0.35;
/** Release caps for the flying half -- a 9kg sapling section is light; let it tumble a bit livelier
 * than the much heavier mid-tree log, still bounded (impulse-proportional-release philosophy). */
const SAPLING_FRAGMENT_SPEED_CAP_MS = 9;
const SAPLING_FRAGMENT_SPIN_CAP_RAD = 10;

// =================================================================================================
// Sapling
// =================================================================================================

export interface SaplingTree {
	readonly kind: 'sapling';
	readonly id: string;
	readonly entityId: number;
	readonly spawnPos: V3;
	readonly anchor: Body;
	/** The standing trunk until a break; after a FRACTURE (P015) this is re-pointed at the flying top
	 * piece -- same convention as MidTree.trunk (see that field's doc comment). */
	trunk: Body;
	joint: SphericalJoint | null;
	/** True once the joint has snapped (trunk is a free falling/toppled body thereafter). */
	broken: boolean;
	/** True once the trunk SNAPPED into stump + flyer (P015 -- "over ~40% break energy") rather than
	 * toppling whole. */
	fractured: boolean;
	stump: { frag: FractureFragment; joint: WeldJoint } | null;
	flyerFrag: FractureFragment | null;
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

function buildSapling(world: World, id: string, entityId: number, site: TreeSiteXZ): SaplingTree {
	const pos: V3 = { x: site.x, y: 0, z: site.z };
	const anchor = world.createBody({ type: BodyType.Static, position: pos, rotation: IDENTITY_Q });
	const { trunk } = buildSaplingTrunk(world, pos);
	trunk.setUserData(entityId);
	const joint = attachSaplingJoint(world, anchor, trunk);
	trunk.setAwake(false);
	return { kind: 'sapling', id, entityId, spawnPos: pos, anchor, trunk, joint, broken: false, fractured: false, stump: null, flyerFrag: null };
}

/** Idempotent: if the joint already snapped, destroys the (now free-flying/settled) old trunk and
 * rebuilds a fresh one + joint; otherwise just teleports the intact trunk back (cheaper, matches
 * world/bodies.ts's resetDestructibleWorld() teleport-and-sleep approach). Mirrors resetMid()'s 3-way
 * shape (fractured / broken-whole / intact) for the P015 sapling-snap case. */
function resetSapling(world: World, s: SaplingTree, massRegistry: Map<number, number> | null): void {
	if (s.fractured && s.stump && s.flyerFrag) {
		s.stump.joint.destroy();
		s.stump.frag.shape.destroy(false);
		s.stump.frag.body.destroy();
		s.flyerFrag.shape.destroy(false);
		s.flyerFrag.body.destroy(); // this IS s.trunk (re-pointed at fracture time)
		massRegistry?.delete(s.stump.frag.entityId);
		massRegistry?.delete(s.flyerFrag.entityId);
		massRegistry?.set(s.entityId, SAPLING_MASS_KG);
		s.stump = null;
		s.flyerFrag = null;
		s.fractured = false;
		const { trunk } = buildSaplingTrunk(world, s.spawnPos);
		trunk.setUserData(s.entityId);
		s.trunk = trunk;
		s.joint = attachSaplingJoint(world, s.anchor, trunk);
		s.broken = false;
	} else if (s.broken || !s.joint) {
		s.trunk.destroy();
		const { trunk } = buildSaplingTrunk(world, s.spawnPos);
		trunk.setUserData(s.entityId); // re-tag: fresh body, same deterministic member id (spec §E)
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

/** SNAPS a sapling trunk (P015) at its (jittered) roughly-a-third point -- same fractureCapsuleTrunk()
 * machinery as fractureMid() (this file), just with the sapling's own dimensions/mass/thresholds. Only
 * called for a "hard" break (SAPLING_FRACTURE_OVER_RATIO over threshold, see pollSaplingBreaks) --
 * anything short of that still fells the whole trunk, unchanged. */
function fractureSapling(s: SaplingTree, forceMag: number, ctx: TreesFractureContext, massRegistry: Map<number, number> | null): void {
	s.joint!.destroy();
	s.joint = null;
	s.broken = true;

	const t = s.trunk.getTransform();
	const lv = s.trunk.getLinearVelocity();
	const av = s.trunk.getAngularVelocity();
	s.trunk.destroy();
	massRegistry?.delete(s.entityId);

	const { stump, flyer } = fractureCapsuleTrunk({
		world: ctx.world,
		position: t.position,
		rotation: t.rotation,
		linearVelocity: lv,
		angularVelocity: av,
		radius: SAPLING_TRUNK_RADIUS_M,
		fullHeight: SAPLING_TRUNK_HEIGHT_M,
		massKg: SAPLING_MASS_KG,
		friction: SAPLING_FRICTION,
		stumpFraction: SAPLING_STUMP_FRACTION,
		forceMag,
		threshold: { forceN: SAPLING_FORCE_THRESHOLD_N, torqueNm: SAPLING_TORQUE_THRESHOLD_NM },
		seed: fractureSeed(s.entityId),
		timeSec: 0, // tree debris never despawns (existing "stays a live hazard" convention)
		idAllocator: ctx.idAllocator,
		breakSpeedCapMs: SAPLING_FRAGMENT_SPEED_CAP_MS,
		breakSpinCapRad: SAPLING_FRAGMENT_SPIN_CAP_RAD,
	});
	// Rigid stump weld (same "snapped off at the base" convention as fractureMid()).
	const stumpJoint = ctx.world.createWeldJoint(s.anchor, stump.body, {
		linearHertz: 0,
		angularHertz: 0,
		linearDampingRatio: 1,
		angularDampingRatio: 1,
	});
	s.stump = { frag: stump, joint: stumpJoint };
	s.flyerFrag = flyer;
	s.trunk = flyer.body;
	s.fractured = true;
	massRegistry?.set(stump.entityId, stump.massKg);
	massRegistry?.set(flyer.entityId, flyer.massKg);
}

/** Polls each intact sapling joint's constraint force/torque and snaps it past threshold -- direct
 * per-step polling (not world.jointEvents(), which only reports for awake joints and would otherwise
 * need extra userData plumbing) -- same technique as game/src/damage/welds.ts. P015: a "hard" break
 * (SAPLING_FRACTURE_OVER_RATIO over threshold) SNAPS the trunk in half when a fracture context is
 * provided; a marginal break, or no fracture context (legacy sim tests), fells the whole trunk exactly
 * as before. */
function pollSaplingBreaks(saplings: readonly SaplingTree[], fracture: TreesFractureContext | undefined, massRegistry: Map<number, number> | null): void {
	for (const s of saplings) {
		if (s.broken || !s.joint) continue;
		const f = s.joint.getConstraintForce();
		const forceMag = Math.hypot(f.x, f.y, f.z);
		const t = s.joint.getConstraintTorque();
		const torqueMag = Math.hypot(t.x, t.y, t.z);
		const overRatio = Math.max(forceMag / SAPLING_FORCE_THRESHOLD_N, torqueMag / SAPLING_TORQUE_THRESHOLD_NM);
		if (overRatio > 1) {
			if (overRatio > SAPLING_FRACTURE_OVER_RATIO && fracture && tryConsumeFractureBudget(fracture.budget)) {
				fractureSapling(s, forceMag, fracture, massRegistry);
			} else {
				s.joint.destroy();
				s.joint = null;
				s.broken = true;
			}
		}
	}
}

// =================================================================================================
// Mid tree
// =================================================================================================

export interface MidTree {
	readonly kind: 'mid';
	readonly id: string;
	readonly entityId: number;
	readonly spawnPos: V3;
	readonly anchor: Body;
	/** The standing trunk until a break; after a FRACTURE this is re-pointed at the flying top piece
	 * (so every existing reader -- visuals, tilt reporting, finite checks -- keeps working unchanged). */
	trunk: Body;
	joint: WeldJoint | null;
	broken: boolean;
	/** True once the trunk SNAPPED into stump + flyer (fracture spec §C) rather than felling whole. */
	fractured: boolean;
	/** The base stump fragment (welded to the anchor -- "the car snapped it off at the base") and the
	 * flying top fragment (whose body `trunk` above aliases); null until fractured. */
	stump: { frag: FractureFragment; joint: WeldJoint } | null;
	flyerFrag: FractureFragment | null;
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

function buildMid(world: World, id: string, entityId: number, site: TreeSiteXZ): MidTree {
	const pos: V3 = { x: site.x, y: 0, z: site.z };
	const anchor = world.createBody({ type: BodyType.Static, position: pos, rotation: IDENTITY_Q });
	const trunk = buildMidTrunk(world, pos);
	trunk.setUserData(entityId);
	const joint = attachMidJoint(world, anchor, trunk);
	trunk.setAwake(false);
	return { kind: 'mid', id, entityId, spawnPos: pos, anchor, trunk, joint, broken: false, fractured: false, stump: null, flyerFrag: null };
}

function resetMid(world: World, m: MidTree, massRegistry: Map<number, number> | null): void {
	if (m.fractured && m.stump && m.flyerFrag) {
		// Fractured: tear down BOTH fragments (joint first -- never leave a live joint referencing a
		// soon-to-be-destroyed body, fracture.ts's safety invariant), then rebuild pristine below.
		m.stump.joint.destroy();
		m.stump.frag.shape.destroy(false);
		m.stump.frag.body.destroy();
		m.flyerFrag.shape.destroy(false);
		m.flyerFrag.body.destroy(); // this IS m.trunk (re-pointed at fracture time)
		massRegistry?.delete(m.stump.frag.entityId);
		massRegistry?.delete(m.flyerFrag.entityId);
		massRegistry?.set(m.entityId, MID_MASS_KG);
		m.stump = null;
		m.flyerFrag = null;
		m.fractured = false;
		m.trunk = buildMidTrunk(world, m.spawnPos);
		m.trunk.setUserData(m.entityId);
		m.joint = attachMidJoint(world, m.anchor, m.trunk);
		m.broken = false;
	} else if (m.broken || !m.joint) {
		m.trunk.destroy();
		m.trunk = buildMidTrunk(world, m.spawnPos);
		m.trunk.setUserData(m.entityId);
		m.joint = attachMidJoint(world, m.anchor, m.trunk);
		m.broken = false;
	} else {
		m.trunk.setTransform(m.spawnPos, IDENTITY_Q);
		m.trunk.setLinearVelocity({ x: 0, y: 0, z: 0 });
		m.trunk.setAngularVelocity({ x: 0, y: 0, z: 0 });
	}
	m.trunk.setAwake(false);
}

/** SNAPS a mid trunk at its (jittered) base-third: destroys the root weld + the intact trunk body,
 * spawns a stump fragment (welded rigidly back onto the anchor -- reads as "snapped off at the base";
 * it never re-fractures, spec §D's no-re-fracture rule) + a flying top fragment, and re-points
 * m.trunk at the flyer so every downstream reader (visuals/tilt/tests) follows the falling piece.
 * The mid trunk IS the fracture spec's anchor member, so its fracture threshold is numerically the
 * existing fell threshold -- above it the trunk now snaps instead of toppling whole. */
function fractureMid(m: MidTree, forceMag: number, ctx: TreesFractureContext, massRegistry: Map<number, number> | null): void {
	m.joint!.destroy();
	m.joint = null;
	m.broken = true;

	const t = m.trunk.getTransform();
	const lv = m.trunk.getLinearVelocity();
	const av = m.trunk.getAngularVelocity();
	m.trunk.destroy(); // same body-only destroy convention as resetMid (shape freed natively with it)
	massRegistry?.delete(m.entityId);

	const { stump, flyer } = fractureCapsuleTrunk({
		world: ctx.world,
		position: t.position,
		rotation: t.rotation,
		linearVelocity: lv,
		angularVelocity: av,
		radius: MID_TRUNK_RADIUS_M,
		fullHeight: MID_TRUNK_HEIGHT_M,
		massKg: MID_MASS_KG,
		friction: MID_FRICTION,
		stumpFraction: MID_STUMP_FRACTION,
		forceMag,
		threshold: MID_TRUNK_FRACTURE,
		seed: fractureSeed(m.entityId),
		timeSec: 0, // tree debris never despawns (existing "stays a live hazard" convention)
		idAllocator: ctx.idAllocator,
		breakSpeedCapMs: MID_FRAGMENT_SPEED_CAP_MS,
		breakSpinCapRad: MID_FRAGMENT_SPIN_CAP_RAD,
	});
	// Rigid stump weld (default identity frames: anchor origin == trunk-base origin at spawn; any
	// small lean-offset at the break instant is pulled back over one solve -- sub-cm, reads fine).
	const stumpJoint = ctx.world.createWeldJoint(m.anchor, stump.body, {
		linearHertz: 0,
		angularHertz: 0,
		linearDampingRatio: 1,
		angularDampingRatio: 1,
	});
	m.stump = { frag: stump, joint: stumpJoint };
	m.flyerFrag = flyer;
	m.trunk = flyer.body;
	m.fractured = true;
	massRegistry?.set(stump.entityId, stump.massKg);
	massRegistry?.set(flyer.entityId, flyer.massKg);
}

/** The root weld is angularly compliant (tuning.ts's MID_WELD_ANGULAR_HERTZ) so the trunk leans/creaks
 * under load; past the fell threshold it now SNAPS at the base-third (fractureMid above) when a
 * fracture context is provided, else fells whole (destroys the weld only -- the legacy behavior every
 * pre-fracture sim test still exercises). Same per-step polling technique as damage/welds.ts (NOT
 * world.jointEvents()). */
function pollMidBreaks(mids: readonly MidTree[], fracture: TreesFractureContext | undefined, massRegistry: Map<number, number> | null): void {
	for (const m of mids) {
		if (m.broken || !m.joint) continue;
		const f = m.joint.getConstraintForce();
		const forceMag = Math.hypot(f.x, f.y, f.z);
		const t = m.joint.getConstraintTorque();
		const torqueMag = Math.hypot(t.x, t.y, t.z);
		if (forceMag > MID_FORCE_THRESHOLD_N || torqueMag > MID_TORQUE_THRESHOLD_NM) {
			if (fracture && tryConsumeFractureBudget(fracture.budget)) {
				fractureMid(m, forceMag, fracture, massRegistry);
			} else {
				m.joint.destroy();
				m.joint = null;
				m.broken = true;
			}
		}
	}
}

// =================================================================================================
// Large tree (static trunk + welded dynamic branches)
// =================================================================================================

export interface LargeBranch {
	readonly index: number;
	readonly entityId: number;
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
	/** Static ground anchor the (now dynamic) trunk is welded to -- same anchor/trunk split as
	 * sapling/mid, added by the P002 fix (see tuning.ts's LARGE_TRUNK_WELD_* doc comment). */
	readonly anchor: Body;
	/** DYNAMIC (P002 fix -- was BodyType.Static): a very-stiff root weld to `anchor` gives it real,
	 * registered mass (massAwareDamageFactor) and a hairline of lean under a severe hit, while reading
	 * and driving exactly like the old immovable trunk for every existing consumer (visuals, tilt,
	 * tests) -- see tuning.ts's doc comment. Never destroyed/rebuilt (no break threshold at all: this
	 * class only ever loses branches, never the trunk itself). */
	readonly trunk: Body;
	readonly trunkEntityId: number;
	/** Never polled for a break -- see tuning.ts's LARGE_TRUNK_WELD_* doc comment ("no break threshold
	 * at all"). Kept on the record purely so destroySingleTree/teardown paths have a handle if ever
	 * needed; box3d frees it automatically when `trunk` (or `anchor`) is destroyed. */
	readonly trunkJoint: WeldJoint;
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

/** P002 fix: the trunk capsule is now DYNAMIC (was created directly as the static body) -- built the
 * same way every other tree class's trunk is (capsule sized from a target mass), then welded to a
 * separate static anchor below. */
function buildLargeTrunk(world: World, pos: V3): Body {
	const r = LARGE_TRUNK_RADIUS_M;
	const capLen = LARGE_TRUNK_HEIGHT_M - 2 * r;
	const density = LARGE_TRUNK_MASS_KG / capsuleVolume(r, capLen);
	const trunk = world.createBody({ type: BodyType.Dynamic, position: pos, rotation: IDENTITY_Q });
	trunk.createCapsuleShape({
		center1: { x: 0, y: r, z: 0 },
		center2: { x: 0, y: LARGE_TRUNK_HEIGHT_M - r, z: 0 },
		radius: r,
		density,
		friction: LARGE_TRUNK_FRICTION,
	});
	trunk.applyMassFromShapes();
	return trunk;
}

/** Very-stiff root weld (tuning.ts's LARGE_TRUNK_WELD_* doc comment) -- default identity frames (anchor
 * and trunk share the spawn origin, exactly like the mid tree's own root weld). */
function attachLargeTrunkJoint(world: World, anchor: Body, trunk: Body): WeldJoint {
	return world.createWeldJoint(anchor, trunk, {
		linearHertz: LARGE_TRUNK_WELD_LINEAR_HERTZ,
		angularHertz: LARGE_TRUNK_WELD_ANGULAR_HERTZ,
		linearDampingRatio: LARGE_TRUNK_WELD_DAMPING_RATIO,
		angularDampingRatio: LARGE_TRUNK_WELD_DAMPING_RATIO,
	});
}

function buildLarge(world: World, id: string, entityIdBase: number, site: TreeSiteXZ): LargeTree {
	const pos: V3 = { x: site.x, y: 0, z: site.z };
	const anchor = world.createBody({ type: BodyType.Static, position: pos, rotation: IDENTITY_Q });
	const trunk = buildLargeTrunk(world, pos);
	const trunkEntityId = entityIdBase + LARGE_TRUNK_ID_SUBOFFSET;
	trunk.setUserData(trunkEntityId);
	const trunkJoint = attachLargeTrunkJoint(world, anchor, trunk);
	trunk.setAwake(false);

	const branches: LargeBranch[] = [];
	for (let i = 0; i < LARGE_BRANCH_LAYOUT.length; i++) {
		const { heightM, yawDeg } = LARGE_BRANCH_LAYOUT[i];
		const dir = branchDirection(yawDeg);
		const trunkLocalAttach: V3 = { x: dir.x * LARGE_TRUNK_RADIUS_M, y: heightM, z: dir.z * LARGE_TRUNK_RADIUS_M };
		const spawnPos: V3 = { x: pos.x + trunkLocalAttach.x, y: pos.y + trunkLocalAttach.y, z: pos.z + trunkLocalAttach.z };
		const spawnRot = branchYawQuat(yawDeg);
		const body = buildBranchBody(world, spawnPos, spawnRot);
		const entityId = entityIdBase + i;
		body.setUserData(entityId);
		const joint = attachBranchJoint(world, trunk, body, trunkLocalAttach, yawDeg);
		body.setAwake(false);
		branches.push({ index: i, entityId, spawnPos, spawnRot, body, joint, broken: false });
	}

	return { kind: 'large', id, spawnPos: pos, anchor, trunk, trunkEntityId, trunkJoint, branches };
}

function resetLarge(world: World, l: LargeTree): void {
	// Trunk never breaks (no break threshold at all -- tuning.ts's LARGE_TRUNK_WELD_* doc comment), so
	// -- like an intact sapling/mid trunk -- a reset is just a teleport+resleep, never a rebuild.
	l.trunk.setTransform(l.spawnPos, IDENTITY_Q);
	l.trunk.setLinearVelocity({ x: 0, y: 0, z: 0 });
	l.trunk.setAngularVelocity({ x: 0, y: 0, z: 0 });
	l.trunk.setAwake(false);
	for (const b of l.branches) {
		if (b.broken || !b.joint) {
			b.body.destroy();
			const { heightM, yawDeg } = LARGE_BRANCH_LAYOUT[b.index];
			b.body = buildBranchBody(world, b.spawnPos, b.spawnRot);
			b.body.setUserData(b.entityId); // re-tag: fresh body, same deterministic member id (spec §E)
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

/** Branch welds are angularly compliant (tuning.ts's LARGE_WELD_ANGULAR_HERTZ) so a branch bends/
 * droops under load, then snaps off once force/torque crosses the threshold. Same per-step polling as
 * damage/welds.ts. */
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
// Bend/droop reporting (destruction-feel): the compliant welds let an unbroken trunk/branch sit
// visibly deflected; these read that deflection off the LIVE rotations (honest -- no separate stored
// flag to drift out of sync) for the feature snapshot + destruction-feel.test.mjs assertions.
// =================================================================================================

/** Degrees a trunk has tipped away from vertical. */
export function trunkTiltDeg(body: Body): number {
	const up = rotateVector(body.getRotation(), LOCAL_UP);
	const c = Math.max(-1, Math.min(1, dot(up, { x: 0, y: 1, z: 0 })));
	return (Math.acos(c) * 180) / Math.PI;
}

/** Angle (degrees) of the relative rotation between two quaternions -- how far a branch has swung from
 * its spawn pose. Only the scalar part of a*b^-1 is needed for the angle. */
function quatAngleDeg(a: Q4, b: Q4): number {
	const w = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z; // scalar part of a * conj(b)
	return (2 * Math.acos(Math.min(1, Math.abs(w))) * 180) / Math.PI;
}

/** A mid trunk counts as "leaning" once its compliant root weld has tipped it past this, while still
 * attached (unfelled). */
export const MID_LEAN_REPORT_DEG = 4;
export const BRANCH_DROOP_REPORT_DEG = 6;

export function midLeaningDeg(m: MidTree): number {
	return m.broken || !m.joint ? 0 : trunkTiltDeg(m.trunk);
}

export function largeBranchDroopCount(l: LargeTree): number {
	let n = 0;
	for (const b of l.branches) {
		if (b.broken || !b.joint) continue;
		if (quatAngleDeg(b.body.getRotation(), b.spawnRot) > BRANCH_DROOP_REPORT_DEG) n++;
	}
	return n;
}

// =================================================================================================
// Whole-feature assembly
// =================================================================================================

export interface TreesWorld {
	readonly saplings: SaplingTree[];
	readonly mids: MidTree[];
	readonly larges: LargeTree[];
	/** Foreign-mass registry (damage/system.ts's setForeignMass store) this feature keeps in sync --
	 * null when built headless without one (legacy sim tests). Spec §E. */
	readonly massRegistry: Map<number, number> | null;
}

/** Builds every tree (west-zone slalom + mid/large groves + the sparse far line -- see tuning.ts's
 * doc comment for the exact placement/clearance rationale), all spawned asleep. Deterministic: every
 * site/id is a fixed literal, no Math.random anywhere (feature contract warning #3). Pass the damage
 * system's foreign-mass Map as `massRegistry` (browser path) to register every member's real mass
 * (sapling 9kg / mid 320kg / branch 15kg) for mass-aware car damage (fracture spec §E). */
export function createTreesWorld(world: World, massRegistry: Map<number, number> | null = null): TreesWorld {
	const saplings: SaplingTree[] = [];
	const mids: MidTree[] = [];
	const larges: LargeTree[] = [];
	const B = TREES_MEMBER_ENTITY_ID_BASE;

	SAPLING_SITES.forEach((site, i) => saplings.push(buildSapling(world, `sapling-${i}`, B + SAPLING_ID_OFFSET + i, site)));
	MID_SITES.forEach((site, i) => mids.push(buildMid(world, `mid-${i}`, B + MID_ID_OFFSET + i, site)));
	LARGE_SITES.forEach((site, i) => larges.push(buildLarge(world, `large-${i}`, B + BRANCH_ID_OFFSET + i * 10, site)));

	const nearSaplings = saplings.length;
	const nearMids = mids.length;
	const nearLarges = larges.length;
	FAR_SAPLING_SITES.forEach((site, i) => saplings.push(buildSapling(world, `far-sapling-${i}`, B + SAPLING_ID_OFFSET + nearSaplings + i, site)));
	FAR_MID_SITES.forEach((site, i) => mids.push(buildMid(world, `far-mid-${i}`, B + MID_ID_OFFSET + nearMids + i, site)));
	FAR_LARGE_SITES.forEach((site, i) => larges.push(buildLarge(world, `far-large-${i}`, B + BRANCH_ID_OFFSET + (nearLarges + i) * 10, site)));

	if (massRegistry) {
		for (const s of saplings) massRegistry.set(s.entityId, SAPLING_MASS_KG);
		for (const m of mids) massRegistry.set(m.entityId, MID_MASS_KG);
		for (const l of larges) {
			massRegistry.set(l.trunkEntityId, LARGE_TRUNK_MASS_KG); // P002 fix -- was unregistered (infinite-mass wall damage)
			for (const b of l.branches) massRegistry.set(b.entityId, LARGE_BRANCH_MASS_KG);
		}
	}

	return { saplings, mids, larges, massRegistry };
}

/** Call once per fixed step, AFTER world.step() -- polls every intact joint's constraint force/torque
 * and snaps whichever crossed its break threshold this step. Pass a TreesFractureContext (browser
 * path + fracture tests) to make an over-threshold mid trunk (or a HARD-broken sapling, P015) SNAP into
 * stump+flyer instead of felling whole; without it (legacy sim tests) behavior is byte-identical to
 * before the fracture feature. */
export function stepTreesWorld(trees: TreesWorld, fracture?: TreesFractureContext): void {
	pollSaplingBreaks(trees.saplings, fracture, trees.massRegistry);
	pollMidBreaks(trees.mids, fracture, trees.massRegistry);
	pollLargeBreaks(trees.larges);
}

/** Full world reset (Shift+R): rebuilds any broken tree part fresh, teleports+resleeps every intact
 * one back to its spawn pose -- same idempotent shape as world/bodies.ts's resetDestructibleWorld(),
 * extended to cover the "was this part destroyed by a break?" case those bodies never hit. */
export function resetTreesWorld(world: World, trees: TreesWorld): void {
	for (const s of trees.saplings) resetSapling(world, s, trees.massRegistry);
	for (const m of trees.mids) resetMid(world, m, trees.massRegistry);
	for (const l of trees.larges) resetLarge(world, l);
}

/** Total live physics bodies owned by this feature (anchors + trunks + branches; a fractured mid or
 * sapling contributes stump + flyer = one extra body each) -- feature contract's "bodyCount() honest". */
export function treesBodyCount(trees: TreesWorld): number {
	let n = 0;
	n += trees.saplings.length * 2; // anchor + trunk (post-fracture: anchor + flyer, stump counted below)
	for (const s of trees.saplings) if (s.fractured) n += 1; // the stump
	n += trees.mids.length * 2; // anchor + trunk (post-fracture: anchor + flyer, stump counted below)
	for (const m of trees.mids) if (m.fractured) n += 1; // the stump
	for (const l of trees.larges) n += 2 + l.branches.length; // anchor + trunk (P002: now dynamic) + branches
	return n;
}

// =================================================================================================
// Crash Lab single-tree spawn/teardown (src/lab/crashTargets.ts's "crash into one model" tool). NOT
// used by the forest itself -- createTreesWorld above places the whole deterministic forest. Kept
// here, next to the tree records + builders, so it stays correct as the fracture record evolves.
// =================================================================================================

/** Builds ONE tree of the given class at an arbitrary ground site (y=0, upright) + registers its
 * member mass, so a car hit is mass-attenuated exactly like the forest. Drive it with a one-tree
 * TreesWorld through stepTreesWorld() and render it with trees/visuals.ts's buildTreesVisuals(). */
export function spawnSingleTree(
	world: World,
	kind: 'sapling' | 'mid' | 'large',
	site: TreeSiteXZ,
	entityIdBase: number,
	massRegistry: Map<number, number> | null,
): SaplingTree | MidTree | LargeTree {
	if (kind === 'sapling') {
		const t = buildSapling(world, 'crash-sapling', entityIdBase, site);
		massRegistry?.set(t.entityId, SAPLING_MASS_KG);
		return t;
	}
	if (kind === 'mid') {
		const t = buildMid(world, 'crash-mid', entityIdBase, site);
		massRegistry?.set(t.entityId, MID_MASS_KG);
		return t;
	}
	const t = buildLarge(world, 'crash-large', entityIdBase, site);
	massRegistry?.set(t.trunkEntityId, LARGE_TRUNK_MASS_KG);
	for (const b of t.branches) massRegistry?.set(b.entityId, LARGE_BRANCH_MASS_KG);
	return t;
}

/** Destroys every body of a single spawned tree + clears its foreign-mass entries. box3d frees a
 * body's joints WITH it, so we only ever destroy bodies (never a joint whose body is already gone). */
export function destroySingleTree(tree: SaplingTree | MidTree | LargeTree, massRegistry: Map<number, number> | null): void {
	if (tree.kind === 'sapling') {
		massRegistry?.delete(tree.entityId);
		if (tree.fractured && tree.stump) {
			massRegistry?.delete(tree.stump.frag.entityId);
			if (tree.flyerFrag) massRegistry?.delete(tree.flyerFrag.entityId);
			tree.stump.frag.body.destroy();
		}
		tree.trunk.destroy(); // === flyerFrag.body once fractured
		tree.anchor.destroy();
		return;
	}
	if (tree.kind === 'mid') {
		massRegistry?.delete(tree.entityId);
		if (tree.fractured && tree.stump) {
			massRegistry?.delete(tree.stump.frag.entityId);
			if (tree.flyerFrag) massRegistry?.delete(tree.flyerFrag.entityId);
			tree.stump.frag.body.destroy();
		}
		tree.trunk.destroy(); // === flyerFrag.body once fractured
		tree.anchor.destroy();
		return;
	}
	massRegistry?.delete(tree.trunkEntityId);
	for (const b of tree.branches) {
		massRegistry?.delete(b.entityId);
		b.body.destroy();
	}
	tree.trunk.destroy(); // frees the trunk's root weld with it (box3d convention, see this fn's doc)
	tree.anchor.destroy();
}
