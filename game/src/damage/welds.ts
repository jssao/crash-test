// SPDX-License-Identifier: MIT
//
// Weld stress model (G3 spec) + wheel detach. Per fixed step: (1) poll each intact panel weld's
// constraint-force magnitude (direct force-spike trigger), (2) accumulate event-driven stress from
// nearby qualifying hit events (falls off with distance from the panel centroid), loosening/springing/
// breaking whichever trigger fires first (DOORS ONLY escalate through the extra SPRUNG tier -- latch
// fails, hinge holds, see panels.ts's sprungPanelWeld() -- hood/trunk go straight loosened->broken as
// before), and (3) poll each intact wheel joint's constraint force, detaching a wheel outright on a big
// enough spike. Renderer-free (no three/DOM import).

import type { Body, World } from '../../../src/ts/index.js';
import { length, sub, type Q4, type V3 } from '../vehicle/mathUtil';
import { GRAVITY_MAG } from '../vehicle/tuning';
import { CAR_ENTITY_ID, type Vehicle, type WheelKey } from '../vehicle/vehicle';
import { getSegmentTelemetry, SEGMENT_ENTITY_ID_SET } from '../vehicle/segments';
import {
	DOOR_BREAK_GATE_MS,
	DOOR_SPRUNG_GATE_MS,
	DOOR_SPRUNG_LATERAL_FRACTION_MAX,
	DOOR_SPRUNG_TO_BREAK_STRESS_MULT,
	DOOR_STRESS_TOUCH_MIN,
	HOOD_BREAK_MIN_FRONT_CRUSH_M,
	PANEL_ADJACENCY,
	PANEL_ADJACENCY_BLEED_CAP,
	PANEL_ADJACENCY_BLEED_FRACTION,
	PANEL_BREAK_FORCE_MULT,
	PANEL_BREAK_S2_MULT,
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
	STRESS_RADIUS_M_BY_PANEL,
	WHEEL_DETACH_DEBOUNCE_STEPS,
	WHEEL_DETACH_EXTREME_DEBOUNCE_STEPS,
	WHEEL_DETACH_EXTREME_GATE_MS,
	WHEEL_DETACH_FORCE_MULT,
	WHEEL_DETACH_IMPACT_BYPASS_MULT,
	WHEEL_DETACH_JAMMED_DOOR_DEBOUNCE_STEPS,
	WHEEL_DETACH_MIN_APPROACH_MS,
	type PanelVulnerability,
} from './damage-tuning';
import { breakPanelWeld, DOOR_PANEL_KEY_SET, loosenPanelWeld, PANEL_ENTITY_ID, PANEL_KEYS, sprungPanelWeld, type PanelHandle, type PanelKey } from './panels';
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
 * panel is weak against (|component|, or the signed sense for a one-sided panel like the trunk),
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

/**
 * DOORS ONLY: this door's stress-weighted average |dirLocal.x| in [0,1] -- see panels.ts's
 * lateralStressWeighted doc comment for the exact accumulation. 0 when the door has accumulated no
 * stress yet (nothing to divide -- also correctly reads as "not predominantly lateral", since there is
 * no lateral stress to speak of). Exported for direct unit-testing (sim/*.test.mjs can construct a
 * PanelHandle-shaped object and check this in isolation, no physics needed).
 */
export function doorLateralFraction(panel: Pick<PanelHandle, 'stress' | 'lateralStressWeighted'>): number {
	if (panel.stress <= 1e-9) return 0;
	return panel.lateralStressWeighted / panel.stress;
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

/** True if either side of a hit event is the chassis, a crush-segment body (crush M1: a frontal wall
 * now strikes the bumperBeam/rail chain instead of the chassis's old solid nose, and that hit must
 * keep routing cosmetic crumple to the chassis-front mesh + stress to the panel welds exactly as the
 * nose hit did -- segments.ts), or a not-yet-broken panel (see crumple.ts's applyCrumpleEvent doc
 * comment for why "attached panel" includes `loosened`, not just `attached`). */
export function hitTouchesCar(hit: HitEventLike, panels: Record<PanelKey, PanelHandle>): boolean {
	const idsToCheck = [hit.userDataA, hit.userDataB];
	for (const id of idsToCheck) {
		if (id === CAR_ENTITY_ID.chassis) return true;
		if (SEGMENT_ENTITY_ID_SET.has(id)) return true;
		const panelKey = isCarPanelId(id);
		if (panelKey && panels[panelKey].state !== 'broken') return true;
	}
	return false;
}

/**
 * Escalates one panel by at most one tier this call, per whichever of shouldBreak/shouldSprung/
 * shouldLoosen fires (checked in that priority order, break winning outright). `shouldSprung` is only
 * ever true for a door (see stepWeldsAndWheels' callers) -- passing `world`/`chassis` unconditionally
 * costs nothing when it's false, and keeps this one escalation path shared by hood/trunk/doors alike
 * (mirrors how shouldBreak/shouldLoosen were already shared before this feature).
 */
function escalatePanel(world: World, chassis: Body, panel: PanelHandle, shouldBreak: boolean, shouldSprung: boolean, shouldLoosen: boolean, timeSec: number, emit: (e: DamageEvent) => void): void {
	if (shouldBreak) {
		if (panel.state !== 'broken') {
			breakPanelWeld(panel);
			panel.breakTimeSec = timeSec;
			emit({ type: 'panelBroken', panel: panel.key });
		}
		return;
	}
	if (shouldSprung && (panel.state === 'attached' || panel.state === 'loosened')) {
		sprungPanelWeld(world, chassis, panel);
		emit({ type: 'panelSprung', panel: panel.key });
		return;
	}
	if (shouldLoosen && panel.state === 'attached') {
		loosenPanelWeld(panel, LOOSEN_HERTZ, LOOSEN_DAMPING_RATIO);
		emit({ type: 'panelLoosened', panel: panel.key });
	}
}

export interface WeldStepArgs {
	/** The box3d-js world, needed to create a door's SPRUNG hinge (RevoluteJoint) -- see panels.ts's
	 * sprungPanelWeld(). */
	world: World;
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
	const { world, vehicle, panels, hits, carMassKg, timeSec, wheelOverThresholdSteps, emit } = args;

	// HOOD crush gate (damage-tuning.ts's HOOD_BREAK_MIN_FRONT_CRUSH_M doc): the hood may only BREAK
	// once the front structure carrying its hinges+latch has mechanically collapsed past the gate --
	// rig-independent physics truth, unlike accumulated stress (measured ~3x apart between the lab and
	// the sim harness for the same nominal crash). Applied to BOTH break triggers (force spike below +
	// accumulated stress), never to loosen.
	const hoodMayBreak = getSegmentTelemetry(vehicle.chassis, vehicle.segments).frontCrushM > HOOD_BREAK_MIN_FRONT_CRUSH_M;
	// DOORS ONLY: peak forward speed (same rig-independent signal the wheel-detach extreme tier below
	// gates on) -- the SECOND, speed-gated door sprung/break trigger (damage-tuning.ts's
	// DOOR_SPRUNG_GATE_MS doc comment has the full derivation for why this is needed alongside, not
	// instead of, the stress path). Computed once here since part 3 below also reads it.
	const peakSpeedMs = Math.abs(vehicle.segments.yieldState.peakForwardSpeedMs);

	// ---- 1) Direct weld constraint-force spike ----
	for (const key of PANEL_KEYS) {
		const panel = panels[key];
		if (panel.state === 'broken' || !panel.weldJoint) continue;
		const forceMag = length(panel.weldJoint.getConstraintForce());
		const weightN = panel.massKg * GRAVITY_MAG;
		const breakGate = key === 'hood' ? hoodMayBreak : true;
		// Force-spike stays a 2-outcome mechanism (loosen/break) even for doors -- a T-bone tearing a
		// door off outright via a genuine single-step overload skips sprung entirely, same as it always
		// skipped loosened (shouldSprung=false here; the accumulated-stress path in part 2 below is
		// where a door can land on sprung).
		escalatePanel(world, vehicle.chassis, panel, breakGate && forceMag > PANEL_BREAK_FORCE_MULT * weightN, false, forceMag > PANEL_LOOSEN_FORCE_MULT * weightN, timeSec, emit);
	}

	// ---- 2) Accumulated event-driven stress (nearby qualifying hits), now DIRECTION-AWARE ----
	const chassisTransform = vehicle.chassis.getTransform();
	// P013(d): each panel's THIS-STEP accumulated-stress increment, for the adjacency-bleed pass below.
	const incThisStep = {} as Record<PanelKey, number>;
	for (const key of PANEL_KEYS) incThisStep[key] = 0;
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
		//
		// P007 NOTE: this stays the impact-POINT-vs-origin vector (not the contact normal). The point
		// vector is near-axial and low-noise for a clean frontal, which is what keeps a frontal door's
		// accumulated stress in its calibrated sweet spot: small enough that <=100 km/h leaves doors
		// attached (crash-realism / threshold-ordering pins) yet nonzero enough that the extreme-tier
		// 161 km/h door SPRUNG behaviour still fires. A per-contact NORMAL was tried and rejected -- a
		// frontal wall's manifold normals carry enough incidental lateral component to loosen the doors at
		// 100 km/h, while a clean axial frontal reads EXACTLY zero and kills the 161 km/h sprung tier
		// (measured both regressions). The "side impact drops the trunk" half of P007 is instead fixed by
		// the tight per-panel TRUNK radius (STRESS_RADIUS_M_BY_PANEL) below -- a geometry guard that needs
		// no change to this well-calibrated direction signal.
		const relLocal = rotateByConjugate(chassisTransform.rotation, sub(hit.point, chassisTransform.position));
		const relLen = length(relLocal);
		const dirLocal: V3 = relLen > 1e-9 ? { x: relLocal.x / relLen, y: relLocal.y / relLen, z: relLocal.z / relLen } : { x: 0, y: 0, z: 0 };
		for (const key of PANEL_KEYS) {
			const panel = panels[key];
			if (panel.state === 'broken') continue;
			// P007: per-panel stress radius (STRESS_RADIUS_M_BY_PANEL) -- the trunk uses a tight radius so
			// a door-region hit can't reach it on distance alone (belt-and-suspenders with the direction
			// fix above). Every other panel keeps the global STRESS_RADIUS_M.
			const radius = STRESS_RADIUS_M_BY_PANEL[key] ?? STRESS_RADIUS_M;
			const centroid = panel.body.getPosition();
			const dist = length(sub(hit.point, centroid));
			if (dist > radius) continue;
			const dirFactor = panelDirectionalFactor(PANEL_VULNERABILITY[key], dirLocal);
			if (dirFactor <= 0) continue;
			// Mass-aware weighting: a light plank/brick/sapling transmits a fraction e of the stress a
			// wall would at the same closing speed (massAwareDamageFactor). For a static/unknown other
			// body e is exactly 1, so `* 1` is an IEEE-754 no-op and this stress figure is bit-identical
			// to the pre-mass-aware code -- the byte-stable-against-static-obstacles guarantee.
			const massFactor = massAwareDamageFactor(hit.otherMassKg, carMassKg);
			const stressIncrement = STRESS_K * hit.approachSpeed * stressFalloff(dist / radius) * dirFactor * massFactor;
			panel.stress += stressIncrement;
			incThisStep[key] += stressIncrement;
			// DOORS ONLY (C3b): track the stress-weighted lateral-alignment numerator alongside stress
			// itself -- see panels.ts's lateralStressWeighted doc comment + doorLateralFraction() below.
			if (DOOR_PANEL_KEY_SET.has(key)) panel.lateralStressWeighted += stressIncrement * Math.abs(dirLocal.x);
		}
	}
	// P013(d) ZONE PROPAGATION: bleed a small fraction of each panel's this-step stress increment into
	// its physical neighbours (PANEL_ADJACENCY) so a hard localized hit spreads a little beyond the exact
	// zone its own radius/direction reached, instead of stopping at a razor-sharp panel boundary. Applied
	// as a pure ADD-ON after the main accumulation (so no panel bleeds this step's OWN freshly-bled
	// stress onward -- reads only incThisStep, the direct-hit increments). The fraction is small enough
	// that the bleed can never by itself loosen a neighbour (see PANEL_ADJACENCY_BLEED_FRACTION's doc).
	// Deliberately NOT fed into lateralStressWeighted -- a neighbour's bleed carries no lateral direction
	// of its own, so it must not perturb the C3b sprung/jam split.
	for (const key of PANEL_KEYS) {
		const panel = panels[key];
		if (panel.state === 'broken') continue;
		let bleed = 0;
		for (const neighbour of PANEL_ADJACENCY[key]) bleed += incThisStep[neighbour];
		if (bleed <= 0) continue;
		// Hard-cap the LIFETIME bleed this panel receives (PANEL_ADJACENCY_BLEED_CAP) so a neighbour's
		// (unbounded) accumulated stress can never bleed a panel across its loosen threshold on its own.
		const want = PANEL_ADJACENCY_BLEED_FRACTION * bleed;
		const room = Math.max(0, PANEL_ADJACENCY_BLEED_CAP - panel.bleedStress);
		const add = Math.min(want, room);
		if (add > 0) {
			panel.stress += add;
			panel.bleedStress += add;
		}
	}
	for (const key of PANEL_KEYS) {
		const panel = panels[key];
		if (panel.state === 'broken') continue;
		const sprungStressThreshold = STRESS_BREAK_S2 * PANEL_BREAK_S2_MULT[key];
		let shouldBreak: boolean;
		let shouldSprung = false;
		if (DOOR_PANEL_KEY_SET.has(key)) {
			// DOORS: two independent (OR'd) triggers -- see damage-tuning.ts's DOOR_SPRUNG_GATE_MS doc
			// comment for why both are needed (a pure side impact reports ~zero peak forward speed and
			// must reach break via stress alone; the plain sim harness's frontal extreme tier never
			// accumulates anywhere near the old stress threshold and must reach sprung/break via speed).
			const touched = panel.stress > DOOR_STRESS_TOUCH_MIN;
			const breakStressThreshold = sprungStressThreshold * DOOR_SPRUNG_TO_BREAK_STRESS_MULT;
			const rawShouldSprung = panel.stress > sprungStressThreshold || (touched && peakSpeedMs > DOOR_SPRUNG_GATE_MS);
			shouldBreak = panel.stress > breakStressThreshold || (touched && peakSpeedMs > DOOR_BREAK_GATE_MS);
			// C3b REALISM FIX: a STRUCK-side door in a real side impact jams shut and caves -- it does not
			// spring open on its hinge (springing/swinging free is a FRONTAL/oblique phenomenon: the
			// latch fails from LONGITUDINAL inertia overloading it fore-aft, while the hinge -- mounted
			// perpendicular to that load -- still holds; a squarely lateral push-in instead crushes the
			// door/hinge/latch assembly together, jamming it). Gate the SPRUNG transition on this door's
			// stress being predominantly OBLIQUE/longitudinal rather than predominantly lateral: skip
			// sprung (stay 'loosened' -- the jammed/caved read) once doorLateralFraction crosses
			// DOOR_SPRUNG_LATERAL_FRACTION_MAX. shouldBreak is DELIBERATELY untouched by this gate -- a
			// T-bone can still tear a predominantly-lateral door straight off (crash-realism.test.mjs's
			// side-130 pins >=1 broken door), it just never passes through the sprung tier on the way.
			shouldSprung = rawShouldSprung && doorLateralFraction(panel) <= DOOR_SPRUNG_LATERAL_FRACTION_MAX;
		} else {
			// Hood/trunk: unchanged -- sprungStressThreshold is exactly the old S2*mult break threshold.
			const breakGate = key === 'hood' ? hoodMayBreak : true;
			shouldBreak = breakGate && panel.stress > sprungStressThreshold;
		}
		escalatePanel(world, vehicle.chassis, panel, shouldBreak, shouldSprung, panel.stress > STRESS_LOOSEN_S1, timeSec, emit);
	}

	// ---- 3) Wheel detach (impact-gated + debounced -- see WHEEL_DETACH_FORCE_MULT's doc comment) ----
	const perWheelWeightShareN = (carMassKg * GRAVITY_MAG) / 4;
	const wheelDetachForceN = WHEEL_DETACH_FORCE_MULT * perWheelWeightShareN;
	const wheelDetachBypassForceN = WHEEL_DETACH_IMPACT_BYPASS_MULT * perWheelWeightShareN;
	// IMPACT CONTEXT: is the car in a genuine collision THIS step? A qualifying hit is car-touching,
	// above the min approach speed, and NOT a near-vertical ground contact (same three filters the
	// accumulated-stress path in part 2 uses). The reverse (and forward) drivetrain load carries NO
	// such hit, so a purely drivetrain-induced joint-force plateau -- the reverse spin-motor reaction
	// sustaining ~4x the rear weight share for ~1s (measured, see WHEEL_DETACH_FORCE_MULT's doc) --
	// never reaches the base detach path; a wall/pole/tree crash's force breach coincides with its hit
	// and detaches exactly as before. A catastrophic CONTACTLESS load (the direct-impulse mechanism
	// test, or a real gross overload) still detaches via the higher WHEEL_DETACH_IMPACT_BYPASS_MULT.
	let impactContext = false;
	for (const hit of hits) {
		// P012: a GENUINE impact -- car-touching, mostly-horizontal normal, AND closing above the
		// wheel-detach approach floor (WHEEL_DETACH_MIN_APPROACH_MS, well above ordinary-driving contact
		// speeds). The old STRESS_MIN_APPROACH_SPEED_MS (3 m/s) floor let a low-speed curb/prop brush
		// during hard driving supply impact context, so a coincident hard-driving joint-force transient
		// (in the documented ordinary 5-23kN band) could false-detach a wheel. A solid 60 km/h wheel-region
		// strike (16.7 m/s) clears this comfortably and still detaches.
		if (hit.approachSpeed < WHEEL_DETACH_MIN_APPROACH_MS) continue;
		if (Math.abs(hit.normal.y) > STRESS_MAX_NORMAL_UP_COMPONENT) continue;
		if (!hitTouchesCar(hit, panels)) continue;
		impactContext = true;
		break;
	}
	// EXTREME TIER (Stream C C2): see WHEEL_DETACH_EXTREME_GATE_MS's doc comment -- a crash whose peak
	// speed ever exceeded the gate only needs a 1-step breach to detach (a genuinely extreme crash's
	// whole force spike lasts one step, same root cause as segments.ts's core-retreat extreme tier).
	// (peakSpeedMs computed once above, ahead of part 2 -- the door-sprung logic reads it too.)
	// C3c: a JAMMED (not sprung, not broken) door keeps feeding a sustained lateral push into the
	// chassis/suspension longer than a door that swings free or has already torn off -- see
	// WHEEL_DETACH_JAMMED_DOOR_DEBOUNCE_STEPS's doc comment for the measured near-miss this restores
	// margin against (side-mdb-50) and why it's provably inert for extreme-tier frontal (doors read
	// 'sprung' there, never 'loosened') and side-130 (doors read 'broken' within the first contact step,
	// well before the wheel force plateau). Checked using PART 2's already-escalated panel states (this
	// step's door transitions, if any, have already landed by here), so the gate takes effect on the
	// exact same step a door first reads 'loosened'. EXTREME TIER wins outright when both could apply
	// (checked first) -- a genuinely extreme crash must never regain patience from an incidental door
	// state.
	let anyDoorJammed = false;
	for (const key of DOOR_PANEL_KEY_SET) {
		if (panels[key].state === 'loosened') { anyDoorJammed = true; break; }
	}
	const wheelDebounceSteps = peakSpeedMs > WHEEL_DETACH_EXTREME_GATE_MS
		? WHEEL_DETACH_EXTREME_DEBOUNCE_STEPS
		: anyDoorJammed
			? WHEEL_DETACH_JAMMED_DOOR_DEBOUNCE_STEPS
			: WHEEL_DETACH_DEBOUNCE_STEPS;
	for (const key of Object.keys(vehicle.wheels) as WheelKey[]) {
		const wheel = vehicle.wheels[key];
		if (!wheel.joint) continue;
		const forceMag = length(wheel.joint.getConstraintForce());
		// Detach-eligible this step iff a contactless gross overload, or a base-threshold breach that
		// coincides with a real impact. Either way still requires wheelDebounceSteps in a row.
		const detachEligible = forceMag > wheelDetachBypassForceN || (forceMag > wheelDetachForceN && impactContext);
		if (detachEligible) {
			wheelOverThresholdSteps[key] = (wheelOverThresholdSteps[key] ?? 0) + 1;
		} else {
			wheelOverThresholdSteps[key] = 0;
		}
		if (wheelOverThresholdSteps[key] >= wheelDebounceSteps) {
			wheel.joint.destroy();
			wheel.joint = null;
			emit({ type: 'wheelDetached', i: key });
		}
	}
}
