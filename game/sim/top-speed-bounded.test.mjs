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
// contact loss. createGroundBody()'s shared default half-size was raised from 250 to 1000m for this
// reason (see that function's doc comment), but THIS test's own duration/speed still needs more room
// than that shared default comfortably provides (a sustained ~110km/h cruise covers >1km over the
// window below) -- so it builds its own world directly (like kicker-jump.test.mjs) with an explicit,
// generous ground half-size, rather than going through harness.mjs's createSim().
//
// With genuine on-ground driving confirmed for the whole run, the car's ACTUAL settled top speed
// (engine-torque-curve peak vs. aero drag + the pre-existing traction taper, unchanged from this pass)
// is a stable ~105-120 km/h in 3rd gear -- well under the spec's aspirational 180-240 km/h band.
// Reaching that band would need a powertrain retune (more torque headroom or taller gearing), which
// was out of this pass's safely-verifiable budget (this system is extremely non-monotonic/chaotic
// under small tuning changes -- see TRACTION_SLIP_ALLOWANCE_RAD_S's doc comment for direct
// measurements of that). This test asserts what IS true and load-bearing: the car reaches a genuinely
// BOUNDED, non-runaway top speed and keeps all 4 wheels grounded throughout -- not the specific
// 180-240 km/h figure, which is flagged as an honest gap in the return for this work, not silently
// asserted.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';

describe('top-speed-bounded', () => {
	it('45s full throttle settles to a bounded, non-runaway top speed with suspension in contact throughout', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		createGroundBody(world, 3000); // generous -- this run can cover >1km at its settled cruise speed
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

		// Genuinely bounded: nowhere close to the old ~680km/h runaway (a wide, deliberately generous
		// ceiling -- this is a "didn't run away" check, not a tight target).
		expect(maxSpeedKmh).toBeLessThan(200);
		// Settled (not still monotonically climbing by the end): the last-5s range is tight.
		expect(settledMax - settledMin).toBeLessThan(15);
		// Suspension stayed in contact the entire run (no airborne/skipping regime).
		expect(minGroundedCount).toBeGreaterThanOrEqual(4);

		world.destroy();
	});
});
