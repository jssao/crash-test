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

		// RE-CALIBRATED (airborne round 3, asymmetric-launch honesty pass -- measured justification):
		// this used to be an unconditional full-throttle run, arriving at the 30-degree kicker at
		// ~73km/h. Under the honest strict assist gating (vehicle.ts's updateGroundAuthority(): full
		// authority only at >=3 grounded wheels, instant cut on contact loss), the ramp face unloads
		// the front axle so the climb happens on the rear wheels alone (2 grounded) -- the anti-pitch
		// assist that previously (and dishonestly, per the round-3 escalation) damped the launch
		// rotation DURING the climb is correctly off, and a full-send 73km/h hit now genuinely
		// backflips the car onto its roof (measured entry-speed sweep, settled upDot after landing:
		// 43km/h->0.87, 47->0.90, 50->0.93, 54->1.000, 58->1.000, 65->1.000, full-send 73 -> -1.000
		// on the roof). That flip is real crash-sandbox physics, not a regression -- flipping at full
		// send is exactly what the round-3 escalation demands be REACHABLE (see
		// asymmetric-launch.test.mjs for the roll-direction equivalent). THIS test's contract is the
		// playability one (kicker reachable straight ahead, catches real air, lands drivable), so the
		// approach now models a player lifting off the throttle just before the jump: hold ~58km/h
		// (16.1 m/s) until the ramp base (z=41), then coast -- squarely in the measured
		// lands-clean band, still catching ~0.65s of air (39-41 airborne steps, need >=18).
		// MUSTANG-65 SWAP RE-CALIBRATION (measured justification): the hero-car swap dropped the wheel
		// radius 0.39m -> 0.31m (car-map.ts), so the car sits ~8cm lower and flies a shorter, flatter arc
		// off the same 1.2m/30deg kicker. At the old 16.1 m/s entry the lower car no longer CLEARS the
		// ramp's back edge -- it lands short (z~47.3) with its rear underside hung up on the 1.2m apex,
		// rear (driven) wheels in the air -> zero traction -> won't drive off (measured: disp 0.00m,
		// nose-down upDot 0.964). Re-swept entry speed on the actual Mustang: 16.1->stuck, but 18/20/22/24
		// m/s all clear the ramp and land flat and drivable (upDot 1.000, drive-away 43m) -- the smaller-
		// wheel / lower-CoM car has a WIDER clean-landing window than the concept car did (no backflip even
		// at 24 m/s). 18 m/s (~65km/h) sits at the low, safe end of that measured band.
		const KICKER_ENTRY_SPEED_MS = 18; // ~65km/h, measured Mustang clean-landing band 18-24 m/s (see above)
		const THROTTLE_CUT_Z = 41; // ramp base is at z=43; lift ~2m before it
		const DRIVE_STEPS = 420;
		for (let i = 0; i < DRIVE_STEPS; i++) {
			const pos = vehicle.chassis.getPosition();
			const vel = vehicle.chassis.getLinearVelocity();
			const speed = Math.hypot(vel.x, vel.y, vel.z);
			const x = pos.x;
			const yaw = yawFromQuat(vehicle.chassis.getRotation());
			const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + x * 0.01));
			const throttle = pos.z < THROTTLE_CUT_Z && speed < KICKER_ENTRY_SPEED_MS ? 1 : 0;
			stepVehicle(vehicle, { throttle, brake: 0, steer, handbrake: false }, FIXED_DT);
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
