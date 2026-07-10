// SPDX-License-Identifier: MIT
//
// Collects the car shapes the scrape-audio loop needs contactBeginEvents/contactEndEvents from --
// chassis hull + all 4 (still-attached) damage panels. Deliberately EXCLUDES wheel shapes: a wheel is
// continuously touching the ground for the entire time the car is driving normally (that's ordinary
// rolling contact, not a "scrape"), so arming wheels here would make the scrape voice spuriously
// "active" from the moment the car spawns on its suspension -- tire noise is its own, separately-
// modeled SKID voice (engine.ts), driven by slip telemetry instead of contact events. The chassis
// hull/panels, by contrast, do NOT normally touch anything while driving (CHASSIS_ORIGIN_HEIGHT_M
// keeps the hull above the wheels) -- a chassis/panel-vs-world contact really is an exceptional
// scrape/grind/rollover event, exactly what this loop should react to.
//
// Read-only: this worker (skids-audio, see STRICT OWNERSHIP) doesn't create these shapes, but
// Shape.enableContactEvents() is a runtime opt-in (src/ts/shape.ts) that only needs ONE side of a
// contact enabled to report events (vendor/box3d/src/contact.c:246) -- so main.ts can arm the CAR side
// every step without touching vehicle.ts/damage/panels.ts at all.

import type { Shape } from '../../../src/ts/index.js';
import type { Vehicle } from '../vehicle/vehicle';
import type { DamageSystem } from '../damage/system';
import { PANEL_KEYS } from '../damage/panels';

/** Re-collected fresh every fixed step (see main.ts's doFixedStep) rather than cached once: doCarRepair()
 * destroys+recreates the whole vehicle/damage system, and breakPanelWeld() destroys+recreates an
 * individual panel's Shape object on break (damage/panels.ts) -- a cached Shape reference would go
 * stale (and lose its contact-events flag) across either event. enableContactEvents() itself is
 * idempotent and cheap (a single flag set), so re-arming every step is negligible. */
export function collectCarShapes(vehicle: Vehicle, damageSystem: DamageSystem): Shape[] {
	// Tier-3: the chassis is now the concave cabin-tub decomposition (~12 convex shapes), not one hull --
	// arm contact events on every exterior cabin shape so a scrape/grind/rollover on ANY face still voices.
	const shapes: Shape[] = [...vehicle.chassisShapes.cabin];
	for (const key of PANEL_KEYS) {
		const panel = damageSystem.panels[key];
		if (!panel.despawned) shapes.push(panel.shape);
	}
	return shapes;
}
