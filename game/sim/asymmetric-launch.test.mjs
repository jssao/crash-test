// SPDX-License-Identifier: MIT
//
// Regression test for airborne round 3 (user escalation: a car launching HALF-ON the kicker ramp
// "corrects itself flat before landing instead of flipping like it should"). Rounds 1-2 only ever
// regression-tested SYMMETRIC pitch launches (airborne-momentum.test.mjs); the asymmetric case had
// two dedicated dishonesty mechanisms of its own, both fixed in vehicle.ts's updateGroundAuthority():
//   1. Full assist authority used to persist at >=2 grounded wheels -- and a half-on-ramp launch
//      keeps EXACTLY 2 wheels (the off-ramp side) grounded for the whole climb, so the anti-roll
//      assist actively killed the roll rate the ramp geometry was imparting, at its source.
//   2. The takeoff direction shared ASSIST_AUTHORITY_RAMP_TIME_S's smoothing ramp with landing,
//      bleeding decaying-but-nonzero leveling authority into the first ~0.15s of genuine flight.
// Now: full authority ONLY at >=3 grounded wheels (with an upDot>0.5 wheel-support plausibility
// check -- see updateGroundAuthority()'s doc comment for the measured mid-tumble deflection-chatter
// leak it closes), instant cut on contact loss, ramp retained for landing re-entry only.
//
// SCENARIO: drive straight at a held target speed with the car's centerline on the kicker's right
// edge (LANE_X = ramp half-width = 1.2m): the right wheels ride the 30-degree face, the left wheels
// stay on flat ground, and the lip converts that geometry into real roll rate. World contains ONLY
// ground + the kicker (same static wedge createDestructibleWorld() builds, from the same
// RAMP_CONFIGS/wedgeHullPoints source) -- this is a vehicle-physics regression, so the rest of the
// destructible clutter would only add unrelated reshuffle noise.
//
// MEASURED TRUTH the bounds below encode (sim/diag/asym-launch-probe.mjs +
// asym-halfmean-probe.mjs, this pass; exact values from this test's own spawn/speed script):
//   entry 32.2km/h: flight 0.65s, totalRoll  63.2deg, landing upDot  0.502
//   entry 39.9km/h: flight 0.78s, totalRoll 110.3deg, landing upDot -0.224  <- lands PAST 90deg
//   entry 48.6km/h: flight 1.37s, totalRoll 197.1deg, landing upDot -0.929  <- roof-first
//   maxAuthorityInFlight = 0 at every speed (zero assist bleed once genuinely airborne); roll is
//   96-97% of the total launch rotation; |angular velocity| half-of-flight means decay +3.8 / -9.8
//   / -2.6 %/s (essentially conserved -- nothing like the pre-fix ~100%-in-0.3s kill), while the
//   body-roll COMPONENT alone precesses +-50%/s (see HONESTY GATE 2 below for why the magnitude is
//   the honest conserved quantity).
import { describe, expect, it } from 'vitest';
import { init, World, BodyType } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, CHASSIS_ORIGIN_HEIGHT_M, WHEEL_SPAWN_SETTLE_MARGIN_M } from '../src/vehicle/tuning.ts';
import { RAMP_CONFIGS, RAMP_FRICTION } from '../src/world/tuning.ts';
import { wedgeHullPoints } from '../src/world/bodies.ts';
import { dot, LOCAL_UP, LOCAL_FORWARD, rotateVector } from '../src/vehicle/mathUtil.ts';

const LANE_X = 1.2; // kicker half-width: centerline on the ramp's right edge = a true half-on launch

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

/**
 * One half-on launch at a held target speed. Spawn distance scales with target speed so each run
 * has enough run-up without wasting sim time. Returns measured flight/landing quantities.
 */
async function runHalfOnLaunch(targetSpeedMs, spawnZ) {
	const native = await loadNative();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world);
	const kicker = RAMP_CONFIGS.find((r) => r.id === 'kicker');
	const rampBody = world.createBody({ type: BodyType.Static, position: { x: kicker.centerX, y: 0, z: kicker.backZ } });
	rampBody.createHullShape(wedgeHullPoints(kicker.width, kicker.length, kicker.height), { density: 1, friction: RAMP_FRICTION });

	const vehicle = createVehicle(world, { x: LANE_X, y: CHASSIS_ORIGIN_HEIGHT_M - WHEEL_SPAWN_SETTLE_MARGIN_M, z: spawnZ });

	for (let i = 0; i < 30; i++) {
		stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
	}

	let phase = 'approach';
	let speedAtRamp = 0;
	const flight = []; // per-airborne-step samples
	let landingUpDot = null;
	const MAX_STEPS = 60 * 20;

	for (let s = 0; s < MAX_STEPS && phase !== 'landed'; s++) {
		const pos = vehicle.chassis.getPosition();
		const vel = vehicle.chassis.getLinearVelocity();
		const rot = vehicle.chassis.getRotation();
		const speed = Math.hypot(vel.x, vel.y, vel.z);

		let input;
		if (phase === 'approach') {
			// Lane-keep on LANE_X (same yaw-first correction shape as kicker-jump.test.mjs) + bang-bang
			// speed hold, coasting once airborne-bound; no input in flight (a player can't steer air).
			const yaw = yawFromQuat(rot);
			const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + (pos.x - LANE_X) * 0.01));
			input = { throttle: speed < targetSpeedMs ? 1 : 0, brake: 0, steer, handbrake: false };
		} else {
			input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
		}
		stepVehicle(vehicle, input, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);

		if (phase === 'approach' && pos.z >= kicker.backZ && speedAtRamp === 0) speedAtRamp = speed;

		// Wheels are spheres, so exact per-wheel ground clearance is center.y - radius (ground top is
		// y=0; the only other surface, the kicker, is behind the car once past the lip) -- an
		// attitude-independent, proxy-free airborne measure.
		const clearances = Object.values(vehicle.wheels).map((w) => w.body.getPosition().y - w.def.radius);
		const allAir = clearances.every((c) => c > 0.12);
		const anyContact = clearances.some((c) => c < 0.03);

		if (phase === 'approach' && allAir && pos.z > kicker.backZ) phase = 'airborne';
		if (phase === 'airborne') {
			const av = vehicle.chassis.getAngularVelocity();
			const fwd = rotateVector(rot, LOCAL_FORWARD);
			flight.push({
				rollRate: dot(av, fwd),
				omegaMag: Math.hypot(av.x, av.y, av.z),
				authority: getTelemetry(vehicle).assistAuthority,
				upDot: upDot(rot),
			});
			if (anyContact && flight.length > 3) {
				phase = 'landed';
				landingUpDot = upDot(rot);
			}
		}
	}

	world.destroy();
	const totalRollDeg = (flight.reduce((acc, f) => acc + Math.abs(f.rollRate), 0) * FIXED_DT * 180) / Math.PI;
	return {
		speedAtRampKmh: speedAtRamp * 3.6,
		flight,
		flightSeconds: flight.length * FIXED_DT,
		totalRollDeg,
		maxAuthorityInFlight: flight.length ? Math.max(...flight.map((f) => f.authority)) : null,
		landingUpDot,
	};
}

describe('asymmetric-launch (half-on the kicker)', () => {
	it(
		'roll rate imparted by a half-on launch is preserved through flight, scales with speed, and flipping is reachable',
		async () => {
			// 3 held entry speeds; spawn distance sized to each (see runHalfOnLaunch()).
			const runs = [
				{ target: 14, spawnZ: -5 }, // ~33km/h at the ramp
				{ target: 17, spawnZ: -25 }, // ~40km/h
				{ target: 20, spawnZ: -60 }, // ~49km/h
			];
			const results = [];
			for (const r of runs) results.push(await runHalfOnLaunch(r.target, r.spawnZ));

			for (const [i, res] of results.entries()) {
				console.log(
					`[asymmetric-launch] run${i} rampSpeed=${res.speedAtRampKmh.toFixed(1)}km/h flight=${res.flightSeconds.toFixed(2)}s ` +
						`totalRoll=${res.totalRollDeg.toFixed(1)}deg maxAuthority=${res.maxAuthorityInFlight} landingUpDot=${res.landingUpDot?.toFixed(3)}`,
				);
				// Real, sustained flight at every tested speed (not a curb hop).
				expect(res.flight.length).toBeGreaterThan(20);
				expect(res.landingUpDot).not.toBeNull();

				// HONESTY GATE 1: zero assist authority during genuine flight -- no bleed, no mid-air
				// re-latch (the instant-cut + >=3-wheel + wheel-support-plausibility gating, measured).
				expect(res.maxAuthorityInFlight).toBe(0);

				// HONESTY GATE 2: the rotation the ramp imparted is PRESERVED through flight -- decay
				// bounded at <10%/s (the pre-fix auto-leveling killed ~100% in ~0.3s). Two parts, both
				// measured (sim/diag/asym-halfmean-probe.mjs):
				//  (a) The launch rotation IS roll: first-half-of-flight mean |body-roll rate| is >=60%
				//      of mean |total angular speed| (measured 96-97% at all three speeds) -- so this
				//      can't silently pass on pitch-only rotation.
				//  (b) Rotation MAGNITUDE decays <10%/s between flight halves (measured: +3.8%/s decay /
				//      -9.8 / -2.6, i.e. essentially conserved). The magnitude -- not the body-roll
				//      COMPONENT -- is the honest conserved quantity: a torque-free asymmetric body
				//      exchanges rotation between its axes (precession; the roll component alone was
				//      measured swinging +-50%/s in genuinely assist-free flight while |w| held), and
				//      what the pre-fix bug killed was the magnitude itself.
				const half = Math.floor(res.flight.length / 2);
				const meanAbs = (arr, sel) => arr.reduce((acc, f) => acc + Math.abs(sel(f)), 0) / arr.length;
				const rollMean1 = meanAbs(res.flight.slice(0, half), (f) => f.rollRate);
				const omegaMean1 = meanAbs(res.flight.slice(0, half), (f) => f.omegaMag);
				const omegaMean2 = meanAbs(res.flight.slice(half, res.flight.length - 1), (f) => f.omegaMag);
				const halfSeconds = (res.flightSeconds / 2) || 1e-6;
				const decayPerS = (1 - omegaMean2 / omegaMean1) / halfSeconds;
				console.log(
					`[asymmetric-launch] run${i} rollDominance=${(rollMean1 / omegaMean1).toFixed(3)} omegaHalfMeans=${omegaMean1.toFixed(3)}->${omegaMean2.toFixed(3)} decay=${(decayPerS * 100).toFixed(1)}%/s`,
				);
				expect(rollMean1 / omegaMean1).toBeGreaterThan(0.6);
				expect(decayPerS).toBeLessThan(0.1);
			}

			// Higher entry speed -> more total rotation accumulated in flight (measured 64.7 / 101.8 /
			// 197.1 deg at 32.6/39.9/48.6 km/h -- the ramp's geometric roll kick AND the flight time both
			// grow with speed, so this ordering is a real physical property, not tuning luck).
			expect(results[1].totalRollDeg).toBeGreaterThan(results[0].totalRollDeg);
			expect(results[2].totalRollDeg).toBeGreaterThan(results[1].totalRollDeg);

			// FLIPPING IS REACHABLE (the round-3 escalation's headline): at least one tested speed lands
			// genuinely non-wheels-down, rolled >=90deg (upDot <= 0 at first ground contact). Measured:
			// -0.140 at ~40km/h and -0.919 at ~49km/h.
			const minLandingUpDot = Math.min(...results.map((r) => r.landingUpDot));
			console.log(`[asymmetric-launch] minLandingUpDot=${minLandingUpDot.toFixed(3)}`);
			expect(minLandingUpDot).toBeLessThanOrEqual(0);
		},
		120000,
	);
});
