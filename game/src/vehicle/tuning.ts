// SPDX-License-Identifier: MIT
//
// All vehicle tuning constants live here (per G2 spec). This module imports nothing but
// car-map.ts (plain measured data, no three/DOM) so it can be shared between the renderer-side
// vehicle assembly (game/src/vehicle/vehicle.ts) and the headless sim harness (game/sim/harness.mjs)
// without pulling three.js into the physics core.
//
// Values below are the spec's starting points, then hand-tuned against the five headless drive
// tests in game/sim/*.test.mjs -- see the "TUNING DELTAS" comments next to any constant that moved
// from its starting value, with the reason.

import { CAR_MAP } from '../assets/car-map';

// ---------------------------------------------------------------------------------------------
// Chassis mass + geometry
// ---------------------------------------------------------------------------------------------

/**
 * Target total chassis (sprung) mass, kg -- hull shell + ballast combined (includes the 9 crush
 * segments, vehicle/segments.ts -- their mass is DEDUCTED from this figure at construction time, not
 * additional to it; see segment-mass-parity.test.mjs).
 *
 * TUNING DELTA (G3 damage system): was 1350 pre-damage. The detachable panel bodies
 * (game/src/damage/panels.ts, welded to the chassis in vehicle.ts's createVehicle()) add their own
 * mass, carried as SEPARATE bodies rather than baked into this hull+ballast figure.
 *
 * PHASE R RE-MASS (2026-07-12, S90 realistic-curb-weight calibration pass -- the TODO the S90-swap
 * pass deliberately deferred, see git history for that comment): total car mass raised from the
 * swap's mass-conserving 1438kg to 1750kg, picked as the midpoint of the real S90's published curb
 * weight range (~1700-1900kg per trim) and a round, documentable number. Split across the 3 mass
 * pools:
 *   - PANELS (damage-tuning.ts PANEL_MASS_KG): bumped to a plausible heavier-S90-door set, 116kg
 *     total (hood16 + doorL22 + doorR22 + doorRL20 + doorRR20 + trunk16) -- doors specifically
 *     heavier than the swap's 89kg (real power windows/speakers/side-impact beams), not a uniform
 *     scale-up.
 *   - WHEELS (WHEEL_MASS_KG below): bumped 22 -> 25kg each (100kg total) -- a heavier sedan rides on
 *     more substantial wheel/tire/brake-rotor assemblies than the swap's carried-over 22kg.
 *   - CHASSIS_MASS_KG (this constant): the remainder, 1750 - 116 - 100 = 1534kg. Scale factor vs the
 *     swap's 1261kg = 1534/1261 = 1.2166 -- applied uniformly to the 9 crush segments
 *     (vehicle/segments.ts SEGMENT_SPECS, 135kg -> 164kg, see that file's comment for the per-segment
 *     arithmetic) so the crush structure's mass grows in the same proportion as the sprung mass it's
 *     carved out of; the non-segment hull+ballast remainder (1126kg -> 1370kg) grows by the identical
 *     1.2166 factor as a consequence (1534-164=1370; 1370/1126=1.2167, consistent within rounding).
 * Total: 1534 (chassis, incl. 164 segments) + 116 (panels) + 100 (wheels) = 1750kg exactly.
 */
export const CHASSIS_MASS_KG = 1534;

/**
 * Each wheel's rigid-body mass, kg.
 *
 * PHASE R RE-MASS (2026-07-12): bumped 22 -> 25kg -- see CHASSIS_MASS_KG's doc comment for the full
 * mass-split arithmetic. A heavier sedan's wheel/tire/rotor assembly plausibly outweighs the swap's
 * carried-over Mustang figure; 25kg/wheel (100kg total) is still an ordinary road-wheel mass, not an
 * outlier.
 */
export const WHEEL_MASS_KG = 25;

/**
 * Shared box3d collision-filter group index for EVERY car body's shapes (chassis hull, ballast
 * sensor, wheel spheres, damage-system panel boxes) -- box3d/box2d filter convention: a NEGATIVE
 * shared group index means shapes in that group NEVER collide with each other, overriding
 * category/mask bits, regardless of collideConnected on any joint between them. Set on every car
 * shape (vehicle.ts, game/src/damage/panels.ts) so panels/wheels/chassis can never self-collide --
 * upgrades the previous per-joint `collideConnected: false` (which only ever covered the specific
 * chassis<->wheel pairs with an actual joint between them, not e.g. wheel-vs-wheel or panel-vs-wheel).
 * Ground/wall/other world bodies keep the default groupIndex 0, so this has zero effect on car-vs-
 * environment collisions -- only car-vs-own-parts.
 */
export const CAR_GROUP_INDEX = -1;

// ---------------------------------------------------------------------------------------------
// COLLISION-FILTER CATEGORY-BIT REGISTRY (Tier-3 Stage 2, the occupant FILTER PATH). Box3d filters:
// a pair collides iff (catA & maskB) && (catB & maskA), unless a shared negative groupIndex vetoes
// it first. DEFAULT_CATEGORY_BITS/DEFAULT_MASK_BITS are all-ones, so a bit listed here is present on
// EVERY shape unless a creation site explicitly clears it. All project category bits live in this
// one table so they can never collide:
//   1n << 4n, 1n << 8n, 1n << 9n, 1n << 10n
//             SEAT_PAN_CATEGORY_BITS (below; re-exported by occupants/tuning.ts) -- one bit PER
//             SEAT (index 0-3); each seat pan carries ONLY its own seat's bit as its category.
//   1n << 5n  OCCUPANT_COLLIDABLE_BIT (below) -- cleared from car volumes occupants pass through.
//   1n << 6n  OCCUPANT_CATEGORY_BIT (below) -- the occupant capsules' own (only) category bit; also
//             the SOLE bit CLEARED from every static ground's category (GROUND_CATEGORY_BITS) so the
//             occupant-only FOOTWELL SHELF (mask = this bit) never beaches the car on the terrain.
//   1n << 7n  OCCUPANT_EJECTED_COLLIDABLE_BIT (below) -- panels: ejected-only occupant collision.
// The four SEAT_PAN_CATEGORY_BITS are ALSO reused as the FOOTWELL SHELF's category (front row = seats
// 0,1; rear = seats 2,3, FOOTWELL_SHELF_*_CATEGORY_BITS below): a seated occupant's own seat bit
// makes it rest on its row's ledge, while an ejected occupant (seat bits dropped from its mask) flies
// straight through -- the ledge holds feet without ever blocking ejection.
// (1n << 3n was the retired EJECTED_MARKER_BIT -- Stage 2 replaced the whole ejected-filter-flip
// machinery with the real category scheme below; the bit is left unassigned deliberately.)
// ---------------------------------------------------------------------------------------------

/** All-ones filter word, mirroring the binding's DEFAULT_CATEGORY_BITS/DEFAULT_MASK_BITS
 * (src/ts/math.ts) -- not imported because this module deliberately imports nothing but car-map.ts
 * (see the module doc); game/sim/hull-cabin-tub.test.mjs asserts the mirror stays equal. */
const ALL_FILTER_BITS = 0xffffffffffffffffn;

/** Seat pans carry ONLY their own seat's category bit, one bit PER SEAT INDEX (occupants/tuning.ts
 * re-exports these; see its seat-pan doc comment): a SEATED occupant's mask includes its OWN seat's
 * bit only -- the pelvis rests on its own pan via real contact, while the OTHER three rigid-welded
 * pans are transparent to it (MEASURED: rear occupants sliding forward under a plain 0.5-brake
 * slammed the FRONT seats' pans -- a rigid weld to the 1300kg chassis, i.e. a wall mid-cabin -- for
 * single-step 3.1-3.2x belt-threshold spikes that ejected both rears during ordinary driving; a
 * flick maneuver likewise wedged a rear shin between its own pan edge and the sill for a 3.0x
 * spike). An EJECTED occupant's mask drops all pan bits (a body flying across the cabin must not be
 * arrested by ANY rigid-welded pan). Defined here (not in occupants/tuning.ts) because
 * vehicle.ts/panels.ts/cardetail need the derived category words below and the vehicle core must
 * not import a world feature's module. */
export const SEAT_PAN_CATEGORY_BITS: readonly bigint[] = [1n << 4n, 1n << 8n, 1n << 9n, 1n << 10n];

/** Every seat pan bit OR'd -- the word cleared from occupant-transparent car volumes' categories
 * (any occupant's seated mask contains exactly one of these) and masked out of rays that must not
 * hit pans. */
export const SEAT_PAN_ALL_CATEGORY_BITS = SEAT_PAN_CATEGORY_BITS.reduce((a, b) => a | b, 0n);

/**
 * "A SEATED occupant can collide with this shape" marker bit. Present by default on every shape in
 * the world (ground/walls/trees/buildings, the cabin INTERIOR shells -- floorpan/sills/roof/pillars
 * -- and the glass panes), and explicitly CLEARED from the car volumes occupants must pass through
 * un-contested: the solid NOSE and TAIL crush volumes (seated front legs/feet live inside the nose,
 * rear torsos/heads inside the tail -- measured, see the Stage-2 design in
 * docs/build-log/specs/compound-hull-design.md), the WHEEL spheres, the cardetail parts
 * (brakeBoosterMC shares firewall space with the front knees), and the damage PANELS (measured: the
 * hood box's rear edge sits ~4cm from the braced front torsos and the door boxes span the window
 * band beside the shoulders -- seated contact against them pumped crash-magnitude spikes through
 * the belts during ordinary cornering). Occupant capsule maskBits are built EXCLUSIVELY from the
 * three OCCUPANT_* bits here, so clearing them from a shape's category makes it occupant-
 * transparent without touching how anything else (world, rays, other car parts) sees that shape.
 */
export const OCCUPANT_COLLIDABLE_BIT = 1n << 5n;

/** The ONLY category bit occupant capsules carry. Rays/queries that must never hit an occupant
 * (e.g. the occupant ground-height raycast in occupants/active.ts) mask this bit OUT; everything
 * else's default all-ones mask still sees occupants normally. */
export const OCCUPANT_CATEGORY_BIT = 1n << 6n;

/**
 * "An EJECTED occupant can collide with this shape" marker bit -- carried (beyond the default-
 * category shapes) ONLY by the damage panels (hood/doors/trunk, attached AND broken) and the two
 * GLASS PANES (vehicle.ts): an ejected body or corpse must land on / rest ON the hood, bounce off
 * doors from outside, and punch THROUGH the windshield pane (the visible Stage-2 payoffs), but a
 * SEATED occupant must not fight those same shapes from inside the cabin -- the door boxes' window
 * band and the hood's cowl edge overlap the seated envelope, and a soft-belted torso lurching into
 * the pane band during a hard flick got solver-squeezed between belt and pane for crash-magnitude
 * belt spikes (and would false-shatter the windshield during ordinary hard driving) -- measured,
 * see OCCUPANT_COLLIDABLE_BIT's doc + the Stage-2 sim/diag probes. Ejected masks are
 * OCCUPANT_COLLIDABLE_BIT | OCCUPANT_EJECTED_COLLIDABLE_BIT; seated masks are
 * OCCUPANT_COLLIDABLE_BIT | that seat's own SEAT_PAN_CATEGORY_BITS entry.
 */
export const OCCUPANT_EJECTED_COLLIDABLE_BIT = 1n << 7n;

/** categoryBits for car volumes occupants NEVER collide with (nose/tail crush volumes, wheels,
 * cardetail parts): default categories minus every bit an occupant mask can contain. Their masks
 * stay default, but a pair needs (catA & maskB) AND (catB & maskA), so clearing the occupant-facing
 * bits from the category alone fully suppresses the occupant pair while leaving every other
 * interaction (world contacts, rays, hit events) byte-identical. */
export const OCCUPANT_TRANSPARENT_CATEGORY_BITS =
	~(OCCUPANT_COLLIDABLE_BIT | SEAT_PAN_ALL_CATEGORY_BITS | OCCUPANT_EJECTED_COLLIDABLE_BIT) & ALL_FILTER_BITS;

/** categoryBits for shapes an occupant touches only once EJECTED: the damage PANELS
 * (game/src/damage/panels.ts) and the GLASS PANES (vehicle.ts) -- occupant-transparent while SEATED
 * (OCCUPANT_COLLIDABLE_BIT and the pan bits cleared) but collidable for EJECTED bodies
 * (OCCUPANT_EJECTED_COLLIDABLE_BIT kept) -- see that bit's doc comment. */
export const EJECTED_ONLY_OCCUPANT_CATEGORY_BITS = ~(OCCUPANT_COLLIDABLE_BIT | SEAT_PAN_ALL_CATEGORY_BITS) & ALL_FILTER_BITS;

/**
 * categoryBits for every STATIC GROUND SURFACE -- the game terrain heightfield
 * (world/terrain/terrainBody.ts) and the flat sim/lab pad (createGroundBody below, shared by the
 * headless sim harness AND lab/main.ts). Default all-ones MINUS the occupant capsule's own category
 * bit (OCCUPANT_CATEGORY_BIT). This is the enabling half of the P001 FOOTWELL SHELF fix (geometry.ts
 * buildFootwellShelfShapes(), vehicle.ts): the shelf's maskBits are OCCUPANT_CATEGORY_BIT alone, so
 * clearing that ONE bit from every ground's category makes the two-sided box3d filter
 * ((catA & maskB) && (catB & maskA), vendor/box3d/src/shape.h b3ShouldShapesCollide) drop the
 * shelf<->ground pair -- the shelf can hang at the cabin floor line to hold seated feet WITHOUT the
 * car beaching itself on the terrain (the original FOOTWELL-SHELF NEGATIVE RESULT, geometry.ts).
 * WHY THIS IS SAFE for everything else -- verified against the actual filter, not assumed:
 *   - Cars/wheels/panels/trees/buildings/debris carry DEFAULT all-ones masks, which still intersect
 *     every OTHER bit of a ground's category -> ground contact is byte-identical for them.
 *   - Occupant capsules collide with grounds through OCCUPANT_COLLIDABLE_BIT (in their mask AND still
 *     in a ground's category) crossed with their own OCCUPANT_CATEGORY_BIT (in a ground's still-all-
 *     ones MASK) -- clearing bit 6 from the ground CATEGORY does NOT touch either leg, so ejected
 *     bodies still land on the ground exactly as before (proven: heightfield-drive + occupants suites).
 *   - The occupant ground-recovery raycast (active.ts sampleGroundY) already masks OCCUPANT_CATEGORY_
 *     BIT (and the seat bits) OUT of its query, so it never relied on a ground's category carrying bit
 *     6 and still finds the ground through the other bits.
 * The ONLY shape in the whole project whose mask is exactly OCCUPANT_CATEGORY_BIT is the footwell
 * shelf, so this clear has a blast radius of one: the shelf. */
export const GROUND_CATEGORY_BITS = ~OCCUPANT_CATEGORY_BIT & ALL_FILTER_BITS;

/**
 * The occupant-only FOOTWELL SHELF (geometry.ts buildFootwellShelfShapes(), created on the chassis in
 * vehicle.ts) -- the real fix for P001 ("seated dummies' feet dip below the car's floor line"). It is
 * a thin static ledge at the cabin floor line that the SEATED occupants' feet rest ON, so they no
 * longer dangle through the occupant-transparent floorpan onto the world ground plane.
 *
 * FILTER (per row, so a rear occupant sliding forward can never be caught by the FRONT footwell ledge,
 * mirroring the per-seat pan philosophy -- SEAT_PAN_CATEGORY_BITS doc):
 *   categoryBits = the row's two SEAT_PAN_CATEGORY_BITS (front = seats 0,1; rear = seats 2,3). A
 *     SEATED occupant's mask carries its OWN seat bit (physics.ts addCapsuleShape), so it collides
 *     with its row's shelf; an EJECTED occupant's mask drops all seat bits, so the shelf is
 *     transparent to it and NEVER blocks the designed ejection path down through the (occupant-
 *     transparent) floorpan -- the shelf needs no runtime break/disable on ejection, the ejected
 *     filter already flies through it. The ground-recovery ray (active.ts) also masks the seat bits
 *     out, so an ejected occupant's downward ray ignores the shelf and finds the real ground.
 *   maskBits = OCCUPANT_CATEGORY_BIT ALONE -- the shelf reaches for nothing but occupant capsules.
 *     Crossed with GROUND_CATEGORY_BITS (bit 6 cleared) this is exactly what keeps the car off the
 *     terrain. (It still meets a tree/wall/debris shape carrying an all-ones category if one ever
 *     physically intrudes into the cabin footwell -- an unavoidable, harmless residual given those
 *     out-of-scope world bodies keep all-ones categories; documented, not a beaching path.)
 *   groupIndex = CAR_GROUP_INDEX -- it is a chassis shape, so it never fights other car parts.
 */
export const FOOTWELL_SHELF_FRONT_CATEGORY_BITS = SEAT_PAN_CATEGORY_BITS[0] | SEAT_PAN_CATEGORY_BITS[1];
export const FOOTWELL_SHELF_REAR_CATEGORY_BITS = SEAT_PAN_CATEGORY_BITS[2] | SEAT_PAN_CATEGORY_BITS[3];
export const FOOTWELL_SHELF_MASK_BITS = OCCUPANT_CATEGORY_BIT;

/**
 * SPEED-GATING of the footwell shelf (stepVehicle's updateFootwellShelfEngagement()). The ledge holds
 * the seated feet at the floor line only while the car is AT REST / crawling -- exactly the state in
 * which the seated pose is ever actually looked at (crash-lab idle, a parked car; the occupants are an
 * opaque-glass-tinted non-entity while driving). ABOVE FOOTWELL_SHELF_DISENGAGE_SPEED_MS the shelf's
 * maskBits are flipped to 0 (collides with nothing) so the feet dangle to their free rest exactly as
 * they did before this shelf existed, and BOTH hard-driving jostle AND -- the load-bearing reason --
 * the crash ejection dynamics are byte-for-byte the pre-shelf behavior every occupant crash/brace/flee
 * test is calibrated on. WHY SPEED, NOT G-LOAD: the wall-crash tests inject a cruise velocity and coast
 * ~1s to the barrier at near-constant (low-g) speed; a g-gate would re-engage during that coast and
 * put the feet back on the ledge at impact, flipping the documented +-2cm ejection knife-edge (rears
 * clearing the seated fronts -- occupants-escalation). A SPEED gate stays disengaged for the whole
 * high-speed approach, so the legs settle to their free hang well before impact and the ejection is
 * identical. Hysteresis (engage < ENGAGE, disengage > DISENGAGE) avoids per-step filter thrash near
 * the boundary (setFilter is ~as costly as recreating the shape). MEASURED: a 45km/h crash approaches
 * at 12.5m/s (>> DISENGAGE); an idle/parked car sits at ~0 (< ENGAGE); the leg free-fall from the
 * floor line to its hang takes ~0.2s, far inside the crash coast. */
export const FOOTWELL_SHELF_ENGAGE_SPEED_MS = 1.5;
export const FOOTWELL_SHELF_DISENGAGE_SPEED_MS = 3.5;

/**
 * OCCUPANT capsule entity-id band [base, end) -- occupant part shapes/bodies tag
 * `OCCUPANT_ENTITY_ID_BASE + seatIndex*100 + partIndex` (game/src/world/features/occupants/
 * physics.ts). Registered HERE (like the collision-filter bit registry above) because the damage
 * system must recognize occupant-sourced hit events without importing a world feature's module:
 * occupant capsules really collide with the cabin interior shells (Tier-3 Stage 2), those shells
 * carry enableHitEvents for the crumple pipeline, and occupant bodies are NOT registered foreign
 * masses -- so without an explicit exclusion a 1.6kg forearm brushing the sill would crumple the
 * car at full unattenuated obstacle weight (see game/src/damage/system.ts's central drain).
 */
export const OCCUPANT_ENTITY_ID_BASE = 1000;
export const OCCUPANT_ENTITY_ID_END = 1400;

/** World gravity magnitude (m/s^2), matching createVehicle()/createGroundBody()'s world gravity of
 * (0,-10,0) -- shared by the damage system's weight-based force thresholds (damage-tuning.ts). */
export const GRAVITY_MAG = 10;

/** Wheel (sphere) radii per axle, meters -- from car-map.ts measured wheel radiusMm. */
export const WHEEL_RADIUS_FRONT_M = CAR_MAP.wheels.frontLeft.radiusMm / 1000; // ~0.390
export const WHEEL_RADIUS_REAR_M = CAR_MAP.wheels.rearLeft.radiusMm / 1000; // ~0.384

/** Wheelbase / track, meters -- from car-map.ts measured values. */
export const WHEELBASE_M = CAR_MAP.wheelbaseMm / 1000;
export const TRACK_FRONT_M = CAR_MAP.trackFrontMm / 1000;
export const TRACK_REAR_M = CAR_MAP.trackRearMm / 1000;

/** Overall body dims, meters -- from car-map.ts overallDimsMm. */
export const CAR_LENGTH_M = CAR_MAP.overallDimsMm.length / 1000;
export const CAR_WIDTH_M = CAR_MAP.overallDimsMm.width / 1000;
export const CAR_HEIGHT_M = CAR_MAP.overallDimsMm.height / 1000;

/**
 * Chassis body ORIGIN height above ground at rest (world Y), meters. Chosen to sit at ~front-hub
 * height so wheel-joint suspension starts near zero compression at spawn (wheel local Y offsets
 * below correct for the small front/rear radius difference).
 */
export const CHASSIS_ORIGIN_HEIGHT_M = WHEEL_RADIUS_FRONT_M;

/**
 * BINDING/ENGINE GOTCHA (found while debugging zero-traction wheelspin, see vehicle.ts's
 * createVehicle() doc comment): spawning a wheel sphere with its bottom EXACTLY tangent to the
 * ground plane (zero gap, zero penetration) is a razor's-edge case for box3d's contact generation --
 * empirically, spawning at that exact boundary produced no reliable normal force (friction never
 * engaged, or engaged only briefly then collapsed), even after several seconds of "settling" via
 * gravity/suspension alone. Spawning with a small DELIBERATE initial penetration below the ground
 * plane removes the ambiguity and produces immediate, stable rolling contact (verified against a
 * free-spinning-sphere baseline that behaves correctly with the same friction settings). This is
 * purely a spawn-time y-offset (uniformly shifts the whole vehicle down by this much); the
 * suspension spring still finds its own natural loaded equilibrium from there.
 */
export const WHEEL_SPAWN_SETTLE_MARGIN_M = 0.01;

/**
 * Underbody ground clearance, meters: the gap between the chassis hull's lowest face and the road
 * surface, matching how a real car's body rides above the ground while the wheels project down
 * below it. FOUND WHILE DEBUGGING near-total wheelspin with zero forward propulsion: the hull's
 * bottom face was initially placed at exactly the ground plane (y=0, same height the wheels touch
 * down at), which put the WHOLE HULL SHAPE in direct, sustained contact with the ground -- its
 * friction (a much larger contact area than any tire) was silently anchoring the chassis to the
 * road independent of the wheels, so no amount of wheel torque could move it. Lifting the hull's
 * bottom face above the wheel-contact plane by this clearance removes that parasitic ground contact.
 */
export const GROUND_CLEARANCE_M = 0.24;

/**
 * Convex-hull "bevelled box" silhouette for the chassis collision shape, in chassis-local space
 * (origin at CHASSIS_ORIGIN_HEIGHT_M above ground -- see vehicle.ts buildChassisHullPoints()).
 * Bottom face = full footprint (per spec); top face narrower + set back, approximating a real
 * greenhouse/roofline. 8 vertices total (well within the spec's 8-16 budget).
 */
export const HULL_BOTTOM_HALF_WIDTH_M = CAR_WIDTH_M / 2;
export const HULL_BOTTOM_HALF_LENGTH_M = CAR_LENGTH_M / 2;
/**
 * RE-MEASURED 2026-07-11 (Mustang fastback -> Volvo S90 4-door sedan swap). The S90's greenhouse is a
 * proper sedan roofline (roof spans over 4 real doors, not a 2-door fastback's rearward-biased taper):
 * measured directly off the GLB (Windshield node header ~z0.95..1.0, RearWindow/QuarterGlass header
 * ~z-1.07..-1.17 -- both in the car's own load-time frame, game/src/assets/car-map.ts axis convention),
 * giving TOP_FRONT_Z ~0.95 and TOP_REAR_Z ~-1.17: HULL_TOP_HALF_LENGTH_M = (0.95-(-1.17))/2 = 1.06,
 * HULL_TOP_CENTER_Z_M = (0.95+(-1.17))/2 = -0.11. Width kept at the Mustang's measured top/bottom-width
 * RATIO (0.75/0.968 = 0.775, a sedan greenhouse tapers from the body similarly to a fastback's) applied
 * to the S90's own HULL_BOTTOM_HALF_WIDTH_M (1.0055m): 0.775 * 1.0055 = 0.779.
 */
export const HULL_TOP_HALF_WIDTH_M = 0.78;
export const HULL_TOP_HALF_LENGTH_M = 1.06;
/** Roofline center is shifted slightly rearward of the footprint center (greenhouse behind the engine bay). */
export const HULL_TOP_CENTER_Z_M = -0.11;

/**
 * Target center-of-mass height offset: ~0.25m BELOW the hull's geometric (volumetric) centroid,
 * per spec. This is achieved via a ballast-sensor shape rather than a direct mass-data override
 * (kept as-is -- it works, and replacing a working mechanism isn't worth the retune risk): an
 * invisible, isSensor, high-density "ballast" sphere shape mounted low in the chassis pulls the
 * composite center of mass down, since b3UpdateBodyMassData accumulates mass over *every* shape on a
 * body (sensor or not, see vendor/box3d/src/body.c). A sphere (not box) shape is used for the ballast
 * because box3d-js's box shapes have no off-origin `center` field, only sphere/capsule do (see
 * shape.ts's BoxShapeOptions vs. SphereShapeOptions). See vehicle.ts's createVehicle() and
 * geometry.ts's ballastMassProperties().
 *
 * CORRECTION (FIXROUND-2): an earlier version of this comment claimed box3d-js's Body/Shape API
 * doesn't expose b3Body_SetMassData/GetMassData -- that was WRONG. Both ARE wired end-to-end:
 * src/wasm-shim/binding.c's b3js_Body_SetMassData/b3js_Body_GetMassData (binding.c:464/484),
 * src/ts/body.ts's Body.setMassData()/getMassData() (body.ts:168/186), exported via
 * src/ts/index.ts. A direct mass-data override (setting an explicit local center of mass) COULD
 * replace the ballast-sensor workaround above -- but that mechanism already works and is verified
 * against the drive-test matrix, so it's left in place rather than swapped for an equivalent-effort,
 * non-zero-retune-risk alternative. COM height itself is still not independently readable back from
 * the binding (no getCenterOfMass/getLocalCenter accessor) -- verified only indirectly via the
 * rollover/step-steer behavior tests, not by API readback.
 */
export const COM_LOWER_OFFSET_M = 0.25;

/**
 * Ballast sensor-shape (sphere) radius (meters) and its local position (meters, chassis-local),
 * low near the hull's underside face (HULL_BOTTOM_Y_M, see geometry.ts). See geometry.ts's
 * solveChassisDensities() for how this + COM_LOWER_OFFSET_M determine the hull and ballast
 * densities at vehicle-construction time (numerically, per-vehicle, not hardcoded here). At this
 * radius/position the solved ballast density comes out ~7200 kg/m^3 -- plausible for a dense engine
 * block/cast-iron mass concentration, not an unphysically dense "cheat" value.
 */
export const BALLAST_RADIUS_M = 0.3;
export const BALLAST_LOCAL_Y_M = -0.34;

/** isBullet CCD on the chassis (spec requirement) -- high-speed impacts / the suspension bump test. */
export const CHASSIS_IS_BULLET = true;

// ---------------------------------------------------------------------------------------------
// Wheel shape (physical) properties
// ---------------------------------------------------------------------------------------------

/**
 * TUNING DELTA (FIXROUND-2, root-caused): was 1.5 going into that pass. The 1.5 value (up from a
 * physically-sane 1.1) was compensating for a REAL traction deficit; FIXROUND-2 root-caused the
 * asymmetric-wheel-mount / traction-taper interaction (see vehicle.ts's WHEEL_DEFS symmetrization) and
 * its doc comment (at the time) claimed 1.05 cleared the drive-test matrix -- but that claim was NEVER
 * actually re-verified after the G3 damage system (5 welded panel bodies, game/src/damage/panels.ts)
 * landed, and the code's own value stayed at 1.5, i.e. the deficit silently came back (this pass's
 * own residual: "0.5g average accel needs mu~1.5?!").
 *
 * RE-ROOT-CAUSED (vehicle deep-pass): instrumented per-wheel suspension load (joint.getConstraintForce
 * -- turned out unreliable, see below), per-wheel suspension DEFLECTION (getSuspensionDeflection(),
 * reliable, ~0.12m loaded in every configuration tested -- wheels ARE properly loaded), and directly
 * A/B'd every candidate parasitic-contact path (game/sim/diag/friction-instrument*.test.mjs). Found:
 * the 5 damage-system panel bodies are welded RIGIDLY (no suspension) to the chassis, and doorL/doorR's
 * raw measured vertical bbox (car-map.ts's BodyDoorLColor1/BodyDoorRColor1 sizeMm.y, bundling mirror/
 * handle/window-frame childNodes into one bbox -- same class of over-inclusive-measurement issue
 * damage-tuning.ts's PANEL_THICKNESS_AXIS doc comment already flags on the OTHER axis) put the doors'
 * bottom edge ~8.5cm BELOW the hull's own tuned GROUND_CLEARANCE_M line -- i.e. lower than the hull
 * itself, silently reinstating the exact "shape drags on the ground, its friction anchors the chassis
 * independent of wheel traction" bug GROUND_CLEARANCE_M was created to fix for the hull (see that
 * constant's doc comment). Confirmed directly: a clean single-variable isolation (Shape.setFilter()
 * excluding ONLY door<->ground collision, weld/mass/position otherwise untouched) recovered +5.1km/h
 * (+5.5%) of 5s straight-line acceleration by itself. FIXED at the geometry level (damage/panels.ts's
 * panelHalfExtentsRef() now clamps each panel's vertical half-extent to the same ground-clearance
 * floor the hull already respects -- see that function's doc comment), not by further inflating this
 * friction constant.
 *
 * (Aside, ruled out: joint.getConstraintForce() summed across all 4 wheels read ~0N of the vehicle's
 * ~14.4kN weight at rest -- looked like "wheels carry no load", but cross-checked via suspension
 * DEFLECTION with panels relocated away entirely and found IDENTICAL ~0.12m compression either way, so
 * the wheels demonstrably ARE loaded; the getConstraintForce() reading itself is unreliable for this
 * purpose here, not the physics -- see vendor/box3d/src/wheel_joint.c's b3GetWheelJointForce(), whose
 * suspension-axis impulse term includes `joint->lowerSuspensionLimit` (a configured LENGTH limit, not
 * an impulse accumulator) alongside the real impulse accumulators, which looks like a vendor readback
 * quirk; vendor code is out of scope to modify, and the deflection cross-check was conclusive enough
 * not to need it.)
 *
 * With the real parasitic-drag mechanism fixed, re-measured empirically against the full drive-test
 * matrix (straight-line, braking, step-steer, kicker-jump, airborne-momentum, cornering, sustained-
 * oscillation): 1.05 clears all of them. 1.05 is a physically ordinary road/sport-tire coefficient
 * (real tires span ~0.7-1.5+), not a "cheat" value like the old 1.5 high-grip-slick figure.
 */
export const WHEEL_FRICTION = 1.05;
export const WHEEL_RESTITUTION = 0;
/** Native box3d rolling-resistance term (sphere/capsule shapes only) -- keeps top speed bounded
 * without needing an explicit aerodynamic-drag model (not in the spec). TUNING DELTA: added,
 * small value, mirrors real tire rolling resistance; does not change low-speed behavior. */
export const WHEEL_ROLLING_RESISTANCE = 0.02;

export const GROUND_FRICTION = 0.95;

/**
 * Traction-control torque taper on the driven (rear) wheels -- see vehicle.ts's
 * tractionLimitedTorque(). Full drive torque is preserved for slip (real wheel omega minus
 * chassis-implied omega) up to TRACTION_SLIP_ALLOWANCE_RAD_S, then linearly cut to zero by
 * TRACTION_SLIP_CUTOFF_RAD_S.
 *
 * TUNING DELTA (BINDFIX follow-up, required by allowFastRotation): added after removing the
 * ENGINE_ASSIST_* workaround. box3d's per-body rotation clamp used to silently bound every wheel
 * body's angular speed near ~47 rad/s regardless of what drove it; that incidentally also bounded the
 * drivetrain servo's permanently-"unreachable" spin target (powertrain.ts's driveServoTarget()) to
 * something sane. With the clamp lifted (wheels now need allowFastRotation to spin past the old ~65
 * km/h ceiling), a momentary traction-loss event let a driven wheel free-spin toward that huge target
 * for real -- observed at ~990 rad/s (several hundred km/h wheel-surface-equivalent), which destabilized
 * the step-steer test (rear-wheel-drive power-oversteer, yaw well outside the test's bounds). This
 * taper restores a bound similar in spirit to the removed clamp without touching the servo pattern
 * itself. Values chosen empirically against the 5 drive tests: wide enough to not touch normal
 * (low-slip) traction-limited acceleration, tight enough to keep a genuine wheelspin event's angular
 * speed within a plausible range. (Also see YAW_DAMPING_* further below, in the drivetrain section,
 * added for the residual oversteer this alone did not fully remove.)
 */
/**
 * TUNING NOTE (FIXROUND-2, diagnostic D4 "tighten the taper so wheelspin is caught earlier"): tried
 * and REVERTED. A low-pass filter on the taper's realOmega input (killing the raw per-step spin-speed
 * reading's +/-20-30 rad/s step-to-step swing, aimed at diagnostic B3) combined with a tightened
 * ALLOWANCE/CUTOFF window measurably WORSENED straight-line acceleration (max speed in the 5s drive
 * test dropped from ~90 to ~67-75 km/h in direct A/B testing) -- root cause: that raw swing isn't pure
 * noise to be smoothed away, it's the taper reacting instant-by-instant to a real, fast-oscillating
 * wheel-speed dynamic (small wheel rotational inertia vs. a torque-saturated servo), and the troughs
 * of that oscillation are exactly when the UNFILTERED taper permits high torque -- averaging them away
 * with any filter strong enough to matter left the taper reading a persistently elevated "slip" and
 * cutting torque far more of the time. Diagnostic B3's underlying goal (kill the drift-seeding
 * per-wheel torque-cut asymmetry) turned out to be already resolved by B1 (mount symmetrization) + B2
 * (per-wheel yaw-aware implied omega) alone -- verified directly: 30s full-throttle straight-line yaw
 * stays within ~2deg with the taper UNFILTERED, using the ORIGINAL (unchanged) 10/50 window, so no
 * filter or extra tightening was actually load-bearing for the drift fix. Left at the original 10/50
 * (unmodified) rather than force a "tighter" number that doesn't survive the drive-test matrix.
 */
export const TRACTION_SLIP_ALLOWANCE_RAD_S = 10;
export const TRACTION_SLIP_CUTOFF_RAD_S = 50;

/**
 * Consecutive steps a wheel's slip must stay above TRACTION_SLIP_CUTOFF_RAD_S before
 * updateWheelGroundContact() (vehicle.ts) trusts it as genuine free-spin evidence overriding a
 * (possibly stale) "grounded" suspension-deflection reading -- see Vehicle.wheelSlipOverCutoffStreak's
 * doc comment for the full rationale (a single-step chatter spike at high cruise speed can hit the
 * cutoff too; a sustained streak cannot). Same value/pattern as damage-tuning.ts's
 * WHEEL_DETACH_DEBOUNCE_STEPS (an analogous "ignore an isolated transient spike" filter).
 */
export const SLIP_OVERRIDE_DEBOUNCE_STEPS = 3;

// ---------------------------------------------------------------------------------------------
// Wheel joint: suspension
// ---------------------------------------------------------------------------------------------

/**
 * TUNING DELTA (suspension-feel pass, user report: "collapses on the wheels instead of having
 * springiness"). ROOT-CAUSED via direct instrumentation (see game/sim/suspension-feel.test.mjs and
 * this constant's sibling doc comments below), NOT assumed from the "hertz" name alone:
 * vendor/box3d/src/wheel_joint.c's b3PrepareWheelJoint() computes this joint's suspension spring
 * against `joint->suspensionMass` -- the DOF's own reduced/effective mass (invMassA(chassis) +
 * invMassB(wheel) + angular lever-arm terms), NOT the chassis's real quarter-sprung mass. Since the
 * wheel body (WHEEL_MASS_KG=22) is ~60x lighter than the chassis, invMassB dominates that sum, so
 * `suspensionMass` comes out close to the WHEEL's own mass (~20kg), not ~340kg (a real quarter-car
 * sprung mass). The old hertz=3.0-3.2 was therefore an implied spring rate (k = suspensionMass*
 * (2*pi*hertz)^2) calibrated to support a ~20kg virtual oscillator -- FAR too soft for this car's
 * real ~3600N/corner static load, whose honest spring-only equilibrium point lands well beyond
 * ANY plausible travel limit. Measured directly (game/sim/diag-style static-settle probe, throttle/
 * brake/steer all neutral): the old tuning settled from spawn to ~0.121m in the first ~10 fixed
 * steps (~0.17s) and then sat there UNCHANGING forever -- i.e. the suspension's SPRING did none of
 * the actual weight-holding; the joint's own hard suspensionLimit (the old +/-0.12m bound) was
 * silently doing 100% of the job, with the spring's natural equilibrium point lying somewhere
 * beyond it. A joint parked flush against its own hard stop has zero remaining spring compliance in
 * either direction under load -- exactly "collapses on the wheels instead of having springiness".
 *
 * FIX: this is NOT a case of "make the suspension softer" (the spec's own vocabulary, and the
 * intuitive read of "collapses" as "too stiff") -- it is the OPPOSITE: raising the internal hertz
 * parameter (which raises the virtual spring's stiffness against its own small effective mass) is
 * what pulls the static equilibrium build IN OFF the wall, restoring real spring compliance in both
 * directions. Swept empirically (5/6/6.5/7/8/9/10/11/13/16/20, symmetric front/rear, holding the old
 * +/-0.12m limit): static deflection falls monotonically from ~0.121m (pinned at the wall, hertz<=5)
 * through ~0.096/0.082/0.063/0.050/0.034/0.024/0.016/0.010m as hertz rises 6.5->20 -- i.e. there IS
 * a hertz value that clears the wall, but a second empirical fact (see SUSPENSION_LOWER_LIMIT_M's doc
 * comment below) showed that hertz alone, even once clear of the wall, still doesn't leave enough
 * *headroom* on the loaded (compression) side for hard-braking/launch/cornering weight transfer to
 * show up as visible body motion -- the travel band itself (see below) also needed widening, AND (see
 * that same doc comment) the travel band this pass settled on has a hard, empirically-found ceiling:
 * widening it much past +/-0.14m reintroduces enough EXTRA suspension compliance during a crash
 * impact specifically to measurably change downstream damage/occupant/crash-test outcomes this task
 * isn't scoped to retune. Final value (6, both axles -- an even front/rear split was empirically just
 * as good as a front/rear-differentiated one and simpler; a front/rear split was tried and actually
 * made launch squat WORSE the stiffer the rear got, the opposite of what was wanted) chosen as the
 * point where static settle clears the (also-widened) wall with real headroom on both sides, inside
 * the +/-0.14m ceiling above, AND the emergent measured oscillation on a landing (see the jump-
 * landing scenario in suspension-feel.test.mjs) comes out as a genuinely plausible, visibly decaying
 * bounce -- i.e. this internal "hertz" knob does not equal the real-world ride frequency the spec's
 * own suggested "1.5-2.5Hz" language describes (that mismatch IS the root cause above), but the
 * EMERGENT, MEASURED behavior at this tuned value lands in the physically-plausible neighborhood the
 * spec was actually asking for.
 *
 * PHASE R RE-MASS/SUSPENSION RETUNE (2026-07-12): raised 6/6 -> 7.2/7.85 (front/rear, now
 * DIFFERENTIATED -- see below for why an even split no longer suffices). The heavier corner loads
 * (tuning.ts's CHASSIS_MASS_KG doc comment) push the TRUE (unclamped) static-equilibrium deflection at
 * the OLD hertz=6 to a measured 0.1145m front / 0.1415m rear at REST and 0.1307m front / 0.1561m rear
 * LADEN (game/sim's ride-height LADEN_FEATURE_BALLAST rig) -- the rear figure alone (0.1561m) already
 * exceeds the +/-0.14m ceiling outright (would pin flush against the wall, zero headroom, the exact
 * "rides near bump-stop" debt this pass was asked to close).
 *
 * TWO candidate fixes were tried: (a) widen SUSPENSION_LOWER/UPPER_LIMIT_M instead of touching hertz,
 * (b) stiffen hertz and leave the +/-0.14m ceiling alone. (a) was tried FIRST (widened to +/-0.24m,
 * comfortably covering all 4 load states with margin) but MEASURABLY REGRESSED bumpy-terrain driving
 * stability: sim/terrain-compound.test.mjs's connectivity run rolled the car outright (minUpDot
 * dropped to -0.98, a real rollover) and sim/cardetail-ground-contact.test.mjs's welded parts started
 * clipping the ground -- both because the active anti-roll/yaw-damping/anti-pitch assists (further
 * below in this file) and the cardetail parts' clearance were implicitly tuned against the +/-0.14m
 * envelope's dynamics, not just its final rest position. (b) -- stiffening hertz, leaving the ceiling
 * untouched -- cleared the FULL sim suite with no such collateral (verified directly), so it's the one
 * kept. Swept empirically holding the +/-0.14m ceiling: front 7.2 / rear 7.85 gives every corner >=30%
 * headroom in all 4 measured conditions --
 *   front REST  0.0797/0.14 = 56.9% used -> 43.0% headroom
 *   rear  REST  0.0825/0.14 = 58.9% used -> 41.0% headroom
 *   front LADEN 0.0906/0.14 = 64.7% used -> 35.3% headroom
 *   rear  LADEN 0.0951/0.14 = 67.9% used -> 32.1% headroom (worst case, still clears the 30% floor)
 * Front/rear are now DIFFERENTIATED (unlike the swap-era "an even split was empirically just as good"
 * finding above): the rear carries a heavier, more rearward-biased load post-re-mass (heavier rear
 * doors + trunk-side segments), so it needs more stiffening than the front to reach the same headroom
 * fraction -- re-verified against the full suspension-feel.test.mjs battery (dive 2.75deg, squat
 * 1.02deg, corner-roll 3.28deg, landing oscillation 7 decaying half-cycles -- all comfortably inside
 * their existing target bands with the stiffer springs).
 */
export const SUSPENSION_HERTZ_FRONT = 7.2;
export const SUSPENSION_HERTZ_REAR = 7.85;
export const SUSPENSION_DAMPING_RATIO = 0.7;
/**
 * TUNING DELTA (suspension-feel pass): widened from +/-0.12m. Even after SUSPENSION_HERTZ_FRONT/REAR
 * above pulls the static-equilibrium deflection off the wall, the old +/-0.12m band left too little
 * *compression* headroom above that equilibrium for hard weight-transfer events (braking dive,
 * launch squat, cornering roll) to visibly develop before hitting the same hard stop again from the
 * other side -- measured directly: at hertz=6 (old limit), static settle ~0.112m front / ~0.120m rear
 * already used ~93-100% of the +/-0.12m band's compression side, leaving almost no headroom before
 * the wall (dive/squat/roll all measured BELOW this pass's own target bands at that combination).
 *
 * Widened empirically in steps (0.13/0.14/0.145/0.15/0.155/0.16, holding hertz=6): +/-0.14m was the
 * largest value that cleared every existing damage/occupant/crash sim test AT THE SWAP'S 1438KG MASS
 * (0.145m and up measurably regressed game/sim/panel-loosen-pose.test.mjs, game/sim/features-
 * occupants.test.mjs, game/sim/damage-crumple-bounded.test.mjs and/or game/sim/features-cardetail.
 * test.mjs's crash-scatter assertion -- more suspension compliance during a hard wall impact changes
 * how much of the impact's momentum reaches the chassis/panels/occupants vs. gets absorbed by the
 * spring travel).
 *
 * PHASE R RE-MASS/SUSPENSION RETUNE (2026-07-12): KEPT AT +/-0.14m (unchanged) -- see
 * SUSPENSION_HERTZ_FRONT/REAR's doc comment immediately above for the full A/B: widening this ceiling
 * to buy rear headroom was tried FIRST and measurably destabilized bumpy-terrain driving (a real
 * rollover) and cardetail ground clearance, so this pass fixes the "rides near bump-stop" debt by
 * stiffening the spring instead, leaving this travel envelope -- and everything implicitly tuned
 * against it (active assists, cardetail clearance, the crash/damage/occupant knife-edges the original
 * +/-0.14m ceiling comment above references) -- untouched.
 */
export const SUSPENSION_LOWER_LIMIT_M = -0.14;
export const SUSPENSION_UPPER_LIMIT_M = 0.14;

/**
 * Suspension strut REST-LENGTH offset (meters): a PHYSICS ride-height lever. Each wheel's joint frameA
 * anchor (its zero-deflection point) mounts this much LOWER in the chassis, so at a given spring
 * deflection the chassis+hull+welded-panels all ride this much HIGHER above the on-ground wheels --
 * like fitting longer struts (the wheel bodies still spawn at / rest on the ground; see
 * withRestLengthLift() + the spawnMount in createVehicle()).
 *
 * HELD AT 0 -- see VISUAL_RIDE_LIFT_M below, which carries the ride-height correction instead. This
 * lever is the *physically correct* fix (it keeps the collision hull aligned with the rendered body,
 * so crashes stay accurate), but suspension round 2 measured it to be boxed in on three fronts and
 * unusable at the magnitude actually needed:
 *   1. MAGNITUDE. The wheel-joint spring is calibrated against the DOF's tiny reduced mass (~wheel
 *      mass, see SUSPENSION_HERTZ_FRONT), so under the full game's ~260kg laden feature load (cardetail
 *      + 4 occupants; see createVehicle()'s SprungBallastPoint) the car sags to its bump stop and the
 *      body sits ~10-11cm below the GLB's authored ride height -- measured directly in the real game
 *      (verify/ride-height.mjs): the front tire renders ~8.5cm THROUGH the fender (tireTop 0.778 vs
 *      fenderMinY 0.693). Un-slamming needs a ~0.11-0.13m lift.
 *   2. FEEL COUPLING. Reducing the underlying sag instead (stiffer hertz) is impossible without killing
 *      feel: box3d's linear wheel spring makes static sag AND dynamic dive/squat/roll amplitude BOTH
 *      scale as 1/k, so any stiffening that meaningfully cuts sag cuts the suspension-feel targets below
 *      their floors by the same factor (swept + measured, round 2 dev notes).
 *   3. CRASH-TEST SENSITIVITY. A physics lift shifts the hull/COM/impact geometry the whole crash /
 *      destruction / occupant sim suite is (latently) calibrated against, AND it perturbs
 *      getSuspensionDeflection during pitch (the airborne/ground-contact gating signal). Empirically
 *      EVERY nonzero value flips a different knife-edge crash assertion (0.01 -> destruction-feel debris
 *      velocity, 0.02 -> cardetail-containment detach count, 0.03 -> airborne-momentum pitch rate),
 *      i.e. it cannot be made gate-clean in a vehicle-only wave. Raising it to the ~0.11m actually
 *      needed breaks crash-realism, occupants-escalation/-active and cardetail crash tests outright.
 * Enabling this (instead of the visual lift) is a future coordinated pass: bump it AND re-tune the
 * crash/destruction/occupant thresholds to the corrected ride height together. The mechanism is left
 * wired (a no-op at 0) so that re-tune only has to change this number.
 */
export const SUSPENSION_RESTLENGTH_OFFSET_M = 0;

/**
 * VISUAL ride-height lift (meters): raises the rendered car body (car.root, in main.ts's render loop)
 * along the chassis's own up axis, seating the GLB-authored body at its intended ride height over the
 * physics-correct, on-ground wheels -- WITHOUT touching physics (COM, hull, suspension, crash geometry
 * all unchanged, so zero sim-test collateral; see SUSPENSION_RESTLENGTH_OFFSET_M above for why the
 * physics lever can't do this within the gate). Attached body panels are children of car.root (see
 * scene/panelVisuals.ts) so they lift with the shell; the 4 wheels are re-parented out to the scene and
 * driven by their own physics bodies, so they stay on the ground -- the net effect is exactly the
 * intended "body sits up, wheels tuck into the arches" stance.
 *
 * Value tuned (verify/ride-height.mjs, rendered front/rear fender-vs-tire AABB gap in the REAL laden
 * game) so the fender-to-tire gap clears >2cm at rest and stays positive through a 1g brake dive, from
 * the measured ~-8.5cm (tire through fender) at 0. See game/sim/ride-height.test.mjs, which recomputes
 * that gap from the laden physics rest state + this constant.
 *
 * KNOWN RESIDUAL (honest): because this is a render-only lift, the visible body sits this far ABOVE the
 * physics collision hull. At rest / while driving that hull is invisible (collision-only) so it never
 * shows; during a hard crash the body can visually overlap a wall/object by up to this much at the
 * contact instant before the crumple reads. That brief, crash-only cosmetic offset is the deliberate
 * trade for fixing the always-visible slammed stance with zero physics/crash-test disruption; closing
 * it fully is the coordinated physics-lift + crash-retune pass described above.
 */
export const VISUAL_RIDE_LIFT_M = 0.13;

// ---------------------------------------------------------------------------------------------
// Wheel joint: steering (front only)
// ---------------------------------------------------------------------------------------------

export const STEERING_HERTZ = 20;
export const STEERING_DAMPING_RATIO = 1.0;
export const STEERING_MAX_TORQUE_NM = 4000;
export const STEERING_LOWER_LIMIT_RAD = -0.55;
export const STEERING_UPPER_LIMIT_RAD = 0.55;

/** Speed-sensitive steering clamp: full lock at 0 km/h down to a much smaller lock at 130 km/h+. */
export const STEER_CLAMP_MAX_RAD = 0.55; // at 0 km/h
export const STEER_CLAMP_MIN_RAD = 0.12; // at STEER_CLAMP_SPEED_KMH+
export const STEER_CLAMP_SPEED_KMH = 130;
/** Slew-rate limit on the *commanded* steering angle, rad/s. */
export const STEER_SLEW_RATE_RAD_S = 3.5;

// ---------------------------------------------------------------------------------------------
// Drivetrain: engine torque curve (3-point piecewise-linear lerp), gearbox, final drive
// ---------------------------------------------------------------------------------------------

export interface EngineCurvePoint {
	rpm: number;
	torqueNm: number;
}

export const ENGINE_IDLE_RPM = 900;
export const ENGINE_REDLINE_RPM = 6800;

/**
 * TUNING DELTA (BINDFIX follow-up, required by removing ENGINE_ASSIST_*): with the assist gone, the
 * torque-limited-velocity-servo pattern (powertrain.ts's driveServoTarget()) plus the new traction
 * control (TRACTION_SLIP_* above, YAW_DAMPING_* below) needed roughly 36% more torque headroom to
 * clear the straight-line drive test's >=90 km/h in its 5s window -- these 3 points are the spec's
 * original curve (220/330/240 Nm) scaled by that factor (still a physically plausible curve for a
 * ~1350kg RWD car, not an unphysical value; DRIVETRAIN_EFFICIENCY stays at its original <=1 value
 * below rather than being pushed past 100%).
 */
export const ENGINE_TORQUE_CURVE: readonly EngineCurvePoint[] = [
	{ rpm: 900, torqueNm: 300 }, // idle
	{ rpm: 4600, torqueNm: 450 }, // peak
	{ rpm: 6800, torqueNm: 327 }, // redline
];

export const GEAR_RATIOS: readonly number[] = [3.4, 2.2, 1.55, 1.15, 0.9];
export const FINAL_DRIVE_RATIO = 3.7;
export const UPSHIFT_RPM = 6300;
export const DOWNSHIFT_RPM = 2600;
export const SHIFT_CUT_MS = 250;
export const DRIVETRAIN_EFFICIENCY = 0.88;

/** Light engine-braking torque applied when coasting (no throttle/brake pedal), per driven wheel. */
export const ENGINE_BRAKE_TORQUE_NM = 150;

// ---------------------------------------------------------------------------------------------
// Brakes
// ---------------------------------------------------------------------------------------------

export const BRAKE_TORQUE_FRONT_NM = 2800;
export const BRAKE_TORQUE_REAR_NM = 1600;

// ---------------------------------------------------------------------------------------------
// Reverse (the brake/S key doubles as reverse when the car is stopped or already rolling backward)
// ---------------------------------------------------------------------------------------------

/** While the car is still rolling forward faster than this (m/s), the brake pedal foot-brakes; at or
 * below it (stopped / rolling backward) the pedal engages reverse instead. */
export const REVERSE_ENGAGE_SPEED_MS = 0.6;
/** Reverse is torque-cut once backward speed reaches this (m/s ≈ 25 km/h) so it stays gentle/bounded. */
export const REVERSE_MAX_SPEED_MS = 7;
/**
 * Max per-driven-wheel spin-motor torque (N*m) while REVERSING -- much lower than a forward launch's
 * torque cap (~1660 N*m at gear 0). REVERSE-FIX (measured, game/verify/reverse-check.mjs): the reverse
 * branch previously reused the FULL forward-launch torque, and in the real laden game that ~0.7g reverse
 * demand was actively harmful. This car settles genuinely NOSE-HEAVY (measured rest pitch -1.7deg, front
 * suspension deflection ~0.13m vs REAR only ~0.05m -- the rear axle is very lightly loaded; the bare sim
 * doesn't reproduce this because baked-mass ballast bottoms the soft springs symmetrically). The wheel-
 * joint spin motor's reaction torque about the chassis pitch axis, driving the rear wheels backward at
 * full launch torque, pitched the nose DOWN and lifted that light rear into suspension droop; the lifted
 * rear then read "airborne" (dropping ground-assist authority, so the anti-pitch assist that would damp
 * it switched OFF), and the pitch ran away into a fore-aft rocking oscillation that converted the drive
 * energy into rotation instead of translation -- the car netted ~0m backward (forward is immune: forward
 * drive SQUATS the rear, loading it). Capping the reverse torque keeps that pitch reaction bounded so the
 * rear stays planted and the car reverses smoothly and straight. Swept empirically in the real browser
 * game (fresh-spawn, 4s hold-S; measured backward displacement): 300->0.1m (too weak, still stalls),
 * 400->2.6m, 500->8.6m, 600->14.6m, 700->18.0m, 900->20.7m, uncapped(1660)->0.1m (pitch runaway). 600
 * clears the >=8m/4s target with comfortable margin, reaches the REVERSE_MAX_SPEED_MS cap smoothly with
 * a steady bounded ~4deg nose-down attitude (no oscillation), and sits far below the ~1000+ N*m where the
 * runaway re-appears. A gentle reverse is also simply realistic -- real cars don't reverse at 0.7g. */
export const REVERSE_MAX_DRIVE_TORQUE_NM = 600;
export const HANDBRAKE_TORQUE_NM = 5000;
/** Small passive drag on the (undriven) front wheels when neither braking nor coasting-drive
 * logic applies to them -- emulates bearing/rolling drag so they don't free-spin unrealistically. */
export const FRONT_PASSIVE_DRAG_NM = 15;

// ---------------------------------------------------------------------------------------------
// ASSIST RETIREMENT AUDIT (airborne round 3 / asymmetric-launch honesty pass) -- applies to all
// three active assists below (anti-roll / yaw-damping / anti-pitch).
//
// The three assists were originally band-aids for root causes that have since been FIXED at the
// source (collapsed bump-stop suspension -> real springs 93bd161 + laden seating fcd5490; panel
// ground-drag -> geometry clamp e4b9790; straight-line drift -> mount symmetrization). FULL
// RETIREMENT WAS ATTEMPTED this pass: all three disabled, entire 139-test battery re-run under the
// new strict >=3-wheel/instant-cut ground gating (vehicle.ts's updateGroundAuthority()). Verdict --
// the ORIGINAL failure modes are indeed gone (step-steer, sustained-oscillation, straight-line-30s,
// suspension-feel, braking, cornering ALL PASS with every assist off), but two OTHER test families
// now genuinely depend on assist-shaped dynamics, so full retirement fails these, measured:
//   - ALL THREE OFF: heightfield-drive minUpDot -0.93 (bound >0.9 -- a real rollover on the bumpy
//     heightfield at speed); destruction-feel brick 120km/h peakDebris 17.6 m/s (bounds >18 and
//     >70km/h-peak+3); destruction-feel brick monotonic-signature fail; cardetail-containment
//     detached-exterior count 0 (bound >0).
//   - ANTI-PITCH OFF (roll+yaw on): destruction-feel brick 120km/h peak 17.6-17.7 vs 19.1-20.4
//     with it on -- cleanly bimodal on this one flag: without pitch-rate damping the hard approach
//     pitches up under drive torque and delivers measurably less impact speed to the wall. At 50%
//     authority (rate 7000 / cap 8000): hi-peak 18.16 < 18.89 bound AND cardetail detach count 0.
//     KEPT AT FULL (14000 / 16000) -- 50% measured insufficient.
//   - YAW OFF (roll+pitch on): heightfield-drive minUpDot 0.846 < 0.9. At 50% (3250/2000):
//     minUpDot -0.87, a full rollover. KEPT AT FULL (6500/4000) -- the dominant bumpy-terrain
//     stability term.
//   - ANTI-ROLL OFF (pitch+yaw on) got closest to retirement: heightfield passes (0.9996) and only
//     destruction-feel's brick knife-edge orderings flip (broken-count/peak monotonicity, an
//     approach-dynamics reshuffle). Halved gains pass the ENTIRE battery; quartered (2250/450/1500)
//     fail destruction broken-count monotonicity (132 !> 135). KEPT AT HALF -- see below.
// Net: what keeps these assists alive today is bumpy-terrain stability (yaw, roll) and crash-
// approach attitude integrity (pitch) -- NOT the original step-steer/oscillation failure modes.
// Each is kept at the MINIMUM measured authority that passes the full battery.
// ---------------------------------------------------------------------------------------------

/**
 * Whether the active anti-roll assist is engaged. Spec: "after tuning, if roll-over happens in a
 * 60 km/h step-steer test, apply a modest active anti-roll torque... cap it; document." It was
 * needed here: with only suspension + lowered COM, the step-steer test's roll angle exceeded the
 * 25-degree budget before the tests passed reliably. This is a small torque proportional to roll
 * angle & rate, capped, applied about the chassis's world forward axis every fixed step.
 *
 * TUNING DELTA (airborne round 3, retirement audit above): HALVED from 9000/1800/6000 -- the
 * original step-steer rollover justification no longer exists (passes with the assist fully off),
 * and half authority is the measured minimum that still clears destruction-feel's approach-
 * sensitive knife-edges (quarter authority fails; see audit). Full-off was tried first and is
 * documented above -- this is not a silent re-enable.
 */
export const ANTI_ROLL_ENABLED = true;
export const ANTI_ROLL_GAIN_ANGLE = 4500; // N*m per radian of roll (was 9000 -- halved, see above)
export const ANTI_ROLL_GAIN_RATE = 900; // N*m per (rad/s) of roll rate (was 1800 -- halved)
export const ANTI_ROLL_TORQUE_CAP_NM = 3000; // was 6000 -- halved
/**
 * INVESTIGATED, NOT ADOPTED (suspension-feel pass): tried a dead-zone/envelope on the ANGLE term
 * above ("yield-first: only clamp EXCESS beyond a natural-motion envelope") to stop it eating ordinary
 * cornering roll -- measured a real effect (~20% more roll with the assist's angle term fully off at a
 * ~0.98g corner: 1.620deg -> 1.944deg) and picked an envelope comfortably above this pass's own
 * 1.5-4.5deg target band and step-steer's 25deg budget. REVERTED after a regression this pass's own
 * verification caught: game/sim/heightfield-drive.test.mjs (bumpy-terrain high-speed drive stability,
 * pre-existing, not authored by this pass) needs the angle term's authority starting from ZERO roll --
 * even a 1deg envelope dropped its minUpDot from a passing 0.94 to a failing 0.89, and every larger
 * envelope tried (2/2.5/3/4/7deg) failed it further (down to ~0.83 at 7deg) -- a fast, violent
 * multi-bump event apparently needs the angle term engaged from the very start to stay ahead of the
 * roll building up, not just past some threshold. The gain in ordinary-cornering feel wasn't worth
 * that regression, so the assist is left exactly as it was (unconditional angle+rate, no dead-zone);
 * the suspension retune alone (SUSPENSION_HERTZ_FRONT/REAR + SUSPENSION_LOWER/UPPER_LIMIT_M below)
 * still clears this pass's corner-roll target on its own (see game/sim/suspension-feel.test.mjs),
 * just with a harder corner (~1-1.1g) than the original 0.7-0.8g probe used above.
 */

/**
 * Yaw-rate damping (active, chassis torque about the world-up axis) -- see vehicle.ts's
 * computeYawDampingTorque(). Same pattern as the anti-roll assist above (small, rate-proportional,
 * capped, always-on), added for the same class of reason: TUNING DELTA (BINDFIX follow-up, required
 * by removing the ENGINE_ASSIST_ workaround and wiring allowFastRotation) -- the step-steer test's
 * rear-wheel-drive power-oversteer got measurably worse once driven wheels could actually spin fast
 * (no longer silently capped by box3d's removed per-body rotation clamp, see tuning.ts's
 * TRACTION_SLIP_* doc comment above), pushing yaw rate past the test's upper bound even with the
 * drivetrain-side traction control in place. A small proportional yaw-rate damping torque --
 * independent of the drivetrain -- reins in the resulting oversteer without touching straight-line
 * torque.
 */
/**
 * Whether the active yaw-rate damping assist is engaged -- added for convention parity with
 * ANTI_ROLL_ENABLED/ANTI_PITCH_ENABLED (FIXROUND-2 diagnostic B4); this assist previously had no
 * enable flag at all. Left true: still needed (see the drift diagnostics), but now consistent with
 * how the other two active-assist terms are gated.
 */
export const YAW_DAMPING_ENABLED = true;
/**
 * TUNING DELTA (FIXROUND-2 diagnostic B4): raised from 5000 -- with the mount-asymmetry root cause
 * (vehicle.ts's WHEEL_DEFS) fixed, this damping's job narrows to arresting genuinely small
 * perturbations (bumps, minor slip noise) quickly rather than fighting a large systemic bias, so a
 * slightly stronger gain settles small yaw disturbances faster without measurably affecting the
 * intentional turning response (step-steer test's required yaw-rate range is achieved via steering
 * input, which this damping does not oppose at the rates that test exercises).
 */
/**
 * RETIREMENT AUDIT (airborne round 3, see the audit block above ANTI_ROLL_ENABLED): retirement and
 * 50% authority both measured-failed (heightfield-drive minUpDot 0.846 off / -0.87 at half, bound
 * >0.9) -- this is now the dominant bumpy-terrain stability term, kept at FULL, its original
 * step-steer-oversteer justification notwithstanding (step-steer passes with it off).
 */
export const YAW_DAMPING_GAIN_NM_PER_RAD_S = 6500;
export const YAW_DAMPING_TORQUE_CAP_NM = 4000;

/**
 * Anti-pitch assist (active, chassis torque about the chassis's world-right/lateral axis) -- same
 * rate-damping shape as the yaw-damping assist above, about the third (pitch) axis. Added for playtest
 * MAJOR "flat-ground rollover under sustained mild steer" (game/verify/playtest/battery.mjs's
 * free-drive scenario: 0.15-amplitude oscillating steer + sustained throttle for 30s).
 *
 * DIAGNOSIS (game/sim/sustained-oscillation.test.mjs + ad hoc pitch/roll tracing): the car does NOT
 * actually roll over -- roll angle stayed under ~9deg throughout the whole run even with every
 * existing knob (suspension hertz/damping/limits, steering slew rate, steer clamp, stronger anti-roll
 * gains) left at their pre-existing tuned values. upDot still collapsed to -1 (fully inverted) via an
 * unbounded, monotonically-growing PITCH rotation instead (confirmed by direct forward-vector pitch
 * tracing: roughly -0.2deg/step and accelerating, -0.2deg -> -18deg in under a second once triggered,
 * never settling). Root cause: the bang-bang
 * throttle controller's instantaneous full-torque reapplication, whenever it happens to land mid-slip
 * on a driven (rear) wheel, occasionally kicks off a rear-wheel spin-up event; the wheel joint's
 * spin-motor reaction torque acts directly about the chassis's lateral (pitch) axis, and NOTHING in
 * the existing model damps pitch (anti-roll only covers the forward axis, yaw-damping only the up
 * axis) -- so an unlucky spin-up event pitches the nose with no restoring force at all. No combination
 * of the existing knobs (suspension hertz/damping/limits, steering slew rate, steer clamp) prevented
 * the triggering spin-up event itself across repeated tuning attempts -- this is a genuinely missing
 * degree-of-freedom control, not a mistuned existing one, so a new assist term was added (same file/
 * function as the pre-existing anti-roll/yaw-damping assists, not a new subsystem).
 *
 * TUNING: rate-only (ANGLE gain = 0), unlike anti-roll's angle+rate combo -- a proportional ANGLE term
 * (tried first, e.g. 9000 Nm/rad) measurably fought the ordinary, harmless nose-lift/squat that happens
 * every hard launch, costing ~1-2km/h off the straight-line drive test's required >=90km/h/5s (that
 * pitch builds up slowly, so an angle-proportional torque leans on it continuously). A pitch RATE only
 * term stays silent during that slow, ordinary buildup but engages hard and fast the instant a violent
 * rate spike appears (the actual failure signature), which is exactly the discrimination needed here.
 * The cap is deliberately much higher than anti-roll/yaw-damping's (a genuine wheel-spin-reaction event
 * measured a multi-thousand-N*m sustained torque -- see stepVehicle()'s drivetrain section -- a small
 * cap could never arrest it before the pitch angle ran away).
 */
/**
 * RETIREMENT AUDIT (airborne round 3, see the audit block above ANTI_ROLL_ENABLED): retirement and
 * 50% authority both measured-failed (destruction-feel brick 120km/h peakDebris drops 19.1-20.4 ->
 * 17.6-17.7 m/s with it off, bound >18; 18.16 at half vs an 18.89 bound, plus cardetail-containment
 * detach count 0) -- crash-approach attitude integrity now depends on it; kept at FULL.
 */
export const ANTI_PITCH_ENABLED = true;
export const ANTI_PITCH_GAIN_ANGLE = 0; // N*m per radian of pitch (rate-only, see doc comment above)
export const ANTI_PITCH_GAIN_RATE = 14000; // N*m per (rad/s) of pitch rate
export const ANTI_PITCH_TORQUE_CAP_NM = 16000;

// ---------------------------------------------------------------------------------------------
// Ground-contact gating for the active assists above (FIXROUND-2 diagnostic A "airborne
// auto-leveling", TIGHTENED by the airborne-round-3 asymmetric-launch honesty pass). ROOT CAUSE
// (round 1): the assist torques were applied EVERY step unconditionally, so a real, physical
// airborne rotation (e.g. off the kicker ramp) got actively cancelled in flight (measured: pitch
// rate -0.6875 -> 0.0000 rad/s within ~0.3s airborne). FIX: scale the summed assist torque by a
// per-vehicle "ground authority" scalar (vehicle.ts's updateGroundAuthority()) from per-wheel real
// ground contact (getSuspensionDeflection() hysteresis, see ENTER/EXIT below). ROUND 3 tightening
// (user report: a HALF-ON-ramp launch "corrects itself flat instead of flipping"): full authority
// now requires >=3 grounded wheels (was >=2 -- which kept the assists fighting the roll rate a
// half-on launch's 2-grounded-wheel geometry imparts), the takeoff direction CUTS instantly (zero
// authority bleed into flight), and ASSIST_AUTHORITY_RAMP_TIME_S smooths the LANDING direction only.
// ---------------------------------------------------------------------------------------------

/**
 * Per-wheel ground-contact thresholds on getSuspensionDeflection(), meters -- hysteresis band (ENTER
 * a lower/looser bound than EXIT is HIGHER, i.e. once grounded it takes a bigger drop in deflection to
 * count as "left the ground" again) to avoid chatter right at the boundary. Calibrated empirically
 * (game/sim/diag): steady-state grounded deflection under normal driving load sits ~0.11-0.12m
 * (compressed toward SUSPENSION_UPPER_LIMIT_M), while genuinely airborne wheels relax back toward
 * ~0.00m (the spring's unloaded/free position, since chassis and wheel fall together) within a
 * fraction of a second -- a large, clean gap, not a fine line.
 */
export const GROUND_CONTACT_DEFLECTION_ENTER_M = 0.05; // deflection must rise above this to count as grounded
export const GROUND_CONTACT_DEFLECTION_EXIT_M = 0.02; // must fall below this to count as airborne again
/**
 * Time (s) to ramp the assists' authority from 0->1 on LANDING ONLY -- takeoff/contact-loss is an
 * INSTANT cut (asymmetric-launch honesty rewrite, airborne round 3: the old symmetric ramp bled
 * decaying assist authority into the first ~0.15s of genuine flight, damping the roll rate a
 * half-on-ramp launch imparts; see vehicle.ts's updateGroundAuthority()). The landing direction keeps
 * the ramp: touchdown should not snap full leveling torque on against whatever attitude the car
 * landed at.
 *
 * REMOVED alongside this rewrite (re-measured, not assumed): SUSTAINED_AIRBORNE_STEPS=10 +
 * PARTIAL_AUTHORITY_FLOOR=0.3 (a floor keeping >=0.3 authority through brief <=1-wheel contact dips,
 * added for a sustained-oscillation rollover mode observed under the OLD assist config). That
 * scenario was re-run under the new strict >=3-wheel/instant-cut policy with the post-retirement
 * assist set (see the audit above ANTI_ROLL_ENABLED) and stays green, so the machinery was deleted
 * rather than kept as dead complexity.
 */
export const ASSIST_AUTHORITY_RAMP_TIME_S = 0.15;
// NOTE (tried and removed, airborne round 3): a system-vertical-momentum FREE-FALL gate on ramp-up
// (block authority while the whole car reads ~-g) was prototyped against the same mid-flight
// authority leak the upDot>0.5 wheel-support check in updateGroundAuthority() closes. It was
// removed as redundant: every measured leak step ALSO had upDot <= -0.89 (rotation-induced spring
// load only fooled the deflection proxy while the car was past 90deg), and the free-fall gate
// measurably perturbed the crash suites (a hard wall crash contains real 1-3-step free-fall-grade
// bounce windows; cutting assist authority inside them reshuffled cardetail-containment's detach
// outcome to 0 at both -8 and -9.5 m/s^2 thresholds, while ballistic flight reads -9.99..-10.00).
/**
 * Fixed steps (at FIXED_DT) right after spawn/reset during which every wheel is forced "grounded"
 * regardless of raw deflection -- see Vehicle.settleStepsRemaining's doc comment in vehicle.ts. ~0.3s,
 * comfortably longer than the suspension's observed ~0.15s settle time (SUSPENSION_HERTZ_FRONT/REAR
 * ~3Hz => one full period ~0.33s, so this covers slightly more than one spring cycle).
 */
export const SUSPENSION_SETTLE_GRACE_STEPS = 20;

/**
 * Max drive torque (N*m) allowed on an individual driven wheel while THAT wheel is not in ground
 * contact (same per-wheel grounded check as above). FIX for the other half of diagnostic A: the
 * drivetrain servo always targets an unreachable wheel speed (powertrain.ts's UNREACHABLE_WHEEL_OMEGA)
 * and saturates at its torque cap regardless of whether the wheel has traction -- with no ground
 * contact, that cap used to be the FULL throttle-scaled engine torque (thousands of N*m), and since
 * the wheel joint's spin motor is a constraint between the wheel AND the chassis, that torque reacts
 * on the chassis too (a real wheel-spin-reaction pitch/yaw kick) even though the wheel is free-
 * spinning with nothing to push against. Capping it small while airborne keeps the "wheels spin up
 * for the visual" behavior without the chassis-reaction windup that (with the ground-contact gating
 * above now correctly disabling the anti-pitch assist while airborne) would otherwise go completely
 * uncountered.
 */
export const AIRBORNE_DRIVE_TORQUE_CAP_NM = 60;

// ---------------------------------------------------------------------------------------------
// Fixed timestep
// ---------------------------------------------------------------------------------------------

export const FIXED_DT = 1 / 60;
/**
 * TUNING DELTA (G3 damage system): was 4 pre-damage. Raised alongside WHEEL_FRICTION above (see its
 * doc comment for the full investigation) -- empirically, more substeps per world.step() call also
 * measurably improved straight-line acceleration with the 5 welded panel bodies present (4->69km/h,
 * 6->75, 8->77, 12->91 in 5s; non-monotonic beyond that, 16/20 substeps came back down to ~74 -- so
 * this isn't "more is strictly better", 12 was the empirically-chosen point that cleared the full
 * drive-test matrix). More box3d constraint-solver iterations per fixed step plausibly resolves the
 * weld joints' own "long chains may flex" solver-accuracy limit (see WHEEL_FRICTION's doc comment)
 * more tightly, which apparently matters for how the driven wheels' traction is realized. Only ever
 * measured indirectly through the 5 drive tests' behavior, same caveat as WHEEL_FRICTION's doc
 * comment. 12 substeps is not a runtime-performance concern for this vehicle's small body/joint count.
 */
export const FIXED_SUBSTEPS = 12;

// ---------------------------------------------------------------------------------------------
// box3d's per-body angular-velocity safety clamp -- BINDFIX applied.
//
// vendor/box3d/src/solver.c's b3IntegratePositionsTask() clamps EVERY dynamic body's angular speed
// to `B3_MAX_ROTATION * context->inv_dt` each step (B3_MAX_ROTATION = 0.25*pi, a "don't rotate more
// than 45 degrees in one world.step() call" tunneling-safety limit -- vendor/box3d/include/box3d/
// constants.h; at FIXED_DT=1/60 that's ~47.12 rad/s, capping our ~0.385m rear wheel's
// rolling-without-slip road speed at ~65 km/h), UNLESS the body was created with
// `b3BodyDef.allowFastRotation = true` (vendor/box3d/src/body.c, checked in solver.c's clamp;
// upstream's own doc comment: "Should only be used for circular objects, like wheels.").
//
// This is now wired end-to-end: src/wasm-shim/binding.c's b3js_CreateBody takes an
// `allowFastRotation` scalar, and src/ts/body.ts's BodyOptions exposes it. vehicle.ts's
// createVehicle() sets `allowFastRotation: true` on all 4 wheel bodies, so driven wheels can spin
// past the old ~65 km/h ceiling. The chassis-forward-force "engine assist" workaround that used to
// compensate for the capped wheel speed (see git history) has been removed -- powertrain.ts's
// existing torque-limited-velocity-servo pattern (driveServoTarget()/UNREACHABLE_WHEEL_OMEGA)
// reaches high speed on its own now that the wheels aren't artificially pinned.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Aerodynamic drag (FIXROUND-2 diagnostic C, "hidden top-speed runaway"). ROOT CAUSE: with the
// mount-asymmetry bug fixed (see WHEEL_DEFS' doc comment), the car no longer yaw-spirals into a
// crash at moderate speed -- but nothing in the model bounds top speed at all: the drivetrain servo
// always saturates its torque cap, and the only retarding forces were rolling resistance
// (WHEEL_ROLLING_RESISTANCE, tiny) and engine-braking-on-coast (not engaged at full throttle).
//
// RE-MEASURED (FIXROUND-2, with the mount-asymmetry/drift bug from diagnostic B already fixed): the
// originally-reported ~680 km/h at t=30s does NOT reproduce as a genuine on-ground runaway -- direct
// long-run tracing (60s+, large ground plane so the finite default 250m half-size never confounds the
// measurement) shows the car settling to a STABLE, BOUNDED ~105-120 km/h in 3rd gear, hovering right
// at that gear's peak-torque wheel speed (engine rpm sits at the ~4600rpm torque-curve peak; past it,
// rising rpm only gets LESS torque, so this is a genuine local force-vs-speed maximum for gear 3, not
// an artifact) -- full throttle, 60+ seconds, never progresses to 4th/5th gear. The original ~680km/h
// figure is consistent with what happens if that measurement's car instead drove off the ground
// plane's finite edge (250m half-size; at even a modest ~110km/h/30m/s cruise, 250m is crossed well
// under 10s) into unconstrained freefall -- gravity alone adds ~10m/s of speed per second airborne,
// which over ~17-20s of subsequent freefall accounts for the reported magnitude far more directly than
// a genuine ground-driven torque/traction runaway would. FIX (still correct and still applied,
// independent of the above): a real car's dominant top-speed-limiting force is aerodynamic drag (grows
// with v^2), entirely missing from this model before this pass -- added as quadratic drag opposing the
// chassis's full velocity vector (F = -0.5*rho*Cd*A*v^2*v_hat), applied every step in stepVehicle().
//
// SUPERSEDED (vehicle deep-pass, residuals 1+2): the "~105-120km/h, below the 180-240 band" gap
// above was a downstream symptom of the friction deficit (WHEEL_FRICTION's doc comment), not a
// powertrain problem -- with the parasitic panel-ground contact fixed at the geometry level (damage/
// panels.ts), the SAME gearing/torque-curve/taper this section's comment above called "unchanged"
// already reaches a genuine, honest settle speed of ~235km/h (measured: big-ground 60s full-throttle
// trace, gear 5, rpm~5400, well below redline -- a real force-balance settle, not a redline/gear-limit
// artifact) -- squarely inside the 180-240km/h target band withOUT any gearing/torque-curve change.
// No powertrain retune was needed once the actual traction/drag bottleneck was corrected; this
// confirms the original diagnostic C writeup's own suspicion ("this vehicle's actual settled top
// speed is low enough that CdA barely matters") had the causality backwards -- it wasn't that CdA
// didn't matter, it's that a large non-aerodynamic parasitic drag term (undiagnosed at the time) was
// the dominant retarding force, masking aero drag's real role entirely.
// ---------------------------------------------------------------------------------------------

/** Air density, kg/m^3 (sea-level, ~20C). */
export const AIR_DENSITY_KG_M3 = 1.225;
/**
 * Combined drag coefficient * frontal area (Cd*A), m^2.
 *
 * TUNING DELTA (vehicle deep-pass, residual 2): raised 0.3 -> 0.65 (the spec's own suggested sports-
 * coupe range is 0.6-0.7 m^2) now that the parasitic panel-ground drag confound (WHEEL_FRICTION's doc
 * comment) is fixed and no longer eats the straight-line test's margin -- re-verified directly: with
 * this value, straight-line still clears its >=85km/h/5s bar (measured 86.3km/h) and the settled top
 * speed (~235km/h, see the section doc comment above) lands solidly inside the 180-240km/h target
 * band, with a swept comparison (0.3/0.6/0.9/1.2 all measured) confirming top speed is NOT strongly
 * driven by this coefficient alone in this vehicle's operating range (0.6->1.2, roughly a 2x change,
 * only moved settle speed ~230->221km/h) -- gearing/torque-curve set the overall scale, drag fine-
 * tunes where in the target band it lands. 0.65 was chosen (rather than the swept 0.6/0.9/1.2 points)
 * to land mid-band with comfortable margin under the 240km/h ceiling.
 */
export const AERO_DRAG_COEFF_AREA_M2 = 0.65;

// ---------------------------------------------------------------------------------------------
// Brake torque ramp + progressive lateral grip (FIXROUND-2 diagnostic D, "friction/feel").
// ---------------------------------------------------------------------------------------------

/**
 * Time (s) over which the brake pedal's commanded torque ramps from 0 to full, once the pedal is
 * pressed -- FIX for the measured 1.9-2.2g transient spike in the first 2 steps of hard braking
 * (steady-state was already a reasonable 1.20-1.22g): the old code applied BRAKE_TORQUE_*_NM at full
 * magnitude the very first step the pedal is pressed, which -- combined with the tire's finite grip
 * -- produced a brief, unrealistic near-instantaneous deceleration spike before settling to the
 * traction-limited steady value. Real brake systems (and driver foot pressure) ramp up over a
 * fraction of a second; this does the same for the commanded torque only (steady-state braking
 * distance/deceleration is unaffected once the ramp completes).
 *
 * TUNING DELTA (vehicle deep-pass, residual 2): raised 0.15 -> 0.26, landing ~1.27g transient / ~1.02g
 * steady on the concept car.
 *
 * MUSTANG-65 SWAP RE-CALIBRATION (measured): the hero-car swap dropped the wheel radius 0.39 -> 0.31m
 * (car-map.ts). Brake FORCE at the contact patch is torque/radius, so the SAME commanded brake torque
 * now bites ~26% harder, and the smaller wheels' lower rotational inertia spins down faster into a
 * brief lockup -- the transient overshot back up to ~1.71g at the old 0.26s ramp (steady stayed
 * traction-limited at ~1.00g, still in band). Re-swept directly against game/sim/braking-g.test.mjs
 * (0.26/0.38/0.50/0.60/0.72 measured: transient 1.71/1.71/1.35/1.04/0.94, steady ~1.00-1.02
 * throughout): 0.60 lands the transient at ~1.04g with a comfortable margin under the 1.4g bound and
 * steady at ~1.01g, squarely inside the spec's 0.9-1.1g band. Steady braking distance is unaffected
 * (traction-limited once the ramp completes).
 */
export const BRAKE_TORQUE_RAMP_TIME_S = 0.6;

/**
 * Game-side progressive lateral-grip governor (see vehicle.ts's computeLateralGripAssistTorque()).
 * box3d's contact friction is a single isotropic Coulomb scalar (confirmed in vendor source, see
 * vendor/box3d/src/contact_solver.c) -- there is no slip-angle-dependent tire model, so the physical
 * lateral force available saturates at (mu * normal load) as soon as ANY meaningful slip develops,
 * essentially independent of how much slip/steer is actually commanded. Measured: cornering hit
 * 0.87-1.16g lateral at only 43% of max steer angle -- near-binary saturation, not the progressive
 * "more steer -> more lateral g, up to a limit" feel a real tire's slip-angle-vs-force curve gives.
 * FIX: an additional yaw-axis torque, layered on top of the physical friction response (not a
 * replacement for it -- WHEEL_FRICTION above still sets the underlying grip ceiling), that
 * softens/suppresses REALIZED lateral acceleration in proportion to how far the CURRENT commanded
 * steering angle is below the speed-sensitive max lock (speedSensitiveSteerClamp()), progressively
 * releasing that suppression as commanded steer approaches full lock. Deliberately keyed off
 * COMMANDED steer (not a measured body/tire slip angle) so it shapes the steering-authority curve
 * specifically without also damping genuine power-oversteer (a rear-wheel-drive slide with the wheel
 * held straight is NOT suppressed by this term -- "controllable power-oversteer" stays intact, per
 * the spec's explicit "car still fun" requirement).
 */
export const LATERAL_GRIP_PEAK_G = 0.95; // target peak lateral g at/near full steer lock
/** Progressive-ramp shaping exponent (>1 => slower initial rise, "materially below max at 50%
 * steer" -- e.g. ramp(0.5) = 0.5^1.8 =~ 0.29, i.e. ~29% of peak grip authority at half steer). */
export const LATERAL_GRIP_RAMP_EXPONENT = 1.8;
/** Gain (N*m per (m/s^2) of excess realized lateral accel above the ramp's allowance) and cap (N*m)
 * for the corrective yaw torque -- same shape as the pre-existing anti-roll/anti-pitch assists. */
export const LATERAL_GRIP_ASSIST_GAIN_NM_PER_MS2 = 900;
export const LATERAL_GRIP_ASSIST_TORQUE_CAP_NM = 5000;
/** Below this forward speed (m/s), the lateral-grip governor is inert (avoids divide-by-near-zero /
 * meaningless slip-angle-proxy behavior at a standstill or crawl). */
export const LATERAL_GRIP_MIN_SPEED_MS = 2;
