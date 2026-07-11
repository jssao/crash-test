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

/** Per-panel mass, kg -- spec: "mass 12-18kg (door heavier than hood)". Mustang 2-door set (no roof):
 * hood + 2 doors + trunk lid. Sum (59kg) is exactly what game/src/vehicle/tuning.ts's CHASSIS_MASS_KG
 * was reduced by (1350 - 59 = 1291), so total car mass stays ~unchanged (1291 + 59 + 88 = 1438kg). */
export const PANEL_MASS_KG: Record<PanelKey, number> = {
	hood: 13,
	doorL: 16,
	doorR: 16,
	trunk: 14,
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
	trunk: 'y', // trunk lid is a near-horizontal panel (car-map Trunk sizeMm.y=139mm, thin along Y)
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

/**
 * Hit events at or below this approach speed (m/s) are ignored by the damage system entirely (both
 * the crumple pipeline and the accumulated-stress model) -- ordinary rolling/settling contact noise.
 *
 * INVESTIGATED for playtest MAJOR "panels loosen from 60s of ordinary driving" but NOT changed: raising
 * this floor (tried up to 7 m/s -- comfortably below every calibration crash's ~8.3/15.3/27.8 m/s at
 * 30/55/100 km/h, see damage-threshold-ordering.test.mjs) measurably disturbed
 * game/sim/damage-crumple-bounded.test.mjs's repeated-impact plateau shape (even a +0.5 m/s nudge):
 * excluding a few extra low-speed hits shifts exactly when panels loosen/break across that test's 12
 * repeated trials, which shifts the exact contact geometry each subsequent trial lands on. The
 * ground-contact normal exclusion below (STRESS_MAX_NORMAL_UP_COMPONENT) is the actual, precisely
 * targeted fix for this playtest finding and does not touch crumple-bounded's behavior at all (that
 * test's repeated wall crash is a horizontal-normal impact throughout), so this floor is left at its
 * original value rather than compensating with a second, riskier lever.
 */
export const STRESS_MIN_APPROACH_SPEED_MS = 3;

/**
 * Minimum approach speed (m/s) for a contact against a GLASS PANE shape (vehicle.ts GLASS_ENTITY_ID)
 * to shatter it (Tier-3 Stage 2). Real automotive glass takes incidental brushes but fails under a
 * body thrown at it: a 70km/h-crash ejectee crosses the cabin at 10-19 m/s. 3 m/s (matching
 * STRESS_MIN_APPROACH_SPEED_MS's "real impact, not a resting contact" floor) cleanly separates the
 * two regimes while letting rollover roof-slams and deep-penetration debris strikes shatter glass
 * believably. Below-threshold pane hits are still consumed by the glass path (never leaked to
 * crumple/welds) -- they just don't break the pane.
 */
export const GLASS_PANE_SHATTER_MIN_APPROACH_MS = 3;

/**
 * Hit events whose contact normal is this vertical (|normal.y| above this, 0=horizontal, 1=straight
 * up/down) are excluded from the accumulated-stress model entirely, regardless of approach speed.
 *
 * ROOT CAUSE (playtest MAJOR "panels loosen from 60s of ordinary driving", diagnosed via headless
 * hitEvents() instrumentation during ordinary driving through the full destructible world): the
 * chassis/panels' own hit events (enableHitEvents=true, see vehicle.ts/panels.ts) fire for ANY
 * qualifying contact, including the car settling onto / bouncing against / briefly scraping the flat
 * ground plane -- these hits carry a near-perfectly-vertical contact normal (measured (0,1,0) or
 * similarly ~0.85-1.0 |normal.y|), unlike a real wall/pole/barrel crash, whose normal is dominated by
 * the HORIZONTAL direction of travel (measured well under this threshold in every existing crash test:
 * moderate-impact/hard-frontal/threshold-ordering/determinism all hit walls or barrels head-on). The
 * stress model was treating these two physically-distinct contact classes identically, so ordinary
 * bumps/settling self-inflicted damage exactly like a real impact would. Excluding near-vertical-normal
 * hits from panel stress (this constant) is the primary fix -- it discriminates on the actual physical
 * difference (what direction the car got hit from), not a proxy like speed or distance, so it doesn't
 * touch how a genuine crash's stress is computed at all. See welds.ts's stepWeldsAndWheels().
 */
export const STRESS_MAX_NORMAL_UP_COMPONENT = 0.6;

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
// Weld stress model -- DIRECTION-AWARE panel vulnerability (crash-deformation-reference.md).
// ---------------------------------------------------------------------------------------------

/**
 * Per-panel directional vulnerability: the accumulated-stress each panel absorbs from a hit is now
 * scaled by how well the impact DIRECTION (chassis-local unit vector from the chassis origin to the
 * impact point) aligns with the axis that panel is physically weak against -- see welds.ts's
 * panelDirectionalFactor(). This is the reference-driven fix for the user playtest finding "doors fly
 * off in frontal impacts": a door's hinge+latch+B-pillar carry LONGITUDINAL (fore-aft) crash load
 * well and only tear from LATERAL push-in (a side impact) or rollover -- so a frontal (nose) impact,
 * whose chassis-local direction is dominated by +Z, must contribute ~zero breaking stress to a door,
 * no matter how close the old distance-only radius let it reach. FMVSS-206's own rulemaking record:
 * "offset frontals, near side impacts, and especially rollovers ... cause doors to open" -- i.e. door
 * separation is a lateral/complex-loading event, never a clean frontal. See crash-deformation-
 * reference.md for the full sourcing.
 *
 *   axis   : the chassis-local axis whose |component| (or signed component, if `signed`) of the
 *            impact direction gates this panel's stress.
 *   signed : when true, only impacts coming FROM that axis's positive-or-negative sense count
 *            (e.g. the rear hatch is only vulnerable to impacts from behind, dir.z < 0).
 *   sharpness : exponent applied to the alignment fraction -- >1 sharpens the gate so a mostly-
 *            frontal hit with a little incidental yaw (small non-zero lateral component) still gives a
 *            door almost nothing, while a true side impact (|dir.x|~1) gives it ~full stress.
 *   floor  : a minimum multiplier that always applies regardless of direction (the hood is frontal-
 *            weak by design, so it keeps floor=1 = today's exact behaviour; doors get floor=0 so a
 *            pure frontal contributes literally nothing toward breaking them).
 */
export interface PanelVulnerability {
	axis: 'x' | 'y' | 'z';
	signed: 1 | -1 | 0; // 0 = both senses (|component|); +/-1 = only that sense
	sharpness: number;
	floor: number;
}

export const PANEL_VULNERABILITY: Record<PanelKey, PanelVulnerability> = {
	// Hood is frontal/top-weak BY DESIGN (it buckles and, at high speed, tears loose). Kept at floor=1
	// so its stress -- and therefore every existing hood loosen/break threshold calibrated in the tests
	// above -- is byte-for-byte unchanged; the directional model only ever REMOVES stress from the
	// panels that were wrongly breaking (doors/hatch/roof) in a frontal.
	hood: { axis: 'z', signed: 1, sharpness: 1, floor: 1 },
	// Doors: lateral push-in only. floor 0 + sharpness 3 => a frontal or offset-frontal (small
	// incidental dir.x from post-impact yaw) gives ~0 -- the struck door stays fully ATTACHED, not even
	// loosened; a genuine side impact (dir.x~+/-1) gives ~full stress, so it still tears off.
	doorL: { axis: 'x', signed: 0, sharpness: 3, floor: 0 },
	doorR: { axis: 'x', signed: 0, sharpness: 3, floor: 0 },
	// Trunk lid: only vulnerable to a rear impact (dir.z < 0), same as the concept car's rear hatch. A
	// frontal (dir.z > 0) gives nothing.
	trunk: { axis: 'z', signed: -1, sharpness: 3, floor: 0 },
};

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
 *
 * THIS is the BASE threshold: it only counts toward detach when it coincides with a real IMPACT (a
 * car-touching collision that step -- see welds.ts's stepWeldsAndWheels() part 3 and
 * WHEEL_DETACH_IMPACT_BYPASS_MULT below). REVERSE-DETACH FIX (measured, game/verify/reverse-check.mjs
 * + verify/playtest-r3/diag-reverse.mjs): a plain forward -> full-stop -> reverse maneuver on open flat
 * ground, zero collision, drove the two REAR wheel joints to a SUSTAINED ~14.5kN plateau (~4.0x the
 * rear weight share) for ~80 consecutive steps -- the reverse spin-motor holds the barely-moving rear
 * wheels in a permanent high-slip stall, and getConstraintForce() reports that reaction as a force
 * that noses just over 4x for far longer than the debounce, tearing BOTH rear wheels off with no
 * impact at all. The debounce cannot help (the breach is genuinely sustained, not a spike), so the
 * base breach is now gated on impact context: a purely drivetrain-induced plateau (reverse OR forward)
 * carries no car-collision hit and can never reach the detach path, mirroring the occupants' restraint
 * gating (world/features/occupants/physics.ts). A real crash's force breach DOES coincide with the
 * wall/pole/tree hit, so crash wheel-detach is byte-unchanged (base threshold + debounce, as before).
 */
export const WHEEL_DETACH_FORCE_MULT = 4;

/**
 * CONTACTLESS gross-overload bypass multiplier: a wheel-joint force this many times the per-wheel
 * weight share detaches the wheel WITHOUT requiring impact context (still debounced). This preserves
 * the direct-impulse mechanism test (game/sim/damage-wheel-detach.test.mjs applies a huge impulse
 * straight to a wheel body, producing NO hit event but a measured ~22kN->40kN+ sustained joint force,
 * ~7-14x the share) and any genuinely catastrophic contactless load, while sitting well ABOVE the
 * measured reverse plateau (~4.0x) so the reverse false-detach can never reach it. Chosen at 6x
 * (=~21.6kN on this car): ~50% above the reverse plateau, below the impulse-test regime, and the lone
 * ~38kN single-step handbrake spike is still filtered by WHEEL_DETACH_DEBOUNCE_STEPS. */
export const WHEEL_DETACH_IMPACT_BYPASS_MULT = 6;

/** Consecutive fixed steps a detach-eligible breach (base+impact, or the contactless gross-overload
 * bypass) must persist before actually detaching (see WHEEL_DETACH_FORCE_MULT's doc comment for why:
 * filters a single-step transient solver spike). */
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

/**
 * Impact radius (meters): R = CRUMPLE_RADIUS0_M + CRUMPLE_RADIUS_SPEED_COEF_M * min(approachSpeed, cap).
 *
 * REALISM DELTA (crash-deformation-reference.md "localised crease, not a global cloth-wrinkle"):
 * RADIUS0 tightened 0.45 -> 0.34 and the speed coefficient/cap trimmed, so the deformation
 * concentrates as a sharp fold AT the impact site instead of smearing a shallow ripple across the
 * whole front shell. Combined with CRUMPLE_FALLOFF_POWER below (a steeper-than-smoothstep center
 * concentration) this reads as struck sheet metal creasing rather than a soft dent.
 */
export const CRUMPLE_RADIUS0_M = 0.34;
export const CRUMPLE_RADIUS_SPEED_COEF_M = 0.03;
export const CRUMPLE_RADIUS_SPEED_CAP_MS = 16;

/** Extra exponent applied to crumple.ts's smoothFalloff(t) (1 = the old plain smoothstep). >1
 * concentrates displacement toward the impact center -> a sharper crease, less broad wrinkle. */
export const CRUMPLE_FALLOFF_POWER = 1.6;

/** Displacement magnitude (meters) at the impact center (before falloff/jitter):
 * mag = CRUMPLE_MAG_COEF_M_PER_MS * min(approachSpeed, cap).
 * REALISM DELTA: coefficient/cap raised so a single high-speed contact drives the nose in fast enough
 * to reach the speed-scaled crush cap below within the crash's few high-energy substeps. */
export const CRUMPLE_MAG_COEF_M_PER_MS = 0.03;
export const CRUMPLE_MAG_SPEED_CAP_MS = 26;

/** Per-vertex crease-noise jitter fraction (deterministic hash of vertex index, NOT Math.random -- see
 * crumple.ts's hash32()/deterministicJitter01()). */
export const CRUMPLE_JITTER_FRACTION = 0.25;

/**
 * Max accumulated per-vertex displacement magnitude (meters), persistent/never-healing -- the ABSOLUTE
 * ceiling. REALISM DELTA: chassis raised 0.25 -> 0.58 so a genuinely severe crash can cave the nose in
 * deeply (crash-deformation-reference.md's per-class crush bands). The actual crush a given crash
 * reaches is gated below this by the SPEED-SCALED cap (CRUMPLE_CRUSH_*), so a light tap no longer
 * saturates to the same depth as a highway hit -- see crumple.ts's applyImpactToMesh().
 */
export const CRUMPLE_CLAMP_CHASSIS_M = 0.58;
export const CRUMPLE_CLAMP_PANEL_GLASS_M = 0.12;

/**
 * SPEED-SCALED crush cap: the deepest a vertex is allowed to cave in FROM A GIVEN HIT is
 *   min(clampM, CRUMPLE_CRUSH_FLOOR_M + CRUMPLE_CRUSH_SPEED_COEF_M * min(approachSpeed, cap)),
 * but never below what already accumulated (monotonic / never-heals -- crumple.ts enforces this). This
 * is what makes final crush depth scale with closing speed instead of every crash saturating to the
 * absolute clamp: ~0.30 m at 40 km/h (11.1 m/s), ~0.47 m at 64 km/h (17.8), ~0.55 m at 80 km/h (22.2),
 * saturating to the 0.58 m clamp only for the most extreme hits. Calibrated against
 * game/sim/crash-realism.test.mjs's measured per-speed crush.
 */
export const CRUMPLE_CRUSH_FLOOR_M = 0.09;
export const CRUMPLE_CRUSH_SPEED_COEF_M = 0.021;
export const CRUMPLE_CRUSH_SPEED_CAP_MS = 24;

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

// ---------------------------------------------------------------------------------------------
// CRUSH M3 -- collision follows the dents (crush-architecture.md §B): rate-limited panel collision
// hull refresh from the deformed panel mesh (Shape.setHull, the M0b runtime-geometry machinery).
// ---------------------------------------------------------------------------------------------

/** A panel's collision hull is rebuilt once its deformed-mesh AABB has moved this far (max single
 * face component, m) since the hull's last rebuild (spec §B's ~0.06m max-vertex delta). */
export const PANEL_HULL_REFRESH_DELTA_M = 0.06;
/** Minimum fixed steps between one panel's hull rebuilds (spec §B: >=30 steps apart; additionally
 * at most ONE panel is rebuilt per fixed step). */
export const PANEL_HULL_REFRESH_MIN_STEPS = 30;
/** Once a panel has rebuilt at least once, follow-up rebuilds track the still-deepening dent at
 * this finer residual (still >=PANEL_HULL_REFRESH_MIN_STEPS apart) so the hull CONVERGES to the
 * final dent instead of freezing one threshold-crossing behind it (measured: a 0.12m dent's first
 * rebuild landed at the 0.06 crossing and the remaining growth never re-crossed a full 0.06). */
export const PANEL_HULL_REFRESH_FOLLOWUP_DELTA_M = 0.02;
/** A rebuilt face may bulge OUTWARD at most this far past the pristine collision box (dents pull
 * faces inward; ripple bulges are real but bounded -- an unbounded outward rebuild could grow the
 * collision proxy into neighbors). */
export const PANEL_HULL_GROW_CAP_M = 0.05;
/** Per-axis half-extent floor for a rebuilt hull (a fully-pancaked axis still needs a sliver of
 * collision thickness for stable contacts). */
export const PANEL_HULL_MIN_HALF_M = 0.01;
