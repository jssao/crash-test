// SPDX-License-Identifier: MIT
// DIAGNOSTIC repro harness for the 4 user-playtest occupant defects (not part of the shipping
// suite -- lives in sim/diag/, run explicitly). Measures, does not assert acceptance yet.
import { describe, expect, it } from 'vitest';
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
import { SEAT_KEYS } from '../../src/world/features/occupants/tuning.ts';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };

function activeCtx(sim) {
	const t = sim.vehicle.chassis.getTransform();
	return { chassisPos: t.position, chassisRot: t.rotation, chassisVel: sim.vehicle.chassis.getLinearVelocity(), world: sim.world };
}

function seatAll(sim) {
	const chassis = sim.vehicle.chassis;
	const t = chassis.getTransform();
	const pans = [], occupants = [], runtimes = [];
	SEAT_KEYS.forEach((seatKey, i) => {
		pans.push(createSeatPan(sim.world, chassis, seatKey, t.position, t.rotation));
		occupants.push(createOccupant(sim.world, chassis, i, seatKey, t.position, t.rotation));
		runtimes.push(createOccupantRuntime());
	});
	return { pans, occupants, runtimes };
}

function teardownAll(rig) {
	for (const o of rig.occupants) teardownOccupant(o);
	for (const p of rig.pans) teardownSeatPan(p);
}

describe('DIAG 1: seated jitter at idle + gentle driving', () => {
	it('measures head/torso angular velocity RMS at idle (muscles ON, browser-style loop)', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			// settle 2s with the active layer running (exactly like the browser afterFixedStep loop)
			for (let i = 0; i < 120; i++) {
				sim.step(NEUTRAL);
				const ctx = activeCtx(sim);
				rig.occupants.forEach((o, k) => {
					pollOccupantRestraint(o);
					updateOccupantActive(o, rig.runtimes[k], 1 / 60, ctx);
				});
			}
			// record 5s idle
			let sumSq = { head: 0, torso: 0 }, n = 0;
			let maxW = 0;
			for (let i = 0; i < 300; i++) {
				sim.step(NEUTRAL);
				const ctx = activeCtx(sim);
				rig.occupants.forEach((o, k) => {
					pollOccupantRestraint(o);
					updateOccupantActive(o, rig.runtimes[k], 1 / 60, ctx);
					const wh = o.parts.head.body.getAngularVelocity();
					const wt = o.parts.torso.body.getAngularVelocity();
					const mh = Math.hypot(wh.x, wh.y, wh.z);
					const mt = Math.hypot(wt.x, wt.y, wt.z);
					sumSq.head += mh * mh;
					sumSq.torso += mt * mt;
					maxW = Math.max(maxW, mh, mt);
					n++;
				});
			}
			const rmsHead = Math.sqrt(sumSq.head / n);
			const rmsTorso = Math.sqrt(sumSq.torso / n);
			console.log(`[diag-jitter] idle rmsHead=${rmsHead.toFixed(4)} rmsTorso=${rmsTorso.toFixed(4)} max=${maxW.toFixed(3)} rad/s`);
			expect(true).toBe(true);
			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});

describe('DIAG 2: restraint force at 30km/h bump vs 70km/h crash', () => {
	async function forceTrace(speedKmh) {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
			const wall = spawnTestWall(sim.world, sim.vehicle, 18);
			crashSetup(sim.vehicle, speedKmh);
			const v = sim.vehicle.chassis.getLinearVelocity();
			rig.occupants.forEach((o, i) => { matchOccupantVelocity(o, v); resetOccupantAccelBaseline(o, rig.runtimes[i]); });
			for (const p of rig.pans) matchSeatPanVelocity(p, v);
			const maxForce = [0, 0, 0, 0];
			const overSteps = [0, 0, 0, 0]; // consecutive-step-over-threshold max run length
			const run = [0, 0, 0, 0];
			for (let step = 0; step < 300; step++) {
				sim.step(NEUTRAL);
				const ctx = activeCtx(sim);
				rig.occupants.forEach((o, i) => {
					if (o.restraintJoint) {
						const f = o.restraintJoint.getConstraintForce();
						const m = Math.hypot(f.x, f.y, f.z);
						maxForce[i] = Math.max(maxForce[i], m);
						if (m > o.restraintThresholdN) { run[i]++; overSteps[i] = Math.max(overSteps[i], run[i]); } else run[i] = 0;
					}
					pollOccupantRestraint(o);
					updateOccupantActive(o, rig.runtimes[i], 1 / 60, ctx);
				});
			}
			const ejected = rig.occupants.map((o) => o.ejected);
			console.log(`[diag-eject ${speedKmh}km/h] maxForce=${maxForce.map((f) => f.toFixed(0))} thresholds=${rig.occupants.map((o) => o.restraintThresholdN)} maxOverRun=${overSteps} ejected=${ejected}`);
			wall.destroy();
			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	}
	it('traces 30km/h', async () => { await forceTrace(30); expect(true).toBe(true); });
	it('traces 70km/h', async () => { await forceTrace(70); expect(true).toBe(true); });
});

describe('DIAG 4: spawn/reset settle-drop restraint spike (browser-style: active layer from step 0)', () => {
	it('measures restraint force during the first 60 steps after (re)seat', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			const maxForce = [0, 0, 0, 0];
			const ejectedAt = [-1, -1, -1, -1];
			for (let step = 0; step < 120; step++) {
				sim.step(NEUTRAL);
				const ctx = activeCtx(sim);
				rig.occupants.forEach((o, i) => {
					if (o.restraintJoint) {
						const f = o.restraintJoint.getConstraintForce();
						maxForce[i] = Math.max(maxForce[i], Math.hypot(f.x, f.y, f.z));
					}
					if (pollOccupantRestraint(o) && ejectedAt[i] < 0) ejectedAt[i] = step;
					updateOccupantActive(o, rig.runtimes[i], 1 / 60, ctx);
				});
			}
			console.log(`[diag-reset] maxForceFirst120=${maxForce.map((f) => f.toFixed(0))} ejectedAtStep=${ejectedAt}`);
			expect(true).toBe(true);
			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});

describe('DIAG 3: recover/flee on NON-ZERO ground height (terrain proxy platform)', () => {
	it('ejects an occupant onto a raised platform (top y=+1.2) and reports FSM + hover heights', async () => {
		const sim = await createSim();
		try {
			// Big raised platform ahead+left of the car where an ejected occupant will land.
			const plat = sim.world.createBody({ position: { x: 0, y: 0.6, z: 30 } });
			plat.createBoxShape({ halfExtents: { x: 40, y: 0.6, z: 40 }, friction: 0.8 });

			const rig = seatAll(sim);
			for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
			crashSetup(sim.vehicle, 55);
			const v = sim.vehicle.chassis.getLinearVelocity();
			rig.occupants.forEach((o, i) => { matchOccupantVelocity(o, v); resetOccupantAccelBaseline(o, rig.runtimes[i]); });
			for (const p of rig.pans) matchSeatPanVelocity(p, v);
			const zero = { x: 0, y: 0, z: 0 };
			sim.vehicle.chassis.setLinearVelocity(zero);
			for (const w of Object.values(sim.vehicle.wheels)) w.body.setLinearVelocity(zero);
			for (const pnl of Object.values(sim.vehicle.panels)) pnl.body.setLinearVelocity(zero);
			for (const p of rig.pans) p.body.setLinearVelocity(zero);

			for (let step = 0; step < 1800; step++) {
				sim.step(NEUTRAL);
				const ctx = activeCtx(sim);
				rig.occupants.forEach((o, i) => {
					pollOccupantRestraint(o);
					updateOccupantActive(o, rig.runtimes[i], 1 / 60, ctx);
				});
			}
			const report = rig.occupants.map((o, i) => ({
				seat: o.seatKey,
				state: rig.runtimes[i].state,
				ejected: o.ejected,
				pelvisY: o.parts.pelvis.body.getPosition().y.toFixed(2),
				pelvisZ: o.parts.pelvis.body.getPosition().z.toFixed(1),
				headY: o.parts.head.body.getPosition().y.toFixed(2),
			}));
			console.log('[diag-terrain]', JSON.stringify(report));
			expect(true).toBe(true);
			teardownAll(rig);
			plat.destroy();
		} finally {
			sim.destroy();
		}
	});
});
