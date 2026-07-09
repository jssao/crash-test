// DIAGNOSTIC ONLY -- not part of the drive-test suite. Full throttle, zero steer, 30s (1800 steps),
// logging yaw/yaw-rate/lateral offset/per-wheel spin + suspension deflection to find WHEN/WHY a
// straight-line drift starts.
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { getSuspensionDeflection } from '../../src/vehicle/vehicle.ts';

function yawFromQuat(q) {
	// yaw about world Y from a quaternion (matches chassisForward's projection when roll/pitch small)
	return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

describe('diag: straight-line drift', () => {
	it('30s full throttle, zero steer', async () => {
		const sim = await createSim();
		try {
			const rows = [];
			for (let i = 0; i < 1800; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				if (i % 30 === 0 || i === 1799) {
					const t = sim.telemetry();
					const yaw = yawFromQuat(t.chassisQuat);
					rows.push({
						t: (i / 60).toFixed(2),
						speed: t.speedKmh.toFixed(1),
						gear: t.gear,
						x: t.chassisPos.x.toFixed(4),
						z: t.chassisPos.z.toFixed(2),
						yawDeg: (yaw * 180 / Math.PI).toFixed(3),
						yawRate: t.yawRateRadS.toFixed(4),
						rl: t.wheelOmegas.rl.toFixed(2),
						rr: t.wheelOmegas.rr.toFixed(2),
						fl: t.wheelOmegas.fl.toFixed(2),
						fr: t.wheelOmegas.fr.toFixed(2),
						susFL: getSuspensionDeflection(sim.vehicle, 'fl').toFixed(4),
						susFR: getSuspensionDeflection(sim.vehicle, 'fr').toFixed(4),
						susRL: getSuspensionDeflection(sim.vehicle, 'rl').toFixed(4),
						susRR: getSuspensionDeflection(sim.vehicle, 'rr').toFixed(4),
						steer: t.steeringAngle.toFixed(4),
					});
				}
			}
			console.log('t,speedKmh,gear,x,z,yawDeg,yawRateRadS,rl,rr,fl,fr,susFL,susFR,susRL,susRR,steerAngle');
			for (const r of rows) {
				console.log(
					`${r.t},${r.speed},${r.gear},${r.x},${r.z},${r.yawDeg},${r.yawRate},${r.rl},${r.rr},${r.fl},${r.fr},${r.susFL},${r.susFR},${r.susRL},${r.susRR},${r.steer}`,
				);
			}
		} finally {
			sim.destroy();
		}
	});
});
