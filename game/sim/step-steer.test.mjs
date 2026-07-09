// SPDX-License-Identifier: MIT
//
// Drive test 3/5: 60 km/h, steer 0.25 rad for 2.5s -> |yaw rate| between 0.25 and 1.2 rad/s (turns,
// doesn't spin out instantly), roll angle stays <25 degrees, no rollover.
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';
import { speedSensitiveSteerClamp } from '../src/vehicle/vehicle.ts';

describe('step-steer', () => {
	it('60km/h step-steer to 0.25rad wheel angle for 2.5s', async () => {
		const sim = await createSim();
		try {
			// Get to 60 km/h first (straight line).
			let reached60 = false;
			for (let i = 0; i < 600 && !reached60; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				if (sim.telemetry().speedKmh >= 60) reached60 = true;
			}
			expect(reached60).toBe(true);

			let maxRollDeg = 0;
			let minUpDot = 1;
			let minYawAbs = Infinity;
			let maxYawAbs = 0;
			const SETTLE_STEPS = 6; // skip the steering slew-rate ramp-up window (~0.1s)

			for (let k = 0; k < 150; k++) {
				// steer input dynamically compensated for the speed-sensitive clamp, so the commanded
				// front-wheel angle is the spec's literal 0.25 rad regardless of current speed.
				const speedNow = sim.telemetry().speedKmh;
				const maxAngle = speedSensitiveSteerClamp(speedNow);
				const steerInput = Math.min(1, 0.25 / maxAngle);
				// light throttle to roughly hold speed through the turn (not accelerate/decelerate hard)
				sim.step({ throttle: 0.15, brake: 0, steer: steerInput, handbrake: false });

				const t = sim.telemetry();
				minUpDot = Math.min(minUpDot, t.upDot);
				maxRollDeg = Math.max(maxRollDeg, Math.abs((t.rollAngleRad * 180) / Math.PI));
				if (k >= SETTLE_STEPS) {
					minYawAbs = Math.min(minYawAbs, Math.abs(t.yawRateRadS));
					maxYawAbs = Math.max(maxYawAbs, Math.abs(t.yawRateRadS));
				}
			}

			console.log(
				`[step-steer] yawRate range=[${minYawAbs.toFixed(3)}, ${maxYawAbs.toFixed(3)}] rad/s maxRoll=${maxRollDeg.toFixed(2)}deg minUpDot=${minUpDot.toFixed(4)}`,
			);

			expect(minYawAbs).toBeGreaterThanOrEqual(0.25);
			expect(maxYawAbs).toBeLessThanOrEqual(1.2);
			expect(maxRollDeg).toBeLessThan(25);
			expect(minUpDot).toBeGreaterThan(0.85);
		} finally {
			sim.destroy();
		}
	});
});
