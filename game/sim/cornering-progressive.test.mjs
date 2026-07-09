// SPDX-License-Identifier: MIT
//
// Regression test for FIXROUND-2 diagnostic D2 ("progressive lateral grip"): box3d's contact friction
// is a single isotropic Coulomb scalar (no slip-angle-dependent tire model -- confirmed in vendor
// source), so lateral grip used to saturate near-instantly once any meaningful slip developed,
// independent of how much steer was actually commanded. Measured pre-fix: cornering hit 0.87-1.16g
// lateral at only 43% of max steer angle -- near-binary saturation, not a progressive "more steer ->
// more lateral g" curve. FIX: computeLateralGripAssistTorque() (vehicle.ts) layers a yaw-axis
// corrective torque, keyed off how far COMMANDED steer sits below the speed-sensitive max lock, that
// softens realized lateral acceleration at low steer fractions and progressively releases that
// softening as commanded steer approaches full lock.
//
// HONEST GAP: this does not yet produce a textbook-smooth slip-angle-vs-force curve (the underlying
// isotropic friction model still dominates at the high end) -- measured: 25%/50%/75%/100%-of-max-steer
// lateral g came out ~0.64/0.91/1.11/1.15g. That IS monotonic and 25%-steer sits well below the
// 100%-steer peak (the specific near-binary-saturation failure is fixed), but 50%-steer (0.91g) is not
// as far below peak as an idealized curve might put it. Thresholds below assert the two things that
// ARE reliably true: monotonic non-decreasing lateral g with more steer, and a low-steer sample
// meaningfully below the peak (not saturated) -- not an exact curve shape.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry, speedSensitiveSteerClamp } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';

const G = 9.81;
const STEER_FRACTIONS = [0.25, 0.5, 0.75, 1.0];

async function peakLateralGAtSteerFraction(fraction) {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world);
	const vehicle = createVehicle(world);
	let reached60 = false;
	for (let i = 0; i < 600 && !reached60; i++) {
		stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		if (getTelemetry(vehicle).speedKmh >= 60) reached60 = true;
	}
	let maxLatG = 0;
	for (let k = 0; k < 240; k++) {
		stepVehicle(vehicle, { throttle: 0.15, brake: 0, steer: fraction, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		const tel = getTelemetry(vehicle);
		const speedMs = tel.speedKmh / 3.6;
		const latG = (Math.abs(tel.yawRateRadS) * speedMs) / G;
		if (k > 60) maxLatG = Math.max(maxLatG, latG); // skip the transient settle window
	}
	world.destroy();
	return maxLatG;
}

describe('cornering-progressive', () => {
	it('peak lateral g increases monotonically with commanded steer fraction, and low steer is not saturated at the peak', async () => {
		const results = [];
		for (const frac of STEER_FRACTIONS) {
			results.push({ frac, latG: await peakLateralGAtSteerFraction(frac) });
		}
		console.log('[cornering-progressive]', JSON.stringify(results));

		for (let i = 1; i < results.length; i++) {
			expect(results[i].latG).toBeGreaterThanOrEqual(results[i - 1].latG - 0.02); // monotonic (tiny slack for step noise)
		}

		const low = results[0].latG; // 25% steer
		const peak = results[results.length - 1].latG; // 100% steer
		expect(peak).toBeGreaterThan(0.5); // genuinely corners
		expect(peak).toBeLessThan(1.4); // bounded, not an unrealistic spike
		expect(low).toBeLessThan(0.75 * peak); // NOT near-binary-saturated at low steer (pre-fix failure)
	});
});
