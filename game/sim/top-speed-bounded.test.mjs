// SPDX-License-Identifier: MIT
//
// Regression test for FIXROUND-2 diagnostic C ("hidden top-speed runaway"). Pre-fix (with diagnostic
// B's mount-asymmetry already fixed), a 30s full-throttle run reached ~680 km/h at t=30s with
// suspension contact lost from t~=12s on.
//
// RE-MEASURED ROOT CAUSE (see tuning.ts's AERO_DRAG_COEFF_AREA_M2 doc comment for the full writeup):
// that ~680 km/h figure does not reproduce as a genuine on-ground runaway -- it reproduces as the car
// driving off a too-small ground plane's finite edge into unconstrained freefall, which trivially
// explains both the reported speed (gravity alone adds ~10m/s every second falling) and the reported
// contact loss. createGroundBody()'s shared default half-size was raised for this reason (see that
// function's doc comment), but THIS test's own duration/speed still needs more room than that shared
// default comfortably provides -- so it builds its own world directly (like kicker-jump.test.mjs) with
// an explicit, generous ground half-size, rather than going through harness.mjs's createSim().
//
// VEHICLE DEEP-PASS (residuals 1+2, friction root-cause + powertrain): with the panel<->ground
// parasitic-drag bug fixed (damage/panels.ts) and WHEEL_FRICTION brought down to a physically-ordinary
// 1.05 (tuning.ts), the car's genuine settled top speed rose from the old ~105-120km/h to ~230-240km/h
// -- a real force-balance settle in gear 5 at ~5400rpm (well below redline, not a gear/redline-limit
// artifact -- see game/sim/diag/topspeed-instrument*.test.mjs) -- landing inside the spec's 180-240
// km/h target band WITHOUT any gearing/torque-curve change (AERO_DRAG_COEFF_AREA_M2 alone was raised to
// the spec's own suggested 0.65 sports-coupe value now that it isn't fighting the straight-line test's
// margin -- see that constant's doc comment). Ground half-size raised 3000 -> 8000 to comfortably
// contain this run at the new, honest, much higher settle speed (measured: this 45s run covers
// ~2500-3000m one-way at ~235km/h cruise -- the old 3000m half-size left almost no margin).
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';

describe('top-speed-bounded', () => {
	it('45s full throttle settles to a bounded top speed (inside the 180-240km/h target band) with suspension in contact throughout', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		createGroundBody(world, 8000); // generous -- this run can cover ~3000m at its settled cruise speed
		const vehicle = createVehicle(world);

		let minGroundedCount = 4;
		let maxSpeedKmh = 0;
		const speedSamples = [];
		const TOTAL_STEPS = 2700; // 45s @ 60Hz
		for (let i = 0; i < TOTAL_STEPS; i++) {
			stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
			world.step(FIXED_DT, FIXED_SUBSTEPS);
			const t = getTelemetry(vehicle);
			minGroundedCount = Math.min(minGroundedCount, t.groundedWheelCount);
			maxSpeedKmh = Math.max(maxSpeedKmh, t.speedKmh);
			if (i >= TOTAL_STEPS - 300) speedSamples.push(t.speedKmh); // last 5s: settled, not still climbing?
		}
		const finalSpeed = getTelemetry(vehicle).speedKmh;
		const settledMin = Math.min(...speedSamples);
		const settledMax = Math.max(...speedSamples);
		console.log(
			`[top-speed-bounded] finalSpeed=${finalSpeed.toFixed(1)}km/h maxSpeedEver=${maxSpeedKmh.toFixed(1)}km/h ` +
				`last5s range=[${settledMin.toFixed(1)},${settledMax.toFixed(1)}] minGroundedCount=${minGroundedCount}`,
		);

		// Honest target band (spec's own 180-240km/h aspirational range) -- now genuinely achieved, not
		// just "didn't run away" (see this file's header comment for the measured settle mechanics).
		expect(maxSpeedKmh).toBeGreaterThanOrEqual(180);
		expect(maxSpeedKmh).toBeLessThan(240);
		// Settled (not still monotonically climbing by the end): the last-5s range is tight.
		expect(settledMax - settledMin).toBeLessThan(15);
		// Suspension stayed in contact the entire run (no airborne/skipping regime).
		expect(minGroundedCount).toBeGreaterThanOrEqual(4);

		world.destroy();
	});
});
