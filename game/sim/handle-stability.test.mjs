// SPDX-License-Identifier: MIT
//
// Regression tests for two native-handle leaks found during a soak-test pass (game/verify/playtest-soak/
// run1-reset-cycle-soak.mjs, run2-long-session*.json, run3-wheel-detach-endurance*.json):
//
// (a) LEAK (fixed): window.__GAME__.spawnTestWall (main.ts hook -> damage/scenario.ts's
//     spawnTestWall()) created a wall body+shape that NO reset path ever destroyed -- isolated soak
//     repro: spawnTestWall+resetWorld x10 = perfectly linear +2 handles/call, never reclaimed. Fixed by
//     scenario.ts's destroyTestWall() (shape-then-body, matching every other destroy site in this
//     codebase) + main.ts tracking the current wall and calling it on both a repeat spawnTestWall() call
//     (replace semantics) and a world reset. This test exercises destroyTestWall()/spawnTestWall()'s
//     contract directly (main.ts itself can't be imported headless -- it's a browser entry point that
//     touches the DOM at import time), wrapped in a small worldReset() that mirrors doWorldRepair()'s
//     "destroy the vehicle + destroy the wall" responsibilities.
//
// (b) INVESTIGATED, NOT A LEAK: doCarRepair()/resetCar() on a HEAVILY damaged car (panels broken, a
//     wheel detached, cardetail parts broken, occupants ejected) shows a real, one-time liveHandleCount
//     INCREASE when repaired (matches the soak evidence: run2-long-session-samples.json's
//     t=483->513s "repair" segment, 1378->1395, +17). Root-caused by hand-deriving the exact handle
//     arithmetic per subsystem (cardetail/index.ts's destroyAll()+spawnAll(), occupants/physics.ts's
//     teardownOccupant()+seatAll()) AND confirming empirically: a broken cardetail part or an ejected
//     occupant already destroyed its own weld/restraint joint live during the crash (breakComponent(),
//     pollOccupantRestraint()) -- repair legitimately reconstructs that joint from scratch, which is a
//     real, BOUNDED, one-time cost proportional to how much was broken, not an unbounded leak. Verified
//     by instrumented headless repro (game/sim/leak-diag*.mjs, not committed) across 4 damage
//     configurations (mild panel damage, mid-despawn-timer, past-despawn-timer, and all 4 wheels
//     detached): every case showed a nonzero delta on the FIRST repair (matching the crash's damage
//     severity) and EXACTLY ZERO delta on repair cycles 2-5 (no new damage in between) -- i.e. repair
//     is idempotent from an already-pristine state, which is the actual definition of "no leak" (a real
//     leak would keep growing every cycle regardless of state). This test locks in that same invariant
//     as an exit-gated regression check.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { loadNative, Sim } from './harness.mjs';
import { World, liveHandleCount } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, destroyVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT } from '../src/vehicle/tuning.ts';
import { createDamageSystem, stepDamageSystem, getDamageTelemetry } from '../src/damage/system.ts';
import { resetCrumpleRegistry } from '../src/damage/crumple.ts';
import { spawnTestWall, destroyTestWall, crashSetup } from '../src/damage/scenario.ts';
import createCarDetailFeature from '../src/world/features/cardetail/index.ts';
import createOccupantsFeature from '../src/world/features/occupants/index.ts';

describe('handle stability: spawnTestWall + world reset (leak 1)', () => {
	it('spawnTestWall + worldReset x10 -> liveHandleCount flat from cycle 1 onward', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			let wall = null;

			/** Mirrors main.ts's doWorldRepair(): destroy+recreate the vehicle, AND destroy the
			 * currently-tracked test wall (if any) -- the exact two responsibilities the leak fix added. */
			function worldReset() {
				destroyVehicle(sim.vehicle);
				sim.vehicle = createVehicle(sim.world, sim.vehicle.spawnPosition, sim.vehicle.spawnRotation);
				if (wall) {
					destroyTestWall(wall);
					wall = null;
				}
			}

			const counts = [];
			for (let cycle = 0; cycle < 10; cycle++) {
				// Mirrors main.ts's spawnTestWall hook: replace semantics (destroy any previous wall first
				// -- a no-op here since worldReset() below always clears it, but matches the real hook's own
				// defensive check).
				if (wall) destroyTestWall(wall);
				wall = spawnTestWall(sim.world, sim.vehicle, 20);
				worldReset();
				counts.push(liveHandleCount());
			}

			console.log(`[handle-stability] spawnTestWall+worldReset x10 liveHandleCount per cycle: ${counts.join(', ')}`);
			const deltasFromCycle2 = counts.slice(1).map((c, i) => c - counts[i]);
			console.log(`[handle-stability] per-cycle deltas (cycle N -> N+1): ${deltasFromCycle2.join(', ')}`);

			// Every cycle destroys+recreates the SAME shape of world (1 vehicle + 1 wall), so once past the
			// first cycle every subsequent cycle must return to the EXACT SAME liveHandleCount -- any
			// growth here is exactly the leak this test guards against.
			for (let i = 1; i < counts.length; i++) {
				expect(counts[i]).toBe(counts[0]);
			}
		} finally {
			sim.destroy();
		}
	});
});

describe('handle stability: doCarRepair() on a heavily-damaged car (leak 2 investigation)', () => {
	it('heavy crash (broken panels + detached wheel + broken cardetail + ejected occupants), past the despawn window -> resetCar x5 -> flat after cycle 1', async () => {
		const native = await loadNative();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		createGroundBody(world);
		let vehicle = createVehicle(world, { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
		const SPAWN_POS = vehicle.spawnPosition;
		const SPAWN_ROT = vehicle.spawnRotation;
		let damage = createDamageSystem(vehicle);

		const ctx = {
			world,
			scene: new THREE.Scene(),
			getVehicle: () => vehicle,
			carRoot: new THREE.Object3D(),
			quality: { level: 'high', shadowMapSize: 1024, pixelRatioCap: 2, antialias: false, envMapSize: 256 },
		};
		const cardetail = await createCarDetailFeature(ctx);
		const occupants = await createOccupantsFeature(ctx);

		function step(input) {
			stepVehicle(vehicle, input, FIXED_DT);
			world.step(FIXED_DT, 4);
			stepDamageSystem(damage, world, FIXED_DT);
			cardetail.afterFixedStep(FIXED_DT);
			occupants.afterFixedStep(FIXED_DT);
		}

		/** Mirrors main.ts's doCarRepair() exactly (minus the THREE-visual-only steps, which never touch
		 * a box3d native handle -- panelVisuals/glass-material swap/carDeformables sync are pure
		 * three.js scene-graph/geometry operations). */
		function doCarRepair() {
			resetCrumpleRegistry(damage.registry);
			destroyVehicle(vehicle);
			vehicle = createVehicle(world, SPAWN_POS, SPAWN_ROT);
			damage = createDamageSystem(vehicle, damage.registry);
			cardetail.reset('car');
			occupants.reset('car');
		}

		// ---- Deterministic wheel detach: a direct sustained impulse (same mechanism-test technique as
		// damage-wheel-detach.test.mjs), not a speed/RNG-dependent crash retry. ----
		for (let i = 0; i < 20; i++) {
			vehicle.wheels.fl.body.applyLinearImpulseToCenter({ x: 20000, y: 0, z: 0 }, true);
			step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		}

		// ---- Panel/cardetail damage + occupant ejection: drive hard into a wall. ----
		const wall = spawnTestWall(world, vehicle, 20);
		crashSetup(vehicle, 150);
		for (let i = 0; i < 240; i++) step({ throttle: 1, brake: 0, steer: 0, handbrake: false });

		// ---- Step well past every despawn/disable timer (damage-tuning.ts's PANEL_DESPAWN_AFTER_S=25s,
		// PANEL_HIT_EVENTS_DISABLE_AFTER_S=6s) so a broken panel has actually despawned (body+shape
		// destroyed by system.ts) before repair -- exercises the "broken panel mid-despawn-timer when
		// destroyVehicle() runs" hazard the leak was suspected to live in. ----
		for (let i = 0; i < 1560; i++) step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		destroyTestWall(wall);

		const dt = getDamageTelemetry(damage);
		const brokenPanels = Object.values(dt.panelStates).filter((s) => s === 'broken').length;
		const detachedWheels = Object.values(dt.wheelStates).filter((s) => s === 'detached').length;
		const cardetailBroken = cardetail.hooks.detachedCount();
		const occupantsEjected = occupants.hooks.seatStates().filter((s) => s.ejected).length;
		console.log(
			`[handle-stability] pre-repair damage: brokenPanels=${brokenPanels} detachedWheels=${detachedWheels} ` +
				`cardetailBroken=${cardetailBroken} occupantsEjected=${occupantsEjected}`,
		);
		// Sanity: this really is a "heavily damaged car" scenario, not an accidental no-op crash.
		expect(detachedWheels).toBeGreaterThanOrEqual(1);
		expect(brokenPanels + cardetailBroken).toBeGreaterThan(0);

		const counts = [liveHandleCount()];
		for (let cycle = 1; cycle <= 5; cycle++) {
			doCarRepair();
			counts.push(liveHandleCount());
		}
		console.log(`[handle-stability] liveHandleCount before + after 5x resetCar(): ${counts.join(' -> ')}`);
		const deltas = counts.slice(1).map((c, i) => c - counts[i]);
		console.log(`[handle-stability] per-cycle deltas: ${deltas.join(', ')}`);

		// Cycle 1 (damaged -> repaired) legitimately reconstructs whatever joints the crash destroyed --
		// not asserted flat. Cycles 2-5 (repaired -> repaired, no new damage) MUST be perfectly flat; any
		// growth there is a genuine, unbounded leak.
		for (let i = 2; i < counts.length; i++) {
			expect(counts[i]).toBe(counts[1]);
		}

		world.destroy();
	}, 60_000);
});
