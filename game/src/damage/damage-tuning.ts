// SPDX-License-Identifier: MIT
//
// All damage-system tuning constants (G3 spec) live here, mirroring how game/src/vehicle/tuning.ts
// centralizes the drivetrain/suspension constants. No three/DOM import (renderer-free) so this file
// is shared verbatim by the browser game (main.ts) and the headless sim harness/tests
// (game/sim/damage-*.test.mjs).
//
// Starting points are the spec's own numbers; any constant that moved during tuning against the
// game/sim/damage-*.test.mjs matrix has a "TUNING DELTA" comment explaining why, same convention as
// game/src/vehicle/tuning.ts.

import type { PanelKey } from './panels';

// ---------------------------------------------------------------------------------------------
// Panel mass + geometry
// ---------------------------------------------------------------------------------------------

/** Per-panel mass, kg -- spec: "mass 12-18kg (door heavier than hood)". Sum (71kg) is exactly what
 * game/src/vehicle/tuning.ts's CHASSIS_MASS_KG was reduced by, so total car mass stays ~unchanged. */
export const PANEL_MASS_KG: Record<PanelKey, number> = {
	hood: 13,
	doorL: 16,
	doorR: 16,
	hatch: 14,
	roof: 12,
};

/** Panel hull thickness (full, meters) -- spec: "thin box hull (panel bbox, thickness 5cm)". */
export const PANEL_THICKNESS_M = 0.05;
export const PANEL_HALF_THICKNESS_M = PANEL_THICKNESS_M / 2;

/**
 * Which LOCAL axis is the panel's "thin" direction, overridden to PANEL_HALF_THICKNESS_M regardless
 * of the car-map.ts measured bbox on that axis (the measured bbox includes underside/interior detail
 * nodes bundled into the same parent, e.g. BodyHood's childNodes include BodyHoodUnder/BodyHoodInterior*
 * -- see car-map.ts -- so the raw bbox is much deeper than the visible outer sheet). Hood/roof/hatch
 * are near-horizontal panels (thin along vertical Y); doors are near-vertical panels (thin along
 * lateral X, the in/out-from-body direction) -- confirmed against car-map.ts's measured sizeMm:
 * BodyRoofPanel's Y size (32mm) is already ~thin, matching this axis choice.
 */
export const PANEL_THICKNESS_AXIS: Record<PanelKey, 'x' | 'y'> = {
	hood: 'y',
	doorL: 'x',
	doorR: 'x',
	hatch: 'y',
	roof: 'y',
};

export const PANEL_FRICTION = 0.8;

// ---------------------------------------------------------------------------------------------
// Weld stress model -- direct constraint-force spike
// ---------------------------------------------------------------------------------------------

/**
 * Force multiplier (of the panel's own static weight, massKg*GRAVITY_MAG) at which an intact weld
 * loosens/breaks from a single-step constraint-force spike.
 *
 * TUNING DELTA: raised enormously from the spec's starting points (6x/14x). Measured directly
 * (Joint.getConstraintForce() magnitude, polled every fixed step): a panel WELDED AT the impact zone
 * (e.g. BodyHood in a frontal crash) reads single-step spikes in the ~1e5-1e6 N range for ANY real
 * contact from ~30 km/h upward -- 1000x+ its own ~130N static weight -- because that reading conflates
 * the weld's tension with the panel's OWN contact-resolution impulse each substep (FIXED_SUBSTEPS=12,
 * ~1.4ms per substep -- see tuning.ts's FIXED_SUBSTEPS doc comment -- makes any impulsive contact read
 * as a huge instantaneous force). A panel NOT at the impact zone (e.g. a door, reacting only to the
 * chassis's own inertia through its weld, not directly touching anything) reads a much cleaner,
 * roughly speed-monotonic signal (measured ~12x/40x/55x/200x its own weight at 30/55/70/100 km/h).
 * Given that gap, a literal "6x/14x weight" threshold would break every panel on first contact at any
 * speed (failing the moderate-impact test's "NO panel broken" requirement) -- raised here so the
 * force-spike path only fires for a genuinely extreme, sustained load (effectively a secondary/rare
 * trigger within this game's tested crash-speed range), and the SPEED-based accumulated-stress model
 * above does the actual loosen/break discrimination (which naturally favors the panel(s) nearest the
 * impact point, and scales cleanly with hit approachSpeed rather than a noisy single-substep force
 * reading). Documented plainly as an empirical-only finding, same as this file's other TUNING DELTAs.
 */
export const PANEL_LOOSEN_FORCE_MULT = 100_000;
export const PANEL_BREAK_FORCE_MULT = 300_000;

// ---------------------------------------------------------------------------------------------
// Weld stress model -- accumulated event-driven stress (nearby hit events)
// ---------------------------------------------------------------------------------------------

/** Hit events at or below this approach speed (m/s) are ignored by the damage system entirely (both
 * the crumple pipeline and the accumulated-stress model) -- ordinary rolling/settling contact noise. */
export const STRESS_MIN_APPROACH_SPEED_MS = 3;

/**
 * Radius (meters) within which a hit event's impact point contributes stress to a panel's centroid --
 * NOTE: the falloff curve used against this radius is welds.ts's own `stressFalloff()` (a quadratic
 * (1-t)^2), deliberately gentler than crumple.ts's smoothFalloff() (a steeper cubic smoothstep used for
 * the visual dent radius) -- see welds.ts's doc comment on stressFalloff() for why.
 *
 * TUNING DELTA: raised from the spec's starting point of 1.2, twice. At 1.2m, a purely frontal impact
 * (the hull's front-most point is ~2.1-2.3m ahead of the chassis origin) only ever reaches the HOOD
 * panel (centroid ~0.5m from a nose impact) -- BodyDoorLColor1/BodyDoorRColor1 sit ~2.1m back, entirely
 * outside a 1.2m radius, so no frontal crash could ever get >=2 panels to accumulate stress no matter
 * how hard, failing the "100 km/h -> >=2 broken" requirement (game/sim/damage-threshold-ordering.
 * test.mjs) by construction. 2.5m (with the gentler quadratic falloff) still left the doors' share too
 * small to independently cross STRESS_BREAK_S2 at any tested speed; raised again to 4.0m so the doors
 * are reliably reachable (with a much smaller falloff multiplier than the hood gets, so the hood/doors
 * still cross the loosen/break thresholds at different, ordered speeds) while InteriorRearHatch/
 * BodyRoofPanel (~3.1-3.3m from a nose impact) remain effectively out of reach for a purely frontal
 * hit -- physically sensible: a frontal crash denting/tearing off the hood and a door, but not the rear
 * hatch or roof, matches real-world crash damage patterns. (Measured: at this radius, an off-center
 * hit can occasionally still reach the roof/hatch a little too -- see game/sim/damage-*.test.mjs's
 * console output -- which is a fair bonus outcome, not a violation of any required test.)
 */
export const STRESS_RADIUS_M = 4.0;

/**
 * Stress-per-event coefficient: stress += STRESS_K * approachSpeed * stressFalloff(dist/radius).
 * TUNING DELTA: raised from an initial 1.0, then re-tuned twice more alongside STRESS_RADIUS_M/
 * STRESS_LOOSEN_S1/STRESS_BREAK_S2 above/below -- final value calibrated empirically against the full
 * game/sim/damage-*.test.mjs matrix (see that suite's console output for the resulting measured stress
 * numbers at each required speed: e.g. hood stress ~28 @30km/h, ~99 @55km/h, ~211 @100km/h).
 */
export const STRESS_K = 9;

/**
 * Accumulated-stress thresholds (same units as STRESS_K's output, arbitrary but consistent).
 * TUNING DELTA: both re-tuned from the spec's starting points (S1=?, S2=? -- left unspecified) several
 * times alongside STRESS_K/STRESS_RADIUS_M above, calibrated against the exact matrix in
 * game/sim/damage-threshold-ordering.test.mjs: 20 km/h must stay under S1 entirely (measured hood
 * stress ~0, no qualifying hits survive engine-braking coastdown to a nearby wall); 30 km/h (the
 * moderate-impact test) must stay under S2 (measured hood ~28-40, comfortably below S2=90, may cross
 * S1 and loosen -- allowed, only breaking is disallowed); 55 km/h needs >=1 loosened and <=1 broken
 * (measured: hood crosses S2 and breaks, at least one door crosses S1 and loosens); 100 km/h needs
 * >=2 broken (measured: hood + at least one door both cross S2).
 */
export const STRESS_LOOSEN_S1 = 28;
export const STRESS_BREAK_S2 = 90;

// ---------------------------------------------------------------------------------------------
// Loosen behavior -- runtime weld-param setters ARE wired (src/wasm-shim/binding.c's
// b3js_WeldJoint_SetLinearDampingRatio/SetAngularDampingRatio, added for this feature -- see
// src/ts/joint.ts's WeldJoint class), so LOOSEN uses the "soften in place" path, not destroy+recreate.
// ---------------------------------------------------------------------------------------------

export const LOOSEN_HERTZ = 4;
export const LOOSEN_DAMPING_RATIO = 0.15;

// ---------------------------------------------------------------------------------------------
// Wheel detach
// ---------------------------------------------------------------------------------------------

/**
 * Force multiplier (of the car's own per-wheel weight share, carMassKg*GRAVITY_MAG/4) at which a
 * wheel joint's constraint force spike detaches that wheel outright.
 *
 * TUNING DELTA: lowered from the spec's starting point of 22x. Measured directly
 * (WheelJoint.getConstraintForce() magnitude): this joint's reported force appears to have an
 * inherent ceiling around ~20-25kN regardless of how large an external impulse is thrown at the wheel
 * body (a single massive one-shot impulse mostly just lets the wheel fly off with a comparatively
 * modest reading; a SUSTAINED large impulse applied over several consecutive steps gets closer to that
 * ceiling, ~20.9kN measured) -- so 22x this car's ~3595N per-wheel weight share (=79.1kN) is
 * unreachable by any external-impulse mechanism test. Lowered to 4x (=14.4kN), comfortably inside the
 * achievable ~20kN ceiling. Ordinary hard driving (full-throttle launch, hard braking + full steer)
 * peaks at ~5-23kN too, though as brief (1-2 step) transients rather than a sustained multi-step
 * plateau -- see WHEEL_DETACH_DEBOUNCE_STEPS below, added specifically so an isolated single-step
 * spike (measured: a hard handbrake-from-standstill stop can spike to ~38kN for exactly one step) does
 * not falsely detach a wheel during ordinary aggressive driving, while a genuinely sustained overload
 * (the mechanism test's repeated impulse, or a real sustained crash load) still does.
 */
export const WHEEL_DETACH_FORCE_MULT = 4;

/** Consecutive fixed steps the wheel-joint force must stay above threshold before actually detaching
 * (see WHEEL_DETACH_FORCE_MULT's doc comment for why: filters a single-step transient spike). */
export const WHEEL_DETACH_DEBOUNCE_STEPS = 3;

// ---------------------------------------------------------------------------------------------
// Broken-panel lifecycle
// ---------------------------------------------------------------------------------------------

/** Seconds after breaking before a detached panel's hit events are disabled (it keeps physically
 * simulating/resting, just stops generating further damage-system events). */
export const PANEL_HIT_EVENTS_DISABLE_AFTER_S = 6;
/** Seconds after breaking, OR meters from the chassis, after which a detached panel body is destroyed
 * outright (despawn). */
export const PANEL_DESPAWN_AFTER_S = 25;
export const PANEL_DESPAWN_DISTANCE_M = 100;

// ---------------------------------------------------------------------------------------------
// Plastic crumple
// ---------------------------------------------------------------------------------------------

/** Impact radius (meters): R = CRUMPLE_RADIUS0_M + CRUMPLE_RADIUS_SPEED_COEF_M * min(approachSpeed, cap). */
export const CRUMPLE_RADIUS0_M = 0.45;
export const CRUMPLE_RADIUS_SPEED_COEF_M = 0.05;
export const CRUMPLE_RADIUS_SPEED_CAP_MS = 12;

/** Displacement magnitude (meters) at the impact center (before falloff/jitter):
 * mag = CRUMPLE_MAG_COEF_M_PER_MS * min(approachSpeed, cap). */
export const CRUMPLE_MAG_COEF_M_PER_MS = 0.012;
export const CRUMPLE_MAG_SPEED_CAP_MS = 18;

/** Per-vertex crease-noise jitter fraction (deterministic hash of vertex index, NOT Math.random -- see
 * crumple.ts's hash32()/deterministicJitter01()). */
export const CRUMPLE_JITTER_FRACTION = 0.25;

/** Max accumulated per-vertex displacement magnitude (meters), persistent/never-healing. */
export const CRUMPLE_CLAMP_CHASSIS_M = 0.25;
export const CRUMPLE_CLAMP_PANEL_GLASS_M = 0.12;

/** A vertex counts as "dented" (telemetry.dentedVertexCount) once its accumulated displacement
 * magnitude exceeds this (meters) -- small enough to catch real denting, large enough to ignore
 * floating-point noise. */
export const CRUMPLE_DENT_EPSILON_M = 0.0015;

/** Accumulated glass displacement (meters) past which that glass mesh "shatters" (material swap +
 * event), once, per mesh. */
export const GLASS_SHATTER_THRESHOLD_M = 0.04;

/** Perf guard: meshes beyond the 2 nearest-to-impact candidates are skipped for an event if they
 * have more than this many vertices. */
export const CRUMPLE_PERF_VERTEX_GUARD = 50_000;
export const CRUMPLE_PERF_NEAREST_EXEMPT_COUNT = 2;

// ---------------------------------------------------------------------------------------------
// Hull-rebuild feedback -- STRETCH GOAL, NOT IMPLEMENTED. Everything above this line (panels, welds,
// wheel detach, crumple) was the full required scope and consumed the available time/effort budget;
// these 3 constants are left as a placeholder for a future pass, unused by any current code path.
// ---------------------------------------------------------------------------------------------

export const HULL_REBUILD_DENT_VOLUME_THRESHOLD = 0.02; // m^3 equivalent accumulated-displacement proxy
export const HULL_REBUILD_MIN_INTERVAL_S = 2;
export const HULL_REBUILD_MAX_COUNT = 3;
