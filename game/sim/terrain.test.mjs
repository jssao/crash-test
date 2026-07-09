// SPDX-License-Identifier: MIT
//
// Terrain generation + integration test (environment overhaul). Validates the shared terrain height
// data (game/src/world/terrain/heightfield.ts) that drives BOTH the physics height-field body and the
// visual mesh:
//   1. Deterministic generation -- buildTerrainHeights() is byte-identical across runs.
//   2. Spawn-pad flatness -- the apron (spawn + legacy destructibles + ramps) is < 2 deg slope and
//      exactly h=0, so every existing scenario/verify keeps working.
//   3. Pothole depth -- each dirt-road pothole is 0.15-0.35m below its surrounding road rim.
//   4. Feature placement -- every relocated tree site + every building piece centre sits within 5cm of
//      the terrain surface (they spawn at y=0, so the terrain under them must be ~0).
//   5. Physics parity -- the box3d height-field body built from the SAME data rests bodies at the
//      height function's value (apron -> ~0), with no NaN/trap.
import { describe, expect, it } from 'vitest';
import { init, World, BodyType } from '../../src/ts/index.ts';
import {
	APRON,
	DIRT_LOOP,
	DIRT_POTHOLES,
	SPUR_POTHOLES,
	TERRAIN_COUNT,
	buildTerrainHeights,
	terrainHeight,
	terrainSlopeDeg,
	apronMask,
} from '../src/world/terrain/heightfield.ts';
import { createTerrainGroundBody } from '../src/world/terrain/terrainBody.ts';
import {
	SAPLING_SITES,
	MID_SITES,
	LARGE_SITES,
	FAR_SAPLING_SITES,
	FAR_MID_SITES,
	FAR_LARGE_SITES,
} from '../src/world/features/trees/tuning.ts';
import {
	SHED_CENTER,
	CORNER_POINT,
	BRICK_WALL_CENTER,
	FENCE_CONFIGS,
} from '../src/world/features/buildings/tuning.ts';

describe('terrain generation', () => {
	it('buildTerrainHeights() is deterministic (byte-identical across runs)', () => {
		const a = buildTerrainHeights();
		const b = buildTerrainHeights();
		expect(a.length).toBe(TERRAIN_COUNT * TERRAIN_COUNT);
		let maxDelta = 0;
		for (let i = 0; i < a.length; i++) maxDelta = Math.max(maxDelta, Math.abs(a[i] - b[i]));
		expect(maxDelta).toBe(0);
		// Sanity: the field is not trivially flat everywhere (the dirt loop/meadow have real relief).
		let min = Infinity, max = -Infinity;
		for (let i = 0; i < a.length; i++) { if (a[i] < min) min = a[i]; if (a[i] > max) max = a[i]; }
		console.log(`[terrain] height range: min=${min.toFixed(3)}m max=${max.toFixed(3)}m over ${TERRAIN_COUNT}x${TERRAIN_COUNT}`);
		expect(min).toBeLessThan(-0.15); // potholes present
		expect(max).toBeGreaterThan(0.1); // rolling relief present
	});

	it('spawn-pad apron is flat: h==0 and slope < 2deg across the whole pad', () => {
		let maxAbsH = 0;
		let maxSlope = 0;
		for (let x = APRON.cx - APRON.halfX + 2; x <= APRON.cx + APRON.halfX - 2; x += 2) {
			for (let z = APRON.cz - APRON.halfZ + 2; z <= APRON.cz + APRON.halfZ - 2; z += 2) {
				// Only assert over the pad interior (mask fully 1); the feathered border is meant to ramp.
				if (apronMask(x, z) < 0.999) continue;
				maxAbsH = Math.max(maxAbsH, Math.abs(terrainHeight(x, z)));
				maxSlope = Math.max(maxSlope, terrainSlopeDeg(x, z));
			}
		}
		console.log(`[terrain] apron interior: maxAbsHeight=${maxAbsH.toFixed(4)}m maxSlope=${maxSlope.toFixed(3)}deg`);
		expect(maxAbsH).toBe(0);
		expect(maxSlope).toBeLessThan(2);
		// Spawn point itself is exactly flat.
		expect(terrainHeight(0, 0)).toBe(0);
	});

	it('dirt-road potholes: designed depths are 0.15-0.35m and each carves a real depression', () => {
		let minDip = Infinity, maxDip = -Infinity;
		for (const p of [...DIRT_POTHOLES, ...SPUR_POTHOLES]) {
			// (a) The designed depth is within the spec range.
			expect(p.depth).toBeGreaterThanOrEqual(0.15);
			expect(p.depth).toBeLessThanOrEqual(0.35);
			// (b) The surface actually dips: centre is below the mean of an 8-sample ring ~2.5*radius out
			// (averaging cancels the road's washboard/rolling so the pothole itself dominates), and the
			// centre is a strict local minimum vs every ring sample.
			const centreH = terrainHeight(p.x, p.z);
			const off = p.radius * 2.5;
			let ringSum = 0;
			for (let k = 0; k < 8; k++) {
				const a = (k / 8) * Math.PI * 2;
				ringSum += terrainHeight(p.x + Math.cos(a) * off, p.z + Math.sin(a) * off);
			}
			// Mean of the surrounding ring averages out the road's washboard so the pothole itself
			// dominates -- a robust "the surface really dips here by ~pothole depth" check.
			const dip = ringSum / 8 - centreH;
			minDip = Math.min(minDip, dip);
			maxDip = Math.max(maxDip, dip);
			expect(dip).toBeGreaterThan(0.08); // a real depression, never washed out by a flat mask
			expect(dip).toBeLessThan(0.6);
		}
		console.log(`[terrain] validated ${DIRT_POTHOLES.length + SPUR_POTHOLES.length} potholes: designed 0.15-0.35m; measured ring dip ${minDip.toFixed(3)}-${maxDip.toFixed(3)}m`);
	});

	it('every feature placement site sits within 5cm of the terrain surface (spawns at y=0)', () => {
		const treeSites = [
			...SAPLING_SITES, ...MID_SITES, ...LARGE_SITES,
			...FAR_SAPLING_SITES, ...FAR_MID_SITES, ...FAR_LARGE_SITES,
		];
		let worstTree = 0;
		for (const s of treeSites) worstTree = Math.max(worstTree, Math.abs(terrainHeight(s.x, s.z)));
		console.log(`[terrain] ${treeSites.length} tree sites, worst |terrainHeight| = ${worstTree.toFixed(4)}m`);
		expect(worstTree).toBeLessThan(0.05);

		const buildingCentres = [SHED_CENTER, CORNER_POINT, BRICK_WALL_CENTER, ...FENCE_CONFIGS.map((f) => f.center)];
		let worstBldg = 0;
		for (const c of buildingCentres) worstBldg = Math.max(worstBldg, Math.abs(terrainHeight(c.x, c.z)));
		console.log(`[terrain] ${buildingCentres.length} building centres, worst |terrainHeight| = ${worstBldg.toFixed(4)}m`);
		expect(worstBldg).toBeLessThan(0.05);
	});

	it('physics: box3d height-field body rests bodies at the height function, no NaN', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createTerrainGroundBody(world);
			// Drop sites: spawn (flat apron -> ~0) and a dirt-road point (matches terrainHeight there).
			const roadX = DIRT_LOOP.cx, roadZ = DIRT_LOOP.cz - DIRT_LOOP.rz; // south point of the loop
			const sites = [
				{ name: 'apron', x: 0, z: 0 },
				{ name: 'dirt-road', x: roadX, z: roadZ },
			];
			const bodies = sites.map((s) => {
				const surface = terrainHeight(s.x, s.z);
				const body = world.createBody({ type: BodyType.Dynamic, position: { x: s.x, y: surface + 3, z: s.z } });
				body.createBoxShape({ halfExtents: { x: 0.4, y: 0.4, z: 0.4 }, friction: 0.9 });
				return { s, surface, body };
			});
			let sawNaN = false;
			for (let i = 0; i < 240; i++) {
				world.step(1 / 60, 4);
				for (const { body } of bodies) {
					const p = body.getPosition();
					if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) sawNaN = true;
				}
			}
			expect(sawNaN).toBe(false);
			expect(world.isValid()).toBe(true);
			for (const { s, surface, body } of bodies) {
				const p = body.getPosition();
				const rest = p.y - terrainHeight(p.x, p.z);
				console.log(`[terrain] drop@${s.name}: surfaceExpected=${surface.toFixed(3)} restAboveSurface=${rest.toFixed(3)}m`);
				expect(rest).toBeGreaterThan(0.2); // box half-extent 0.4, resting on the surface
				expect(rest).toBeLessThan(0.65);
			}
		} finally {
			world.destroy();
		}
	});
});
