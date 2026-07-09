// DIAGNOSTIC: does the pre-existing per-step wheel-speed chatter cross TRACTION_SLIP_CUTOFF_RAD_S at
// high cruise speed (~235km/h), false-triggering the new slip-based ground-contact override?
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { TRACTION_SLIP_CUTOFF_RAD_S } from '../../src/vehicle/tuning.ts';

describe('diag: slip chatter check at high cruise speed', () => {
	it('per-step rl/rr slip vs implied omega over a 45s full-throttle run, late-run window', async () => {
		const sim = await createSim();
		try {
			let maxSlipSeen = 0;
			let overCutoffCount = 0;
			let overCutoffConsecutiveMax = 0;
			let overCutoffConsecutive = 0;
			const rows = [];
			for (let i = 0; i < 2700; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				if (i > 2400) {
					const t = sim.telemetry();
					const speedMs = t.speedKmh / 3.6;
					const impliedOmega = speedMs / 0.384; // approx rear radius
					const slipRl = Math.abs(t.wheelOmegas.rl) - impliedOmega;
					const slipRr = Math.abs(t.wheelOmegas.rr) - impliedOmega;
					const maxSlip = Math.max(slipRl, slipRr);
					maxSlipSeen = Math.max(maxSlipSeen, maxSlip);
					const over = maxSlip > TRACTION_SLIP_CUTOFF_RAD_S;
					if (over) {
						overCutoffCount++;
						overCutoffConsecutive++;
						overCutoffConsecutiveMax = Math.max(overCutoffConsecutiveMax, overCutoffConsecutive);
					} else overCutoffConsecutive = 0;
					if (i % 30 === 0) rows.push(`t=${(i / 60).toFixed(1)} speed=${t.speedKmh.toFixed(1)} slipRl=${slipRl.toFixed(1)} slipRr=${slipRr.toFixed(1)} grounded=${t.groundedWheelCount}`);
				}
			}
			console.log('[slip-chatter]\n' + rows.join('\n'));
			console.log(`[slip-chatter] maxSlipSeen=${maxSlipSeen.toFixed(1)} overCutoffSteps=${overCutoffCount} maxConsecutiveOverCutoff=${overCutoffConsecutiveMax} (cutoff=${TRACTION_SLIP_CUTOFF_RAD_S})`);
		} finally {
			sim.destroy();
		}
	});
});
