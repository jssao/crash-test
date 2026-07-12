// SPDX-License-Identifier: MIT
//
// Shared FRACTURE module (D1 spec: docs/loom/d1-fracture-material-spec.md) -- renderer-free (no
// three/DOM import), reused by the 'trees' feature (mid trunk snap) and the 'buildings' feature
// (fence rail/post, shed+corner stud, shed plank/cladding, corner drywall). No engine primitive
// splits one body into pieces (p0d-destructibles-inventory.md F3), so a fracture EVENT here is always
// the same destroy-intact-body + spawn-N-fragment-bodies pattern the inventory recommends, mirroring
// the tree/panel destroy-and-rebuild precedent already proven in production.
//
// WHAT LIVES HERE (see each export's own doc comment):
//   - Per-material fracture thresholds (spec §B's derived force/torque numbers).
//   - A tiny deterministic RNG (local mulberry32 copy -- same duplicated-small-helper convention as
//     trees/tuning.ts's scatterRng/mulberry32, world/materials.ts, world/bodies.ts's nextRandom --
//     NO Math.random anywhere in this module, per the codebase's determinism contract).
//   - Fragment spawners: fractureCapsuleTrunk() (trunk -> stump + flyer) and fractureBoxMember()
//     (beam/sheet box -> 2 pieces split along one local axis) -- the two shapes every fracturable
//     member in this game reduces to.
//   - Velocity clamp (mirrors buildings/structures.ts's private clampDebrisVelocity() -- reproduced
//     here, not imported, since this module is shared across features and that one is structures.ts's
//     own private helper for its EXISTING weld-break path).
//   - A tiny per-feature fracture-event budget (>=1 fixed step apart per feature, mirroring damage/
//     system.ts's refreshPanelHulls() "<=1 panel/step" rule) and despawn tuning (mirrors the panel
//     despawn constants verbatim).
//
// SAFETY INVARIANT this module leans on but does NOT itself enforce (the CALLER must): before
// destroying a fracturing member's body, the caller must first destroy EVERY joint attached to that
// body (both as the joint's own dynamic side and as another piece's anchor side) -- src/ts/joint.ts's
// Joint.destroy() doc comment + this module's own callers document the "sever, then destroy" ordering
// used to avoid ever leaving a live Joint handle referencing a soon-to-be-destroyed Body.

import { Body, BodyType, Shape, World } from '../../../../src/ts/index.js';
import { add, length, rotateVector, scale, type Q4, type V3 } from '../../vehicle/mathUtil';

// =================================================================================================
// Entity id range (damage/system.ts's setForeignMass() registry) -- disjoint from every other range:
// chassis=1, wheels=2-5, panels=6-11, glass=12-13, segments=14-22, occupants=1000-1399,
// cardetail=88,100,000+/88,200,000+, barrels=44,000,000+ (world/tuning.ts). Spec §E's proposal.
// =================================================================================================
export const FRACTURE_FRAGMENT_ENTITY_ID_BASE = 45_000_000;

// =================================================================================================
// A. Material fracture thresholds (docs/loom/d1-fracture-material-spec.md §B's derived numbers --
// ratio(member) = (MOR_member/MOR_anchor) * (S_member/S_anchor), scaled off the mid-trunk anchor
// (MID_FORCE_THRESHOLD_N=550_000 / MID_TORQUE_THRESHOLD_NM=140_000, trees/tuning.ts:196-197). Kept as
// literal numbers (not re-derived here) so the values are traceable 1:1 against the spec's table
// without duplicating its section-modulus arithmetic in a second place.
// =================================================================================================
export interface FractureThreshold {
	readonly forceN: number;
	readonly torqueNm: number;
}

/** Fence rail (single-end weld cantilever) -- fractures well before its own 700N/350N·m weld-pop. */
export const FENCE_RAIL_FRACTURE: FractureThreshold = { forceN: 571, torqueNm: 145 };
/** Fence post (footing cantilever) -- its 700N/350N·m weld-pop wins in practice; kept for completeness
 * (a car pinning a post hard enough could still reach this before the weld gives). */
export const FENCE_POST_FRACTURE: FractureThreshold = { forceN: 1981, torqueNm: 504 };
/** Shed/corner stud (footing cantilever, shared 58mm-square cross-section) -- fractures LONG before its
 * 3500N/1800N·m*2.4 ductile weld-break; this is the PRIMARY new stud behavior (spec §B). */
export const STUD_FRACTURE: FractureThreshold = { forceN: 386, torqueNm: 98 };
/** Shed plank/cladding bay panel -- fractures overwhelmingly before its shared stud-style weld break. */
export const PLANK_FRACTURE: FractureThreshold = { forceN: 375, torqueNm: 95 };
/** Corner drywall bay panel -- fractures on essentially any real car-speed contact. */
export const DRYWALL_FRACTURE: FractureThreshold = { forceN: 29, torqueNm: 7.3 };
/** Mid tree trunk -- IS the spec's anchor (ratio 1.0), so its fracture threshold is numerically
 * identical to the existing fell (weld-break) threshold: trees/tuning.ts's MID_FORCE_THRESHOLD_N /
 * MID_TORQUE_THRESHOLD_NM. Duplicated here as a literal (rather than importing trees/tuning.ts into
 * this cross-feature module) so fracture.ts has zero feature-specific imports; trees/bodies.ts's own
 * test asserts these two numbers stay equal. */
export const MID_TRUNK_FRACTURE: FractureThreshold = { forceN: 550_000, torqueNm: 140_000 };

export function exceedsFracture(forceMag: number, torqueMag: number, t: FractureThreshold): boolean {
	return forceMag > t.forceN || torqueMag > t.torqueNm;
}

// =================================================================================================
// Deterministic RNG -- local mulberry32 copy (same algorithm as damage/crumple.ts's hash32/
// trees/tuning.ts's scatterRng/mulberry32/world/bodies.ts's nextRandom -- established small-helper
// duplication convention, not a shared import). NO Math.random()/Date.now() anywhere in this module.
// =================================================================================================
function fractureHash32(n: number): number {
	let x = n | 0;
	x = (x ^ 61) ^ (x >>> 16);
	x = (x + (x << 3)) | 0;
	x = x ^ (x >>> 4);
	x = Math.imul(x, 0x27d4eb2d);
	x = x ^ (x >>> 15);
	return x >>> 0;
}

/** Deterministic pseudo-random generator (mulberry32) seeded from a stable integer key. Call
 * repeatedly for a sequence of independent draws (split-fraction jitter, kick direction/magnitude,
 * angular nudge) -- same call always produces the same sequence for the same seed. */
export function fractureRng(seed: number): () => number {
	let a = seed | 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Stable per-member seed: `(memberEntityId, breakEventOrdinal)` per spec §C's velocity-seeding
 * recipe -- combined via the same 2654435761 (Knuth) multiplicative-hash constant trees/visuals.ts
 * already uses for its own per-instance seed spread. Re-fracturing is disallowed (spec §D "no
 * re-fracturing"), so `breakEventOrdinal` is always 0 in practice today; kept as a parameter so two
 * fragments spawned in the very same run from DIFFERENT members never accidentally share a seed. */
export function fractureSeed(memberEntityId: number, breakEventOrdinal = 0): number {
	return fractureHash32(((memberEntityId * 2654435761) ^ (breakEventOrdinal * 0x9e3779b1)) >>> 0);
}

// =================================================================================================
// Velocity clamp -- mirrors buildings/structures.ts's private clampDebrisVelocity() PATTERN
// (impulse-proportional release: direction preserved, only excess magnitude trimmed). Reproduced
// here (not imported) since this module is shared cross-feature and that one is structures.ts's own
// private helper for the EXISTING weld-break path.
// =================================================================================================
export function clampFragmentVelocity(body: Body, capMs: number, capRad: number): void {
	const v = body.getLinearVelocity();
	const s = Math.hypot(v.x, v.y, v.z);
	if (s > capMs) {
		const k = capMs / s;
		body.setLinearVelocity({ x: v.x * k, y: v.y * k, z: v.z * k });
	}
	const w = body.getAngularVelocity();
	const ws = Math.hypot(w.x, w.y, w.z);
	if (ws > capRad) {
		const k = capRad / ws;
		body.setAngularVelocity({ x: w.x * k, y: w.y * k, z: w.z * k });
	}
}

/** Deterministic separation-kick magnitude (m/s), spec §C item 2: "0.3-0.8 m/s ... scaled by how far
 * the triggering force exceeded the break threshold (clamped)". `forceMag`/`thresholdN` drive a [1,2]x
 * over-threshold ratio (clamped) linearly mapped onto [minMs,maxMs]. */
export function fractureKickMagnitude(forceMag: number, thresholdN: number, minMs = 0.3, maxMs = 0.8): number {
	const overRatio = Math.min(2, Math.max(1, thresholdN > 0 ? forceMag / thresholdN : 1));
	return minMs + (maxMs - minMs) * (overRatio - 1);
}

// =================================================================================================
// Id allocator -- monotonic counter per feature instance (trees / buildings each own one, seeded from
// a disjoint base) so every fragment this session gets a fresh, stable, deterministic entity id
// (same run order -> same ids, satisfying the determinism contract).
// =================================================================================================
export interface FractureIdAllocator {
	next(): number;
}

export function createFractureIdAllocator(base: number): FractureIdAllocator {
	let n = base;
	return {
		next(): number {
			return n++;
		},
	};
}

// =================================================================================================
// Per-feature fracture-event budget (spec §D: "at most 1 new fracture event ... per fixed step").
// Scoped PER FEATURE (trees / buildings each own one instance) rather than one shared global counter
// across features -- a deliberate, documented simplification: mirrors refreshPanelHulls()'s own
// single-subsystem scope (panels), and keeps trees/buildings decoupled (no cross-feature ordering
// dependency needed in registry.ts). Reset once per fixed step by each feature's own afterFixedStep().
// =================================================================================================
export interface FractureBudget {
	used: number;
	readonly cap: number;
}

export function createFractureBudget(cap = 1): FractureBudget {
	return { used: 0, cap };
}

export function resetFractureBudget(b: FractureBudget): void {
	b.used = 0;
}

export function tryConsumeFractureBudget(b: FractureBudget): boolean {
	if (b.used >= b.cap) return false;
	b.used++;
	return true;
}

// =================================================================================================
// Budget discipline (spec §D): global soft cap (documentation + a hook for callers/tests to check
// against) + despawn tuning reused VERBATIM from damage-tuning.ts's panel despawn constants (spec:
// "reuse the car-panel despawn pattern verbatim").
// =================================================================================================
export const FRACTURE_GLOBAL_FRAGMENT_CAP = 60;
export const FRACTURE_DESPAWN_AFTER_S = 25;
export const FRACTURE_DESPAWN_DISTANCE_M = 100;
/** No re-fracturing (spec §D): a fragment that is itself the product of one break never re-splits --
 * every FractureFragment this module returns is therefore terminal debris from the caller's point of
 * view (same as today's whole-piece debris), bounding worst-case fragment count. This constant exists
 * purely as a documentation anchor for that invariant; nothing in this module enforces it internally
 * since fragments never re-enter fractureBoxMember()/fractureCapsuleTrunk() -- the callers simply never
 * poll a FractureFragment's body for its own further fracture. */
export const FRACTURE_NO_REFRACTURE = true;

// =================================================================================================
// Generic fragment record -- what a caller (trees/buildings feature index.ts) needs to: (a) register
// the fragment's mass into damage/system.ts's setForeignMass() registry (spec §E), (b) build a
// matching THREE visual, and (c) poll it for age/distance despawn.
// =================================================================================================
export interface FractureFragment {
	readonly entityId: number;
	body: Body;
	shape: Shape;
	readonly massKg: number;
	readonly spawnTimeSec: number;
	readonly kind: 'capsule' | 'box';
	/** Box fragments only. */
	readonly halfExtents?: V3;
	/** Capsule fragments only (cap-to-cap length, i.e. NOT including the two hemispherical caps). */
	readonly capsuleRadius?: number;
	readonly capsuleCapLen?: number;
	despawned: boolean;
}

function fragmentBase(entityId: number, body: Body, shape: Shape, massKg: number, timeSec: number): Pick<FractureFragment, 'entityId' | 'body' | 'shape' | 'massKg' | 'spawnTimeSec' | 'despawned'> {
	return { entityId, body, shape, massKg, spawnTimeSec: timeSec, despawned: false };
}

function boxVolume(half: V3): number {
	return 8 * half.x * half.y * half.z;
}

function capsuleVolume(radius: number, capToCapLength: number): number {
	return Math.PI * radius * radius * capToCapLength + (4 / 3) * Math.PI * radius ** 3;
}

/** Deterministic separation-kick direction (world space): a jittered azimuth about the parent's local
 * up axis, tilted slightly upward -- reads as a real snap-apart shove rather than a straight vertical
 * pop. `sign` flips which of the two fragments gets the "positive" half of the kick (spec §C item 2:
 * "split oppositely between the two fragments"). */
function kickVector(rotation: Q4, rng: () => number, magnitude: number, sign: 1 | -1): V3 {
	const angle = rng() * Math.PI * 2;
	const local: V3 = { x: Math.cos(angle), y: 0.25 + rng() * 0.35, z: Math.sin(angle) };
	const len = Math.hypot(local.x, local.y, local.z) || 1;
	const dirWorld = rotateVector(rotation, { x: local.x / len, y: local.y / len, z: local.z / len });
	return scale(dirWorld, magnitude * sign);
}

// =================================================================================================
// Box-member fracture: splits a box body into 2 fragments along ONE local axis at `splitLocalCoord`
// (a coordinate in (-half[axis], +half[axis])), each keeping the parent's full cross-section on the
// other two axes (spec §C: "each keeping the parent's full cross-section"). Used for fence rail/post,
// shed/corner stud, shed plank/cladding, corner drywall.
// =================================================================================================
export interface BoxFractureInput {
	world: World;
	position: V3;
	rotation: Q4;
	linearVelocity: V3;
	angularVelocity: V3;
	half: V3;
	axis: 'x' | 'y' | 'z';
	/** Where to cut, a local-space coordinate strictly between -half[axis] and +half[axis]. */
	splitLocalCoord: number;
	massKg: number;
	friction: number;
	restitution: number;
	angularDamping: number;
	linearDamping: number;
	forceMag: number;
	threshold: FractureThreshold;
	seed: number;
	timeSec: number;
	idAllocator: FractureIdAllocator;
	breakSpeedCapMs: number;
	breakSpinCapRad: number;
}

export interface BoxFractureResult {
	/** The fragment on the (-axis) side of the cut. */
	neg: FractureFragment;
	/** The fragment on the (+axis) side of the cut. */
	pos: FractureFragment;
}

export function fractureBoxMember(input: BoxFractureInput): BoxFractureResult {
	const { world, position, rotation, linearVelocity, angularVelocity, half, axis, splitLocalCoord, massKg, friction, restitution, angularDamping, linearDamping, forceMag, threshold, seed, timeSec, idAllocator, breakSpeedCapMs, breakSpinCapRad } = input;
	const rng = fractureRng(seed);

	const fullLen = half[axis] * 2;
	const negLen = Math.max(0.02, splitLocalCoord - -half[axis]);
	const posLen = Math.max(0.02, fullLen - negLen);
	const negHalfAxis = negLen / 2;
	const posHalfAxis = posLen / 2;
	const negCenterAxis = -half[axis] + negHalfAxis;
	const posCenterAxis = splitLocalCoord + posHalfAxis;

	const negHalf: V3 = { ...half, [axis]: negHalfAxis };
	const posHalf: V3 = { ...half, [axis]: posHalfAxis };
	const negMassKg = massKg * (negLen / fullLen);
	const posMassKg = massKg * (posLen / fullLen);

	const negLocalOffset: V3 = { x: 0, y: 0, z: 0, [axis]: negCenterAxis };
	const posLocalOffset: V3 = { x: 0, y: 0, z: 0, [axis]: posCenterAxis };
	const negWorldPos = add(position, rotateVector(rotation, negLocalOffset));
	const posWorldPos = add(position, rotateVector(rotation, posLocalOffset));

	const kickMag = fractureKickMagnitude(forceMag, threshold.forceN);
	const negKick = kickVector(rotation, rng, kickMag, -1);
	const posKick = kickVector(rotation, rng, kickMag, 1);
	const angNudge = 0.6 + rng() * 0.9;

	function spawn(worldPos: V3, halfExtents: V3, fragMassKg: number, kick: V3, angSign: 1 | -1): FractureFragment {
		const body = world.createBody({ type: BodyType.Dynamic, position: worldPos, rotation, angularDamping, linearDamping });
		const density = fragMassKg / boxVolume(halfExtents);
		const shape = body.createBoxShape({ halfExtents, density, friction, restitution });
		body.applyMassFromShapes();
		body.setLinearVelocity(add(linearVelocity, kick));
		body.setAngularVelocity(add(angularVelocity, rotateVector(rotation, { x: angNudge * angSign, y: angNudge * 0.3 * angSign, z: 0 })));
		clampFragmentVelocity(body, breakSpeedCapMs, breakSpinCapRad);
		const entityId = idAllocator.next();
		body.setUserData(entityId);
		return { ...fragmentBase(entityId, body, shape, fragMassKg, timeSec), kind: 'box', halfExtents };
	}

	const neg = spawn(negWorldPos, negHalf, negMassKg, negKick, -1);
	const pos = spawn(posWorldPos, posHalf, posMassKg, posKick, 1);
	return { neg, pos };
}

// =================================================================================================
// Sheet-member fracture: splits a thin box sheet (plywood cladding bay / drywall sheet) into 3
// irregular quad shards -- one full-width lower piece plus two upper pieces cut at a jittered
// vertical+lateral crack (spec §C: "2-4 irregular quadrilateral shards (jagged, not a clean
// rectangle cut)"). Each shard keeps the parent's full THICKNESS; its two in-plane half-extents are
// shrunk by a small deterministic jitter so the edges read as splintered/jagged (visible gaps at the
// crack lines) rather than a machine cut. Mass is apportioned by UNSHRUNK area so total mass is
// conserved. 3 shards = net +2 bodies per sheet fracture.
// =================================================================================================
export interface SheetFractureInput {
	world: World;
	position: V3;
	rotation: Q4;
	linearVelocity: V3;
	angularVelocity: V3;
	half: V3;
	/** The sheet's two IN-PLANE axes (the third is the thickness axis, untouched). */
	axisU: 'x' | 'y' | 'z';
	axisV: 'x' | 'y' | 'z';
	massKg: number;
	friction: number;
	restitution: number;
	angularDamping: number;
	linearDamping: number;
	forceMag: number;
	threshold: FractureThreshold;
	seed: number;
	timeSec: number;
	idAllocator: FractureIdAllocator;
	breakSpeedCapMs: number;
	breakSpinCapRad: number;
}

export function fractureSheetMember(input: SheetFractureInput): FractureFragment[] {
	const { world, position, rotation, linearVelocity, angularVelocity, half, axisU, axisV, massKg, friction, restitution, angularDamping, linearDamping, forceMag, threshold, seed, timeSec, idAllocator, breakSpeedCapMs, breakSpinCapRad } = input;
	const rng = fractureRng(seed);

	const fullU = half[axisU] * 2;
	const fullV = half[axisV] * 2;
	// Jittered crack coordinates (local space): a horizontal crack at ~35-55% height, and a vertical
	// crack through the UPPER region at ~40-60% width.
	const vCut = -half[axisV] + fullV * (0.35 + rng() * 0.2);
	const uCut = -half[axisU] + fullU * (0.4 + rng() * 0.2);

	const kickMag = fractureKickMagnitude(forceMag, threshold.forceN);
	const totalArea = fullU * fullV;

	const lowerV = vCut - -half[axisV];
	const upperV = fullV - lowerV;
	const leftU = uCut - -half[axisU];
	const rightU = fullU - leftU;
	const shardSpecs: { centerU: number; centerV: number; halfU: number; halfV: number }[] = [
		// Full-width lower piece.
		{ centerU: 0, centerV: -half[axisV] + lowerV / 2, halfU: half[axisU], halfV: lowerV / 2 },
		// Upper-left piece.
		{ centerU: -half[axisU] + leftU / 2, centerV: vCut + upperV / 2, halfU: leftU / 2, halfV: upperV / 2 },
		// Upper-right piece.
		{ centerU: uCut + rightU / 2, centerV: vCut + upperV / 2, halfU: rightU / 2, halfV: upperV / 2 },
	];

	const fragments: FractureFragment[] = [];
	for (let i = 0; i < shardSpecs.length; i++) {
		const s = shardSpecs[i];
		const area = s.halfU * 2 * (s.halfV * 2);
		const shardMassKg = massKg * (area / totalArea);
		// Jagged-edge shrink (deterministic): each in-plane half-extent scaled 0.86-0.98.
		const shrinkU = 0.86 + rng() * 0.12;
		const shrinkV = 0.86 + rng() * 0.12;
		const shardHalf: V3 = { ...half, [axisU]: Math.max(0.015, s.halfU * shrinkU), [axisV]: Math.max(0.015, s.halfV * shrinkV) };
		const localOffset: V3 = { x: 0, y: 0, z: 0, [axisU]: s.centerU, [axisV]: s.centerV };
		const worldPos = add(position, rotateVector(rotation, localOffset));

		const sign: 1 | -1 = i % 2 === 0 ? 1 : -1;
		const kick = kickVector(rotation, rng, kickMag, sign);
		const angNudge = 0.5 + rng() * 1.0;

		const body = world.createBody({ type: BodyType.Dynamic, position: worldPos, rotation, angularDamping, linearDamping });
		const density = shardMassKg / boxVolume(shardHalf);
		const shape = body.createBoxShape({ halfExtents: shardHalf, density, friction, restitution });
		body.applyMassFromShapes();
		body.setLinearVelocity(add(linearVelocity, kick));
		body.setAngularVelocity(add(angularVelocity, rotateVector(rotation, { x: angNudge * sign, y: 0, z: angNudge * 0.4 * -sign })));
		clampFragmentVelocity(body, breakSpeedCapMs, breakSpinCapRad);
		const entityId = idAllocator.next();
		body.setUserData(entityId);
		fragments.push({ ...fragmentBase(entityId, body, shape, shardMassKg, timeSec), kind: 'box', halfExtents: shardHalf });
	}
	return fragments;
}

// =================================================================================================
// Capsule-trunk fracture: splits a vertical trunk capsule (body origin at the trunk's BASE, per
// trees/bodies.ts's convention -- center1={0,r,0}, center2={0,H-r,0}) into a short "stump" (the base
// portion, same origin+rotation as the parent -- reads as "the car snapped it off at the base") and a
// longer "flyer" (the rest, positioned at the break height). Used for the mid tree trunk.
// =================================================================================================
export interface CapsuleFractureInput {
	world: World;
	/** Parent trunk's CURRENT world position (its base, per trees/bodies.ts's body-origin convention). */
	position: V3;
	rotation: Q4;
	linearVelocity: V3;
	angularVelocity: V3;
	radius: number;
	/** Overall trunk length including both hemispherical caps (trees/tuning.ts's *_TRUNK_HEIGHT_M). */
	fullHeight: number;
	massKg: number;
	friction: number;
	/** Nominal fraction of fullHeight kept as the stump (spec: "~30%"), BEFORE jitter -- jitter is
	 * applied internally from `seed` so two identical crashes reproduce the identical split. */
	stumpFraction: number;
	forceMag: number;
	threshold: FractureThreshold;
	seed: number;
	timeSec: number;
	idAllocator: FractureIdAllocator;
	breakSpeedCapMs: number;
	breakSpinCapRad: number;
}

export interface CapsuleFractureResult {
	stump: FractureFragment;
	flyer: FractureFragment;
}

export function fractureCapsuleTrunk(input: CapsuleFractureInput): CapsuleFractureResult {
	const { world, position, rotation, linearVelocity, angularVelocity, radius, fullHeight, massKg, friction, stumpFraction, forceMag, threshold, seed, timeSec, idAllocator, breakSpeedCapMs, breakSpinCapRad } = input;
	const rng = fractureRng(seed);

	// Small deterministic jitter on the split point (spec: "offset by a small deterministic jitter ...
	// so the cut doesn't read as machine-clean") -- +/-10% of the nominal stump fraction.
	const jitteredFraction = Math.min(0.6, Math.max(0.1, stumpFraction + (rng() * 2 - 1) * stumpFraction * 0.15));
	const breakHeight = fullHeight * jitteredFraction;

	const stumpCapLen = Math.max(0.03, breakHeight - 2 * radius);
	const flyerLen = fullHeight - breakHeight;
	const flyerCapLen = Math.max(0.03, flyerLen - 2 * radius);

	const stumpMassKg = massKg * (breakHeight / fullHeight);
	const flyerMassKg = massKg * (flyerLen / fullHeight);

	const flyerWorldPos = add(position, rotateVector(rotation, { x: 0, y: breakHeight, z: 0 }));

	const kickMag = fractureKickMagnitude(forceMag, threshold.forceN);
	const stumpKick = kickVector(rotation, rng, kickMag * 0.4, -1); // stump: a smaller settle-kick
	const flyerKick = kickVector(rotation, rng, kickMag, 1);
	const angNudge = 0.5 + rng() * 0.8;

	function spawn(worldPos: V3, capLen: number, fragMassKg: number, kick: V3, angSign: 1 | -1): FractureFragment {
		const body = world.createBody({ type: BodyType.Dynamic, position: worldPos, rotation });
		const density = fragMassKg / capsuleVolume(radius, capLen);
		const shape = body.createCapsuleShape({
			center1: { x: 0, y: radius, z: 0 },
			center2: { x: 0, y: radius + capLen, z: 0 },
			radius,
			density,
			friction,
		});
		body.applyMassFromShapes();
		body.setLinearVelocity(add(linearVelocity, kick));
		body.setAngularVelocity(add(angularVelocity, rotateVector(rotation, { x: angNudge * angSign, y: 0, z: angNudge * 0.3 * angSign })));
		clampFragmentVelocity(body, breakSpeedCapMs, breakSpinCapRad);
		const entityId = idAllocator.next();
		body.setUserData(entityId);
		return { ...fragmentBase(entityId, body, shape, fragMassKg, timeSec), kind: 'capsule', capsuleRadius: radius, capsuleCapLen: capLen };
	}

	const stump = spawn(position, stumpCapLen, stumpMassKg, stumpKick, -1);
	const flyer = spawn(flyerWorldPos, flyerCapLen, flyerMassKg, flyerKick, 1);
	return { stump, flyer };
}

// =================================================================================================
// Despawn poll -- age + distance-from-car (mirrors damage-tuning.ts's PANEL_DESPAWN_AFTER_S/
// PANEL_DESPAWN_DISTANCE_M verbatim, spec §D). Caller supplies the reference point (the chassis
// position) since fracture.ts has no Vehicle reference of its own. Destroys shape then body (same
// explicit ordering as damage/system.ts's panel despawn, so the box3d-js live-handle registry entry is
// unregistered cleanly) and returns the ids so the caller can drop them from setForeignMass().
// =================================================================================================
export function pollFragmentDespawn(fragments: FractureFragment[], referencePos: V3, timeSec: number): number[] {
	const despawnedIds: number[] = [];
	for (const f of fragments) {
		if (f.despawned) continue;
		const age = timeSec - f.spawnTimeSec;
		const pos = f.body.getPosition();
		const dist = length({ x: pos.x - referencePos.x, y: pos.y - referencePos.y, z: pos.z - referencePos.z });
		if (age > FRACTURE_DESPAWN_AFTER_S || dist > FRACTURE_DESPAWN_DISTANCE_M) {
			f.shape.destroy(false);
			f.body.destroy();
			f.despawned = true;
			despawnedIds.push(f.entityId);
		}
	}
	return despawnedIds;
}
