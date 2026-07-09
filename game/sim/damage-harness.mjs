// SPDX-License-Identifier: MIT
//
// Headless damage-test harness: extends harness.mjs's Sim with the damage system (panels are already
// part of createVehicle() -- see vehicle.ts's doc comment) + a handful of synthetic "deformable mesh"
// proxies standing in for the real GLB shell/panel meshes the browser registers (game/src/scene/
// carDeformables.ts) -- there's no three.js/GLTFLoader available in plain node, so these proxies use
// crumple.ts's buildGridPlane() to approximate the chassis front shell + each of the 5 panels' own
// footprint, in the SAME local-space convention the real browser registration will use (chassis-shell
// proxies in chassis-local space, panel proxies in their own panel-body-local space).

import { Sim, loadNative } from './harness.mjs';
import { FIXED_DT } from '../src/vehicle/tuning.ts';
import {
	CAR_HEIGHT_M,
	CAR_WIDTH_M,
	CHASSIS_ORIGIN_HEIGHT_M,
	GROUND_CLEARANCE_M,
} from '../src/vehicle/tuning.ts';
import { createDamageSystem, stepDamageSystem, registerDeformable, getDamageTelemetry } from '../src/damage/system.ts';
import { spawnTestWall, crashSetup } from '../src/damage/scenario.ts';
import { buildGridPlane } from '../src/damage/crumple.ts';
import { PANEL_KEYS } from '../src/damage/panels.ts';
import { PANEL_THICKNESS_AXIS } from '../src/damage/damage-tuning.ts';

const HULL_BOTTOM_Y_M = -CHASSIS_ORIGIN_HEIGHT_M + GROUND_CLEARANCE_M;
const HULL_TOP_Y_M = CAR_HEIGHT_M - CHASSIS_ORIGIN_HEIGHT_M;
const HULL_FRONT_Z_M = 2.1; // just inside the hull's actual front-most vertex (see geometry.ts's HULL_BOTTOM_HALF_LENGTH_M)

function footprintAxesFor(thicknessAxis) {
	return thicknessAxis === 'x' ? ['y', 'z'] : ['x', 'z'];
}

export class DamageSim extends Sim {
	constructor(native, spawnPosition) {
		super(native, spawnPosition);
		this.damage = createDamageSystem(this.vehicle);
		this._registerDefaultDeformables();
	}

	_registerDefaultDeformables() {
		// Chassis front-shell proxy (chassis-local space) -- where a frontal crash actually lands.
		const chassisFront = buildGridPlane({
			center: { x: 0, y: (HULL_BOTTOM_Y_M + HULL_TOP_Y_M) / 2, z: HULL_FRONT_Z_M },
			halfU: CAR_WIDTH_M / 2,
			halfV: (HULL_TOP_Y_M - HULL_BOTTOM_Y_M) / 2,
			axisU: 'x',
			axisV: 'y',
			segsU: 10,
			segsV: 6,
		});
		registerDeformable(this.damage, 'chassis-front', 'chassis', 'chassis', chassisFront.positions, chassisFront.indices);

		// One grid-plane proxy per panel, in that panel body's OWN local space (center = body origin,
		// spanning its two non-thickness axes) -- matches how the browser will register each panel's
		// own mesh(es), which move with the panel body always (crumple.ts's registerDeformable doc).
		for (const key of PANEL_KEYS) {
			const panel = this.vehicle.panels[key];
			const [axisU, axisV] = footprintAxesFor(PANEL_THICKNESS_AXIS[key]);
			const halfU = panel.halfExtents[axisU];
			const halfV = panel.halfExtents[axisV];
			const grid = buildGridPlane({ center: { x: 0, y: 0, z: 0 }, halfU, halfV, axisU, axisV, segsU: 6, segsV: 6 });
			registerDeformable(this.damage, `panel-${key}`, 'panel', key, grid.positions, grid.indices);
		}
	}

	step(input) {
		super.step(input);
		stepDamageSystem(this.damage, this.world, FIXED_DT);
	}

	spawnWall(distanceAhead = 25) {
		return spawnTestWall(this.world, this.vehicle, distanceAhead);
	}

	crash(speedKmh) {
		crashSetup(this.vehicle, speedKmh);
	}

	damageTelemetry() {
		return getDamageTelemetry(this.damage);
	}
}

export async function createDamageSim(spawnPosition) {
	const native = await loadNative();
	return new DamageSim(native, spawnPosition);
}
