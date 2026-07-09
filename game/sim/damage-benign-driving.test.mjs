// SPDX-License-Identifier: MIT
//
// Regression test for playtest MAJOR #2: panels loosen from 60s of ordinary driving. Headed real-GPU
// run finding: all 4 panels loosened after 60s of mild driving, no crashes. Root cause (diagnosed via
// headless hitEvents() instrumentation): the chassis/panels' own hit events (enableHitEvents=true)
// fire for ANY qualifying contact, including the car settling onto / bouncing against / briefly
// scraping the flat ground -- these hits carry a near-vertical contact normal, unlike a real crash's
// horizontal-dominated normal, but the accumulated-stress model (game/src/damage/welds.ts) treated them
// identically. Fixed by excluding near-vertical-normal hits from panel stress (damage-tuning.ts's
// STRESS_MAX_NORMAL_UP_COMPONENT). This test proves: (1) 60s of varied ordinary driving with no
// deliberate obstacle contact leaves every panel attached/zero-stress, THEN (2) a real 55km/h wall
// crash still loosens at least one panel (the fix doesn't blunt genuine crash-severity discrimination
// -- see damage-threshold-ordering.test.mjs for the same requirement at that exact speed).
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';

describe('damage: benign-driving', () => {
	it('60s of varied mild driving (accelerate/brake/turn, no obstacles) leaves every panel attached', async () => {
		const sim = await createDamageSim();
		try {
			// Varied mild driving, no obstacles anywhere in this harness (createDamageSim() -- flat
			// ground only, no destructible world): repeated accelerate/cruise/brake/turn phases, mirroring
			// how a player would casually explore an empty stretch of ground for a minute.
			const phaseSteps = 600; // 10s per phase @ 60Hz
			const phases = [
				{ throttle: 1, brake: 0, steer: 0 }, // accelerate
				{ throttle: 0, brake: 0.6, steer: 0 }, // brake
				{ throttle: 1, brake: 0, steer: 0.4 }, // turn right while accelerating
				{ throttle: 1, brake: 0, steer: -0.4 }, // turn left while accelerating
				{ throttle: 0.6, brake: 0, steer: 0.15 }, // mild cruise with a gentle weave
				{ throttle: 0, brake: 1, steer: 0 }, // hard brake to a stop
			];

			for (const phase of phases) {
				for (let i = 0; i < phaseSteps; i++) {
					sim.step({ ...phase, handbrake: false });
				}
			}

			const dt = sim.damageTelemetry();
			console.log(`[benign-driving] after 60s mild driving: panelStates=${JSON.stringify(dt.panelStates)} stressLevels=${JSON.stringify(dt.stressLevels)}`);

			for (const key of Object.keys(dt.panelStates)) {
				expect(dt.panelStates[key]).toBe('attached');
			}
			expect(dt.dentedVertexCount).toBe(0);

			// No NaNs anywhere after the 60s drive.
			const t = sim.vehicle.chassis.getTransform();
			for (const v of [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w]) {
				expect(Number.isFinite(v)).toBe(true);
			}

			// THEN: thresholds still discriminate -- a real 55km/h wall crash still loosens >=1 panel (same
			// requirement as damage-threshold-ordering.test.mjs at this exact speed).
			const wall = sim.spawnWall(10);
			sim.crash(55);
			for (let i = 0; i < 240; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
			}
			const dt2 = sim.damageTelemetry();
			console.log(`[benign-driving] after 55km/h wall crash: panelStates=${JSON.stringify(dt2.panelStates)}`);
			const loosenedOrBroken = Object.values(dt2.panelStates).filter((s) => s === 'loosened' || s === 'broken').length;
			expect(loosenedOrBroken).toBeGreaterThanOrEqual(1);
			wall.destroy();
		} finally {
			sim.destroy();
		}
	});
});
