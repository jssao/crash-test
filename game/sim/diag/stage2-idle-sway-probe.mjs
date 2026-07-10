// SPDX-License-Identifier: MIT
// Stage-2 diagnosis probe 7 (vite-node): per-part chassis-relative angular-speed RMS at IDLE
// (browser-faithful loop), to locate the escalation-1 sway source. Also prints per-part world
// position drift over the window + live contacts at the end.
import { createSim } from '../harness.mjs';
import {
	createOccupant,
	createSeatPan,
	pollOccupantRestraint,
	teardownOccupant,
	teardownSeatPan,
} from '../../src/world/features/occupants/physics.ts';
import { createOccupantRuntime, updateOccupantActive } from '../../src/world/features/occupants/active.ts';
import { SEAT_KEYS, PART_KEYS } from '../../src/world/features/occupants/tuning.ts';

const sim = await createSim();
const chassis = sim.vehicle.chassis;
const t0 = chassis.getTransform();
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
sim.ground.setUserData(9000);
const braceCtx = () => {
	const ct = chassis.getTransform();
	return { chassisPos: ct.position, chassisRot: ct.rotation, chassisVel: chassis.getLinearVelocity(), world: sim.world };
};
const step = () => {
	sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
	occupants.forEach((o, k) => {
		pollOccupantRestraint(o);
		updateOccupantActive(o, runtimes[k], 1 / 60, braceCtx());
	});
};
for (let i = 0; i < 180; i++) step(); // 3s settle (test settles 3s then measures 5s)
const sums = occupants.map(() => Object.fromEntries(PART_KEYS.map((p) => [p, 0])));
const startPos = occupants.map((o) => Object.fromEntries(PART_KEYS.map((p) => {
	const w = o.parts[p].body.getPosition();
	return [p, { x: w.x, y: w.y, z: w.z }];
})));
const N = 300;
for (let i = 0; i < N; i++) {
	step();
	const wc = chassis.getAngularVelocity();
	occupants.forEach((o, k) => {
		for (const p of PART_KEYS) {
			const w = o.parts[p].body.getAngularVelocity();
			const m = Math.hypot(w.x - wc.x, w.y - wc.y, w.z - wc.z);
			sums[k][p] += m * m;
		}
	});
}
occupants.forEach((o, k) => {
	const per = PART_KEYS.map((p) => `${p}=${Math.sqrt(sums[k][p] / N).toFixed(3)}`).join(' ');
	console.log(`idle seat=${o.seatKey}: ${per}`);
	for (const p of PART_KEYS) {
		const w = o.parts[p].body.getPosition();
		const s = startPos[k][p];
		const drift = Math.hypot(w.x - s.x, w.y - s.y, w.z - s.z);
		if (drift > 0.03) console.log(`  DRIFT seat=${o.seatKey} part=${p} ${drift.toFixed(3)}m`);
		const live = o.parts[p].shape.getContactData().filter((c) => c.totalNormalImpulseSum > 0.2);
		for (const c of live) console.log(`  contact seat=${o.seatKey} part=${p} ids=${c.entityIdA}/${c.entityIdB} J=${c.totalNormalImpulseSum.toFixed(2)}`);
	}
});
for (const o of occupants) teardownOccupant(o);
for (const p of pans) teardownSeatPan(p);
sim.destroy();
