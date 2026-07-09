// DIAGNOSTIC: raw per-wheel getSuspensionDeflection() values during the false-grounded window, plus
// chassis pitch angle/rate, to find exactly what's producing the false-positive "grounded" reading.
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getSuspensionDeflection } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';
import { dot, rotateVector } from '../../src/vehicle/mathUtil.ts';

function wheelHeights(vehicle) {
	const out = {};
	for (const key of Object.keys(vehicle.wheels)) out[key] = vehicle.wheels[key].body.getPosition().y;
	return out;
}

describe('diag: airborne pitch check 3 (raw deflection values)', () => {
	it('raw per-wheel deflection + pitch angle/rate during the flight', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		createGroundBody(world);
		const vehicle = createVehicle(world);
		createDestructibleWorld(world);
		for (let i = 0; i < 30; i++) {
			stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
		}
		const rest = wheelHeights(vehicle);
		const AIR_THRESHOLD_M = 0.3;
		let airborne = false;
		const rows = [];
		for (let i = 0; i < 360; i++) {
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
			const h = wheelHeights(vehicle);
			const allAirborne = Object.keys(h).every((key) => h[key] - rest[key] > AIR_THRESHOLD_M);
			if (allAirborne) airborne = true;
			if (airborne) {
				const defl = {};
				for (const key of Object.keys(vehicle.wheels)) defl[key] = getSuspensionDeflection(vehicle, key).toFixed(3);
				const rot = vehicle.chassis.getRotation();
				const forward = rotateVector(rot, { x: 0, y: 0, z: 1 });
				const pitchAngleDeg = (Math.asin(Math.max(-1, Math.min(1, dot(forward, { x: 0, y: 1, z: 0 })))) * 180) / Math.PI;
				rows.push(`defl=${JSON.stringify(defl)} pitchDeg=${pitchAngleDeg.toFixed(2)}`);
				if (rows.length > 30) break;
			}
		}
		console.log('[raw-deflection-trace]\n' + rows.join('\n'));
		world.destroy();
	});
});
