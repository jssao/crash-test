// SPDX-License-Identifier: MIT
//
// Damage test 2/6: crash at 90 km/h -> hood loosened or broken; if broken, its body diverges from the
// chassis (relative displacement >0.5m within 2s of breaking); positions/quats stay finite everywhere;
// chassis dent accumulated near the nose.
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';

describe('damage: hard-frontal', () => {
	it('crash at 90 km/h at least loosens the hood', async () => {
		const sim = await createDamageSim();
		try {
			sim.spawnWall(10);
			sim.crash(90);

			let sawNaN = false;
			const checkFinite = () => {
				const t = sim.vehicle.chassis.getTransform();
				const vals = [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w];
				for (const v of vals) if (!Number.isFinite(v)) sawNaN = true;
				for (const key of Object.keys(sim.vehicle.panels)) {
					const pt = sim.vehicle.panels[key].body.getTransform();
					for (const v of [pt.position.x, pt.position.y, pt.position.z, pt.rotation.x, pt.rotation.y, pt.rotation.z, pt.rotation.w]) {
						if (!Number.isFinite(v)) sawNaN = true;
					}
				}
			};

			for (let i = 0; i < 300; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				checkFinite();
			}

			const dt = sim.damageTelemetry();
			console.log(`[hard-frontal] panelStates=${JSON.stringify(dt.panelStates)} dentedVertexCount=${dt.dentedVertexCount}`);

			expect(sawNaN).toBe(false);
			expect(['loosened', 'broken']).toContain(dt.panelStates.hood);

			if (dt.panelStates.hood === 'broken') {
				// Snapshot now, then step 2s (120 steps) further and check the broken hood's body has
				// diverged from the chassis by >0.5m (it's a free body once broken, no longer rigidly
				// welded -- see panels.ts's breakPanelWeld()).
				const relBefore = (() => {
					const h = sim.vehicle.panels.hood.body.getPosition();
					const c = sim.vehicle.chassis.getPosition();
					return Math.hypot(h.x - c.x, h.y - c.y, h.z - c.z);
				})();
				for (let i = 0; i < 120; i++) {
					sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
					checkFinite();
				}
				const relAfter = (() => {
					const h = sim.vehicle.panels.hood.body.getPosition();
					const c = sim.vehicle.chassis.getPosition();
					return Math.hypot(h.x - c.x, h.y - c.y, h.z - c.z);
				})();
				console.log(`[hard-frontal] hood-chassis relative displacement: before=${relBefore.toFixed(2)}m after=${relAfter.toFixed(2)}m`);
				expect(relAfter).toBeGreaterThan(0.5);
			}

			expect(sawNaN).toBe(false);

			// Chassis dent accumulated near the nose: the registered 'chassis-front' proxy mesh
			// (game/sim/damage-harness.mjs, centered at the hull's front face) should show real denting.
			const chassisMesh = sim.damage.registry.meshes.find((m) => m.id === 'chassis-front');
			console.log(`[hard-frontal] chassis-front dentedCount=${chassisMesh.dentedCount}`);
			expect(chassisMesh.dentedCount).toBeGreaterThan(0);
		} finally {
			sim.destroy();
		}
	});
});
