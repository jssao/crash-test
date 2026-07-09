// SPDX-License-Identifier: MIT
//
// Test/playtest scenario helpers (G3 spec): a static wall spawner + a "crash at speed" setup, shared
// verbatim by the browser game (main.ts's window.__GAME__.spawnTestWall/crash) and the headless sim
// tests (game/sim/damage-*.test.mjs) -- renderer-free (no three/DOM import), same pattern as
// vehicle.ts/panels.ts.

import { Body, BodyType, Shape, World } from '../../../src/ts/index.js';
import { rotateVector, scale, type V3 } from '../vehicle/mathUtil';
import { resetVehicle, type Vehicle } from '../vehicle/vehicle';

const LOCAL_FORWARD: V3 = { x: 0, y: 0, z: 1 };

/** Body -> its own box shape, for every wall spawnTestWall() has ever created -- lookup table backing
 * destroyTestWall() below. A private WeakMap (not a field on Body itself, which existing callers depend
 * on treating as a bare box3d-js Body -- see this file's doc comment: spawnTestWall() is shared verbatim
 * by main.ts AND several existing sim tests that already call the returned Body's OWN .destroy()
 * directly, e.g. game/sim/damage-moderate-impact.test.mjs, game/sim/features-occupants.test.mjs -- so
 * this function's return type must stay a plain Body, never a wrapper object). */
const wallShapes = new WeakMap<Body, Shape>();

/** Spawns a thick static box wall `distanceAhead` meters in front of the vehicle's SPAWN position
 * (along its spawn-forward axis), tall/wide enough that a car can't drive around or over it. Returns
 * the wall body so a test can inspect/despawn it. */
export function spawnTestWall(world: World, vehicle: Vehicle, distanceAhead = 25): Body {
	const forward = rotateVector(vehicle.spawnRotation, LOCAL_FORWARD);
	const position: V3 = {
		x: vehicle.spawnPosition.x + forward.x * distanceAhead,
		y: 1.5,
		z: vehicle.spawnPosition.z + forward.z * distanceAhead,
	};
	const wall = world.createBody({ type: BodyType.Static, position });
	// Deliberately no enableHitEvents on the wall shape itself -- box3d only needs ONE side of a
	// contact to have it enabled (vendor/box3d/src/contact.c: `shapeA->flags & enableHitEvents ||
	// shapeB->flags & enableHitEvents`), and every car shape (chassis hull + all 5 panels) already has
	// it on (vehicle.ts/panels.ts).
	const shape = wall.createBoxShape({ halfExtents: { x: 8, y: 2, z: 0.5 }, friction: 0.9, density: 1 });
	wallShapes.set(wall, shape);
	return wall;
}

/**
 * FULL teardown of a spawnTestWall() body: destroys its shape BEFORE the body (same box3d-js
 * live-handle-registry gotcha as every other destroy site in this codebase -- vehicle.ts's
 * destroyVehicle() doc comment, damage/panels.ts's breakPanelWeld(), etc: destroying the body alone
 * frees the shape natively too, but leaves its JS-side Shape wrapper's registry entry stuck "live"
 * forever). Root-caused leak (soak isolation: spawnTestWall+resetWorld x10 = perfectly linear +2
 * handles/call, never reclaimed) -- main.ts's window.__GAME__.spawnTestWall hook never destroyed the
 * PREVIOUS wall on a repeat call, and doWorldRepair() never destroyed it either. Safe to call at any
 * time, including mid-crash: the wall is a plain static body with no userData tag the damage system
 * ever matches against (hitTouchesCar() only recognizes the chassis/panel entity ids -- see welds.ts),
 * and nothing else anywhere holds a reference to it, so there is no despawned-body/dangling-reference
 * hazard to guard against here (contrast damage/panels.ts's PanelHandle.despawned flag, needed because
 * MULTIPLE places -- system.ts, main.ts's doFixedStep, welds.ts -- hold a live reference to a panel
 * body across frames; this wall has exactly one owner, whoever holds the Body this function was called
 * with).
 */
export function destroyTestWall(wall: Body): void {
	const shape = wallShapes.get(wall);
	if (shape) {
		shape.destroy(false);
		wallShapes.delete(wall);
	}
	wall.destroy();
}

/**
 * "Teleport-align + set velocity toward the wall": resets the vehicle to its pristine spawn transform
 * (resetVehicle(), so repeated calls from a fresh or already-driven car both start from the same known
 * state) and gives EVERY car body (chassis, wheels, AND the 5 welded panels) an initial forward
 * velocity of `speedKmh` km/h, so it coasts into a wall spawned ahead of it without needing to spin up
 * via throttle (deterministic, and doesn't depend on the drivetrain's own acceleration curve to reach
 * the target speed).
 *
 * IMPORTANT: the panel bodies MUST get this velocity too, not just chassis+wheels -- panels are
 * rigidly welded to the chassis (game/src/damage/panels.ts), so leaving them at their old (near-zero)
 * velocity while the chassis instantly jumps to speedKmh creates a huge, entirely artificial relative-
 * velocity violation across every weld joint on the very first physics step (the solver has to yank
 * each panel from ~0 to speedKmh in one substep) -- which reads as a massive constraint-force spike
 * and breaks every panel immediately, before the car has even reached the wall. Caught by hand while
 * building this scenario helper: an early version omitted this and every panel broke on step 1 of
 * every crash test regardless of speed.
 */
export function crashSetup(vehicle: Vehicle, speedKmh: number): void {
	resetVehicle(vehicle);
	const speedMs = speedKmh / 3.6;
	const forward = rotateVector(vehicle.spawnRotation, LOCAL_FORWARD);
	const velocity = scale(forward, speedMs);
	vehicle.chassis.setLinearVelocity(velocity);
	for (const wheel of Object.values(vehicle.wheels)) {
		wheel.body.setLinearVelocity(velocity);
	}
	for (const panel of Object.values(vehicle.panels)) {
		panel.body.setLinearVelocity(velocity);
	}
}
