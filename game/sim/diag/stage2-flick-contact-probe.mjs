// SPDX-License-Identifier: MIT
// Stage-2 diagnosis probe 2 (vite-node): during the right->left steer flick that ejects both rears
// (stage2-seated-eject-probe.mjs), dump every occupant capsule's live contact manifolds + its
// chassis-local position, to identify WHICH shape arrests the occupant and pumps the belt spike.
import { createSim } from '../harness.mjs';
import {
	createOccupant,
	createSeatPan,
	pollOccupantRestraint,
	teardownOccupant,
	teardownSeatPan,
} from '../../src/world/features/occupants/physics.ts';
import { SEAT_KEYS, RESTRAINT_FORCE_THRESHOLD_N, PART_KEYS } from '../../src/world/features/occupants/tuning.ts';

function conj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
function rot(q, v) {
	const { x, y, z, w } = q;
	const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
	return { x: v.x + w * tx + (y * tz - z * ty), y: v.y + w * ty + (z * tx - x * tz), z: v.z + w * tz + (x * ty - y * tx) };
}

const sim = await createSim();
const chassis = sim.vehicle.chassis;
const t0 = chassis.getTransform();
const pans = [];
const occupants = [];
SEAT_KEYS.forEach((seatKey, i) => {
	pans.push(createSeatPan(sim.world, chassis, seatKey, t0.position, t0.rotation));
	occupants.push(createOccupant(sim.world, chassis, i, seatKey, t0.position, t0.rotation));
});
for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

const phases = [
	{ name: 'launch', throttle: 1, brake: 0, steer: 0 },
	{ name: 'right', throttle: 0.6, brake: 0, steer: 0.2 },
	{ name: 'left', throttle: 0.6, brake: 0, steer: -0.2 },
];
let step = 0;
for (const phase of phases) {
	for (let i = 0; i < 150; i++, step++) {
		sim.step({ throttle: phase.throttle, brake: phase.brake, steer: phase.steer, handbrake: false });
		// Window of interest: steps 335-350 (flick happens ~340-347).
		if (step >= 335 && step <= 350) {
			const ct = chassis.getTransform();
			const cq = conj(ct.rotation);
			occupants.forEach((o) => {
				const f = o.restraintJoint ? Math.hypot(...Object.values(o.restraintJoint.getConstraintForce())) : NaN;
				const ratio = f / RESTRAINT_FORCE_THRESHOLD_N[o.seatKey];
				for (const key of PART_KEYS) {
					const part = o.parts[key];
					const contacts = part.shape.getContactData();
					const live = contacts.filter((c) => c.totalNormalImpulseSum > 0.5);
					if (live.length === 0) continue;
					const wp = part.body.getPosition();
					const lp = rot(cq, { x: wp.x - ct.position.x, y: wp.y - ct.position.y, z: wp.z - ct.position.z });
					for (const c of live) {
						console.log(
							`step=${step} seat=${o.seatKey} beltRatio=${ratio.toFixed(2)} part=${key} local=(${lp.x.toFixed(2)},${lp.y.toFixed(2)},${lp.z.toFixed(2)}) ids=${c.entityIdA}/${c.entityIdB} J=${c.totalNormalImpulseSum.toFixed(1)} n=(${c.normal.x.toFixed(2)},${c.normal.y.toFixed(2)},${c.normal.z.toFixed(2)})`,
						);
					}
				}
			});
		}
		occupants.forEach((o) => pollOccupantRestraint(o));
	}
}
for (const o of occupants) teardownOccupant(o);
for (const p of pans) teardownSeatPan(p);
sim.destroy();
