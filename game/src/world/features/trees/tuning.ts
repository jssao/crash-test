// SPDX-License-Identifier: MIT
//
// Physics/placement tuning for the 'trees' world feature (3 size classes: sapling/mid/large).
// Renderer-free (no three/DOM import) -- shared verbatim by the browser feature (./index.ts) and the
// headless sim test (game/sim/features-trees.test.mjs), same convention as world/tuning.ts.
//
// ZONE (COMPOUND-IN-A-FOREST overhaul): a dense forest that ENCLOSES the compound on every side. Sites
// are a DETERMINISTIC Poisson-disc scatter (fixed seed, min-spacing rejection) placed ONLY where the
// terrain's forest RING is hard-flat -- acceptance is gated on world/terrain/heightfield.ts's
// forestMask(x,z) >= 0.985, which is 1 exactly on the flat forest floor and 0 over the compound yard,
// the roads, and the meadow edges. That single gate guarantees three things at once: every trunk (which
// spawns at y=0, bodies.ts) sits on h==0 ground; nothing lands on the compound or a drive corridor; and
// the trees automatically press right up to the road edges (where forestMask falls off) so the loop/
// driveway "wind through the woods". The FIRST site of each size class is a hand-placed HERO with a
// guaranteed-clear south approach (the Poisson fill is kept out of each hero's approach corridor) so
// game/sim/features-trees.test.mjs -- which drives at SAPLING_SITES[0]/MID_SITES[0]/LARGE_SITES[0] with
// all trees present -- always has an unobstructed run at its target. A far backdrop treeline ring (still
// on flat floor) adds depth through the fog.

import { IDENTITY_Q, type Q4, type V3 } from '../../../vehicle/mathUtil';
import { forestMask } from '../../terrain/heightfield';

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

// Hand-placed HERO site for each size class (index 0 of each class array) -- each sits on flat forest
// floor in the WEST arc of the ring with a long, clear straight approach from -Z, so the class-specific
// drive-in tests always reach their target with no other trunk in the way. HERO_RUNWAY meters south of
// each is kept tree-free by seeding the Poisson rejection set with corridor "phantom" points.
const LARGE_HERO: TreeSiteXZ = { x: -92, z: -8 };
const MID_HERO: TreeSiteXZ = { x: -72, z: -40 };
const SAPLING_HERO: TreeSiteXZ = { x: -110, z: 20 };
const HERO_RUNWAY_M = 20;

function heroApproachPhantoms(): TreeSiteXZ[] {
	const pts: TreeSiteXZ[] = [];
	for (const h of [LARGE_HERO, MID_HERO, SAPLING_HERO]) {
		for (let d = 4; d <= HERO_RUNWAY_M; d += 4) pts.push({ x: h.x, z: h.z - d });
	}
	return pts;
}

/** Poisson-disc scatter confined to the flat forest RING (forestMask>=0.985), keeping HERO approach
 * corridors clear. Deterministic (fixed seed). */
function scatterForestRing(count: number): TreeSiteXZ[] {
	const rng = scatterRng(0xf0e57); // 'FOREST'
	const xMin = -152, xMax = 152, zMin = -122, zMax = 182;
	const minDist2 = 6.8 * 6.8;
	// Heroes + their approach corridors occupy the rejection set from the start (kept clear, not emitted).
	const accepted: TreeSiteXZ[] = [LARGE_HERO, MID_HERO, SAPLING_HERO, ...heroApproachPhantoms()];
	const emitted: TreeSiteXZ[] = [];
	let attempts = 0;
	while (emitted.length < count && attempts < 80000) {
		attempts++;
		const x = xMin + rng() * (xMax - xMin);
		const z = zMin + rng() * (zMax - zMin);
		if (forestMask(x, z) < 0.985) continue; // flat forest floor only (h~=0, off compound/road/meadow)
		let ok = true;
		for (const p of accepted) {
			if ((p.x - x) ** 2 + (p.z - z) ** 2 < minDist2) { ok = false; break; }
		}
		if (!ok) continue;
		const pt = { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
		accepted.push(pt);
		emitted.push(pt);
	}
	return emitted;
}

/** Backdrop treeline: a sparse ring of trees near the OUTER flat edge of the forest (still on hard-flat
 * floor -- gated on the same forestMask) for depth through the fog. `centerZ` matches the forest ring's
 * slight northward shift. Deterministic angular sweep. */
function farRing(count: number, radius: number, angleOffset: number): TreeSiteXZ[] {
	const pts: TreeSiteXZ[] = [];
	const centerZ = 20;
	for (let i = 0; i < count * 4 && pts.length < count; i++) {
		const a = angleOffset + (i / (count * 1.3)) * Math.PI * 2;
		const x = Math.cos(a) * radius;
		const z = centerZ + Math.sin(a) * radius;
		if (forestMask(x, z) < 0.985) continue;
		pts.push({ x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 });
	}
	return pts;
}

// Dense enclosing forest: 14 larges (immovable anchors) + 32 mids + 93 saplings = 139 near trees, plus
// the far backdrop ring below (~19) -> ~158 total, toward the upper end of the orchestrator's 120-180
// band. The count is perf-gated (npm run bench:full + verify/perf-headed.mjs stay green -- see this
// run's report for the measured body-count/draw-call/fps deltas). Fill counts exclude the 3 heroes
// (which are prepended as each class's index 0).
const LARGE_FILL = 13;
const MID_FILL = 31;
const SAPLING_FILL = 92;
const RING_FILL = scatterForestRing(LARGE_FILL + MID_FILL + SAPLING_FILL);

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

export const SAPLING_SITES: readonly TreeSiteXZ[] = [SAPLING_HERO, ...RING_FILL.slice(LARGE_FILL + MID_FILL, LARGE_FILL + MID_FILL + SAPLING_FILL)];

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

export const MID_SITES: readonly TreeSiteXZ[] = [MID_HERO, ...RING_FILL.slice(LARGE_FILL, LARGE_FILL + MID_FILL)];

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

export const LARGE_SITES: readonly TreeSiteXZ[] = [LARGE_HERO, ...RING_FILL.slice(0, LARGE_FILL)];

// ---------------------------------------------------------------------------------------------
// Far backdrop treeline -- a sparse ring near the OUTER flat edge of the forest (still gated on
// forestMask so every trunk is on h=0 floor), purely for depth behind the main scatter through the fog.
// ---------------------------------------------------------------------------------------------

export const FAR_LARGE_SITES: readonly TreeSiteXZ[] = farRing(8, 138, 0.35);
export const FAR_MID_SITES: readonly TreeSiteXZ[] = farRing(6, 132, 1.2);
export const FAR_SAPLING_SITES: readonly TreeSiteXZ[] = farRing(5, 144, 2.0);

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
