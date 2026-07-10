// SPDX-License-Identifier: MIT
//
// Numeric containment gate for the 'cardetail' WorldFeature (docs/build-log/specs/engine-bay-spec.md):
// asserts every ATTACHED component's chassis-local AABB sits inside the real car body envelope
// (car-map.ts's measured overallDimsMm, via the BodyUnderside chassis node, which happens to equal
// overallDimsMm exactly -- see this file's ENVELOPE_LOCAL_MM derivation), plus tighter per-zone checks
// for interior parts, plus the exterior-proxy invisible-while-attached visibility policy
// (tuning.ts's EXTERIOR_PROXY_IDS). This is the regression gate for the numeric audit that found and
// fixed the orchestrator's screenshot-confirmed "grey boxes poking out of the car" defects -- see
// tuning.ts's per-component comments (mufflerTailpipe/rearBumperBeam/taillightL/R/headlightL/R/
// mirrorL/R/dashboard) for the specific corrections this guards.
//
// TIER-3 STAGE 3 (open engine bay, docs/build-log/specs/compound-hull-design.md) additions: the whole-
// car ENVELOPE check above stays (still the right, looser bound for underbody/extremity parts, which
// legitimately hang below/outside the chassis's own Stage-1 collision shapes by design -- subframes/
// control-arms/fuel tank/muffler all measurably do, that's real underbody hardware). NEW: engine-bay
// parts get a TIGHTER check against the chassis's own actual Stage-1 'nose' crush-volume shape (from
// vehicle/geometry.ts's buildCabinShapes() -- the real collision geometry these parts are welded
// inside, not just the car's overall visual silhouette) -- this is "containment... inside bay/cabin/
// underbody envelopes" read literally, against Stage 1's real shapes rather than a single whole-car
// box. Also NEW: a solid-collision assertion (parts genuinely REST on the ground post-crash, not float
// or sink) and an attached-solidity assertion (every part is a real, non-sensor shape while attached
// except the 3 measured ATTACHED_SENSOR_OVERRIDE_IDS -- see tuning.ts's doc comment on that set).
//
// Same headless-import pattern as features-cardetail.test.mjs (imports the feature module directly,
// skipping registry.ts's vite-only import.meta.glob -- see feature.ts's doc comment).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Sim, loadNative } from './harness.mjs';
import { spawnTestWall, crashSetup } from '../src/damage/scenario.ts';
import { FIXED_DT, CHASSIS_ORIGIN_HEIGHT_M } from '../src/vehicle/tuning.ts';
import { buildCabinShapes } from '../src/vehicle/geometry.ts';
import createCarDetailFeature from '../src/world/features/cardetail/index.ts';
import { ATTACHED_SENSOR_OVERRIDE_IDS, CAR_DETAIL_SPECS, EXTERIOR_PROXY_IDS, MODELED_PROXY_IDS } from '../src/world/features/cardetail/tuning.ts';
import { CAR_MAP } from '../src/assets/car-map.ts';
import { rotateVector } from '../src/vehicle/mathUtil.ts';

async function makeFeature(sim) {
	const ctx = {
		world: sim.world,
		scene: new THREE.Scene(),
		getVehicle: () => sim.vehicle,
		carRoot: new THREE.Object3D(),
		quality: { level: 'high', shadowMapSize: 1024, pixelRatioCap: 2, antialias: false, envMapSize: 256 },
	};
	return { ctx, feature: await createCarDetailFeature(ctx) };
}

// ---------------------------------------------------------------------------------------------
// Envelope + zone geometry, derived from car-map.ts measured data (ground truth). The whole-body AABB
// is now car-map.ts's overallCenterMm + overallDimsMm (the Mustang split is flat -- there is no single
// 'BodyUnderside' node that equals the whole-body box; overallCenterMm/DimsMm ARE that box directly,
// unioned over every part in analyze-car.mjs). Recorded in WORLD mm (ground = Y 0), converted to
// chassis-local METERS the same way tuning.ts's mm() helper does (X/Z unit-convert only, Y shifted by
// CHASSIS_ORIGIN_HEIGHT_M since the chassis's own local origin sits at hub height, not ground).
// ---------------------------------------------------------------------------------------------

function worldMmToLocalM(centerMm, sizeMm) {
	const halfMm = [sizeMm[0] / 2, sizeMm[1] / 2, sizeMm[2] / 2];
	return {
		xMin: (centerMm[0] - halfMm[0]) / 1000,
		xMax: (centerMm[0] + halfMm[0]) / 1000,
		yMin: (centerMm[1] - halfMm[1]) / 1000 - CHASSIS_ORIGIN_HEIGHT_M,
		yMax: (centerMm[1] + halfMm[1]) / 1000 - CHASSIS_ORIGIN_HEIGHT_M,
		zMin: (centerMm[2] - halfMm[2]) / 1000,
		zMax: (centerMm[2] + halfMm[2]) / 1000,
	};
}

/** Whole-body envelope (chassis-local meters) -- every attached part's AABB must sit inside this. */
const ENVELOPE = worldMmToLocalM(CAR_MAP.overallCenterMm, [CAR_MAP.overallDimsMm.width, CAR_MAP.overallDimsMm.height, CAR_MAP.overallDimsMm.length]);

// Cabin footprint (X/Z only) for the interior-parts sub-check. The Mustang split has no InteriorCage
// node, so the cabin is derived from the measured DOOR panels (car-map.ts DoorL/DoorR -- they bound the
// cabin sides) plus a forward Z reach for the dashboard/steering-column firewall mount and a rearward
// reach for the rear bench. Chassis-local meters.
const doorOuterX = Math.max(
	Math.abs(CAR_MAP.panels.DoorL.centerMm[0]) + CAR_MAP.panels.DoorL.sizeMm[0] / 2,
	Math.abs(CAR_MAP.panels.DoorR.centerMm[0]) + CAR_MAP.panels.DoorR.sizeMm[0] / 2,
) / 1000;
const CABIN_X = { min: -doorOuterX, max: doorOuterX }; // ~+-0.90m -- the door outer line bounds the cabin width
const CABIN_Z = { min: -1.1, max: 1.4 }; // rear bench (~-0.75m) to steering-column firewall mount (~+1.32m)

/** Per-shape chassis-local AABB half-extents, matching index.ts's createShapeFor()/buildMeshFor()
 * geometry exactly (box: dims are already half-extents; capsule: full reach along its own axis is
 * length/2 + radius, and radius perpendicular to it). */
function halfExtents(spec) {
	if (spec.phys === 'box') {
		const { hx, hy, hz } = spec.dims;
		return { hx, hy, hz };
	}
	const { length, radius } = spec.dims;
	const axialHalf = length / 2 + radius;
	if (spec.phys === 'capsuleX') return { hx: axialHalf, hy: radius, hz: radius };
	return { hx: radius, hy: radius, hz: axialHalf };
}

function aabbOf(spec) {
	const c = spec.localCenter;
	const { hx, hy, hz } = halfExtents(spec);
	return { xMin: c.x - hx, xMax: c.x + hx, yMin: c.y - hy, yMax: c.y + hy, zMin: c.z - hz, zMax: c.z + hz };
}

function within(box, bound) {
	return box.xMin >= bound.xMin - 1e-9 && box.xMax <= bound.xMax + 1e-9 && box.yMin >= bound.yMin - 1e-9 && box.yMax <= bound.yMax + 1e-9 && box.zMin >= bound.zMin - 1e-9 && box.zMax <= bound.zMax + 1e-9;
}

// ---------------------------------------------------------------------------------------------
// TIER-3 STAGE 3: the actual Stage-1 'nose' crush-volume AABB (vehicle/geometry.ts's
// buildCabinShapes(), the REAL chassis collision geometry every engine-bay part is welded inside),
// derived the same way (min/max over the shape's own point cloud) rather than duplicating any
// constant out of that file -- stays correct automatically if Stage-1 tuning ever shifts.
// ---------------------------------------------------------------------------------------------
function aabbOfPoints(points) {
	let xMin = Infinity,
		xMax = -Infinity,
		yMin = Infinity,
		yMax = -Infinity,
		zMin = Infinity,
		zMax = -Infinity;
	for (let i = 0; i < points.length; i += 3) {
		xMin = Math.min(xMin, points[i]);
		xMax = Math.max(xMax, points[i]);
		yMin = Math.min(yMin, points[i + 1]);
		yMax = Math.max(yMax, points[i + 1]);
		zMin = Math.min(zMin, points[i + 2]);
		zMax = Math.max(zMax, points[i + 2]);
	}
	return { xMin, xMax, yMin, yMax, zMin, zMax };
}
const CABIN_SHAPES = buildCabinShapes();
const NOSE_AABB = aabbOfPoints(CABIN_SHAPES.find((s) => s.name === 'nose').points);

function boxCorners(hx, hy, hz) {
	const out = [];
	for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push({ x: sx * hx, y: sy * hy, z: sz * hz });
	return out;
}
/** Returns fn(pos, rot) -> this shape's own lowest world-Y point at that live transform (exact for
 * both box and capsule -- see sim/cardetail-ground-contact.test.mjs's identical helper doc comment). */
function lowestWorldYFn(spec) {
	if (spec.phys === 'box') {
		const { hx, hy, hz } = spec.dims;
		const corners = boxCorners(hx, hy, hz);
		return (pos, rot) => Math.min(...corners.map((c) => pos.y + rotateVector(rot, c).y));
	}
	const { length, radius } = spec.dims;
	const half = length / 2;
	const axisOffset = spec.phys === 'capsuleX' ? { x: half, y: 0, z: 0 } : { x: 0, y: 0, z: half };
	const c1 = { x: -axisOffset.x, y: -axisOffset.y, z: -axisOffset.z };
	const c2 = axisOffset;
	return (pos, rot) => Math.min(pos.y + rotateVector(rot, c1).y, pos.y + rotateVector(rot, c2).y) - radius;
}

// Underbody/extremity mechanicals -- subframes, driveshaft, fuel tank, muffler, bumper beams, lights,
// mirrors -- legitimately sit outside the (now nonexistent, see below) cabin footprint.
const UNDERBODY_EXTREMITY_IDS = new Set([
	'mufflerTailpipe',
	'fuelTank',
	'frontSubframe',
	'rearSubframe',
	'driveshaft',
	'flControlArm',
	'frControlArm',
	'rlControlArm',
	'rrControlArm',
	...EXTERIOR_PROXY_IDS,
]);

describe('cardetail containment (numeric audit gate)', () => {
	it('ENVELOPE is non-empty and matches car-map.ts overallDimsMm (sanity)', () => {
		expect(ENVELOPE.xMax - ENVELOPE.xMin).toBeCloseTo(CAR_MAP.overallDimsMm.width / 1000, 6);
		expect(ENVELOPE.yMax - ENVELOPE.yMin).toBeCloseTo(CAR_MAP.overallDimsMm.height / 1000, 6);
		expect(ENVELOPE.zMax - ENVELOPE.zMin).toBeCloseTo(CAR_MAP.overallDimsMm.length / 1000, 6);
	});

	// RECALIBRATED (MUSTANG-65 MODEL-FIRST CULL): 39 -> 27 -- see tuning.ts's top doc comment /
	// features-cardetail.test.mjs's matching recalibration note for the full rationale.
	it('every one of the 27 post-cull components has a distinct id and a mass-bearing shape (table sanity)', () => {
		expect(CAR_DETAIL_SPECS.length).toBe(27);
		expect(new Set(CAR_DETAIL_SPECS.map((s) => s.id)).size).toBe(27);
	});

	it('every attached part sits fully inside the real car body envelope (no protruding proxy boxes)', () => {
		const offenders = [];
		for (const spec of CAR_DETAIL_SPECS) {
			const box = aabbOf(spec);
			if (!within(box, ENVELOPE)) offenders.push({ id: spec.id, box, ENVELOPE });
		}
		if (offenders.length) console.log('[cardetail-containment] envelope offenders:', JSON.stringify(offenders, null, 2));
		expect(offenders).toEqual([]);
	});

	// TIER-3 STAGE 3: a TIGHTER check than the whole-car envelope above -- every engine-bay part must
	// sit fully inside the chassis's own ACTUAL Stage-1 'nose' crush-volume shape (the real collision
	// geometry it's welded inside), not just somewhere in the car's overall silhouette. All 10 measured
	// clear this with margin (verified directly against buildCabinShapes() -- see this file's top doc
	// comment); underbody/extremity parts are deliberately NOT held to this bound (they legitimately
	// hang outside the nose/tail shapes -- real subframe/control-arm/exhaust hardware does).
	it('every engine-bay part sits fully inside the real Stage-1 nose crush-volume shape', () => {
		const offenders = [];
		for (const spec of CAR_DETAIL_SPECS.filter((s) => s.engineBay)) {
			const box = aabbOf(spec);
			if (!within(box, NOSE_AABB)) offenders.push({ id: spec.id, box, NOSE_AABB });
		}
		if (offenders.length) console.log('[cardetail-containment] nose-zone offenders:', JSON.stringify(offenders, null, 2));
		expect(offenders).toEqual([]);
	});

	// MUSTANG-65 MODEL-FIRST CULL: the whole §2 interior category (driverSeat, passengerSeat, rearBench,
	// dashboard, steeringColumn, centerConsole, pedalCluster, rearviewMirror) was removed outright -- the
	// Mustang model already molds the cabin into its 'body' vertex group ('seat_rubber' material), so a
	// procedural interior box was always a visible duplicate through the glass (see tuning.ts's top doc
	// comment). This is now a guard against regression: no non-engine-bay, non-underbody/extremity part
	// should exist (if one is added later without deciding its category, this catches it) -- the
	// CABIN_X/CABIN_Z geometry above is kept for reference/documentation but no longer has anything to
	// bound.
	it('the interior category is empty post-cull (no orphaned non-engine-bay, non-underbody part)', () => {
		const interiorIds = new Set(CAR_DETAIL_SPECS.filter((s) => !s.engineBay && !UNDERBODY_EXTREMITY_IDS.has(s.id)).map((s) => s.id));
		expect([...interiorIds]).toEqual([]);
	});

	it('exterior + modeled-GLB proxy parts start INVISIBLE while attached', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			const visible = feature.hooks.meshVisible();
			const states = feature.hooks.states();
			expect(EXTERIOR_PROXY_IDS.size).toBeGreaterThan(0);
			for (const id of EXTERIOR_PROXY_IDS) {
				expect(states[id]).toBe('attached');
				expect(visible[id]).toBe(false);
			}
			// MODELED_PROXY_IDS (engineBlock, driveshaft, mufflerTailpipe): the model's own GLB mesh
			// already renders these, so their procedural proxy is likewise invisible while attached (same
			// policy as EXTERIOR_PROXY_IDS -- see tuning.ts's doc comment on both sets).
			expect(MODELED_PROXY_IDS.size).toBeGreaterThan(0);
			for (const id of MODELED_PROXY_IDS) {
				expect(states[id]).toBe('attached');
				expect(visible[id]).toBe(false);
			}
			// Every other (non-engine-bay, non-exterior-proxy, non-modeled-proxy) part stays visible
			// throughout -- underbody/extremity mechanicals the model does not render distinctly.
			for (const spec of CAR_DETAIL_SPECS) {
				if (spec.engineBay || EXTERIOR_PROXY_IDS.has(spec.id) || MODELED_PROXY_IDS.has(spec.id)) continue;
				expect(visible[spec.id]).toBe(true);
			}
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});

	it('exterior proxy parts become visible once they actually detach (flying debris on impact)', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			// crashSetup() (velocity-teleport, same convenience path verify/feature-cardetail.mjs uses)
			// rather than a real drive-up: this test only needs SOME exterior proxy to detach so the
			// visibility invariant below is actually exercised, not a physically-realistic frontal-impact
			// distribution (that's features-cardetail.test.mjs's job, via a real drive-up). Escalating
			// speed across a couple of tries covers the same run-to-run float jitter that verify script's
			// own comment documents.
			let states = null;
			for (const speedKmh of [110, 160, 220]) {
				spawnTestWall(sim.world, sim.vehicle, 8);
				crashSetup(sim.vehicle, speedKmh);
				for (let i = 0; i < 300; i++) {
					sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
					feature.afterFixedStep(FIXED_DT);
				}
				states = feature.hooks.states();
				if ([...EXTERIOR_PROXY_IDS].some((id) => states[id] !== 'attached')) break;
			}
			feature.applyVisuals(1);

			const visible = feature.hooks.meshVisible();
			const detachedExterior = [...EXTERIOR_PROXY_IDS].filter((id) => states[id] !== 'attached');
			console.log(`[cardetail-containment] detached exterior proxies after crash: ${detachedExterior.length}/${EXTERIOR_PROXY_IDS.size}`, JSON.stringify(states));
			expect(detachedExterior.length).toBeGreaterThan(0);
			for (const id of detachedExterior) {
				expect(visible[id]).toBe(true);
			}
			// Every still-attached exterior part (didn't break this run) must remain invisible.
			for (const id of EXTERIOR_PROXY_IDS) {
				if (states[id] === 'attached') expect(visible[id]).toBe(false);
			}
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});

	// ---------------------------------------------------------------------------------------------
	// TIER-3 STAGE 3: solid-while-attached policy + genuine solid-collision behavior once scattered.
	// ---------------------------------------------------------------------------------------------

	it('every part is SOLID (non-sensor) while attached, except the 3 measured ATTACHED_SENSOR_OVERRIDE_IDS', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			expect(ATTACHED_SENSOR_OVERRIDE_IDS.size).toBe(3);
			const isSensor = feature.hooks.isSensor();
			for (const spec of CAR_DETAIL_SPECS) {
				expect(isSensor[spec.id]).toBe(ATTACHED_SENSOR_OVERRIDE_IDS.has(spec.id));
			}
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});

	it('every part becomes SOLID (non-sensor) once broken, including the 3 override parts', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			spawnTestWall(sim.world, sim.vehicle, 8);
			crashSetup(sim.vehicle, 140);
			for (let i = 0; i < 300; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				feature.afterFixedStep(FIXED_DT);
			}
			const states = feature.hooks.states();
			const isSensor = feature.hooks.isSensor();
			const broken = CAR_DETAIL_SPECS.filter((s) => states[s.id] !== 'attached');
			expect(broken.length).toBeGreaterThan(0);
			for (const spec of broken) expect(isSensor[spec.id]).toBe(false);
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});

	// Proves solid-while-attached genuinely delivers real world/debris collision, not just a flag flip:
	// a hard frontal crash + a long settle window, then every scattered part's OWN shape must have come
	// to rest actually ON the ground (lowest point close to world Y=0), not floating or sunk through --
	// the same class of correctness gate as game/sim/cardetail-ground-contact.test.mjs, applied to the
	// SCATTERED (post-break) state instead of the attached-driving state.
	it('scattered parts settle to REST on the ground after a crash (genuine solid collision, no floating/sinking)', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			spawnTestWall(sim.world, sim.vehicle, 60);
			for (let i = 0; i < 320; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				feature.afterFixedStep(FIXED_DT);
			}
			// Long settle window -- long enough for scattered parts' velocity to die down under friction.
			for (let i = 0; i < 600; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				feature.afterFixedStep(FIXED_DT);
			}
			const states = feature.hooks.states();
			const bodies = feature.hooks.bodies();
			const lowestFns = CAR_DETAIL_SPECS.map(lowestWorldYFn);
			const rows = CAR_DETAIL_SPECS.map((spec, k) => {
				const t = bodies[k].getTransform();
				return { id: spec.id, state: states[spec.id], lowestY: lowestFns[k](t.position, t.rotation) };
			});
			const broken = rows.filter((r) => r.state !== 'attached');
			console.log(`[cardetail-containment] scattered=${broken.length}/27 lowestY=${JSON.stringify(broken.map((r) => [r.id, Number(r.lowestY.toFixed(3))]))}`);
			expect(broken.length).toBeGreaterThan(0);
			// REST_TOLERANCE_M: generous both ways -- slightly negative (a few mm of resting speculative
			// penetration/settle) and slightly positive (resting at an angle, or momentarily still settling)
			// are both physically normal; the point is nothing is grossly floating (still meters up in the
			// air) or has fallen through the world (deeply negative).
			const REST_TOLERANCE_M = 0.15;
			const offenders = broken.filter((r) => Math.abs(r.lowestY) > REST_TOLERANCE_M);
			if (offenders.length) console.log('[cardetail-containment] rest offenders:', JSON.stringify(offenders));
			expect(offenders).toEqual([]);
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});
});
