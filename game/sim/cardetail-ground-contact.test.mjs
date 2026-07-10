// SPDX-License-Identifier: MIT
//
// TIER-3 STAGE 3 (open engine bay, docs/build-log/specs/compound-hull-design.md): the
// "parts-ground-contact probe" the stage brief asks for -- PROVES (not just asserts) that making
// cardetail parts SOLID while attached (index.ts's createShapeFor()) doesn't reintroduce the
// driveline-stall class of bug that originally forced the sensor-while-attached compromise
// (createShapeFor()'s doc comment: 39 parts, several clipping the ground during acceleration squat,
// dropped a 34km/h/2s baseline to <1km/h).
//
// METHOD: transforms each spec's own box/capsule geometry through its LIVE welded body pose every
// fixed step and finds the shape's own lowest world-Y point directly (no solver/contact dependency) --
// a sensor's kinematics while rigidly welded are 100% weld-determined, identical to a solid shape's,
// UNLESS/UNTIL real penetration would occur, so this safely measures "would this shape have
// penetrated the ground" for ANY part regardless of its current isSensor flag. This is how the
// ATTACHED_SENSOR_OVERRIDE_IDS list (tuning.ts) was calibrated in the first place -- this test is the
// permanent regression gate for that measurement, run against 3 benign-driving scenarios covering
// acceleration, sustained cruise, hard braking, and swerving.
//
// Every part NOT in ATTACHED_SENSOR_OVERRIDE_IDS must stay clear of the ground (world Y=0) by a small
// safety margin throughout; every part IN that set is expected to (that's exactly why it's overridden
// back to a sensor) and is asserted separately so a future re-measurement showing it newly clears
// (e.g. after the chassis-side bay/floor geometry changes) is visible here rather than silently masked.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Sim, loadNative } from './harness.mjs';
import { FIXED_DT } from '../src/vehicle/tuning.ts';
import createCarDetailFeature from '../src/world/features/cardetail/index.ts';
import { ATTACHED_SENSOR_OVERRIDE_IDS, CAR_DETAIL_SPECS } from '../src/world/features/cardetail/tuning.ts';
import { rotateVector } from '../src/vehicle/mathUtil.ts';

/** Ground-clearance safety margin (meters) for parts NOT in the override set -- small but nonzero, so
 * float jitter right at 0 doesn't flap the gate. */
const CLEARANCE_MARGIN_M = 0.005;

function boxCorners(hx, hy, hz) {
	const out = [];
	for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push({ x: sx * hx, y: sy * hy, z: sz * hz });
	return out;
}

/** Returns fn(pos, rot) -> this shape's own lowest world-Y point at that live transform -- exact for
 * a box (a convex box's extreme point in any direction is always one of its 8 corners) and exact for a
 * capsule (a sphere swept along a segment: the extreme point in -Y is the lower of the two sphere
 * centers, minus the radius, regardless of the capsule's own orientation -- isotropic radius). */
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

/** Drives `inputSeq` (array of [input, steps]) and returns, per spec index, the minimum world-Y its
 * own shape reached at any step. */
async function measureMinClearance(inputSeq) {
	const native = await loadNative();
	const sim = new Sim(native);
	try {
		const { feature } = await makeFeature(sim);
		const lowestFns = CAR_DETAIL_SPECS.map(lowestWorldYFn);
		const minY = new Array(CAR_DETAIL_SPECS.length).fill(Infinity);

		for (const [input, steps] of inputSeq) {
			for (let i = 0; i < steps; i++) {
				sim.step(input);
				feature.afterFixedStep(FIXED_DT);
				const bodies = feature.hooks.bodies();
				for (let k = 0; k < bodies.length; k++) {
					const t = bodies[k].getTransform();
					const y = lowestFns[k](t.position, t.rotation);
					if (y < minY[k]) minY[k] = y;
				}
			}
		}
		feature.dispose?.();
		return minY;
	} finally {
		sim.destroy();
	}
}

function assertClearance(minY, label) {
	const offenders = [];
	CAR_DETAIL_SPECS.forEach((spec, k) => {
		const overridden = ATTACHED_SENSOR_OVERRIDE_IDS.has(spec.id);
		if (!overridden && minY[k] < CLEARANCE_MARGIN_M) offenders.push({ id: spec.id, minY: minY[k] });
	});
	if (offenders.length) console.log(`[cardetail-ground-contact] ${label} offenders:`, JSON.stringify(offenders));
	expect(offenders).toEqual([]);
}

describe('cardetail parts-ground-contact probe (Tier-3 stage 3)', () => {
	it('ordinary full-throttle driving (240 steps, matches features-cardetail.test.mjs benign case): no non-overridden part touches the ground', async () => {
		const minY = await measureMinClearance([[{ throttle: 1, brake: 0, steer: 0, handbrake: false }, 240]]);
		assertClearance(minY, 'benign full-throttle');
	});

	it('straight-line 5s cruise (matches straight-line.test.mjs): no non-overridden part touches the ground', async () => {
		const minY = await measureMinClearance([[{ throttle: 1, brake: 0, steer: 0, handbrake: false }, 300]]);
		assertClearance(minY, 'straight-line 5s');
	});

	it('launch + hard brake + swerve (4s, matches tuning.ts benign-driving calibration note): no non-overridden part touches the ground', async () => {
		const minY = await measureMinClearance([
			[{ throttle: 1, brake: 0, steer: 0, handbrake: false }, 90],
			[{ throttle: 0, brake: 1, steer: 0.6, handbrake: false }, 90],
			[{ throttle: 1, brake: 0, steer: -0.6, handbrake: false }, 60],
		]);
		assertClearance(minY, 'launch+brake+swerve');
	});

	// Documents WHY the 3 overridden parts stay sensors -- if a future chassis-geometry change (e.g.
	// the bay/floor rework) fixes their clearance too, this makes that visible (log shows positive
	// minY) rather than silently leaving them on the sensor list forever.
	it('logs the 3 ATTACHED_SENSOR_OVERRIDE_IDS parts own clearance (informational, not a pass/fail gate)', async () => {
		expect(ATTACHED_SENSOR_OVERRIDE_IDS.size).toBe(3);
		const minY = await measureMinClearance([[{ throttle: 1, brake: 0, steer: 0, handbrake: false }, 300]]);
		const overridden = CAR_DETAIL_SPECS.map((s, k) => ({ id: s.id, minY: minY[k] })).filter((r) => ATTACHED_SENSOR_OVERRIDE_IDS.has(r.id));
		console.log('[cardetail-ground-contact] override-set clearance @straight-line-5s:', JSON.stringify(overridden));
		expect(overridden.length).toBe(3);
	});
});
