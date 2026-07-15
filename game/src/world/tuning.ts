// SPDX-License-Identifier: MIT
//
// Destructible-world tuning constants (G4 spec): stacked-block walls, crate tower, barrel bowling
// triangle, tippable poles + 2 static ramps. Renderer-free (no three/DOM import) so this file is
// shared verbatim by the browser game (main.ts) and the headless perf-bench harness
// (game/sim/perf-bench.mjs), same convention as game/src/vehicle/tuning.ts.
//
// LAYOUT (playtest MAJOR fix -- "kicker ramp unreachable"): 7 parallel lanes fanning out from the
// car's spawn point (0,0,0), facing +Z, each with its OWN clear straight approach (nothing else sits
// in a lane closer to spawn than that lane's own target) -- x positions below, ordered left to right:
//   x=-22  wall-left (brick),        clear approach, z=20
//   x=-16  crate tower,              clear approach, z=34
//   x=-9   wall-center (concrete),   clear approach, z=18 -- closest/easiest target, no longer at x=0
//   x=0    kicker ramp,              clear approach, ~43m ahead (nothing between spawn and it, and
//                                    the landing zone beyond it -- x~0, z>45 -- is also clear, so a
//                                    jump can be followed by more driving without hitting anything)
//   x=+9   wide ramp,                clear approach, z=8 (a quick, close jump)
//   x=+16  barrel triangle,          clear approach, z=34
//   x=+22  wall-right (concrete),    clear approach, z=20
// TUNING DELTA: previously the kicker ramp sat at x=-11 (11m lateral, 8m ahead -- unreachable at speed
// from a straight-ahead approach) and wall-left/crate-tower shared that SAME x=-11 lane behind it (so
// reaching them meant crossing the kicker first); wide-ramp/wall-right/barrel-triangle had the same
// problem on the x=+11 side. Every lane above is now independent -- no lane requires crossing a ramp
// (or any other body) to reach a DIFFERENT lane's target -- which also fixes the reported minor "side
// walls barely scatter" (wall-left/wall-right previously only ever took a glancing hit while
// maneuvering around a ramp; each now gets a clean, direct, head-on approach like wall-center always
// had). Poles are scattered in the gaps BETWEEN lanes (never blocking any lane's own clear approach)
// for variety/slalom flavor. All Z values are comfortably within the ground plane's play area
// (buildGround(200,40) / the physics ground half-size of 250).

import type { Q4, V3 } from '../vehicle/mathUtil';
import { IDENTITY_Q } from '../vehicle/mathUtil';
import type { FractureThreshold } from './features/fracture';

export { IDENTITY_Q };
export type { Q4 };

// ---------------------------------------------------------------------------------------------
// Stacked-block walls
// ---------------------------------------------------------------------------------------------

/** Half-extents of one wall block, meters (full size 0.5 x 0.35 x 0.35m per spec). */
export const WALL_BLOCK_HALF_EXTENTS_M: V3 = { x: 0.25, y: 0.175, z: 0.175 };
export const WALL_BLOCK_GAP_M = 0.01;
export const WALL_COLS = 6;
export const WALL_ROWS = 3;
/** Mass varies by row (bottom row heaviest, like real foundation-vs-cap masonry): row 0 (bottom)
 * = MAX, top row = MIN, linearly interpolated -- satisfies the spec's "masses varied 8-30kg". */
export const WALL_BLOCK_MASS_MIN_KG = 8;
export const WALL_BLOCK_MASS_MAX_KG = 30;
export const WALL_BLOCK_FRICTION = 0.7;
/** Effective bulk density implied by the mass/size above (~490-1840 kg/m^3, well under solid
 * concrete/brick's real ~1900-2400 kg/m^3) -- deliberately lighter than a literal solid block so a
 * whole wall stays fun/scatterable on impact rather than immovable; documented plainly as a gameplay
 * choice, same convention as game/src/damage/damage-tuning.ts's TUNING DELTA comments. */
export type WallMaterial = 'concrete' | 'brick';

export interface WallConfig {
	id: string;
	/** World position of the wall's horizontal center, at ground level (base row sits on y=0). */
	center: V3;
	material: WallMaterial;
}

export const WALL_CONFIGS: readonly WallConfig[] = [
	{ id: 'wall-center', center: { x: -9, y: 0, z: 18 }, material: 'concrete' },
	{ id: 'wall-left', center: { x: -22, y: 0, z: 20 }, material: 'brick' },
	{ id: 'wall-right', center: { x: 22, y: 0, z: 20 }, material: 'concrete' },
];

// ---------------------------------------------------------------------------------------------
// Crate tower
// ---------------------------------------------------------------------------------------------

export const CRATE_HALF_EXTENT_M = 0.3; // 0.6m cube
export const CRATE_MASS_KG = 15;
export const CRATE_GAP_M = 0.02;
export const CRATE_FRICTION = 0.65;
/** 8 layers tall (per spec); the top 2 layers taper from a 3x3 to a 2x2 footprint so the tower
 * silhouette narrows toward the top rather than reading as a plain rectangular block. */
export const CRATE_TOWER_LAYERS = 8;
export const CRATE_TOWER_WIDE_LAYERS = 6;
export const CRATE_TOWER_CENTER: V3 = { x: -16, y: 0, z: 34 };

// P011 FIX ("wooden crates should splinter/break apart on impact; currently monolithic boxes"): a
// crate has no joint (it's a free stacked box, unlike a welded pole/tree), so there's no constraint
// force to poll -- the break trigger is instead a world.hitEvents() read (same "approachSpeed * this
// body's own mass" proxy world/bodies.ts's checkHitEntityForBarrelTrigger() already uses for barrels),
// firing fractureBoxMember() (world/features/fracture.ts, called as-is) once the hit is "hard" rather
// than a gentle shove. 90 kg*m/s = a 15kg crate (CRATE_MASS_KG) hit at 6 m/s (~22 km/h) -- comfortably
// above tower-settle jitter (bodies at rest / lightly nudged never reach this), comfortably below what
// a real car-speed collision delivers, so a firm hit splinters it while a slow bump just shoves it.
export const CRATE_FRACTURE_TRIGGER_IMPULSE_KGMS = 90;
/** fractureBoxMember()'s `forceMag`/`threshold` pair only ever feeds fractureKickMagnitude()'s
 * ratio-of-two-numbers-in-the-SAME-unit computation (see that function's doc comment) -- a crate has no
 * real Newton-scale force reading (no joint), so the hit event's own kg*m/s "impulse-like" proxy is
 * reused directly as `forceMag` at call time, against this threshold expressed in the same unit.
 * torqueNm is unused by fractureBoxMember (it never reads `.torqueNm`) but FractureThreshold requires
 * it -- mirrored from forceN for a harmless, honest placeholder. */
export const CRATE_FRACTURE_THRESHOLD: FractureThreshold = { forceN: CRATE_FRACTURE_TRIGGER_IMPULSE_KGMS, torqueNm: CRATE_FRACTURE_TRIGGER_IMPULSE_KGMS };
/** Release caps for the 2 splinter fragments -- a 15kg plank should crack and tumble, not rocket. */
export const CRATE_FRAGMENT_SPEED_CAP_MS = 8;
export const CRATE_FRAGMENT_SPIN_CAP_RAD = 10;
/** Which local axis fractureBoxMember() splits along -- 'y' reads as "the lid/top separates from the
 * base", a believable crate-splinter silhouette with the simplest possible split (spec: "2-4 plank-like
 * pieces"; 2 is the low end of that range, chosen for robustness -- see this run's dispatch notes). */
export const CRATE_FRACTURE_AXIS: 'y' = 'y';

// ---------------------------------------------------------------------------------------------
// Barrel bowling triangle (10 barrels, 4 rows: 1+2+3+4)
// ---------------------------------------------------------------------------------------------

export const BARREL_RADIUS_M = 0.3;
export const BARREL_HEIGHT_M = 0.9;
export const BARREL_SIDES = 12;
/** No longer used to build the barrel triangle's REAL per-instance mass (see BARREL_FULL_MASS_KG/
 * BARREL_EMPTY_MASS_KG below, P010 fix) -- kept as the exploding-barrels feature's own FIXED reference
 * mass (world/bodies.ts's checkHitEntityForBarrelTrigger()), so that feature's pre-existing trigger/
 * chain-reaction calibration (sim/exploding-barrels.test.mjs, tuned against a uniform 25kg) stays
 * exactly as tested regardless of which full/empty variant a car actually hits. */
export const BARREL_MASS_KG = 25;
export const BARREL_FRICTION = 0.5;
export type BarrelMaterial = 'barrelBlue' | 'barrelRust';

// P010 FIX ("metal barrels don't deform when hit; want full-of-fluid vs empty variants with different
// mass and different effect on car and barrel"): a real 55-gallon (208L) steel drum full of liquid is
// ~208kg of fluid + ~20kg of steel shell =~ 228kg, rounded down slightly for gameplay feel; the SAME
// empty shell alone is ~15-20kg. Both variants keep the identical 12-gon hull/dimensions (only density
// changes), so a full barrel is a much harder, heavier obstacle (shoves the car more, barely budges
// itself) while an empty one is a nearly-weightless bowling pin (gets flung, barely slows the car).
export const BARREL_FULL_MASS_KG = 200;
export const BARREL_EMPTY_MASS_KG = 20;
/** barrelBlue = full-of-fluid (painted drums in real yards are typically the sealed/full ones), rust =
 * weathered/empty (an empty steel drum rusts through faster with no fluid coating its inside). */
export const BARREL_MASS_KG_BY_MATERIAL: Readonly<Record<BarrelMaterial, number>> = {
	barrelBlue: BARREL_FULL_MASS_KG,
	barrelRust: BARREL_EMPTY_MASS_KG,
};

/** Entity-id base for crates/poles, tagged EXPLICITLY at build time (unlike wall blocks, which still
 * rely on createDestructibleWorld()'s post-hoc "tag whatever's still 0" sweep) -- P011/P009 fracture
 * bookkeeping (world/bodies.ts's CrateProp/PoleProp) needs each prop's real entity id available AT
 * BUILD TIME (for its own entityId->prop lookup map), before that post-hoc sweep ever runs. Disjoint
 * from every other range: barrels=44,000,000-44,000,009 (BARREL_ENTITY_ID_BASE), fracture
 * fragments=45,000,000+ (features/fracture.ts), trees=46,000,000+, buildings=47,000,000+, legacy
 * (walls, and anything left untagged)=48,000,000+. */
export const CRATE_ENTITY_ID_BASE = 44_100_000;
export const POLE_ENTITY_ID_BASE = 44_200_000;

// ---- Barrel DENT (visual-only, physics hull unchanged -- P010's other half) ----
// world/visuals.ts borrows damage/crumple.ts's registerDeformable()/applyImpactToMesh()/
// recomputeNormals() (imported only, that module is not edited) to displace the barrel MESH's own
// vertices radially at the hit point -- same technique the car's own crumple already uses, just
// applied to a barrel's CylinderGeometry instead of the car shell. Trigger: any world.hitEvents() hit
// on a barrel above this closing speed (a firm knock, not a stationary-contact jitter).
export const BARREL_DENT_TRIGGER_SPEED_MS = 2.5;
/** applyImpactToMesh()'s `massFactor` parameter scales dent DEPTH only (not the affected radius) --
 * an EMPTY drum is an unsupported thin steel shell (dents deeply, like a soda can); a FULL one is
 * backed by near-incompressible fluid, which resists caving in nearly as much (spec: "empty barrels
 * dent MORE than full ones").
 *
 * ROUND-2 RE-TUNE (P010 gate: "no dent discernible by eye; dent claim numeric only"). MEASURED
 * (applyImpactToMesh()'s own math, damage/crumple.ts, not touched here): at a firm 40 km/h hit,
 * approachSpeedMs~11.1 gives magBase = CRUMPLE_MAG_COEF_M_PER_MS * min(11.1, cap) ~= 0.333m at the
 * impact center BEFORE massFactor/clamping -- already well past the barrel's own clamp ceiling
 * (mesh.kind='panel' -> CRUMPLE_CLAMP_PANEL_GLASS_M = 0.12m, damage-tuning.ts). With the OLD factors
 * (full=0.35, empty=1.0) both variants landed within ~3% of that SAME 0.12m ceiling (full: 0.333*0.35
 * = 0.1165, clamps to ~itself; empty: 0.333*1.0 = 0.333, clamps to 0.12) -- numerically "dented" but
 * visually near-indistinguishable, and neither reads as a deliberate crease vs. the barrel's own
 * 12-gon facets at normal screenshot distance. Re-tuned for real contrast, still bounded by the SAME
 * unmodified clamp (this file owns no clamp/radius/falloff constant -- those are damage/damage-
 * tuning.ts, out of scope): EMPTY raised to 1.6 so a much WIDER share of the impact radius (not just
 * the exact center point) saturates the 0.12m clamp -- a genuinely wide, deep, flat-bottomed crater,
 * "crushed like a soda can" rather than a pinprick. FULL cut to 0.12 so its peak dent (0.333*0.12 =
 * 0.04m, comfortably under the clamp, no saturation) reads as a shallow dimple -- a real, visible mark
 * but nowhere near the empty drum's crater, matching "200kg full one dents less". Both variants still
 * clear CRUMPLE_DENT_EPSILON_M (0.0015m) by more than an order of magnitude, so dentedVertexCount>0 is
 * not a knife's-edge pass either way -- see sim/props-pole-barrel-crate.test.mjs's extended P010 case
 * for the measured before/after numbers this produced. */
export const BARREL_DENT_MASS_FACTOR_FULL = 0.12;
export const BARREL_DENT_MASS_FACTOR_EMPTY = 1.6;
/** Apex barrel position (row 1); rows 2-4 extend toward +Z (away from spawn), so a car approaching
 * from spawn hits the apex first, like a bowling ball. */
export const BARREL_TRIANGLE_APEX: V3 = { x: 16, y: 0, z: 34 };
export const BARREL_ROW_SPACING_M = BARREL_RADIUS_M * Math.sqrt(3) * 1.05;
export const BARREL_LATERAL_SPACING_M = BARREL_RADIUS_M * 2 * 1.05;

// ---------------------------------------------------------------------------------------------
// Exploding barrels (world.explode() chain-reaction feature -- see bodies.ts's stepExplodingBarrels()/
// triggerBarrelExplosion()).
//
// ENTITY IDS: each barrel body gets tagged (Body.setUserData()) with BARREL_ENTITY_ID_BASE + its
// index in the barrel triangle (0-9), so world.hitEvents() can resolve "which barrel got hit" back to
// this module's own bookkeeping. Kept in a disjoint numeric range from every other entity-id scheme in
// the codebase: chassis=1, wheels=2-5 (vehicle/tuning.ts's CAR_ENTITY_ID), panels=6-11
// (damage/panels.ts's PANEL_ENTITY_ID), occupants=1000-1399 (occupants/physics.ts's entityIdFor()),
// cardetail=88,100,000+/88,200,000+ (cardetail/tuning.ts) -- 44,000,000 sits nowhere near any of those.
export const BARREL_ENTITY_ID_BASE = 44_000_000;

/** Entity-id base for every OTHER legacy destructible (wall blocks, crates, poles -- barrels keep
 * their own BARREL_ENTITY_ID_BASE range above), tagged at spawn (world/bodies.ts) so main.ts can
 * register each body's real mass into the damage system's foreign-mass registry (fracture spec §E:
 * a 15kg crate must not hit the car with wall-strength damage). Disjoint from every other range:
 * barrels=44,000,000+, fracture fragments=45,000,000+ (features/fracture.ts), trees members=
 * 46,000,000+ (trees/bodies.ts), buildings pieces=47,000,000+ (buildings/structures.ts). */
export const LEGACY_DESTRUCTIBLE_ENTITY_ID_BASE = 48_000_000;

/** Trigger threshold, kg*m/s -- deliberately built from ONLY the struck barrel's own (always-known)
 * mass and the hit event's own approachSpeed (types.h's b3ContactHitEvent field, already the real
 * relative closing speed at the contact point), rather than the OTHER body's mass: this module has no
 * reference to the car/other destructibles' Body objects (bodies.ts's ownership boundary -- see the
 * G4-run dispatch brief's STRICT OWNERSHIP), and approachSpeed*barrelMass is already a physically
 * sound proxy for "how hard did THIS barrel just get hit" regardless of what hit it (car, flying
 * debris, or a neighboring barrel's blast) -- in a near-inelastic hit the barrel picks up roughly
 * `approachSpeed` of velocity, so this is approximately the impulse the barrel itself absorbed.
 * 200 kg*m/s = a 25kg barrel (BARREL_MASS_KG) hit at 8 m/s (~29 km/h) -- a firm hit, not a graze. */
export const BARREL_EXPLOSION_TRIGGER_IMPULSE_KGMS = 200;

/** b3World_Explode's radius/falloff (see World.explode() in ../../../src/ts/world.ts): full-strength
 * out to RADIUS_M, linearly ramping to zero over the next FALLOFF_M, nothing beyond their sum.
 * Calibrated against the real barrel triangle + a full-size vehicle (game/sim/_tune-explosion.mjs, a
 * throwaway probe run against createDestructibleWorld() before landing these numbers): at
 * IMPULSE_PER_AREA=1400, a 10m-distant car (just inside RADIUS_M+FALLOFF_M=12m) picks up ~2 m/s of
 * shove velocity (a real hit, not vaporization) while the barrel's own immediate neighbors (the other
 * 9 barrels, all within a couple meters of the triangle apex) scatter hard. */
export const BARREL_EXPLOSION_RADIUS_M = 6;
export const BARREL_EXPLOSION_FALLOFF_M = 6;
export const BARREL_EXPLOSION_IMPULSE_PER_AREA = 1400;

/** The exploding barrel's OWN impulse (box3d.h's b3World_Explode gives it almost nothing useful --
 * vendor/box3d/src/physics_world.c's ExplosionCallback falls back to an arbitrary +X direction for a
 * shape sitting exactly at the blast center, distance==0 -- so the "they famously rocket" effect is
 * applied directly via Body.applyLinearImpulseToCenter() instead, see bodies.ts's
 * triggerBarrelExplosion()), expressed as a TARGET LAUNCH SPEED (m/s), not a flat impulse -- the actual
 * impulse applied is `speed * this barrel's OWN real mass` (bodies.ts), so every barrel launches at
 * roughly the SAME ~18 m/s regardless of which P010 mass variant (full ~200kg / empty ~20kg) it is.
 * P010 FIX HISTORY: this was originally a flat 450/120 kg*m/s impulse (byte-identical to `18/4.8 * 25`
 * for the old uniform 25kg barrel), which worked fine when every barrel weighed the same -- but once
 * P010 gave full/empty barrels real, very different masses, that SAME flat impulse launched an empty
 * (20kg) barrel at ~23 m/s while barely nudging a full (200kg) one at ~2 m/s. The heavy barrels then
 * stayed clustered near the car instead of scattering, and a chain reaction's several world.explode()
 * blasts landing on that dense pile-up wrongly ACCELERATED the car to >200 km/h instead of slowing it
 * (measured directly: sim/exploding-barrels.test.mjs's (b) case, speedAfter=62.5 m/s vs the
 * expected/tested "speed drops" outcome) -- a genuine physics bug from the mass split, not a feature.
 * Scaling the impulse by real mass restores every barrel's ~18 m/s launch (byte-identical to the old
 * 25kg case, since 18*25=450 exactly) regardless of variant, fixing the pile-up. */
export const BARREL_ROCKET_UPWARD_SPEED_MS = 18;
export const BARREL_ROCKET_JITTER_SPEED_MS = 4.8;

/** Chain reaction: every other not-yet-exploded, not-yet-fused barrel within this distance of a fresh
 * explosion gets a short random fuse (see bodies.ts's triggerBarrelExplosion()). Same distance as the
 * blast's own total reach (RADIUS_M+FALLOFF_M) -- if a barrel is close enough to feel ANY blast
 * impulse, it's close enough to plausibly cook off too. */
export const BARREL_CHAIN_RADIUS_M = BARREL_EXPLOSION_RADIUS_M + BARREL_EXPLOSION_FALLOFF_M;
/** Fuse delay range, seconds -- "short random-free fuse delay" per the dispatch brief; both bounds
 * comfortably under the G4-run acceptance test's 1.5s chain-reaction window. */
export const BARREL_CHAIN_FUSE_MIN_S = 0.15;
export const BARREL_CHAIN_FUSE_MAX_S = 0.45;
/** Default seed for the deterministic mulberry32-style RNG driving fuse-delay jitter (bodies.ts's
 * nextRandom()) -- same seed + same sequence of triggers always reproduces the same fuse timings.
 * Reset to this exact value by resetDestructibleWorld() so a world reset can never leave two runs of
 * "drive into the barrels" observing different chain timings. */
export const BARREL_EXPLOSION_SEED = 1337;

// ---- Fireball/smoke visual burst tuning (world/visuals.ts's spawnExplosionEffects()) ----
export const FIREBALL_CORE_LIFETIME_S = 0.5;
export const FIREBALL_CORE_MAX_SCALE_M = 5;
export const SMOKE_LIFETIME_S = 2.2;
/** Kept modest relative to BARREL_CHAIN_RADIUS_M (12m): the whole 10-barrel triangle sits inside one
 * chain radius of the apex, so a full cascade lights ~10 bursts within under a second -- a larger
 * value here stacks enough overlapping semi-transparent smoke sprites to fog out the ENTIRE screen for
 * a nearby camera (caught in verify/shoot-exploding-barrels.mjs's own screenshot, tuned down from an
 * initial 8 after that looked like a whiteout, not "billowing smoke"). */
export const SMOKE_MAX_SCALE_M = 5;
export const FIREBALL_SPRITES_PER_BURST = 5;
export const SMOKE_SPRITES_PER_BURST = 3;

// ---------------------------------------------------------------------------------------------
// Utility poles (P009 FIX: "the pole prop does nothing to the car, doesn't look like a utility pole,
// and should be rooted in the ground and behave like trees (lean/snap)").
//
// REBUILT from a free-standing, friction-rested 40kg box (no joint/anchor -- a car could push it
// around like an empty box) into a tall dynamic CAPSULE shaft, ROOTED to a static ground anchor by a
// stiff WeldJoint that's angularly COMPLIANT (same "bend under load, snap past a threshold" technique
// as world/features/trees/bodies.ts's mid-trunk weld -- reimplemented independently here per this run's
// file ownership, NOT imported from trees/*): a light bump just shudders/leans the pole on its
// compliant root, a real ~50km/h+ hit snaps it at the base (fractureCapsuleTrunk(), world/features/
// fracture.ts, called as-is) into a short anchored STUMP + a flying top piece carrying the cross-arm.
// A capsule shape DOES support an off-origin center1/center2 (unlike a box, see the now-removed
// POLE_SHAFT_HALF_EXTENTS_M note this replaces), so the shaft itself needs no compound-shape workaround.
// ---------------------------------------------------------------------------------------------

/** 8.2m dynamic shaft (a real wood utility pole's above-ground run is commonly ~8-9m of a longer pole
 * sunk partway into the ground -- this capsule stands in for the whole visible/collidable above-ground
 * portion), radius 0.13m (~26cm diameter, a real distribution pole's butt-class diameter). */
export const POLE_SHAFT_RADIUS_M = 0.13;
export const POLE_HEIGHT_M = 8.2;
/** A real creosote/CCA-treated wood distribution pole this size runs roughly 350-500kg; 420kg sits
 * mid-band (spec's own range). */
export const POLE_MASS_KG = 420;
export const POLE_FRICTION = 0.6;

/** Root weld: rigid linearly (hertz 0, so the base never sinks/sways sideways at rest) but angularly
 * COMPLIANT (a soft torsion spring) so the pole visibly leans/creaks under a sub-break-threshold hit
 * and springs back -- same destruction-feel technique as trees/tuning.ts's MID_WELD_ANGULAR_HERTZ. */
export const POLE_WELD_LINEAR_HERTZ = 0;
export const POLE_WELD_ANGULAR_HERTZ = 5;
export const POLE_WELD_DAMPING_RATIO = 0.75;

/** Break (snap) thresholds -- constraint force/torque magnitude, polled per-step like the mid tree's
 * root weld. Calibrated empirically (game/sim/props-pole-barrel-crate.test.mjs) against the game's real
 * ~1750kg car (vehicle/tuning.ts's CHASSIS_MASS_KG+PANEL/WHEEL totals) so a gentle nudge (~10km/h) only
 * shudders the pole, while a real ~50km/h+ hit reliably snaps it at the base -- deliberately LOWER than
 * trees/tuning.ts's MID tree thresholds (550,000N/140,000Nm on a much thicker, 320kg trunk): a utility
 * pole is thin and meant to snap in a vehicle collision (real breakaway-pole road-safety design), not
 * stand like a tree. */
export const POLE_FORCE_THRESHOLD_N = 65_000;
export const POLE_TORQUE_THRESHOLD_NM = 40_000;
export const POLE_FRACTURE_THRESHOLD: FractureThreshold = { forceN: POLE_FORCE_THRESHOLD_N, torqueNm: POLE_TORQUE_THRESHOLD_NM };

/** Nominal stump fraction for the base-third snap (fractureCapsuleTrunk jitters it +/-15% per member,
 * same convention as trees/tuning.ts's MID_STUMP_FRACTION doc comment). */
export const POLE_STUMP_FRACTION = 0.28;
/** Release caps for the flying top piece (carries the cross-arm) -- tumbles, doesn't rocket. */
export const POLE_FRAGMENT_SPEED_CAP_MS = 10;
export const POLE_FRAGMENT_SPIN_CAP_RAD = 7;

// ---- Cross-arm + insulator-peg visual dressing (world/visuals.ts) -- purely cosmetic children of the
// shaft mesh (no separate collision shape: see the module doc above on why a box compound isn't
// constructible here, and a non-colliding decorative cross-arm is a harmless, documented scope cut --
// the shaft capsule alone is what the car actually hits). Placed near the shaft's top. ----
export const POLE_CROSSARM_HEIGHT_FRACTION = 0.9; // fraction of POLE_HEIGHT_M up the shaft
export const POLE_CROSSARM_LENGTH_M = 1.5;
export const POLE_CROSSARM_HALF_THICKNESS_M = 0.06;
export const POLE_INSULATOR_COUNT: number = 3;
export const POLE_INSULATOR_RADIUS_M = 0.045;
export const POLE_INSULATOR_HEIGHT_M = 0.11;

// COMPOUND overhaul: the poles now form a "light-row along the drive" -- two neat rows flanking the
// north driveway line (x=0) at x=+-12, never inside the kicker lane (x=0) or the wide ramp's footprint
// (x in [7.5,10.5], z in [8,12]). All sit on the yard's hard-flat interior (z<=42).
export const POLE_POSITIONS: readonly V3[] = [
	{ x: -12, y: 0, z: 10 },
	{ x: -12, y: 0, z: 26 },
	{ x: -12, y: 0, z: 42 },
	{ x: 12, y: 0, z: 10 },
	{ x: 12, y: 0, z: 26 },
	{ x: 12, y: 0, z: 42 },
];

// ---------------------------------------------------------------------------------------------
// Static ramps -- convex-hull wedges (box3d computes the hull itself from a flat point cloud, same
// pattern as vehicle/geometry.ts's buildChassisHullPoints()): a flat rectangular base plus a raised
// front ridge, giving a single inclined face at atan(height/length).
// ---------------------------------------------------------------------------------------------

export interface RampConfig {
	id: 'kicker' | 'wide';
	angleDeg: number;
	width: number;
	length: number;
	height: number;
	/** World Z of the ramp's low (entry) edge; the raised edge sits at backZ + length. */
	backZ: number;
	centerX: number;
	/** Down-slope length on the exit side (see bodies.ts's wedgeHullPoints() doc comment) -- 0 (the
	 * original sheer knife-edge drop) unless a config sets it explicitly. */
	backSlopeLength?: number;
}

const KICKER_HEIGHT_M = 1.2;
const KICKER_ANGLE_DEG = 25;
const KICKER_LENGTH_M = KICKER_HEIGHT_M / Math.tan((KICKER_ANGLE_DEG * Math.PI) / 180);

// KICKER-BEACHING FIX (playtest MAJOR "~1/3 of straight-north full-throttle drives beach the car
// rear-wheels-up on the kicker ramp, permanently"): root cause is vehicle.ts's updateGroundAuthority()
// -- drive-torque authority is cut to ~0 the instant fewer than 3 wheels are grounded (an honest
// "no traction assist mid-air" rule, not a bug in itself). The ORIGINAL 30deg wedge met its vertical
// drop-off at a single zero-width knife edge: a car that reached the ridge without enough speed to
// truly launch could end up with its FRONT axle hanging in open air past the drop (no ground, 0
// authority) while the REAR axle was still on the steep incline -- and because nothing at all
// supported the front axle, that pose was a stable mechanical deadlock: 0 drive authority forever, so
// throttle (or reverse) could never recover it (measured directly: game/verify/playtest-r3/diag-gate5.mjs
// + a 1200-extra-step longwait probe -- position/speed byte-identical 20 REAL seconds later; real
// browser build, repeated resetWorld()+full-throttle-straight runs: 3/10 permanent stalls).
//
// FIX HISTORY (both measured against the real browser build, not just headless -- headless box3d-js
// turned out to be fully deterministic run-to-run here and never reproduced the stall at all, so only
// the actual production build is informative for this specific bug):
//   ATTEMPT 1 (deck, reverted): extending the crest into a flat "table" before the same vertical drop
//     -- the intuitive fix (give the wheelbase room to cross the incline/vertical discontinuity
//     together) -- measured WORSE: 3/10 -> 6/10 permanent stalls. A longer flat run gives the car MORE
//     distance to bleed speed before the still-sheer drop, more often leaving it short of the momentum
//     to clear it. A longer knife-edge approach is not the lever.
//   ATTEMPT 2 (30deg + a continuous "roof" down-slope instead of the vertical drop, reverted): removes
//     the knife edge entirely (see bodies.ts's wedgeHullPoints() `downLength` param, kept as available
//     infra below at 0) so a short-of-launch-speed wheel just rolls down a supported surface instead of
//     hanging in open air -- measured NO better at 30deg (~60-70% still stalled) AND it broke
//     asymmetric-launch.test.mjs's free-flight measurements (the down-slope clips a low/slow half-on
//     launch mid-flight, which isn't a bug in the ramp, just incompatible with that test's ballistic-
//     flight assumption).
//   ATTEMPT 3 (angle only, SHIPPED): gentling the up-face itself from 30deg to 25deg -- less abrupt
//     momentum loss on the climb, so a full-throttle straight-north arrival (measured ~55-90km/h at the
//     ramp) clears the ridge with real speed to spare instead of sitting right at a stall/clear
//     boundary. Measured: 3/10 -> 0/10 permanent stalls (10-run browser samples, repeated). The
//     down-slope infra from attempt 2 is kept (KICKER_BACK_SLOPE_LENGTH_M below, currently 0 for both
//     ramps) since it's inert and harmless, but the angle change alone is what fixed this.
const KICKER_BACK_SLOPE_LENGTH_M = 0;

const WIDE_RAMP_ANGLE_DEG = 15;
const WIDE_RAMP_LENGTH_M = 4;
const WIDE_RAMP_HEIGHT_M = WIDE_RAMP_LENGTH_M * Math.tan((WIDE_RAMP_ANGLE_DEG * Math.PI) / 180);

// TUNING DELTA (playtest MAJOR "kicker ramp unreachable"): the kicker used to sit at centerX=-11,
// backZ=8 -- 8m ahead but 11m lateral from spawn, so a straight-ahead approach at speed could never
// line up with it. Moved to centerX=0 (directly ahead of spawn, which is itself at x=0 --
// vehicle.ts's createVehicle() default spawnPosition), backZ=43 (~45m ahead including the ramp's own
// length, per this file's LAYOUT doc comment) -- a genuinely clear, reachable straight shot. The wide
// ramp moves from centerX=11 to +9 (still its own dedicated lane, just renumbered to fit the new
// 7-lane spacing -- see the LAYOUT doc comment above).
export const RAMP_CONFIGS: readonly RampConfig[] = [
	{ id: 'kicker', angleDeg: KICKER_ANGLE_DEG, width: 2.4, length: KICKER_LENGTH_M, height: KICKER_HEIGHT_M, backZ: 43, centerX: 0, backSlopeLength: KICKER_BACK_SLOPE_LENGTH_M },
	{ id: 'wide', angleDeg: WIDE_RAMP_ANGLE_DEG, width: 3, length: WIDE_RAMP_LENGTH_M, height: WIDE_RAMP_HEIGHT_M, backZ: 8, centerX: 9 },
];

export const RAMP_FRICTION = 0.9;
