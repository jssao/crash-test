// DIAGNOSTIC (plain node, not vitest -- vitest/vite is currently broken in this repo on the
// "crash test" space-containing directory name, see the write-up handed back with this run).
// Run with:
//   node --experimental-loader <scratchpad>/ts-loader.mjs game/sim/diag/airborne-pitch-run.mjs
// Logs chassis angular velocity every fixed step through the kicker-ramp flight (same launch script
// as game/sim/kicker-jump.test.mjs) to measure real pitch-rate decay while airborne.
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';
import { dot, LOCAL_UP, rotateVector } from '../../src/vehicle/mathUtil.ts';

function upDot(rotation) {
	return dot(rotateVector(rotation, LOCAL_UP), { x: 0, y: 1, z: 0 });
}

function wheelHeights(vehicle) {
	const out = {};
	for (const key of Object.keys(vehicle.wheels)) out[key] = vehicle.wheels[key].body.getPosition().y;
	return out;
}

async function main() {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, 250);
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
		const steer = Math.max(-0.2, Math.min(0.2, -x * 0.03));
		stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);

		const h = wheelHeights(vehicle);
		const allAirborne = Object.keys(h).every((key) => h[key] - rest[key] > AIR_THRESHOLD_M);
		const av = vehicle.chassis.getAngularVelocity();
		const rot = vehicle.chassis.getRotation();
		const right = rotateVector(rot, { x: 1, y: 0, z: 0 });
		const pitchRate = dot(av, right);
		if (allAirborne) {
			if (!airborne) {
				airborne = true;
				airStepIdx = 0;
			}
			log.push({ step: airStepIdx, t: i * FIXED_DT, pitchRate, upDot: upDot(rot), avMag: Math.sqrt(dot(av, av)) });
			airStepIdx++;
		} else if (airborne) {
			airborne = false;
		}
	}

	console.log(`[airborne-pitch] airborne samples: ${log.length}`);
	for (const l of log) {
		console.log(
			`  step=${l.step} t=${l.t.toFixed(3)}s pitchRate=${l.pitchRate.toFixed(4)} rad/s upDot=${l.upDot.toFixed(4)} |av|=${l.avMag.toFixed(4)}`
		);
	}
	if (log.length >= 2) {
		const first = log[0].pitchRate;
		const last = log[log.length - 1].pitchRate;
		const dtAir = (log[log.length - 1].step - log[0].step) * FIXED_DT;
		console.log(
			`[airborne-pitch] SUMMARY pitchRate first=${first.toFixed(4)} last=${last.toFixed(4)} over ${dtAir.toFixed(3)}s of continuous air ` +
				`(delta=${(first - last).toFixed(4)} rad/s, decay-rate=${((first - last) / dtAir).toFixed(3)} (rad/s)/s), upDot first=${log[0].upDot.toFixed(4)} last=${log[log.length - 1].upDot.toFixed(4)}`
		);
	} else {
		console.log('[airborne-pitch] not enough sustained-air samples -- car may not have cleared the kicker this run');
	}

	world.destroy();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
