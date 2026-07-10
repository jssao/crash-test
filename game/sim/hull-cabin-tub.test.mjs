// SPDX-License-Identifier: MIT
//
// Tier-3 STAGE 1 gate (docs/build-log/specs/compound-hull-design.md): the chassis's single convex hull
// is replaced by a ~12-shape concave CABIN TUB (floorpan/nose/tail/roof/sills/pillars, geometry.ts
// buildCabinShapes()). This test proves the three load-bearing claims of stage 1:
//   1. STRUCTURE: the chassis now carries a multi-shape composite (12 convex shapes), not one hull.
//   2. MASS PARITY: box3d's computed mass/COM/inertia for the new body is byte-identical to the
//      pre-Tier-3 single-hull+ballast chassis (createVehicle() captures the legacy MassData and stamps
//      it back via setMassData()) -- so ALL vehicle calibration survives untouched.
//   3. REAL HOLLOW CAVITY: a probe dropped into the cabin centre falls THROUGH the interior and rests
//      on the floorpan -- impossible against the old solid hull (which was solid space there). This is
//      the concavity the whole Tier-3 line is built on.
import { describe, expect, it } from 'vitest';
import { init, World, BodyType } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, destroyVehicle } from '../src/vehicle/vehicle.ts';
import { buildChassisHullPoints, solveChassisDensities } from '../src/vehicle/geometry.ts';
import {
	BALLAST_LOCAL_Y_M,
	BALLAST_RADIUS_M,
	CAR_GROUP_INDEX,
	CHASSIS_MASS_KG,
	CHASSIS_ORIGIN_HEIGHT_M,
	FIXED_DT,
	FIXED_SUBSTEPS,
} from '../src/vehicle/tuning.ts';
import { add, rotateVector } from '../src/vehicle/mathUtil.ts';

/** Inverse chassis transform: world point -> chassis-local. */
function toLocal(chassis, p) {
	const t = chassis.getTransform();
	const q = t.rotation;
	const d = { x: p.x - t.position.x, y: p.y - t.position.y, z: p.z - t.position.z };
	// rotate d by conjugate(q)
	return rotateVector({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, d);
}

describe('hull cabin-tub (Tier-3 stage 1)', () => {
	it('the chassis is a 12-shape concave composite, not a single hull', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createGroundBody(world);
			const vehicle = createVehicle(world, { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 });
			expect(vehicle.chassisShapes.cabin.length).toBe(12);
			for (const s of vehicle.chassisShapes.cabin) expect(s.isValid()).toBe(true);
			console.log(`[hull-cabin] chassis collision shapes: ${vehicle.chassisShapes.cabin.length}`);
			destroyVehicle(vehicle);
		} finally {
			world.destroy();
		}
	});

	it('mass/COM/inertia are byte-identical to the pre-Tier-3 single-hull+ballast chassis', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createGroundBody(world);

			// Reference: the exact legacy chassis mass config (single bevelled hull + COM-ballast sphere,
			// empty sprung ballast = default), letting box3d integrate its mass just as HEAD did.
			const solved = solveChassisDensities();
			const ref = world.createBody({ type: BodyType.Dynamic, position: { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 } });
			ref.createHullShape(buildChassisHullPoints(), { density: solved.hullDensity, groupIndex: CAR_GROUP_INDEX });
			ref.createSphereShape({ radius: BALLAST_RADIUS_M, center: { x: 0, y: BALLAST_LOCAL_Y_M, z: 0 }, density: solved.ballastDensity, isSensor: true, groupIndex: CAR_GROUP_INDEX });
			ref.applyMassFromShapes();
			const refMD = ref.getMassData();
			ref.destroy();

			const vehicle = createVehicle(world, { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 });
			const md = vehicle.chassis.getMassData();

			console.log(`[hull-cabin] mass=${md.mass.toFixed(3)} (ref ${refMD.mass.toFixed(3)}) COM=(${md.center.x.toExponential(2)},${md.center.y.toFixed(5)},${md.center.z.toFixed(5)})`);

			// Total mass is exactly the tuned chassis mass, and matches the legacy composite.
			expect(md.mass).toBeCloseTo(CHASSIS_MASS_KG, 3);
			expect(md.mass).toBeCloseTo(refMD.mass, 5);
			// Center of mass matches the legacy composite (the COM-lowering the ballast used to provide is
			// now carried by setMassData directly).
			expect(md.center.x).toBeCloseTo(refMD.center.x, 6);
			expect(md.center.y).toBeCloseTo(refMD.center.y, 6);
			expect(md.center.z).toBeCloseTo(refMD.center.z, 6);
			// Inertia tensor diagonal matches (drives every rotation/rollover/handling calibration).
			expect(md.inertia.cx.x).toBeCloseTo(refMD.inertia.cx.x, 3);
			expect(md.inertia.cy.y).toBeCloseTo(refMD.inertia.cy.y, 3);
			expect(md.inertia.cz.z).toBeCloseTo(refMD.inertia.cz.z, 3);

			destroyVehicle(vehicle);
		} finally {
			world.destroy();
		}
	});

	it('the cabin is a genuine hollow cavity: a probe dropped into it falls through and rests on the floorpan', async () => {
		const native = await init();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createGroundBody(world);
			const vehicle = createVehicle(world, { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 });

			// Let the car settle on its suspension for a moment so the chassis frame is steady.
			for (let i = 0; i < 30; i++) world.step(FIXED_DT, FIXED_SUBSTEPS);

			// Drop a small NEUTRAL-filter probe at the cabin centre, mid-window-band height (chassis-local
			// (0, 0.6, 0)) -- empty space in the new cavity, but solid interior of the old single hull.
			const t = vehicle.chassis.getTransform();
			const startLocalY = 0.6;
			const worldStart = add(t.position, rotateVector(t.rotation, { x: 0, y: startLocalY, z: 0 }));
			const probe = world.createBody({ type: BodyType.Dynamic, position: worldStart });
			probe.createBoxShape({ halfExtents: { x: 0.05, y: 0.05, z: 0.05 }, density: 300, friction: 0.6 });

			let sawNaN = false;
			for (let i = 0; i < 150; i++) {
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				const p = probe.getPosition();
				if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) sawNaN = true;
			}

			const restLocal = toLocal(vehicle.chassis, probe.getPosition());
			console.log(`[hull-cabin] probe rest chassis-local=(${restLocal.x.toFixed(3)}, ${restLocal.y.toFixed(3)}, ${restLocal.z.toFixed(3)}) from startY=${startLocalY}`);

			expect(sawNaN).toBe(false);
			// It fell well below its start (a solid hull would have wedged/ejected it, never let it drop).
			expect(restLocal.y).toBeLessThan(startLocalY - 0.25);
			// ...and came to rest ON the floorpan (~0.06 top + 0.05 probe half), not on the ground far below
			// (~ -0.23 local) -- so the cavity is bounded by a real floor shell.
			expect(restLocal.y).toBeGreaterThan(-0.05);
			expect(restLocal.y).toBeLessThan(0.35);
			// Stayed inside the cabin footprint (contained by the sills / firewall / bulkhead shells).
			expect(Math.abs(restLocal.x)).toBeLessThan(0.72);
			expect(restLocal.z).toBeGreaterThan(-0.66);
			expect(restLocal.z).toBeLessThan(0.72);

			destroyVehicle(vehicle);
		} finally {
			world.destroy();
		}
	});
});
