// SPDX-License-Identifier: MIT
//
// Suspension-FEEL regression gate (user report: "the car doesn't really seem to have suspension --
// it collapses on the wheels instead of having springiness"). ROOT CAUSE (measured directly, see
// tuning.ts's SUSPENSION_HERTZ_FRONT doc comment): the old suspensionHertz (3.0-3.2) was calibrated
// against box3d's wheel-joint spring model, whose implied stiffness is computed against the DOF's own
// small effective/reduced mass (dominated by the light wheel body, NOT the heavy chassis) -- so the
// old spring's honest, unclamped equilibrium point sat far beyond ANY plausible travel limit, meaning
// the +/-0.12m hard suspension LIMIT (not the spring) was silently doing 100% of the weight-holding at
// rest, with zero remaining compliance in either direction: exactly "collapses on the wheels instead
// of having springiness". FIX: retuned suspensionHertz (see tuning.ts) to pull the static equilibrium
// off the wall, plus a widened travel band (SUSPENSION_LOWER/UPPER_LIMIT_M) so hard weight-transfer
// events have real headroom to compress into. This file locks in the resulting, measured feel so it
// can't silently regress back to "rigid" again.
//
// Every scenario below is intentionally a fresh, independent Sim (matching this repo's existing drive
// tests) so one scenario's settling/impact never contaminates another's measurement.
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';
import { getSuspensionDeflection, speedSensitiveSteerClamp } from '../src/vehicle/vehicle.ts';
import { rotateVector, LOCAL_FORWARD } from '../src/vehicle/mathUtil.ts';
import { SUSPENSION_LOWER_LIMIT_M, SUSPENSION_UPPER_LIMIT_M } from '../src/vehicle/tuning.ts';

const WHEEL_KEYS = ['fl', 'fr', 'rl', 'rr'];
const TRAVEL_M = SUSPENSION_UPPER_LIMIT_M - SUSPENSION_LOWER_LIMIT_M;

/** Chassis pitch, degrees: how far the forward axis has tilted toward world-up (0 = level, positive =
 * nose UP). Same proxy vehicle.ts's computeAntiPitchTorque() uses internally. */
function pitchDeg(chassisQuat) {
	const forward = rotateVector(chassisQuat, LOCAL_FORWARD);
	return (Math.asin(Math.max(-1, Math.min(1, forward.y))) * 180) / Math.PI;
}

/** Peak-to-peak suspension travel used by one wheel across a sample window, as a fraction of the
 * full SUSPENSION_LOWER_LIMIT_M..SUSPENSION_UPPER_LIMIT_M band. */
function travelFractionUsed(samples) {
	return (Math.max(...samples) - Math.min(...samples)) / TRAVEL_M;
}

describe('suspension-feel', () => {
	it('hard braking from 80km/h produces visible nose-dive (1.5-4deg), not an instant rigid stop', async () => {
		const sim = await createSim();
		try {
			let reached = false;
			for (let i = 0; i < 600 && !reached; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				if (sim.telemetry().speedKmh >= 80) reached = true;
			}
			expect(reached).toBe(true);

			const basePitch = pitchDeg(sim.telemetry().chassisQuat);
			let maxDiveDeg = 0;
			const flSamples = [];
			const rlSamples = [];
			for (let i = 0; i < 90; i++) {
				sim.step({ throttle: 0, brake: 1, steer: 0, handbrake: false });
				const t = sim.telemetry();
				maxDiveDeg = Math.max(maxDiveDeg, basePitch - pitchDeg(t.chassisQuat)); // nose-down = positive dive
				flSamples.push(getSuspensionDeflection(sim.vehicle, 'fl'));
				rlSamples.push(getSuspensionDeflection(sim.vehicle, 'rl'));
			}
			const usedFrac = Math.max(travelFractionUsed(flSamples), travelFractionUsed(rlSamples));

			console.log(`[suspension-feel] brake-dive: maxDiveDeg=${maxDiveDeg.toFixed(3)} usedTravelFrac=${(usedFrac * 100).toFixed(1)}%`);

			expect(maxDiveDeg).toBeGreaterThanOrEqual(1.5);
			expect(maxDiveDeg).toBeLessThanOrEqual(4.0);
		} finally {
			sim.destroy();
		}
	});

	it('full-throttle launch from rest produces visible squat (1-3deg) using a large share of suspension travel', async () => {
		const sim = await createSim();
		try {
			const basePitch = pitchDeg(sim.telemetry().chassisQuat);
			let maxSquatDeg = 0;
			const flSamples = [];
			const rlSamples = [];
			for (let i = 0; i < 90; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				const t = sim.telemetry();
				maxSquatDeg = Math.max(maxSquatDeg, pitchDeg(t.chassisQuat) - basePitch); // nose-up = positive squat
				flSamples.push(getSuspensionDeflection(sim.vehicle, 'fl'));
				rlSamples.push(getSuspensionDeflection(sim.vehicle, 'rl'));
			}
			const usedFrac = Math.max(travelFractionUsed(flSamples), travelFractionUsed(rlSamples));

			console.log(`[suspension-feel] launch-squat: maxSquatDeg=${maxSquatDeg.toFixed(3)} usedTravelFrac=${(usedFrac * 100).toFixed(1)}%`);

			expect(maxSquatDeg).toBeGreaterThanOrEqual(1.0);
			expect(maxSquatDeg).toBeLessThanOrEqual(3.0);
			// Launch squat is this vehicle's single largest-amplitude everyday suspension event (front
			// end unloading toward full extension while the rear compresses) -- a hard maneuver should
			// visibly use a large share of the available travel, not just graze it.
			expect(usedFrac).toBeGreaterThanOrEqual(0.4);
		} finally {
			sim.destroy();
		}
	});

	it('hard cornering (~1g lateral) produces visible body roll (1.5-4.5deg)', async () => {
		const sim = await createSim();
		try {
			const STEER_RAD = 0.38;
			const TARGET_SPEED_KMH = 72;
			let reached = false;
			for (let i = 0; i < 900 && !reached; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				if (sim.telemetry().speedKmh >= TARGET_SPEED_KMH) reached = true;
			}
			expect(reached).toBe(true);

			let maxRollDeg = 0;
			let maxLatG = 0;
			for (let i = 0; i < 200; i++) {
				const speedNow = sim.telemetry().speedKmh;
				const maxAngle = speedSensitiveSteerClamp(speedNow);
				const steerInput = Math.min(1, STEER_RAD / maxAngle);
				const throttle = speedNow < TARGET_SPEED_KMH ? 0.3 : 0.1;
				sim.step({ throttle, brake: 0, steer: steerInput, handbrake: false });
				const t = sim.telemetry();
				maxRollDeg = Math.max(maxRollDeg, Math.abs((t.rollAngleRad * 180) / Math.PI));
				const latAccelMs2 = t.yawRateRadS * (t.speedKmh / 3.6);
				maxLatG = Math.max(maxLatG, Math.abs(latAccelMs2) / 9.81);
			}

			console.log(`[suspension-feel] corner-roll: maxRollDeg=${maxRollDeg.toFixed(3)} maxLatG=${maxLatG.toFixed(3)}`);

			// Sanity: this scenario should actually be a hard, ~1g-class corner (not a gentle one) --
			// otherwise the roll assertion below wouldn't be testing what it claims to.
			expect(maxLatG).toBeGreaterThanOrEqual(0.8);
			expect(maxRollDeg).toBeGreaterThanOrEqual(1.5);
			expect(maxRollDeg).toBeLessThanOrEqual(4.5);
		} finally {
			sim.destroy();
		}
	});

	it('landing after a jump shows a damped spring oscillation (>=2 half-cycles, decaying), not an instant flatline', async () => {
		const sim = await createSim();
		try {
			// Let the car settle onto its suspension at rest first.
			for (let i = 0; i < 60; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

			// Synthetic hop: lift the chassis (wheels come along rigidly via the joints on the very next
			// step regardless -- this is just a clean, reproducible way to get the whole car airborne
			// and falling, independent of any specific ramp geometry in the world) and give it a bit of
			// forward speed, then let gravity bring it back down onto the suspension.
			const pos = sim.vehicle.chassis.getPosition();
			sim.vehicle.chassis.setTransform({ x: pos.x, y: pos.y + 1.2, z: pos.z }, sim.vehicle.chassis.getRotation());
			sim.vehicle.chassis.setLinearVelocity({ x: 0, y: 0, z: 5 });

			const rlTrace = [];
			for (let i = 0; i < 150; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				rlTrace.push(getSuspensionDeflection(sim.vehicle, 'rl'));
			}

			// Find the landing (deflection rises out of the near-zero "falling freely" band).
			const landedIdx = rlTrace.findIndex((v) => v > 0.03);
			expect(landedIdx).toBeGreaterThan(0);

			// Count local extrema (peaks/troughs) after landing whose amplitude clears a small noise
			// floor (filters out solver-jitter-scale wiggles, not genuine spring motion), and track
			// each extremum's value so decay can be checked directly.
			const NOISE_FLOOR_M = 0.004;
			const extrema = [];
			let runStart = landedIdx;
			let dir = 0; // -1 falling, +1 rising, 0 unknown
			for (let i = landedIdx + 1; i < rlTrace.length; i++) {
				const delta = rlTrace[i] - rlTrace[i - 1];
				const newDir = delta > 0 ? 1 : delta < 0 ? -1 : dir;
				if (dir !== 0 && newDir !== dir) {
					const amplitude = Math.abs(rlTrace[i - 1] - rlTrace[runStart]);
					if (amplitude >= NOISE_FLOOR_M) {
						extrema.push({ idx: i - 1, value: rlTrace[i - 1], amplitude });
						runStart = i - 1;
					}
				}
				dir = newDir;
			}

			console.log(
				`[suspension-feel] landing-oscillation: halfCycles=${extrema.length} ` +
					`amplitudes=${extrema.map((e) => e.amplitude.toFixed(4)).join(',')}`,
			);

			// At least 2 detectable half-cycles (a rise-then-fall-then-rise, i.e. genuine spring-back,
			// not a single monotonic settle).
			expect(extrema.length).toBeGreaterThanOrEqual(2);

			// Decaying: the later half of the detected extrema must have a smaller (or equal) average
			// amplitude than the earlier half -- a real damped oscillation loses energy over time,
			// unlike a sustained/growing bounce (which would indicate an unstable, underdamped spring).
			const mid = Math.floor(extrema.length / 2);
			const earlyAvg = extrema.slice(0, mid || 1).reduce((a, e) => a + e.amplitude, 0) / (mid || 1);
			const lateAvg = extrema.slice(mid).reduce((a, e) => a + e.amplitude, 0) / (extrema.length - mid);
			expect(lateAvg).toBeLessThanOrEqual(earlyAvg * 1.05); // small tolerance for float noise
		} finally {
			sim.destroy();
		}
	});
});
