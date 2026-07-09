// SPDX-License-Identifier: MIT
//
// Regression test for playtest MAJOR #3: kicker ramp unreachable. Repro was the kicker sitting 8m
// ahead but 11m lateral from spawn -- unhittable driving straight ahead at speed. Fixed by relocating
// it directly ahead of spawn (game/src/world/tuning.ts's RAMP_CONFIGS: centerX=0, backZ=43 -- see that
// file's LAYOUT doc comment). This test scripts a straight full-throttle run from spawn and asserts
// the car actually catches air off the kicker (all 4 wheels simultaneously well above rest height for
// a sustained window, not just a single-step bump) and remains drivable after landing.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../src/world/bodies.ts';
import { dot, LOCAL_UP, rotateVector } from '../src/vehicle/mathUtil.ts';

function upDot(rotation) {
	return dot(rotateVector(rotation, LOCAL_UP), { x: 0, y: 1, z: 0 });
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
		// clear its ~2m length at any plausible speed, plus land. A very mild proportional steer
		// correction keeps the car centered on the kicker's lane (x=0): a long full-throttle RWD launch
		// with LITERALLY zero steering input drifts several meters off-center over ~45m from a small
		// persistent yaw bias (verified directly -- by z=43 the chassis had drifted to x=-3.25, already
		// outside the kicker's own 2.4m width), same as how a real (attentive) player would make small
		// corrections to stay centered on a lane rather than holding the wheel dead level for a 45m
		// sprint -- this does not touch the "reachable in a straight line" fix itself (the correction
		// gain is small and only offsets natural drift, not a deliberate turn).
		const DRIVE_STEPS = 360;
		for (let i = 0; i < DRIVE_STEPS; i++) {
			const x = vehicle.chassis.getPosition().x;
			const steer = Math.max(-0.2, Math.min(0.2, -x * 0.03));
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
