// SPDX-License-Identifier: MIT
// Stage-2 diagnosis probe 9 (vite-node): jostle-test repro -- 4 occupants, full throttle -- is the
// car pinned by feet pinched between the footwell shelf and the static ground?
import { createSim } from '../harness.mjs';
import { createOccupant, createSeatPan, teardownOccupant, teardownSeatPan } from '../../src/world/features/occupants/physics.ts';
import { SEAT_KEYS, PART_KEYS } from '../../src/world/features/occupants/tuning.ts';

const sim = await createSim();
sim.ground.setUserData(9000);
const chassis = sim.vehicle.chassis;
const t0 = chassis.getTransform();
const pans = [];
const occupants = [];
SEAT_KEYS.forEach((seatKey, i) => {
	const pan = createSeatPan(sim.world, chassis, seatKey, t0.position, t0.rotation);
	pan.shape.setUserData(9001 + i);
	pans.push(pan);
	occupants.push(createOccupant(sim.world, chassis, i, seatKey, t0.position, t0.rotation));
});
for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
console.log('carY after settle:', chassis.getPosition().y.toFixed(3));
for (let i = 0; i < 120; i++) {
	sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
	if (i % 30 === 29) {
		const v = chassis.getLinearVelocity();
		const w = sim.vehicle.wheels.rl.body.getAngularVelocity();
		console.log(`t=${((i + 1) / 60).toFixed(1)}s speed=${Math.hypot(v.x, v.z).toFixed(2)} carY=${chassis.getPosition().y.toFixed(3)} chassisAwake=${chassis.isAwake()} rlWheelAwake=${sim.vehicle.wheels.rl.body.isAwake()} rlSpin=${Math.hypot(w.x, w.y, w.z).toFixed(1)} pelvis0Awake=${occupants[0].parts.pelvis.body.isAwake()}`);
		occupants.forEach((o) => {
			for (const p of PART_KEYS) {
				const live = o.parts[p].shape.getContactData().filter((c) => c.totalNormalImpulseSum > 1);
				for (const c of live) {
					const who = c.entityIdA === 9000 || c.entityIdB === 9000 ? 'GROUND' : c.entityIdA >= 9001 || (c.entityIdB >= 9001 && c.entityIdB <= 9004) ? 'pan' : 'car';
					if (who === 'GROUND') console.log(`   GROUND contact seat=${o.seatKey} part=${p} J=${c.totalNormalImpulseSum.toFixed(1)}`);
				}
			}
		});
	}
}
for (const o of occupants) teardownOccupant(o);
for (const p of pans) teardownSeatPan(p);
sim.destroy();
