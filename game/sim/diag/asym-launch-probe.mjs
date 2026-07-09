// SPDX-License-Identifier: MIT
//
// MEASUREMENT PROBE (airborne round 3, asymmetric-launch honesty): drive HALF-ON the kicker ramp at
// several controlled speeds and print the raw roll-rate/flight/landing numbers, so the regression
// bounds in game/sim/asymmetric-launch.test.mjs are set from measured truth rather than guessed.
// Run: npx vite-node sim/diag/asym-launch-probe.mjs
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, CHASSIS_ORIGIN_HEIGHT_M, WHEEL_SPAWN_SETTLE_MARGIN_M } from '../../src/vehicle/tuning.ts';
import { RAMP_CONFIGS, RAMP_FRICTION } from '../../src/world/tuning.ts';
import { wedgeHullPoints } from '../../src/world/bodies.ts';
import { BodyType } from '../../../src/ts/index.ts';
import { dot, LOCAL_UP, LOCAL_FORWARD, rotateVector } from '../../src/vehicle/mathUtil.ts';

const LANE_X = 1.2; // car center on the kicker's right edge: right wheels ON the ramp, left wheels OFF

function upDot(rotation) {
	return dot(rotateVector(rotation, LOCAL_UP), { x: 0, y: 1, z: 0 });
}
function yawFromQuat(q) {
	return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

async function run(targetSpeedMs) {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world);
	// Kicker only (no other world clutter): same static wedge createDestructibleWorld() builds.
	const kicker = RAMP_CONFIGS.find((r) => r.id === 'kicker');
	const rampBody = world.createBody({ type: BodyType.Static, position: { x: kicker.centerX, y: 0, z: kicker.backZ } });
	rampBody.createHullShape(wedgeHullPoints(kicker.width, kicker.length, kicker.height), { density: 1, friction: RAMP_FRICTION });

	const vehicle = createVehicle(world, { x: LANE_X, y: CHASSIS_ORIGIN_HEIGHT_M - WHEEL_SPAWN_SETTLE_MARGIN_M, z: -60 });

	for (let i = 0; i < 30; i++) {
		stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
	}

	let phase = 'approach'; // approach -> airborne -> landed
	let speedAtRamp = 0;
	const flight = [];
	let landing = null;
	let steps = 0;
	const MAX_STEPS = 60 * 20;

	while (phase !== 'landed' && steps < MAX_STEPS) {
		steps++;
		const pos = vehicle.chassis.getPosition();
		const vel = vehicle.chassis.getLinearVelocity();
		const rot = vehicle.chassis.getRotation();
		const speed = Math.hypot(vel.x, vel.y, vel.z);

		let input;
		if (phase === 'approach') {
			const yaw = yawFromQuat(rot);
			const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + (pos.x - LANE_X) * 0.01));
			const throttle = speed < targetSpeedMs ? 1 : 0;
			input = { throttle, brake: 0, steer, handbrake: false };
		} else {
			input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
		}
		stepVehicle(vehicle, input, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);

		if (phase === 'approach' && pos.z >= kicker.backZ && speedAtRamp === 0) speedAtRamp = speed;

		// Wheels are spheres: exact ground clearance = center.y - radius (ground top at y=0).
		const clearances = Object.values(vehicle.wheels).map((w) => w.body.getPosition().y - w.def.radius);
		const allAir = clearances.every((c) => c > 0.12);
		const anyContact = clearances.some((c) => c < 0.03);

		const rotNow = vehicle.chassis.getRotation();
		const av = vehicle.chassis.getAngularVelocity();
		const fwd = rotateVector(rotNow, LOCAL_FORWARD);
		const rollRate = dot(av, fwd);
		const omegaMag = Math.hypot(av.x, av.y, av.z);

		if (phase === 'approach' && allAir && pos.z > kicker.backZ) {
			phase = 'airborne';
		}
		if (phase === 'airborne') {
			flight.push({ rollRate, omegaMag, authority: getTelemetry(vehicle).assistAuthority, upDot: upDot(rotNow) });
			if (anyContact && flight.length > 3) {
				phase = 'landed';
				landing = { upDot: upDot(rotNow), rollRate, z: pos.z };
			}
		}
	}

	const n = flight.length;
	if (n < 5) {
		console.log(`target=${targetSpeedMs}m/s speedAtRamp=${(speedAtRamp * 3.6).toFixed(1)}km/h -- NO real flight (${n} samples)`);
		world.destroy();
		return;
	}
	const first = flight[0];
	const last = flight[n - 2]; // n-1 is the contact step itself
	const flightT = n * FIXED_DT;
	const totalRollDeg = (flight.reduce((s, f) => s + Math.abs(f.rollRate), 0) * FIXED_DT * 180) / Math.PI;
	const decayPerS = (1 - Math.abs(last.rollRate) / Math.abs(first.rollRate)) / flightT;
	const maxAuthority = Math.max(...flight.map((f) => f.authority));
	console.log(
		`target=${targetSpeedMs}m/s speedAtRamp=${(speedAtRamp * 3.6).toFixed(1)}km/h flight=${flightT.toFixed(2)}s samples=${n}\n` +
			`  rollRate first=${first.rollRate.toFixed(3)} last=${last.rollRate.toFixed(3)} decay=${(decayPerS * 100).toFixed(1)}%/s |w|first=${first.omegaMag.toFixed(3)}\n` +
			`  totalRoll=${totalRollDeg.toFixed(1)}deg maxAuthorityInFlight=${maxAuthority} landing upDot=${landing ? landing.upDot.toFixed(3) : 'n/a'} z=${landing ? landing.z.toFixed(1) : '?'}`,
	);
	world.destroy();
}

for (const v of [10, 12, 14, 17, 20, 22]) {
	await run(v);
}
