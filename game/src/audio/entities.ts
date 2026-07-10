// SPDX-License-Identifier: MIT
//
// Read-only lookup of which entity ids (Body/Shape userData) are car parts, for classifying hit/
// contact events as "touches the car" without owning any of the shape-creation sites that assign these
// ids (see STRICT OWNERSHIP -- this worker owns game/src/audio/** + a surgical main.ts wiring only).
// Imports the EXISTING numeric conventions from vehicle.ts (CAR_ENTITY_ID) and damage/panels.ts
// (PANEL_ENTITY_ID) rather than redefining them.

import { CAR_ENTITY_ID } from '../vehicle/vehicle';
import { PANEL_ENTITY_ID } from '../damage/panels';

/** Every entity id that identifies a car part: chassis, all 4 wheels, all 4 damage panels (attached OR
 * detached/broken -- PANEL_ENTITY_ID is stable across breakPanelWeld()'s shape destroy+recreate, see
 * that function's doc comment in damage/panels.ts). Static across vehicle resets/panel breaks: the
 * numeric ids themselves never change, only which live body/shape currently holds one -- safe to
 * compute once at module load rather than re-deriving per vehicle instance. */
export const CAR_PART_ENTITY_IDS: ReadonlySet<number> = new Set<number>([
	CAR_ENTITY_ID.chassis,
	...Object.values(CAR_ENTITY_ID.wheel),
	...Object.values(PANEL_ENTITY_ID),
]);

export function isCarEntity(id: number): boolean {
	return CAR_PART_ENTITY_IDS.has(id);
}

/** True when EXACTLY one side of a hit/contact pair is a car part (i.e. car-vs-world). Car-vs-car
 * never fires for chassis/wheels/attached-panels (CAR_GROUP_INDEX excludes self-collision -- see
 * vehicle/tuning.ts's doc comment); a detached/broken panel touching another car part is rare/
 * inconsequential enough not to special-case here. */
export function isCarVsWorld(idA: number, idB: number): boolean {
	return isCarEntity(idA) !== isCarEntity(idB);
}
