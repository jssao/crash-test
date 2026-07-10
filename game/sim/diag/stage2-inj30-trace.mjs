// SPDX-License-Identifier: MIT
// Stage-2 diagnosis probe 8 (vite-node): EXACT escalation-2 repro (60 settle steps, wall@18m,
// 30km/h, 360 aftermath steps, browser-faithful loop) with per-step force/gate logging around any
// over-threshold step, to attribute the 30km/h false ejection.
import { createSim } from '../harness.mjs';
import { spawnTestWall, crashSetup } from '../../src/damage/scenario.ts';
import {
	createOccupant,
	createSeatPan,
	matchOccupantVelocity,
	matchSeatPanVelocity,
	pollOccupantRestraint,
	teardownOccupant,
	teardownSeatPan,
} from '../../src/world/features/occupants/physics.ts';
import { createOccupantRuntime, resetOccupantAccelBaseline, updateOccupantActive } from '../../src/world/features/occupants/active.ts';
import { createDamageSystem, stepDamageSystem } from '../../src/damage/system.ts';
import { SEAT_KEYS, RESTRAINT_FORCE_THRESHOLD_N, PART_KEYS } from '../../src/world/features/occupants/tuning.ts';
import { FIXED_DT, GRAVITY_MAG } from '../../src/vehicle/tuning.ts';

const sim = await createSim();
const chassis = sim.vehicle.chassis;
const t0 = chassis.getTransform();
sim.ground.setUserData(9000);
const pans = [];
const occupants = [];
const runtimes = [];
SEAT_KEYS.forEach((seatKey, i) => {
	const pan = createSeatPan(sim.world, chassis, seatKey, t0.position, t0.rotation);
	pan.shape.setUserData(9001 + i);
	pans.push(pan);
	occupants.push(createOccupant(sim.world, chassis, i, seatKey, t0.position, t0.rotation));
	runtimes.push(createOccupantRuntime());
});
const braceCtx = () => {
	const ct = chassis.getTransform();
	return { chassisPos: ct.position, chassisRot: ct.rotation, chassisVel: chassis.getLinearVelocity(), world: sim.world };
};
const damage = createDamageSystem(sim.vehicle);
const stepAll = () => {
	sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
	stepDamageSystem(damage, sim.world, 1 / 60);
	occupants.forEach((o, k) => {
		pollOccupantRestraint(o);
		updateOccupantActive(o, runtimes[k], 1 / 60, braceCtx());
	});
};
for (let i = 0; i < 60; i++) stepAll();
const wall = spawnTestWall(sim.world, sim.vehicle, 18);
crashSetup(sim.vehicle, 30);
const v = chassis.getLinearVelocity();
occupants.forEach((o, k) => {
	matchOccupantVelocity(o, v);
	resetOccupantAccelBaseline(o, runtimes[k]);
});
for (const p of pans) matchSeatPanVelocity(p, v);

let prevCv = chassis.getLinearVelocity();
for (let step = 0; step < 360; step++) {
	sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
	stepDamageSystem(damage, sim.world, 1 / 60);
	const cv = chassis.getLinearVelocity();
	const instG = Math.hypot(cv.x - prevCv.x, cv.y - prevCv.y, cv.z - prevCv.z) / FIXED_DT / GRAVITY_MAG;
	prevCv = cv;
	occupants.forEach((o, k) => {
		if (!o.restraintJoint || o.ejected) return;
		const f = Math.hypot(...Object.values(o.restraintJoint.getConstraintForce()));
		const ratio = f / RESTRAINT_FORCE_THRESHOLD_N[o.seatKey];
		{
			const ring = o.chassisVelRing;
			const oldest = ring[0];
			const wg = ring.length > 1 ? Math.hypot(cv.x - oldest.x, cv.y - oldest.y, cv.z - oldest.z) / ((ring.length - 1) * FIXED_DT) / GRAVITY_MAG : 0;
			if (!globalThis.__mx) globalThis.__mx = {};
			const m = (globalThis.__mx[o.seatKey] ??= { wg: 0, f: 0, fAtOpenGate: 0 });
			m.wg = Math.max(m.wg, wg);
			m.f = Math.max(m.f, f);
			if (wg >= 2.5) m.fAtOpenGate = Math.max(m.fAtOpenGate, f);
		}
		if (ratio > 0.9) {
			const ring = o.chassisVelRing;
			const oldest = ring[0];
			const wg = ring.length > 1 ? Math.hypot(cv.x - oldest.x, cv.y - oldest.y, cv.z - oldest.z) / ((ring.length - 1) * FIXED_DT) / GRAVITY_MAG : 0;
			console.log(`step=${step} seat=${o.seatKey} ratio=${ratio.toFixed(2)} windowG(pre-poll)=${wg.toFixed(1)} instG=${instG.toFixed(1)} carSpeed=${Math.hypot(cv.x, cv.z).toFixed(1)}`);
			// dump this occupant's live contacts
			for (const p of PART_KEYS) {
				const live = o.parts[p].shape.getContactData().filter((c) => c.totalNormalImpulseSum > 5);
				for (const c of live) console.log(`   contact part=${p} ids=${c.entityIdA}/${c.entityIdB} J=${c.totalNormalImpulseSum.toFixed(1)}`);
			}
		}
	});
	occupants.forEach((o, k) => {
		const before = o.ejected;
		pollOccupantRestraint(o);
		updateOccupantActive(o, runtimes[k], 1 / 60, braceCtx());
		if (!before && o.ejected) console.log(`EJECT step=${step} seat=${o.seatKey}`);
	});
}
console.log('final:', occupants.map((o) => `${o.seatKey}:${o.ejected}`).join(' '));
console.log('maxima:', JSON.stringify(globalThis.__mx));
wall.destroy();
for (const o of occupants) teardownOccupant(o);
for (const p of pans) teardownSeatPan(p);
sim.destroy();
