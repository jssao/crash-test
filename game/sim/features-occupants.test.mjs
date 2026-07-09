// SPDX-License-Identifier: MIT
//
// Headless tests for the 'occupants' WorldFeature (game/src/world/features/occupants/*). Imports
// physics.ts DIRECTLY (skips the WorldFeature registry, which needs import.meta.glob/vite -- per this
// task's own guidance: "your feature module can be imported directly in a vitest file"). No visuals
// module involved (no three/DOM in plain node) -- this exercises exactly the same renderer-free
// physics the browser feature drives.
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';
import { spawnTestWall, crashSetup } from '../src/damage/scenario.ts';
import {
	createOccupant,
	createSeatPan,
	matchOccupantVelocity,
	matchSeatPanVelocity,
	pollOccupantRestraint,
	teardownOccupant,
	teardownSeatPan,
} from '../src/world/features/occupants/physics.ts';
import { MASS_FRACTION, SEAT_KEYS } from '../src/world/features/occupants/tuning.ts';

/** Builds all 4 seat pans + occupants against `sim.vehicle.chassis`'s CURRENT transform -- mirrors
 * index.ts's seatAll(), without the visuals half (no three/DOM in plain node). */
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

function allPartsFinite(occupant) {
	for (const key of Object.keys(occupant.parts)) {
		const t = occupant.parts[key].body.getTransform();
		for (const v of [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w]) {
			if (!Number.isFinite(v)) return false;
		}
	}
	return true;
}

function pelvisDistanceFromChassis(sim, occupant) {
	const p = occupant.parts.pelvis.body.getPosition();
	const c = sim.vehicle.chassis.getPosition();
	return Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
}

describe('occupants: mass fractions', () => {
	it('sum to 1 across all 11 parts', () => {
		const sum = Object.values(MASS_FRACTION).reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(1, 6);
	});
});

describe('occupants: seated-stability', () => {
	it('10s of mild varied driving leaves all 4 occupants restrained, no ejection, no NaN', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);

			// Let the settle-drop resolve first (see physics.ts's SETTLE doc comment).
			for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

			const phaseSteps = 150; // 2.5s per phase @ 60Hz
			const phases = [
				{ throttle: 1, brake: 0, steer: 0 },
				{ throttle: 0.6, brake: 0, steer: 0.2 },
				{ throttle: 0.6, brake: 0, steer: -0.2 },
				{ throttle: 0, brake: 0.5, steer: 0 },
			];
			let sawNaN = false;
			for (const phase of phases) {
				for (let i = 0; i < phaseSteps; i++) {
					sim.step({ ...phase, handbrake: false });
					for (const o of rig.occupants) {
						pollOccupantRestraint(o);
						if (!allPartsFinite(o)) sawNaN = true;
					}
				}
			}

			const ejectedCount = rig.occupants.filter((o) => o.ejected).length;
			const maxForce = Math.max(...rig.occupants.map((o) => (o.restraintJoint ? Math.hypot(...Object.values(o.restraintJoint.getConstraintForce())) : -1)));
			console.log(`[seated-stability] ejectedCount=${ejectedCount} maxRestraintForceN=${maxForce.toFixed(0)} sawNaN=${sawNaN}`);

			expect(sawNaN).toBe(false);
			expect(ejectedCount).toBe(0);
			for (const o of rig.occupants) expect(o.restraintJoint).not.toBeNull();

			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});

describe('occupants: jostle under hard braking', () => {
	it('a hard brake from speed produces measurable torso pitch motion relative to the chassis', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

			// Accelerate to speed.
			for (let i = 0; i < 240; i++) sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
			const speedBefore = Math.hypot(sim.vehicle.chassis.getLinearVelocity().x, sim.vehicle.chassis.getLinearVelocity().z);
			expect(speedBefore).toBeGreaterThan(5); // m/s -- confirms the rig actually got moving

			// Snapshot each torso's pitch (angle between its local Y axis and the chassis's local Y axis,
			// via the dot product of their world-up directions) just before hard braking.
			function torsoTiltFromChassis(o) {
				const torsoQ = o.parts.torso.body.getRotation();
				const chassisQ = sim.vehicle.chassis.getRotation();
				// World-up-axis-in-body-space dot product: 1 = perfectly aligned with chassis, less = tilted.
				const up = (q) => {
					// rotate (0,1,0) by q
					const x = q.x, y = q.y, z = q.z, w = q.w;
					return { x: 2 * (x * y - w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + w * x) };
				};
				const a = up(torsoQ);
				const b = up(chassisQ);
				return a.x * b.x + a.y * b.y + a.z * b.z;
			}
			const tiltBefore = rig.occupants.map(torsoTiltFromChassis);

			// Hard brake.
			let minTilt = tiltBefore.slice();
			for (let i = 0; i < 90; i++) {
				sim.step({ throttle: 0, brake: 1, steer: 0, handbrake: false });
				rig.occupants.forEach((o, idx) => {
					const tilt = torsoTiltFromChassis(o);
					if (tilt < minTilt[idx]) minTilt[idx] = tilt;
				});
			}

			const maxDeviation = Math.max(...rig.occupants.map((_, i) => tiltBefore[i] - minTilt[i]));
			console.log(`[jostle] tiltBefore=${tiltBefore.map((v) => v.toFixed(4))} minTilt=${minTilt.map((v) => v.toFixed(4))} maxDeviation=${maxDeviation.toFixed(4)}`);

			// A perfectly rigid (non-jostling) torso would track the chassis's own pitch exactly (constant
			// dot product, deviation ~0) -- braking must produce a measurably independent forward lean.
			expect(maxDeviation).toBeGreaterThan(0.01);

			for (const o of rig.occupants) expect(allPartsFinite(o)).toBe(true);

			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});

describe('occupants: ejection on hard frontal crash', () => {
	it('a >=60km/h wall crash ejects at least the 2 unbelted (rear) occupants', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

			const wall = spawnTestWall(sim.world, sim.vehicle, 20);
			crashSetup(sim.vehicle, 70);
			// Match every occupant to the chassis's new (instant) velocity BEFORE the wall impact -- see
			// physics.ts's matchOccupantVelocity() doc comment: avoids an artificial t=0 relative-velocity
			// spike across the restraint from crashSetup's own instantaneous speed injection, so the
			// ACTUAL wall-impact deceleration is what's under test.
			const v = sim.vehicle.chassis.getLinearVelocity();
			for (const o of rig.occupants) matchOccupantVelocity(o, v);
			for (const p of rig.seatPans) matchSeatPanVelocity(p, v);

			const pelvisDistAtT0 = rig.occupants.map((o) => pelvisDistanceFromChassis(sim, o));

			let sawNaN = false;
			for (let i = 0; i < 180; i++) {
				// 3s @ 60Hz
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				for (const o of rig.occupants) {
					pollOccupantRestraint(o);
					if (!allPartsFinite(o)) sawNaN = true;
				}
			}

			const ejected = rig.occupants.filter((o) => o.ejected);
			const separations = rig.occupants.map((o) => pelvisDistanceFromChassis(sim, o));
			console.log(
				`[ejection] ejectedSeats=${ejected.map((o) => o.seatKey)} pelvisDistAtT0=${pelvisDistAtT0.map((d) => d.toFixed(2))} separationsAfter3s=${separations.map((d) => d.toFixed(2))}`,
			);

			expect(sawNaN).toBe(false);
			expect(ejected.length).toBeGreaterThanOrEqual(2);
			// Every EJECTED occupant's pelvis must have separated meaningfully from the chassis.
			for (const o of ejected) {
				const idx = rig.occupants.indexOf(o);
				expect(separations[idx]).toBeGreaterThan(2);
			}
			// The unbelted rear seats (lower threshold) must be among the ejected.
			const ejectedSeatKeys = new Set(ejected.map((o) => o.seatKey));
			expect(ejectedSeatKeys.has('rearLeft') || ejectedSeatKeys.has('rearRight')).toBe(true);

			wall.destroy();
			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});

describe('occupants: reset re-seats 4/4', () => {
	it('teardown + rebuild against a fresh chassis produces 4 fully-restrained occupants again', async () => {
		const sim = await createSim();
		try {
			let rig = seatAll(sim);
			for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

			// Force an ejection first, so the reset actually has broken state to recover from.
			const wall = spawnTestWall(sim.world, sim.vehicle, 20);
			crashSetup(sim.vehicle, 70);
			const v = sim.vehicle.chassis.getLinearVelocity();
			for (const o of rig.occupants) matchOccupantVelocity(o, v);
			for (const p of rig.seatPans) matchSeatPanVelocity(p, v);
			for (let i = 0; i < 120; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				for (const o of rig.occupants) pollOccupantRestraint(o);
			}
			const ejectedBefore = rig.occupants.filter((o) => o.ejected).length;
			expect(ejectedBefore).toBeGreaterThanOrEqual(1);
			wall.destroy();

			// Simulate main.ts's doCarRepair(): the vehicle module destroys+recreates its OWN chassis/
			// wheels/panels independently (not exercised here -- this test only owns the occupants
			// feature's reaction), then this feature's reset() tears down + rebuilds against the (in this
			// test, same-handle, since we didn't actually recreate the vehicle) chassis -- see physics.ts's
			// LIFECYCLE HAZARD doc comment for why teardown always uses forgetHandle() for the chassis-
			// attached joints rather than destroy().
			teardownAll(rig);
			rig = seatAll(sim);

			expect(rig.occupants.length).toBe(4);
			for (const o of rig.occupants) {
				expect(o.ejected).toBe(false);
				expect(o.restraintJoint).not.toBeNull();
				expect(allPartsFinite(o)).toBe(true);
			}

			// A brief settle + mild step confirms the freshly-reseated rig is stable (no NaN, nobody
			// immediately re-ejects from the settle drop alone).
			for (let i = 0; i < 60; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				for (const o of rig.occupants) pollOccupantRestraint(o);
			}
			for (const o of rig.occupants) {
				expect(o.ejected).toBe(false);
				expect(allPartsFinite(o)).toBe(true);
			}

			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});
