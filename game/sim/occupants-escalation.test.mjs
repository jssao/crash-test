// SPDX-License-Identifier: MIT
//
// ESCALATION acceptance tests for the 4 USER-PLAYTEST occupant defects (2026-07-09 playtest wave):
//   1. TWITCHY seated occupants  -> idle head/torso angular-velocity RMS < 0.05 rad/s (was 24 rad/s:
//      the per-step PD muscles diverged at 60Hz on the light bodies; seated bracing now rides the
//      joint solver's own springs, gain-scheduled on chassis g -- see active.ts/tuning.ts).
//   2. INSTANT PHASE-OUT on mild impacts -> a 30km/h wall bump ejects NOBODY (was: both rear
//      occupants, from single-step solver force spikes 1.03x their threshold; ejection now needs a
//      3-step sustained breach or a 1.3x instant-break overload -- measured bands in tuning.ts).
//   3. FLOATY KNEEL-STAND -> the whole get-up/flee scenario run on ELEVATED ground (terrain proxy)
//      finishes with survivors standing feet-on-ground at the measured ground height, not hovering
//      at the old absolute-Y stand height (recovery heights are now ground-raycast-relative).
//   4. Shift+R WORLD RESET phase-out -> a browser-faithful double reset (doCarRepair + the second
//      reset('world') rebuild, exactly main.ts's doWorldRepair order) from EVERY FSM state leaves
//      all 4 occupants seated + alive + restrained + car-filtered + physically in the cabin.
//
// Browser-faithful loop convention: pollOccupantRestraint() + updateOccupantActive() run every fixed
// step from creation, exactly like index.ts's afterFixedStep (including during settle).
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';
import { spawnTestWall, crashSetup } from '../src/damage/scenario.ts';
import { BodyType } from '../../src/ts/index.ts';
import { createVehicle, destroyVehicle } from '../src/vehicle/vehicle.ts';
import { CAR_GROUP_INDEX, CHASSIS_ORIGIN_HEIGHT_M } from '../src/vehicle/tuning.ts';
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
	return { chassisPos: t.position, chassisRot: t.rotation, chassisVel: sim.vehicle.chassis.getLinearVelocity(), world: sim.world };
}

function seatAll(sim) {
	const chassis = sim.vehicle.chassis;
	const t = chassis.getTransform();
	const rig = { pans: [], occupants: [], runtimes: [] };
	SEAT_KEYS.forEach((seatKey, i) => {
		rig.pans.push(createSeatPan(sim.world, chassis, seatKey, t.position, t.rotation));
		rig.occupants.push(createOccupant(sim.world, chassis, i, seatKey, t.position, t.rotation));
		rig.runtimes.push(createOccupantRuntime());
	});
	return rig;
}

function teardownAll(rig) {
	for (const o of rig.occupants) teardownOccupant(o);
	for (const p of rig.pans) teardownSeatPan(p);
}

/** One browser-faithful fixed step: physics, then per occupant poll + active update. */
function stepAll(sim, rig, input = NEUTRAL) {
	sim.step(input);
	const ctx = activeCtx(sim);
	rig.occupants.forEach((o, i) => {
		pollOccupantRestraint(o);
		updateOccupantActive(o, rig.runtimes[i], 1 / 60, ctx);
	});
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

// -- Defect 1: seated stillness ---------------------------------------------------------------------

describe('escalation 1: seated occupants are visually still', () => {
	it('idle head/torso angular-velocity RMS < 0.05 rad/s over 5s; gentle driving stays calm too', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			for (let i = 0; i < 180; i++) stepAll(sim, rig); // 3s settle

			// Two metrics per window: RMS chassis-relative angular speed ("sway" -- riding WITH the car
			// counts as still), and RMS STEP-TO-STEP angular-velocity change ("chatter" -- the actual
			// twitch signature: the pre-fix limit cycle sign-flipped at 60Hz, giving delta-RMS in the
			// tens of rad/s, while smooth passenger sway changes velocity only ~A*2*pi*f*dt per step).
			const measure = (steps, input) => {
				let sumSq = 0;
				let deltaSq = 0;
				let n = 0;
				const prev = new Map();
				for (let i = 0; i < steps; i++) {
					stepAll(sim, rig, input);
					const wc = sim.vehicle.chassis.getAngularVelocity();
					for (const o of rig.occupants) {
						for (const part of ['head', 'torso']) {
							const w = o.parts[part].body.getAngularVelocity();
							const m = Math.hypot(w.x - wc.x, w.y - wc.y, w.z - wc.z);
							sumSq += m * m;
							const key = `${o.seatKey}:${part}`;
							const pw = prev.get(key);
							if (pw) deltaSq += (w.x - pw.x) ** 2 + (w.y - pw.y) ** 2 + (w.z - pw.z) ** 2;
							prev.set(key, w);
							n++;
						}
					}
				}
				return { rms: Math.sqrt(sumSq / n), deltaRms: Math.sqrt(deltaSq / n) };
			};

			const idle = measure(300, NEUTRAL); // 5s @ 60Hz
			// gentle driving: light cruise throttle (chassis g stays under the brace-up band)
			const gentle = measure(300, { throttle: 0.3, brake: 0, steer: 0.05, handbrake: false });
			console.log(`[still] idleRMS=${idle.rms.toFixed(4)} idleDelta=${idle.deltaRms.toFixed(4)} gentleRMS=${gentle.rms.toFixed(4)} gentleDelta=${gentle.deltaRms.toFixed(4)} rad/s`);

			expect(idle.rms).toBeLessThan(0.05); // the user-visible acceptance bar (was 24 rad/s pre-fix)
			expect(idle.deltaRms).toBeLessThan(0.05);
			expect(gentle.rms).toBeLessThan(0.5); // gentle low-frequency passenger sway allowed...
			expect(gentle.deltaRms).toBeLessThan(0.15); // ...60Hz chatter not (pre-fix: tens of rad/s)
			for (const o of rig.occupants) expect(o.ejected).toBe(false);

			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});

// -- Defect 2: mild impacts eject nobody -------------------------------------------------------------

describe('escalation 2: a 30km/h bump ejects nobody', () => {
	it('30km/h frontal wall bump: zero ejections, all alive, all belts intact, everyone stays seated', async () => {
		const sim = await createSim();
		try {
			const rig = seatAll(sim);
			for (let i = 0; i < 60; i++) stepAll(sim, rig);
			const wall = spawnTestWall(sim.world, sim.vehicle, 18);
			crashSetup(sim.vehicle, 30);
			const v = sim.vehicle.chassis.getLinearVelocity();
			rig.occupants.forEach((o, i) => {
				matchOccupantVelocity(o, v);
				resetOccupantAccelBaseline(o, rig.runtimes[i]);
			});
			for (const p of rig.pans) matchSeatPanVelocity(p, v);

			for (let i = 0; i < 360; i++) stepAll(sim, rig); // impact + 5s aftermath

			const report = rig.occupants.map((o, i) => ({ seat: o.seatKey, ejected: o.ejected, alive: rig.runtimes[i].alive, state: rig.runtimes[i].state }));
			console.log('[mild-bump]', JSON.stringify(report));
			for (let i = 0; i < rig.occupants.length; i++) {
				expect(rig.occupants[i].ejected).toBe(false);
				expect(rig.occupants[i].restraintJoint).not.toBeNull();
				expect(rig.runtimes[i].alive).toBe(true);
				expect(rig.runtimes[i].state).toBe('seated');
				expect(allFinite(rig.occupants[i])).toBe(true);
			}

			wall.destroy();
			teardownAll(rig);
		} finally {
			sim.destroy();
		}
	});
});

// -- Defect 3: recovery is grounded (terrain-proxy elevated world) -----------------------------------

describe('escalation 3: get-up/flee stands feet-on-ground on non-zero terrain height', () => {
	it('the whole crash->flee scenario on ground at y=+1.2 ends with survivors standing AT that height', async () => {
		const PLATFORM_TOP_Y = 1.2;
		// Spawn the car on top of an elevated slab covering the whole play area -- the terrain proxy.
		const sim = await createSim({ x: 0, y: CHASSIS_ORIGIN_HEIGHT_M + PLATFORM_TOP_Y, z: 0 });
		try {
			const slab = sim.world.createBody({ type: BodyType.Static, position: { x: 0, y: PLATFORM_TOP_Y - 0.5, z: 0 } });
			const slabShape = slab.createBoxShape({ halfExtents: { x: 150, y: 0.5, z: 150 }, friction: 0.8 });

			const rig = seatAll(sim);
			for (let i = 0; i < 30; i++) stepAll(sim, rig);

			// Same wall-less crash model as the flee test: car abruptly stops, occupants keep velocity.
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
				stepAll(sim, rig);
				for (const o of rig.occupants) if (!allFinite(o)) sawNaN = true;
			}

			const carPos = sim.vehicle.chassis.getPosition();
			const report = rig.occupants.map((o, i) => ({
				seat: o.seatKey,
				alive: rig.runtimes[i].alive,
				state: rig.runtimes[i].state,
				ejected: o.ejected,
				groundY: rig.runtimes[i].groundY === null ? null : +rig.runtimes[i].groundY.toFixed(2),
				pelvisY: +o.parts.pelvis.body.getPosition().y.toFixed(2),
				headY: +o.parts.head.body.getPosition().y.toFixed(2),
				dist: +Math.hypot(o.parts.pelvis.body.getPosition().x - carPos.x, o.parts.pelvis.body.getPosition().z - carPos.z).toFixed(1),
			}));
			console.log('[grounded-flee]', JSON.stringify(report));
			expect(sawNaN).toBe(false);

			// At least one alive ejected survivor stands at the ELEVATED ground height (head clearly up
			// relative to the platform top, exactly the flat-ground flee test's bar shifted by +1.2).
			const stood = rig.occupants.some(
				(o, i) => rig.runtimes[i].alive && o.ejected && o.parts.head.body.getPosition().y > PLATFORM_TOP_Y + 1.2,
			);
			expect(stood).toBe(true);

			for (let i = 0; i < rig.occupants.length; i++) {
				const o = rig.occupants[i];
				const r = rig.runtimes[i];
				if (!o.ejected || !r.alive) continue;
				// GROUNDED: the measured ground under every ejected survivor is the platform top...
				expect(r.groundY).not.toBeNull();
				expect(Math.abs(r.groundY - PLATFORM_TOP_Y)).toBeLessThan(0.15);
				// ...nobody hovers (old bug: pelvis servo'd to ABSOLUTE 0.92 regardless of terrain), and
				// nobody is driven INTO the ground either. Upright states get the stand band; any state
				// must at least keep all parts out of the slab.
				if (r.state === 'recover' || r.state === 'flee' || r.state === 'safe') {
					const rel = o.parts.pelvis.body.getPosition().y - PLATFORM_TOP_Y;
					expect(rel).toBeGreaterThan(0.1);
					expect(rel).toBeLessThan(1.15);
				}
				expect(minPartY(o)).toBeGreaterThan(PLATFORM_TOP_Y - 0.25);
			}

			teardownAll(rig);
			slabShape.destroy(false);
			slab.destroy();
		} finally {
			sim.destroy();
		}
	});
});

// -- Defect 4: world reset from EVERY FSM state ------------------------------------------------------

describe('escalation 4: browser-faithful world reset re-seats 4/4 from every FSM state', () => {
	/** Mimics main.ts doWorldRepair() EXACTLY as the occupants feature experiences it:
	 * doCarRepair(): destroyVehicle + createVehicle, then features.reset('car') = teardown + reseat;
	 * then features.reset('world') = teardown + reseat AGAIN (the double rebuild -- the second
	 * teardown exercises the OTHER joint-lifecycle branch, where the restraint's chassis is still
	 * alive). Returns the fresh rig. */
	function browserWorldReset(sim, rig) {
		destroyVehicle(sim.vehicle);
		sim.vehicle = createVehicle(sim.world, { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 });
		teardownAll(rig);
		const carResetRig = seatAll(sim); // features.reset('car')
		teardownAll(carResetRig);
		return seatAll(sim); // features.reset('world')
	}

	/** Runs `prep` to put occupants into some FSM state, resets, then asserts a fully-healthy
	 * seated rig through 300 browser-faithful post-reset steps. Returns states seen at reset. */
	async function resetScenario(name, prep) {
		const sim = await createSim();
		try {
			let rig = seatAll(sim);
			const cleanup = (await prep(sim, rig)) ?? (() => {});
			const statesAtReset = rig.runtimes.map((r) => r.state);
			cleanup(); // browser: doWorldRepair destroys any test wall before rebuilding
			rig = browserWorldReset(sim, rig);

			for (let i = 0; i < 300; i++) stepAll(sim, rig);

			const carPos = sim.vehicle.chassis.getPosition();
			for (let i = 0; i < rig.occupants.length; i++) {
				const o = rig.occupants[i];
				const r = rig.runtimes[i];
				expect(r.alive, `${name}: occupant ${i} alive after reset`).toBe(true);
				expect(r.state, `${name}: occupant ${i} state after reset`).toBe('seated');
				expect(o.ejected, `${name}: occupant ${i} not ejected after reset`).toBe(false);
				expect(o.restraintJoint, `${name}: occupant ${i} restraint present`).not.toBeNull();
				expect(allFinite(o), `${name}: occupant ${i} finite`).toBe(true);
				// Filter restored: seated occupants ride the shared car group (never collide with car).
				expect(o.parts.pelvis.shape.getFilter().groupIndex, `${name}: occupant ${i} car-filtered`).toBe(CAR_GROUP_INDEX);
				// Physically IN the cabin: pelvis near the chassis, no part sunk through the floor.
				const p = o.parts.pelvis.body.getPosition();
				expect(Math.hypot(p.x - carPos.x, p.y - carPos.y, p.z - carPos.z), `${name}: occupant ${i} in cabin`).toBeLessThan(1.8);
				expect(minPartY(o), `${name}: occupant ${i} above ground`).toBeGreaterThan(-0.3);
			}
			console.log(`[reset:${name}] statesAtReset=${JSON.stringify(statesAtReset)} -> all 4 seated+braced+filtered`);
			teardownAll(rig);
			return statesAtReset;
		} finally {
			sim.destroy();
		}
	}

	/** Wall-less 55km/h yank crash (flee test's model) that reliably ejects all 4 alive. */
	function yankCrash(sim, rig) {
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
	}

	const seen = new Set();
	const note = (states) => states.forEach((s) => seen.add(s));

	it('reset with all 4 SEATED', async () => {
		note(await resetScenario('seated', async (sim, rig) => {
			for (let i = 0; i < 60; i++) stepAll(sim, rig);
		}));
	});

	it('reset mid-TUMBLING', async () => {
		note(await resetScenario('tumbling', async (sim, rig) => {
			for (let i = 0; i < 31; i++) stepAll(sim, rig);
			yankCrash(sim, rig);
			for (let i = 0; i < 45; i++) stepAll(sim, rig);
		}));
	});

	it('reset while SETTLED', async () => {
		note(await resetScenario('settled', async (sim, rig) => {
			for (let i = 0; i < 31; i++) stepAll(sim, rig);
			yankCrash(sim, rig);
			for (let i = 0; i < 200; i++) stepAll(sim, rig);
		}));
	});

	/** Steps until some occupant reports `state` (cap `maxSteps`) -- the transient states (recover,
	 * and especially flee when the crash already threw the occupant past the arrival radius) have
	 * data-dependent timing, so the reset is triggered ON the observed state, not on a step count.
	 * The coverage assertion at the end still fails loudly if a state was never actually caught. */
	function stepUntilState(sim, rig, state, maxSteps) {
		for (let i = 0; i < maxSteps; i++) {
			stepAll(sim, rig);
			if (rig.runtimes.some((r) => r.state === state)) return;
		}
	}

	it('reset mid-RECOVER', async () => {
		note(await resetScenario('recover', async (sim, rig) => {
			for (let i = 0; i < 31; i++) stepAll(sim, rig);
			yankCrash(sim, rig);
			stepUntilState(sim, rig, 'recover', 900);
		}));
	});

	it('reset mid-FLEE', async () => {
		note(await resetScenario('flee', async (sim, rig) => {
			for (let i = 0; i < 31; i++) stepAll(sim, rig);
			yankCrash(sim, rig);
			stepUntilState(sim, rig, 'flee', 1200);
		}));
	});

	it('reset from SAFE', async () => {
		note(await resetScenario('safe', async (sim, rig) => {
			for (let i = 0; i < 31; i++) stepAll(sim, rig);
			yankCrash(sim, rig);
			for (let i = 0; i < 1500; i++) stepAll(sim, rig);
		}));
	});

	it('reset with DEAD occupants (lethal wall crash)', async () => {
		note(await resetScenario('dead', async (sim, rig) => {
			for (let i = 0; i < 31; i++) stepAll(sim, rig);
			const wall = spawnTestWall(sim.world, sim.vehicle, 16);
			crashSetup(sim.vehicle, 150);
			const v = sim.vehicle.chassis.getLinearVelocity();
			rig.occupants.forEach((o, i) => {
				matchOccupantVelocity(o, v);
				resetOccupantAccelBaseline(o, rig.runtimes[i]);
			});
			for (const p of rig.pans) matchSeatPanVelocity(p, v);
			for (let i = 0; i < 300; i++) stepAll(sim, rig);
			return () => wall.destroy();
		}));
	});

	it('the scenarios above covered EVERY FSM state at reset time', () => {
		console.log('[reset-coverage]', JSON.stringify([...seen]));
		for (const s of ['seated', 'tumbling', 'settled', 'recover', 'flee', 'safe', 'dead']) {
			expect(seen.has(s), `covered FSM state '${s}' at reset`).toBe(true);
		}
	});
});
