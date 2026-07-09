// DIAGNOSTIC: compare kicker-approach lateral drift WITH vs WITHOUT the test script's own small
// steer correction, to see if the correction itself is now destabilizing (vs the raw uncorrected
// drift).
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';

async function run(correctionGain) {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, 250);
	const vehicle = createVehicle(world);
	createDestructibleWorld(world);
	for (let i = 0; i < 30; i++) {
		stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
	}
	const rows = [];
	for (let i = 0; i < 300; i++) {
		const x = vehicle.chassis.getPosition().x;
		const steer = correctionGain === 0 ? 0 : Math.max(-0.2, Math.min(0.2, -x * correctionGain));
		stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		const z = vehicle.chassis.getPosition().z;
		if (z > 40 && z < 46) {
			rows.push(`z=${z.toFixed(2)} x=${vehicle.chassis.getPosition().x.toFixed(3)}`);
		}
	}
	world.destroy();
	return rows;
}

describe('diag: kicker instrument 2 (correction gain sensitivity)', () => {
	it('x-position while crossing z=40-46 for several correction gains', async () => {
		for (const gain of [0, 0.01, 0.02, 0.03, 0.05]) {
			const rows = await run(gain);
			console.log(`[gain=${gain}] ` + rows.join(' | '));
		}
	});
});
