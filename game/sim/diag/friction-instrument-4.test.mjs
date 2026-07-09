// DIAGNOSTIC ONLY, cleanest causal isolation: uses Shape.setFilter() (runtime collision filter,
// SHIMEXT) to disable ONLY panel<->ground collision RESPONSE, changing nothing else (weld intact,
// mass unchanged, panel geometry/position unchanged -- panels still physically overlap the ground
// zone exactly as before, they just no longer generate a contact response there). If this alone
// recovers the straight-line acceleration deficit, it is conclusive proof the panel<->ground contact
// (not e.g. some panel-mass/weld-reaction side effect) is the parasitic-drag mechanism.
import { describe, it } from 'vitest';
import { init, World, BodyType } from '../../../src/ts/index.ts';
import { createVehicle, stepVehicle, getTelemetry } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, GROUND_FRICTION } from '../../src/vehicle/tuning.ts';
import { PANEL_KEYS } from '../../src/damage/panels.ts';

const GROUND_CATEGORY_BIT = 1n << 5n; // arbitrary distinct bit, only used in this isolated test world
const ALL_BITS = 0xffffffffffffffffn;

async function run(excludePanelsFromGround) {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	// Custom ground: tags its shape with a distinct category bit so panel shapes can selectively
	// exclude it via maskBits, while chassis/wheels (default mask = ALL_BITS) still collide with it
	// normally.
	const ground = world.createBody({ type: BodyType.Static, position: { x: 0, y: -0.5, z: 0 } });
	ground.createBoxShape({
		halfExtents: { x: 1000, y: 0.5, z: 1000 },
		friction: GROUND_FRICTION,
		density: 1,
		categoryBits: GROUND_CATEGORY_BIT,
		maskBits: ALL_BITS,
	});
	const vehicle = createVehicle(world);

	if (excludePanelsFromGround) {
		for (const key of PANEL_KEYS) {
			const p = vehicle.panels[key];
			p.shape.setFilter({ categoryBits: ALL_BITS, maskBits: ALL_BITS & ~GROUND_CATEGORY_BIT, groupIndex: p.shape.getFilter().groupIndex }, true);
		}
	}

	for (let i = 0; i < 300; i++) {
		stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
	}
	const t = getTelemetry(vehicle);
	world.destroy();
	return t;
}

describe('diag: friction instrument 4 (clean causal isolation via runtime collision filter)', () => {
	it('5s full-throttle straight-line: panel-ground collision ENABLED (baseline-equivalent) vs DISABLED (filter only)', async () => {
		const withContact = await run(false);
		const withoutContact = await run(true);
		console.log(
			`[filter-isolation] panels DO collide with ground: speed@5s=${withContact.speedKmh.toFixed(1)}km/h disp=${withContact.chassisPos.z.toFixed(2)}m`,
		);
		console.log(
			`[filter-isolation] panels EXCLUDED from ground (filter only, weld/mass/position unchanged): speed@5s=${withoutContact.speedKmh.toFixed(1)}km/h disp=${withoutContact.chassisPos.z.toFixed(2)}m`,
		);
		console.log(`[filter-isolation] delta = ${(withoutContact.speedKmh - withContact.speedKmh).toFixed(2)}km/h`);
	});
});
