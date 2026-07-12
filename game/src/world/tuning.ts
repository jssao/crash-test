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

// ---------------------------------------------------------------------------------------------
// Barrel bowling triangle (10 barrels, 4 rows: 1+2+3+4)
// ---------------------------------------------------------------------------------------------

export const BARREL_RADIUS_M = 0.3;
export const BARREL_HEIGHT_M = 0.9;
export const BARREL_SIDES = 12;
export const BARREL_MASS_KG = 25;
export const BARREL_FRICTION = 0.5;
export type BarrelMaterial = 'barrelBlue' | 'barrelRust';
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
 * triggerBarrelExplosion()). 450 kg*m/s straight up on a 25kg barrel = ~18 m/s launch speed (~1.7s of
 * airtime) -- a real "rocketing" barrel, not a twitch. JITTER adds a small deterministic sideways
 * component (direction from this module's seeded RNG -- see bodies.ts's nextRandom()) so the barrel
 * tumbles/arcs rather than going perfectly vertical every time. */
export const BARREL_ROCKET_UPWARD_IMPULSE_KGMS = 450;
export const BARREL_ROCKET_JITTER_KGMS = 120;

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
// Tippable poles.
//
// SPEC NOTE ("base slightly heavier via two-shape compound of boxes if easy, else uniform"): NOT
// easy, so this falls back to the spec's explicit "uniform" alternative -- box3d-js's box shapes have
// no off-origin `center` field (only sphere/capsule do -- see ../vehicle/geometry.ts's ballast doc
// comment on vehicle/tuning.ts's COM_LOWER_OFFSET_M, which hit the exact same limitation for the
// chassis), so a literal "shaft box + separately-positioned heavier base box" compound isn't
// constructible in this binding (both boxes would sit at the same body-local origin). A uniform
// single box (post) is used instead -- documented plainly as a scope cut, not silently downgraded.
// ---------------------------------------------------------------------------------------------

/** Half-extents, meters (0.15 x 2.5m post). Body origin sits at half-height so the post's bottom
 * face rests on the ground (y=0) -- see bodies.ts's buildPoles(). */
export const POLE_SHAFT_HALF_EXTENTS_M: V3 = { x: 0.075, y: 1.25, z: 0.075 };
export const POLE_MASS_KG = 40;
export const POLE_FRICTION = 0.6;

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
