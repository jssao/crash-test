// SPDX-License-Identifier: MIT
//
// Weld stress model (G3 spec) + wheel detach. Per fixed step: (1) poll each intact panel weld's
// constraint-force magnitude (direct force-spike trigger), (2) accumulate event-driven stress from
// nearby qualifying hit events (falls off with distance from the panel centroid), loosening/breaking
// whichever trigger fires first, and (3) poll each intact wheel joint's constraint force, detaching a
// wheel outright on a big enough spike. Renderer-free (no three/DOM import).

import { length, sub, type Q4, type V3 } from '../vehicle/mathUtil';
import { GRAVITY_MAG } from '../vehicle/tuning';
import { CAR_ENTITY_ID, type Vehicle, type WheelKey } from '../vehicle/vehicle';
import {
	PANEL_BREAK_FORCE_MULT,
	PANEL_LOOSEN_FORCE_MULT,
	PANEL_VULNERABILITY,
	LOOSEN_DAMPING_RATIO,
	LOOSEN_HERTZ,
	STRESS_BREAK_S2,
	STRESS_K,
	STRESS_LOOSEN_S1,
	STRESS_MAX_NORMAL_UP_COMPONENT,
	STRESS_MIN_APPROACH_SPEED_MS,
	STRESS_RADIUS_M,
	WHEEL_DETACH_DEBOUNCE_STEPS,
	WHEEL_DETACH_FORCE_MULT,
	type PanelVulnerability,
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

/** Inverse-rotates a world-space vector into a body's local frame given the body's rotation (rotate by
 * the conjugate quaternion) -- used to express a hit's direction in CHASSIS-LOCAL axes so the
 * direction-aware panel vulnerability model can tell a frontal (+Z) from a side (+/-X) impact. Kept
 * local here rather than importing (same pattern as system.ts's private rotate()). */
function rotateByConjugate(q: Q4, v: V3): V3 {
	const cx = -q.x;
	const cy = -q.y;
	const cz = -q.z;
	const cw = q.w;
	const t = { x: 2 * (cy * v.z - cz * v.y), y: 2 * (cz * v.x - cx * v.z), z: 2 * (cx * v.y - cy * v.x) };
	return {
		x: v.x + cw * t.x + (cy * t.z - cz * t.y),
		y: v.y + cw * t.y + (cz * t.x - cx * t.z),
		z: v.z + cw * t.z + (cx * t.y - cy * t.x),
	};
}

/**
 * Directional stress multiplier in [floor, 1] for one panel given the impact's CHASSIS-LOCAL unit
 * direction (chassis origin -> impact point). Alignment = how much the impact comes from the axis the
 * panel is weak against (|component|, or the signed sense for a one-sided panel like the rear hatch),
 * sharpened by the panel's exponent; `floor` guarantees a minimum (1 for the frontal-weak hood =
 * unchanged behaviour, 0 for doors so a pure frontal contributes nothing toward tearing them off).
 * See damage-tuning.ts's PANEL_VULNERABILITY + crash-deformation-reference.md.
 */
export function panelDirectionalFactor(vuln: PanelVulnerability, dirLocal: V3): number {
	const component = dirLocal[vuln.axis];
	const aligned = vuln.signed === 0 ? Math.abs(component) : Math.max(0, vuln.signed * component);
	const sharpened = Math.pow(aligned < 0 ? 0 : aligned > 1 ? 1 : aligned, vuln.sharpness);
	return vuln.floor + (1 - vuln.floor) * sharpened;
}

export interface HitEventLike {
	userDataA: number;
	userDataB: number;
	point: V3;
	normal: V3;
	approachSpeed: number;
	/**
	 * Effective mass (kg) of the NON-car body in this contact, resolved by system.ts from the damage
	 * system's foreign-mass registry (setForeignMass()). `undefined` means "not a registered dynamic
	 * body" -- i.e. a static wall / tree / ground OR any obstacle whose owner hasn't opted into the
	 * mass-aware path -- and is treated as effectively infinite mass (factor 1, unchanged behavior).
	 * Only finite positive values attenuate car damage. See massAwareDamageFactor().
	 */
	otherMassKg?: number;
}

/**
 * The car-damage attenuation factor e for one contact, from the OTHER body's effective mass:
 * `e = m_other / (m_other + m_car)` for a dynamic body of known finite mass, else 1 (static/ground/
 * unknown -> effectively infinite mass -> full damage, exactly the pre-mass-aware behavior). This is
 * the single definition of "e" used by BOTH the plastic-crumple deposit (system.ts, via
 * applyCrumpleEvent's massFactor) and the accumulated weld-stress increment (below) -- weighting every
 * approach-speed-driven car-damage contribution by how much momentum the other body can actually
 * transmit. A 2.7kg brick vs a 1300kg car reads e~=0.002; a wall reads exactly 1.
 *
 * NOTE this deliberately leaves the SOLVER-driven triggers untouched: the direct weld constraint-force
 * spike and the wheel-detach force test (stepWeldsAndWheels parts 1 & 3) already read the real
 * mass-aware contact response out of the solver (getConstraintForce()), so a light body already fails
 * to spike them -- only the approach-SPEED heuristics (crumple depth + accumulated stress) needed this.
 */
export function massAwareDamageFactor(otherMassKg: number | undefined, carMassKg: number): number {
	if (otherMassKg == null || !(otherMassKg > 0) || !(carMassKg > 0)) return 1;
	return otherMassKg / (otherMassKg + carMassKg);
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

	// ---- 2) Accumulated event-driven stress (nearby qualifying hits), now DIRECTION-AWARE ----
	const chassisTransform = vehicle.chassis.getTransform();
	for (const hit of hits) {
		if (hit.approachSpeed <= STRESS_MIN_APPROACH_SPEED_MS) continue;
		// Ground-plane contacts (the car settling, bouncing, or briefly scraping flat ground -- NOT a
		// deliberate wall/pole/barrel crash) carry a near-vertical contact normal; a real crash's normal
		// is dominated by the horizontal direction of travel. See damage-tuning.ts's
		// STRESS_MAX_NORMAL_UP_COMPONENT doc comment for the diagnosis behind this exclusion.
		if (Math.abs(hit.normal.y) > STRESS_MAX_NORMAL_UP_COMPONENT) continue;
		if (!hitTouchesCar(hit, panels)) continue;
		// Which direction did this impact come from, in CHASSIS-LOCAL axes? (+Z frontal, +/-X lateral,
		// +/-Y vertical.) This is what lets a door ignore a nose impact but tear off in a side impact --
		// the reference-driven fix for "doors fly off in frontal impacts". See panelDirectionalFactor().
		const relLocal = rotateByConjugate(chassisTransform.rotation, sub(hit.point, chassisTransform.position));
		const relLen = length(relLocal);
		const dirLocal: V3 = relLen > 1e-9 ? { x: relLocal.x / relLen, y: relLocal.y / relLen, z: relLocal.z / relLen } : { x: 0, y: 0, z: 0 };
		for (const key of PANEL_KEYS) {
			const panel = panels[key];
			if (panel.state === 'broken') continue;
			const centroid = panel.body.getPosition();
			const dist = length(sub(hit.point, centroid));
			if (dist > STRESS_RADIUS_M) continue;
			const dirFactor = panelDirectionalFactor(PANEL_VULNERABILITY[key], dirLocal);
			if (dirFactor <= 0) continue;
			// Mass-aware weighting: a light plank/brick/sapling transmits a fraction e of the stress a
			// wall would at the same closing speed (massAwareDamageFactor). For a static/unknown other
			// body e is exactly 1, so `* 1` is an IEEE-754 no-op and this stress figure is bit-identical
			// to the pre-mass-aware code -- the byte-stable-against-static-obstacles guarantee.
			const massFactor = massAwareDamageFactor(hit.otherMassKg, carMassKg);
			panel.stress += STRESS_K * hit.approachSpeed * stressFalloff(dist / STRESS_RADIUS_M) * dirFactor * massFactor;
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
