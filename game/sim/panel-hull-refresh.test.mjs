// SPDX-License-Identifier: MIT
//
// Crush M3 gate (crush-architecture.md §B): COLLISION FOLLOWS THE DENTS. When a panel's accumulated
// cosmetic crumple moves its deformed-mesh AABB past PANEL_HULL_REFRESH_DELTA_M, the damage system
// rebuilds that panel's collision hull in place (Shape.setHull, the M0b runtime-geometry machinery;
// system.ts refreshPanelHulls) -- rate-limited (>= 30 steps apart per panel, <= 1 panel/step).
//
// Scenario: a heavy box dropped on the HOOD -- a real hit event, denting the hood DOWNWARD (normal
// direction). NOTE a convex hull can only follow the collision-VISIBLE part of a dent (the AABB
// face shift); purely in-plane vertex slide (e.g. a frontal wall pushing hood vertices rearward
// within the panel plane) leaves any convex proxy unchanged by geometry, and the refresh correctly
// ignores it (refreshPanelHulls' doc).
import { describe, expect, it } from 'vitest';
import { BodyType } from '../../src/ts/index.ts';
import { createDamageSim } from './damage-harness.mjs';
import { PANEL_HULL_REFRESH_DELTA_M, PANEL_HULL_REFRESH_MIN_STEPS } from '../src/damage/damage-tuning.ts';
import { OCCUPANT_EJECTED_COLLIDABLE_BIT } from '../src/vehicle/tuning.ts';

// The impactor/probe carry an EJECTEE-like mask (the single ejected-collidable bit): the front crush
// CORES (chassis backstops, occupant-transparent category = that bit stripped) sit ABOVE the low
// Mustang hood line, so a default-mask body dropped "onto the hood" actually rests on the invisible
// core -- exactly as it rested on the old solid nose volume pre-crush-M1. The bodies that genuinely
// rest ON the hood's own hull in gameplay are EJECTED OCCUPANTS (panels are ejected-only colliders;
// see escalation 6's corpse-on-the-hood), so the hull-follows-dents proof uses the same filter.

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };

describe('crush M3: panel collision follows the dents (system.ts refreshPanelHulls)', () => {
	it('a heavy impactor dents the hood; the hull is rebuilt (rate-limited) and a probe rests INTO the dent', async () => {
		const sim = await createDamageSim();
		try {
			for (let i = 0; i < 30; i++) sim.step(NEUTRAL);

			const hood = sim.vehicle.panels.hood;
			const hp0 = hood.body.getPosition();
			// Heavy impactor over the hood center: a REAL hit event -> the crumple pipeline dents the
			// hood mesh downward (unregistered foreign body = wall-like full-weight damage).
			const impactor = sim.world.createBody({ type: BodyType.Dynamic, position: { x: hp0.x, y: hp0.y + 2.0, z: hp0.z } });
			const impactorShape = impactor.createBoxShape({ halfExtents: { x: 0.3, y: 0.15, z: 0.3 }, density: 500, friction: 0.7, maskBits: OCCUPANT_EJECTED_COLLIDABLE_BIT });
			for (let i = 0; i < 180; i++) sim.step(NEUTRAL);

			// The dent is real (mesh moved beyond the refresh threshold, downward)...
			const mesh = sim.damage.registry.meshes.find((m) => m.kind === 'panel' && m.attachedTo === 'hood');
			let minYOff = 0;
			for (let v = 0; v < mesh.vertexCount; v++) minYOff = Math.min(minYOff, mesh.offsets[v * 3 + 1]);
			console.log(`[panel-hull] hood dent depth=${(-minYOff).toFixed(3)}m refreshes=${JSON.stringify(sim.damage.panelHull.refreshes)} hoodState=${sim.damageTelemetry().panelStates.hood}`);
			expect(-minYOff).toBeGreaterThan(PANEL_HULL_REFRESH_DELTA_M);
			// ...and the collision hull was genuinely REBUILT, respecting the rate limit.
			const refreshes = sim.damage.panelHull.refreshes.hood;
			expect(refreshes).toBeGreaterThanOrEqual(1);
			expect(refreshes).toBeLessThanOrEqual(Math.ceil(180 / PANEL_HULL_REFRESH_MIN_STEPS));

			// Remove the impactor, then rest a small LIGHT probe onto the dented region: contacts must
			// respect the mutated hull -- the probe settles measurably BELOW the pristine hull's top
			// plane (which tracks the hood BODY pose, so post-impact sag/loosening cannot fake this).
			impactorShape.destroy(false);
			impactor.destroy();
			for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
			const hp = hood.body.getPosition();
			const probe = sim.world.createBody({ type: BodyType.Dynamic, position: { x: hp.x, y: hp.y + 1.0, z: hp.z } });
			probe.createSphereShape({ radius: 0.06, density: 100, friction: 0.9, maskBits: OCCUPANT_EJECTED_COLLIDABLE_BIT });
			for (let i = 0; i < 240; i++) sim.step(NEUTRAL);

			const rest = probe.getPosition();
			const hoodNow = hood.body.getPosition();
			const pristineTopRestY = hoodNow.y + hood.halfExtents.y + 0.06; // hull top + probe radius
			console.log(`[panel-hull] probe restY=${rest.y.toFixed(3)} pristine-hull restY=${pristineTopRestY.toFixed(3)} (delta ${(pristineTopRestY - rest.y).toFixed(3)})`);
			// Still ON the car (not rolled off), and INTO the dent: >=2.5cm below the pristine top
			// plane (the dented-region mean the rebuild follows -- measured -0.033m for this dent).
			expect(Math.hypot(rest.x - hoodNow.x, rest.z - hoodNow.z)).toBeLessThan(1.2);
			expect(rest.y).toBeLessThan(pristineTopRestY - 0.025);
			expect(rest.y).toBeGreaterThan(hoodNow.y - 0.3); // ...but did NOT tunnel through the panel

			probe.destroy();
		} finally {
			sim.destroy();
		}
	});

	it('an undented panel never rebuilds (no false refresh churn from plain driving)', async () => {
		const sim = await createDamageSim();
		try {
			for (let i = 0; i < 300; i++) sim.step({ throttle: 1, brake: 0, steer: 0.05, handbrake: false });
			const r = sim.damage.panelHull.refreshes;
			expect(r.hood + r.doorL + r.doorR + r.trunk).toBe(0);
		} finally {
			sim.destroy();
		}
	});
});
