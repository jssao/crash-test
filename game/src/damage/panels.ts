// SPDX-License-Identifier: MIT
//
// Damage-system panel bodies (G3 spec): 5 thin box hulls (car-map.ts panel bboxes, forced to a 5cm
// thickness on their "thin" axis -- see damage-tuning.ts's PANEL_THICKNESS_AXIS doc comment), each
// welded RIGIDLY to the chassis. Renderer-free (no three/DOM import) -- called from vehicle.ts's
// createVehicle() so panels are part of the core vehicle assembly shared by the browser game and the
// headless sim harness alike (game/sim/harness.mjs), same as chassis/wheels.

import { Body, BodyType, Shape, World, WeldJoint } from '../../../src/ts/index.js';
import { add, IDENTITY_Q, rotateVector, type Q4, type V3 } from '../vehicle/mathUtil';
import { CAR_GROUP_INDEX, CHASSIS_ORIGIN_HEIGHT_M } from '../vehicle/tuning';
import { CAR_MAP, type Vec3Mm } from '../assets/car-map';
import { PANEL_FRICTION, PANEL_HALF_THICKNESS_M, PANEL_MASS_KG, PANEL_THICKNESS_AXIS } from './damage-tuning';

export type PanelKey = 'hood' | 'doorL' | 'doorR' | 'hatch' | 'roof';

export const PANEL_KEYS: readonly PanelKey[] = ['hood', 'doorL', 'doorR', 'hatch', 'roof'];

/** car-map.ts node name for each panel (see car-map.ts's `panels` record). */
export const PANEL_NODE_NAMES: Record<PanelKey, string> = {
	hood: 'BodyHood',
	doorL: 'BodyDoorLColor1',
	doorR: 'BodyDoorRColor1',
	hatch: 'InteriorRearHatch',
	roof: 'BodyRoofPanel',
};

/**
 * Entity ids tagged on panel bodies/shapes (Body/Shape userData), read back via hit events'
 * userDataA/userDataB (src/ts/events.ts's HitEventCursor). Deliberately NOT imported from vehicle.ts
 * (that would create a vehicle.ts <-> panels.ts import cycle, since vehicle.ts's createVehicle()
 * calls createPanels() below) -- kept in a disjoint numeric range (6-10) by convention; vehicle.ts's
 * CAR_ENTITY_ID doc comment cross-references this range (1 = chassis, 2-5 = wheels).
 */
export const PANEL_ENTITY_ID: Record<PanelKey, number> = {
	hood: 6,
	doorL: 7,
	doorR: 8,
	hatch: 9,
	roof: 10,
};

/** Same mm->local-meters conversion as vehicle.ts's (private) mmToLocalMount() -- kept as an
 * independent copy rather than importing vehicle.ts's version, to avoid a vehicle.ts <-> panels.ts
 * import cycle (vehicle.ts's createVehicle() calls createPanels() below). */
function mmToLocalCenter(centerMm: Vec3Mm): V3 {
	return {
		x: centerMm[0] / 1000,
		y: centerMm[1] / 1000 - CHASSIS_ORIGIN_HEIGHT_M,
		z: centerMm[2] / 1000,
	};
}

/** Footprint from the measured bbox, with the panel's "thin" axis forced to PANEL_HALF_THICKNESS_M
 * (damage-tuning.ts's PANEL_THICKNESS_AXIS doc comment explains why the raw measured value on that
 * axis is not used directly). */
function panelHalfExtents(key: PanelKey, sizeMm: Vec3Mm): V3 {
	const half: V3 = { x: sizeMm[0] / 2000, y: sizeMm[1] / 2000, z: sizeMm[2] / 2000 };
	half[PANEL_THICKNESS_AXIS[key]] = PANEL_HALF_THICKNESS_M;
	return half;
}

export interface PanelHandle {
	readonly key: PanelKey;
	body: Body;
	shape: Shape;
	/** Non-null while attached/loosened; null once broken (weld destroyed) -- LOOSEN itself keeps the
	 * same joint object (softened in place via the runtime hertz/damping setters), see
	 * loosenPanelWeld(). */
	weldJoint: WeldJoint | null;
	/** Chassis-local mount point (== this panel body's local offset from the chassis origin at spawn). */
	readonly localCenter: V3;
	readonly halfExtents: V3;
	readonly massKg: number;
	readonly density: number;
	state: 'attached' | 'loosened' | 'broken';
	/** Accumulated event-driven stress (game/src/damage/welds.ts). */
	stress: number;
	/** Sim-time (seconds) this panel broke, or null if still attached/loosened. */
	breakTimeSec: number | null;
	hitEventsDisabled: boolean;
	despawned: boolean;
}

/**
 * Creates the 5 damage-system panel bodies, each welded RIGIDLY to the chassis (weld hertz 0 ==
 * "maximum stiffness" -- confirmed in vendor/box3d/include/box3d/box3d.h's b3WeldJoint_SetLinearHertz
 * doc comment: "0 is rigid" -- NOT a degenerate/disabled spring). Called from vehicle.ts's
 * createVehicle(): panels are part of the core vehicle assembly (not a separate opt-in step) because
 * the spec requires total car mass to stay ~unchanged with panels included, which only holds if every
 * vehicle -- including the 5 pre-existing headless drive tests -- gets panels too (see tuning.ts's
 * CHASSIS_MASS_KG doc comment for the mass-conservation arithmetic).
 */
export function createPanels(world: World, chassis: Body, spawnPosition: V3, spawnRotation: Q4): Record<PanelKey, PanelHandle> {
	const result = {} as Record<PanelKey, PanelHandle>;
	for (const key of PANEL_KEYS) {
		const node = CAR_MAP.panels[PANEL_NODE_NAMES[key]];
		const localCenter = mmToLocalCenter(node.centerMm);
		const halfExtents = panelHalfExtents(key, node.sizeMm);
		const massKg = PANEL_MASS_KG[key];
		const volume = 8 * halfExtents.x * halfExtents.y * halfExtents.z;
		const density = massKg / volume;

		const worldPos = add(spawnPosition, rotateVector(spawnRotation, localCenter));
		const body = world.createBody({
			type: BodyType.Dynamic,
			position: worldPos,
			rotation: spawnRotation,
			userData: PANEL_ENTITY_ID[key],
		});
		const shape = body.createBoxShape({
			halfExtents,
			density,
			friction: PANEL_FRICTION,
			enableHitEvents: true,
			groupIndex: CAR_GROUP_INDEX,
			userData: PANEL_ENTITY_ID[key],
		});

		const weldJoint = world.createWeldJoint(chassis, body, {
			frameA: { position: localCenter, rotation: IDENTITY_Q },
			frameB: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_Q },
			collideConnected: false,
			linearHertz: 0,
			angularHertz: 0,
			linearDampingRatio: 1,
			angularDampingRatio: 1,
		});

		result[key] = {
			key,
			body,
			shape,
			weldJoint,
			localCenter,
			halfExtents,
			massKg,
			density,
			state: 'attached',
			stress: 0,
			breakTimeSec: null,
			hitEventsDisabled: false,
			despawned: false,
		};
	}
	return result;
}

/** LOOSEN: soften the intact weld IN PLACE via the runtime hertz/damping-ratio setters (src/ts/
 * joint.ts's WeldJoint.setLinearHertz/setAngularHertz/setLinearDampingRatio/setAngularDampingRatio --
 * wired for this feature, see src/wasm-shim/binding.c) -- NOT destroy+recreate. */
export function loosenPanelWeld(panel: PanelHandle, hertz: number, dampingRatio: number): void {
	if (!panel.weldJoint) return;
	panel.weldJoint.setLinearHertz(hertz);
	panel.weldJoint.setAngularHertz(hertz);
	panel.weldJoint.setLinearDampingRatio(dampingRatio);
	panel.weldJoint.setAngularDampingRatio(dampingRatio);
	panel.state = 'loosened';
}

/** BREAK: destroy the weld outright, then destroy+recreate the panel's shape with a NEUTRAL filter
 * (groupIndex 0) so the now-free panel body can hit the car and the world (it was previously immune
 * to car-vs-car collision via CAR_GROUP_INDEX -- see tuning.ts's doc comment). The panel BODY persists
 * (free, simulated, per spec) -- only the shape is swapped, preserving the same box geometry/density
 * so mass is conserved (Body.createBoxShape() recomputes body mass from ALL current shapes each call --
 * see vehicle.ts's createVehicle() note on b3UpdateBodyMassData). */
export function breakPanelWeld(panel: PanelHandle): void {
	if (panel.weldJoint) {
		panel.weldJoint.destroy();
		panel.weldJoint = null;
	}
	panel.shape.destroy(false); // skip the pointless mass recompute with zero shapes momentarily
	panel.shape = panel.body.createBoxShape({
		halfExtents: panel.halfExtents,
		density: panel.density,
		friction: PANEL_FRICTION,
		enableHitEvents: true,
		groupIndex: 0, // neutral filter: can now hit the car + world
		userData: PANEL_ENTITY_ID[panel.key],
	});
	panel.state = 'broken';
}

export function totalPanelMassKg(panels: Record<PanelKey, PanelHandle>): number {
	let sum = 0;
	for (const key of PANEL_KEYS) sum += panels[key].body.getMass();
	return sum;
}

/** Repositions every still-`attached` panel back to its rigid mount point (mirrors vehicle.ts's
 * resetVehicle() doing the same for wheel bodies). Panels already `loosened`/`broken` are left alone
 * -- full damage repair-on-reset is a known scope cut (matching the equivalent decision for a
 * detached wheel joint in vehicle.ts's resetVehicle()). */
export function resetAttachedPanels(panels: Record<PanelKey, PanelHandle>, spawnPosition: V3, spawnRotation: Q4): void {
	for (const key of PANEL_KEYS) {
		const panel = panels[key];
		if (panel.state !== 'attached') continue;
		const worldPos = add(spawnPosition, rotateVector(spawnRotation, panel.localCenter));
		panel.body.setTransform(worldPos, spawnRotation);
		panel.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		panel.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		panel.body.setAwake(true);
	}
}
