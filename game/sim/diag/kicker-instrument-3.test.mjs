// DIAGNOSTIC: try a PD (position+rate) lane-centering correction instead of pure-P, since pure-P
// gains are chaotically sensitive (see kicker-instrument-2.test.mjs).
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';

async function run(kp, kd) {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, 250);
	const vehicle = createVehicle(world);
	createDestructibleWorld(world);
	for (let i = 0; i < 30; i++) {
		stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
	}
	let maxAbsXAtRamp = 0;
	for (let i = 0; i < 300; i++) {
		const x = vehicle.chassis.getPosition().x;
		const vx = vehicle.chassis.getLinearVelocity().x;
		const steer = Math.max(-0.3, Math.min(0.3, -(x * kp + vx * kd)));
		stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		const z = vehicle.chassis.getPosition().z;
		if (z > 43 && z < 45.1) maxAbsXAtRamp = Math.max(maxAbsXAtRamp, Math.abs(vehicle.chassis.getPosition().x));
	}
	world.destroy();
	return maxAbsXAtRamp;
}

describe('diag: kicker instrument 3 (PD correction)', () => {
	it('max |x| while crossing the ramp span for several PD gains', async () => {
		for (const [kp, kd] of [
			[0.02, 0],
			[0.02, 0.05],
			[0.03, 0.1],
			[0.04, 0.15],
			[0.05, 0.2],
			[0.06, 0.25],
		]) {
			const maxAbsX = await run(kp, kd);
			console.log(`[kp=${kp} kd=${kd}] maxAbsXAtRamp=${maxAbsX.toFixed(3)}m`);
		}
	});
});
