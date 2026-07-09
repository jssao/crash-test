// SPDX-License-Identifier: MIT
//
// Regression test for playtest MAJOR #3: kicker ramp unreachable. Repro was the kicker sitting 8m
// ahead but 11m lateral from spawn -- unhittable driving straight ahead at speed. Fixed by relocating
// it directly ahead of spawn (game/src/world/tuning.ts's RAMP_CONFIGS: centerX=0, backZ=43 -- see that
// file's LAYOUT doc comment). This test scripts a straight full-throttle run from spawn and asserts
// the car actually catches air off the kicker (all 4 wheels simultaneously well above rest height for
// a sustained window, not just a single-step bump) and remains drivable after landing.
//
// LANE-CENTERING CORRECTION (vehicle deep-pass, residual 3 "kicker ground-extent sensitivity"): this
// used to be a small proportional correction on LATERAL POSITION (steer = -x*0.03). ROOT-CAUSED here:
// game/sim/diag/ground-extent-repro.test.mjs proves the underlying per-step chassis state is already
// bit-different from literally step 0 (a ~1e-7 position / ~1e-5 rad/s yaw-rate seed) purely from
// changing the STATIC ground body's half-size -- with the car nowhere near that edge, before it has
// even moved. That tiny numerical seed (plausibly a float32 precision/solver-iteration-order artifact
// from the ground shape's own vertex-generation math at different absolute scales; vendor/box3d is out
// of scope to instrument further) then amplifies through this vehicle's already-documented chaotic
// traction-taper feedback (tuning.ts's TRACTION_SLIP_ALLOWANCE_RAD_S doc comment) into a macroscopic
// difference by the time the car reaches the ramp (measured: ~0.7m divergence by t=4s between
// halfSize=250 vs 1000, ~1.8m vs 10000) -- a genuine sensitive-dependence-on-initial-conditions
// mechanism, not a "wrong physics" bug, and not something a vendor-untouched fix can remove outright.
// A position-based P correction reacts to yaw bias only AFTER it has already become position drift
// (effectively an extra integration lag on top of an already-chaotic loop), which measurably made
// things WORSE post-friction-fix (game/sim/diag/kicker-instrument-2/3.test.mjs: gain sweeps large
// enough to matter flip sign/magnitude near-randomly, several meters off centerline). Correcting
// YAW ANGLE directly instead (the actual root disturbance, one derivative earlier) is dramatically
// more robust: game/sim/diag/kicker-instrument-4/5.test.mjs swept a wide range of gains AND ground
// half-sizes (250/1000/5000/10000) and found sub-2cm lane deviation at the ramp in every case -- this
// is the fix that lets the ground-halfSize PIN be removed (uses createGroundBody()'s shared default,
// see vehicle.ts) rather than special-casing this test's world.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../src/world/bodies.ts';
import { dot, LOCAL_UP, rotateVector } from '../src/vehicle/mathUtil.ts';

function upDot(rotation) {
	return dot(rotateVector(rotation, LOCAL_UP), { x: 0, y: 1, z: 0 });
}

function yawFromQuat(q) {
	return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

let cachedNative = null;
async function loadNative() {
	if (cachedNative === null) cachedNative = init();
	return cachedNative;
}

function wheelHeights(vehicle) {
	const out = {};
	for (const key of Object.keys(vehicle.wheels)) out[key] = vehicle.wheels[key].body.getPosition().y;
	return out;
}

describe('kicker-jump', () => {
	it('a straight full-throttle run from spawn catches air off the kicker ramp and lands drivable', async () => {
		const native = await loadNative();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		// Shared default ground (see vehicle.ts's createGroundBody() doc comment) -- no longer pinned
		// to a smaller explicit halfSize now that the yaw-based lane correction below is robust across
		// ground sizes (see this file's header comment, residual 3).
		createGroundBody(world);
		const vehicle = createVehicle(world);
		createDestructibleWorld(world);

		// Let the car settle onto its suspension before recording "rest" wheel heights.
		for (let i = 0; i < 30; i++) {
			stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
		}
		const rest = wheelHeights(vehicle);

		const AIR_THRESHOLD_M = 0.3;
		const REQUIRED_AIR_STEPS = Math.ceil(0.3 / FIXED_DT); // >=0.3s simultaneously airborne

		let consecutiveAirSteps = 0;
		let maxConsecutiveAirSteps = 0;
		let everCaughtAir = false;

		// Straight full-throttle for up to 6s -- comfortably enough to reach the kicker (43m ahead) and
		// clear its ~2m length at any plausible speed, plus land. A mild yaw-angle correction (see this
		// file's header comment, residual 3) keeps the car centered on the kicker's lane (x=0): a long
		// full-throttle RWD launch with LITERALLY zero steering input drifts off-center over ~45m from a
		// small persistent yaw bias, same as how a real (attentive) player would make small corrections
		// to stay centered on a lane rather than holding the wheel dead level for a 45m sprint -- this
		// does not touch the "reachable in a straight line" fix itself (the correction gains are small
		// and only offset natural drift, not a deliberate turn).
		const DRIVE_STEPS = 360;
		for (let i = 0; i < DRIVE_STEPS; i++) {
			const x = vehicle.chassis.getPosition().x;
			const yaw = yawFromQuat(vehicle.chassis.getRotation());
			const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + x * 0.01));
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);

			const h = wheelHeights(vehicle);
			const allAirborne = Object.keys(h).every((key) => h[key] - rest[key] > AIR_THRESHOLD_M);
			if (allAirborne) {
				consecutiveAirSteps++;
				maxConsecutiveAirSteps = Math.max(maxConsecutiveAirSteps, consecutiveAirSteps);
				everCaughtAir = true;
			} else {
				consecutiveAirSteps = 0;
			}
		}

		console.log(`[kicker-jump] rest wheel heights=${JSON.stringify(rest)} maxConsecutiveAirSteps=${maxConsecutiveAirSteps} (need >=${REQUIRED_AIR_STEPS})`);

		expect(everCaughtAir).toBe(true);
		expect(maxConsecutiveAirSteps).toBeGreaterThanOrEqual(REQUIRED_AIR_STEPS);

		// Let it settle after landing.
		for (let i = 0; i < 60; i++) {
			stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
		}
		const landedTransform = vehicle.chassis.getTransform();
		const landedUpDot = upDot(landedTransform.rotation);
		console.log(`[kicker-jump] post-landing upDot=${landedUpDot.toFixed(3)} pos=${JSON.stringify(landedTransform.position)}`);
		expect(landedUpDot).toBeGreaterThan(0.7);

		// Remains drivable: continued throttle moves it >=10m further from where it landed.
		const posAtLanding = vehicle.chassis.getPosition();
		for (let i = 0; i < 240; i++) {
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
		}
		const posAfterDriving = vehicle.chassis.getPosition();
		const displacement = Math.hypot(
			posAfterDriving.x - posAtLanding.x,
			posAfterDriving.y - posAtLanding.y,
			posAfterDriving.z - posAtLanding.z,
		);
		console.log(`[kicker-jump] post-landing drive displacement=${displacement.toFixed(2)}m`);
		expect(displacement).toBeGreaterThanOrEqual(10);

		const finalUpDot = upDot(vehicle.chassis.getTransform().rotation);
		expect(finalUpDot).toBeGreaterThan(0.5);

		world.destroy();
	});
});
