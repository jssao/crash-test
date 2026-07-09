// DIAGNOSTIC: with the new yaw-based lane correction, does the kicker jump now reliably clear at
// BOTH the old pinned halfSize (250) and a much larger one (5000, 10000), confirming the fix is
// robust to ground-extent and the pin can be removed?
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';

function yawFromQuat(q) {
	return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

function wheelHeights(vehicle) {
	const out = {};
	for (const key of Object.keys(vehicle.wheels)) out[key] = vehicle.wheels[key].body.getPosition().y;
	return out;
}

async function run(halfSize) {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, halfSize);
	const vehicle = createVehicle(world);
	createDestructibleWorld(world);
	for (let i = 0; i < 30; i++) {
		stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
	}
	const rest = wheelHeights(vehicle);
	const AIR_THRESHOLD_M = 0.3;
	const REQUIRED_AIR_STEPS = Math.ceil(0.3 / FIXED_DT);
	let consecutiveAirSteps = 0;
	let maxConsecutiveAirSteps = 0;
	for (let i = 0; i < 360; i++) {
		const yaw = yawFromQuat(vehicle.chassis.getRotation());
		const x = vehicle.chassis.getPosition().x;
		const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + x * 0.01));
		stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		const h = wheelHeights(vehicle);
		const allAirborne = Object.keys(h).every((key) => h[key] - rest[key] > AIR_THRESHOLD_M);
		if (allAirborne) {
			consecutiveAirSteps++;
			maxConsecutiveAirSteps = Math.max(maxConsecutiveAirSteps, consecutiveAirSteps);
		} else consecutiveAirSteps = 0;
	}
	world.destroy();
	return { maxConsecutiveAirSteps, required: REQUIRED_AIR_STEPS };
}

describe('diag: kicker instrument 5 (robustness of yaw-correction across ground sizes)', () => {
	it('clears the required air-steps threshold at halfSize 250, 1000, 5000, 10000', async () => {
		for (const hs of [250, 1000, 5000, 10000]) {
			const r = await run(hs);
			console.log(`[halfSize=${hs}] maxConsecutiveAirSteps=${r.maxConsecutiveAirSteps} (need >=${r.required})`);
		}
	});
});
