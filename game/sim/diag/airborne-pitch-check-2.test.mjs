// DIAGNOSTIC: cross-check vehicle.ts's OWN ground-contact/authority telemetry against pitch rate
// during the flight, to see if the assist-authority gate is (wrongly) re-engaging mid-flight.
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';
import { dot, rotateVector } from '../../src/vehicle/mathUtil.ts';

function wheelHeights(vehicle) {
	const out = {};
	for (const key of Object.keys(vehicle.wheels)) out[key] = vehicle.wheels[key].body.getPosition().y;
	return out;
}

describe('diag: airborne pitch check 2 (ground-authority cross-check)', () => {
	it('telemetry.groundedWheelCount / assistAuthority through the flight, steer=0', async () => {
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
			const t = getTelemetry(vehicle);
			const av = vehicle.chassis.getAngularVelocity();
			const rot = vehicle.chassis.getRotation();
			const right = rotateVector(rot, { x: 1, y: 0, z: 0 });
			const pitchRate = dot(av, right);
			if (allAirborne && !airborne) airborne = true;
			if (airborne) {
				rows.push(
					`wheelAirborne=${allAirborne} groundedCount=${t.groundedWheelCount} authority=${t.assistAuthority.toFixed(3)} pitchRate=${pitchRate.toFixed(4)} h=${JSON.stringify(
						Object.fromEntries(Object.keys(h).map((k) => [k, (h[k] - rest[k]).toFixed(3)])),
					)}`,
				);
			}
			if (!allAirborne && airborne) break;
		}
		console.log('[authority-trace]\n' + rows.join('\n'));
		world.destroy();
	});
});
