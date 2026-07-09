// SPDX-License-Identifier: MIT
//
// Damage test 1/6: crash at 30 km/h -> >=1 hit event, dentedVertexCount>0, NO panel broken, all welds
// still valid, car still drives afterward.
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';

describe('damage: moderate-impact', () => {
	it('crash at 30 km/h dents the car but breaks nothing', async () => {
		const sim = await createDamageSim();
		try {
			const wall = sim.spawnWall(10);
			sim.crash(30);

			let hitEventCount = 0;
			for (let i = 0; i < 240; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				hitEventCount += sim.world.hitEvents().count;
			}

			const dt = sim.damageTelemetry();
			const brokenCount = Object.values(dt.panelStates).filter((s) => s === 'broken').length;

			console.log(
				`[moderate-impact] hitEvents=${hitEventCount} dentedVertexCount=${dt.dentedVertexCount} ` +
					`panelStates=${JSON.stringify(dt.panelStates)}`,
			);

			expect(hitEventCount).toBeGreaterThanOrEqual(1);
			expect(dt.dentedVertexCount).toBeGreaterThan(0);
			expect(brokenCount).toBe(0);

			// All welds still valid (loosened is fine -- softened in place, joint object persists;
			// only BREAK destroys the joint).
			for (const key of Object.keys(sim.vehicle.panels)) {
				const panel = sim.vehicle.panels[key];
				expect(panel.state).not.toBe('broken');
				expect(panel.weldJoint).not.toBeNull();
				expect(panel.weldJoint.isValid()).toBe(true);
			}

			// Car still drives: post-crash throttle moves it meaningfully. Removes the wall first --
			// the car rebounds to rest only ~3m clear of it (verified), and driving straight back into
			// the same solid wall it just hit isn't a fair "does the drivetrain still work" check (it
			// would just pin itself against the wall again after ~1m); this is checking the drivetrain
			// itself survived the crash, not re-litigating collision physics against the same obstacle.
			wall.destroy();
			const posBefore = sim.vehicle.chassis.getPosition();
			for (let i = 0; i < 240; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
			}
			const posAfter = sim.vehicle.chassis.getPosition();
			const displacement = Math.hypot(posAfter.x - posBefore.x, posAfter.y - posBefore.y, posAfter.z - posBefore.z);
			console.log(`[moderate-impact] post-crash throttle displacement=${displacement.toFixed(2)}m`);
			expect(displacement).toBeGreaterThan(5);

			// No NaNs anywhere.
			const t = sim.vehicle.chassis.getTransform();
			for (const v of [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w]) {
				expect(Number.isFinite(v)).toBe(true);
			}
		} finally {
			sim.destroy();
		}
	});
});
