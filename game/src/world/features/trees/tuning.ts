// SPDX-License-Identifier: MIT
//
// Physics/placement tuning for the 'trees' world feature (3 size classes: sapling/mid/large).
// Renderer-free (no three/DOM import) -- shared verbatim by the browser feature (./index.ts) and the
// headless sim test (game/sim/features-trees.test.mjs), same convention as world/tuning.ts.
//
// ZONE (orchestrator contract): west side x < -30, plus a sparse far line at x > 60. Every position
// below keeps >=15m clearance (edge-to-edge, conservatively measured on x alone since that's the
// tightest axis) from the nearest existing body: wall-left's block extent is x in [-23.5,-20.5]
// (world/tuning.ts's WALL_CONFIGS 'wall-left' center x=-22, WALL_COLS=6 blocks * ~0.51m step ~= 3.06m
// wide) and the west-most pole sits at x=-19 (world/tuning.ts's POLE_POSITIONS) -- so -23.5 is the
// true nearest edge. The closest tree x used below is -42 (sapling slalom), giving -42-(-23.5) =
// 18.5m clearance. Large/mid trees sit further out (x<=-55) for extra margin. The far line (x>=64)
// clears wall-right/barrel-triangle (nearest edge ~23.5m) by 40+m. Nothing here touches |x|<20 (the
// main drive corridor) or the kicker approach lane (x=0, z up to ~45).

import { IDENTITY_Q, type Q4, type V3 } from '../../../vehicle/mathUtil';

export { IDENTITY_Q };
export type { Q4, V3 };

export interface TreeSiteXZ {
	readonly x: number;
	readonly z: number;
}

// ---------------------------------------------------------------------------------------------
// Sapling: 1 dynamic capsule trunk body, root pinned to a static anchor by a spherical joint
// (cone limit + spring -- bends under push), joint force/torque threshold snaps it at moderate
// impact (see bodies.ts's pollSaplingBreaks()). A slalom line -- fun to weave through at low speed,
// each one topples if actually driven into.
// ---------------------------------------------------------------------------------------------

export const SAPLING_TRUNK_RADIUS_M = 0.07;
export const SAPLING_TRUNK_HEIGHT_M = 2.2;
export const SAPLING_MASS_KG = 9;
export const SAPLING_FRICTION = 0.6;

/** Cone half-angle (radians) the spherical joint allows before the limit engages -- ~31 degrees. */
export const SAPLING_CONE_LIMIT_RAD = 0.55;
export const SAPLING_SPRING_HERTZ = 2.2;
export const SAPLING_SPRING_DAMPING_RATIO = 0.6;

/** Break thresholds (constraint force/torque magnitude, polled per-step like welds.ts) -- calibrated
 * empirically (game/sim/features-trees.test.mjs) so idle settling/gentle bumps never break it, but a
 * ~30km/h+ car impact reliably does. */
export const SAPLING_FORCE_THRESHOLD_N = 6000;
export const SAPLING_TORQUE_THRESHOLD_NM = 2500;

export const SAPLING_SITES: readonly TreeSiteXZ[] = [
	{ x: -42, z: 6 },
	{ x: -48, z: 14 },
	{ x: -42, z: 22 },
	{ x: -48, z: 30 },
	{ x: -42, z: 38 },
	{ x: -48, z: 46 },
];

// ---------------------------------------------------------------------------------------------
// Mid tree: single heavy dynamic trunk (200-400kg), root WELD joint with a HIGH break threshold --
// only a fast car fells it, and the falling trunk is itself dangerous (stays live physics debris,
// per the spec's "broken stumps stay ... despawn-safe either way": we simply never despawn it).
// ---------------------------------------------------------------------------------------------

export const MID_TRUNK_RADIUS_M = 0.35;
export const MID_TRUNK_HEIGHT_M = 6.5;
export const MID_MASS_KG = 320;
export const MID_FRICTION = 0.7;

export const MID_WELD_LINEAR_HERTZ = 0; // 0 = rigid (max stiffness) until it breaks
export const MID_WELD_ANGULAR_HERTZ = 0;
export const MID_WELD_DAMPING_RATIO = 1;

/** HIGH relative to the sapling's -- survives everyday bumps/glancing hits, breaks under a genuinely
 * fast (~80km/h) frontal impact. Calibrated empirically (game/sim/features-trees.test.mjs). */
export const MID_FORCE_THRESHOLD_N = 260_000;
export const MID_TORQUE_THRESHOLD_NM = 140_000;

export const MID_SITES: readonly TreeSiteXZ[] = [
	{ x: -55, z: 20 },
	{ x: -60, z: 35 },
	{ x: -55, z: 50 },
	{ x: -60, z: 65 },
];

// ---------------------------------------------------------------------------------------------
// Large tree: STATIC trunk (the deliberately-immovable anchor -- stops the car dead) + 2-3 welded
// DYNAMIC branches that break off on impact for drama. One branch always points toward -z (the
// direction a car driving +z through this zone approaches from), at bumper height, so a head-on
// hit into the trunk also directly strikes that branch.
// ---------------------------------------------------------------------------------------------

export const LARGE_TRUNK_RADIUS_M = 0.6;
export const LARGE_TRUNK_HEIGHT_M = 10;
export const LARGE_TRUNK_FRICTION = 0.8;

export const LARGE_BRANCH_RADIUS_M = 0.12;
export const LARGE_BRANCH_LENGTH_M = 1.6;
export const LARGE_BRANCH_MASS_KG = 15;
export const LARGE_BRANCH_FRICTION = 0.6;

/** Attachment height (m, above trunk base) and yaw (degrees about world +Y; direction(yaw) =
 * (cos(yaw), 0, -sin(yaw)) -- see bodies.ts's branchDirection()). Branch 0 (yaw=90 -> direction
 * (0,0,-1), i.e. pointing toward WORLD -Z) sits at ~1.0m -- within the car's hull envelope (roof at
 * world y ~= CAR_HEIGHT_M = 1.149m, see vehicle/tuning.ts -- an earlier draft used 1.6m, which sailed
 * clean over the roofline and never actually touched the car, so the branch never took a hit; caught
 * empirically via game/sim/features-trees.test.mjs's large-tree case reporting anyBranchBroken=false
 * despite a confirmed trunk collision) -- on the side a car driving +Z through this zone approaches
 * FROM, so a head-on hit into the trunk clips this branch first/at the same time. Branches 1-2 sit
 * higher, purely for visual variety (not required to ever be struck). */
export const LARGE_BRANCH_LAYOUT: readonly { heightM: number; yawDeg: number }[] = [
	{ heightM: 1.0, yawDeg: 90 },
	{ heightM: 3.2, yawDeg: 210 },
	{ heightM: 4.8, yawDeg: 330 },
];

export const LARGE_WELD_LINEAR_HERTZ = 0;
export const LARGE_WELD_ANGULAR_HERTZ = 0;
export const LARGE_WELD_DAMPING_RATIO = 1;

/** LOWER than the mid tree's trunk weld -- branches are meant to snap off readily on any real
 * impact. Calibrated empirically (game/sim/features-trees.test.mjs). */
export const LARGE_BRANCH_FORCE_THRESHOLD_N = 30_000;
export const LARGE_BRANCH_TORQUE_THRESHOLD_NM = 12_000;

export const LARGE_SITES: readonly TreeSiteXZ[] = [
	{ x: -66, z: 12 },
	{ x: -70, z: 40 },
	{ x: -66, z: 68 },
];

// ---------------------------------------------------------------------------------------------
// Far line (x > 60), sparse, one of each class -- per the orchestrator's "optionally a sparse far
// line at x > 60".
// ---------------------------------------------------------------------------------------------

export const FAR_SAPLING_SITES: readonly TreeSiteXZ[] = [{ x: 64, z: 20 }];
export const FAR_MID_SITES: readonly TreeSiteXZ[] = [{ x: 72, z: 45 }];
export const FAR_LARGE_SITES: readonly TreeSiteXZ[] = [{ x: 80, z: 70 }];

// ---------------------------------------------------------------------------------------------
// Seeded RNG for purely cosmetic jitter (canopy color/scale/yaw) -- deterministic, no Math.random
// (feature contract's warning #3). Same mulberry32 algorithm as world/materials.ts's own local copy
// (that file's doc comment: "this module's own small noise helper mirrors that file's algorithm" --
// small-helper duplication, not cross-import, is the established convention here).
// ---------------------------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const TREES_RNG_SEED = 0x7ee5; // 'TREES' pun, deterministic across every reset
