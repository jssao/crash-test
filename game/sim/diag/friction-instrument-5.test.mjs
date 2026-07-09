// DIAGNOSTIC: sanity-check that friction-instrument-4's hand-rolled world setup reproduces
// harness.mjs's own baseline (88.5km/h@5s) before trusting its filter-isolation delta.
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { init, World, BodyType } from '../../../src/ts/index.ts';
import { createVehicle, stepVehicle, getTelemetry, createGroundBody } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, GROUND_FRICTION } from '../../src/vehicle/tuning.ts';

describe('diag: friction instrument 5 (sanity re-check)', () => {
	it('harness.mjs createSim() baseline', async () => {
		const sim = await createSim();
		for (let i = 0; i < 300; i++) sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
		const t = sim.telemetry();
		console.log(`[sanity] harness createSim(): speed@5s=${t.speedKmh.toFixed(1)}km/h disp=${t.chassisPos.z.toFixed(2)}m`);
		sim.destroy();
	});

	it('hand-rolled world with createGroundBody() (real function) + createVehicle() default spawn', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		createGroundBody(world);
		const vehicle = createVehicle(world);
		for (let i = 0; i < 300; i++) {
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
		}
		const t = getTelemetry(vehicle);
		console.log(`[sanity] hand-rolled w/ createGroundBody(): speed@5s=${t.speedKmh.toFixed(1)}km/h disp=${t.chassisPos.z.toFixed(2)}m`);
		world.destroy();
	});

	it('hand-rolled world with MANUAL ground box (mirrors friction-instrument-4 exactly, ALL_BITS filter)', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		const ALL_BITS = 0xffffffffffffffffn;
		const ground = world.createBody({ type: BodyType.Static, position: { x: 0, y: -0.5, z: 0 } });
		ground.createBoxShape({ halfExtents: { x: 1000, y: 0.5, z: 1000 } }, { friction: GROUND_FRICTION, density: 1, categoryBits: ALL_BITS, maskBits: ALL_BITS });
		const vehicle = createVehicle(world);
		for (let i = 0; i < 300; i++) {
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
		}
		const t = getTelemetry(vehicle);
		console.log(`[sanity] hand-rolled w/ manual ground box: speed@5s=${t.speedKmh.toFixed(1)}km/h disp=${t.chassisPos.z.toFixed(2)}m`);
		world.destroy();
	});
});
