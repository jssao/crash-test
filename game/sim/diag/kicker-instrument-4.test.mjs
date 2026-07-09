// DIAGNOSTIC: yaw-angle-based correction (steer proportional to -yawAngle, not position) -- should
// converge faster/more robustly than a pure position-based P controller (which reacts one integration
// step later, after yaw bias has already become position drift).
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';

function yawFromQuat(q) {
	return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

async function run(kYaw, kX) {
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
		const yaw = yawFromQuat(vehicle.chassis.getRotation());
		const steer = Math.max(-0.3, Math.min(0.3, yaw * kYaw + x * kX));
		stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		const z = vehicle.chassis.getPosition().z;
		if (z > 43 && z < 45.1) maxAbsXAtRamp = Math.max(maxAbsXAtRamp, Math.abs(vehicle.chassis.getPosition().x));
	}
	world.destroy();
	return maxAbsXAtRamp;
}

describe('diag: kicker instrument 4 (yaw-based correction)', () => {
	it('max |x| while crossing the ramp span for several yaw+position gains', async () => {
		for (const [ky, kx] of [
			[2, 0.01],
			[3, 0.01],
			[4, 0.01],
			[5, 0.02],
			[6, 0.02],
			[8, 0.02],
			[10, 0.03],
			[4, 0],
			[6, 0],
			[8, 0],
		]) {
			const maxAbsX = await run(ky, kx);
			console.log(`[kYaw=${ky} kX=${kx}] maxAbsXAtRamp=${maxAbsX.toFixed(3)}m`);
		}
	});
});
