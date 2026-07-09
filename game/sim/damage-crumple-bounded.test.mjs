// SPDX-License-Identifier: MIT
//
// Damage test 5/6: 12 repeated 40 km/h impacts -> max per-vertex displacement stays within the
// per-mesh clamp (crumple.ts's CRUMPLE_CLAMP_CHASSIS_M / CRUMPLE_CLAMP_PANEL_GLASS_M, applied at
// registration -- see DeformableMeshHandle.clampM), all normals finite, dentedVertexCount
// monotonically non-decreasing and eventually plateaus (clamp reached -- persistent, never heals, per
// crumple.ts's module doc).
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';

describe('damage: crumple-bounded', () => {
	it('12 repeated 40 km/h impacts stay within clamp bounds', async () => {
		const sim = await createDamageSim();
		try {
			sim.spawnWall(10);

			const dentedHistory = [];
			for (let trial = 0; trial < 12; trial++) {
				sim.crash(40);
				for (let i = 0; i < 180; i++) {
					sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				}
				dentedHistory.push(sim.damageTelemetry().dentedVertexCount);
			}
			console.log(`[crumple-bounded] dentedVertexCount history: ${dentedHistory.join(',')}`);

			// Monotonically non-decreasing (persistent -- never heals).
			for (let i = 1; i < dentedHistory.length; i++) {
				expect(dentedHistory[i]).toBeGreaterThanOrEqual(dentedHistory[i - 1]);
			}
			// Eventually plateaus: growth over the last 3 trials is much smaller than over the first 3
			// (the repeatedly-hit region's vertices are already dented/clamped, so later impacts touch
			// few if any NEW vertices) -- a small tolerance rather than requiring exactly zero further
			// growth, since an impact landing at a very slightly different spot each trial can still
			// occasionally reach one or two fresh boundary vertices.
			const n = dentedHistory.length;
			const earlyGrowth = dentedHistory[2] - dentedHistory[0];
			const tailGrowth = dentedHistory[n - 1] - dentedHistory[n - 3];
			console.log(`[crumple-bounded] earlyGrowth(trials 1-3)=${earlyGrowth} tailGrowth(last 3 trials)=${tailGrowth}`);
			expect(tailGrowth).toBeLessThanOrEqual(3);
			expect(tailGrowth).toBeLessThan(earlyGrowth);
			expect(dentedHistory[n - 1]).toBeGreaterThan(0);

			// Per-vertex displacement clamp + normal finiteness, across every registered mesh.
			let maxObservedDisplacement = 0;
			for (const mesh of sim.damage.registry.meshes) {
				for (let v = 0; v < mesh.vertexCount; v++) {
					const ox = mesh.offsets[v * 3];
					const oy = mesh.offsets[v * 3 + 1];
					const oz = mesh.offsets[v * 3 + 2];
					const mag = Math.hypot(ox, oy, oz);
					maxObservedDisplacement = Math.max(maxObservedDisplacement, mag);
					expect(mag).toBeLessThanOrEqual(mesh.clampM + 1e-6);
				}
				if (mesh.normals) {
					for (let i = 0; i < mesh.normals.length; i++) {
						expect(Number.isFinite(mesh.normals[i])).toBe(true);
					}
				}
			}
			console.log(`[crumple-bounded] max observed per-vertex displacement: ${maxObservedDisplacement.toFixed(4)}m`);
		} finally {
			sim.destroy();
		}
	});
});
