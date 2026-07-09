// SPDX-License-Identifier: MIT
//
// Regression test for playtest MAJOR #1: flat-ground rollover under sustained mild steer. Repro
// (game/verify/playtest/battery.mjs's "free-drive" scenario + the QA brief): sustained throttle +
// oscillating steer (0.15 amplitude, ~70-step/1.17s period sine) on open ground eventually inverts the
// car, even though a single step-steer event (game/sim/step-steer.test.mjs) stays well within budget --
// prior tuning was only ever validated against that one step input, not a sustained oscillation, which
// pumps roll energy in every steer reversal (see game/src/vehicle/tuning.ts's ANTI_ROLL_*/
// YAW_DAMPING_*/SUSPENSION_* doc comments for the tuning deltas made to fix this).
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';

describe('sustained-oscillation', () => {
	it('30s of throttle + oscillating steer (0.15 amplitude) never rolls the car', async () => {
		const sim = await createSim();
		try {
			const TARGET_SPEED_KMH = 50;
			const STEER_AMP = 0.15;
			const PERIOD_STEPS = 70; // mirrors battery.mjs's free-drive scenario sine period
			const TOTAL_STEPS = 1800; // 30s @ 60Hz

			let minUpDot = 1;
			let maxAbsRollRad = 0;

			for (let i = 0; i < TOTAL_STEPS; i++) {
				const speedNow = sim.telemetry().speedKmh;
				const steer = Math.sin(i / PERIOD_STEPS) * STEER_AMP;
				const throttle = speedNow < TARGET_SPEED_KMH ? 1 : 0;
				const brake = speedNow > TARGET_SPEED_KMH * 1.2 ? 0.2 : 0;
				sim.step({ throttle, brake, steer, handbrake: false });

				const t = sim.telemetry();
				minUpDot = Math.min(minUpDot, t.upDot);
				maxAbsRollRad = Math.max(maxAbsRollRad, Math.abs(t.rollAngleRad));
			}

			const finalTelemetry = sim.telemetry();
			console.log(
				`[sustained-oscillation] minUpDot=${minUpDot.toFixed(4)} maxAbsRollDeg=${((maxAbsRollRad * 180) / Math.PI).toFixed(2)} ` +
					`finalUpDot=${finalTelemetry.upDot.toFixed(4)} finalSpeedKmh=${finalTelemetry.speedKmh.toFixed(1)}`,
			);

			// Car must stay upright THROUGHOUT (not just at the end) -- upDot>0.5 excludes anything past a
			// ~60 degree lean, well short of the "fully inverts" failure mode.
			expect(minUpDot).toBeGreaterThan(0.5);
			// And it must finish the run upright (not merely dip and recover once).
			expect(finalTelemetry.upDot).toBeGreaterThan(0.7);
			expect(Number.isFinite(finalTelemetry.chassisPos.x)).toBe(true);
		} finally {
			sim.destroy();
		}
	});
});
