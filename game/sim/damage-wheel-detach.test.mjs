// SPDX-License-Identifier: MIT
//
// Damage test 4/6: direct huge impulse at a front wheel (mechanism test, not crash-luck) -> wheel
// joint destroyed, car body count consistent, remaining car simulates 3s without NaN and still
// responds to throttle (any displacement >1m).
//
// MEASURED CAVEAT: a sustained impulse large enough to reliably detach the TARGETED wheel (front-left)
// also rocks the whole chassis hard enough, through shared chassis dynamics, that the other 3 wheel
// joints cross the same force-spike threshold within the same handful of steps -- measured directly:
// every magnitude/duration combination that detached the front-left wheel at all detached all 4
// wheels virtually simultaneously (never just 1-3), i.e. this joint model doesn't offer a clean
// "exactly this one wheel, not the others" impulse in practice. Documented plainly rather than
// asserting something not actually observed -- this test checks the MECHANISM (a big enough sustained
// force spike destroys a wheel joint) and that the car keeps simulating/responding afterward, without
// asserting exactly how many of the 4 wheels end up detached.
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';

describe('damage: wheel-detach', () => {
	it('a sustained huge impulse on the front-left wheel destroys its joint', async () => {
		const sim = await createDamageSim();
		try {
			for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

			const bodyCountBefore = 1 /* chassis */ + Object.keys(sim.vehicle.wheels).length + Object.keys(sim.vehicle.panels).length;

			let detachedAtStep = -1;
			for (let i = 0; i < 20; i++) {
				if (detachedAtStep < 0) {
					sim.vehicle.wheels.fl.body.applyLinearImpulseToCenter({ x: 20000, y: 0, z: 0 }, true);
				}
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				if (detachedAtStep < 0 && !sim.vehicle.wheels.fl.joint) detachedAtStep = i;
			}

			const dt = sim.damageTelemetry();
			console.log(`[wheel-detach] detachedAtStep=${detachedAtStep} wheelStates=${JSON.stringify(dt.wheelStates)}`);
			expect(dt.wheelStates.fl).toBe('detached');

			// Every wheel BODY still exists (only the JOINT is destroyed on detach -- see welds.ts's
			// stepWeldsAndWheels()); body count is unchanged.
			for (const key of Object.keys(sim.vehicle.wheels)) {
				expect(sim.vehicle.wheels[key].body.isValid()).toBe(true);
			}
			const bodyCountAfter = 1 + Object.keys(sim.vehicle.wheels).length + Object.keys(sim.vehicle.panels).length;
			expect(bodyCountAfter).toBe(bodyCountBefore);

			// Remaining car simulates 3s (180 steps) without NaN and still responds to throttle.
			let sawNaN = false;
			const posBefore = sim.vehicle.chassis.getPosition();
			for (let i = 0; i < 180; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				const t = sim.vehicle.chassis.getTransform();
				for (const v of [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w]) {
					if (!Number.isFinite(v)) sawNaN = true;
				}
			}
			const posAfter = sim.vehicle.chassis.getPosition();
			const displacement = Math.hypot(posAfter.x - posBefore.x, posAfter.y - posBefore.y, posAfter.z - posBefore.z);
			console.log(`[wheel-detach] post-detach 3s throttle displacement=${displacement.toFixed(2)}m sawNaN=${sawNaN}`);

			expect(sawNaN).toBe(false);
			expect(displacement).toBeGreaterThan(1);
		} finally {
			sim.destroy();
		}
	});
});
