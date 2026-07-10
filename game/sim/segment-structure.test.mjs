// SPDX-License-Identifier: MIT
//
// Crush M1 gate (crush-architecture.md §A step 1, "pure structure swap"): the chassis's monolithic
// NOSE/TAIL crush volumes are now chains of REAL welded segment bodies (vehicle/segments.ts:
// bumperBeam ⇄ crushRailL/R (2 cells each) ⇄ engineCradle ⇄ chassis firewall; trunkFloor + rear rails
// rear). This test proves the swap's load-bearing claims:
//   1. STRUCTURE: 9 segment bodies + a 10-weld rigid chain exist, tagged with the 13-21 entity ids.
//   2. ENGINE-INTEGRATED MASS PARITY: box3d's own integrated masses reproduce the spec masses, and
//      chassis remainder + segments == the tuned total (the parity DEDUCTION applied in vehicle.ts;
//      the full COM/inertia recomposition identity is asserted in hull-cabin-tub.test.mjs).
//   3. FILTERS: every segment shape is occupant-transparent + in the shared car group -- the exact
//      NOSE_TAIL-equivalent filter the solid volumes carried (occupants' legs/torsos live inside).
//   4. FIXITY: after a settle, every segment holds its chassis-local rest pose (fixed soft+overdamped
//      welds in M1, never yielding -- see segments.ts's SEGMENT_WELD_DAMPING_RATIO for why not hertz-0).
//   5. LIFECYCLE: destroyVehicle() unregisters every segment handle (no live-handle leak).
import { describe, expect, it } from 'vitest';
import { init, World, liveHandleCount } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, destroyVehicle } from '../src/vehicle/vehicle.ts';
import { SEGMENT_ENTITY_ID, SEGMENT_SPECS, segmentLocalDisplacement } from '../src/vehicle/segments.ts';
import { CHASSIS_MASS_KG, CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT, FIXED_SUBSTEPS, CAR_GROUP_INDEX, OCCUPANT_TRANSPARENT_CATEGORY_BITS } from '../src/vehicle/tuning.ts';

const SPAWN = { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 };

describe('crush M1: segment structure (segments.ts)', () => {
	it('9 segment bodies + 9 chassis-anchored welds, tagged 13-21, disjoint from every other entity-id range', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createGroundBody(world);
			const vehicle = createVehicle(world, SPAWN);
			const keys = Object.keys(vehicle.segments.bodies);
			expect(keys.length).toBe(9);
			expect(SEGMENT_SPECS.length).toBe(9);
			expect(vehicle.segments.welds.length).toBe(9);
			for (const w of vehicle.segments.welds) {
				expect(w.joint).not.toBeNull();
				expect(w.joint.isValid()).toBe(true);
				expect(w.crushM).toBe(0);
			}
			const ids = Object.values(SEGMENT_ENTITY_ID);
			expect(new Set(ids).size).toBe(9);
			// Disjoint from chassis/wheels (1-5), panels (6-10), glass (11-12), occupants (1000+).
			for (const id of ids) {
				expect(id).toBeGreaterThanOrEqual(13);
				expect(id).toBeLessThan(1000);
			}
			destroyVehicle(vehicle);
		} finally {
			world.destroy();
		}
	});

	it('engine-integrated masses: each segment body carries its spec mass; chassis remainder + segments == tuned total', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createGroundBody(world);
			const vehicle = createVehicle(world, SPAWN);
			let segTotal = 0;
			for (const spec of SEGMENT_SPECS) {
				const bodyMass = vehicle.segments.bodies[spec.key].body.getMass();
				expect(bodyMass).toBeCloseTo(spec.massKg, 4);
				segTotal += bodyMass;
			}
			const chassisMass = vehicle.chassis.getMass();
			console.log(`[segment-structure] chassis=${chassisMass.toFixed(3)}kg segments=${segTotal.toFixed(3)}kg total=${(chassisMass + segTotal).toFixed(3)}kg (tuned ${CHASSIS_MASS_KG}kg)`);
			expect(chassisMass + segTotal).toBeCloseTo(CHASSIS_MASS_KG, 3);
			destroyVehicle(vehicle);
		} finally {
			world.destroy();
		}
	});

	it('every segment shape carries the occupant-transparent filter + shared car group (NOSE_TAIL-equivalent)', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createGroundBody(world);
			const vehicle = createVehicle(world, SPAWN);
			for (const h of Object.values(vehicle.segments.bodies)) {
				const filter = h.shape.getFilter();
				// getFilter() reads the 64-bit word back SIGNED (wasm i64 -> BigInt); normalize to the
				// unsigned word the registry constant is expressed in before comparing.
				expect(BigInt.asUintN(64, filter.categoryBits)).toBe(OCCUPANT_TRANSPARENT_CATEGORY_BITS);
				expect(filter.groupIndex).toBe(CAR_GROUP_INDEX);
			}
			destroyVehicle(vehicle);
		} finally {
			world.destroy();
		}
	});

	// MEASURED: worst drift after 2s is ~4.5mm (the 8Hz/ratio-2 compliances sag single-digit
	// millimeters under gravity -- segments.ts's SEGMENT_WELD_DAMPING_RATIO doc). 1cm bounds that
	// comfortably while still failing loudly if a weld were genuinely loose/missing (a loosened
	// panel-style weld sags several cm under the same load).
	it('FIXED chain: after a 2s settle every segment holds its chassis-local rest pose to within 1cm', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createGroundBody(world);
			const vehicle = createVehicle(world, SPAWN);
			for (let i = 0; i < 120; i++) world.step(FIXED_DT, FIXED_SUBSTEPS);
			let worst = 0;
			for (const h of Object.values(vehicle.segments.bodies)) {
				const d = segmentLocalDisplacement(vehicle.chassis, h);
				const mag = Math.hypot(d.x, d.y, d.z);
				if (mag > worst) worst = mag;
			}
			console.log(`[segment-structure] worst rest-pose drift after 2s settle: ${(worst * 1000).toFixed(3)}mm`);
			expect(worst).toBeLessThan(0.01);
			destroyVehicle(vehicle);
		} finally {
			world.destroy();
		}
	});

	it('destroyVehicle() unregisters every segment body/shape/weld handle (no live-handle leak)', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createGroundBody(world);
			const before = liveHandleCount();
			const vehicle = createVehicle(world, SPAWN);
			expect(liveHandleCount()).toBeGreaterThan(before);
			destroyVehicle(vehicle);
			expect(liveHandleCount()).toBe(before);
		} finally {
			world.destroy();
		}
	});
});
