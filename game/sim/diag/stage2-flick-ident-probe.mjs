// SPDX-License-Identifier: MIT
// Stage-2 diagnosis probe 4 (vite-node): same flick window as probe 2, but with the harness ground
// shape and each seat pan shape tagged with disambiguating userData (9000 = ground, 9001-9004 = pan
// per seat), so contact partners are unambiguous. Focus: the rear shin/torso arrest at steps 344-348.
import { createSim } from '../harness.mjs';
import {
	createOccupant,
	createSeatPan,
	pollOccupantRestraint,
	teardownOccupant,
	teardownSeatPan,
} from '../../src/world/features/occupants/physics.ts';
import { SEAT_KEYS, RESTRAINT_FORCE_THRESHOLD_N, PART_KEYS } from '../../src/world/features/occupants/tuning.ts';

const sim = await createSim();
const chassis = sim.vehicle.chassis;
const t0 = chassis.getTransform();
// Tag ground body (its shapes carry the body tag when they have none of their own... hit events do;
// contact data reports shape entity ids -- tag the BODY, and if that doesn't show, shapes need it).
sim.ground.setUserData(9000);
const pans = [];
const occupants = [];
SEAT_KEYS.forEach((seatKey, i) => {
	const pan = createSeatPan(sim.world, chassis, seatKey, t0.position, t0.rotation);
	pan.shape.setUserData(9001 + i);
	pans.push(pan);
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
		if (step >= 340 && step <= 350) {
			const cp = chassis.getPosition();
			occupants.forEach((o) => {
				if (o.seatKey !== 'rearLeft' && o.seatKey !== 'rearRight' && o.seatKey !== 'frontLeft') return;
				const f = o.restraintJoint ? Math.hypot(...Object.values(o.restraintJoint.getConstraintForce())) : NaN;
				const ratio = f / RESTRAINT_FORCE_THRESHOLD_N[o.seatKey];
				for (const key of PART_KEYS) {
					const part = o.parts[key];
					const live = part.shape.getContactData().filter((c) => c.totalNormalImpulseSum > 3);
					if (live.length === 0) continue;
					const wp = part.body.getPosition();
					for (const c of live) {
						console.log(
							`step=${step} seat=${o.seatKey} belt=${ratio.toFixed(2)} part=${key} world=(${wp.x.toFixed(2)},${wp.y.toFixed(2)},${wp.z.toFixed(2)}) carY=${cp.y.toFixed(2)} ids=${c.entityIdA}/${c.entityIdB} J=${c.totalNormalImpulseSum.toFixed(1)} n=(${c.normal.x.toFixed(2)},${c.normal.y.toFixed(2)},${c.normal.z.toFixed(2)})`,
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
