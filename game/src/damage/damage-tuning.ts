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

/** Per-panel mass, kg -- spec: "mass 12-18kg (door heavier than hood)". S90 4-door set (no roof):
 * hood + 4 doors + trunk lid.
 *
 * PHASE R RE-MASS (2026-07-12, see vehicle/tuning.ts's CHASSIS_MASS_KG doc comment for the full
 * total-mass arithmetic): bumped from the S90-swap's mass-conserving 89kg total to a plausible
 * heavier-S90-door set, 116kg total -- doors specifically heavier (real power windows, speakers,
 * side-impact door beams on a real S90) rather than a uniform scale-up: hood +3kg (13->16, still the
 * lightest panel), front doors +6kg each (16->22), rear doors +5kg each (15->20), trunk +2kg (14->16).
 */
export const PANEL_MASS_KG: Record<PanelKey, number> = {
	hood: 16,
	doorL: 22,
	doorR: 22,
	doorRL: 20,
	doorRR: 20,
	trunk: 16,
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
	doorRL: 'x', // rear doors are near-vertical panels too, same thin-lateral axis as the front doors
	doorRR: 'x',
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
 * P013(c) OWN-RATCHET CORROBORATION: minimum hit-event approach speed (m/s) for a car-touching,
 * mostly-horizontal-normal contact on a crush chain to count as STRONG evidence -- the extra
 * corroboration the segment OWN-displacement ratchet now requires (alongside the longer debounce, see
 * segments.ts's OWN_RATCHET_DEBOUNCE_STEPS) before it may bake a segment's current displacement into a
 * permanent plastic set. Ordinary heightfield/curb driving contacts close at low speed and never sustain
 * this AND the crash gate AND a multi-step touch together; a genuine barrier crash (>=30 km/h = ~8.3 m/s)
 * clears it easily. Computed in system.ts (damage side, where the drain lives) and passed to
 * stepSegmentYield() as a boolean CoreHitFlags.frontStrong/rearStrong, so segments.ts needs no
 * damage-tuning import. */
export const OWN_RATCHET_STRONG_APPROACH_MS = 8;

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
 * P007 PER-PANEL stress radius override (m). Panels not listed use the global STRESS_RADIUS_M above.
 *
 * TRUNK re-scope (playtest "side impact drops the trunk"): the 4.0m global radius reaches the trunk
 * centroid (rear of the car) from a struck DOOR's impact point, so a squarely-lateral rear-door hit --
 * whose direction is now correctly read as lateral, not rearward (welds.ts's normal-based
 * panelDirectionalFactor caller) -- could STILL leak a little stress into the trunk purely on distance.
 * A tight trunk radius makes trunk stress mostly SAME-PANEL: only a genuine REAR impact (barrier/pole at
 * the tail, ~0.7m from the trunk centroid) reaches it, while a door-region hit (>=1.1m away) never does.
 * This is the belt-and-suspenders half of the trunk fix (the direction fix is the primary lever); on its
 * own the geometry guarantees "a side impact cannot drop the trunk" independent of any direction math. */
export const STRESS_RADIUS_M_BY_PANEL: Partial<Record<PanelKey, number>> = {
	// MEASURED (2026-07-15): trunk centroid sits at chassis-local z=-2.13; the rear DOORS sit at z=-0.62
	// and a door-centred SIDE barrier reaches back to ~z=-1.2. At the old 4.0m (and even a 1.1m) radius
	// those rearmost side-flank hits still reached the trunk centroid (~0.93m away) and loosened it in a
	// side impact -- the "side impact drops the trunk" bug. 0.7m excludes every side-flank hit (>=0.93m
	// from the trunk) while still comfortably admitting a genuine REAR impact (a tail barrier/pole at
	// z~-2.5 is ~0.37m from the centroid). Trunk stress becomes essentially same-panel: only a real rear
	// hit reaches it.
	trunk: 0.7,
};

/**
 * P013(d) ZONE PROPAGATION -- panel-to-panel adjacency. The panels are star-welded to the chassis with
 * no direct panel-to-panel load path, so a hard localized hit used to stay strictly within the panel(s)
 * its own impact radius + directional factor reached (deformation read as sharply "zone-confined"). This
 * defines a simple, tunable physical-neighbour graph so a fraction of each panel's per-step accumulated
 * stress bleeds into its neighbours (a front hit's hood load bleeds into the front doors' cowl edges; a
 * side door's load bleeds into the panel behind it and the hood; a rear hit bleeds into the rear doors).
 * Deliberately NOT an architecture rebuild -- it rides on top of the existing accumulated-stress model as
 * a small secondary pass (welds.ts), gated so the bleed alone can never escalate a neighbour (see
 * PANEL_ADJACENCY_BLEED_FRACTION). */
export const PANEL_ADJACENCY: Record<PanelKey, readonly PanelKey[]> = {
	hood: ['doorL', 'doorR'],
	doorL: ['hood', 'doorRL'],
	doorR: ['hood', 'doorRR'],
	doorRL: ['doorL', 'trunk'],
	doorRR: ['doorR', 'trunk'],
	trunk: ['doorRL', 'doorRR'],
};

/**
 * P013(d): fraction of a panel's THIS-STEP accumulated-stress increment that bleeds into each physical
 * neighbour (PANEL_ADJACENCY). Kept deliberately small: at the highest calibrated frontal (120 km/h,
 * measured hood stress a few hundred units accumulated over the whole crash) 0.05x the hood's per-step
 * increments summed over the crash stays well under STRESS_LOOSEN_S1 (28), so the bleed by itself can
 * never loosen a neighbouring door -- preserving crash-realism.test.mjs's "NO door loosens in a frontal
 * at 40/64/80/120" and damage-threshold-ordering.test.mjs's "doors stay attached" pins. It only ever
 * brings a neighbour that is ALREADY accumulating its own genuine directional stress a little closer to
 * its threshold -- the pragmatic cross-zone spread the brief asks for, not a new failure mode. */
export const PANEL_ADJACENCY_BLEED_FRACTION = 0.05;

/**
 * P013(d): absolute ceiling (same stress units as STRESS_LOOSEN_S1) on the TOTAL adjacency bleed any one
 * panel may ever receive over its life (tracked in PanelHandle.bleedStress). MEASURED NECESSITY
 * (2026-07-15): a hard frontal accumulates ~800 units of HOOD stress at 100 km/h (and far more at
 * extreme speed), so an uncapped 0.05x bleed alone put ~40 units into each front door -- past
 * STRESS_LOOSEN_S1 (28) -- wrongly loosening doors in a pure frontal and breaking damage-threshold-
 * ordering.test.mjs / crash-realism.test.mjs / extreme-tier.test.mjs's "doors stay attached" pins. The
 * bleed source (a neighbour's own stress) is unbounded, so a fixed fraction cannot be safe on its own;
 * this hard cap (well under STRESS_LOOSEN_S1) guarantees the bleed can only ever nudge a panel that is
 * ALREADY carrying its own genuine directional stress a little closer to escalation, never manufacture a
 * loosen from a neighbour's damage alone. */
export const PANEL_ADJACENCY_BLEED_CAP = 12;

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

/**
 * Per-panel BREAK threshold multiplier on STRESS_BREAK_S2 (the LOOSEN threshold S1 is untouched).
 * REALISM DELTA (user playtest 2026-07-10 vs the NHTSA 56 km/h full-frontal reference): a hood at
 * NCAP speed BUCKLES -- tents at mid-span, stays attached via hinges+latch -- it does not tear off;
 * hood separation is a high-speed event. Measured hood stress on this car: ~99 @55 km/h, ~211
 * @100 km/h (roughly speed-linear between), so 1.65x (break at ~148.5) keeps 55-64 km/h frontals at
 * LOOSENED (the visual tent buckle, scene/structuralCrush.ts, carries the "damaged hood" read) while
 * ~80+ km/h still tears the hood off, and damage-threshold-ordering.test.mjs's hard "100 km/h ->
 * hood BROKEN" requirement keeps passing (211 > 148.5). Doors/trunk stay at 1x: crash-realism.
 * test.mjs's 130 km/h side impact pins door break through the same global S2, and the hood-scoped
 * form (rather than weakening PANEL_VULNERABILITY.hood.floor or raising S2 globally) is exactly what
 * keeps crash-realism.test.mjs's panelDirectionalFactor(hood, frontal)~=1 unit pin intact.
 */
export const PANEL_BREAK_S2_MULT: Record<PanelKey, number> = {
	hood: 1.65,
	doorL: 1,
	doorR: 1,
	doorRL: 1, // rear doors: same vulnerability shape as the front doors (orchestrator decision)
	doorRR: 1,
	trunk: 1,
};

// ---------------------------------------------------------------------------------------------
// Weld stress model -- DOOR SPRUNG state (Stream C slice C1, 2026-07-12): a door's LATCH failing
// while its HINGE holds -- swings open freely instead of tearing off outright. DOORS ONLY (hood/
// trunk keep their existing loosen/break-only escalation): attached -> loosened -> SPRUNG -> broken.
// ---------------------------------------------------------------------------------------------

/**
 * DOORS ONLY: the existing S2 crossing (STRESS_BREAK_S2 * PANEL_BREAK_S2_MULT[key], == STRESS_BREAK_S2
 * for every door key since their mult is 1) is repurposed as the SPRUNG threshold instead of BREAK --
 * this is exactly the stress level a door used to fully detach at from a hard-enough hit (e.g.
 * crash-realism.test.mjs's side-130 impact, which measures 260-600, far past it either way). BREAK now
 * sits this multiplier above THAT threshold instead.
 */
export const DOOR_SPRUNG_TO_BREAK_STRESS_MULT = 1.5;

/**
 * DOORS ONLY, a SECOND (OR'd, not layered) trigger alongside the stress path above: peak forward speed
 * (m/s, segments.ts's SegmentAssembly.yieldState.peakForwardSpeedMs -- the same rig-independent "how
 * fast did this crash ever get" signal WHEEL_DETACH_EXTREME_GATE_MS already gates on) past which a door
 * becomes SPRUNG-eligible (paired with DOOR_STRESS_TOUCH_MIN below, so it still needs to have actually
 * been near something).
 *
 * WHY A SECOND TRIGGER IS NEEDED, NOT JUST A LOWER STRESS THRESHOLD (measured directly, sim/
 * extreme-tier.test.mjs's frontalCrash helper, BEFORE this feature existed): a door's PANEL_VULNERABILITY
 * (floor=0, sharpness=3) makes it near-immune to a clean frontal by design (FMVSS-206) -- what little
 * door stress a frontal DOES accumulate comes entirely from incidental secondary/chaotic contact (spin,
 * ground scrape), whose magnitude does NOT scale cleanly with speed the way hood/chassis stress does.
 * Measured front-door stress: ~9.2 @100km/h, ~8.2 @120km/h (a DIP, not a rise), ~19.1 @161km/h,
 * ~19.0 @193km/h, ~42.5 @322km/h -- nowhere near STRESS_BREAK_S2=90 at ANY tested frontal speed. This
 * confirms the reference behavior "doors tear off around 161-193km/h" describes the crash LAB rig
 * (occupants + longer contact dwell reads 3x+ higher stress than this bare sim harness for the same
 * nominal crash -- see HOOD_BREAK_MIN_FRONT_CRUSH_M's doc comment for the identical rig-divergence
 * problem, already solved once here the same way) -- NOT the plain sim harness extreme-tier.test.mjs
 * actually runs against. There is also no single stress value that could stand in for it: 100km/h's
 * peak (~9.2) sits ABOVE 120km/h's (~8.2), so no threshold cleanly separates "100/120km/h: never" from
 * "161+km/h: always" using the stress number alone. Gating on mechanical peak speed instead sidesteps
 * the rig-dependent noise entirely (same fix SHAPE as HOOD_BREAK_MIN_FRONT_CRUSH_M/
 * WHEEL_DETACH_EXTREME_GATE_MS): 40 m/s sits comfortably above 120km/h's peak (33.3 m/s) and below
 * 161km/h's (44.7 m/s) -- deliberately reusing WHEEL_DETACH_EXTREME_GATE_MS's exact value (both mark the
 * same "genuinely 100mph+" line from the reference footage).
 *
 * This is an OR against the stress path, not a replacement: a pure SIDE impact (crash-realism.test.mjs's
 * side-130, crashSideways()) reports ~zero peak FORWARD speed throughout (the launch velocity is
 * entirely lateral) yet must still reach BREAK -- confirmed it does, via the stress path alone (measured
 * 260-600, comfortably past DOOR_SPRUNG_TO_BREAK_STRESS_MULT's raised threshold too). Each path fires
 * independently; whichever crosses first wins.
 */
export const DOOR_SPRUNG_GATE_MS = 40;

/** DOORS ONLY: peak forward speed (m/s) past which a door is BREAK-eligible via the speed path -- 1.5x
 * DOOR_SPRUNG_GATE_MS (mirroring DOOR_SPRUNG_TO_BREAK_STRESS_MULT's own ratio), landing at 60 m/s
 * (~216 km/h): comfortably above 193 km/h (53.6 m/s, measured to stay at sprung) and below 322 km/h
 * (89.4 m/s, measured well past it) -- see extreme-tier.test.mjs's door-sprung matrix. */
export const DOOR_BREAK_GATE_MS = 60;

/** DOORS ONLY: minimum accumulated stress (same units as STRESS_K's output) a door must ALSO show
 * before either speed gate above can fire -- confirms THIS SPECIFIC door was actually near some contact
 * during the crash (not just "the car was fast somewhere"), without trying to pin an exact
 * rig-dependent magnitude the way STRESS_LOOSEN_S1/STRESS_BREAK_S2 do. Comfortably below every measured
 * front-door stress at 161+ km/h (9.9-42.5) and above the near-zero reading of a door nothing came near. */
export const DOOR_STRESS_TOUCH_MIN = 1;

/**
 * C3b REALISM FIX (2026-07-12, user side-impact top-view reference vs the C1x C3 interaction): a
 * STRUCK-side door in a real side impact jams shut and caves inward -- it does not spring open on its
 * hinge. Springing/swinging free is a FRONTAL/oblique phenomenon (the latch fails from LONGITUDINAL
 * inertia overloading it fore-aft while the hinge, mounted perpendicular to that load, still holds); a
 * squarely lateral push-in instead crushes the door/hinge/latch assembly together and jams it. Gates
 * welds.ts's SPRUNG transition (DOORS ONLY): skip sprung (stay 'loosened' -- the jammed/caved read,
 * previously masked by the door swinging open) once doorLateralFraction(panel) -- welds.ts's
 * stress-weighted running average of |dirLocal.x| across every hit contributing to this door's stress,
 * see panels.ts's lateralStressWeighted doc comment -- exceeds this fraction. shouldBreak is NOT gated
 * by this (a T-bone can still tear a predominantly-lateral door clean off; it just never passes through
 * the sprung tier first).
 *
 * MEASURED (sim harness, 300-step settle; see the now-deleted sim/_probe-lateral-fraction.test.mjs):
 *   side-mdb-50 proxy (spawnSideWall(1.05)+crashSideways(50)): doorL 0.798, doorR 0.794, doorRL 0.826,
 *     doorRR 0.821 -- all squarely lateral, as expected for a door-centred MDB strike.
 *   side-pole-32 proxy (rigid capsule pole + crashSideways(32)): doorL 0.997, doorR 0.997, doorRL 0.997,
 *     doorRR 0.997 -- even more purely lateral (a pole's narrow single-point contact has near-zero
 *     fore-aft component).
 *   frontal 161 km/h (extreme-tier.test.mjs's own scenario): doorL 0.323, doorR 0.334, doorRL 0.316,
 *     doorRR 0.334 -- the incidental secondary/chaotic contact (spin, ground scrape) that gives a
 *     frontal-crash door ANY stress at all (damage-tuning.ts's DOOR_SPRUNG_GATE_MS doc comment) still
 *     reads clearly LESS lateral than a genuine side impact.
 *   frontal 193 km/h: doorL 0.292, doorR 0.281, doorRL 0.292, doorRR 0.277 -- same band as 161.
 * Clean, wide separation (frontal max 0.334 vs side min 0.794, a >0.46 gap) -- 0.6 sits almost exactly
 * at the midpoint (0.564), comfortably inside the brief's suggested 0.6-0.7 band and far from either
 * cluster, so ordinary measurement noise on either side cannot flip the outcome.
 */
export const DOOR_SPRUNG_LATERAL_FRACTION_MAX = 0.6;

/** DOORS ONLY: outward swing limit (radians) for the SPRUNG hinge (RevoluteJointOptions.enableLimit),
 * measured from the closed (0) position -- real doors typically stop well short of a full 90deg. See
 * panels.ts's sprungPanelWeld(). */
export const DOOR_SWING_MAX_RAD = (75 * Math.PI) / 180;

/**
 * HOOD BREAK is additionally gated on MECHANICAL front crush depth (vehicle/segments.ts telemetry):
 * the hood only tears off once the front structure carrying its hinges+latch has collapsed this far.
 *
 * WHY a crush gate and not stress alone (measured, __LAB__.panelStress timeline + sweep 2026-07-10):
 * the same nominal crash produces wildly different accumulated-stress totals per rig -- the bare sim
 * harness reads ~99 @55 km/h and ~211 @100 km/h, while the crash lab (occupant ragdolls, segment
 * chain contacts, longer contact dwell) reads ~307 @56 and ~435 @80 -- lab-56 stress EXCEEDS sim-100
 * stress, so no stress threshold can simultaneously keep an NCAP-speed hood attached (the reference
 * behavior: it buckles, it does not fly off) and satisfy damage-threshold-ordering.test.mjs's hard
 * "sim 100 km/h -> hood broken". Mechanical crush depth is rig-independent physics truth
 * (segment-yield.test.mjs bands: 0.382 @56, 0.456 @64, 0.542 @80, 0.580 @120 -- lab measures the
 * same +-0.02), so gating on it separates the regimes cleanly: 56/64 km/h stay under 0.52 ->
 * LOOSENED (tented, attached); ~80+ km/h crosses -> hood tears off as before. The stress threshold
 * (PANEL_BREAK_S2_MULT above) still applies on top -- both must hold to break.
 */
export const HOOD_BREAK_MIN_FRONT_CRUSH_M = 0.52;

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
	// Rear doors (S90 swap): mirror the front doors exactly -- lateral-only vulnerability, floor 0 (a
	// frontal/rear hit contributes nothing; only a genuine side impact tears a rear door off).
	doorRL: { axis: 'x', signed: 0, sharpness: 3, floor: 0 },
	doorRR: { axis: 'x', signed: 0, sharpness: 3, floor: 0 },
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
 * P012 (wheels fly off too easily): minimum hit-event approach speed (m/s) for a car-touching,
 * mostly-horizontal-normal contact to count as the IMPACT CONTEXT that gates the base (4x) wheel-detach
 * breach. Raised from the base STRESS_MIN_APPROACH_SPEED_MS (3) floor the impact-context loop used to
 * share: a 3 m/s bar let ordinary low-speed obstacle brushes during hard driving (a curb kiss, clipping
 * a light prop) supply "impact context", so a coincident hard-cornering/braking joint-force transient
 * in the documented 5-23kN ordinary-driving band (WHEEL_DETACH_FORCE_MULT's doc) could tip a wheel off
 * with no genuine crash. The base force multiplier sits INSIDE that ordinary band, so force alone cannot
 * discriminate -- the corroborating signal must be a real IMPACT. 12 m/s (~43 km/h closing) is well
 * above ordinary-driving contact speeds yet comfortably below a solid 60 km/h (16.7 m/s) wheel-region
 * pole/barrier strike, which still detaches. The CONTACTLESS gross-overload bypass
 * (WHEEL_DETACH_IMPACT_BYPASS_MULT, e.g. the direct-impulse mechanism test) is unaffected -- it never
 * used impact context -- and any genuinely extreme crash (>=WHEEL_DETACH_EXTREME_GATE_MS) reaches the
 * bypass on force alone, so the extreme-tier wheel loss is unchanged.
 *
 * 8 m/s (~29 km/h), NOT higher: reverse.test.mjs pins that a genuine coincident car impact of
 * approachSpeed 10 m/s (a real 36 km/h collision) DOES arm the base detach path -- an ordinary-driving
 * low-speed brush (a curb kiss / clipping a light prop) closes well under this, while any real collision
 * from ~30 km/h up clears it. */
export const WHEEL_DETACH_MIN_APPROACH_MS = 8;

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

/**
 * EXTREME TIER (Stream C slice C2): above this chassis PEAK forward speed (m/s, segments.ts
 * SegmentAssembly.yieldState.peakForwardSpeedMs -- the same "how fast did this crash ever get"
 * signal the mechanical crush extreme tier gates on), a wheel-joint detach breach only needs to
 * persist WHEEL_DETACH_EXTREME_DEBOUNCE_STEPS steps, not the full WHEEL_DETACH_DEBOUNCE_STEPS.
 *
 * MEASURED NECESSITY (extreme-tier probe, 161-322 km/h rigid-barrier frontal): the wheel-joint force
 * breach at these speeds is a genuine, catastrophic overload (measured 3-68x the per-wheel weight
 * share, comfortably past WHEEL_DETACH_IMPACT_BYPASS_MULT=6x at 193+ km/h) but lasts EXACTLY ONE
 * fixed step -- the car's own bullet-CCD kills essentially its whole closing speed in the single step
 * the TOI lands on (the same one-step-mega-kill phenomenon segments.ts's CORE_MAX_RETREAT_STEP_EXTREME_M
 * doc comment records for the mechanical crush tier), so the standard 3-step debounce (correctly, for
 * ordinary driving spikes) filters the ENTIRE crash as noise and no wheel ever tears off, contradicting
 * the reference footage (wheels torn/car airborne by 120mph). 40 m/s (~144 km/h) sits comfortably above
 * every speed in the existing calibrated matrix (120 km/h = 33.3 m/s is the fastest crash in
 * damage-threshold-ordering.test.mjs / crash-realism.test.mjs), so this is provably inert for the
 * ≤120 km/h regression suite -- confirmed by the full suite staying green.
 */
export const WHEEL_DETACH_EXTREME_GATE_MS = 40;
export const WHEEL_DETACH_EXTREME_DEBOUNCE_STEPS = 1;

/**
 * C3c REGRESSION FIX: extra wheel-detach patience while at least one door is in the 'loosened' (JAMMED,
 * C3b) state. side-mdb-50 tore off 3 of 4 wheels post-C3b (0 of 4 pre-C3b), even though a real 50 km/h
 * side-MDB test never sheds a wheel. ROOT CAUSE (measured, throwaway sim/_probe-c3c-wheel-force.test.mjs,
 * a headless replica of the real guided-trolley rig -- exact geometry/mass/speed from lab/protocols.ts +
 * lab/barriers.ts's mdb-trolley case, deleted after use): C3b correctly made a squarely-lateral-struck
 * door JAM instead of springing open (a real side-struck door does jam) -- but a jammed door keeps
 * transmitting the trolley's continued push into the chassis/suspension for longer than a door that
 * swings away and sheds some of that energy, nudging the struck-side wheel joints' sustained
 * constraint-force plateau right up against WHEEL_DETACH_DEBOUNCE_STEPS. MEASURED: fl/rl/rr each reach 2
 * CONSECUTIVE steps over the base 4x threshold (fl peaks 100.9kN = 25.4x share, rl 68.5kN = 17.3x, rr
 * 22.8kN = 5.7x) -- one step short of the 3-step debounce in this simplified replica (no occupants/
 * cardetail chassis ballast, no crush-M3 panel-collision setHull refresh); the real full crash lab
 * evidently tips this over 3 for 3 of the 4 wheels.
 *
 * GATED SPECIFICALLY on the 'loosened' (jammed) state -- deliberately NOT 'sprung' (a frontal/oblique
 * door SWINGS instead of jamming, so extreme-tier's 161/193/322 km/h frontal crashes read all doors
 * 'sprung', never 'loosened' -- measured inert there; extreme-tier.test.mjs's own 2/2/4 wheel-detach
 * pin is unaffected, and its EXTREME_GATE check is evaluated first below so an extreme-speed frontal
 * crash can never be slowed back down by this gate even if a door were somehow also 'loosened') and NOT
 * 'broken' (side-130's doors tear off entirely within the first fixed step of contact -- measured
 * doorRL/doorR broken@step 0, while wheels fl/rl don't detach until step 2-3 -- so by the time wheel
 * forces are ramping up, the jammed-door transmission path is already severed and this gate has already
 * turned itself back off; side-130's existing 2-wheel loss is unaffected, confirmed by the same probe).
 * Chosen at 2x the base debounce (6, from 3): comfortably past the measured 2-consecutive-step near-miss
 * with margin for the real lab's somewhat-worse-than-this-replica conditions, while staying a modest,
 * bounded multiple of the base value rather than an unbounded patience.
 */
export const WHEEL_DETACH_JAMMED_DOOR_DEBOUNCE_STEPS = 6;

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

// ---------------------------------------------------------------------------------------------
// EXTREME TIER (Stream C slice C2, 2026-07-12): 100-200mph reference footage (crush-to-A-pillar,
// hood torn, cabin collapse beginning, near-total destruction) needs CHASSIS crush headroom well
// past the NCAP-class 0.58m clamp above -- but every ≤80 km/h (22.2 m/s) crash in the calibrated
// matrix must stay BYTE-IDENTICAL (the whole game/sim test suite pins it). Rather than raising
// CRUMPLE_CLAMP_CHASSIS_M flatly (which would also loosen the NCAP-tier bands), this ADDS a
// speed-gated ramp strictly ABOVE the point the existing speed-scaled cap already saturates
// (CRUMPLE_CRUSH_SPEED_CAP_MS = 24 m/s / 86.4 km/h -- comfortably past every guarded speed:
// 40/64/80/120 km/h = 11.1/17.8/22.2/33.3 m/s). chassisSpeedCrushCapM() below is a TIERED
// replacement for the flat "min(clampM, floor+coef*speed)" expression: for approachSpeedMs at or
// under the gate it evaluates to the EXACT SAME float as before (same sub-expression, same inputs);
// above the gate it ramps linearly toward CRUMPLE_CLAMP_EXTREME_CHASSIS_M, which becomes the new
// (still-tiered, never a flat raise) absolute ceiling once fully engaged. Chassis-mesh-kind only
// (crumple.ts's clampMFor()) -- panel/glass keep their flat CRUMPLE_CLAMP_PANEL_GLASS_M path,
// since the reference's extreme-tier read (A-pillar crush, cabin collapse) is a BODY-SHELL event.
// ---------------------------------------------------------------------------------------------

/** Closing speed (m/s) at/under which the extreme tier contributes nothing -- deliberately equal to
 * CRUMPLE_CRUSH_SPEED_CAP_MS (the existing speed-scaled cap's own saturation point), so the two
 * expressions are identical by construction at the gate and every guarded speed sits well below it. */
export const CRUMPLE_EXTREME_GATE_MS = CRUMPLE_CRUSH_SPEED_CAP_MS;

/** Closing speed (m/s) at which the extreme tier reaches full scale -- ~45 m/s = 162 km/h, just
 * past the reference's "100mph" tier, so 161/193/322 km/h (44.7/53.6/89.4 m/s) all sit at or past
 * full ramp (the reference's ordering above 100mph is read through structuralCrush.ts's cabin-
 * extension field, not a deeper raw chassis-mesh clamp -- see that file's own extreme-tier doc). */
export const CRUMPLE_EXTREME_SPEED_CAP_MS = 45;

/** Absolute chassis crush clamp (m) once the extreme tier is fully engaged. Reference: "crushed all
 * the way to the A-pillar" at 100mph -- FIREWALL_Z_M=0.95 sits ~1.55m behind the nose tip
 * (segments.ts's FRONT_TIP_Z), so 1.4m of persistent per-vertex accumulator lets the deepest nose
 * vertices reach past the firewall plane; combined with structuralCrush.ts's cabin-extension field
 * (what actually reads as "at the A-pillar" from every angle) this is what the eyes-on gate judges. */
export const CRUMPLE_CLAMP_EXTREME_CHASSIS_M = 1.4;

/** P014 CATASTROPHIC TIER: closing speed (m/s) at which the cosmetic chassis crumple reaches its
 * catastrophic full scale -- ~340 km/h, matching segments.ts's CATASTROPHIC_FULL_SPEED_MS. Above the
 * extreme cap (45 m/s) the per-vertex nose crush keeps deepening toward CRUMPLE_CLAMP_CATASTROPHIC_
 * CHASSIS_M so a 340 km/h nose caves visibly deeper than a 200 km/h one (the reference's near-total
 * front destruction), instead of both saturating to 1.4m. */
export const CRUMPLE_CATASTROPHIC_SPEED_CAP_MS = 94;

/** P014: absolute chassis crumple clamp (m) once the catastrophic tier is fully engaged (~340 km/h) --
 * the cosmetic per-vertex ceiling that lets the nose mesh cave in far enough to read as "crushed well
 * past the A-pillar" at the top end. Paired with segments.ts's mechanical catastrophic tier (which
 * drives the STRUCTURAL shell field to a similar depth). */
export const CRUMPLE_CLAMP_CATASTROPHIC_CHASSIS_M = 2.0;

/** Tiered replacement for the flat "min(CRUMPLE_CLAMP_CHASSIS_M, floor+coef*min(speed,cap))"
 * expression used for chassis-kind deformables (crumple.ts's applyImpactToMesh). Identical to that
 * flat expression for approachSpeedMs <= CRUMPLE_EXTREME_GATE_MS (same sub-expression, byte-for-byte
 * -- see this file's guard-pin test, sim/extreme-tier.test.mjs); ramps linearly to
 * CRUMPLE_CLAMP_EXTREME_CHASSIS_M by CRUMPLE_EXTREME_SPEED_CAP_MS above that. */
export function chassisSpeedCrushCapM(approachSpeedMs: number): number {
	const flat = Math.min(CRUMPLE_CLAMP_CHASSIS_M, CRUMPLE_CRUSH_FLOOR_M + CRUMPLE_CRUSH_SPEED_COEF_M * Math.min(approachSpeedMs, CRUMPLE_CRUSH_SPEED_CAP_MS));
	if (approachSpeedMs <= CRUMPLE_EXTREME_GATE_MS) return flat;
	if (approachSpeedMs <= CRUMPLE_EXTREME_SPEED_CAP_MS) {
		const t = (approachSpeedMs - CRUMPLE_EXTREME_GATE_MS) / (CRUMPLE_EXTREME_SPEED_CAP_MS - CRUMPLE_EXTREME_GATE_MS);
		return CRUMPLE_CLAMP_CHASSIS_M + t * (CRUMPLE_CLAMP_EXTREME_CHASSIS_M - CRUMPLE_CLAMP_CHASSIS_M);
	}
	// P014 catastrophic tier: above the extreme cap, ramp from the extreme clamp toward the catastrophic
	// clamp by CRUMPLE_CATASTROPHIC_SPEED_CAP_MS. Byte-identical for approachSpeedMs <= 45 (the extreme
	// cap): the first branch returns the exact same float, so every <=200 km/h crash is untouched.
	const t2 = Math.min(1, (approachSpeedMs - CRUMPLE_EXTREME_SPEED_CAP_MS) / (CRUMPLE_CATASTROPHIC_SPEED_CAP_MS - CRUMPLE_EXTREME_SPEED_CAP_MS));
	return CRUMPLE_CLAMP_EXTREME_CHASSIS_M + t2 * (CRUMPLE_CLAMP_CATASTROPHIC_CHASSIS_M - CRUMPLE_CLAMP_EXTREME_CHASSIS_M);
}

/** A vertex counts as "dented" (telemetry.dentedVertexCount) once its accumulated displacement
 * magnitude exceeds this (meters) -- small enough to catch real denting, large enough to ignore
 * floating-point noise. */
export const CRUMPLE_DENT_EPSILON_M = 0.0015;

/** Accumulated glass displacement (meters) past which that glass mesh "shatters" (material swap +
 * event), once, per mesh. */
export const GLASS_SHATTER_THRESHOLD_M = 0.04;

/** EXTREME TIER (Stream C slice C2): mechanical FRONT crush (segments.ts SegmentTelemetry.frontCrushM,
 * rig-independent physics truth) past which the windshield shatters outright, regardless of whether
 * the contact-dent pipeline's impact point happened to touch the glass deformable mesh directly.
 * Reference: 100mph+ frontal crush reaches the A-pillar/windshield frame -- by that point the glass
 * is gone. 0.7m sits comfortably above the NCAP-tier ceiling (CRUMPLE_CLAMP_CHASSIS_M=0.58, the
 * ≤120km/h calibrated max) so no existing crash reaches it; only the new extreme tier (161+ km/h)
 * does. Coupled via the existing glass-pane shatter path (damage/system.ts's shatterGlassPane()). */
export const WINDSHIELD_SHATTER_FRONT_CRUSH_M = 0.7;

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
