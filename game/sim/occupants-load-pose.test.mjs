// SPDX-License-Identifier: MIT
//
// P001 REGRESSION GUARD ("dummies limp/unposed at crash-lab load"): headless test asserting the seated
// rest pose actually HOLDS through a long settle with no input, rather than sagging into a folded-knee/
// slumped-torso mess. Same renderer-free physics.ts-direct convention as features-occupants.test.mjs
// (no visuals/three/DOM). See occupants/tuning.ts's P001 RE-CALIBRATION doc comments (BALL_SPRING_HERTZ,
// HINGE_SPRING_HERTZ, HINGE_UPPER_RAD, OCCUPANT_MASS_KG, SEAT_LOCAL, PART_DIMS.shin) for the fix this
// test guards.
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';
import { createOccupant, createSeatPan, teardownOccupant, teardownSeatPan } from '../src/world/features/occupants/physics.ts';
import { SEAT_KEYS, SETTLE_DROP_M } from '../src/world/features/occupants/tuning.ts';

function seatAll(sim) {
	const chassis = sim.vehicle.chassis;
	const t = chassis.getTransform();
	const seatPans = [];
	const occupants = [];
	SEAT_KEYS.forEach((seatKey, seatIndex) => {
		seatPans.push(createSeatPan(sim.world, chassis, seatKey, t.position, t.rotation));
		occupants.push(createOccupant(sim.world, chassis, seatIndex, seatKey, t.position, t.rotation));
	});
	return { seatPans, occupants };
}

function teardownAll(rig) {
	for (const o of rig.occupants) teardownOccupant(o);
	for (const p of rig.seatPans) teardownSeatPan(p);
}

describe('occupants: load-pose stability (P001 regression guard)', () => {
	it('after spawn + ~300 settle steps with no input, every seated dummy holds a properly-seated pose: knees near the seated rest angle, no torso/pelvis slump, feet not badly below the floor line', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);

			// Capture the DESIGNED spawn geometry before any physics runs -- the rig is built
			// SETTLE_DROP_M above its final rest point by design (physics.ts's SETTLE doc comment), so
			// the expected settled pelvis height is spawnPelvisY - SETTLE_DROP_M, not the raw spawn value.
			const chassisY0 = sim.vehicle.chassis.getPosition().y;
			const spawnPelvisY = rig.occupants.map((o) => o.parts.pelvis.body.getPosition().y - chassisY0);

			// ~5s @ 60Hz settle, no driver input at all -- the exact "crash-lab load, car just sitting
			// there" scenario the bug report described.
			for (let i = 0; i < 300; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

			let sawNaN = false;
			for (const o of rig.occupants) {
				for (const key of Object.keys(o.parts)) {
					const t = o.parts[key].body.getTransform();
					for (const v of [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w]) {
						if (!Number.isFinite(v)) sawNaN = true;
					}
				}
			}
			expect(sawNaN, 'no NaN/Inf anywhere after the settle').toBe(false);

			const chassisY = sim.vehicle.chassis.getPosition().y;

			rig.occupants.forEach((o, i) => {
				const seatKey = o.seatKey;

				// (a) KNEES stay within ~0.3rad of the seated rest angle (0) -- the core P001 ask: calves
				// must not fold up into the thighs. HINGE_UPPER_RAD=0.3 is now a hard backstop on the
				// fold-in direction (occupants/tuning.ts), so this also implicitly checks that backstop
				// held; the measured settle (this fix's own diagnostic) sits within +-0.1rad.
				for (const jointKey of ['kneeL', 'kneeR']) {
					const angle = o.joints[jointKey].getAngle();
					expect(Math.abs(angle), `${seatKey}.${jointKey} angle stays near seated rest`).toBeLessThan(0.3);
				}

				// (b) PELVIS/TORSO heights stay close to the designed rest pose -- no gravity slump. The
				// pelvis should settle to ~SETTLE_DROP_M below its (elevated) spawn point; the torso
				// should stay a nearly-fixed ~0.21m above the pelvis (pelvisTop 0.05 + torsoBottom 0.16,
				// tuning.ts's ATTACH) regardless of seat -- a large deviation here means the spine/hip
				// joints sagged instead of holding the seated posture.
				const pelvisY = o.parts.pelvis.body.getPosition().y - chassisY;
				const torsoY = o.parts.torso.body.getPosition().y - chassisY;
				const expectedPelvisY = spawnPelvisY[i] - SETTLE_DROP_M;
				expect(Math.abs(pelvisY - expectedPelvisY), `${seatKey} pelvis height near designed rest (no slump)`).toBeLessThan(0.08);
				expect(Math.abs(torsoY - pelvisY - 0.21), `${seatKey} torso-above-pelvis offset near design (no spine slump)`).toBeLessThan(0.08);

				// (c) No shin/foot capsule CENTER below (chassis-local floor line - small epsilon). Floor
				// line = FLOORPAN_TOP_Y_M (vehicle/geometry.ts, currently 0.03 -- not exported, so
				// hard-coded here with this note rather than adding a vehicle/* export for one test
				// constant; re-check this literal if that geometry value ever changes). This is the
				// geometric mitigation this fix made (SEAT_LOCAL.y raise + shin shortening,
				// occupants/tuning.ts) -- it does NOT claim the ankle/foot tip itself clears the floor
				// (documented residual: it doesn't -- see tuning.ts's SEAT_LOCAL doc comment), only that
				// the capsule's own center -- most of its visible mass -- sits at or above the floor line.
				const FLOOR_LINE_Y_M = 0.03;
				const EPSILON_M = 0.05;
				for (const key of ['shinL', 'shinR']) {
					const y = o.parts[key].body.getPosition().y - chassisY;
					expect(y, `${seatKey}.${key} capsule center at/above the floor line (within epsilon)`).toBeGreaterThan(FLOOR_LINE_Y_M - EPSILON_M);
				}
			});

			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});
