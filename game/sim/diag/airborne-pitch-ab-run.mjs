// DIAGNOSTIC A/B (plain node + scratch ts-loader, see airborne-pitch-run.mjs's header). Runs the same
// kicker-ramp launch twice: once against the REAL stepVehicle (game/src/vehicle/vehicle.ts, untouched),
// once against a TEMPORARY copy (./vehicle-nohacks.ts) with only the anti-roll/yaw-damping/anti-pitch
// chassis-torque block commented out, to isolate whether that block is what zeroes airborne angular
// velocity.
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle as createVehicleReal, stepVehicle as stepVehicleReal } from '../../src/vehicle/vehicle.ts';
import { createVehicle as createVehicleNoHacks, stepVehicle as stepVehicleNoHacks } from './vehicle-nohacks.ts';
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

async function runOnce(label, createVehicle, stepVehicle, native) {
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

	console.log(`\n[${label}] airborne samples: ${log.length}`);
	if (log.length > 0) {
		const step = (i) => log[Math.min(i, log.length - 1)];
		[0, 5, 10, 15, 20, 30, 40, 50, log.length - 1].forEach((i) => {
			if (i < log.length) {
				const l = step(i);
				console.log(`  step=${l.step} t=${l.t.toFixed(3)}s pitchRate=${l.pitchRate.toFixed(4)} |av|=${l.avMag.toFixed(4)} upDot=${l.upDot.toFixed(4)}`);
			}
		});
		const first = log[0];
		const last = log[log.length - 1];
		console.log(
			`[${label}] SUMMARY pitchRate ${first.pitchRate.toFixed(4)} -> ${last.pitchRate.toFixed(4)} over ${((last.step - first.step) * FIXED_DT).toFixed(3)}s; |av| ${first.avMag.toFixed(4)} -> ${last.avMag.toFixed(4)}`
		);
	}
	world.destroy();
	return log;
}

async function main() {
	const native = await init();
	const realLog = await runOnce('REAL (hacks ON)', createVehicleReal, stepVehicleReal, native);
	const nohacksLog = await runOnce('NO-HACKS (anti-roll/yaw/pitch OFF)', createVehicleNoHacks, stepVehicleNoHacks, native);
	console.log('\n[DIAG] Done. Compare |av| decay: REAL should collapse toward 0 in-air; NO-HACKS should stay roughly flat (only tiny rolling-resistance/contact-transient effects).');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
