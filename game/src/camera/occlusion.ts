// SPDX-License-Identifier: MIT
//
// Chase/orbit camera occlusion pullback (Tier-2 camera task): cast a small sphere from a
// car-anchored origin toward the camera's DESIRED position (World.castShapeClosest -- box3d.h's
// b3World_CastShape, already wired in ../../../src/ts/world.ts specifically for this "chase-cam
// occlusion" use case, see that method's doc comment, and exercised generically by
// tests/cast-shape.test.ts) and report the nearest point along that segment a REAL environment
// surface blocks it, so the camera can be pulled in before it clips through a wall/tree/terrain.
//
// FILTERING ("ignore the car's own shapes/panels/occupants/detached-debris"): World.castShapeClosest
// only filters by categoryBits/maskBits (see RayCastOptions), and every car-owned shape currently
// relies on CAR_GROUP_INDEX (a negative groupIndex) for self-collision suppression instead -- that
// mechanism is shape-vs-shape only, box3d/box2d convention, and has no effect on a ray/shape cast's
// own filter. Adding a dedicated category bit would mean touching vehicle.ts/panels.ts/occupants'
// physics setup, outside this module's ownership (camera/**), so this filters by ENTITY ID instead,
// against the numeric convention that is ALREADY the single documented source of truth across the
// codebase (see world/tuning.ts's BARREL_ENTITY_ID_BASE doc comment): chassis=1, wheels=2-5
// (vehicle.ts's CAR_ENTITY_ID, imported directly), panels=6-11 (damage/panels.ts's PANEL_ENTITY_ID,
// imported directly -- UNCHANGED by breakPanelWeld()'s detach, so a just-detached hood/door still
// resolves to its original id and stays filtered here, i.e. "detached debris near the car" is exactly
// what a still-fresh detach looks like), occupants=1000-1399 (occupants/physics.ts's entityIdFor(),
// not exported -- duplicated here as a documented range since importing an internal, unexported
// helper isn't possible without touching that module). A hit against any of those ids is skipped: the
// cast resumes just past the hit point along the SAME ray, so a real occluder further along (a wall
// behind the car) is still found. Everything else -- terrain, the containment berm, trees, buildings,
// exploding barrels -- keeps the default all-bits filter and blocks normally.

import type { Vec3, World } from '../../../src/ts/index.js';
import { CAR_ENTITY_ID, GLASS_ENTITY_ID } from '../vehicle/vehicle';
import { SEGMENT_ENTITY_ID_SET } from '../vehicle/segments';
import { PANEL_ENTITY_ID } from '../damage/panels';

/** occupants/physics.ts's entityIdFor(seatIndex, partIndex) = 1000 + seatIndex*100 + partIndex, for
 * seatIndex 0-3 and partIndex 0-10 (11 parts) -- see world/tuning.ts's doc comment for the range. */
const OCCUPANT_ENTITY_ID_MIN = 1000;
const OCCUPANT_ENTITY_ID_MAX = 1399;

/** world/features/cardetail's on-car detail bodies (mirrors/wipers/badges) -- tuning.ts's
 * CARDETAIL_JOINT_ID_BASE (88.1M) / CARDETAIL_BODY_ID_BASE (88.2M). Same documented-range treatment
 * as occupants above (importing a world/features module from camera/** would cross the ownership
 * boundary the other way). */
const CARDETAIL_ENTITY_ID_MIN = 88_000_000;
const CARDETAIL_ENTITY_ID_MAX = 88_999_999;

const CAR_OWNED_ENTITY_IDS: ReadonlySet<number> = new Set<number>([
	CAR_ENTITY_ID.chassis,
	...Object.values(CAR_ENTITY_ID.wheel),
	...Object.values(PANEL_ENTITY_ID),
	// Glass panes (12-13) + crush segments/cores (14-25): every one of these sits ON the cast's path
	// out of the cabin (the rear window and trunk segments squarely so for the default 6m-back chase
	// offset). Before these were filtered, the FIRST chase frame's cast hit the car's own rear
	// window/trunk, clamped the allowed distance to minDistanceM (1.5m -- inside the cabin), and
	// KEPT re-clamping it every subsequent frame -- so a fresh boot rendered the car's own black
	// interior backfaces until the player toggled away from chase mode ("car texture never loads on
	// fresh start", 2026-08-05).
	...Object.values(GLASS_ENTITY_ID),
	...SEGMENT_ENTITY_ID_SET,
]);

/** True if `id` (a cast/hit-event entityId, i.e. Body/Shape userData) belongs to the car itself --
 * chassis, wheels, damage panels (attached or freshly detached), glass panes, crush segments/cores,
 * on-car detail parts (mirrors/wipers), or a seated/ejected occupant. Zero (the default userData for
 * untagged bodies, e.g. verify/spawnTestWall's test wall, world terrain, trees, buildings, exploding
 * barrels) is never in this set. */
export function isCarOwnedEntityId(id: number): boolean {
	return (
		CAR_OWNED_ENTITY_IDS.has(id) ||
		(id >= OCCUPANT_ENTITY_ID_MIN && id <= OCCUPANT_ENTITY_ID_MAX) ||
		(id >= CARDETAIL_ENTITY_ID_MIN && id <= CARDETAIL_ENTITY_ID_MAX)
	);
}

export interface OcclusionCastOptions {
	/** Sphere-cast probe radius (meters) -- keeps a margin so the CAMERA (not just a single point)
	 * clears the occluder, per the brief's "small sphere cast is ideal so the camera keeps a margin".
	 * Default 0.4. */
	probeRadiusM?: number;
	/** Extra pullback (meters), beyond the probe radius, subtracted from a real hit's distance so the
	 * camera sits clearly clear of the occluding surface rather than exactly tangent to it (the
	 * cast's own probeRadiusM already keeps the camera's clearance bubble off the surface -- this is
	 * EXTRA buffer on top of that). Default 0.25. */
	clearanceMarginM?: number;
	/** Never resolve to a distance shorter than this (meters) -- keeps the camera from being pulled
	 * onto/inside the car when boxed in tight against a wall. Default 1.5. */
	minDistanceM?: number;
	/** Bounded total cast attempts (car-owned skips + the final real-hit-or-clear cast). A car-owned
	 * shape can legitimately take MORE THAN ONE re-cast to fully clear (each step only advances by a
	 * bounded margin, see the skip branch below), so this needs real headroom over the car's own part
	 * count, not a 1-to-1 budget. Default 16. */
	maxIgnoredHits?: number;
}

export interface OcclusionResult {
	/** Allowed distance (meters) from `origin` toward `desired` along that straight line: the full
	 * origin->desired distance if nothing (non-car-owned) blocks it, else the nearest real blocker's
	 * probe-sphere-tangent distance minus clearanceMarginM (clamped to >= minDistanceM). */
	distanceM: number;
	/** True if a real (non-car-owned) surface actually clamped distanceM below the full distance. */
	occluded: boolean;
	/** Entity id (Body/Shape userData) of the blocking hit, or null if unoccluded -- DIAGNOSTIC field
	 * (main.ts's cameraDebug() surfaces it for verify/debugging; not required for the clamp itself). */
	hitEntityId: number | null;
}

const DEFAULTS: Required<OcclusionCastOptions> = {
	probeRadiusM: 0.4,
	clearanceMarginM: 0.25,
	minDistanceM: 1.5,
	maxIgnoredHits: 16,
};

/**
 * Sphere-casts from `origin` (car-anchored, e.g. the chassis position) toward `desired` (the
 * camera's uncclamped target position) and returns how far along that segment the camera may
 * actually go. Car-owned hits (see isCarOwnedEntityId()) are transparent: the cast resumes just past
 * them so a real occluder further along the same ray is still detected.
 */
export function castCameraOcclusion(world: World, origin: Vec3, desired: Vec3, options: OcclusionCastOptions = {}): OcclusionResult {
	const opts = { ...DEFAULTS, ...options };
	const fullDx = desired.x - origin.x;
	const fullDy = desired.y - origin.y;
	const fullDz = desired.z - origin.z;
	const fullDistance = Math.hypot(fullDx, fullDy, fullDz);
	if (fullDistance < 1e-6) return { distanceM: opts.minDistanceM, occluded: false, hitEntityId: null };

	const dirX = fullDx / fullDistance;
	const dirY = fullDy / fullDistance;
	const dirZ = fullDz / fullDistance;
	// Small forward nudge past a skipped car-owned hit's SURFACE (not just its center-tangent point --
	// see hitCenterDistance's doc comment just below) so the next cast's own probe sphere doesn't still
	// overlap the very shape it just skipped, which would otherwise re-report the same hit at
	// fraction~0 forever (verified directly: a naive "nudge past the tangent point" reproduces exactly
	// that infinite-same-hit loop).
	const PAST_HIT_EPS_M = 0.05;

	let traveled = 0;
	for (let i = 0; i < opts.maxIgnoredHits; i++) {
		const remaining = fullDistance - traveled;
		if (remaining <= 1e-6) return { distanceM: fullDistance, occluded: false, hitEntityId: null };

		const castOrigin: Vec3 = { x: origin.x + dirX * traveled, y: origin.y + dirY * traveled, z: origin.z + dirZ * traveled };
		const translation: Vec3 = { x: dirX * remaining, y: dirY * remaining, z: dirZ * remaining };
		const hit = world.castShapeClosest({ points: [{ x: 0, y: 0, z: 0 }], radius: opts.probeRadiusM }, castOrigin, translation);

		if (!hit.hit) return { distanceM: fullDistance, occluded: false, hitEntityId: null };

		// b3World_CastShape's `fraction` is where the PROBE SPHERE'S CENTER is when its surface first
		// touches the target (verified directly against a known geometry: a sphere of radius 0.4 cast
		// at a box whose near face sits 0.6m out reports fraction*|translation| = 0.2, i.e. 0.6 - the
		// probe radius -- NOT 0.6 itself). So `hitCenterDistance` is already the exact "camera center
		// distance that makes the probe sphere tangent to the surface" -- the probe-radius margin is
		// baked in by the cast itself, and must NOT be subtracted a second time below. The target
		// surface itself sits probeRadiusM further out, at hitCenterDistance + opts.probeRadiusM.
		const hitCenterDistance = traveled + hit.fraction * remaining;
		if (isCarOwnedEntityId(hit.entityId)) {
			// Advance a full probeRadiusM PAST the surface (not just past the tangent point) so the next
			// cast's probe sphere fully clears this shape rather than re-overlapping it from the far
			// side -- then a second probeRadiusM of headroom on top of that, since real car-owned shapes
			// (a wheel, a chassis corner) can be a few tens of cm thick along the ray, not knife-thin.
			traveled = hitCenterDistance + 2 * opts.probeRadiusM + PAST_HIT_EPS_M;
			continue;
		}

		const clamped = Math.max(opts.minDistanceM, hitCenterDistance - opts.clearanceMarginM);
		return { distanceM: Math.min(clamped, fullDistance), occluded: true, hitEntityId: hit.entityId };
	}
	// Exhausted the ignore budget (pathological stack of car-owned shapes on one ray) -- fail open
	// rather than leaving the camera stuck at a stale short distance.
	return { distanceM: fullDistance, occluded: false, hitEntityId: null };
}

/**
 * Asymmetric damped follower for an occlusion distance: pulls IN fast (near-instant -- the brief's
 * "no jitter" requirement is about oscillation, not about lagging behind a wall that just appeared)
 * and recovers back OUT slowly once the path clears, so briefly passing a thin occluder (a lamp post,
 * a fence post) doesn't yo-yo the camera. Same exponential-smoothing shape as cameraOrbit.ts's
 * UserOrbitController damping, just with two different time constants depending on direction.
 */
export class OcclusionDamper {
	private currentM: number | null = null;

	constructor(private readonly pullInTimeS = 0.05, private readonly recoverTimeS = 0.6) {}

	/** Advances the damped distance toward `targetM` by `dt` seconds and returns the new value. */
	update(targetM: number, dt: number): number {
		if (this.currentM === null || dt <= 0) {
			this.currentM = targetM;
			return this.currentM;
		}
		const tau = targetM < this.currentM ? this.pullInTimeS : this.recoverTimeS;
		const t = 1 - Math.exp(-dt / Math.max(tau, 1e-4));
		this.currentM += (targetM - this.currentM) * t;
		return this.currentM;
	}

	reset(): void {
		this.currentM = null;
	}
}
