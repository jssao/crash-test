// DIAGNOSTIC: trace yaw angle/rate over a 10s zero-steer full-throttle run to see when/how drift
// develops (post friction+panel-clearance fix).
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';

function yawFromQuat(q) {
	return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

describe('diag: yaw instrument', () => {
	it('10s full throttle, zero steer: yaw trace', async () => {
		const sim = await createSim();
		try {
			const rows = [];
			for (let i = 0; i < 600; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				if (i % 12 === 0) {
					const t = sim.telemetry();
					const yawDeg = (yawFromQuat(t.chassisQuat) * 180) / Math.PI;
					rows.push(
						`t=${(i / 60).toFixed(2)} yawDeg=${yawDeg.toFixed(3)} yawRate=${t.yawRateRadS.toFixed(4)} speed=${t.speedKmh.toFixed(1)} x=${t.chassisPos.x.toFixed(3)} rl=${t.wheelOmegas.rl.toFixed(2)} rr=${t.wheelOmegas.rr.toFixed(2)}`,
					);
				}
			}
			console.log('[yaw-trace]\n' + rows.join('\n'));
		} finally {
			sim.destroy();
		}
	});
});
