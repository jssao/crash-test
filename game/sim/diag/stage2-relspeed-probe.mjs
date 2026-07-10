// SPDX-License-Identifier: MIT
// Stage-2 diagnosis probe 6 (vite-node): pelvis-vs-chassis relative speed at the moment of belt
// force peaks, across the four regimes (mild driving / 30km/h bump / 70km/h wall / 55km/h yank) --
// picks the RESTRAINT_INSTANT_MIN_REL_SPEED_MS gate value. Browser-faithful loop (poll+active).
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
import { SEAT_KEYS, RESTRAINT_FORCE_THRESHOLD_N } from '../../src/world/features/occupants/tuning.ts';

function rig(sim) {
	const chassis = sim.vehicle.chassis;
	const t = chassis.getTransform();
	const out = { pans: [], occupants: [], runtimes: [] };
	SEAT_KEYS.forEach((seatKey, i) => {
		out.pans.push(createSeatPan(sim.world, chassis, seatKey, t.position, t.rotation));
		out.occupants.push(createOccupant(sim.world, chassis, i, seatKey, t.position, t.rotation));
		out.runtimes.push(createOccupantRuntime());
	});
	return out;
}
function stepAll(sim, r, input, tr) {
	sim.step(input);
	// Sample force/rel-speed BEFORE the poll (the poll may eject and null the joint on the peak step).
	if (tr) {
		tr.chassisVel = sim.vehicle.chassis.getLinearVelocity();
		tr.sample();
	}
	const ct = sim.vehicle.chassis.getTransform();
	const ctx = { chassisPos: ct.position, chassisRot: ct.rotation, chassisVel: sim.vehicle.chassis.getLinearVelocity(), world: sim.world };
	r.occupants.forEach((o, k) => {
		pollOccupantRestraint(o);
		updateOccupantActive(o, r.runtimes[k], 1 / 60, ctx);
	});
}
// per-seat trace: for each step, force ratio + rel speed; report the max ratio and the rel speed AT
// that step, plus the max relSpeed while ratio>0.8 (near-breach states).
function makeTracker(r) {
	const best = r.occupants.map(() => ({ ratio: 0, rel: 0, relAtHighForce: 0 }));
	return {
		sample() {
			const cv = { v: null };
			cv.v = null;
			const chassisVel = r.occupants[0] ? undefined : undefined;
			r.occupants.forEach((o, k) => {
				if (!o.restraintJoint) return;
				const f = Math.hypot(...Object.values(o.restraintJoint.getConstraintForce()));
				const ratio = f / RESTRAINT_FORCE_THRESHOLD_N[o.seatKey];
				const pv = o.parts.pelvis.body.getLinearVelocity();
				// chassis vel via the sim closure -- passed in below
				const ch = this.chassisVel;
				const rel = Math.hypot(pv.x - ch.x, pv.y - ch.y, pv.z - ch.z);
				if (ratio > best[k].ratio) {
					best[k].ratio = ratio;
					best[k].rel = rel;
				}
				if (ratio > 0.8) best[k].relAtHighForce = Math.max(best[k].relAtHighForce, rel);
			});
		},
		report(name) {
			r.occupants.forEach((o, k) => {
				console.log(
					`${name} seat=${o.seatKey} peakRatio=${best[k].ratio.toFixed(2)} relSpeedAtPeak=${best[k].rel.toFixed(2)}m/s maxRelWhileRatio>0.8=${best[k].relAtHighForce.toFixed(2)}m/s ejected=${o.ejected}`,
				);
			});
		},
		chassisVel: { x: 0, y: 0, z: 0 },
	};
}

// -- regime 1: mild driving --
{
	const sim = await createSim();
	const r = rig(sim);
	const tr = makeTracker(r);
	for (let i = 0; i < 30; i++) stepAll(sim, r, { throttle: 0, brake: 0, steer: 0, handbrake: false });
	for (const phase of [
		{ throttle: 1, brake: 0, steer: 0 },
		{ throttle: 0.6, brake: 0, steer: 0.2 },
		{ throttle: 0.6, brake: 0, steer: -0.2 },
		{ throttle: 0, brake: 0.5, steer: 0 },
	]) {
		for (let i = 0; i < 150; i++) stepAll(sim, r, { ...phase, handbrake: false }, tr);
	}
	tr.report('mild-driving');
	for (const o of r.occupants) teardownOccupant(o);
	for (const p of r.pans) teardownSeatPan(p);
	sim.destroy();
}
// -- regime 2/3: wall crashes --
for (const speed of [30, 70]) {
	const sim = await createSim();
	const r = rig(sim);
	const tr = makeTracker(r);
	for (let i = 0; i < 30; i++) stepAll(sim, r, { throttle: 0, brake: 0, steer: 0, handbrake: false });
	const wall = spawnTestWall(sim.world, sim.vehicle, speed === 30 ? 18 : 20);
	crashSetup(sim.vehicle, speed);
	const v = sim.vehicle.chassis.getLinearVelocity();
	r.occupants.forEach((o, k) => {
		matchOccupantVelocity(o, v);
		resetOccupantAccelBaseline(o, r.runtimes[k]);
	});
	for (const p of r.pans) matchSeatPanVelocity(p, v);
	for (let i = 0; i < 240; i++) stepAll(sim, r, { throttle: 0, brake: 0, steer: 0, handbrake: false }, tr);
	tr.report(`${speed}km/h-wall`);
	wall.destroy();
	for (const o of r.occupants) teardownOccupant(o);
	for (const p of r.pans) teardownSeatPan(p);
	sim.destroy();
}
// -- regime 4: 55km/h yank (flee/escalation model) --
{
	const sim = await createSim();
	const r = rig(sim);
	const tr = makeTracker(r);
	for (let i = 0; i < 31; i++) stepAll(sim, r, { throttle: 0, brake: 0, steer: 0, handbrake: false });
	crashSetup(sim.vehicle, 55);
	const v = sim.vehicle.chassis.getLinearVelocity();
	r.occupants.forEach((o, k) => {
		matchOccupantVelocity(o, v);
		resetOccupantAccelBaseline(o, r.runtimes[k]);
	});
	for (const p of r.pans) matchSeatPanVelocity(p, v);
	const zero = { x: 0, y: 0, z: 0 };
	sim.vehicle.chassis.setLinearVelocity(zero);
	for (const w of Object.values(sim.vehicle.wheels)) w.body.setLinearVelocity(zero);
	for (const pnl of Object.values(sim.vehicle.panels)) pnl.body.setLinearVelocity(zero);
	for (const p of r.pans) p.body.setLinearVelocity(zero);
	for (let i = 0; i < 240; i++) stepAll(sim, r, { throttle: 0, brake: 0, steer: 0, handbrake: false }, tr);
	tr.report('55km/h-yank');
	for (const o of r.occupants) teardownOccupant(o);
	for (const p of r.pans) teardownSeatPan(p);
	sim.destroy();
}
