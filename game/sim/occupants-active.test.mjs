// SPDX-License-Identifier: MIT
//
// Headless tests for the ACTIVE occupant layer (game/src/world/features/occupants/active.ts): muscle
// bracing, the muscle-overwhelm gradient, life/death, glass-shatter-on-ejection, car-collision
// re-enable, and the self-preservation get-up/flee FSM. Imports physics.ts + active.ts DIRECTLY (skips
// the vite-only WorldFeature registry, same convention as features-occupants.test.mjs); no visuals /
// three / DOM, exactly the renderer-free code the browser feature drives.
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';
import { spawnTestWall, crashSetup } from '../src/damage/scenario.ts';
import {
	createOccupant,
	createSeatPan,
	matchOccupantVelocity,
	matchSeatPanVelocity,
	pollOccupantRestraint,
	teardownOccupant,
	teardownSeatPan,
} from '../src/world/features/occupants/physics.ts';
import { createOccupantRuntime, resetOccupantAccelBaseline, updateOccupantActive } from '../src/world/features/occupants/active.ts';
import { SEAT_KEYS } from '../src/world/features/occupants/tuning.ts';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };

function activeCtx(sim) {
	const t = sim.vehicle.chassis.getTransform();
	return { chassisPos: t.position, chassisRot: t.rotation, chassisVel: sim.vehicle.chassis.getLinearVelocity() };
}

/** Torso "up" alignment with the chassis: dot of the two bodies' world-up axes (1 = torso tracks the
 * chassis rigidly, less = the torso has tilted away from it). Same metric features-occupants.test.mjs
 * uses for its jostle measurement. */
function torsoUpDot(occupant, sim) {
	const up = (q) => {
		const { x, y, z, w } = q;
		return { x: 2 * (x * y - w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + w * x) };
	};
	const a = up(occupant.parts.torso.body.getRotation());
	const b = up(sim.vehicle.chassis.getRotation());
	return a.x * b.x + a.y * b.y + a.z * b.z;
}

function seatOne(sim, seatKey = 'frontLeft', seatIndex = 0) {
	const chassis = sim.vehicle.chassis;
	const t = chassis.getTransform();
	const pan = createSeatPan(sim.world, chassis, seatKey, t.position, t.rotation);
	const occupant = createOccupant(sim.world, chassis, seatIndex, seatKey, t.position, t.rotation);
	return { pan, occupant, runtime: createOccupantRuntime() };
}

function seatAll(sim) {
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
	return { pans, occupants, runtimes };
}

function allFinite(occupant) {
	for (const key of Object.keys(occupant.parts)) {
		const t = occupant.parts[key].body.getTransform();
		for (const v of [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w]) {
			if (!Number.isFinite(v)) return false;
		}
	}
	return true;
}

function minPartY(occupant) {
	let m = Infinity;
	for (const key of Object.keys(occupant.parts)) m = Math.min(m, occupant.parts[key].body.getPosition().y);
	return m;
}

function distXZ(a, b) {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Brings the car up to speed, then hard-brakes, returning the MEAN absolute torso misalignment from
 * the chassis (mean of 1 - torsoUpDot, i.e. how far the torso tips away from the upright/aligned pose a
 * rigid occupant would hold) over the braking window. A braced occupant holds near-aligned (small
 * deviation); a limp one sags/flops (large deviation). `useMuscle` toggles the active muscle layer. */
function accelerateThenBrake(sim, occupant, runtime, useMuscle) {
	for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
	for (let i = 0; i < 120; i++) {
		sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
		if (useMuscle) updateOccupantActive(occupant, runtime, 1 / 60, activeCtx(sim));
	}
	let sum = 0;
	const steps = 90;
	for (let i = 0; i < steps; i++) {
		sim.step({ throttle: 0, brake: 1, steer: 0, handbrake: false });
		if (useMuscle) updateOccupantActive(occupant, runtime, 1 / 60, activeCtx(sim));
		sum += 1 - torsoUpDot(occupant, sim);
	}
	return sum / steps;
}

describe('occupants-active: muscle bracing vs limp under hard braking', () => {
	it('a braced occupant deviates < 50% of a motors-off occupant under the same hard brake', async () => {
		const simLimp = await createSim();
		const simBraced = await createSim();
		try {
			const limp = seatOne(simLimp);
			const braced = seatOne(simBraced);
			const devLimp = accelerateThenBrake(simLimp, limp.occupant, limp.runtime, false);
			const devBraced = accelerateThenBrake(simBraced, braced.occupant, braced.runtime, true);
			console.log(`[brace] devLimp=${devLimp.toFixed(4)} devBraced=${devBraced.toFixed(4)} ratio=${(devBraced / devLimp).toFixed(3)}`);
			expect(allFinite(limp.occupant)).toBe(true);
			expect(allFinite(braced.occupant)).toBe(true);
			expect(devLimp).toBeGreaterThan(0.15); // the passive baseline genuinely sags/leans (non-vacuous)
			expect(devBraced).toBeLessThan(0.5 * devLimp);

			teardownOccupant(limp.occupant);
			teardownSeatPan(limp.pan);
			teardownOccupant(braced.occupant);
			teardownSeatPan(braced.pan);
		} finally {
			simLimp.destroy();
			simBraced.destroy();
		}
	});
});

/** Crash into a wall at `speedKmh`, returning the MEAN absolute torso misalignment from the chassis
 * (mean 1 - torsoUpDot) over the impact window -- same metric as the braking test. `useMuscle` toggles
 * the active layer. Returns { deviation, occupant, runtime, pan }. */
function crashTorsoDeviation(sim, seatKey, speedKmh, useMuscle) {
	const { pan, occupant, runtime } = seatOne(sim, seatKey, 0);
	for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
	const wall = spawnTestWall(sim.world, sim.vehicle, 18);
	crashSetup(sim.vehicle, speedKmh);
	const v = sim.vehicle.chassis.getLinearVelocity();
	matchOccupantVelocity(occupant, v);
	matchSeatPanVelocity(pan, v);
	resetOccupantAccelBaseline(occupant, runtime);
	let sum = 0;
	const steps = 150;
	for (let i = 0; i < steps; i++) {
		sim.step(NEUTRAL);
		pollOccupantRestraint(occupant);
		if (useMuscle) updateOccupantActive(occupant, runtime, 1 / 60, activeCtx(sim));
		sum += 1 - torsoUpDot(occupant, sim);
	}
	wall.destroy();
	return { deviation: sum / steps, occupant, runtime, pan };
}

describe('occupants-active: muscles are overwhelmed by a violent crash', () => {
	it('a 140km/h crash drives braced torso deviation close to the motors-off level (muscle lost)', async () => {
		const simLimp = await createSim();
		const simBraced = await createSim();
		try {
			const limp = crashTorsoDeviation(simLimp, 'frontLeft', 140, false);
			const braced = crashTorsoDeviation(simBraced, 'frontLeft', 140, true);
			console.log(`[overwhelm] devLimp=${limp.deviation.toFixed(4)} devBraced=${braced.deviation.toFixed(4)} ratio=${(braced.deviation / limp.deviation).toFixed(3)} peakG(braced)=${braced.runtime.peakAccelG.toFixed(0)}`);
			expect(limp.deviation).toBeGreaterThan(0.3); // a 140km/h hit genuinely throws the torso far
			// Overwhelmed: the muscle can no longer meaningfully hold -- braced deviation approaches limp
			// (contrast the braking test, where braced is < 50% of limp).
			expect(braced.deviation).toBeGreaterThan(0.6 * limp.deviation);

			teardownOccupant(limp.occupant);
			teardownSeatPan(limp.pan);
			teardownOccupant(braced.occupant);
			teardownSeatPan(braced.pan);
		} finally {
			simLimp.destroy();
			simBraced.destroy();
		}
	});
});

describe('occupants-active: ejection shatters glass, clears the car AABB, lands on the ground', () => {
	it('a 70km/h frontal crash ejects occupants who shatter the windshield, re-enable car collision, and settle on the ground without tunnelling', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
			const wall = spawnTestWall(sim.world, sim.vehicle, 22);
			crashSetup(sim.vehicle, 70);
			const v = sim.vehicle.chassis.getLinearVelocity();
			rig.occupants.forEach((o, i) => {
				matchOccupantVelocity(o, v);
				resetOccupantAccelBaseline(o, rig.runtimes[i]);
			});
			for (const p of rig.pans) matchSeatPanVelocity(p, v);

			let sawNaN = false;
			let minYAfterEject = Infinity;
			for (let step = 0; step < 600; step++) {
				sim.step(NEUTRAL);
				const ctx = activeCtx(sim);
				rig.occupants.forEach((o, i) => {
					pollOccupantRestraint(o);
					updateOccupantActive(o, rig.runtimes[i], 1 / 60, ctx);
					if (!allFinite(o)) sawNaN = true;
					if (o.ejected && step > 120) minYAfterEject = Math.min(minYAfterEject, minPartY(o));
				});
			}

			const ejected = rig.occupants.filter((o) => o.ejected);
			const anyWindshield = rig.runtimes.some((r) => r.shatteredGlass.has('BodyWindshield'));
			const anyCarCollisionReEnabled = rig.runtimes.some((r) => r.carCollisionEnabled);
			// Filter state readback: a re-enabled occupant's shapes must be back on the neutral group 0.
			const reEnabledIdx = rig.runtimes.findIndex((r) => r.carCollisionEnabled);
			const filterGroup = reEnabledIdx >= 0 ? rig.occupants[reEnabledIdx].parts.pelvis.shape.getFilter().groupIndex : null;
			console.log(
				`[ejection-active] ejected=${ejected.length} anyWindshield=${anyWindshield} carCollisionReEnabled=${anyCarCollisionReEnabled} filterGroup=${filterGroup} minPartYAfterEject=${minYAfterEject.toFixed(3)}`,
			);

			expect(sawNaN).toBe(false);
			expect(ejected.length).toBeGreaterThanOrEqual(2);
			expect(anyWindshield).toBe(true); // glass shattered on windshield crossing
			expect(anyCarCollisionReEnabled).toBe(true); // whole body cleared the hull AABB
			expect(filterGroup).toBe(0); // occupant<->car collision genuinely re-enabled
			expect(minYAfterEject).toBeGreaterThan(-0.25); // collided with ground, never tunnelled through it

			wall.destroy();
			for (const o of rig.occupants) teardownOccupant(o);
			for (const p of rig.pans) teardownSeatPan(p);
		} finally {
			sim.destroy();
		}
	});
});

describe('occupants-active: a survivor gets up and flees the wreck', () => {
	it('an alive ejected occupant reaches >=10m from the car and ends standing within 30s', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			for (let i = 0; i < 30; i++) sim.step(NEUTRAL);

			// Model a crash WITHOUT a wall: bring the car up to speed, then abruptly stop the car body
			// (as if it hit something offscreen) while the occupants keep their velocity -- the restraint
			// YIELDS (breaks) rather than fully decelerating them, so they eject into open space and
			// survive (no wall to fly into). This isolates the get-up/flee FSM.
			crashSetup(sim.vehicle, 55);
			const v = sim.vehicle.chassis.getLinearVelocity();
			rig.occupants.forEach((o, i) => {
				matchOccupantVelocity(o, v);
				resetOccupantAccelBaseline(o, rig.runtimes[i]);
			});
			for (const p of rig.pans) matchSeatPanVelocity(p, v);
			const zero = { x: 0, y: 0, z: 0 };
			sim.vehicle.chassis.setLinearVelocity(zero);
			for (const w of Object.values(sim.vehicle.wheels)) w.body.setLinearVelocity(zero);
			for (const pnl of Object.values(sim.vehicle.panels)) pnl.body.setLinearVelocity(zero);
			for (const p of rig.pans) p.body.setLinearVelocity(zero);

			let sawNaN = false;
			for (let step = 0; step < 1800; step++) {
				// 30s @ 60Hz
				sim.step(NEUTRAL);
				const ctx = activeCtx(sim);
				rig.occupants.forEach((o, i) => {
					pollOccupantRestraint(o);
					updateOccupantActive(o, rig.runtimes[i], 1 / 60, ctx);
					if (!allFinite(o)) sawNaN = true;
				});
			}

			const carPos = sim.vehicle.chassis.getPosition();
			const report = rig.occupants.map((o, i) => ({
				seat: o.seatKey,
				alive: rig.runtimes[i].alive,
				state: rig.runtimes[i].state,
				ejected: o.ejected,
				dist: distXZ(o.parts.pelvis.body.getPosition(), carPos).toFixed(1),
				head: o.parts.head.body.getPosition().y.toFixed(2),
			}));
			console.log('[flee]', JSON.stringify(report));

			expect(sawNaN).toBe(false);
			// At least one alive, ejected occupant fled >=10m and ended standing (head clearly up).
			const fled = rig.occupants.some((o, i) => {
				const r = rig.runtimes[i];
				return r.alive && o.ejected && distXZ(o.parts.pelvis.body.getPosition(), carPos) >= 10 && o.parts.head.body.getPosition().y > 1.2;
			});
			expect(fled).toBe(true);

			for (const o of rig.occupants) teardownOccupant(o);
			for (const p of rig.pans) teardownSeatPan(p);
		} finally {
			sim.destroy();
		}
	});
});

describe('occupants-active: the dead stay limp', () => {
	it('a lethally high-g crash kills an occupant, who then never braces, gets up, or flees', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
			const wall = spawnTestWall(sim.world, sim.vehicle, 16);
			crashSetup(sim.vehicle, 150);
			const v = sim.vehicle.chassis.getLinearVelocity();
			rig.occupants.forEach((o, i) => {
				matchOccupantVelocity(o, v);
				resetOccupantAccelBaseline(o, rig.runtimes[i]);
			});
			for (const p of rig.pans) matchSeatPanVelocity(p, v);

			let everRecovered = false;
			for (let step = 0; step < 1200; step++) {
				sim.step(NEUTRAL);
				const ctx = activeCtx(sim);
				rig.occupants.forEach((o, i) => {
					pollOccupantRestraint(o);
					updateOccupantActive(o, rig.runtimes[i], 1 / 60, ctx);
					const st = rig.runtimes[i].state;
					if (!rig.runtimes[i].alive && (st === 'recover' || st === 'flee' || st === 'safe')) everRecovered = true;
				});
			}

			const dead = rig.occupants.filter((o, i) => !rig.runtimes[i].alive);
			console.log(`[dead] deadCount=${dead.length} states=${JSON.stringify(rig.runtimes.map((r) => ({ alive: r.alive, state: r.state, peakG: r.peakAccelG.toFixed(0) })))}`);
			expect(dead.length).toBeGreaterThanOrEqual(1); // the crash was lethal for someone
			for (let i = 0; i < rig.occupants.length; i++) {
				if (!rig.runtimes[i].alive) {
					expect(rig.runtimes[i].state).toBe('dead'); // pure limp, no FSM progress
					expect(rig.occupants[i].parts.head.body.getPosition().y).toBeLessThan(1.0); // never stood up
				}
			}
			expect(everRecovered).toBe(false);

			wall.destroy();
			for (const o of rig.occupants) teardownOccupant(o);
			for (const p of rig.pans) teardownSeatPan(p);
		} finally {
			sim.destroy();
		}
	});
});
