// SPDX-License-Identifier: MIT
//
// Damage test 3/6: crash-speed matrix -> 20 km/h: zero loosened/broken; 55 km/h: >=1 loosened, <=1
// broken; 100 km/h: >=2 broken. Tunes game/src/damage/damage-tuning.ts's STRESS_* / PANEL_*_FORCE_MULT
// constants against this exact matrix (see that file's doc comments for the empirical basis of each
// value that moved from the spec's starting point).
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';

async function crashAndMeasure(speedKmh) {
	const sim = await createDamageSim();
	try {
		sim.spawnWall(12);
		sim.crash(speedKmh);
		for (let i = 0; i < 420; i++) {
			sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		}
		const dt = sim.damageTelemetry();
		const brokenCount = Object.values(dt.panelStates).filter((s) => s === 'broken').length;
		const loosenedCount = Object.values(dt.panelStates).filter((s) => s === 'loosened').length;
		return { panelStates: dt.panelStates, brokenCount, loosenedCount };
	} finally {
		sim.destroy();
	}
}

describe('damage: threshold-ordering', () => {
	it('20 km/h -> zero loosened/broken', async () => {
		const r = await crashAndMeasure(20);
		console.log(`[threshold-ordering] 20km/h states=${JSON.stringify(r.panelStates)}`);
		expect(r.brokenCount).toBe(0);
		expect(r.loosenedCount).toBe(0);
	});

	it('55 km/h -> >=1 loosened, <=1 broken', async () => {
		const r = await crashAndMeasure(55);
		console.log(`[threshold-ordering] 55km/h states=${JSON.stringify(r.panelStates)}`);
		expect(r.loosenedCount).toBeGreaterThanOrEqual(1);
		expect(r.brokenCount).toBeLessThanOrEqual(1);
	});

	it('100 km/h -> >=2 broken', async () => {
		const r = await crashAndMeasure(100);
		console.log(`[threshold-ordering] 100km/h states=${JSON.stringify(r.panelStates)}`);
		expect(r.brokenCount).toBeGreaterThanOrEqual(2);
	});
});
