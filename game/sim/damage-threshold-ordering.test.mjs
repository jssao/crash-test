// SPDX-License-Identifier: MIT
//
// Damage test 3/6: FRONTAL crash-speed escalation. 20 km/h: no damage; 55 km/h: exactly the hood takes
// damage (loosened or broken), doors stay attached; 100 km/h: hood broken (torn loose), doors STILL
// attached.
//
// RECALIBRATED (docs/build-log/specs/crash-deformation-reference.md, "doors fly off in frontal" user
// playtest fix): the 55/100 km/h cases previously required a DOOR to loosen/break in a pure frontal
// (">=1 loosened" and ">=2 broken"). That is exactly the unrealistic behaviour the reference spec
// corrects -- FMVSS-206's own record: door separation is a side-impact / rollover / complex-loading
// event, never a clean frontal. With the direction-aware weld model (damage-tuning.ts's
// PANEL_VULNERABILITY + welds.ts's panelDirectionalFactor) a frontal loads only the frontal-weak hood;
// the doors' longitudinal vulnerability is ~zero, so they no longer loosen/break head-on at any speed.
// The escalation-with-speed intent is preserved (no damage -> hood loosens -> hood tears off); the
// "doors CAN still break, from LATERAL load" half of the old coverage now lives in crash-realism.
// test.mjs's side-impact case. See that spec + the direction-aware damage-tuning.ts doc comments.
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
		const doorsTouched = ['doorL', 'doorR'].filter((k) => dt.panelStates[k] !== 'attached');
		return { panelStates: dt.panelStates, brokenCount, loosenedCount, doorsTouched };
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

	it('55 km/h -> the hood takes damage, doors stay attached', async () => {
		const r = await crashAndMeasure(55);
		console.log(`[threshold-ordering] 55km/h states=${JSON.stringify(r.panelStates)}`);
		// The hood (frontal-weak) loosens or tears; nothing else escalates this hard yet.
		expect(['loosened', 'broken']).toContain(r.panelStates.hood);
		// RECALIBRATED per crash-deformation-reference.md: a pure frontal must NOT touch the doors.
		expect(r.doorsTouched).toEqual([]);
		expect(r.brokenCount).toBeLessThanOrEqual(1);
	});

	it('100 km/h -> hood torn loose, doors STILL attached (no frontal door detachment)', async () => {
		const r = await crashAndMeasure(100);
		console.log(`[threshold-ordering] 100km/h states=${JSON.stringify(r.panelStates)}`);
		// At severe frontal energy the hood is torn off (a free body) ...
		expect(r.panelStates.hood).toBe('broken');
		// ... but the doors stay latched -- the reference-spec fix for the "doors fly off in frontal"
		// playtest finding (see this file's header + crash-realism.test.mjs's side-impact case for the
		// LATERAL load that DOES detach a door).
		expect(r.doorsTouched).toEqual([]);
	});
});
