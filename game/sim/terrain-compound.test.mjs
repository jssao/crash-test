// SPDX-License-Identifier: MIT
//
// Compound-in-a-forest terrain test (the terrain GROW + COMPOUND overhaul). Complements terrain.test.mjs
// (determinism / apron flatness / potholes / feature-placement / physics parity) with the assertions
// specific to "a rural workshop compound ringed by forest":
//   1. Span grew to 800m and the 512^2 heightfield still builds cheaply (O(count^2) -> unchanged cost).
//   2. The forest RING actually ENCLOSES the compound -- forestMask ~= 1 in every direction around the
//      yard (so the yard reads as sitting in the woods, not open on one side).
//   3. The north GATE is OPEN -- no fence piece sits in the gate gap the driveway passes through, and
//      the driveway spur carries real (drivable) washboard/pothole relief.
//   4. The loop road winds THROUGH the forest -- trees' flat floor abuts the drivable road band.
//   5. GATE/ROAD CONNECTIVITY DRIVE: the real box3d terrain ground is traversable straight north out of
//      the compound, over the driveway, up onto the forest loop -- the car covers real distance, stays
//      controllable (upDot > 0.9, no NaN), and the road relief measurably works the suspension harder
//      than the flat yard it started on.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import {
	APRON,
	DIRT_LOOP,
	DIRT_SPUR,
	FOREST_RING,
	TERRAIN_COUNT,
	TERRAIN_SPAN_M,
	buildTerrainHeights,
	dirtRoadWeight,
	forestMask,
	terrainHeight,
} from '../src/world/terrain/heightfield.ts';
import { createTerrainGroundBody } from '../src/world/terrain/terrainBody.ts';
import { createVehicle, stepVehicle, getTelemetry, getSuspensionDeflection } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, CHASSIS_ORIGIN_HEIGHT_M, WHEEL_SPAWN_SETTLE_MARGIN_M } from '../src/vehicle/tuning.ts';
import { FENCE_CONFIGS, FENCE_SPAN_COUNT, FENCE_SPAN_LENGTH_M } from '../src/world/features/buildings/tuning.ts';

const WHEEL_KEYS = ['fl', 'fr', 'rl', 'rr'];

function variance(samples) {
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	return samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
}

describe('terrain: compound in a forest', () => {
	it('grew to 800m span and the 512^2 heightfield still builds cheaply', () => {
		expect(TERRAIN_SPAN_M).toBe(800);
		expect(TERRAIN_COUNT).toBe(512);
		const t0 = performance.now();
		const h = buildTerrainHeights();
		const buildMs = performance.now() - t0;
		expect(h.length).toBe(TERRAIN_COUNT * TERRAIN_COUNT);
		console.log(`[compound] built ${TERRAIN_COUNT}x${TERRAIN_COUNT} over ${TERRAIN_SPAN_M}m in ${buildMs.toFixed(1)}ms (${(h.byteLength / 1024 / 1024).toFixed(2)}MiB)`);
		// O(count^2) build -- span grow does not change the cost. Generous bound (matches terrain.test).
		expect(buildMs).toBeLessThan(600);
	});

	it('the forest RING encloses the compound on every side (forestMask ~= 1 all around)', () => {
		// Sample a full circle of directions at several radii inside the flat forest band; every sample
		// clear of the roads must be hard-flat forest floor. A single open side would show a low mask.
		const centerZ = (APRON.cz + FOREST_RING.rMin) * 0; // ring is measured from the world origin band
		let minOffRoadMask = 1;
		let sampled = 0;
		for (const r of [FOREST_RING.rMin + 8, 100, FOREST_RING.rMax - 12]) {
			for (let a = 0; a < 24; a++) {
				const ang = (a / 24) * Math.PI * 2;
				const x = Math.cos(ang) * r;
				const z = centerZ + Math.sin(ang) * r + 16; // ring is centred near z=16..30
				if (dirtRoadWeight(x, z) > 0.05) continue; // skip where a road corridor punches through
				minOffRoadMask = Math.min(minOffRoadMask, forestMask(x, z));
				sampled++;
			}
		}
		console.log(`[compound] enclosure: min off-road forestMask over ${sampled} ring samples = ${minOffRoadMask.toFixed(3)}`);
		expect(sampled).toBeGreaterThan(40);
		expect(minOffRoadMask).toBeGreaterThan(0.9); // ringed on every side
	});

	it('the north GATE is open (no fence in the gate gap) and the driveway carries relief', () => {
		// The gate gap the driveway spur runs through: |x| <= spur half-width, at the north fence line's z.
		const fenceZ = FENCE_CONFIGS[0].center.z;
		const gateHalf = DIRT_SPUR.halfWidth; // 8m -> gate opening x in [-8,8]
		const fenceHalfLen = (FENCE_SPAN_COUNT * FENCE_SPAN_LENGTH_M) / 2;
		// Every fence run's full X extent must stay OUT of the gate gap.
		let intrusion = null;
		for (const f of FENCE_CONFIGS) {
			const lo = f.center.x - fenceHalfLen;
			const hi = f.center.x + fenceHalfLen;
			if (hi > -gateHalf && lo < gateHalf) intrusion = f.id;
		}
		console.log(`[compound] gate gap x in [${-gateHalf},${gateHalf}] at z=${fenceZ}: intrusion=${intrusion ?? 'none'}`);
		expect(intrusion).toBeNull();
		// The driveway itself is a road (real relief), running north out of the gate up toward the loop.
		expect(DIRT_SPUR.cx).toBe(0);
		let sawRelief = 0;
		for (let z = DIRT_SPUR.zStart + 6; z <= DIRT_SPUR.zEnd - 6; z += 3) {
			expect(dirtRoadWeight(0, z)).toBeGreaterThan(0.5); // on the driveway
			if (Math.abs(terrainHeight(0, z)) > 0.02) sawRelief++;
		}
		console.log(`[compound] driveway samples with >2cm relief: ${sawRelief}`);
		expect(sawRelief).toBeGreaterThan(3); // washboard/potholes actually present on the drive
	});

	it('the loop winds through the forest (trees flat floor abuts the drivable road band)', () => {
		// Just off the loop centreline (a few metres out) the ground becomes hard-flat forest floor.
		let flatAdjacent = 0;
		for (let deg = 0; deg < 360; deg += 30) {
			const a = (deg * Math.PI) / 180;
			// A point ~9m radially outside the loop centreline (past the road band's ~7m half-width).
			const rx = DIRT_LOOP.rx + 9;
			const rz = DIRT_LOOP.rz + 9;
			const x = DIRT_LOOP.cx + Math.cos(a) * rx;
			const z = DIRT_LOOP.cz + Math.sin(a) * rz;
			if (forestMask(x, z) > 0.9 && dirtRoadWeight(x, z) < 0.05) flatAdjacent++;
		}
		console.log(`[compound] loop-adjacent forest-floor samples (of 12): ${flatAdjacent}`);
		expect(flatAdjacent).toBeGreaterThanOrEqual(8); // forest presses the loop on most of its perimeter
	});

	it('CONNECTIVITY: the real terrain ground is drivable straight north out the gate onto the loop', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createTerrainGroundBody(world);
			const spawnY = terrainHeight(0, 0) + CHASSIS_ORIGIN_HEIGHT_M - WHEEL_SPAWN_SETTLE_MARGIN_M;
			const vehicle = createVehicle(world, { x: 0, y: spawnY, z: 0 });

			const yardDefl = { fl: [], fr: [], rl: [], rr: [] };
			const roadDefl = { fl: [], fr: [], rl: [], rr: [] };
			let minUpDot = 1;
			let sawNaN = false;
			const STEPS = 900; // 15s @ 60Hz
			for (let i = 0; i < STEPS; i++) {
				stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				const t = getTelemetry(vehicle);
				if (!Number.isFinite(t.chassisPos.x) || !Number.isFinite(t.chassisPos.y) || !Number.isFinite(t.chassisPos.z)) sawNaN = true;
				minUpDot = Math.min(minUpDot, t.upDot);
				// Bucket per-wheel deflection by where the car is: flat yard (z < gate) vs road (past gate).
				const bucket = t.chassisPos.z < APRON.cz + APRON.halfZ - 6 ? yardDefl : roadDefl;
				for (const k of WHEEL_KEYS) bucket[k].push(getSuspensionDeflection(vehicle, k));
			}
			const finalZ = getTelemetry(vehicle).chassisPos.z;
			expect(sawNaN).toBe(false);
			expect(world.isValid()).toBe(true);
			expect(minUpDot).toBeGreaterThan(0.9); // stayed rubber-side-down the whole way out
			expect(finalZ).toBeGreaterThan(80); // drove out the gate, up the driveway, onto the loop band (z~77+)

			// The road relief works the suspension harder than the flat yard it launched from.
			let ratioSum = 0;
			for (const k of WHEEL_KEYS) {
				const yv = variance(yardDefl[k].length ? yardDefl[k] : [0]);
				const rv = variance(roadDefl[k].length ? roadDefl[k] : [0]);
				ratioSum += rv / Math.max(yv, 1e-9);
			}
			const avgRatio = ratioSum / WHEEL_KEYS.length;
			console.log(`[compound] connectivity drive: finalZ=${finalZ.toFixed(1)}m minUpDot=${minUpDot.toFixed(3)} road/yard deflection-variance ratio=${avgRatio.toFixed(1)}x`);
			expect(avgRatio).toBeGreaterThan(2); // road genuinely bumpier than the yard
		} finally {
			world.destroy();
		}
	});
});
