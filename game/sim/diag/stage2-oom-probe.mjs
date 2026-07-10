// Stage-2 diagnosis: heap growth during the occupants-active ejection scenario.
import { createSim } from '../harness.mjs';
import { spawnTestWall, crashSetup } from '../../src/damage/scenario.ts';
import { createDamageSystem, stepDamageSystem } from '../../src/damage/system.ts';
import {
	createOccupant, createSeatPan, matchOccupantVelocity, matchSeatPanVelocity,
	pollOccupantRestraint, teardownOccupant, teardownSeatPan,
} from '../../src/world/features/occupants/physics.ts';
import { createOccupantRuntime, resetOccupantAccelBaseline, updateOccupantActive } from '../../src/world/features/occupants/active.ts';
import { SEAT_KEYS } from '../../src/world/features/occupants/tuning.ts';

const sim = await createSim();
const chassis = sim.vehicle.chassis;
const t0 = chassis.getTransform();
const pans = [], occupants = [], runtimes = [];
SEAT_KEYS.forEach((seatKey, i) => {
	pans.push(createSeatPan(sim.world, chassis, seatKey, t0.position, t0.rotation));
	occupants.push(createOccupant(sim.world, chassis, i, seatKey, t0.position, t0.rotation));
	runtimes.push(createOccupantRuntime());
});
const damage = createDamageSystem(sim.vehicle);
const ctx = () => {
	const t = chassis.getTransform();
	return { chassisPos: t.position, chassisRot: t.rotation, chassisVel: chassis.getLinearVelocity(), world: sim.world };
};
const stepAll = () => {
	sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
	stepDamageSystem(damage, sim.world, 1 / 60);
	occupants.forEach((o, k) => { pollOccupantRestraint(o); updateOccupantActive(o, runtimes[k], 1 / 60, ctx()); });
};
for (let i = 0; i < 60; i++) stepAll();
const wall = spawnTestWall(sim.world, sim.vehicle, 20);
crashSetup(sim.vehicle, 70);
const v = chassis.getLinearVelocity();
occupants.forEach((o, k) => { matchOccupantVelocity(o, v); resetOccupantAccelBaseline(o, runtimes[k]); });
for (const p of pans) matchSeatPanVelocity(p, v);
for (let step = 0; step < 600; step++) {
	stepAll();
	if (step % 60 === 0) {
		const m = process.memoryUsage();
		console.log(`step=${step} heap=${(m.heapUsed / 1e6).toFixed(0)}MB ext=${(m.external / 1e6).toFixed(0)}MB hist=${damage.emitter.history?.length ?? 'n/a'} meshes=${damage.registry.meshes.length}`);
	}
}
console.log('pane:', sim.vehicle.glass.windshield.shape === null ? 'destroyed' : 'ALIVE', 'ejected:', occupants.filter((o) => o.ejected).map((o) => o.seatKey).join(','), 'hist:', JSON.stringify(damage.emitter.history?.map((e) => e.type)));
console.log('done');
wall.destroy();
for (const o of occupants) teardownOccupant(o);
for (const p of pans) teardownSeatPan(p);
sim.destroy();
