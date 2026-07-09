// DIAGNOSTIC: 0-100km/h acceleration time (residual 2 target: 5.5-7.5s for a sports coupe).
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';

describe('diag: 0-100km/h accel time', () => {
	it('measures time to reach 100km/h from rest, full throttle', async () => {
		const sim = await createSim();
		try {
			let reached100 = -1;
			for (let i = 0; i < 900; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				const t = sim.telemetry();
				if (reached100 === -1 && t.speedKmh >= 100) {
					reached100 = i / 60;
					break;
				}
			}
			console.log(`[accel-0-100] time to 100km/h = ${reached100 < 0 ? 'never (within 15s)' : reached100.toFixed(2) + 's'}`);
		} finally {
			sim.destroy();
		}
	});
});
