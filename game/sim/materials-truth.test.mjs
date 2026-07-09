// SPDX-License-Identifier: MIT
//
// MATERIALS-TRUTH regression (destruction round 2). Two things the user asked for directly:
//   (A) a mass/dimension truth audit -- assert the destructible defs now match the real-world figures
//       in docs/build-log/specs/materials-truth.md (the old "brick" was a 0.4m foam block at 162
//       kg/m^3; it is now a real 194x92x57mm / 2.7kg brick, etc.), read straight off the physics
//       bodies (getMassData) so a future regression in tuning.ts can't silently drift the numbers.
//   (B) debris SETTLES -- after a crash the freed bricks come to rest instead of pirouetting forever
//       (playtest issue #1), the in-structure counterpart to tests/rolling-resistance.test.ts.
// Imports the renderer-free modules directly (skips the WorldFeature registry), same pattern as
// game/sim/features-buildings.test.mjs.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import { buildBrickWall, buildShed, buildHouseCorner, pollStructureBreaks } from '../src/world/features/buildings/structures.ts';
import { BRICK_WALL_CENTER } from '../src/world/features/buildings/tuning.ts';

let cachedNative = null;
async function loadNative() {
	if (cachedNative === null) cachedNative = init();
	return cachedNative;
}
async function makeWorld() {
	const native = await loadNative();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, 250);
	return world;
}
function launch(vehicle, speedKmh) {
	const v = { x: 0, y: 0, z: speedKmh / 3.6 };
	vehicle.chassis.setLinearVelocity(v);
	for (const w of Object.values(vehicle.wheels)) w.body.setLinearVelocity(v);
	for (const p of Object.values(vehicle.panels)) p.body.setLinearVelocity(v);
}
const COAST = { throttle: 0, brake: 0, steer: 0, handbrake: false };

describe('materials-truth: dimensions + masses match the real-world audit', () => {
	it('brick is a real 194x92x57mm / 2.7kg brick (not the old 0.4m foam block)', async () => {
		const world = await makeWorld();
		try {
			const wall = buildBrickWall(world);
			const brick = wall.pieces.find((p) => p.kind === 'brick');
			const h = brick.half;
			// Dimensions (half-extents), millimetres, within 1mm.
			expect(h.x * 2000).toBeCloseTo(194, 0);
			expect(h.y * 2000).toBeCloseTo(57, 0);
			expect(h.z * 2000).toBeCloseTo(92, 0);
			// Mass off the actual body, and the implied density is in the real fired-clay band (not foam).
			const mass = brick.body.getMassData().mass;
			const volume = 8 * h.x * h.y * h.z;
			const density = mass / volume;
			console.log(`[brick truth] ${(h.x * 2000).toFixed(0)}x${(h.z * 2000).toFixed(0)}x${(h.y * 2000).toFixed(0)}mm mass=${mass.toFixed(2)}kg density=${density.toFixed(0)}kg/m3`);
			expect(mass).toBeGreaterThan(2.3);
			expect(mass).toBeLessThan(3.0);
			expect(density).toBeGreaterThan(1800); // real brick ~1900-2650; the OLD block was 162 (styrofoam)
		} finally {
			world.destroy();
		}
	});

	it('2x4 stud cross-section is ~58mm (real 2x4 area) and drywall is ~12.7mm thick', async () => {
		const world = await makeWorld();
		try {
			const shed = buildShed(world);
			const stud = shed.pieces.find((p) => p.kind === 'stud');
			// Square stud, cross-section 58mm (equal area to a 38x89mm 2x4).
			expect(stud.half.x * 2000).toBeCloseTo(58, 0);
			expect(stud.half.z * 2000).toBeCloseTo(58, 0);

			const corner = buildHouseCorner(world);
			const panel = corner.pieces.find((p) => p.kind === 'drywall');
			// Thinnest half-extent is the board thickness -> 12.7mm total.
			const thick = Math.min(panel.half.x, panel.half.y, panel.half.z) * 2000;
			console.log(`[frame truth] stud=${(stud.half.x * 2000).toFixed(0)}mm sq  drywall=${thick.toFixed(1)}mm thick`);
			expect(thick).toBeCloseTo(12.7, 1);
		} finally {
			world.destroy();
		}
	});
});

describe('materials-truth: crashed debris settles (does not spin forever)', () => {
	it('after a hard brick-wall smash, freed debris comes to rest within ~6s (issue #1)', async () => {
		const world = await makeWorld();
		try {
			const wall = buildBrickWall(world);
			const vehicle = createVehicle(world, { x: BRICK_WALL_CENTER.x, y: 0.5, z: 8 });
			launch(vehicle, 90);
			// Impact + a long coast so debris has time to settle (400 steps ~= 6.7s).
			for (let i = 0; i < 400; i++) {
				stepVehicle(vehicle, COAST, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				pollStructureBreaks(wall);
			}
			const bricks = wall.pieces.filter((p) => p.kind === 'brick');
			// Only look at bricks that were actually disturbed (moved from spawn) -- those are the debris.
			const disturbed = bricks.filter((p) => {
				const q = p.body.getPosition();
				return Math.hypot(q.x - p.spawnPos.x, q.y - p.spawnPos.y, q.z - p.spawnPos.z) > 0.3;
			});
			expect(disturbed.length).toBeGreaterThan(20); // it really was a big smash

			let maxOmega = 0;
			let settled = 0;
			for (const p of disturbed) {
				const w = p.body.getAngularVelocity();
				const v = p.body.getLinearVelocity();
				const omega = Math.hypot(w.x, w.y, w.z);
				const speed = Math.hypot(v.x, v.y, v.z);
				maxOmega = Math.max(maxOmega, omega);
				if (omega < 0.6 && speed < 0.4) settled++;
			}
			const settledFrac = settled / disturbed.length;
			console.log(`[debris settle] disturbed=${disturbed.length} settledFrac=${(settledFrac * 100).toFixed(0)}% maxOmega=${maxOmega.toFixed(2)}rad/s`);
			// The overwhelming majority of debris has thudded to rest (angular damping crossed the sleep
			// threshold) -- with no damping the old behaviour left bricks pirouetting indefinitely.
			expect(settledFrac).toBeGreaterThan(0.85);
			expect(maxOmega).toBeLessThan(3.0);
		} finally {
			world.destroy();
		}
	});
});
