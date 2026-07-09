// SPDX-License-Identifier: MIT
//
// Weld stress model (G3 spec) + wheel detach. Per fixed step: (1) poll each intact panel weld's
// constraint-force magnitude (direct force-spike trigger), (2) accumulate event-driven stress from
// nearby qualifying hit events (falls off with distance from the panel centroid), loosening/breaking
// whichever trigger fires first, and (3) poll each intact wheel joint's constraint force, detaching a
// wheel outright on a big enough spike. Renderer-free (no three/DOM import).

import { length, sub, type V3 } from '../vehicle/mathUtil';
import { GRAVITY_MAG } from '../vehicle/tuning';
import { CAR_ENTITY_ID, type Vehicle, type WheelKey } from '../vehicle/vehicle';
import {
	PANEL_BREAK_FORCE_MULT,
	PANEL_LOOSEN_FORCE_MULT,
	LOOSEN_DAMPING_RATIO,
	LOOSEN_HERTZ,
	STRESS_BREAK_S2,
	STRESS_K,
	STRESS_LOOSEN_S1,
	STRESS_MIN_APPROACH_SPEED_MS,
	STRESS_RADIUS_M,
	WHEEL_DETACH_DEBOUNCE_STEPS,
	WHEEL_DETACH_FORCE_MULT,
} from './damage-tuning';
import { breakPanelWeld, loosenPanelWeld, PANEL_ENTITY_ID, PANEL_KEYS, type PanelHandle, type PanelKey } from './panels';
import type { DamageEvent } from './events';

/**
 * Distance falloff for the ACCUMULATED-STRESS model specifically -- deliberately gentler than
 * crumple.ts's smoothFalloff() (a steeper smoothstep cubic used for the visual dent radius), so a
 * panel meaningfully farther from the literal impact point (e.g. a door, ~2m from a nose impact, vs.
 * the hood's ~0.5m) still accumulates a non-negligible share of stress at high crash energy -- with
 * the steeper smoothstep curve, the doors' share was too small at ANY speed to ever independently
 * cross STRESS_BREAK_S2, making ">=2 broken" at high speed (game/sim/damage-threshold-ordering.
 * test.mjs) depend entirely on rare/chaotic secondary contacts rather than the panel's own proximity-
 * scaled stress. A plain quadratic falloff (1-t)^2 is still smooth (C0, continuous derivative-adjacent
 * enough for this non-visual purpose) and roughly doubles the far-panel share at t~0.8-0.9 relative to
 * the cubic smoothstep, without perceptibly changing the near-panel (hood) share used to calibrate
 * STRESS_LOOSEN_S1/STRESS_BREAK_S2 against the moderate-impact test.
 */
function stressFalloff(t: number): number {
	const c = t < 0 ? 0 : t > 1 ? 1 : t;
	const inv = 1 - c;
	return inv * inv;
}

export interface HitEventLike {
	userDataA: number;
	userDataB: number;
	point: V3;
	normal: V3;
	approachSpeed: number;
}

function isCarPanelId(id: number): PanelKey | null {
	for (const key of PANEL_KEYS) {
		if (PANEL_ENTITY_ID[key] === id) return key;
	}
	return null;
}

/** True if either side of a hit event is the chassis or a not-yet-broken panel (see crumple.ts's
 * applyCrumpleEvent doc comment for why "attached panel" includes `loosened`, not just `attached`). */
export function hitTouchesCar(hit: HitEventLike, panels: Record<PanelKey, PanelHandle>): boolean {
	const idsToCheck = [hit.userDataA, hit.userDataB];
	for (const id of idsToCheck) {
		if (id === CAR_ENTITY_ID.chassis) return true;
		const panelKey = isCarPanelId(id);
		if (panelKey && panels[panelKey].state !== 'broken') return true;
	}
	return false;
}

function escalatePanel(panel: PanelHandle, shouldBreak: boolean, shouldLoosen: boolean, timeSec: number, emit: (e: DamageEvent) => void): void {
	if (shouldBreak) {
		if (panel.state !== 'broken') {
			breakPanelWeld(panel);
			panel.breakTimeSec = timeSec;
			emit({ type: 'panelBroken', panel: panel.key });
		}
		return;
	}
	if (shouldLoosen && panel.state === 'attached') {
		loosenPanelWeld(panel, LOOSEN_HERTZ, LOOSEN_DAMPING_RATIO);
		emit({ type: 'panelLoosened', panel: panel.key });
	}
}

export interface WeldStepArgs {
	vehicle: Vehicle;
	panels: Record<PanelKey, PanelHandle>;
	hits: readonly HitEventLike[];
	/** Total car mass (kg), used to scale the wheel-detach force threshold (per-wheel weight share). */
	carMassKg: number;
	/** Sim-time (seconds) as of this step, stamped onto a panel's breakTimeSec when it breaks (see
	 * system.ts's despawn-timer logic). */
	timeSec: number;
	/** Per-wheel consecutive-steps-over-threshold counters (owned by the DamageSystem, persisted
	 * across steps) -- see damage-tuning.ts's WHEEL_DETACH_DEBOUNCE_STEPS doc comment. */
	wheelOverThresholdSteps: Record<WheelKey, number>;
	emit: (event: DamageEvent) => void;
}

/**
 * Advances the weld stress model + wheel detach for one fixed step. Call AFTER world.step() (so
 * getConstraintForce() reflects this step's solve) with this step's hit events already drained (see
 * system.ts's stepDamageSystem() -- the ONE central world.hitEvents() drain per step).
 */
export function stepWeldsAndWheels(args: WeldStepArgs): void {
	const { vehicle, panels, hits, carMassKg, timeSec, wheelOverThresholdSteps, emit } = args;

	// ---- 1) Direct weld constraint-force spike ----
	for (const key of PANEL_KEYS) {
		const panel = panels[key];
		if (panel.state === 'broken' || !panel.weldJoint) continue;
		const forceMag = length(panel.weldJoint.getConstraintForce());
		const weightN = panel.massKg * GRAVITY_MAG;
		escalatePanel(panel, forceMag > PANEL_BREAK_FORCE_MULT * weightN, forceMag > PANEL_LOOSEN_FORCE_MULT * weightN, timeSec, emit);
	}

	// ---- 2) Accumulated event-driven stress (nearby qualifying hits) ----
	for (const hit of hits) {
		if (hit.approachSpeed <= STRESS_MIN_APPROACH_SPEED_MS) continue;
		if (!hitTouchesCar(hit, panels)) continue;
		for (const key of PANEL_KEYS) {
			const panel = panels[key];
			if (panel.state === 'broken') continue;
			const centroid = panel.body.getPosition();
			const dist = length(sub(hit.point, centroid));
			if (dist > STRESS_RADIUS_M) continue;
			panel.stress += STRESS_K * hit.approachSpeed * stressFalloff(dist / STRESS_RADIUS_M);
		}
	}
	for (const key of PANEL_KEYS) {
		const panel = panels[key];
		if (panel.state === 'broken') continue;
		escalatePanel(panel, panel.stress > STRESS_BREAK_S2, panel.stress > STRESS_LOOSEN_S1, timeSec, emit);
	}

	// ---- 3) Wheel detach (debounced -- see WHEEL_DETACH_DEBOUNCE_STEPS's doc comment) ----
	const perWheelWeightShareN = (carMassKg * GRAVITY_MAG) / 4;
	const wheelDetachForceN = WHEEL_DETACH_FORCE_MULT * perWheelWeightShareN;
	for (const key of Object.keys(vehicle.wheels) as WheelKey[]) {
		const wheel = vehicle.wheels[key];
		if (!wheel.joint) continue;
		const forceMag = length(wheel.joint.getConstraintForce());
		if (forceMag > wheelDetachForceN) {
			wheelOverThresholdSteps[key] = (wheelOverThresholdSteps[key] ?? 0) + 1;
		} else {
			wheelOverThresholdSteps[key] = 0;
		}
		if (wheelOverThresholdSteps[key] >= WHEEL_DETACH_DEBOUNCE_STEPS) {
			wheel.joint.destroy();
			wheel.joint = null;
			emit({ type: 'wheelDetached', i: key });
		}
	}
}
