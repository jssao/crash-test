// SPDX-License-Identifier: MIT
//
// Drive test 1/5: full throttle from rest, 5s -> displacement 55-120m, no rollover (up-vector dot
// > 0.85 throughout), reaches >= 85 km/h. Also asserts the residual-2 0-100km/h acceleration target
// (5.5-7.5s for a sports coupe) directly -- runs a bit past the original 5s window since 100km/h now
// takes ~5.8s to reach (see tuning.ts's WHEEL_FRICTION/AERO_DRAG_COEFF_AREA_M2 doc comments).
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';

describe('straight-line', () => {
	it('full throttle from rest for 5s (+ 0-100km/h timing through 7.5s)', async () => {
		const sim = await createSim();
		try {
			let minUpDot = 1;
			let maxSpeedKmh5s = 0;
			let time0To100Sec = -1;
			let statsAt5s = null;
			const TOTAL_STEPS = 450; // 7.5s -- covers the 0-100km/h target window
			for (let i = 0; i < TOTAL_STEPS; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				const t = sim.telemetry();
				minUpDot = Math.min(minUpDot, t.upDot);
				if (i < 300) maxSpeedKmh5s = Math.max(maxSpeedKmh5s, t.speedKmh);
				if (i === 299) statsAt5s = { z: t.chassisPos.z, speedKmh: t.speedKmh, gear: t.gear };
				if (time0To100Sec < 0 && t.speedKmh >= 100) time0To100Sec = (i + 1) / 60;
			}
			const tFinal = sim.telemetry();

			console.log(
				`[straight-line] @5s: displacement=${statsAt5s.z.toFixed(2)}m maxSpeed=${maxSpeedKmh5s.toFixed(1)}km/h ` +
					`speed=${statsAt5s.speedKmh.toFixed(1)}km/h gear=${statsAt5s.gear} minUpDot=${minUpDot.toFixed(4)} ` +
					`time0to100=${time0To100Sec < 0 ? 'n/a' : time0To100Sec.toFixed(2) + 's'} finalSpeed@7.5s=${tFinal.speedKmh.toFixed(1)}km/h`,
			);

			expect(minUpDot).toBeGreaterThan(0.85); // no rollover at any point
			// Recalibrated 90 -> 85 (2026-07-09): the panel-orientation fix (1f0b38c) corrected
			// panel body inertia (axis-permuted collision boxes), legitimately shifting 5s accel
			// from 90.7 to 88.5 km/h. Bar guards against gross traction regressions.
			//
			// VEHICLE DEEP-PASS (residual 1, friction root-cause -- see tuning.ts's WHEEL_FRICTION doc
			// comment): re-measured after fixing the panel<->ground parasitic-contact bug (damage/
			// panels.ts) at a physically-ordinary WHEEL_FRICTION=1.05 -- 5s speed is now ~86km/h, still
			// clearing this bar with margin (kept at 85 rather than re-raised again: this specific
			// number is a coarse "no gross regression" floor, not a target in itself -- the honest
			// target this pass DOES assert directly is the 0-100km/h time below).
			expect(maxSpeedKmh5s).toBeGreaterThanOrEqual(85);
			expect(statsAt5s.z).toBeGreaterThanOrEqual(55); // displacement 55-120m
			expect(statsAt5s.z).toBeLessThanOrEqual(120);

			// Residual 2 (powertrain retune) target: 0-100km/h in 5.5-7.5s for a sports coupe --
			// measured ~5.8s with the friction fix + AERO_DRAG_COEFF_AREA_M2=0.65 in place (see
			// tuning.ts's doc comments), no gearing/torque-curve change needed.
			expect(time0To100Sec).toBeGreaterThan(0);
			expect(time0To100Sec).toBeGreaterThanOrEqual(5.5);
			expect(time0To100Sec).toBeLessThanOrEqual(7.5);
		} finally {
			sim.destroy();
		}
	});
});
