// DIAGNOSTIC: why does kicker-jump.test.mjs's script no longer catch air after the friction fix?
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';

describe('diag: kicker instrument', () => {
	it('traces chassis pos/speed/wheel heights through the scripted kicker run', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		createGroundBody(world, 250);
		const vehicle = createVehicle(world);
		createDestructibleWorld(world);

		for (let i = 0; i < 30; i++) {
			stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
		}
		const restY = {};
		for (const key of Object.keys(vehicle.wheels)) restY[key] = vehicle.wheels[key].body.getPosition().y;

		const rows = [];
		for (let i = 0; i < 360; i++) {
			const x = vehicle.chassis.getPosition().x;
			const steer = Math.max(-0.2, Math.min(0.2, -x * 0.03));
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
			if (i % 6 === 0 || (vehicle.chassis.getPosition().z > 38 && vehicle.chassis.getPosition().z < 55)) {
				const pos = vehicle.chassis.getPosition();
				const vel = vehicle.chassis.getLinearVelocity();
				const speedKmh = Math.hypot(vel.x, vel.y, vel.z) * 3.6;
				const wheelY = {};
				for (const key of Object.keys(vehicle.wheels)) wheelY[key] = (vehicle.wheels[key].body.getPosition().y - restY[key]).toFixed(3);
				rows.push(`t=${(i / 60).toFixed(2)} pos=(${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}) speed=${speedKmh.toFixed(1)} wheelDY=${JSON.stringify(wheelY)}`);
			}
		}
		console.log('[kicker-trace]\n' + rows.join('\n'));
		world.destroy();
	});
});
