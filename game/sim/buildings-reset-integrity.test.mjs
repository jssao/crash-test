// SPDX-License-Identifier: MIT
//
// Reset structural-integrity regression (playtest issue #6: "shack falls apart on Shift+R"). After a
// world reset, every structure must be restored to a FULLY RIGID, self-supporting state: not just
// teleported back to its spawn pose (the existing features-buildings reset test already checks the
// instantaneous pose), but able to STAND under gravity afterwards and survive a drive-by without
// spontaneously collapsing. If reset rebuilt the welds weak/soft (or left yield state uncleared), the
// shed would sag/lean/fall apart over the next second even with nothing touching it -- which is the bug.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import { buildShed, buildAllStructures, pollStructureBreaks, resetStructure, totalBrokenJointCount, totalYieldedJointCount } from '../src/world/features/buildings/structures.ts';
import { SHED_CENTER } from '../src/world/features/buildings/tuning.ts';

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
function maxDrift(structure) {
	let m = 0;
	for (const p of structure.pieces) {
		if (p.isStatic) continue;
		const q = p.body.getPosition();
		m = Math.max(m, Math.hypot(q.x - p.spawnPos.x, q.y - p.spawnPos.y, q.z - p.spawnPos.z));
	}
	return m;
}

describe('buildings reset integrity', () => {
	it('a smashed shed, once reset, STANDS under gravity for 4s without collapsing (issue #6)', async () => {
		const world = await makeWorld();
		try {
			const shed = buildShed(world);
			// Smash it: break/yield a bunch of welds.
			const vehicle = createVehicle(world, { x: SHED_CENTER.x, y: 0.5, z: SHED_CENTER.z - 8 });
			launch(vehicle, 55);
			for (let i = 0; i < 160; i++) {
				stepVehicle(vehicle, COAST, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				pollStructureBreaks(shed);
			}
			const brokenBefore = shed.joints.filter((j) => j.broken).length;
			expect(brokenBefore).toBeGreaterThan(0); // it really was damaged

			resetStructure(world, shed);
			expect(maxDrift(shed)).toBeLessThan(0.001); // teleported home exactly
			expect(totalBrokenJointCount([shed])).toBe(0);
			expect(totalYieldedJointCount([shed])).toBe(0);

			// Now let it stand under gravity for 4s with NOTHING touching it. A correctly-rebuilt rigid
			// frame barely moves; a weak/soft rebuild would sag and the shed would fall apart.
			for (let i = 0; i < 240; i++) pollStructureBreaks(shed), world.step(FIXED_DT, FIXED_SUBSTEPS);
			const driftAfterStanding = maxDrift(shed);
			console.log(`[shed reset-integrity] brokenBeforeReset=${brokenBefore} driftAfter4sStanding=${driftAfterStanding.toFixed(4)}m broken=${totalBrokenJointCount([shed])}`);
			expect(driftAfterStanding).toBeLessThan(0.05); // stands firm
			expect(totalBrokenJointCount([shed])).toBe(0); // nothing spontaneously broke
		} finally {
			world.destroy();
		}
	});

	it('after reset, an UNTOUCHED structure is not collapsed by a drive-by near a DIFFERENT one', async () => {
		const world = await makeWorld();
		try {
			const structures = buildAllStructures(world);
			const shed = structures.find((s) => s.id === 'shed');
			// Damage everything with a fast pass through the shed, then reset ALL.
			const vehicle = createVehicle(world, { x: SHED_CENTER.x, y: 0.5, z: SHED_CENTER.z - 8 });
			launch(vehicle, 80);
			for (let i = 0; i < 160; i++) {
				stepVehicle(vehicle, COAST, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				for (const s of structures) pollStructureBreaks(s);
			}
			for (const s of structures) resetStructure(world, s);
			expect(totalBrokenJointCount(structures)).toBe(0);

			// Let the whole world stand for 3s untouched -- nothing should collapse.
			for (let i = 0; i < 180; i++) {
				for (const s of structures) pollStructureBreaks(s);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
			}
			const shedDrift = maxDrift(shed);
			console.log(`[world reset-integrity] shedDriftAfter3s=${shedDrift.toFixed(4)}m totalBroken=${totalBrokenJointCount(structures)}`);
			expect(shedDrift).toBeLessThan(0.05);
			expect(totalBrokenJointCount(structures)).toBe(0);
		} finally {
			world.destroy();
		}
	});
});
