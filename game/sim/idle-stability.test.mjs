// SPDX-License-Identifier: MIT
//
// Drive test 5/5: car at rest 10s -> drift <0.05m, stays awake-or-asleep without jitter (position
// variance tiny).
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';

describe('idle-stability', () => {
	it('at rest for 10s with no input', async () => {
		const sim = await createSim();
		try {
			// Let the initial spawn/suspension settling transient finish (a few spring periods at
			// SUSPENSION_HERTZ_REAR/FRONT ~3Hz) before starting the drift measurement window --
			// otherwise the initial settle-to-equilibrium drop would count against the drift budget,
			// which is about parked stability, not spawn settling.
			for (let i = 0; i < 90; i++) sim.step();

			const start = sim.telemetry().chassisPos;
			const samples = [];
			for (let i = 0; i < 600; i++) {
				sim.step();
				if (i % 10 === 0) samples.push(sim.telemetry().chassisPos);
			}
			const end = sim.telemetry().chassisPos;

			const drift = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
			const variance = (arr) => {
				const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
				return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
			};
			const varX = variance(samples.map((p) => p.x));
			const varY = variance(samples.map((p) => p.y));
			const varZ = variance(samples.map((p) => p.z));

			console.log(`[idle-stability] drift=${drift.toFixed(5)}m varX=${varX.toExponential(2)} varY=${varY.toExponential(2)} varZ=${varZ.toExponential(2)}`);

			expect(drift).toBeLessThan(0.05);
			// tiny position variance -- no jitter, whether the body ends up asleep or stays awake
			expect(varX).toBeLessThan(1e-4);
			expect(varY).toBeLessThan(1e-4);
			expect(varZ).toBeLessThan(1e-4);
		} finally {
			sim.destroy();
		}
	});
});
