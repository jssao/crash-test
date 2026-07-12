// SPDX-License-Identifier: MIT
//
// Crush-segment structure (crush-architecture.md §A, crush M1): the chassis's monolithic NOSE and
// TAIL crush volumes (formerly two of the cabin-tub shapes, geometry.ts) are replaced by chains of
// REAL rigid bodies joined by welds:
//
//   front:  chassis(firewall) | engineCradle | crushRailL/R (2 cells each) | bumperBeam
//   rear:   chassis(bulkhead) | trunkFloor | rearRailL/R
//
// A frontal wall now meets a bumper+rail chain instead of a solid convex nose. Each segment's ONE
// weld anchors the CHASSIS directly (star topology -- the spec's serial-chain sketch measured as an
// elastic trampoline, see WELD_DEFS' doc comment); the chain SEMANTICS (tiered yield, inboard
// carry-along) are enforced by the M2 yield bookkeeping. In M1 the welds are FIXED (soft+overdamped
// compliances, never yielding -- see SEGMENT_WELD_DAMPING_RATIO's measured rationale for why hertz-0
// trampolines) and the assembly is a pure structure swap: each segment's mass is DEDUCTED
// from the chassis via geometry.ts's deductSegmentsFromParity() (vehicle.ts), so the rigid composite
// reproduces the captured single-hull mass/COM/inertia exactly. The yield mechanic (M2: plastic
// rest-transform shift on overload) lives in stepSegmentYield() below.
//
// FILTERS: every segment shape carries the same occupant-transparent word the solid nose/tail did
// (front occupants' legs live inside the front chain, rear torsos/heads inside the rear -- see
// tuning.ts's OCCUPANT_TRANSPARENT_CATEGORY_BITS doc) plus the shared CAR_GROUP_INDEX (never
// self-collides with chassis/wheels/panels/cardetail). enableHitEvents on, and body+shape tagged with
// SEGMENT_ENTITY_ID so the damage system routes a wall→bumper hit into the SAME cosmetic-crumple /
// weld-stress pipelines a wall→nose hit used to feed (system.ts CAR_ENTITY_IDS, welds.ts
// hitTouchesCar).
//
// GEOMETRY (chassis-local, all boxes): the chains tile the old nose/tail volumes' LOWER band (the
// real structure of a car's crush zone). The old raked hull faces above the beltline (fender tops /
// cowl) are no longer collision-solid -- the hood/trunk PANEL bodies own those top surfaces. First
// wall contact is preserved: the bumperBeam's front face sits at the old hull's bottom-front edge
// (HULL_BOTTOM_HALF_LENGTH_M), the same z the old bevel edge (and the cardetail front bumper capsule)
// contacted first.

import { Body, BodyType, Shape, World, WeldJoint } from '../../../src/ts/index.js';
import { add, IDENTITY_Q, length, rotateVector, sub, type Q4, type V3 } from './mathUtil';
import {
	CAR_GROUP_INDEX,
	FIXED_DT,
	HULL_BOTTOM_HALF_LENGTH_M,
	HULL_BOTTOM_HALF_WIDTH_M,
	OCCUPANT_TRANSPARENT_CATEGORY_BITS,
} from './tuning';
import {
	buildCrushCorePoints,
	BULKHEAD_Z_M,
	CRUSH_CORE_INITIAL_RECESS_M,
	CRUSH_CORE_MAX_RETREAT_FRONT_M,
	CRUSH_CORE_MAX_RETREAT_REAR_M,
	FIREWALL_Z_M,
	HULL_BOTTOM_Y_M,
	type CrushCoreHalf,
	type SegmentMassSpec,
} from './geometry';

export type SegmentKey =
	| 'bumperBeam'
	| 'crushRailLF'
	| 'crushRailLR'
	| 'crushRailRF'
	| 'crushRailRR'
	| 'engineCradle'
	| 'trunkFloor'
	| 'rearRailL'
	| 'rearRailR';

export interface SegmentSpec {
	key: SegmentKey;
	/** Chassis-local rest center (== the segment body's origin offset from the chassis origin). */
	center: V3;
	half: V3;
	massKg: number;
}

/** Entity ids tagged on segment bodies AND shapes (Body/Shape userData) -- extends the car's reserved
 * id ranges (chassis 1, wheels 2-5, panels 6-11, glass 12-13; occupants 1000+; cardetail 88M+) with
 * 14-22. system.ts's CAR_ENTITY_IDS and welds.ts's hitTouchesCar() treat these as "the car".
 *
 * RENUMBERED 2026-07-11 (S90 swap): was 13-21 before the rear-door panels (doorRL/doorRR) took the
 * only free panel slot -- every id here shifted +1 in lockstep with vehicle.ts's GLASS_ENTITY_ID
 * (see that file's doc comment + docs/loom/p0b-mustang-coupling.md section 5). */
export const SEGMENT_ENTITY_ID: Record<SegmentKey, number> = {
	bumperBeam: 14,
	crushRailLF: 15,
	crushRailLR: 16,
	crushRailRF: 17,
	crushRailRR: 18,
	engineCradle: 19,
	trunkFloor: 20,
	rearRailL: 21,
	rearRailR: 22,
};

/** Entity ids tagged on the crush-core SHAPES (chassis-owned backstops, segments.ts createSegments).
 * Extends the segment range: system.ts uses them to (a) keep core strikes routed into the same
 * car-damage pipelines a solid-nose strike used to feed and (b) tell stepSegmentYield WHICH core a
 * barrier is actually pressing (the per-half engagement latch -- see the M2 section doc). */
export const CORE_ENTITY_ID = { frontPos: 23, frontNeg: 24, rear: 25 } as const;

/** Hit-event id sets per crush chain (segments + cores of that end) -- the contact-evidence lookup
 * system.ts runs while draining hits (CoreHitFlags doc). */
export const FRONT_CHAIN_HIT_IDS: ReadonlySet<number> = new Set([
	SEGMENT_ENTITY_ID.bumperBeam,
	SEGMENT_ENTITY_ID.crushRailLF,
	SEGMENT_ENTITY_ID.crushRailLR,
	SEGMENT_ENTITY_ID.crushRailRF,
	SEGMENT_ENTITY_ID.crushRailRR,
	SEGMENT_ENTITY_ID.engineCradle,
	23, // CORE_ENTITY_ID.frontPos (declared below)
	24, // CORE_ENTITY_ID.frontNeg
]);
export const REAR_CHAIN_HIT_IDS: ReadonlySet<number> = new Set([
	SEGMENT_ENTITY_ID.trunkFloor,
	SEGMENT_ENTITY_ID.rearRailL,
	SEGMENT_ENTITY_ID.rearRailR,
	25, // CORE_ENTITY_ID.rear
]);

export const SEGMENT_ENTITY_ID_SET: ReadonlySet<number> = new Set([
	...Object.values(SEGMENT_ENTITY_ID),
	...Object.values(CORE_ENTITY_ID),
]);

// ---------------------------------------------------------------------------------------------
// Layout constants (chassis-local). Y0 = the hull's ground-clearance bottom line; the whole chain
// keeps its bottom there so the crush zone still carries nose-dive/tail-drag ground contact.
// ---------------------------------------------------------------------------------------------
const Y0 = HULL_BOTTOM_Y_M; // ~-0.119 (S90; was ~-0.07 Mustang)
/** Front tip: the old hull's bottom-front edge z (its first-contact feature on a frontal wall),
 * pulled in 0.5mm so the swap can't grow the car's collision length. */
const FRONT_TIP_Z = HULL_BOTTOM_HALF_LENGTH_M - 0.0005;
const REAR_TIP_Z = -FRONT_TIP_Z;
/**
 * RE-DERIVED 2026-07-11 (S90 swap). Beam depth / rail split planes (front chain z-tiling: cradle |
 * rear cells | front cells | beam) -- these are pure internal-tier-split literals (crash-architecture.
 * md §A's staged-yield tiers), not directly car-map-derived. Re-derivation method: preserve the
 * MUSTANG'S tier-depth RATIOS (engineCradle 0.62m : rearCell 0.38m : frontCell 0.355m : beam 0.24m,
 * summing to the Mustang's total available front-crush length FRONT_TIP_Z(2.2955) - FIREWALL_Z_M(0.7)
 * = 1.595m) rescaled to the S90's own total available length (FRONT_TIP_Z(2.5005) -
 * FIREWALL_Z_M(0.95) = 1.5505m, scale factor 0.972): engineCradle 0.603m, rearCell 0.369m, frontCell
 * 0.345m, beam 0.233m -- chosen over a flat re-measurement because these tiers' STAGED-YIELD RATIOS
 * (which tier absorbs how much of the crush budget) are the empirically-tuned physics, not the exact
 * millimeters; preserving the ratio while adapting to the new available length keeps that tuning
 * intact. Re-verify against sim/crash-realism.test.mjs's measured crush-vs-speed bands (S6).
 */
const BEAM_REAR_Z = 2.27;
const RAIL_SPLIT_Z = 1.92;
const RAIL_REAR_Z = 1.55;
/** Rails: outboard frame members. Full rail = 2 cells (front/rear) chained by a weld -- the M2
 * staged-yield tiers need the mid-rail joint (front cell yields before rear cell).
 * S90 SWAP: scaled by the body-width ratio (2.011/1.936 = 1.039) from the Mustang's measured 0.3/0.66. */
const RAIL_X_IN = 0.31;
const RAIL_X_OUT = 0.69;
const RAIL_TOP_Y = 0.38;
/**
 * Rear chain z-tiling: bulkhead | trunkFloor | rear rails | rear tip. RE-DERIVED 2026-07-11 (S90 swap)
 * with the same tier-ratio-preservation method as the front chain above: Mustang's rear crush zone
 * (BULKHEAD_Z_M(-0.64) to REAR_TIP_Z(-2.2955), total 1.6555m) split trunkFloor 0.98m / rearRail
 * 0.6755m (59.2%/40.8%); applied to the S90's rear crush zone (BULKHEAD_Z_M(-1.25) to
 * REAR_TIP_Z(-2.5005), total 1.2505m -- shorter than the Mustang's despite the longer car, because the
 * S90's BULKHEAD_Z_M moved much further back to give the real 4-door rear seat its own cabin space,
 * eating into the available rear-crush length) gives trunkFloor 0.740m / rearRail 0.510m.
 */
const TRUNK_REAR_Z = -1.99;

function boxSpec(key: SegmentKey, massKg: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): SegmentSpec {
	return {
		key,
		massKg,
		center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
		half: { x: (x1 - x0) / 2, y: (y1 - y0) / 2, z: (z1 - z0) / 2 },
	};
}

/**
 * The 9 segment boxes. Masses per crush-architecture.md §A ("real-ish: beam ~15kg, rails ~20kg ea
 * [10 per cell], cradle ~40kg"; rear sized similarly lighter) -- 95kg front + 40kg rear = 135kg total
 * originally, all deducted from the chassis remainder (vehicle.ts's parity stamp).
 *
 * PHASE R RE-MASS (2026-07-12, see vehicle/tuning.ts's CHASSIS_MASS_KG doc comment): scaled uniformly
 * by the chassis sprung-mass growth factor 1534/1261 = 1.2166 (rounded to the nearest kg per segment),
 * so the crush structure's mass grows in proportion to the sprung mass it's carved out of, not
 * independently re-guessed: engineCradle 40->49 (48.66), crushRailLR/RR/LF/RF 10->12 each (12.165),
 * bumperBeam 15->18 (18.25), trunkFloor 16->19 (19.46), rearRailL/R 12->15 each (14.6). New total
 * 49+12+12+12+12+18+19+15+15 = 164kg (was 135kg) -- pinned by segment-mass-parity.test.mjs.
 */
// S90 SWAP 2026-07-11: lateral (x) and vertical (y) literals below scaled by the body-width ratio
// (2.011/1.936 = 1.039, e.g. engineCradle ±0.75 -> ±0.78, trunkFloor ±0.85 -> ±0.88, rearRail
// 0.25/0.7 -> 0.26/0.73) and the fractional Y-rescale method (within [Y0, HULL_TOP_Y_M], same as
// geometry.ts's BELTLINE_Y_M/CANTRAIL_Y_M -- e.g. engineCradle top 0.52 -> 0.54, bumperBeam top
// 0.3 -> 0.29, trunkFloor top 0.1 -> 0.07, rearRail top 0.42 -> 0.43); every result landed within a
// few cm of the Mustang original, consistent with these being largely car-size-invariant underbody
// clearance heights.
export const SEGMENT_SPECS: readonly SegmentSpec[] = [
	// Front chain
	boxSpec('engineCradle', 49, -0.78, 0.78, Y0, 0.54, FIREWALL_Z_M, RAIL_REAR_Z),
	boxSpec('crushRailLR', 12, RAIL_X_IN, RAIL_X_OUT, Y0, RAIL_TOP_Y, RAIL_REAR_Z, RAIL_SPLIT_Z),
	boxSpec('crushRailLF', 12, RAIL_X_IN, RAIL_X_OUT, Y0, RAIL_TOP_Y, RAIL_SPLIT_Z, BEAM_REAR_Z),
	boxSpec('crushRailRR', 12, -RAIL_X_OUT, -RAIL_X_IN, Y0, RAIL_TOP_Y, RAIL_REAR_Z, RAIL_SPLIT_Z),
	boxSpec('crushRailRF', 12, -RAIL_X_OUT, -RAIL_X_IN, Y0, RAIL_TOP_Y, RAIL_SPLIT_Z, BEAM_REAR_Z),
	boxSpec('bumperBeam', 18, -HULL_BOTTOM_HALF_WIDTH_M, HULL_BOTTOM_HALF_WIDTH_M, Y0, 0.29, BEAM_REAR_Z, FRONT_TIP_Z),
	// Rear chain
	boxSpec('trunkFloor', 19, -0.88, 0.88, Y0, 0.07, TRUNK_REAR_Z, BULKHEAD_Z_M),
	boxSpec('rearRailL', 15, 0.26, 0.73, Y0, 0.43, REAR_TIP_Z, TRUNK_REAR_Z),
	boxSpec('rearRailR', 15, -0.73, -0.26, Y0, 0.43, REAR_TIP_Z, TRUNK_REAR_Z),
];

const SPEC_BY_KEY: ReadonlyMap<SegmentKey, SegmentSpec> = new Map(SEGMENT_SPECS.map((s) => [s.key, s]));

export function segmentSpec(key: SegmentKey): SegmentSpec {
	const s = SPEC_BY_KEY.get(key);
	if (!s) throw new Error(`segments.ts: unknown segment key "${key}"`);
	return s;
}

/** The specs shaped for geometry.ts's deductSegmentsFromParity() (mass-parity capture, vehicle.ts). */
export function segmentMassSpecs(): SegmentMassSpec[] {
	return SEGMENT_SPECS.map((s) => ({ center: s.center, half: s.half, massKg: s.massKg }));
}

// ---------------------------------------------------------------------------------------------
// Weld definition: one weld per segment, anchored to the CHASSIS (star topology -- see the measured
// rationale below). frameA = the segment's rest center in chassis-local space, frameB = identity.
// `crushZSign` is the direction (chassis-local z) the segment's rest pose shifts under plastic
// yield: -1 front (segments shorten rearward), +1 rear (segments shorten forward).
// ---------------------------------------------------------------------------------------------

/** M2 staged-resistance tier of one weld (crush-architecture.md §A: beam yields first, then front
 * cells, then rear cells, cradle last; rear chain mirrors with rearRail before trunk). */
export type SegmentWeldTier = 'beam' | 'frontCell' | 'rearCell' | 'cradle' | 'rearRail' | 'trunk';

export type SegmentWeldKey = 'cradle' | 'cellRL' | 'cellRR' | 'cellFL' | 'cellFR' | 'beam' | 'trunk' | 'rearL' | 'rearR';

interface SegmentWeldDef {
	key: SegmentWeldKey;
	tier: SegmentWeldTier;
	/** 'chassis' or a SegmentKey. */
	parent: 'chassis' | SegmentKey;
	child: SegmentKey;
	crushZSign: 1 | -1;
}

// TOPOLOGY DEVIATION FROM crush-architecture.md §A, MEASURED AND DELIBERATE: the spec sketches the
// welds as a SERIAL chain (chassis ⇄ cradle ⇄ rail cells ⇄ beam). Built that way first and measured
// (120 km/h rigid-frontal probe, M1): the serial chain of 10-40kg bodies between the wall and the
// ~1150kg chassis is an elastic trampoline in a sequential-impulse solver -- the wall stops the beam
// (bullet CCD holds, wall penetration ~0.03m) but each weld hop can only propagate a light body's
// worth of impulse per iteration, so the chain COMPRESSED 0.75m in a single fixed step, then TGS
// returned the stored constraint bias as a clean rebound: car expelled at -7.5m/s (e~0.23, final rest
// 17m from the wall vs the solid-nose baseline's "stops at the wall face, rest ~2.5m"), cosmetic
// crush collapsed (0.25m vs baseline 0.58m) and the rebound yank falsely loosened a door. Anchoring
// every weld DIRECTLY to the chassis (star topology) restores the 1-hop solver coupling the solid
// nose had, while keeping the per-tier yield DOFs: each weld still owns its tier's crush budget, and
// the M2 yield loop enforces the chain SEMANTICS in bookkeeping (a segment's total rest shift = its
// own weld's crush + the carry-along of every tier inboard of it on its side -- see
// segmentRestOffsetZ()).
const WELD_DEFS: readonly SegmentWeldDef[] = [
	{ key: 'cradle', tier: 'cradle', parent: 'chassis', child: 'engineCradle', crushZSign: -1 },
	{ key: 'cellRL', tier: 'rearCell', parent: 'chassis', child: 'crushRailLR', crushZSign: -1 },
	{ key: 'cellRR', tier: 'rearCell', parent: 'chassis', child: 'crushRailRR', crushZSign: -1 },
	{ key: 'cellFL', tier: 'frontCell', parent: 'chassis', child: 'crushRailLF', crushZSign: -1 },
	{ key: 'cellFR', tier: 'frontCell', parent: 'chassis', child: 'crushRailRF', crushZSign: -1 },
	{ key: 'beam', tier: 'beam', parent: 'chassis', child: 'bumperBeam', crushZSign: -1 },
	{ key: 'trunk', tier: 'trunk', parent: 'chassis', child: 'trunkFloor', crushZSign: 1 },
	{ key: 'rearL', tier: 'rearRail', parent: 'chassis', child: 'rearRailL', crushZSign: 1 },
	{ key: 'rearR', tier: 'rearRail', parent: 'chassis', child: 'rearRailR', crushZSign: 1 },
];

export interface SegmentHandle {
	readonly key: SegmentKey;
	readonly spec: SegmentSpec;
	body: Body;
	shape: Shape;
}

export interface SegmentWeldHandle {
	readonly key: SegmentWeldKey;
	readonly tier: SegmentWeldTier;
	/** Null once TORN (M2: constraint force above the tier's break threshold destroys the weld and the
	 * segment scatters -- high speed only). Rest-frame recreates (plastic yield) swap the object here. */
	joint: WeldJoint | null;
	readonly parentBody: Body;
	readonly childBody: Body;
	/** The child's PRISTINE rest offset in the parent's local frame (weld frameA position at spawn). */
	readonly restFrameA: V3;
	readonly crushZSign: 1 | -1;
	/** Accumulated plastic shortening (m), 0..maxCrush for this tier. 0 while pristine/rigid. */
	crushM: number;
}

/** One plastically-yielding crush-core backstop (a HULL shape on the chassis body, mutated in place
 * via Shape.setHull -- the M0b runtime-geometry machinery). See geometry.ts's crush-core doc. The
 * FRONT is two independent half-width cores ('pos'/'neg' lateral halves) so an offset barrier
 * collapses only the struck side; the rear is one full-width core. */
export interface CrushCoreHandle {
	readonly end: 'front' | 'rear';
	readonly half: CrushCoreHalf;
	shape: Shape;
	/** Accumulated plastic face retreat (m), 0..maxRetreatM. Monotone (never heals in place). */
	retreatM: number;
	readonly maxRetreatM: number;
}

export interface SegmentAssembly {
	bodies: Record<SegmentKey, SegmentHandle>;
	welds: SegmentWeldHandle[];
	cores: { frontPos: CrushCoreHandle; frontNeg: CrushCoreHandle; rear: CrushCoreHandle };
	/** @internal stepSegmentYield()'s inter-step state: the chassis's signed forward speed (m/s) at
	 * the END of the previous fixed step (the per-step delta is the DIRECTIONAL CRASH GATE), plus the
	 * per-core engagement latches -- steps remaining on each core's "a barrier hit event touched me
	 * recently" timer (see stepSegmentYield's coreHits parameter) -- plus the OWN-displacement ratchet's
	 * consecutive-qualifying-step counters (ownRatchetStreak, PHASE R addition -- see its doc comment at
	 * OWN_RATCHET_DEBOUNCE_STEPS below). */
	yieldState: {
		prevForwardSpeedMs: number;
		prevLostE: number;
		engageSteps: { pos: number; neg: number; rear: number; frontChain: number; rearChain: number };
		ownRatchetStreak: { front: number; rear: number };
		/** EXTREME TIER (Stream C C2): the fastest |forward speed| (m/s) this chassis has reached since
		 * spawn/reset -- see EXTREME_GATE_SPEED_MS's doc comment below for why PEAK (not current,
		 * decaying-through-the-crash) speed is the right gate signal. */
		peakForwardSpeedMs: number;
	};
}

/**
 * Segment weld compliance: SOFT (8Hz) + OVERDAMPED (ratio 2), deliberately NOT hertz-0 "rigid".
 * MEASURED RATIONALE (80/120/140km/h rigid-frontal probes, M1; full parameter scan 0Hz,
 * 60Hz x {5,20,100}, {8,12,20}Hz x {2,3,4}): a hertz-0 weld is solved as a hard TGS constraint whose
 * position-bias at crash-scale violations reversed the whole car's velocity +32 -> -9.5 m/s in a
 * SINGLE fixed step -- the car trampolined off the wall (final rest 6-22m BEHIND spawn vs the
 * solid-nose baseline's dead stop at the wall face), cosmetic crush collapsed at 120+ (0.25m vs
 * baseline 0.58m) and rebound yanks falsely loosened doors / broke zero cardetail parts at 140.
 * Stiff+overdamped (60Hz, any ratio) measured no better -- the stored spring energy itself is the
 * ejector. 8Hz/2.0 makes the coupling a genuine crumple-zone compliance: the crash stroke is
 * absorbed over the CRUSH_CORE_RECESS_M backstop distance (the recessed chassis core then stops the
 * car inelastically, chassis mass directly in the contact row) and the overdamped return leaks the
 * remainder (measured final rest at 80/120/140: 6.2/6.0/1.4m vs baseline 6.7/6.2/6.0 -- same
 * "stops at the wall" behavior; cosmetic crush curve 0.533/0.580/0.580 vs baseline
 * 0.532/0.580/0.579). At drive loads (~0.1-0.5kN) an 8Hz weld deflects single-digit millimeters
 * (measured rest-pose sag ~4-6mm), invisible for the collision proxies these bodies are. The M2
 * yield mechanic (plastic rest-frame shift) rides on top and keeps the elastic deflection small by
 * converting overload deflection into permanent crush.
 */
const SEGMENT_WELD_DAMPING_RATIO = 2;

/**
 * Per-tier weld stiffness (Hz) -- the STAGED RESISTANCE of crush-architecture.md §A, expressed as
 * compliance: outer tiers soft (they take the barrier hit DIRECTLY and would catapult if stiff --
 * see the measured rationale above), inner tiers stiff (the barrier can never reach them: the
 * crush-core backstop caps barrier advance at the core face -- initial recess 0.1m plus up to 0.48m
 * of M2 plastic retreat, geometry.ts's CRUSH_CORE_* constants -- and the rear cells/cradle/trunk
 * floor start deeper than that). A stiff cradle/trunk matters for crash DRAMA truth: the
 * engine-bay cardetail parts anchor the cradle now, and a 140km/h stop must still transmit the
 * chassis's deceleration spike into their break-threshold welds (MEASURED: with the cradle at 8Hz
 * the whole bay was so isolated that a 140km/h wall crash broke ZERO parts; at 30Hz the spike
 * shears the radiator/battery/hoses loose exactly like the solid-nose baseline did).
 */
const TIER_WELD_HERTZ: Record<SegmentWeldTier, number> = {
	beam: 8,
	frontCell: 8,
	rearCell: 15,
	cradle: 30,
	rearRail: 8,
	trunk: 30,
};

function createSegmentWeld(world: World, parentBody: Body, childBody: Body, frameAPos: V3, tier: SegmentWeldTier): WeldJoint {
	return world.createWeldJoint(parentBody, childBody, {
		frameA: { position: frameAPos, rotation: IDENTITY_Q },
		frameB: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_Q },
		collideConnected: false,
		linearHertz: TIER_WELD_HERTZ[tier],
		angularHertz: TIER_WELD_HERTZ[tier],
		linearDampingRatio: SEGMENT_WELD_DAMPING_RATIO,
		angularDampingRatio: SEGMENT_WELD_DAMPING_RATIO,
	});
}

/**
 * Creates the 9 segment bodies + their 9 chassis-anchored welds. Called from vehicle.ts's
 * createVehicle() (segments are core car assembly, like wheels/panels). Densities are exact (box
 * mass integration), so each body's mass/COM match the SegmentMassSpec the chassis deduction used.
 */
export function createSegments(world: World, chassis: Body, spawnPosition: V3, spawnRotation: Q4): SegmentAssembly {
	const bodies = {} as Record<SegmentKey, SegmentHandle>;
	for (const spec of SEGMENT_SPECS) {
		const worldPos = add(spawnPosition, rotateVector(spawnRotation, spec.center));
		const body = world.createBody({
			type: BodyType.Dynamic,
			position: worldPos,
			rotation: spawnRotation,
			isBullet: true, // same continuous-collision treatment as the chassis (CHASSIS_IS_BULLET):
			// the chain is the car's first contact at every closing speed the chassis used to absorb.
			userData: SEGMENT_ENTITY_ID[spec.key],
		});
		const volume = 8 * spec.half.x * spec.half.y * spec.half.z;
		const shape = body.createBoxShape({
			halfExtents: spec.half,
			density: spec.massKg / volume,
			friction: 0.8, // same exterior friction as the cabin shapes (vehicle.ts)
			enableHitEvents: true,
			groupIndex: CAR_GROUP_INDEX,
			categoryBits: OCCUPANT_TRANSPARENT_CATEGORY_BITS,
			userData: SEGMENT_ENTITY_ID[spec.key],
		});
		bodies[spec.key] = { key: spec.key, spec, body, shape };
	}

	const welds: SegmentWeldHandle[] = WELD_DEFS.map((def) => {
		const parentBody = def.parent === 'chassis' ? chassis : bodies[def.parent].body;
		const parentCenter = def.parent === 'chassis' ? { x: 0, y: 0, z: 0 } : segmentSpec(def.parent).center;
		const restFrameA = sub(segmentSpec(def.child).center, parentCenter);
		const childBody = bodies[def.child].body;
		return {
			key: def.key,
			tier: def.tier,
			joint: createSegmentWeld(world, parentBody, childBody, restFrameA, def.tier),
			parentBody,
			childBody,
			restFrameA,
			crushZSign: def.crushZSign,
			crushM: 0,
		};
	});

	// The crush-core backstops: chassis shapes (full chassis mass directly in the barrier's contact
	// row -- see geometry.ts's crush-core doc), occupant-transparent like the old solid nose/tail
	// volumes whose interior space they occupy. No shape userData: hit events fall back to the chassis
	// body's CAR_ENTITY_ID.chassis tag, so a core strike routes into the damage pipelines exactly like
	// a strike on the old solid hull did. NOTE createVehicle() calls createSegments() BEFORE its
	// setMassData parity stamp, so the cores' nominal shape mass is overridden with everything else.
	const mkCore = (end: 'front' | 'rear', half: CrushCoreHalf, userData: number, maxRetreatM: number): CrushCoreHandle => ({
		end,
		half,
		shape: chassis.createHullShape(buildCrushCorePoints(end, 0, half), {
			density: 1,
			friction: 0.8,
			enableHitEvents: true,
			groupIndex: CAR_GROUP_INDEX,
			categoryBits: OCCUPANT_TRANSPARENT_CATEGORY_BITS,
			userData,
		}),
		retreatM: 0,
		maxRetreatM,
	});

	return {
		bodies,
		welds,
		cores: {
			frontPos: mkCore('front', 'pos', CORE_ENTITY_ID.frontPos, CRUSH_CORE_MAX_RETREAT_FRONT_M),
			frontNeg: mkCore('front', 'neg', CORE_ENTITY_ID.frontNeg, CRUSH_CORE_MAX_RETREAT_FRONT_M),
			rear: mkCore('rear', 'full', CORE_ENTITY_ID.rear, CRUSH_CORE_MAX_RETREAT_REAR_M),
		},
		yieldState: {
			prevForwardSpeedMs: 0,
			prevLostE: 0,
			engageSteps: { pos: 0, neg: 0, rear: 0, frontChain: 0, rearChain: 0 },
			ownRatchetStreak: { front: 0, rear: 0 },
			peakForwardSpeedMs: 0,
		},
	};
}

/**
 * Teleport-reset (resetVehicle()): every segment body back to its chassis-local rest pose, zero
 * velocity; every INTACT weld's plastic state back to pristine (crushM 0, weld recreated at its rest
 * frame when it had yielded). A TORN weld stays torn -- destructive damage survives the in-place
 * reset, mirroring panels.ts's resetAttachedPanels() policy; only a full destroy+createVehicle
 * repairs it.
 */
export function resetSegments(assembly: SegmentAssembly, world: World, spawnPosition: V3, spawnRotation: Q4): void {
	for (const h of Object.values(assembly.bodies)) {
		const worldPos = add(spawnPosition, rotateVector(spawnRotation, h.spec.center));
		h.body.setTransform(worldPos, spawnRotation);
		h.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		h.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		h.body.setAwake(true);
	}
	for (const w of assembly.welds) {
		if (!w.joint) continue; // torn: stays torn (see doc comment)
		if (w.crushM !== 0) {
			w.joint.destroy();
			w.joint = createSegmentWeld(world, w.parentBody, w.childBody, w.restFrameA, w.tier);
			w.crushM = 0;
		}
	}
	// Crush cores heal on the in-place reset too (setHull back to the pristine face) -- unlike a torn
	// weld this is non-destructive state, same as the ratcheted weld frames above.
	for (const core of [assembly.cores.frontPos, assembly.cores.frontNeg, assembly.cores.rear]) {
		if (core.retreatM !== 0) {
			core.retreatM = 0;
			core.shape.setHull(buildCrushCorePoints(core.end, 0, core.half));
		}
	}
	assembly.yieldState.prevForwardSpeedMs = 0;
	assembly.yieldState.prevLostE = 0;
	assembly.yieldState.engageSteps = { pos: 0, neg: 0, rear: 0, frontChain: 0, rearChain: 0 };
	assembly.yieldState.ownRatchetStreak = { front: 0, rear: 0 };
	assembly.yieldState.peakForwardSpeedMs = 0;
}

/** Seeds every segment body with the car's launch velocity -- MUST be called by anything that
 * velocity-teleports the car (damage/scenario.ts's crashSetup(), lab/barriers.ts's
 * applyVehicleVelocity()): a rigidly-welded segment left at ~0 velocity while the chassis jumps to
 * speed is a huge artificial constraint violation on the first step (same panel gotcha crashSetup()'s
 * own doc comment records -- and under M2 it would read as a real overload and falsely yield). */
export function seedSegmentVelocities(assembly: SegmentAssembly, velocity: V3, chassis?: Body): void {
	for (const h of Object.values(assembly.bodies)) h.body.setLinearVelocity(velocity);
	// Re-baseline the directional crash gate for the teleport (stepSegmentYield's yieldState doc):
	// without this the injected speed itself reads as a one-step crash-level acceleration
	// (measured +1332 m/s^2 at an 80km/h launch) and falsely opens the gate at launch.
	if (chassis) {
		const fwd = rotateVector(chassis.getRotation(), { x: 0, y: 0, z: 1 });
		assembly.yieldState.prevForwardSpeedMs = velocity.x * fwd.x + velocity.y * fwd.y + velocity.z * fwd.z;
		assembly.yieldState.prevLostE = 0;
	}
}

/**
 * Full teardown (destroyVehicle()): every weld destroyed BEFORE its bodies, shapes before bodies --
 * the box3d-js live-handle-registry ordering every other destroy site uses (vehicle.ts's
 * destroyVehicle() doc comment). Must run BEFORE the chassis body is destroyed (the cradle/trunk
 * welds attach to it).
 */
export function destroySegments(assembly: SegmentAssembly): void {
	for (const w of assembly.welds) {
		if (w.joint) {
			w.joint.destroy();
			w.joint = null;
		}
	}
	for (const h of Object.values(assembly.bodies)) {
		h.shape.destroy(false);
		h.body.destroy();
	}
	// Core shapes live on the CHASSIS body (not destroyed here) -- explicitly destroy them so their
	// JS-side registry entries are unregistered (the same liveHandleCount() discipline as everywhere).
	assembly.cores.frontPos.shape.destroy(false);
	assembly.cores.frontNeg.shape.destroy(false);
	assembly.cores.rear.shape.destroy(false);
}

// ---------------------------------------------------------------------------------------------
// Telemetry (read-only): mechanical crush + intrusion, chassis-local. Used by the damage telemetry
// (system.ts), the Crash Lab readout, and the sim tests.
// ---------------------------------------------------------------------------------------------

function conjugate(q: Q4): Q4 {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** A segment body's current chassis-local displacement from its rest center. */
export function segmentLocalDisplacement(chassis: Body, handle: SegmentHandle): V3 {
	const t = chassis.getTransform();
	const local = rotateVector(conjugate(t.rotation), sub(handle.body.getPosition(), t.position));
	return sub(local, handle.spec.center);
}

export interface SegmentTelemetry {
	/** Mechanical front crush (m): how far the front hard structure has verifiably collapsed -- the
	 * deeper of (a) the deepest intact front segment's rearward (-z) chassis-local displacement from
	 * pristine (plastic ratchet + current elastic compression) and (b) the front core faces' plastic
	 * retreat floor. This is the real, collision-carrying shortening of the front structure. */
	frontCrushM: number;
	/** Mechanical rear crush (m): the rear-chain mirror of frontCrushM. */
	rearCrushM: number;
	/** NHTSA-style intrusion (m): the engineCradle's PERMANENT rest-pose shift toward the firewall
	 * (crush-architecture.md §A "INTRUSION METRIC": firewall-face displacement toward the seats --
	 * the cradle abuts the firewall plane, so its plastic rearward shift IS the hard structure
	 * arriving at the cabin; the occupant injury model's leg-injury line sits at ~0.15m). */
	intrusionM: number;
	/** Plastic face retreat of the crush cores (m); front = the deeper of the two half-cores (the
	 * struck side in an offset crash), per-side detail in coreRetreatFrontM. */
	coreRetreatM: { front: number; rear: number };
	/** Per-side front core retreat (m): pos = +x half, neg = -x half (offset asymmetry readout). */
	coreRetreatFrontM: { pos: number; neg: number };
	/** Per-weld accumulated plastic crush (m) -- the ratcheted permanent rest-frame shift. */
	weldCrushM: Record<SegmentWeldKey, number>;
	/** Welds torn clean off (constraint force above the tier's break threshold -- high speed only). */
	tornWelds: SegmentWeldKey[];
}

export function getSegmentTelemetry(chassis: Body, assembly: SegmentAssembly): SegmentTelemetry {
	const weldCrushM = {} as Record<SegmentWeldKey, number>;
	const tornWelds: SegmentWeldKey[] = [];
	// Deepest pristine-relative compression among each end's INTACT-weld segments (a torn segment is
	// free-flying debris, its displacement means nothing).
	let frontSeg = 0;
	let rearSeg = 0;
	for (const w of assembly.welds) {
		weldCrushM[w.key] = w.crushM;
		if (!w.joint) {
			tornWelds.push(w.key);
			continue;
		}
		const d = segmentLocalDisplacement(chassis, assembly.bodies[WELD_CHILD[w.key]]);
		const c = Math.max(0, w.crushZSign * d.z);
		if (w.crushZSign < 0) frontSeg = Math.max(frontSeg, c);
		else rearSeg = Math.max(rearSeg, c);
	}
	// Once a core face has plastically retreated, the hard structure has verifiably collapsed to
	// ~(initial recess + retreat) -- the crush metric can never read shallower than that. The recess
	// term ramps in over the first 5cm of retreat: a barely-yielding tap's permanent set is small,
	// while any real plastic collapse has taken the whole elastic zone with it.
	const coreFloor = (retreatM: number): number =>
		retreatM > 1e-3 ? CRUSH_CORE_INITIAL_RECESS_M * Math.min(1, retreatM / 0.05) + retreatM : 0;
	const frontRetreat = Math.max(assembly.cores.frontPos.retreatM, assembly.cores.frontNeg.retreatM);
	return {
		frontCrushM: Math.max(frontSeg, coreFloor(frontRetreat)),
		rearCrushM: Math.max(rearSeg, coreFloor(assembly.cores.rear.retreatM)),
		intrusionM: weldCrushM.cradle,
		coreRetreatM: { front: frontRetreat, rear: assembly.cores.rear.retreatM },
		coreRetreatFrontM: { pos: assembly.cores.frontPos.retreatM, neg: assembly.cores.frontNeg.retreatM },
		weldCrushM,
		tornWelds,
	};
}

// ---------------------------------------------------------------------------------------------
// M2 -- THE YIELD MECHANIC (crush-architecture.md §A step 2). Three coupled plastic mechanisms, all
// permanent (only a reset/rebuild heals them), all gated by the DIRECTIONAL CRASH GATE:
//
//  0. DIRECTIONAL CRASH GATE: the chassis's own per-step forward acceleration decides WHICH end may
//     yield this step -- a hard REARWARD deceleration (the car being stopped from the front) opens
//     the FRONT chain; a hard FORWARD acceleration (rear-ended / backing into a wall) opens the
//     REAR. MEASURED NECESSITY (crush-yield-measure diag, first wiring attempt): without it, the
//     rear rails' pure inertia SURGE in a 120km/h FRONTAL (12kg bodies at 33m/s deflecting their
//     compliant welds ~0.2m+ forward when the car stops) read as "barrier advance" and plastically
//     ratcheted the untouched rear chain to its 0.5m cap. Displacement alone cannot distinguish a
//     momentum surge from a genuine barrier press; the chassis's acceleration DIRECTION can.
//
//  1. CORE PLASTIC FLOW (the load-bearing, energy-staged part): on every open-gate step with the
//     face genuinely loaded, the face RETREATS by the stroke the staged plastic law prescribes for
//     the forward speed the chassis ACTUALLY LOST that step: walk the stage table from the current
//     face depth absorbing (v_before^2 - v_after^2)/2 of specific energy. Over a multi-step crash
//     this integrates to depth = recess + v^2/(2*a_staged) -- the car stops where its kinetic
//     energy is spent, total crush depth scales with impact speed, and the depth-staged a_stage
//     reproduces the reference crush-vs-speed curve MECHANICALLY. MEASURED NECESSITY of the
//     retrospective (energy-accounting) form: two forward-looking estimators failed first --
//     differencing the SEGMENTS' displacement stalls when the light beam bounces mid-collapse
//     (measured 0.15m at 120 vs 0.37 at 80: non-monotonic), and a chassis-speed servo positioning
//     the face for the NEXT step still reads v~0 at >=64km/h because the solver kills the WHOLE
//     closing speed in the single step that first presses the (still-rigid) face (measured
//     coreRetreat=0 at 64 AND 120). Accounting for the speed already removed is immune to both:
//     however the solver spent the step, the structure ends at the depth the staged law demands.
//     PER-SIDE ENGAGEMENT: the front is TWO half-width cores; each engages only when its side of
//     the bumper beam is genuinely pressed in (yaw-aware beam-end advance >= 3cm -- also the guard
//     that a false gate spike, e.g. an occupant limb-arrest jolt at speed, can never flow: driving
//     keeps the beam uncompressed). An offset barrier therefore collapses ONLY the struck half;
//     full-width barriers engage both. Implemented as rate-limited Shape.setHull (M0b machinery),
//     <=1 mutation/core/step.
//
//  2. SEGMENT RATCHET (rest-transform shift -- "the chain compresses and STAYS compressed"): each
//     segment's weld rest frame follows the deepest pose the crush has pushed it to (its own
//     measured displacement while its chain's gate is open) or that its side's core collapse implies
//     for its depth zone (carry-along from the face depth: the cradle starts moving only in a deep,
//     cradle-zone crush, bringing the cardetail engine parts toward the firewall -- and in an offset
//     crash only the STRUCK side's rail cells carry, the lab's struck-vs-intact asymmetry). Rest
//     shifts are applied by destroy+recreate of the weld at the shifted frameA (box3d welds define
//     rest pose from creation frames), rate-limited to <=1 recreate/joint/step, skipped below 2mm.
//
//  3. TEAR-OFF: a weld whose constraint force exceeds its tier's break threshold is destroyed
//     outright (segment tears off -- extreme events only; not gated, force is direction-blind).
// ---------------------------------------------------------------------------------------------

/** Elastic compression beyond the applied ratchet a segment may carry before the ratchet advances
 * (also the yield "give" a below-threshold bump stays inside -- below this nothing is permanent). */
const RATCHET_ELASTIC_ALLOWANCE_M = 0.03;

/**
 * PHASE R ADDITION (2026-07-12, terrain-drive regression found while widening CRUSH_CORE_INITIAL_
 * RECESS_M for the crash-pulse fix -- see that constant's doc comment): consecutive gate-open+touched
 * steps required before the OWN-displacement ratchet (the direct rawCompressionM() reading below) is
 * allowed to bake a segment's CURRENT displacement into a permanent plastic set. MEASURED NECESSITY
 * (sim/terrain-compound.test.mjs's connectivity drive, ordinary full-throttle heightfield driving, no
 * wall/barrier anywhere): a single sharp terrain bump/ledge produces a genuine, single-step chassis
 * deceleration spike (measured 487 m/s^2 -- comfortably past YIELD_GATE_ACCEL_MS2 and even past some
 * real LOW-speed wall-crash peaks) plus a real, near-horizontal-normal touch on the exposed bumperBeam
 * (system.ts's own |normal.y|<0.5 structural-press filter does not exclude a curb-like bump face) --
 * ONE such frame used to be enough to ratchet the beam's raw compression into a permanent 0.1m+ crush,
 * which measurably degraded the front geometry enough to send the car into an uncontrolled spin/
 * reverse a few seconds later (finalZ went from +212m to -14m over a 15s drive). A genuine wall crash
 * sustains gate-open+touched for MANY consecutive steps (the car keeps plowing into the barrier), so a
 * short debounce -- same idiom as WHEEL_DETACH_DEBOUNCE_STEPS/SLIP_OVERRIDE_DEBOUNCE_STEPS elsewhere in
 * this codebase -- filters the single-frame bump spike without measurably delaying a real crash's own
 * ratchet (re-verified: segment-yield.test.mjs's crush-vs-speed bands are unaffected by this streak,
 * since a real crash re-crosses the debounce within 1-2 steps and the CORE's own energy-based retreat,
 * which drives the bulk of frontCrushM, is untouched by this gate -- only the segments' direct-
 * displacement ratchet is debounced). The CORE plastic flow (part 1 above) is deliberately NOT gated by
 * this streak: it already requires genuine CORE-shape contact evidence (coreHits.pos/neg/rear, not just
 * any chain segment), which a shallow bump practically never reaches (the core sits CRUSH_CORE_INITIAL_
 * RECESS_M behind the exposed segments).
 */
const OWN_RATCHET_DEBOUNCE_STEPS = 2;
/** Per-weld, per-step plastic growth cap (rate limit; keeps depenetration pops impossible). */
const MAX_RATCHET_STEP_M = 0.08;
/** Don't destroy+recreate a weld for a sub-2mm rest shift (recreate-churn guard). */
const MIN_APPLY_DELTA_M = 0.002;

/** Per-weld total plastic crush cap (m): how far each segment's rest pose may permanently shift.
 * Head segments span (almost) the whole crushable depth; deeper segments less (they start moving
 * only once the barrier advance reaches their zone -- see RATCHET_ZONE_START_M). */
const SEGMENT_TOTAL_CRUSH_CAP_M: Record<SegmentWeldKey, number> = {
	beam: 0.55,
	cellFL: 0.34,
	cellFR: 0.34,
	cellRL: 0.3,
	cellRR: 0.3,
	cradle: 0.17,
	trunk: 0.12,
	rearL: 0.5,
	rearR: 0.5,
};

// ---------------------------------------------------------------------------------------------
// EXTREME TIER (Stream C slice C2, 2026-07-12): additional FRONT-only plastic-crush headroom for
// the 100-200mph reference footage (crush to the A-pillar; 120mph+ cabin collapse beginning).
// ADDITIVE and SPEED-GATED on the same gate/full-scale speeds as damage-tuning.ts's
// chassisSpeedCrushCapM() (24 / 45 m/s) so the mechanical (this file) and cosmetic (crumple.ts)
// extreme tiers engage together. Every helper below returns EXACTLY today's NCAP-tier constant at
// or under EXTREME_GATE_SPEED_MS -- the ≤80 km/h (22.2 m/s) calibrated matrix is untouched (see
// sim/extreme-tier.test.mjs's guard-pin test).
//
// GATED ON PEAK SPEED, NOT CURRENT SPEED: by the time a 322 km/h crash has crushed even 0.3m the
// chassis has already decelerated well below the gate (the whole point of a crash), so gating on
// the CURRENT forward speed would shut the extreme tier back off mid-collapse, exactly when the
// stage table needs the extra budget most. assembly.yieldState.peakForwardSpeedMs (updated every
// step below, reset alongside the rest of yieldState in resetSegments()) tracks the fastest this
// chassis has moved since spawn/reset -- the crash-setup convention in this codebase is to launch
// the car directly at its target closing speed (damage/scenario.ts's crashSetup(), lab/barriers.ts)
// rather than accelerate it there, so the peak is set (at, or within one step of, the launch) before
// any contact, and holds for the whole crash.
//
// FRONT-ONLY SCOPE: the reference footage + this slice's verify target are all frontal impacts;
// rear segments/cores keep their NCAP-tier caps unchanged (no extreme entry -> no behavior change).
// ---------------------------------------------------------------------------------------------
/**
 * MEASURED REGRESSION + FIX (2026-07-12): this MECHANICAL gate deliberately does NOT match
 * damage-tuning.ts's cosmetic CRUMPLE_EXTREME_GATE_MS (24 m/s) -- a first attempt reused 24 m/s here
 * too and broke sim/segment-yield.test.mjs's calibrated 120 km/h (33.3 m/s) reference-band assertion
 * (crash-deformation-reference.md's own "120 km/h ~0.50-0.58m capped" row -- measured 0.833m instead
 * of the pinned [0.55,0.64] band). 120 km/h is ABOVE this slice's hard "<=80 km/h byte-identical"
 * floor but is still part of the existing calibrated-matrix test suite ("full suite green" is a hard
 * requirement too), so the MECHANICAL tier's gate is raised to 35 m/s -- comfortably above 120 km/h's
 * 33.33 m/s (extremeT()=0 there, exactly, no change) while still well below the 161 km/h (44.7 m/s)
 * floor this tier must reach. (The COSMETIC/crumple.ts tier keeps its 24 m/s gate per this slice's
 * brief -- that metric has no equivalent 120 km/h band pinned anywhere in the suite.)
 */
const EXTREME_GATE_SPEED_MS = 35;
/** MEASURED (extreme-tier probe): (a) 161 km/h (44.7 m/s) must already reach >=1.0m frontCrushM (the
 * reference's "crush to the A-pillar" floor) and (b) 193/322 km/h must read strictly deeper than 161,
 * both of which a too-high full-scale speed defeats. 55 m/s (paired with the 35 m/s gate above) puts
 * 161/193 km/h (44.7/53.6 m/s) on the steep, still-increasing part of the ramp (measured 1.116m /
 * 1.561m) while 322 km/h (89.4 m/s, past the 55 m/s full-scale point) saturates at the ceiling
 * (measured 1.63m) -- still strictly the deepest of the three, satisfying the reference's "200mph
 * reads more destroyed than 120mph" ordering. */
const EXTREME_FULL_SPEED_MS = 55;

/** Additional front-core plastic-retreat headroom (m) at full extreme scale, on top of
 * CRUSH_CORE_MAX_RETREAT_FRONT_M (0.48) -- so a fully-engaged extreme crash reaches ~1.0m of front
 * CORE retreat (+ the 0.15m initial recess = ~1.15m mechanical crush from the core alone, before the
 * segment-ratchet carry-along, comfortably reaching structuralCrush.ts's cabin-extension gate). */
const CORE_MAX_RETREAT_FRONT_EXTREME_M = 1.0;

/** Additional per-weld plastic-crush headroom (m) at full extreme scale, front-chain welds only
 * (beam/cellFL/cellFR/cradle) -- rear/trunk/rearL/rearR have no entry, i.e. zero extra headroom. */
const SEGMENT_EXTREME_CRUSH_CAP_M: Partial<Record<SegmentWeldKey, number>> = {
	beam: 0.85, // 0.55 base -> 1.4m total
	cellFL: 0.35, // 0.34 base -> 0.69m total
	cellFR: 0.35,
	cradle: 0.2, // 0.17 base -> 0.37m total
};

/** 0 at/under EXTREME_GATE_SPEED_MS, ramps linearly to 1 by EXTREME_FULL_SPEED_MS. */
function extremeT(peakSpeedMs: number): number {
	if (peakSpeedMs <= EXTREME_GATE_SPEED_MS) return 0;
	return Math.min(1, (peakSpeedMs - EXTREME_GATE_SPEED_MS) / (EXTREME_FULL_SPEED_MS - EXTREME_GATE_SPEED_MS));
}

/** Speed-gated front-core retreat ceiling: CRUSH_CORE_MAX_RETREAT_FRONT_M at/under the gate,
 * ramping toward +CORE_MAX_RETREAT_FRONT_EXTREME_M above it. */
function coreMaxRetreatFrontM(peakSpeedMs: number): number {
	return CRUSH_CORE_MAX_RETREAT_FRONT_M + extremeT(peakSpeedMs) * CORE_MAX_RETREAT_FRONT_EXTREME_M;
}

/** Speed-gated per-weld crush cap: SEGMENT_TOTAL_CRUSH_CAP_M[key] at/under the gate (byte-identical
 * -- no extremeT() multiply even evaluated when the weld has no extreme entry), ramping toward
 * +SEGMENT_EXTREME_CRUSH_CAP_M[key] above it for front-chain welds. */
function segmentCrushCapM(key: SegmentWeldKey, peakSpeedMs: number): number {
	const extra = SEGMENT_EXTREME_CRUSH_CAP_M[key];
	if (extra === undefined) return SEGMENT_TOTAL_CRUSH_CAP_M[key];
	return SEGMENT_TOTAL_CRUSH_CAP_M[key] + extremeT(peakSpeedMs) * extra;
}

/** FACE depth (m: initial recess + plastic retreat of the segment's side's core) at which each
 * segment's carry-along ratchet starts moving it: its front face's recession behind the bumper/tail
 * contact face (beam moves from the first collapse millimeter; the cradle only in a deep,
 * cradle-zone crush -- which is what carries the engine-bay cardetail parts toward the firewall in
 * big hits, crush-architecture.md §A "INTERACTIONS"). */
const RATCHET_ZONE_START_M: Record<SegmentWeldKey, number> = {
	beam: CRUSH_CORE_INITIAL_RECESS_M,
	cellFL: 0.29,
	cellFR: 0.29,
	cellRL: 0.41,
	cellRR: 0.41,
	cradle: 0.49,
	trunk: 0.45,
	rearL: CRUSH_CORE_INITIAL_RECESS_M,
	rearR: CRUSH_CORE_INITIAL_RECESS_M,
};

/** Weld tear-off thresholds (N) per tier -- extreme events only. NOTE the overdamped weld's reported
 * constraint force includes its large DAMPING term (measured: a clean 56km/h frontal already spikes
 * the beam weld past 25kN purely from the closing-rate damping force), so these sit far above every
 * measured clean-frontal peak (140km/h inclusive) -- a tear should mean violent oblique/secondary
 * loading ripping a segment off, not a routine protocol run. The cradle/trunk (the car's heart)
 * never tear. */
const TIER_BREAK_FORCE_N: Record<SegmentWeldTier, number> = {
	beam: 120_000,
	frontCell: 90_000,
	rearCell: 90_000,
	cradle: Number.POSITIVE_INFINITY,
	rearRail: 100_000,
	trunk: Number.POSITIVE_INFINITY,
};

/**
 * Staged plastic resistance of the crush structure: the deceleration (m/s^2) the car sustains while
 * a core face is collapsing at the given total face depth (initial recess + retreat) -- the classic
 * crumple force-vs-crush shape (buckling plateau, then stiffer rail cells, then densification),
 * tiered so the beam zone gives first and the cradle/engine zone resists hardest
 * (crush-architecture.md §A "STAGED RESISTANCE"). CALIBRATED from the energy identity
 * depth = recess + v^2/(2*a) against the reference bands' targets (40km/h ~0.27m, 56 ~0.40m,
 * 64 ~0.47m, 80 ~0.55m, 120+ -> 0.58m clamp) -- the measured curve is asserted by
 * sim/segment-yield.test.mjs.
 */
const CORE_STAGE_DECEL_MS2: readonly { maxDepthM: number; decelMs2: number }[] = [
	{ maxDepthM: 0.35, decelMs2: 325 }, // beam + bumper structure collapsing (~33g)
	{ maxDepthM: 0.51, decelMs2: 470 }, // rail cells buckling (~48g)
	{ maxDepthM: Number.POSITIVE_INFINITY, decelMs2: 1000 }, // densification: engine mass at the firewall
];

/** The stroke (m) the staged plastic law prescribes for absorbing the given specific energy
 * (m^2/s^2, i.e. (v_before^2 - v_after^2)/2) starting from face depth `depth0` -- walks the stage
 * table so a single big step spanning a stage boundary is integrated piecewise. */
function stageStrokeM(depth0: number, specificEnergy: number): number {
	let depth = depth0;
	let e = specificEnergy;
	let stroke = 0;
	for (const st of CORE_STAGE_DECEL_MS2) {
		if (depth > st.maxDepthM) continue;
		const room = st.maxDepthM - depth;
		const need = e / st.decelMs2;
		if (need <= room) return stroke + need;
		stroke += room;
		e -= room * st.decelMs2;
		depth = st.maxDepthM;
	}
	return stroke;
}

/** Directional crash gate (m/s^2): per-step chassis forward-acceleration magnitude that opens a
 * chain's yield. Hard braking measures ~12 m/s^2 and the hardest measured non-crash jolts (occupant
 * limb-arrest spikes, kicker landings) are shorter AND leave the beam uncompressed (see the beam-
 * compression engagement floor); genuine wall crashes measure 300+ m/s^2 on the first contact step. */
const YIELD_GATE_ACCEL_MS2 = 25;
/** Rear-chain engagement floor: the rear core also engages when a rear rail is genuinely pressed
 * in at least this far (backing into a wall too softly for a hit event). */
const CORE_ENGAGE_ADVANCE_M = 0.03;
/** Steps a core stays ENGAGED after a barrier hit event touched its shape. Hit events fire on
 * contact IMPACTS, not on every sustained-press step, and the face's own setHull mutations churn
 * the contact -- the latch bridges those gaps while the gate is open. */
const CORE_ENGAGE_LATCH_STEPS = 10;
/** Sanity cap on a single step's face retreat. Generous: a one-step 120km/h kill legitimately owes
 * the face nearly the whole budget in one step (see the section doc); retreat only ever REMOVES
 * collision material, so a large single-step retreat cannot depenetration-pop anything. */
const CORE_MAX_RETREAT_STEP_M = 0.5;

/** EXTREME TIER (Stream C C2) MEASURED NECESSITY: a rigid-barrier crash at 161-322 km/h has the car's
 * OWN bullet-CCD kill essentially the entire closing speed in the single step the TOI lands on (the
 * same "one-step 120km/h kill" phenomenon CORE_MAX_RETREAT_STEP_M's doc above already describes, just
 * far more extreme) -- measured directly (extreme-tier probe): with only coreMaxRetreatFrontM()
 * raising the CEILING, frontCrushM plateaued at an IDENTICAL 0.650m at 161/193/322 km/h, because
 * every one of those crashes' lostE arrives in that first step and CORE_MAX_RETREAT_STEP_M's flat
 * 0.5m/step rate limit was the actual bottleneck, not the ceiling -- subsequent steps had ~zero
 * further speed to lose (the car was already stopped/rebounding), so the extra ceiling headroom was
 * never reached. Extending the PER-STEP rate in lockstep with the ceiling (same extremeT() gate) lets
 * that single mega-step actually spend the stage-table's (now much larger) energy debt in one shot --
 * still safe (the depenetration-pop argument above is speed-independent: retreat only ever removes
 * material). Gated identically to coreMaxRetreatFrontM(): zero effect at/under 24 m/s. */
const CORE_MAX_RETREAT_STEP_EXTREME_M = 1.0;

function coreMaxRetreatStepM(peakSpeedMs: number): number {
	return CORE_MAX_RETREAT_STEP_M + extremeT(peakSpeedMs) * CORE_MAX_RETREAT_STEP_EXTREME_M;
}

export interface SegmentYieldEvent {
	type: 'segmentWeldTorn';
	weld: SegmentWeldKey;
}

/** Raw (pristine-relative) crush-axis compression of one segment: how far it currently sits
 * displaced along its crush direction, chassis-local. */
function rawCompressionM(chassis: Body, assembly: SegmentAssembly, key: SegmentKey, crushZSign: 1 | -1): number {
	const d = segmentLocalDisplacement(chassis, assembly.bodies[key]);
	return Math.max(0, crushZSign * d.z);
}

/** Which crush structure this step's drained hit events touched (system.ts matches the segment/core
 * entity ids against the hit userData while draining world.hitEvents() -- the drain happens before
 * stepSegmentYield runs, same fixed step). pos/neg/rear = the CORE shapes specifically (a barrier
 * genuinely at a face); frontChain/rearChain = ANY of that chain's segment or core shapes (the
 * contact evidence the ratchet requires -- a chain nothing touched cannot be crushing, however its
 * light bodies surge; see the section doc's gate rationale). */
export interface CoreHitFlags {
	pos: boolean;
	neg: boolean;
	rear: boolean;
	frontChain: boolean;
	rearChain: boolean;
}

/**
 * Advances the yield mechanic by one fixed step. Call AFTER world.step() (constraint forces + body
 * poses reflect this step's solve) -- wired into the damage system's stepDamageSystem().
 */
export function stepSegmentYield(world: World, chassis: Body, assembly: SegmentAssembly, coreHits: CoreHitFlags): SegmentYieldEvent[] {
	const events: SegmentYieldEvent[] = [];
	const dt = FIXED_DT;

	// ---- 0. Directional crash gate (see the section doc above). ----
	const t = chassis.getTransform();
	const fwd = rotateVector(t.rotation, { x: 0, y: 0, z: 1 });
	const vel = chassis.getLinearVelocity();
	const vFwd = vel.x * fwd.x + vel.y * fwd.y + vel.z * fwd.z;
	const accelFwd = (vFwd - assembly.yieldState.prevForwardSpeedMs) / dt;
	assembly.yieldState.prevForwardSpeedMs = vFwd;
	// EXTREME TIER (Stream C C2): track the fastest this chassis has moved since spawn/reset -- see
	// this file's EXTREME_GATE_SPEED_MS section doc for why PEAK (not current) speed gates the tier.
	if (Math.abs(vFwd) > assembly.yieldState.peakForwardSpeedMs) assembly.yieldState.peakForwardSpeedMs = Math.abs(vFwd);
	const frontGate = accelFwd < -YIELD_GATE_ACCEL_MS2;
	const rearGate = accelFwd > YIELD_GATE_ACCEL_MS2;

	// ---- 1. Core plastic flow. ----
	// Per-core engagement latch: a barrier hit event on a core's OWN shape (this step or within the
	// last CORE_ENGAGE_LATCH_STEPS) is the evidence that THAT face is the one being pressed -- the
	// offset-crash discriminator (the struck half-core is hit, the intact one never is) and the
	// false-gate-spike guard (an occupant limb jolt at speed produces no core contact at all).
	const eng = assembly.yieldState.engageSteps;
	// Specific energy (m^2/s^2) the chassis's forward motion lost THIS step -- what the staged
	// plastic law converts into face retreat (section doc: retrospective energy accounting).
	const prevV = vFwd - accelFwd * dt; // == last step's vFwd, reconstructed
	const lostE = frontGate ? Math.max(0, (prevV * prevV - Math.max(0, vFwd) * Math.max(0, vFwd)) / 2) : rearGate ? Math.max(0, (prevV * prevV - Math.min(0, vFwd) * Math.min(0, vFwd)) / 2) : 0;
	// ONE-STEP RETRO-CREDIT (measured, step-trace diag): the chassis is a bullet body, so at highway
	// speeds continuous collision catches the wall-vs-core TOI MID-step -- the big inelastic kill
	// lands one fixed step BEFORE the contact's hit event reaches the drain. When a core's latch
	// first arms, credit the previous gated step's loss too, or the kill step's energy (the majority
	// of a >=80km/h crash) silently vanishes from the plastic law.
	const firstEngage = { pos: coreHits.pos && eng.pos === 0, neg: coreHits.neg && eng.neg === 0, rear: coreHits.rear && eng.rear === 0 };
	const prevLostE = assembly.yieldState.prevLostE;
	assembly.yieldState.prevLostE = lostE;
	// EXTREME TIER (Stream C C2): the per-step retreat rate cap also ramps with peak speed (see
	// CORE_MAX_RETREAT_STEP_EXTREME_M's doc comment -- MEASURED NECESSITY, the ceiling alone was not
	// enough). Safe to apply uniformly to both front AND rear cores: rear's own ceiling
	// (CRUSH_CORE_MAX_RETREAT_REAR_M, unchanged/not extreme-tiered) still bounds `give` via
	// `ceilingM - core.retreatM` regardless of how large the step-rate cap is.
	const stepCapM = coreMaxRetreatStepM(assembly.yieldState.peakForwardSpeedMs);
	const flowCore = (core: CrushCoreHandle, engaged: boolean, retroCredit: boolean, ceilingM: number): void => {
		const e = lostE + (retroCredit ? prevLostE : 0);
		if (!engaged || core.retreatM >= ceilingM || e <= 0) return;
		const faceDepthM = CRUSH_CORE_INITIAL_RECESS_M + core.retreatM;
		const give = Math.min(stageStrokeM(faceDepthM, e), stepCapM, ceilingM - core.retreatM);
		if (give <= 1e-4) return;
		core.retreatM += give;
		core.shape.setHull(buildCrushCorePoints(core.end, core.retreatM, core.half)); // <=1 mutation/core/step
	};
	// EXTREME TIER (Stream C C2): front cores get the speed-gated ceiling (identical to
	// CRUSH_CORE_MAX_RETREAT_FRONT_M at/under the gate); rear keeps its NCAP-tier cap unchanged
	// (see this file's EXTREME_GATE_SPEED_MS section doc -- front-only scope).
	const frontCeilingM = coreMaxRetreatFrontM(assembly.yieldState.peakForwardSpeedMs);
	if (frontGate) {
		flowCore(assembly.cores.frontPos, coreHits.pos || eng.pos > 0, firstEngage.pos, frontCeilingM);
		flowCore(assembly.cores.frontNeg, coreHits.neg || eng.neg > 0, firstEngage.neg, frontCeilingM);
	} else if (rearGate) {
		// Rear: the core-hit latch, or -- while genuinely BACKING (vFwd < -0.5) with rear-chain
		// contact evidence -- the rear rails pressed in (a below-hit-threshold sustained press).
		const rearAdv = Math.max(
			rawCompressionM(chassis, assembly, 'rearRailL', 1),
			rawCompressionM(chassis, assembly, 'rearRailR', 1),
		);
		const backingPress = vFwd < -0.5 && (coreHits.rearChain || eng.rearChain > 0) && rearAdv >= CORE_ENGAGE_ADVANCE_M;
		flowCore(assembly.cores.rear, coreHits.rear || eng.rear > 0 || backingPress, firstEngage.rear, CRUSH_CORE_MAX_RETREAT_REAR_M);
	}
	// Latch refresh AFTER the flow (firstEngage above needs the pre-hit latch value).
	eng.pos = coreHits.pos ? CORE_ENGAGE_LATCH_STEPS : Math.max(0, eng.pos - 1);
	eng.neg = coreHits.neg ? CORE_ENGAGE_LATCH_STEPS : Math.max(0, eng.neg - 1);
	eng.rear = coreHits.rear ? CORE_ENGAGE_LATCH_STEPS : Math.max(0, eng.rear - 1);
	eng.frontChain = coreHits.frontChain ? CORE_ENGAGE_LATCH_STEPS : Math.max(0, eng.frontChain - 1);
	eng.rearChain = coreHits.rearChain ? CORE_ENGAGE_LATCH_STEPS : Math.max(0, eng.rearChain - 1);

	// OWN-displacement ratchet debounce (see OWN_RATCHET_DEBOUNCE_STEPS's doc comment): count
	// CONSECUTIVE gate-open+touched steps per end, reset the instant either condition drops.
	const streak = assembly.yieldState.ownRatchetStreak;
	const frontTouchedNow = coreHits.frontChain || eng.frontChain > 0;
	const rearTouchedNow = coreHits.rearChain || eng.rearChain > 0;
	streak.front = frontGate && frontTouchedNow ? streak.front + 1 : 0;
	streak.rear = rearGate && rearTouchedNow ? streak.rear + 1 : 0;

	// ---- 2 + 3. Segment ratchet + tear-off, per weld. ----
	const faceDepth = (core: CrushCoreHandle): number => CRUSH_CORE_INITIAL_RECESS_M + core.retreatM;
	const frontDepthPos = faceDepth(assembly.cores.frontPos);
	const frontDepthNeg = faceDepth(assembly.cores.frontNeg);
	const rearDepth = faceDepth(assembly.cores.rear);
	/** The face depth that drives each weld's carry-along: rail cells follow THEIR side's half-core
	 * (cellFL/cellRL = the +x rail = the 'pos' half; cellFR/cellRR mirror), full-width members the
	 * deeper of the two. */
	const carryDepth: Record<SegmentWeldKey, number> = {
		beam: Math.max(frontDepthPos, frontDepthNeg),
		cellFL: frontDepthPos,
		cellRL: frontDepthPos,
		cellFR: frontDepthNeg,
		cellRR: frontDepthNeg,
		cradle: Math.max(frontDepthPos, frontDepthNeg),
		trunk: rearDepth,
		rearL: rearDepth,
		rearR: rearDepth,
	};
	for (const w of assembly.welds) {
		if (!w.joint) continue;
		// Tear-off first: a torn weld's segment is free -- no rest frame left to ratchet.
		const forceN = length(w.joint.getConstraintForce());
		if (forceN > TIER_BREAK_FORCE_N[w.tier]) {
			w.joint.destroy();
			w.joint = null;
			events.push({ type: 'segmentWeldTorn', weld: w.key });
			continue;
		}
		// OWN-displacement ratchet only while this chain's gate is open AND something has actually
		// TOUCHED the chain recently (the contact-evidence latch): a segment's own displacement during
		// an opposite-end crash -- including the rebound phase, whose sign flip briefly opens the
		// OTHER gate while the chains are still surge-compressed (measured: a 120km/h frontal falsely
		// ratcheted the untouched rear rails 0.08m via exactly that) -- is momentum surge, not
		// structural collapse. The CARRY term (the face-depth debt) keeps applying for as long as the
		// touch latch lives: a >=80km/h kill collapses the core in 1-3 gated steps, and the
		// rate-limited rest-shifts need a few more steps to catch up to the already-collapsed face
		// (measured: cells froze at one 0.08 rate-step of their 0.34 debt without this).
		const gateOpen = w.crushZSign < 0 ? frontGate : rearGate;
		const touched = w.crushZSign < 0 ? coreHits.frontChain || eng.frontChain > 0 : coreHits.rearChain || eng.rearChain > 0;
		if (!touched) continue;
		const childKey = WELD_CHILD[w.key];
		// OWN_RATCHET_DEBOUNCE_STEPS (Phase R): the direct raw-displacement reading only bakes in once
		// gate-open+touched has held for >=N consecutive steps (see that constant's doc comment) --
		// filters a single-frame terrain-bump spike without delaying a real (multi-step) crash.
		const ownStreakOk = (w.crushZSign < 0 ? streak.front : streak.rear) >= OWN_RATCHET_DEBOUNCE_STEPS;
		const own = gateOpen && ownStreakOk ? rawCompressionM(chassis, assembly, childKey, w.crushZSign) - RATCHET_ELASTIC_ALLOWANCE_M : 0;
		const carry = carryDepth[w.key] - RATCHET_ZONE_START_M[w.key];
		// EXTREME TIER (Stream C C2): segmentCrushCapM() replaces the flat SEGMENT_TOTAL_CRUSH_CAP_M
		// read -- identical for welds with no extreme entry (rear/trunk) or at/under the speed gate.
		const target = Math.min(Math.max(w.crushM, own, carry), segmentCrushCapM(w.key, assembly.yieldState.peakForwardSpeedMs));
		const applied = Math.min(target, w.crushM + MAX_RATCHET_STEP_M);
		if (applied - w.crushM < MIN_APPLY_DELTA_M) continue;
		w.crushM = applied;
		// Shift the REST transform toward the loaded pose: destroy + recreate at the shifted frameA
		// (box3d welds define their rest pose from the frames at creation) -- <=1 recreate/joint/step.
		const shifted: V3 = { x: w.restFrameA.x, y: w.restFrameA.y, z: w.restFrameA.z + w.crushZSign * w.crushM };
		w.joint.destroy();
		w.joint = createSegmentWeld(world, w.parentBody, w.childBody, shifted, w.tier);
	}

	return events;
}

/** weld key -> the segment it holds (the WELD_DEFS child), for the ratchet's displacement reads. */
const WELD_CHILD: Record<SegmentWeldKey, SegmentKey> = {
	cradle: 'engineCradle',
	cellRL: 'crushRailLR',
	cellRR: 'crushRailRR',
	cellFL: 'crushRailLF',
	cellFR: 'crushRailRF',
	beam: 'bumperBeam',
	trunk: 'trunkFloor',
	rearL: 'rearRailL',
	rearR: 'rearRailR',
};
