// SPDX-License-Identifier: MIT
// Stage-2 diagnosis probe (vite-node): replicates sim/features-occupants.test.mjs seated-stability
// (mild varied driving, poll-only, NO active brace layer) and traces per-seat restraint force each
// step -- which seats eject, when, via which path (instant vs sustained), and the force history
// around the breach.
import { createSim } from '../harness.mjs';
import {
	createOccupant,
	createSeatPan,
	pollOccupantRestraint,
	teardownOccupant,
	teardownSeatPan,
} from '../../src/world/features/occupants/physics.ts';
import { SEAT_KEYS, RESTRAINT_FORCE_THRESHOLD_N, RESTRAINT_BREAK_MIN_CHASSIS_ACCEL_G } from '../../src/world/features/occupants/tuning.ts';

const sim = await createSim();
const chassis = sim.vehicle.chassis;
const t = chassis.getTransform();
const pans = [];
const occupants = [];
SEAT_KEYS.forEach((seatKey, i) => {
	pans.push(createSeatPan(sim.world, chassis, seatKey, t.position, t.rotation));
	occupants.push(createOccupant(sim.world, chassis, i, seatKey, t.position, t.rotation));
});

for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

const phases = [
	{ name: 'launch', throttle: 1, brake: 0, steer: 0 },
	{ name: 'right', throttle: 0.6, brake: 0, steer: 0.2 },
	{ name: 'left', throttle: 0.6, brake: 0, steer: -0.2 },
	{ name: 'brake', throttle: 0, brake: 0.5, steer: 0 },
];
const hist = occupants.map(() => []); // per-seat recent force ring
const peaks = occupants.map(() => ({ f: 0, phase: '', step: 0 }));
let step = 0;
for (const phase of phases) {
	for (let i = 0; i < 150; i++, step++) {
		sim.step({ throttle: phase.throttle, brake: phase.brake, steer: phase.steer, handbrake: false });
		occupants.forEach((o, k) => {
			const before = o.ejected;
			const f = o.restraintJoint ? Math.hypot(...Object.values(o.restraintJoint.getConstraintForce())) : NaN;
			const ratio = f / RESTRAINT_FORCE_THRESHOLD_N[o.seatKey];
			hist[k].push(ratio);
			if (ratio > peaks[k].f) peaks[k] = { f: ratio, phase: phase.name, step };
			pollOccupantRestraint(o);
			if (!before && o.ejected) {
				const tail = hist[k].slice(-12).map((r) => r.toFixed(2)).join(',');
				console.log(
					`EJECT seat=${o.seatKey} phase=${phase.name} phaseStep=${i} step=${step} ratioAtBreak=${ratio.toFixed(2)} (crashGate>=${RESTRAINT_BREAK_MIN_CHASSIS_ACCEL_G}g) last12ratios=[${tail}]`,
				);
			}
		});
	}
	console.log(
		`phase=${phase.name} done; peaks so far: ${occupants.map((o, k) => `${o.seatKey}=${peaks[k].f.toFixed(2)}@${peaks[k].phase}`).join(' ')}`,
	);
}
console.log('FINAL ejected:', occupants.filter((o) => o.ejected).map((o) => o.seatKey));
console.log('FINAL peaks:', occupants.map((o, k) => `${o.seatKey}: ${peaks[k].f.toFixed(2)}x @${peaks[k].phase} step ${peaks[k].step}`));
for (const o of occupants) teardownOccupant(o);
for (const p of pans) teardownSeatPan(p);
sim.destroy();
