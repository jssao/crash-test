// SPDX-License-Identifier: MIT
//
// Drive test 2/5: accelerate to ~80 km/h, full brake -> stops (<2 km/h) in <45m from brake
// application, no rollover.
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';

describe('braking', () => {
	it('accelerate to ~80km/h then full brake to a stop', async () => {
		const sim = await createSim();
		try {
			let minUpDot = 1;
			let reachedTarget = false;
			let brakeStartZ = 0;
			let stoppedWithinBudget = false;

			for (let i = 0; i < 900; i++) {
				const t = sim.telemetry();
				if (!reachedTarget && t.speedKmh >= 80) {
					reachedTarget = true;
					brakeStartZ = t.chassisPos.z;
				}
				sim.step({ throttle: reachedTarget ? 0 : 1, brake: reachedTarget ? 1 : 0, steer: 0, handbrake: false });
				const t2 = sim.telemetry();
				minUpDot = Math.min(minUpDot, t2.upDot);
				if (reachedTarget && t2.speedKmh < 2) {
					const dist = t2.chassisPos.z - brakeStartZ;
					console.log(`[braking] stopped after ${dist.toFixed(2)}m, minUpDot=${minUpDot.toFixed(4)}`);
					expect(dist).toBeLessThan(45);
					stoppedWithinBudget = true;
					break;
				}
			}

			expect(reachedTarget).toBe(true);
			expect(stoppedWithinBudget).toBe(true);
			expect(minUpDot).toBeGreaterThan(0.85);
		} finally {
			sim.destroy();
		}
	});
});
