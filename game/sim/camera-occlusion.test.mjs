// SPDX-License-Identifier: MIT
//
// Sim-level unit test for the Tier-2 camera-occlusion cast+margin math (src/camera/occlusion.ts).
// Headless, no three/DOM (same convention as the other game/sim/*.test.mjs -- see sim/harness.mjs's
// doc comment): a plain World with a handful of static bodies stands in for "the car" (tagged with
// real CAR_ENTITY_ID/PANEL_ENTITY_ID userData, exactly as vehicle.ts/panels.ts tag their own bodies)
// and "a wall" (untagged, like a real building/tree/terrain triangle), then castCameraOcclusion() is
// exercised directly against them. The full browser-driven behavior (chase camera pulling in behind a
// real obstacle, then recovering) is covered separately by verify/camera-occlusion.mjs.

import { describe, expect, it } from 'vitest';
import { init, World, BodyType } from '../../src/ts/index.ts';
import { castCameraOcclusion, isCarOwnedEntityId, OcclusionDamper } from '../src/camera/occlusion.ts';
import { CAR_ENTITY_ID } from '../src/vehicle/vehicle.ts';
import { PANEL_ENTITY_ID } from '../src/damage/panels.ts';

let cachedNative = null;
async function loadNative() {
	if (cachedNative === null) cachedNative = await init();
	return cachedNative;
}

describe('isCarOwnedEntityId', () => {
	it('recognizes chassis, every wheel, and every panel', () => {
		expect(isCarOwnedEntityId(CAR_ENTITY_ID.chassis)).toBe(true);
		for (const id of Object.values(CAR_ENTITY_ID.wheel)) expect(isCarOwnedEntityId(id)).toBe(true);
		for (const id of Object.values(PANEL_ENTITY_ID)) expect(isCarOwnedEntityId(id)).toBe(true);
	});

	it('recognizes the occupants/physics.ts entityIdFor() range (1000-1399) without importing it', () => {
		expect(isCarOwnedEntityId(1000)).toBe(true); // seat 0, part 0
		expect(isCarOwnedEntityId(1073)).toBe(true); // seat 0, part 73 (still in-range, hypothetical)
		expect(isCarOwnedEntityId(1399)).toBe(true); // seat 3, part 99 -- top of the documented range
	});

	it('does not flag untagged world geometry (default userData 0) or an out-of-range id', () => {
		expect(isCarOwnedEntityId(0)).toBe(false);
		expect(isCarOwnedEntityId(1400)).toBe(false);
		expect(isCarOwnedEntityId(44_000_000)).toBe(false); // a barrel -- see world/tuning.ts's BARREL_ENTITY_ID_BASE
	});
});

describe('castCameraOcclusion', () => {
	it('reports the full distance, unoccluded, when nothing is in the way', async () => {
		const native = await loadNative();
		const world = new World(native, { gravity: { x: 0, y: 0, z: 0 } });
		try {
			const origin = { x: 0, y: 1, z: 0 };
			const desired = { x: 0, y: 1, z: -6 };
			const result = castCameraOcclusion(world, origin, desired);
			expect(result.occluded).toBe(false);
			expect(result.distanceM).toBeCloseTo(6, 5);
		} finally {
			world.destroy();
		}
	});

	it('pulls in short of a real (untagged) wall standing between origin and desired', async () => {
		const native = await loadNative();
		const world = new World(native, { gravity: { x: 0, y: 0, z: 0 } });
		try {
			const origin = { x: 0, y: 1, z: 0 };
			const desired = { x: 0, y: 1, z: -6 };
			// A wall at z=-4 (untagged userData=0, like a building/tree), thin along the cast direction.
			const wall = world.createBody({ type: BodyType.Static, position: { x: 0, y: 1, z: -4 } });
			wall.createBoxShape({ halfExtents: { x: 8, y: 2, z: 0.5 }, friction: 0.9 });

			const result = castCameraOcclusion(world, origin, desired);
			expect(result.occluded).toBe(true);
			// The wall's near face sits at z=-3.5, i.e. 3.5m from origin; the returned distance must be
			// clamped comfortably short of that (probeRadius+clearanceMargin, ~0.65m by default) and
			// well short of the full 6m.
			expect(result.distanceM).toBeLessThan(3.5);
			expect(result.distanceM).toBeGreaterThan(1.5); // >= minDistanceM default
		} finally {
			world.destroy();
		}
	});

	it('sees straight through car-owned hits (chassis, a wheel, a panel, an occupant) to a real wall behind them', async () => {
		const native = await loadNative();
		const world = new World(native, { gravity: { x: 0, y: 0, z: 0 } });
		try {
			const origin = { x: 0, y: 1, z: 0 };
			const desired = { x: 0, y: 1, z: -10 };

			// Four car-owned bodies spread along the same ray (z=-1.5, -3, -4.5, -6), each realistically
			// THIN along the cast direction (a real panel is 0.05m thick -- damage-tuning.ts's
			// PANEL_THICKNESS_M -- and even a wheel/chassis corner is well under a meter) with real gaps
			// between them, tagged with the SAME entity ids the real car/panels/occupants use.
			const tag = (z, userData) => {
				const b = world.createBody({ type: BodyType.Static, position: { x: 0, y: 1, z }, userData });
				b.createBoxShape({ halfExtents: { x: 0.4, y: 0.4, z: 0.1 }, userData });
				return b;
			};
			tag(-1.5, CAR_ENTITY_ID.chassis);
			tag(-3, CAR_ENTITY_ID.wheel.rl);
			tag(-4.5, PANEL_ENTITY_ID.trunk);
			tag(-6, 1042); // an occupant part (seat 0, part 42)

			// A real wall further along, at z=-8.
			const wall = world.createBody({ type: BodyType.Static, position: { x: 0, y: 1, z: -8 } });
			wall.createBoxShape({ halfExtents: { x: 8, y: 2, z: 0.5 }, friction: 0.9 });

			const result = castCameraOcclusion(world, origin, desired);
			expect(result.occluded).toBe(true);
			// Wall's near face at z=-7.5 -> 7.5m from origin, clamped short of that -- NOT short-circuited
			// at any of the four car-owned hits along the way.
			expect(result.distanceM).toBeGreaterThan(6.5);
			expect(result.distanceM).toBeLessThan(7.5);
		} finally {
			world.destroy();
		}
	});

	it('never resolves below minDistanceM even boxed in tight against a wall', async () => {
		const native = await loadNative();
		const world = new World(native, { gravity: { x: 0, y: 0, z: 0 } });
		try {
			const origin = { x: 0, y: 1, z: 0 };
			const desired = { x: 0, y: 1, z: -6 };
			const wall = world.createBody({ type: BodyType.Static, position: { x: 0, y: 1, z: -0.6 } });
			wall.createBoxShape({ halfExtents: { x: 8, y: 2, z: 0.5 }, friction: 0.9 });

			const result = castCameraOcclusion(world, origin, desired, { minDistanceM: 1.5 });
			expect(result.occluded).toBe(true);
			expect(result.distanceM).toBeCloseTo(1.5, 5);
		} finally {
			world.destroy();
		}
	});
});

describe('OcclusionDamper', () => {
	it('pulls in fast: over ~2x pullInTimeS worth of frames, lands close to a much shorter target', () => {
		const damper = new OcclusionDamper(0.05, 0.6);
		damper.update(6, 0); // seed at 6m (dt=0 snaps to target, matching chase.ts's own springDamp init pattern)
		let pulledIn = 6;
		for (let i = 0; i < 6; i++) pulledIn = damper.update(2, 1 / 60); // ~0.1s = 2x pullInTimeS
		expect(pulledIn).toBeLessThan(3); // most of the way from 6m to 2m already
		expect(pulledIn).toBeGreaterThan(2);
	});

	it('recovers slowly: over that SAME elapsed time, a long recoverTimeS stays far short of a much longer target', () => {
		const damper = new OcclusionDamper(0.05, 0.6);
		damper.update(2, 0); // seed short (occluded)
		let recovering = 2;
		for (let i = 0; i < 6; i++) recovering = damper.update(6, 1 / 60); // same ~0.1s, but recoverTimeS=0.6 (12x longer)
		expect(recovering).toBeGreaterThan(2);
		expect(recovering).toBeLessThan(3); // nowhere near 6m yet -- recovery is much slower than pull-in
	});

	it('reset() forgets prior state, snapping the next update() straight to its target', () => {
		const damper = new OcclusionDamper(0.05, 0.6);
		damper.update(2, 1 / 60);
		damper.reset();
		expect(damper.update(6, 1 / 60)).toBeCloseTo(6, 5);
	});
});
