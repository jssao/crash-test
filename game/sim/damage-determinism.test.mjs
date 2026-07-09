// SPDX-License-Identifier: MIT
//
// Damage test 6/6: identical scripted 70 km/h crash run twice from fresh worlds -> identical panel
// outcome states and identical dentedVertexCount. Requires the crumple noise to be a deterministic
// hash of vertex index (crumple.ts's deterministicJitter01()/hash32()) -- NO Math.random(), NO
// Date.now() anywhere in the sim path.
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';

async function runScriptedCrash() {
	const sim = await createDamageSim();
	try {
		sim.spawnWall(12);
		sim.crash(70);
		for (let i = 0; i < 300; i++) {
			sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		}
		const dt = sim.damageTelemetry();
		return {
			panelStates: dt.panelStates,
			dentedVertexCount: dt.dentedVertexCount,
			wheelStates: dt.wheelStates,
			eventTypes: sim.damage.emitter.history.map((e) => e.type),
		};
	} finally {
		sim.destroy();
	}
}

describe('damage: determinism', () => {
	it('identical scripted 70 km/h crash run twice gives identical outcomes', async () => {
		const a = await runScriptedCrash();
		const b = await runScriptedCrash();

		console.log(`[determinism] run A: panelStates=${JSON.stringify(a.panelStates)} dented=${a.dentedVertexCount}`);
		console.log(`[determinism] run B: panelStates=${JSON.stringify(b.panelStates)} dented=${b.dentedVertexCount}`);

		expect(b.panelStates).toEqual(a.panelStates);
		expect(b.wheelStates).toEqual(a.wheelStates);
		expect(b.dentedVertexCount).toBe(a.dentedVertexCount);
		expect(b.eventTypes).toEqual(a.eventTypes);
	});
});
