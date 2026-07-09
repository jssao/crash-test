// DIAGNOSTIC: real settled top speed with a genuinely large ground plane (rules out edge-falloff).
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';

describe('diag: top speed instrument 2 (big ground, long run)', () => {
	it('60s full throttle, halfSize=8000', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		createGroundBody(world, 8000);
		const vehicle = createVehicle(world);
		let maxSpeed = 0;
		const rows = [];
		for (let i = 0; i < 3600; i++) {
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
			const t = getTelemetry(vehicle);
			maxSpeed = Math.max(maxSpeed, t.speedKmh);
			if (i % 300 === 0) rows.push(`t=${(i / 60).toFixed(0)} speed=${t.speedKmh.toFixed(1)} gear=${t.gear} rpm=${t.rpm.toFixed(0)} grounded=${t.groundedWheelCount} pos=${vehicle.chassis.getPosition().z.toFixed(0)}`);
		}
		console.log('[bigground-trace]\n' + rows.join('\n'));
		console.log(`[bigground] maxSpeed=${maxSpeed.toFixed(1)}km/h finalPos.z=${vehicle.chassis.getPosition().z.toFixed(0)}m`);
		world.destroy();
	});
});
