// DIAGNOSTIC: does the falsely-"grounded" rear wheel (deflection lag) show abnormally large slip
// (realOmega vs chassis-implied omega) during the false-positive window -- i.e. is slip a reliable
// independent "actually airborne" signal here, since the wheel is still being driven at full torque?
import { describe, it } from 'vitest';
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getSuspensionDeflection, getTelemetry } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, WHEEL_RADIUS_REAR_M } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';

function wheelHeights(vehicle) {
	const out = {};
	for (const key of Object.keys(vehicle.wheels)) out[key] = vehicle.wheels[key].body.getPosition().y;
	return out;
}

describe('diag: airborne pitch check 4 (slip as auxiliary ground-truth signal)', () => {
	it('per-wheel omega + implied-omega-equivalent forward speed during the false-grounded window', async () => {
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
				const t = getTelemetry(vehicle);
				const defl = { rl: getSuspensionDeflection(vehicle, 'rl').toFixed(3), rr: getSuspensionDeflection(vehicle, 'rr').toFixed(3) };
				const forwardSpeedMs = t.speedKmh / 3.6;
				const impliedOmega = forwardSpeedMs / WHEEL_RADIUS_REAR_M;
				rows.push(
					`defl=${JSON.stringify(defl)} rl_omega=${t.wheelOmegas.rl.toFixed(1)} rr_omega=${t.wheelOmegas.rr.toFixed(1)} impliedOmega=${impliedOmega.toFixed(1)} slip_rl=${(t.wheelOmegas.rl - impliedOmega).toFixed(1)} slip_rr=${(t.wheelOmegas.rr - impliedOmega).toFixed(1)}`,
				);
				if (rows.length > 30) break;
			}
		}
		console.log('[slip-trace]\n' + rows.join('\n'));
		world.destroy();
	});
});
