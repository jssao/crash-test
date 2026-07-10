// SPDX-License-Identifier: MIT
// Stage-2 diagnosis probe 3 (vite-node): 70km/h wall crash (features-occupants ejection scenario,
// browser-faithful loop) -- per-step belt-force ratio trace per seat, to measure how long crash
// loads SUSTAIN over threshold / over the instant factor, vs the 1-step contact spikes mild
// driving produces. Also 30km/h (escalation-2) for the no-eject band.
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

async function crashTrace(speedKmh, wallDist, steps) {
	const sim = await createSim();
	const chassis = sim.vehicle.chassis;
	const t = chassis.getTransform();
	const pans = [];
	const occupants = [];
	const runtimes = [];
	SEAT_KEYS.forEach((seatKey, i) => {
		pans.push(createSeatPan(sim.world, chassis, seatKey, t.position, t.rotation));
		occupants.push(createOccupant(sim.world, chassis, i, seatKey, t.position, t.rotation));
		runtimes.push(createOccupantRuntime());
	});
	const braceCtx = () => {
		const ct = chassis.getTransform();
		return { chassisPos: ct.position, chassisRot: ct.rotation, chassisVel: chassis.getLinearVelocity(), world: sim.world };
	};
	for (let i = 0; i < 30; i++) {
		sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		occupants.forEach((o, k) => {
			pollOccupantRestraint(o);
			updateOccupantActive(o, runtimes[k], 1 / 60, braceCtx());
		});
	}
	const wall = spawnTestWall(sim.world, sim.vehicle, wallDist);
	crashSetup(sim.vehicle, speedKmh);
	const v = chassis.getLinearVelocity();
	occupants.forEach((o, k) => {
		matchOccupantVelocity(o, v);
		resetOccupantAccelBaseline(o, runtimes[k]);
	});
	for (const p of pans) matchSeatPanVelocity(p, v);

	// Per seat: every step where ratio > 1, log runs; track consecutive-steps counters.
	const runs = occupants.map(() => []); // list of {startStep, ratios[]}
	const cur = occupants.map(() => null);
	const ejectedAt = occupants.map(() => -1);
	for (let step = 0; step < steps; step++) {
		sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		occupants.forEach((o, k) => {
			const f = o.restraintJoint ? Math.hypot(...Object.values(o.restraintJoint.getConstraintForce())) : NaN;
			const ratio = f / RESTRAINT_FORCE_THRESHOLD_N[o.seatKey];
			if (Number.isFinite(ratio) && ratio > 1) {
				if (!cur[k]) cur[k] = { startStep: step, ratios: [] };
				const pv = o.parts.pelvis.body.getLinearVelocity();
				const cv = chassis.getLinearVelocity();
				const rel = Math.hypot(pv.x - cv.x, pv.y - cv.y, pv.z - cv.z);
				cur[k].ratios.push(`${ratio.toFixed(2)}@rel${rel.toFixed(1)}`);
			} else if (cur[k]) {
				runs[k].push(cur[k]);
				cur[k] = null;
			}
			const before = o.ejected;
			pollOccupantRestraint(o);
			updateOccupantActive(o, runtimes[k], 1 / 60, braceCtx());
			if (!before && o.ejected) ejectedAt[k] = step;
		});
	}
	occupants.forEach((o, k) => {
		if (cur[k]) runs[k].push(cur[k]);
		const summary = runs[k]
			.map((r) => `@${r.startStep}x${r.ratios.length}[${r.ratios.slice(0, 10).join(',')}${r.ratios.length > 10 ? '...' : ''}]`)
			.join(' ');
		console.log(`${speedKmh}km/h seat=${o.seatKey} ejectedAtStep=${ejectedAt[k]} over-1x runs: ${summary || '(none)'}`);
	});
	wall.destroy();
	for (const o of occupants) teardownOccupant(o);
	for (const p of pans) teardownSeatPan(p);
	sim.destroy();
}

await crashTrace(70, 20, 180);
console.log('---');
await crashTrace(30, 18, 240);
