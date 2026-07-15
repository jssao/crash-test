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
	buildBrickWallLab,
	buildFenceLine,
	buildHouseCorner,
	pollStructureBreaks,
	resetStructure,
	totalBrokenJointCount,
	totalFracturedPieceCount,
	totalPieceCount,
} from '../src/world/features/buildings/structures.ts';
import { buildSupportGraph, pollStructureCollapse } from '../src/world/features/buildings/support.ts';
import { BRICK_HALF_EXTENTS, BRICK_WALL_CENTER, BRICK_WALL_COLUMNS, BRICK_WALL_LAB_SPAN_M, CORNER_POINT, CORNER_SEGMENT_LENGTH_M, FENCE_CONFIGS } from '../src/world/features/buildings/tuning.ts';
import { createFractureBudget, createFractureIdAllocator, FRACTURE_FRAGMENT_ENTITY_ID_BASE, resetFractureBudget } from '../src/world/features/fracture.ts';

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

	// P005 bug fix: BRICK_WALL_ROWS/COLUMNS grew from a 0.91m "garden divider" to a real ~1.71m x
	// 3.10m wall (tuning.ts), so a hit near one END now leaves the FAR end (>2m away) geometrically
	// distinct from the impact -- this scenario is impossible on the old 1.94m-long wall (nothing on
	// it is ever 2m from anything else on it). Launched with a light throttle (0.12, not the 0.3 the
	// other scenarios in this file use) -- see this task's report: a sustained 0.3 throttle for the
	// full 5s run keeps grinding the car into the wreckage long after the initial impact, which
	// defeats any "does the far section stay standing" measurement regardless of wall tuning (verified
	// empirically). A light throttle models "foot back on the gas after the hit" without that.
	it('brick-wall hit (P005): ~50km/h dislodges bricks LOCALLY, wall >=2m from impact mostly stands, car keeps moving', async () => {
		const world = await makeWorld();
		try {
			const wall = buildBrickWall(world);
			const wallHalfLen = (BRICK_WALL_COLUMNS * BRICK_HALF_EXTENTS.x * 2) / 2;
			// Aim near the wall's LEFT end so the right end sits comfortably >2m away laterally.
			const impactX = BRICK_WALL_CENTER.x - wallHalfLen + 0.6;
			const vehicle = createVehicle(world, { x: impactX, y: 0.5, z: 8 });
			launch(vehicle, 50);
			const startSpeed = 50 / 3.6;

			let sawNaN = false;
			for (let i = 0; i < 300; i++) {
				stepVehicle(vehicle, { throttle: 0.12, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				pollStructureBreaks(wall);
				if (!allFinite(vehicle)) sawNaN = true;
			}

			const bricks = wall.pieces.filter((p) => p.kind === 'brick');
			const displacement = bricks.map((p) => {
				const pos = p.body.getPosition();
				const dist3d = Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z);
				return { dist3d, lateralFromImpact: Math.abs(p.spawnPos.x - impactX) };
			});
			const nearDislodged = displacement.filter((d) => d.lateralFromImpact < 1.0 && d.dist3d > 0.3).length;
			const farBucket = displacement.filter((d) => d.lateralFromImpact > 2.0);
			const farStanding = farBucket.filter((d) => d.dist3d < 0.3).length;
			const finalVel = vehicle.chassis.getLinearVelocity();
			const finalSpeed = Math.hypot(finalVel.x, finalVel.y, finalVel.z);

			console.log(`[brick-wall-local] nearDislodged=${nearDislodged}/${bricks.length} farBucket=${farBucket.length} farStanding=${farStanding} finalSpeed=${finalSpeed.toFixed(2)}m/s startSpeed=${startSpeed.toFixed(2)}m/s`);

			expect(sawNaN).toBe(false);
			expect(nearDislodged).toBeGreaterThanOrEqual(100); // a real chunk breaks loose right at the impact
			expect(farBucket.length).toBeGreaterThan(0); // the resized wall actually HAS a >=2m-away section to check
			expect(farStanding).toBeGreaterThanOrEqual(8); // NOT the whole wall -- a real remnant stays put far away
			expect(finalSpeed).toBeGreaterThan(0.3); // car keeps moving afterward (not dead-stopped)
			expect(finalSpeed).toBeLessThan(startSpeed * 0.7); // but materially slower than it went in

			world.destroy();
		} catch (e) {
			world.destroy();
			throw e;
		}
	});

	// P005 GATE FIX (crash-lab WIDE segmented wall). The adversarial visual gate rated the crash-lab
	// brick wall PARTIAL: "the ENTIRE wall disintegrates flat, ~0% remains upright ... a small isolated
	// panel only slightly wider than the car, so a localized hole is structurally impossible". The lab
	// target now spawns buildBrickWallLab -- a REAL ~8.2m x 1.71m property wall of 3 INDEPENDENTLY-FOOTED
	// panels separated by 4cm expansion joints (no weld crosses a gap). A centre hit knocks out the
	// struck panel while the two flanking panels -- structurally isolated -- STAY STANDING, exactly like
	// the reference photos (car buried in a car-shaped breach, wall standing on both sides). This is the
	// scenario the sim-side of the gate: it exercises the EXACT builder + break + support-collapse polls
	// the crash-lab runs (spawnBuildingTarget in lab/crashTargets.ts), with a fracture ctx + support
	// graph, so the numbers here are the numbers the lab produces. Light throttle (0.12) models "foot
	// back on the gas after the hit" without grinding the car into the wreckage (same as the narrow P005
	// scenario above). Measured at authoring: near=295 dislodged, far(>=2.5m)=480 all standing (frac
	// 1.00), car exits to z~42 at ~4.8 m/s (from 13.9). Asserted with generous margin below the gate line.
	it('brick-wall LAB (P005 gate): 50km/h CENTRE hit breaches struck panel, flanking sections >=2.5m stand >=50%, car passes through slowed', async () => {
		const world = await makeWorld();
		try {
			// >=8m span is a hard requirement (the car is ~1.85m wide -- the wall must be substantially
			// wider so flanking sections can exist), asserted directly off the tuning constant.
			expect(BRICK_WALL_LAB_SPAN_M).toBeGreaterThanOrEqual(8.0);

			const center = { x: 0, y: 0, z: 24 };
			const wall = buildBrickWallLab(world, center);
			const brickCount = wall.pieces.filter((p) => p.kind === 'brick').length;
			// Perf sanity: a real 8.2m x 1.71m masonry wall is inherently ~1200 bricks; it must stay well
			// under the ~2000 that would bog the lab (only ONE structure is live in the lab at a time).
			expect(brickCount).toBeGreaterThan(1000);
			expect(brickCount).toBeLessThan(1500);

			// CENTRE hit: car aimed at the wall's centre, so both flanking panels sit >=2.5m from impact.
			const vehicle = createVehicle(world, { x: center.x, y: 0.5, z: center.z - 16 });
			launch(vehicle, 50);
			const startSpeed = 50 / 3.6;

			// Mirror the crash-lab's own per-step drivers exactly (fracture ctx + support-collapse graph).
			const graph = buildSupportGraph(wall);
			const fracture = {
				world,
				budget: createFractureBudget(1),
				idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE + 500_000),
				timeSec: 0,
				fragments: [],
				events: [],
				liveFragmentCap: 40,
			};

			let sawNaN = false;
			for (let i = 0; i < 300; i++) {
				stepVehicle(vehicle, { throttle: 0.12, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				fracture.timeSec += FIXED_DT;
				resetFractureBudget(fracture.budget);
				fracture.events.length = 0;
				const broke = pollStructureBreaks(wall, fracture);
				if (broke > 0) pollStructureCollapse(wall, graph);
				if (!allFinite(vehicle)) sawNaN = true;
			}

			const bricks = wall.pieces.filter((p) => p.kind === 'brick');
			const disp = bricks.map((p) => {
				const pos = p.body.getPosition();
				return {
					dropped: Math.abs(pos.y - p.spawnPos.y), // height change: a standing brick barely moves in Y
					lateral: Math.abs(p.spawnPos.x - center.x), // lateral distance of the SPAWN column from impact
					moved3d: Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z),
				};
			});
			const nearDislodged = disp.filter((d) => d.lateral < 1.0 && d.moved3d > 0.3).length;
			const farBucket = disp.filter((d) => d.lateral >= 2.5);
			const farStanding = farBucket.filter((d) => d.dropped < 0.1).length; // within ~10cm of spawn height
			const farStandingFrac = farStanding / Math.max(1, farBucket.length);
			const finalVel = vehicle.chassis.getLinearVelocity();
			const finalSpeed = Math.hypot(finalVel.x, finalVel.y, finalVel.z);
			const finalPos = vehicle.chassis.getPosition();

			console.log(
				`[brick-lab-P005] span=${BRICK_WALL_LAB_SPAN_M.toFixed(2)}m bricks=${brickCount} nearDislodged=${nearDislodged} far(>=2.5m)=${farBucket.length} farStanding=${farStanding} frac=${farStandingFrac.toFixed(2)} finalSpeed=${finalSpeed.toFixed(2)}/${startSpeed.toFixed(2)} finalZ=${finalPos.z.toFixed(2)} (wallZ=${center.z})`,
			);

			expect(sawNaN).toBe(false);
			expect(nearDislodged).toBeGreaterThanOrEqual(100); // a real breach opens in the STRUCK panel
			expect(farBucket.length).toBeGreaterThan(0); // the wide wall actually HAS a >=2.5m-lateral section
			expect(farStandingFrac).toBeGreaterThanOrEqual(0.5); // GATE: flanking sections stay standing
			expect(finalPos.z).toBeGreaterThan(center.z); // car PASSED THROUGH (exited past the wall plane)
			expect(finalSpeed).toBeLessThan(startSpeed * 0.9); // ... but was SLOWED by the wall

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

	// P003 bug fix: FENCE_POST_FRACTURE (fracture.ts) was lowered below the post's own footing weld-pop
	// threshold so a hard hit SNAPS the post (base-third stub + longer flyer, structures.ts's
	// fracturePiece() beam split) instead of yanking it whole out of the ground clean. This only
	// exercises the fracture pre-pass with a real StructureFractureContext (bare pollStructureBreaks(fence)
	// -- as every other scenario in this file uses -- is the legacy weld-pop-primary path and would never
	// prove this fix). "Piece count increases" reads as ctx.fragments (2 real fragment bodies spawned per
	// fractured post), not structure.pieces (fracturePiece() destroys the parent in place; it never grows
	// the pieces array -- see structures.ts's own doc comment).
	it('fence smash (P003): ~50km/h SNAPS >=1 post via fracture, not just weld-pop', async () => {
		const world = await makeWorld();
		try {
			const cfg = FENCE_CONFIGS[0];
			const fence = buildFenceLine(world, cfg);
			// Aimed at cfg.center.x -- the fence's MIDDLE post sits exactly there (buildFenceLine's post
			// layout), so the car's bumper hits it head-on rather than just clipping a rail.
			const vehicle = createVehicle(world, { x: cfg.center.x, y: 0.5, z: cfg.center.z - 10 });
			launch(vehicle, 50);

			const fracture = {
				world,
				budget: createFractureBudget(1),
				idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE),
				timeSec: 0,
				fragments: [],
				events: [],
				liveFragmentCap: 40,
			};

			let sawNaN = false;
			for (let i = 0; i < 240; i++) {
				stepVehicle(vehicle, { throttle: 0.3, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				fracture.timeSec += FIXED_DT;
				resetFractureBudget(fracture.budget);
				fracture.events.length = 0;
				pollStructureBreaks(fence, fracture);
				if (!allFinite(vehicle)) sawNaN = true;
			}

			const fracturedPosts = fence.pieces.filter((p) => p.kind === 'post' && p.fractured).length;
			const fracturedAny = totalFracturedPieceCount([fence]);
			console.log(`[fence-smash-fracture] fracturedPosts=${fracturedPosts} fracturedAny=${fracturedAny} liveFragments=${fracture.fragments.length}`);

			expect(sawNaN).toBe(false);
			expect(fracturedPosts).toBeGreaterThanOrEqual(1); // SNAPPED near the base, not popped whole
			expect(fracture.fragments.length).toBeGreaterThanOrEqual(2); // real fragment bodies spawned (stub + flyer)

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
			// the total grew from ~251 to ~312. P005 bug fix: BRICK_WALL_COLUMNS/ROWS grew 10x16=160 ->
			// 16x30=480 bricks (a real ~1.71m x 3.10m wall instead of a 0.91m garden divider), so the
			// total grew again to ~632 (312 - 161 old brick-wall pieces + 481 new ones). Bounds bracket
			// that (tolerant of +-1 fence line, same convention as before).
			expect(pieceCountBefore).toBeGreaterThanOrEqual(590);
			expect(pieceCountBefore).toBeLessThanOrEqual(670);

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
