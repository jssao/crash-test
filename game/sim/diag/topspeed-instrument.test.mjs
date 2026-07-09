// DIAGNOSTIC ONLY: what actually limits top speed once the friction fix is in place? Logs gear/rpm/
// spin torque/computed aero drag over a 45s full-throttle run to see which force dominates near the
// settle point.
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { computeAeroDragForce } from '../../src/vehicle/vehicle.ts';
import { AIR_DENSITY_KG_M3, AERO_DRAG_COEFF_AREA_M2, WHEEL_RADIUS_REAR_M } from '../../src/vehicle/tuning.ts';

describe('diag: top speed instrument', () => {
	it('45s full throttle: gear/rpm/torque/drag trace', async () => {
		const sim = await createSim();
		try {
			const rows = [];
			for (let i = 0; i < 2700; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				if (i % 90 === 0 || i > 2650) {
					const t = sim.telemetry();
					let spinTorqueSum = 0;
					for (const key of ['rl', 'rr']) {
						const w = sim.vehicle.wheels[key];
						if (w.joint) spinTorqueSum += Math.abs(w.joint.getSpinTorque());
					}
					const wheelForceN = spinTorqueSum / WHEEL_RADIUS_REAR_M;
					const vel = sim.vehicle.chassis.getLinearVelocity();
					const dragForce = computeAeroDragForce(vel);
					const dragMag = Math.hypot(dragForce.x, dragForce.y, dragForce.z);
					rows.push(
						`t=${(i / 60).toFixed(1)} speed=${t.speedKmh.toFixed(1)} gear=${t.gear} rpm=${t.rpm.toFixed(0)} ` +
							`wheelForceN=${wheelForceN.toFixed(0)} dragN=${dragMag.toFixed(0)} rl=${t.wheelOmegas.rl.toFixed(1)} rr=${t.wheelOmegas.rr.toFixed(1)}`,
					);
				}
			}
			console.log('[topspeed-trace]\n' + rows.join('\n'));
		} finally {
			sim.destroy();
		}
	});
});
