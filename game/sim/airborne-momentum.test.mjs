// SPDX-License-Identifier: MIT
//
// Regression test for FIXROUND-2 diagnostic A ("airborne auto-leveling"): computeAntiRollTorque/
// computeYawDampingTorque/computeAntiPitchTorque used to be summed and applied to the chassis EVERY
// step unconditionally, with no ground-contact gate at all -- so a real, physical airborne rotation
// (e.g. off the kicker ramp) got actively cancelled by the same torque that's meant to keep the car
// level *while driving*, killing rotational momentum in the air. Measured pre-fix: pitch rate
// collapsed 0.6875 -> 0.0000 rad/s within ~0.3s airborne (a ~100% loss). Fixed by gating those assists
// (plus the new lateral-grip assist) on real ground contact (vehicle.ts's updateGroundAuthority()),
// ramped smoothly so a landing doesn't snap the leveling torque back on against whatever attitude the
// car landed at (vehicle.ts's SUSTAINED_AIRBORNE_STEPS/PARTIAL_AUTHORITY_FLOOR additionally keep the
// assists engaged through brief multi-wheel weight-transfer events that are NOT a real jump -- see
// their doc comments in tuning.ts for the sustained-oscillation-rollover regression that fix itself
// found and fixed).
//
// This test asserts the SPECIFIC thing kicker-jump.test.mjs (catches air / lands upright / still
// drivable) does not check numerically: that the chassis's pitch RATE is not artificially killed while
// genuinely airborne. Same kicker-ramp launch script as kicker-jump.test.mjs, including its yaw-angle
// lane-centering correction and shared (unpinned) ground -- see that file's header comment (vehicle
// deep-pass residual 3) for why the correction is yaw-based rather than position-based, and why the
// ground half-size no longer needs pinning.
// RE-CALIBRATED (vehicle deep-pass, GATE-A item 4 regression, root-caused): the friction fix (residual
// 1) makes the kicker launch meaningfully harder/more heavily loaded at the moment of departure, which
// stretched out the launch's own angular-rate RAMP-UP transient (chassis pitching up under a much
// stronger torque-driven wheelie before leaving the ramp). The test's old fixed "early" reference index
// (5th airborne sample) landed IN that ramp-up, not in the settled ballistic-flight regime -- so it
// captured a still-rising, not-yet-representative rate. Separately (and independently), a REAL bug was
// found and fixed in vehicle.ts's updateWheelGroundContact(): getSuspensionDeflection() lags true ground
// departure by up to ~1 spring period when a wheel leaves the ground still heavily loaded, so the
// anti-pitch/anti-roll/yaw-damping assists stayed at full authority for a genuine ~0.2-0.3s after the
// rear wheels actually left the ramp, re-damping the airborne rotation this test exists to protect (see
// vehicle.ts's doc comment on that fix, and game/sim/diag/airborne-pitch-check-*.test.mjs for the
// measured mechanism). With BOTH fixed, "early" is now picked at the first sample where
// telemetry.assistAuthority genuinely reaches 0 (the vehicle's own ground-truth "assists fully off, in
// real free flight" signal) instead of a fixed sample count -- this directly targets the property GATE-A
// item 4 requires (conservation once genuinely airborne) rather than a magic index tuned to the old,
// gentler launch profile.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../src/world/bodies.ts';
import { dot, LOCAL_UP, rotateVector } from '../src/vehicle/mathUtil.ts';

function upDot(rotation) {
	return dot(rotateVector(rotation, LOCAL_UP), { x: 0, y: 1, z: 0 });
}

function yawFromQuat(q) {
	return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

function wheelHeights(vehicle) {
	const out = {};
	for (const key of Object.keys(vehicle.wheels)) out[key] = vehicle.wheels[key].body.getPosition().y;
	return out;
}

describe('airborne-momentum', () => {
	it('pitch rate is not killed while genuinely airborne off the kicker ramp, and the car settles without flipping after landing', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		createGroundBody(world); // shared default -- see kicker-jump.test.mjs's header comment
		const vehicle = createVehicle(world);
		createDestructibleWorld(world);

		for (let i = 0; i < 30; i++) {
			stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
		}
		const rest = wheelHeights(vehicle);
		const AIR_THRESHOLD_M = 0.3;

		let airborne = false;
		let airStepIdx = 0;
		const log = [];
		const DRIVE_STEPS = 360;
		for (let i = 0; i < DRIVE_STEPS; i++) {
			const x = vehicle.chassis.getPosition().x;
			const yaw = yawFromQuat(vehicle.chassis.getRotation());
			const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + x * 0.01));
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);

			const h = wheelHeights(vehicle);
			const allAirborne = Object.keys(h).every((key) => h[key] - rest[key] > AIR_THRESHOLD_M);
			const av = vehicle.chassis.getAngularVelocity();
			const rot = vehicle.chassis.getRotation();
			const right = rotateVector(rot, { x: 1, y: 0, z: 0 });
			const pitchRate = dot(av, right);
			const assistAuthority = getTelemetry(vehicle).assistAuthority;
			if (allAirborne) {
				if (!airborne) {
					airborne = true;
					airStepIdx = 0;
				}
				log.push({ step: airStepIdx, pitchRate, assistAuthority });
				airStepIdx++;
			} else if (airborne) {
				airborne = false;
			}
		}

		expect(log.length).toBeGreaterThan(15); // genuinely caught sustained air (matches kicker-jump's bar)

		// "early" reference: the first sample where the vehicle's OWN ground-authority gate has fully
		// disengaged (assistAuthority === 0, see this file's header comment) -- the first point in the
		// log genuinely representative of unassisted free flight, not a fixed sample count tuned to the
		// old launch profile. Falls back to a late-log sample if authority never fully reaches 0 (should
		// not happen for a real sustained jump, but keeps this well-defined either way).
		let earlyIdx = log.findIndex((l) => l.assistAuthority === 0);
		if (earlyIdx === -1) earlyIdx = Math.min(5, log.length - 2);
		const early = Math.abs(log[earlyIdx].pitchRate);
		const last = Math.abs(log[log.length - 1].pitchRate);
		console.log(
			`[airborne-momentum] airborne samples=${log.length} early(idx=${earlyIdx}, authority=${log[earlyIdx].assistAuthority})=${early.toFixed(4)} last=${last.toFixed(4)}`,
		);

		// FIX verification: pitch rate must retain a meaningful fraction of its early in-flight
		// magnitude through to landing -- NOT collapse toward 0 the way the pre-fix bug did (measured
		// ~100% loss in ~0.3s). Real angular-momentum conservation in a near-vacuum flight can let
		// pitch rate grow as well as shrink (gravity/rotation coupling) -- retention, not exact
		// preservation, is what's being asserted (a rate that GROWS trivially passes this).
		expect(last).toBeGreaterThan(0.5 * early);

		// Post-landing: settle, then confirm it didn't flip and stays drivable (same bar as
		// kicker-jump.test.mjs).
		for (let i = 0; i < 60; i++) {
			stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
		}
		const landedUpDot = upDot(vehicle.chassis.getTransform().rotation);
		console.log(`[airborne-momentum] post-landing upDot=${landedUpDot.toFixed(3)}`);
		expect(landedUpDot).toBeGreaterThan(0.7);

		world.destroy();
	});
});
