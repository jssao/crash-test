// DIAGNOSTIC: isolate whether pitch-rate retention during the kicker flight is broken by the vehicle
// deep-pass changes themselves, or by the steering-correction script (which applies continuous
// steering input, including during flight) -- test with ZERO steer throughout (accepting the car may
// not catch air / may miss the ramp center; only pitch-rate physics is being probed here).
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';
import { dot, rotateVector } from '../../src/vehicle/mathUtil.ts';

function wheelHeights(vehicle) {
	const out = {};
	for (const key of Object.keys(vehicle.wheels)) out[key] = vehicle.wheels[key].body.getPosition().y;
	return out;
}

describe('diag: airborne pitch check (zero steer, no correction confound)', () => {
	it('pitch rate trace through kicker flight with steer=0 throughout', async () => {
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
		let airStepIdx = 0;
		const log = [];
		for (let i = 0; i < 360; i++) {
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
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
				log.push({ step: airStepIdx, pitchRate });
				airStepIdx++;
			} else if (airborne) airborne = false;
		}
		console.log(`[zero-steer-pitch] airborne samples=${log.length}`);
		if (log.length > 6) {
			const early = Math.abs(log[5].pitchRate);
			const last = Math.abs(log[log.length - 1].pitchRate);
			console.log(`[zero-steer-pitch] early=${early.toFixed(4)} last=${last.toFixed(4)} ratio=${(last / early).toFixed(3)}`);
			for (let i = 0; i < log.length; i += 5) console.log(`  step=${log[i].step} pitchRate=${log[i].pitchRate.toFixed(4)}`);
		}
		world.destroy();
	});
});
