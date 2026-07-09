// SPDX-License-Identifier: MIT
//
// Headless sim test for the 'buildings' WorldFeature (game/src/world/features/buildings/*). Imports
// the renderer-free structures module DIRECTLY (skips the registry, per features/registry.ts's own
// doc comment: "Headless sim tests should import a feature module directly ... rather than going
// through this registry"). Each scenario spawns the vehicle at a custom position/rotation aimed
// straight at the structure under test and gives it an instantaneous velocity (same
// "teleport-align + set velocity" trick as damage/scenario.ts's crashSetup(), reproduced locally here
// since scenario.ts's own version is hardcoded to the vehicle's OWN spawn transform, not an arbitrary
// aim point).
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import {
	buildAllStructures,
	buildBrickWall,
	buildFenceLine,
	buildHouseCorner,
	pollStructureBreaks,
	resetStructure,
	totalBrokenJointCount,
	totalPieceCount,
} from '../src/world/features/buildings/structures.ts';
import { BRICK_WALL_CENTER, CORNER_POINT, CORNER_SEGMENT_LENGTH_M, FENCE_CONFIGS } from '../src/world/features/buildings/tuning.ts';

let cachedNative = null;
async function loadNative() {
	if (cachedNative === null) cachedNative = init();
	return cachedNative;
}

/** "Teleport-align + set velocity": every car body (chassis, wheels, panels) gets the same forward
 * velocity instantly -- see damage/scenario.ts's crashSetup() doc comment for why panels must get it
 * too (otherwise the panel welds see a huge artificial first-step relative-velocity spike). */
function launch(vehicle, speedKmh) {
	const speedMs = speedKmh / 3.6;
	const velocity = { x: 0, y: 0, z: speedMs }; // IDENTITY rotation everywhere below -> forward = +Z
	vehicle.chassis.setLinearVelocity(velocity);
	for (const wheel of Object.values(vehicle.wheels)) wheel.body.setLinearVelocity(velocity);
	for (const panel of Object.values(vehicle.panels)) panel.body.setLinearVelocity(velocity);
}

function allFinite(vehicle) {
	const t = vehicle.chassis.getTransform();
	const vals = [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w];
	return vals.every((v) => Number.isFinite(v));
}

async function makeWorld() {
	const native = await loadNative();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, 250);
	return world;
}

describe('features/buildings', () => {
	it('drive-through-drywall: ~50km/h punches through the house-corner front segment, exits with >40% speed, >=4 drywall panels detach', async () => {
		const world = await makeWorld();
		try {
			const corner = buildHouseCorner(world);
			// Spawn 16m south of the corner's front segment (spans x in [CORNER_POINT.x - len, CORNER_POINT.x]),
			// aimed at its midpoint, driving +Z -- tracks the compound-relocated CORNER_POINT.
			const vehicle = createVehicle(world, { x: CORNER_POINT.x - CORNER_SEGMENT_LENGTH_M / 2, y: 0.5, z: CORNER_POINT.z - 16 });
			launch(vehicle, 50);

			let sawNaN = false;
			const startSpeed = 50 / 3.6;
			for (let i = 0; i < 300; i++) {
				stepVehicle(vehicle, { throttle: 0.3, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				pollStructureBreaks(corner);
				if (!allFinite(vehicle)) sawNaN = true;
			}
			const finalPos = vehicle.chassis.getPosition();
			const finalVel = vehicle.chassis.getLinearVelocity();
			const finalSpeed = Math.hypot(finalVel.x, finalVel.y, finalVel.z);
			const brokenJointsTotal = corner.joints.filter((j) => j.broken).length; // studs+drywall welds share this one joints array
			const brokenDrywallPieces = corner.pieces.filter((p) => p.kind === 'drywall').filter((p) => {
				const pos = p.body.getPosition();
				return Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z) > 0.3;
			}).length;

			console.log(
				`[drive-through-drywall] finalPos=${JSON.stringify(finalPos)} finalSpeed=${finalSpeed.toFixed(2)}m/s (start=${startSpeed.toFixed(2)}m/s) brokenDrywallPieces=${brokenDrywallPieces} totalJointsBroken=${brokenJointsTotal}`,
			);

			expect(sawNaN).toBe(false);
			expect(finalPos.z).toBeGreaterThan(CORNER_POINT.z + 2); // actually exited past the wall
			expect(finalSpeed).toBeGreaterThan(startSpeed * 0.4);
			expect(brokenDrywallPieces).toBeGreaterThanOrEqual(4);

			world.destroy();
		} catch (e) {
			world.destroy();
			throw e;
		}
	});

	it('brick-wall hit: ~70km/h scatters >=15 bricks >0.5m, car survives with speed dropping materially', async () => {
		const world = await makeWorld();
		try {
			const wall = buildBrickWall(world);
			const vehicle = createVehicle(world, { x: BRICK_WALL_CENTER.x, y: 0.5, z: 8 });
			launch(vehicle, 70);
			const startSpeed = 70 / 3.6;

			let sawNaN = false;
			// Track the speed trough right around impact separately from the final speed: with
			// continued light throttle the drivetrain re-accelerates the car in the ~5s AFTER it punches
			// through, so "dropped materially" is asserted against the post-impact trough, not the final
			// (recovered) speed -- the final speed is only checked for having stayed finite ("survives").
			let troughSpeed = Infinity;
			for (let i = 0; i < 300; i++) {
				stepVehicle(vehicle, { throttle: 0.3, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				pollStructureBreaks(wall);
				if (!allFinite(vehicle)) sawNaN = true;
				const vel = vehicle.chassis.getLinearVelocity();
				const speed = Math.hypot(vel.x, vel.y, vel.z);
				if (i > 20) troughSpeed = Math.min(troughSpeed, speed); // skip the initial launch ramp-up
			}

			const displacedBricks = wall.pieces.filter((p) => p.kind === 'brick').filter((p) => {
				const pos = p.body.getPosition();
				return Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z) > 0.5;
			}).length;
			const finalVel = vehicle.chassis.getLinearVelocity();
			const finalSpeed = Math.hypot(finalVel.x, finalVel.y, finalVel.z);

			console.log(`[brick-wall] displacedBricks(>0.5m)=${displacedBricks}/${wall.pieces.filter((p) => p.kind === 'brick').length} troughSpeed=${troughSpeed.toFixed(2)}m/s finalSpeed=${finalSpeed.toFixed(2)}m/s startSpeed=${startSpeed.toFixed(2)}m/s`);

			expect(sawNaN).toBe(false);
			expect(displacedBricks).toBeGreaterThanOrEqual(15);
			expect(troughSpeed).toBeLessThan(startSpeed * 0.9); // dropped materially right around impact
			expect(Number.isFinite(finalSpeed)).toBe(true); // "survives" -- didn't blow up

			world.destroy();
		} catch (e) {
			world.destroy();
			throw e;
		}
	});

	it('fence smash: ~40km/h breaks >=3 fence pieces free', async () => {
		const world = await makeWorld();
		try {
			const cfg = FENCE_CONFIGS[0];
			const fence = buildFenceLine(world, cfg);
			const vehicle = createVehicle(world, { x: cfg.center.x, y: 0.5, z: cfg.center.z - 10 });
			launch(vehicle, 40);

			let sawNaN = false;
			for (let i = 0; i < 240; i++) {
				stepVehicle(vehicle, { throttle: 0.3, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				pollStructureBreaks(fence);
				if (!allFinite(vehicle)) sawNaN = true;
			}

			const brokenFree = fence.pieces.filter((p) => !p.isStatic).filter((p) => {
				const pos = p.body.getPosition();
				return Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z) > 0.3;
			}).length;

			console.log(`[fence-smash] brokenFree=${brokenFree}/${fence.pieces.filter((p) => !p.isStatic).length}`);

			expect(sawNaN).toBe(false);
			expect(brokenFree).toBeGreaterThanOrEqual(3);

			world.destroy();
		} catch (e) {
			world.destroy();
			throw e;
		}
	});

	it('reset restores every structure to its spawn pose (body count + poses unchanged)', async () => {
		const world = await makeWorld();
		try {
			const structures = buildAllStructures(world);
			const pieceCountBefore = totalPieceCount(structures);
			// COMPOUND overhaul: the 2 fence lines became a 6-segment north perimeter (gate-flanked), so
			// the total grew from ~251 to ~312. Bounds bracket that (tolerant of +-1 fence line).
			expect(pieceCountBefore).toBeGreaterThanOrEqual(270);
			expect(pieceCountBefore).toBeLessThanOrEqual(350);

			// Smash the brick wall hard enough to break joints and displace bricks.
			const brickWall = structures.find((s) => s.id === 'brick-wall');
			const vehicle = createVehicle(world, { x: BRICK_WALL_CENTER.x, y: 0.5, z: 8 });
			launch(vehicle, 80);
			for (let i = 0; i < 240; i++) {
				stepVehicle(vehicle, { throttle: 0.3, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				for (const s of structures) pollStructureBreaks(s);
			}
			const brokenBefore = totalBrokenJointCount(structures);
			console.log(`[reset] brokenJointsBeforeReset=${brokenBefore}`);
			expect(brokenBefore).toBeGreaterThan(0);

			for (const s of structures) resetStructure(world, s);

			const pieceCountAfter = totalPieceCount(structures);
			expect(pieceCountAfter).toBe(pieceCountBefore);
			expect(totalBrokenJointCount(structures)).toBe(0);

			let maxDrift = 0;
			for (const s of structures) {
				for (const p of s.pieces) {
					const pos = p.body.getPosition();
					const drift = Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z);
					maxDrift = Math.max(maxDrift, drift);
				}
			}
			console.log(`[reset] maxPositionDriftAfterReset=${maxDrift.toFixed(4)}m brickWallJoints=${brickWall.joints.length}`);
			expect(maxDrift).toBeLessThan(0.001);

			world.destroy();
		} catch (e) {
			world.destroy();
			throw e;
		}
	});
});
