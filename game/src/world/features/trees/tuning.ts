// SPDX-License-Identifier: MIT
//
// Physics/placement tuning for the 'trees' world feature (3 size classes: sapling/mid/large).
// Renderer-free (no three/DOM import) -- shared verbatim by the browser feature (./index.ts) and the
// headless sim test (game/sim/features-trees.test.mjs), same convention as world/tuning.ts.
//
// ZONE (terrain overhaul): a real FOREST on the west side, inside the terrain's hard-flat FOREST zone
// (world/terrain/heightfield.ts's FOREST rect, x in [-186,-46]) so every trunk -- which spawns at y=0
// (bodies.ts) -- sits exactly on the flat forest floor. Sites are a DETERMINISTIC Poisson-disc scatter
// (fixed seed, min-spacing rejection) across x in [-172,-58], z in [-58,118], split first-N into the
// three size classes, plus a sparse far treeline at x ~ -180 for backdrop depth. Min spacing 6.5m keeps
// trunks from overlapping while leaving weave-through gaps. Nothing here touches the apron (|x|<36), the
// dirt-road loop (centred x=0,z=125), or the east buildings zone -- so drive corridors stay sane.

import { IDENTITY_Q, type Q4, type V3 } from '../../../vehicle/mathUtil';

export { IDENTITY_Q };
export type { Q4, V3 };

export interface TreeSiteXZ {
	readonly x: number;
	readonly z: number;
}

// --------------------------------------------------------------------------------------------------
// Deterministic forest scatter. Uses its own local mulberry32 (same algorithm as the exported
// mulberry32 below / world/materials.ts -- small-helper duplication, the established convention here)
// so the generated sites are byte-stable across every run (feature contract warning #3: creation order
// must be deterministic). Body creation order = array order = accepted order = fixed.
// --------------------------------------------------------------------------------------------------

function scatterRng(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function scatterForest(count: number): TreeSiteXZ[] {
	const rng = scatterRng(0xf0e57); // 'FOREST'
	const xMin = -172, xMax = -58, zMin = -58, zMax = 118;
	const minDist2 = 6.5 * 6.5;
	const pts: TreeSiteXZ[] = [];
	let attempts = 0;
	while (pts.length < count && attempts < 40000) {
		attempts++;
		const x = xMin + rng() * (xMax - xMin);
		const z = zMin + rng() * (zMax - zMin);
		let ok = true;
		for (const p of pts) {
			if ((p.x - x) ** 2 + (p.z - z) ** 2 < minDist2) { ok = false; break; }
		}
		if (ok) pts.push({ x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 });
	}
	return pts;
}

// 44 scattered forest trees, split by size class (larges are the immovable anchors, so keep them
// fewest; saplings are the cheap dense filler that makes it read as a forest).
const FOREST_SCATTER = scatterForest(44);
const LARGE_COUNT = 7;
const MID_COUNT = 13;

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

export const SAPLING_SITES: readonly TreeSiteXZ[] = FOREST_SCATTER.slice(LARGE_COUNT + MID_COUNT);

// ---------------------------------------------------------------------------------------------
// Mid tree: single heavy dynamic trunk (200-400kg), root WELD joint with a HIGH break threshold --
// only a fast car fells it, and the falling trunk is itself dangerous (stays live physics debris,
// per the spec's "broken stumps stay ... despawn-safe either way": we simply never despawn it).
// ---------------------------------------------------------------------------------------------

export const MID_TRUNK_RADIUS_M = 0.35;
export const MID_TRUNK_HEIGHT_M = 6.5;
export const MID_MASS_KG = 320;
export const MID_FRICTION = 0.7;

// DESTRUCTION-FEEL: the root weld is now COMPLIANT in angle from spawn (a soft torsion spring, the
// same bend-then-break idea the sapling's spherical spring already proves) instead of dead-rigid, so
// a mid-speed hit visibly LEANS/creaks the heavy trunk and it springs back -- it only fells (the weld
// breaks) once the impact FORCE crosses the raised threshold below. Linear stays rigid (hertz 0) so
// the trunk never sinks into the ground; only the tip-over axis gives. A car contact is a one-step
// force spike (no ramp), so pure in-place softening never engaged here -- baseline compliance is what
// makes the lean real (measured: game/sim/destruction-feel.test.mjs).
export const MID_WELD_LINEAR_HERTZ = 0;
export const MID_WELD_ANGULAR_HERTZ = 4;
export const MID_WELD_DAMPING_RATIO = 0.7;

/** Fell (weld-break) threshold. RAISED from 260kN so the mid trunk actually lives up to its own design
 * note -- "only a fast car fells it": with the compliant weld above, peak contact FORCE scales cleanly
 * with speed (~260kN@20km/h .. ~845kN@80km/h, measured), so a 550kN fell line leans the trunk at
 * <=45km/h and fells it from ~55km/h up (still fells decisively at the 80km/h the feature test drives).
 * Torque is largely absorbed by the angular compliance now, so force is the dominant trigger. */
export const MID_FORCE_THRESHOLD_N = 550_000;
export const MID_TORQUE_THRESHOLD_NM = 140_000;

export const MID_SITES: readonly TreeSiteXZ[] = FOREST_SCATTER.slice(LARGE_COUNT, LARGE_COUNT + MID_COUNT);

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

// DESTRUCTION-FEEL: branch welds are COMPLIANT in angle from spawn (soft torsion spring) so a branch
// visibly BENDS/droops under a glancing load and springs back, then snaps off once the impact force
// crosses the threshold -- rather than popping rigid->free in one step. Linear stays rigid so the
// branch doesn't sag off its mount at rest.
export const LARGE_WELD_LINEAR_HERTZ = 0;
export const LARGE_WELD_ANGULAR_HERTZ = 40;
export const LARGE_WELD_DAMPING_RATIO = 0.6;

/** LOWER than the mid tree's trunk weld -- branches are meant to bend then snap off readily on any
 * real impact. Calibrated empirically (game/sim/features-trees.test.mjs). */
export const LARGE_BRANCH_FORCE_THRESHOLD_N = 30_000;
export const LARGE_BRANCH_TORQUE_THRESHOLD_NM = 12_000;

export const LARGE_SITES: readonly TreeSiteXZ[] = FOREST_SCATTER.slice(0, LARGE_COUNT);

// ---------------------------------------------------------------------------------------------
// Far line (x > 60), sparse, one of each class -- per the orchestrator's "optionally a sparse far
// line at x > 60".
// ---------------------------------------------------------------------------------------------

// Sparse far treeline along the west boundary (x ~ -180, still inside the flat FOREST mask so h=0) --
// pure backdrop depth behind the main scatter, seen through the fog.
export const FAR_SAPLING_SITES: readonly TreeSiteXZ[] = [
	{ x: -178, z: -50 },
	{ x: -180, z: 30 },
	{ x: -178, z: 110 },
];
export const FAR_MID_SITES: readonly TreeSiteXZ[] = [
	{ x: -182, z: -10 },
	{ x: -182, z: 70 },
];
export const FAR_LARGE_SITES: readonly TreeSiteXZ[] = [{ x: -184, z: 40 }];

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
