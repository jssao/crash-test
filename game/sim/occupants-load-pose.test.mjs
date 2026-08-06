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
import { PART_DIMS, SEAT_KEYS, SETTLE_DROP_M } from '../src/world/features/occupants/tuning.ts';
import { FLOORPAN_FLOOR_LINE_Y_M } from '../src/vehicle/geometry.ts';

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
	it('after spawn + ~300 settle steps with no input, every seated dummy holds a properly-seated pose: knees near the seated rest angle, no torso/pelvis slump, feet resting AT/ABOVE the floor line (on the footwell shelf)', async () => {
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

				// (c) P001 REAL FIX (2026-07-15): the shin/foot capsule's own BOTTOM (its lowest point, not
				// just its center) sits AT/ABOVE the cabin floor line -- i.e. the feet no longer dip below
				// the floor at all. The occupant-only FOOTWELL SHELF (vehicle/geometry.ts
				// buildFootwellShelfShapes(), a thin ledge at FLOORPAN_FLOOR_LINE_Y_M) catches the seated
				// feet at the floor while the car idles here (the shelf is speed-gated -- engaged at rest,
				// see tuning.ts FOOTWELL_SHELF_*_SPEED_MS -- and disengaged during driving/crashes so it
				// never perturbs those dynamics; enabled by giving every static ground GROUND_CATEGORY_BITS
				// so the ledge can't beach the car, tuning.ts). This SUPERSEDES the old caveat that only the
				// capsule CENTER cleared the floor while the foot tip still dipped to ~-0.14 -- the tip now
				// rests ON the shelf. The capsule's true lowest point = center.y - halfLen*|worldDownY| -
				// radius (the shin hangs ~vertical, so |worldDownY| ~1). MEASURED bottom after settle:
				// ~0.030 (front) / ~0.029 (rear), both essentially AT the 0.03 floor line (the ~1mm below is
				// box3d's contact slop as the foot rests on the ledge). A small epsilon absorbs that slop.
				const shin = PART_DIMS.shin;
				const EPSILON_M = 0.012;
				for (const key of ['shinL', 'shinR']) {
					const p = o.parts[key].body.getPosition();
					const q = o.parts[key].body.getTransform().rotation;
					// Y-component of the capsule's local +Y axis in world space (see the probe used to derive
					// this): the capsule spans center +- halfLen along local Y, so its lowest point drops by
					// halfLen*|that component| plus the end-cap radius.
					const worldUpY = 1 - 2 * (q.x * q.x + q.z * q.z);
					const capsuleBottomY = p.y - chassisY - shin.halfLen * Math.abs(worldUpY) - shin.radius;
					expect(
						capsuleBottomY,
						`${seatKey}.${key} capsule BOTTOM at/above the cabin floor line (foot no longer dips below the floor)`,
					).toBeGreaterThan(FLOORPAN_FLOOR_LINE_Y_M - EPSILON_M);
				}
			});

			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});
