// DIAGNOSTIC (residual 3, "kicker ground-extent sensitivity"): small repro isolating WHY changing a
// static ground box's half-size (far from where the car ever drives) perturbs the simulation at all.
// Zero steering input (removes any test-script feedback-loop confound) -- pure open-loop comparison.
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';

async function run(halfSize, steps) {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, halfSize);
	const vehicle = createVehicle(world);
	const rows = [];
	for (let i = 0; i < steps; i++) {
		stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		const t = getTelemetry(vehicle);
		rows.push({ z: t.chassisPos.z, x: t.chassisPos.x, yawRate: t.yawRateRadS, speed: t.speedKmh });
	}
	world.destroy();
	return rows;
}

describe('diag: ground-extent repro (residual 3)', () => {
	it('bit-for-bit compares per-step chassis state for halfSize=250 vs 1000 vs 10000, zero steer, 4s', async () => {
		const STEPS = 240; // 4s
		const a = await run(250, STEPS);
		const b = await run(1000, STEPS);
		const c = await run(10000, STEPS);

		let firstDivergeAB = -1;
		let firstDivergeAC = -1;
		for (let i = 0; i < STEPS; i++) {
			if (firstDivergeAB === -1 && (a[i].x !== b[i].x || a[i].z !== b[i].z || a[i].yawRate !== b[i].yawRate)) firstDivergeAB = i;
			if (firstDivergeAC === -1 && (a[i].x !== c[i].x || a[i].z !== c[i].z || a[i].yawRate !== c[i].yawRate)) firstDivergeAC = i;
		}
		console.log(`[ground-extent-repro] first bit-exact divergence: 250-vs-1000 at step=${firstDivergeAB}, 250-vs-10000 at step=${firstDivergeAC} (of ${STEPS})`);
		if (firstDivergeAB >= 0) {
			const i = firstDivergeAB;
			console.log(`  step=${i}: halfSize250 x=${a[i].x} z=${a[i].z} yawRate=${a[i].yawRate}`);
			console.log(`  step=${i}: halfSize1000 x=${b[i].x} z=${b[i].z} yawRate=${b[i].yawRate}`);
			console.log(`  delta x=${(b[i].x - a[i].x).toExponential(3)} z=${(b[i].z - a[i].z).toExponential(3)} yawRate=${(b[i].yawRate - a[i].yawRate).toExponential(3)}`);
		}
		// Final-step comparison (magnitude of divergence after 4s).
		const last = STEPS - 1;
		console.log(
			`[ground-extent-repro] after ${STEPS} steps: halfSize250 x=${a[last].x.toFixed(6)} z=${a[last].z.toFixed(6)} yawRate=${a[last].yawRate.toFixed(6)} speed=${a[last].speed.toFixed(4)}`,
		);
		console.log(
			`[ground-extent-repro] after ${STEPS} steps: halfSize1000 x=${b[last].x.toFixed(6)} z=${b[last].z.toFixed(6)} yawRate=${b[last].yawRate.toFixed(6)} speed=${b[last].speed.toFixed(4)}`,
		);
		console.log(
			`[ground-extent-repro] after ${STEPS} steps: halfSize10000 x=${c[last].x.toFixed(6)} z=${c[last].z.toFixed(6)} yawRate=${c[last].yawRate.toFixed(6)} speed=${c[last].speed.toFixed(4)}`,
		);
		console.log(`[ground-extent-repro] |x| divergence 250-vs-1000 at final step = ${Math.abs(b[last].x - a[last].x).toExponential(3)}m`);
		console.log(`[ground-extent-repro] |x| divergence 250-vs-10000 at final step = ${Math.abs(c[last].x - a[last].x).toExponential(3)}m`);
	});
});
