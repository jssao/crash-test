// DIAGNOSTIC ONLY. Measures braking deceleration g, launch wheelspin slip, and steady-state lateral
// g in a mild constant-steer turn, on the UNMODIFIED shipped model.
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { speedSensitiveSteerClamp } from '../../src/vehicle/vehicle.ts';

const G = 9.81;

describe('diag: friction feel', () => {
	it('braking deceleration g', async () => {
		const sim = await createSim();
		try {
			let reached = false;
			let prevSpeedMs = 0;
			let prevT = 0;
			let maxDecelG = 0;
			let t = 0;
			for (let i = 0; i < 900; i++) {
				const tel = sim.telemetry();
				if (!reached && tel.speedKmh >= 80) reached = true;
				sim.step({ throttle: reached ? 0 : 1, brake: reached ? 1 : 0, steer: 0, handbrake: false });
				t += 1 / 60;
				const tel2 = sim.telemetry();
				if (reached) {
					const speedMs = tel2.speedKmh / 3.6;
					const decel = (prevSpeedMs - speedMs) / (t - prevT);
					if (decel > maxDecelG * G) maxDecelG = decel / G;
					prevSpeedMs = speedMs;
					prevT = t;
					if (tel2.speedKmh < 2) break;
				}
			}
			console.log(`[braking-g] peak braking decel = ${maxDecelG.toFixed(2)} g (realistic road car ~0.9-1.1g)`);
		} finally {
			sim.destroy();
		}
	});

	it('launch wheelspin slip (first 2s full throttle from rest)', async () => {
		const sim = await createSim();
		try {
			let maxSlipMs = 0;
			let maxSlipAtT = 0;
			for (let i = 0; i < 120; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				const tel = sim.telemetry();
				const slip = Math.max(Math.abs(tel.slipHints.rl), Math.abs(tel.slipHints.rr));
				if (slip > maxSlipMs) {
					maxSlipMs = slip;
					maxSlipAtT = i / 60;
				}
			}
			console.log(`[launch-slip] peak rear contact-patch slip = ${maxSlipMs.toFixed(2)} m/s at t=${maxSlipAtT.toFixed(2)}s`);
		} finally {
			sim.destroy();
		}
	});

	it('steady-state lateral g, mild constant steer at 60km/h', async () => {
		const sim = await createSim();
		try {
			let reached60 = false;
			for (let i = 0; i < 600 && !reached60; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				if (sim.telemetry().speedKmh >= 60) reached60 = true;
			}
			let prevVel = sim.vehicle.chassis.getLinearVelocity();
			let maxLatG = 0;
			const samples = [];
			for (let k = 0; k < 240; k++) {
				const speedNow = sim.telemetry().speedKmh;
				const maxAngle = speedSensitiveSteerClamp(speedNow);
				const steerInput = Math.min(1, 0.15 / maxAngle); // mild, sub-limit steer
				sim.step({ throttle: 0.15, brake: 0, steer: steerInput, handbrake: false });
				const tel = sim.telemetry();
				const vel = tel.chassisPos; // not velocity; use telemetry yaw rate * speed as lateral accel proxy
				const speedMs = tel.speedKmh / 3.6;
				const latAccel = Math.abs(tel.yawRateRadS) * speedMs; // v*omega, steady-state circular motion
				const latG = latAccel / G;
				if (k > 60) maxLatG = Math.max(maxLatG, latG); // skip transient settle window
				if (k % 30 === 0) samples.push({ k, speedKmh: tel.speedKmh.toFixed(1), yawRate: tel.yawRateRadS.toFixed(3), latG: latG.toFixed(3), roll: ((tel.rollAngleRad*180/Math.PI)).toFixed(2) });
			}
			console.log('[lateral-g] samples:', JSON.stringify(samples));
			console.log(`[lateral-g] steady-state peak lateral g (mild steer, sub-limit) = ${maxLatG.toFixed(3)} g (realistic road car ~0.8-1.0g at limit; this is sub-limit steer)`);
		} finally {
			sim.destroy();
		}
	});
});
