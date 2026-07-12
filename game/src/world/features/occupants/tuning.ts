// SPDX-License-Identifier: MIT
//
// Tuning constants for the 'occupants' world feature: 4 articulated ragdoll passengers seated in the
// car (11 capsule bodies each -- pelvis/torso/head/2x upper-arm/2x forearm/2x thigh/2x shin), held by a
// breakable lap-restraint joint (pelvis -> chassis), that jostle under acceleration/impacts and get
// EJECTED on hard crashes. See physics.ts's module doc for the kinematic-chain math these feed.

import { quatFromAxisAngle, type Q4, type V3 } from '../../../vehicle/mathUtil';

export type Side = 'L' | 'R';
export type SeatKey = 'frontLeft' | 'frontRight' | 'rearLeft' | 'rearRight';
export const SEAT_KEYS: readonly SeatKey[] = ['frontLeft', 'frontRight', 'rearLeft', 'rearRight'];

/** Base (side-independent) body-part identity -- the 7 distinct shapes, 2 of which (upperArm/forearm/
 * thigh/shin) are mirrored L/R into the 11 actual capsule bodies per occupant. */
export type PartBase = 'pelvis' | 'torso' | 'head' | 'upperArm' | 'forearm' | 'thigh' | 'shin';
export const PART_BASES: readonly PartBase[] = ['pelvis', 'torso', 'head', 'upperArm', 'forearm', 'thigh', 'shin'];

/** The 11 actual per-occupant part keys (upperArm/forearm/thigh/shin duplicated per side). */
export type PartKey =
	| 'pelvis'
	| 'torso'
	| 'head'
	| 'upperArmL'
	| 'upperArmR'
	| 'forearmL'
	| 'forearmR'
	| 'thighL'
	| 'thighR'
	| 'shinL'
	| 'shinR';

export const PART_KEYS: readonly PartKey[] = [
	'pelvis',
	'torso',
	'head',
	'upperArmL',
	'upperArmR',
	'forearmL',
	'forearmR',
	'thighL',
	'thighR',
	'shinL',
	'shinR',
];

export function baseOf(part: PartKey): PartBase {
	if (part === 'pelvis' || part === 'torso' || part === 'head') return part;
	return part.slice(0, -1) as PartBase;
}

export function sideOf(part: PartKey): Side | null {
	if (part === 'pelvis' || part === 'torso' || part === 'head') return null;
	return part.endsWith('L') ? 'L' : 'R';
}

/** Capsule dims (meters): radius + half-length (capsule centers sit at local (0,+-halfLen,0) before
 * REST_OFFSET rotates that local-Y axis into the part's actual chassis-relative direction -- see
 * physics.ts). Approximate stylized adult-human proportions -- not anthropometrically exact, tuned for
 * a convincing/stable ragdoll rather than biomechanical accuracy. */
/**
 * torso/head TUNING NOTE (found via game/verify/feature-occupants.mjs's cabin-closeup screenshot):
 * originally torso halfLen=0.2/head radius=0.1 put the seated stack's head visibly ABOVE the roofline
 * -- this low sports-car concept's cabin headroom is tight (CAR_HEIGHT_M=1.149m total). Lowering
 * SEAT_LOCAL.y to compensate was tried FIRST and rejected: it dragged the shins/feet down through the
 * car floor into the world ground plane (shin-bottom world height went negative -- verified by hand:
 * chassisOriginHeight(~0.39) + SEAT_LOCAL.y + thigh/shin offsets), which pinned the whole car in place
 * via ground contact (a straight-line vehicle regression this feature must never cause -- vehicle.ts's
 * own tests are the authority there). Compacting the TORSO/HEAD instead (see ATTACH's matching
 * torsoBottom/torsoTop/torsoShoulder) keeps SEAT_LOCAL.y/leg geometry (and so ground clearance)
 * untouched.
 *
 * SECOND FINDING (also via cabin-closeup, after the first compaction pass): even fully tucked below
 * the roofline, every occupant stayed invisible from outside at EVERY size tried (including sizes
 * still meaningfully larger than the original bug) -- this car's windshield/side glass renders as an
 * opaque tint from outside in this build (confirmed NOT a positioning bug: the debugVisuals() hook
 * reports meshVisible/inScene=true and correct, expected world positions throughout, even when nothing
 * is visible in the screenshot). An exterior 3/4 screenshot of this car cannot visually confirm a
 * properly-enclosed seated pose either way -- game/verify/feature-occupants.mjs's debugVisuals()/
 * seatStates() hook output (JSON, logged every run) is the authoritative verification for occupant
 * placement, not the screenshot's pixel content. These dims are kept modest (a real but bounded
 * improvement over the original several-cm overshoot) rather than pushed further trying to force a
 * visible poke that this glass material won't reveal either way.
 */
export const PART_DIMS: Record<PartBase, { radius: number; halfLen: number }> = {
	pelvis: { radius: 0.11, halfLen: 0.05 },
	torso: { radius: 0.14, halfLen: 0.16 },
	head: { radius: 0.09, halfLen: 0.02 },
	upperArm: { radius: 0.05, halfLen: 0.13 },
	forearm: { radius: 0.045, halfLen: 0.12 },
	thigh: { radius: 0.08, halfLen: 0.18 },
	shin: { radius: 0.06, halfLen: 0.18 },
};

/** Fraction of OCCUPANT_MASS_KG carried by each part -- sums to 1 (verified in features-occupants.
 * test.mjs). Loosely modeled on Winter's body-segment-mass-fraction tables, rounded for readability. */
export const MASS_FRACTION: Record<PartKey, number> = {
	pelvis: 0.11,
	torso: 0.3,
	head: 0.07,
	upperArmL: 0.03,
	upperArmR: 0.03,
	forearmL: 0.02,
	forearmR: 0.02,
	thighL: 0.13,
	thighR: 0.13,
	shinL: 0.08,
	shinR: 0.08,
};

/** Total occupant mass, kg -- within the spec's 40-60kg band. */
export const OCCUPANT_MASS_KG = 55;

/** Rest-pose rotation OFFSET of each part's body, relative to the chassis's own rotation (i.e.
 * bodyWorldRot = chassisWorldRot * REST_OFFSET[part]) -- every part's capsule is authored along its
 * own local Y axis (center1=(0,-halfLen,0), center2=(0,+halfLen,0), matching Shape.ts's own capsule
 * default), so REST_OFFSET is what turns that "vertical in body-local space" into the part's actual
 * seated-pose direction in chassis space:
 *   - pelvis/torso/head/upperArm/forearm/shin: IDENTITY -- these all stay vertical (arms hang straight
 *     down from the shoulder; shins hang straight down from the knee to the floor).
 *   - thigh: +90deg about chassis-local X (LOCAL_RIGHT) -- maps local Y to chassis Z (forward), so a
 *     seated thigh runs horizontally forward from the hip (local Y-, "hip end") to the knee (local Y+,
 *     "knee end"), matching a ~90deg seated hip bend baked directly into the rest pose.
 */
export const REST_OFFSET: Record<PartBase, Q4> = {
	pelvis: { x: 0, y: 0, z: 0, w: 1 },
	torso: { x: 0, y: 0, z: 0, w: 1 },
	head: { x: 0, y: 0, z: 0, w: 1 },
	upperArm: { x: 0, y: 0, z: 0, w: 1 },
	forearm: { x: 0, y: 0, z: 0, w: 1 },
	thigh: quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2),
	shin: { x: 0, y: 0, z: 0, w: 1 },
};

/** Local (part-own-frame) attach points used to build the kinematic chain + every joint's frame
 * positions -- see physics.ts's childCenterFromParent()/buildJointFrames(). */
export const ATTACH = {
	pelvisTop: { x: 0, y: 0.05, z: 0 } as V3, // spine attach, on pelvis
	pelvisHip: (side: Side): V3 => ({ x: side === 'L' ? 0.1 : -0.1, y: -0.03, z: 0 }), // hip attach, on pelvis
	pelvisRestraint: { x: 0, y: -0.02, z: 0 } as V3, // lap-restraint attach, on pelvis
	torsoBottom: { x: 0, y: -0.16, z: 0 } as V3, // spine attach, on torso (matches PART_DIMS.torso.halfLen)
	torsoTop: { x: 0, y: 0.16, z: 0 } as V3, // neck attach, on torso (matches PART_DIMS.torso.halfLen)
	torsoShoulder: (side: Side): V3 => ({ x: side === 'L' ? 0.16 : -0.16, y: 0.11, z: 0 }), // shoulder attach, on torso
	headBottom: { x: 0, y: -0.02, z: 0 } as V3, // neck attach, on head
	upperArmTop: { x: 0, y: 0.13, z: 0 } as V3, // shoulder attach, on upperArm
	upperArmBottom: { x: 0, y: -0.13, z: 0 } as V3, // elbow attach, on upperArm
	forearmTop: { x: 0, y: 0.12, z: 0 } as V3, // elbow attach, on forearm
	thighHip: { x: 0, y: -0.18, z: 0 } as V3, // hip attach, on thigh (its own local frame, pre-REST_OFFSET)
	thighKnee: { x: 0, y: 0.18, z: 0 } as V3, // knee attach, on thigh
	shinKnee: { x: 0, y: 0.18, z: 0 } as V3, // knee attach, on shin
};

/**
 * Per-seat chassis-local hip point (world = chassisPos + rotate(chassisRot, this)) -- also the
 * lap-restraint joint's frameA position (on the chassis). Derived from car-map.ts's wheelbase/track
 * (approximate cabin placement, not scanned seat geometry -- verified visually + via the settle/
 * stability sim tests rather than exact interior scan data, see physics.ts's module doc). +X = car
 * left (matching vehicle.ts's FRONT_AXLE_MOUNTS.left convention), +Z = front.
 *
 * y=0.22 keeps the shin/foot capsule ends comfortably above the world ground plane (verified by hand
 * and empirically: see PART_DIMS's torso/head TUNING NOTE for why the roof-clearance fix was made by
 * compacting the torso/head instead of lowering this y). Rear seats sit 0.05m lower than front (y=0.17
 * vs 0.22): this fastback-style roofline visibly slopes down toward the rear (cabin-closeup screenshot,
 * game/verify/feature-occupants.mjs) -- rear heads still grazed the roofline at the front-seat height.
 */
// MUSTANG-65 SWAP RE-FIT: the four seat positions were re-checked against the Mustang cabin bounds
// (car-map width 1936mm -> half-width ~0.97m; DoorL inner surface ~0.72m; roofline 1309mm) and left at
// these values -- an occupant at x=+-0.42 with ~0.16m shoulder reaches only ~0.58m laterally, safely
// inside the door line, and the taller Mustang greenhouse gives MORE head clearance than the concept
// car did, so no compaction was needed. The lower chassis origin (wheel radius 0.39->0.31m) already
// seats everyone ~8cm lower. A forward rear-bench re-fit (z -1.05 -> -0.62) was TRIED and reverted: it
// destabilised the chaotic ejection dynamics (occupants no longer cleared the hull AABB after a 70km/h
// eject, and gentle-driving head RMS crept over its bound) for no visual gain the exterior/through-glass
// screenshots could show. Positions verified visually through the glass (game/verify/feature-occupants.
// mjs) + via the settle/stability/ejection sim tests.
// TIER-3 STAGE 2 NOTE: these positions are UNCHANGED from the pre-Stage-2 calibration. A rearward
// rear-bench nudge (z -1.05 -> -1.09, to clear the rear shins off the floorpan's rear edge once
// occupants gained real interior collision) was TRIED and reverted: with the legs clear at rest, a
// mere 30km/h bump lurch slammed them square into the floorpan's 13cm-tall rear face instead
// (measured 19.5kN rear-belt spikes vs 4.6kN before the nudge) -- the floorpan is occupant-
// transparent now instead (vehicle.ts), which removes that wall entirely and keeps every occupant
// calibration at its measured HEAD values.
// VOLVO S90 SWAP RE-DERIVATION (2026-07-11): the Mustang values above were re-checked against actual
// GLB node measurements (game/scripts/analyze-car.mjs-style bbox dump of "Driver Seat"/"Passenger
// Seat"/"Rear Seats", in the car's own load-time frame, chassis-local Y = worldY - CHASSIS_ORIGIN_
// HEIGHT_M = worldY - 0.359):
//   Driver Seat: world center (0.400, 0.778, 0.158), y-range 0.249..1.307 (bottom mount to headrest
//     top), z-range -0.289..0.605 (reclined seatback top to front cushion edge).
//   Rear Seats (bench): world center (0.000, 0.804, -0.881), y-range 0.371..1.237, z-range
//     -1.274..-0.487 (backrest top to front cushion edge).
//   Gas/Brake Pedal (cross-check for footwell depth): z-range 0.911..1.061 (world=chassis-local).
// HIP-POINT DERIVATION (not the mesh's bbox center, which mixes in headrest/backrest/floor-mount
// bulk): a real bucket seat's H-point sits ~25-30% up from the seat's bottom mount to its headrest
// top, and ~65-70% forward along its z-depth (toward the cushion front, away from the reclined
// backrest). Front: y = 0.249-0.359 + 0.28*(1.307-0.249) = -0.11+0.296 ~ 0.22m (matches the Mustang's
// own value almost exactly -- independent cross-check, not a copy); z = -0.289 + 0.70*(0.605-(-0.289))
// ~ 0.336m, cross-validated against the pedal box (hip sits ~0.65m behind the pedals: 0.986-0.65 ~
// 0.336m -- same number two ways). Rear (bench, sits at ~25% up given more compact bench construction,
// ~65% forward along its z-depth): y = 0.371-0.359 + 0.25*(1.237-0.371) ~ 0.229m -- kept a touch below
// front (0.20) since the bench cushion measurement band (0.20-0.23) still sits slightly lower in
// practice; z = -0.487 - 0.35*(-0.487-(-1.274)) ~ -0.76m, close to the rear door's own z-span midpoint
// (DoorRL center z ~-0.623) shifted rearward for legroom. X kept equal to the front seats (0.40,
// matching the Driver/Passenger Seat mesh's own measured x-center almost exactly) -- same simplifying
// convention the Mustang used (front/rear share the same lateral offset).
// CRITICAL DIFFERENCE FROM THE MUSTANG: with BULKHEAD_Z_M moved to -1.25 (vehicle/geometry.ts, S90
// swap), these rear occupants (z=-0.75) sit genuinely INSIDE the cabin (z > BULKHEAD_Z_M) -- unlike
// the Mustang's 2-door fastback, whose rear bench sat in the occupant-transparent TAIL crush volume
// (z=-1.05 < BULKHEAD_Z_M=-0.64) for lack of a real 4-door cabin to seat them in. This completes the
// "dummies actually in the seats" ask for a genuine sedan layout.
export const SEAT_LOCAL: Record<SeatKey, V3> = {
	frontLeft: { x: 0.4, y: 0.22, z: 0.35 },
	frontRight: { x: -0.4, y: 0.22, z: 0.35 },
	rearLeft: { x: 0.4, y: 0.2, z: -0.75 },
	rearRight: { x: -0.4, y: 0.2, z: -0.75 },
};

/** Front 2 seats are belted (higher restraint force threshold, N); rear 2 are unbelted (lower) -- the
 * spec's "graded drama": a hard frontal ejects at least the unbelted ones, mild driving never breaks
 * either. Tuned against features-occupants.test.mjs (seated-stability / jostle / ejection). */
export const RESTRAINT_FORCE_THRESHOLD_N: Record<SeatKey, number> = {
	// TIER-3 STAGE-2 RE-CALIBRATION (16000 -> 20000, measured sim/diag/stage2-inj70-trace with the
	// full browser-faithful loop): in the contact era a 70km/h wall loads the front belts to
	// 15.7-16.6kN while the crash-gate is open -- 16000 sat exactly ON that band and one belted
	// front ejected. The fronts' story is "belted: they stay in at 70" (only the unbelted rears
	// fly); 20000 gives ~20% margin. A 140km/h+ crash still overwhelms this by force alone.
	frontLeft: 20000,
	frontRight: 20000,
	// TIER-3 STAGE-2 RE-CALIBRATION (measured, sim/diag/stage2-inj30/70-trace probes with the full
	// browser-faithful loop INCLUDING the damage system -- its panel-weld breaks and crumple-first
	// ordering soften the deceleration the rear anchors see): at a 70km/h wall the rear belt loads
	// only 3.95-4.48kN while the crash-gate is open (the old 4000, calibrated pre-Stage-2 at 5.4kN,
	// sat exactly ON that band -- one rear ejected, the other read 0.99x and stayed). At a 30km/h
	// bump the rear peak is 1.39kN with the gate shut anyway (chassis window-mean 1.19g < 2.5g).
	// 3000 gives >=30% margin under the 70km/h band and >=2.1x margin over the 30km/h one. Ordinary
	// hard-driving contact spikes DO exceed it (13.8kN single-step limb arrests, measured) but ride
	// under an ordinary-driving chassis: the crash-gate blocks them and they never sustain 6 polls.
	rearLeft: 3000,
	rearRight: 3000,
};

/**
 * EJECTION GATING (user-playtest defect: an occupant "instantly phases out" on MILD impacts).
 * MEASURED (sim/diag/occupants-repro.test.mjs): the polled restraint constraint force is spiky --
 * a 30km/h wall bump produced single-step rear-seat spikes of 5326/5350N against the 5300N rear
 * threshold (ejecting both rear occupants from a bump that should never eject anyone), and even the
 * SPAWN/RESET settle drop alone produced 4.8-6.3kN single-step spikes, i.e. the rear threshold sat
 * INSIDE the solver's transient noise band. Two gates fix this at the mechanism (thresholds keep
 * their calibrated meaning):
 *   - ARMING: polls during the first RESTRAINT_ARM_STEPS after (re)seating are ignored -- the settle
 *     drop + brace-spring engagement transient can never eject anyone at spawn or world reset.
 *   - SUSTAIN: the force must exceed the threshold on RESTRAINT_BREACH_STEPS CONSECUTIVE polls. A
 *     real crash decelerates the cabin over many fixed steps (measured: a 70km/h wall crash holds
 *     front forces >16kN for well past 3 steps); a solver spike lasts one.
 */
export const RESTRAINT_ARM_STEPS = 30; // 0.5s @ 60Hz
// TIER-3 STAGE 2 RECALIBRATION (contact era): with REAL occupant<->interior collision, brief
// solver-arrest spikes (a limb/torso catching a sill or pillar mid-slalom for 1-2 steps) are normal
// driving physics, not ejections. The sustain window doubles (3 -> 6 polls = 100ms) and only serves
// as the slow-crush/pinned fallback; genuine crash ejections ride the FLY-BREAK gate below.
export const RESTRAINT_BREACH_STEPS = 6; // 100ms of sustained over-threshold force
/**
 * CRASH-BREAK gate (Tier-3 Stage 2 -- REPLACES the retired RESTRAINT_INSTANT_BREAK_FACTOR magnitude
 * path): an over-threshold belt force breaks the belt IMMEDIATELY only while the CHASSIS itself is
 * (or was, within the short decaying memory below) accelerating at at least this many g. Rationale +
 * measurements (sim/diag/stage2-* probes, browser-faithful loop):
 *   - Force magnitude CANNOT separate driving from crashes in the contact era: a smooth 0.5g S-curve
 *     at 26m/s produced single-step limb/torso arrest spikes of 3.0-3.4x the rear threshold (a shin
 *     catching the sill, the torso taking the interior wall), while the honest inertial load of a
 *     70km/h wall crash peaks at only 1.9-2.1x -- the regimes are INVERTED in force.
 *   - Pelvis-vs-chassis relative speed was tried and rejected: a braced occupant never GAINS
 *     relative speed precisely because the belt holds (measured 0.7m/s at the 70km/h breach) --
 *     chicken-and-egg.
 *   - WINDOWED chassis acceleration separates the regimes by an order of magnitude: mild-driving
 *     phases peak at 1.44g (launch) / 1.21g (0.5-brake) mean, while a 70km/h wall / 55km/h yank
 *     moves the chassis velocity 8-19m/s across the 10-poll window (6-11g mean). A single-step
 *     limb-arrest spike DOES jerk the 1300kg chassis past 2.5g for one poll (30kN+ solver impulse),
 *     but only moves its velocity ~0.4m/s -- the windowed mean stays ~0.2g, blind to it.
 *   - The 30km/h bump (~5g chassis, so the gate alone would pass) stays no-eject via the FORCE
 *     threshold itself: its belt peak is 0.76x -- never breaches, gate never consulted.
 * 2.5 sits ~1.7x above the hardest mild-driving chassis mean and >2x below the crash band.
 */
export const RESTRAINT_BREAK_MIN_CHASSIS_ACCEL_G = 2.5;
/** Crash-gate memory length, in polls (~0.17s at 60Hz) -- long enough that a yank-crash's
 * single-step velocity jump is still inside the window when the loading belt crosses threshold a
 * few steps later, short enough that the gate closes again a sixth of a second after any real
 * deceleration ends. */
export const RESTRAINT_ACCEL_WINDOW_POLLS = 10;

/** Spawn drop, meters -- occupants spawn this far ABOVE their settled seat pose so the lap-restraint
 * joint's spring gently pulls the pelvis down onto the seat pan over the first few real fixed steps
 * (rather than snapping/spawning already mathematically perfect -- see physics.ts's module doc for why
 * this is done via ordinary in-loop settling instead of pre-stepping the shared world). */
export const SETTLE_DROP_M = 0.05;

/** Seat pan (my own minimal welded-to-chassis seat surface, self-contained per the task's ownership
 * split -- not depending on a 'cardetail' feature). */
export const SEAT_PAN_HALF_EXTENTS: V3 = { x: 0.22, y: 0.05, z: 0.22 };
/**
 * Seat pans carry ONLY their own seat's category bit (instead of the default all-bits; one bit PER
 * SEAT INDEX, vehicle/tuning.ts's SEAT_PAN_CATEGORY_BITS), a SEATED occupant's mask includes only
 * its OWN seat's bit, and an EJECTED occupant's mask drops all pan bits -- so a pan holds exactly
 * the one occupant it exists for and is transparent to everyone else, seated or flying. MEASURED
 * artifacts this shape of filter fixes: (1) ejected era (sim/diag/occupants-eject-detail.test.mjs):
 * a rear occupant ejected in a 70km/h frontal crossed the cabin at ~19m/s and its trailing legs
 * raked the FRONT seat pan -- a rigid (hertz=0) weld to the 1300kg chassis, i.e. effectively a wall
 * -- yanking a 90g one-step spike through the hip joints into the torso and killing it mid-cabin
 * before it reached the windshield. (2) Stage-2 seated era (sim/diag/stage2-* probes): once seated
 * occupants gained real interior collision, a plain 0.5-brake slid both soft-belted (3Hz spring)
 * rears ~0.7m forward INTO the front seats' pans for single-step 3.1-3.2x belt-threshold arrest
 * spikes -- false ejections during the mild-driving suite -- and a hard steer flick wedged a rear
 * shin between its own pan's outboard edge and the sill (opposing-normal pincer, 12-13kN). Real
 * seat backs fold/break away under a 55kg body at highway speed; a rigid-weld pan is the same class
 * of modeling artifact as the solid nose/tail crush volumes, and it gets the same treatment
 * (filtered down to the one pair it exists for). Everything else still collides with pans normally
 * (their maskBits stay default). The bits themselves are DEFINED in vehicle/tuning.ts's
 * collision-filter bit registry (Tier-3 Stage 2) because the vehicle core needs them to build the
 * derived category words and must not import a world feature's module; re-exported here for this
 * feature's own call sites. */
export { SEAT_PAN_CATEGORY_BITS, SEAT_PAN_ALL_CATEGORY_BITS } from '../../../vehicle/tuning';

/**
 * Shared negative collision group for ALL occupant capsules (every occupant, every part, seated AND
 * ejected) -- Tier-3 STAGE 2: occupants left the car's shared CAR_GROUP_INDEX (-1) so category/mask
 * filtering can give them REAL collision against the cabin interior shells + glass panes (see
 * vehicle/tuning.ts's collision-filter bit registry). A distinct shared negative group preserves the
 * two suppressions the old shared car group provided for free and that must survive the move:
 * occupant-vs-occupant (4 ragdolls seated centimeters apart, and mid-flight bodies crossing the
 * cabin) and self-collision among one ragdoll's own 11 capsules (non-adjacent parts overlap in the
 * seated pose by construction). vs the car's own group (-1 != -2) the pair falls through to
 * category/mask -- exactly the point.
 */
export const OCCUPANT_GROUP_INDEX = -2;
export const SEAT_PAN_MASS_KG = 4;
export const SEAT_PAN_FRICTION = 0.9;
/** Vertical drop from SEAT_LOCAL down to the seat pan's center (pan top sits ~1cm below the pelvis's
 * settled resting bottom -- see physics.ts's derivation). */
export const SEAT_PAN_DROP_M = 0.2;

// ---- Joint tuning (cone/twist limits in radians, spring hertz/dampingRatio) ----
// Cone/twist ranges are loose human-anatomy approximations (not exact clinical ROM figures), tuned for
// a stable, non-floppy ragdoll that still visibly jostles -- see spherical-joint.test.ts for the API
// this rides on (coneAngle/twist limits are relative to each joint's own frame, not world axes).

export const NECK_CONE_RAD = 0.6;
export const NECK_TWIST_RAD = 0.5;
export const SPINE_CONE_RAD = 0.35;
export const SPINE_TWIST_RAD = 0.3;
export const SHOULDER_CONE_RAD = 1.4;
export const SHOULDER_TWIST_RAD = 1.2;
export const HIP_CONE_RAD = 1.0;
export const HIP_TWIST_RAD = 0.4;
export const RESTRAINT_CONE_RAD = 0.5;
export const RESTRAINT_TWIST_RAD = 0.35;

/** Modest critically-damped-ish spring on every ball joint, pulling it back toward the seated rest
 * pose -- spec: "add modest spring damping so they don't flop like noodles". */
export const BALL_SPRING_HERTZ = 3;
export const BALL_SPRING_DAMPING = 1;

/** Elbow/knee (revolute) limits -- deliberately generous/symmetric (rather than a biomechanically
 * one-sided hinge range) because the joint's own zero-angle reference depends on a sign convention this
 * feature doesn't independently verify against upstream (see physics.ts's HINGE_AXIS_ROTATION doc
 * comment) -- a symmetric range avoids the joint ending up almost-fully-limited on the wrong side. */
export const HINGE_LOWER_RAD = -2.2;
export const HINGE_UPPER_RAD = 2.2;
export const HINGE_SPRING_HERTZ = 1.5;
export const HINGE_SPRING_DAMPING = 0.6;

export const OCCUPANT_FRICTION = 0.5;
export const OCCUPANT_RESTITUTION = 0.1;
export const OCCUPANT_ROLLING_RESISTANCE = 0.05;

/**
 * Friction an ejected occupant's shapes are swapped to (see physics.ts's pollOccupantRestraint()) --
 * MEASURED FINDING: with the seated OCCUPANT_FRICTION/SEAT_PAN_FRICTION combination (needed to keep a
 * seated, still-restrained occupant from sliding around under normal cornering/braking), a freshly-
 * EJECTED occupant stayed frictionally glued to the seat pan's grippy surface even with the restraint
 * joint gone (measured directly: a 70km/h wall crash produced <0.7m of pelvis-to-chassis separation
 * over 3s instead of a real ejection) -- friction, not the joint, was arresting it. Swapping to a low
 * value on ejection (mirrors game/src/damage/panels.ts's breakPanelWeld() shape-swap-on-break pattern)
 * decouples "grippy while seated" from "slides/flies freely once ejected" without compromising seated
 * stability.
 */
export const EJECTED_FRICTION = 0.1;

/**
 * One-time linear impulse (kg*m/s, i.e. newton-seconds), applied to the pelvis ALONE (the rest of the
 * ragdoll follows via its still-intact internal joints) at the exact instant a restraint breaks, along
 * the pelvis's OWN current velocity direction -- a physically-motivated "release" (real seatbelts/seat
 * structures store some elastic energy that snaps free on failure) that also compensates for a MEASURED
 * structural asymmetry: a frontal wall impact decelerates the chassis hardest right at the impact point
 * (near the front seats), but the REAR of the car (and so the rear seats' chassis-local anchor) lags
 * that deceleration -- at the same crash speed/threshold, front occupants measured 6-7m of separation
 * in 3s while rear occupants measured under 1.5m, well short of the spec's ">2m within 3s" bar, purely
 * from passive inertia. This kick makes the drama reliable regardless of which seat/how-hard-exactly a
 * given crash decelerates that seat's own local chassis point.
 */
export const EJECTION_KICK_NS = 220;

/** Shirt colors, one per seat, seeded deterministically (mulberry32, matching world/materials.ts's
 * existing seeded-noise convention) rather than Math.random() -- see feature.ts's contract note #3. */
export const SHIRT_COLOR_SEED: Record<SeatKey, number> = {
	frontLeft: 0x2b6cb0, // blue
	frontRight: 0xb02b3f, // red
	rearLeft: 0x2f8f4e, // green
	rearRight: 0xd18f1a, // amber
};

// =================================================================================================
// MUSCLE / LIFE-DEATH / SELF-PRESERVATION tuning (drives active.ts). See that module's doc comment.
// =================================================================================================

/**
 * MUSCLE LAYER. Each articulated ball-joint that we actively "power" gets a PD controller in active.ts:
 * a world-space corrective torque = Kp*(rotation error toward the target relative pose) - Kd*(relative
 * angular velocity), its MAGNITUDE HARD-CLAMPED to maxTorqueNm, applied as an equal-and-opposite pair
 * to the child and parent bodies (Body.applyTorque, momentum-conserving -- like a real muscle spanning
 * a joint). The clamp is the whole point of the drama gradient: within its torque budget a muscle holds
 * posture against ordinary g's (braking/cornering), but a crash's angular impulse blows straight past
 * the budget and the joint goes limp-ragdoll for that instant (test: occupants-active braced-vs-limp +
 * muscle-overwhelm). maxTorqueNm values are grounded in real human isometric joint-strength orders of
 * magnitude (neck extensors ~30-50 N*m, lumbar/trunk ~150-300 N*m, hip ~150-350 N*m, shoulder ~50-90
 * N*m) rather than tuned purely for looks. Kp/Kd give a snappy-but-damped (~2-3 Hz, ~critically damped)
 * hold well inside those torque ceilings for small errors. These are the SEATED-BRACING gains; the
 * self-preservation FSM (active.ts) reuses the same controller with pose targets swapped per state. */
export interface MuscleGains {
	kp: number; // N*m per radian of orientation error
	kd: number; // N*m per (rad/s) of relative angular velocity
	maxTorqueNm: number; // hard magnitude clamp -- the "muscle strength" ceiling
}
export const MUSCLE_NECK: MuscleGains = { kp: 90, kd: 9, maxTorqueNm: 45 };
export const MUSCLE_SPINE: MuscleGains = { kp: 900, kd: 110, maxTorqueNm: 320 };
export const MUSCLE_SHOULDER: MuscleGains = { kp: 70, kd: 8, maxTorqueNm: 70 };
export const MUSCLE_HIP: MuscleGains = { kp: 320, kd: 34, maxTorqueNm: 260 };

/**
 * MUSCLE DISCRETE-TIME STABILITY (user-playtest defect: "twitchy/nervous" seated occupants).
 * MEASURED: with the gains above applied as raw per-step explicit torques at 60Hz, an occupant at
 * IDLE showed head angular-velocity RMS of ~24 rad/s (sim/diag/occupants-repro.test.mjs) -- a violent
 * limit-cycle, not a subtle shimmer. Root cause is classic explicit-integrator gain overflow on the
 * LIGHT bodies: a damping torque -kd*w applied for one step dt on inertia I updates w by factor
 * (1 - kd*dt/I), which DIVERGES (sign-flipping, growing) when kd > 2*I/dt. The head's transverse
 * inertia is ~0.02 kg*m^2, so its stable kd ceiling at 60Hz is ~1.2 N*m*s -- the tuned kd of 9 is
 * ~7x past the divergence bound (same story for the arms). The kp term has the matching bound
 * kp < I*(w_nyq)^2. FIX (active.ts applyMuscle): each muscle's EFFECTIVE gains are capped per child
 * body at these stability fractions of the discrete-time bounds (kd <= f*I/dt, kp <= f*I/dt^2), plus
 * a small target deadband so a settled joint applies exactly zero torque instead of chattering
 * against the clamp. The tuned gains above still apply in full to heavy parts (torso) whose inertia
 * affords them. NOTE: seated occupants no longer use these muscles at all (solver-spring bracing,
 * see SEATED_BRACE_* below) -- these gains drive the ejected-FSM poses only.
 */
export const MUSCLE_KD_STABLE_FRACTION = 0.7; // of I/dt (well inside the non-oscillating <1 regime)
export const MUSCLE_KP_STABLE_FRACTION = 0.7; // of I/dt^2
/** No muscle torque at all when the pose error AND relative spin are inside this deadband. */
export const MUSCLE_DEADBAND_RAD = 0.06;
export const MUSCLE_DEADBAND_RAD_S = 0.35;

/** Approximate transverse moment of inertia (kg*m^2) of each part's capsule about its center --
 * solid-cylinder-of-total-length approximation, m*(3r^2 + L^2)/12 with L = full capsule length
 * including caps. Feeds the per-part discrete-stability gain caps above; an approximation is fine
 * (the caps carry a 0.7 safety fraction). */
export function partTransverseInertia(part: PartKey): number {
	const dims = PART_DIMS[baseOf(part)];
	const m = MASS_FRACTION[part] * OCCUPANT_MASS_KG;
	const fullLen = 2 * dims.halfLen + 2 * dims.radius;
	return (m * (3 * dims.radius * dims.radius + fullLen * fullLen)) / 12;
}

/**
 * SEATED BRACING (rebuilt after the user playtest -- defect: constant visible jitter at rest).
 * While ALIVE + SEATED the occupant is now held by the JOINT SOLVER'S OWN SPRINGS (SphericalJoint
 * hertz/dampingRatio, solver-integrated and unconditionally stable -- the same surface the lap-belt
 * brace already used) instead of explicit per-step muscle torques, with GAIN SCHEDULING on the
 * measured chassis g-load:
 *   - chassis calm (below BRACE_G_LO): springs stay at the passive BALL_SPRING_HERTZ -- the occupant
 *     is VISUALLY STILL (bodies may even sleep), zero active torque, zero jitter by construction.
 *   - real g (braking/cornering/impacts, above BRACE_G_HI): ball-joint springs ramp to
 *     SEATED_BRACE_HERTZ and the lap-belt to RESTRAINT_BRACE_HERTZ -- the visible "brace up".
 *   - braceLevel attacks fast (a human startles quickly) and releases slowly (no flickering).
 * The crash drama gradient is preserved: solver springs are SOFT constraints a violent angular
 * impulse still overwhelms (measured: 140km/h braced-vs-limp deviation ratio stays within the
 * overwhelm test's band), and a real crash still snaps the belt through RESTRAINT_FORCE_THRESHOLD_N
 * -> ejection -> limp. */
export const SEATED_BRACE_HERTZ = 9;
export const BRACE_G_LO = 0.25; // below this chassis g-load: fully relaxed
export const BRACE_G_HI = 0.6; // above this: fully braced
export const BRACE_ATTACK_TAU_S = 0.06;
export const BRACE_RELEASE_TAU_S = 0.45;
/** Chassis g-load is EMA-smoothed with this time constant before scheduling (one 60Hz step of raw
 * |dv|/dt is far too spiky a signal to gate on directly). */
export const BRACE_G_SMOOTH_TAU_S = 0.12;

/**
 * CORE/trunk bracing acts through the LAP-RESTRAINT SPRING rather than an explicit PD torque: while
 * alive + seated we raise the pelvis<->chassis spring stiffness from its passive BALL_SPRING_HERTZ to
 * this braced value, which holds the pelvis upright ON THE BELT (target = the seated rest orientation)
 * so the muscle-held torso has a stable base instead of tipping with a sagging pelvis. A solver-
 * integrated spring is UNCONDITIONALLY STABLE even on the light (~6kg) pelvis body, unlike a stiff
 * explicit per-step PD torque (which oscillates at these stiffnesses). It is NOT torque-capped, but the
 * drama gradient is preserved a different way: in a real crash the stiff belt's own constraint force
 * spikes straight through RESTRAINT_FORCE_THRESHOLD_N and the belt BREAKS (ejection) -> limp ragdoll.
 * On death the restraint spring is dropped back to slack (setOccupantLimp) so a killed belted occupant
 * hangs limp. */
export const RESTRAINT_BRACE_HERTZ = 16;
export const RESTRAINT_BRACE_DAMPING = 1;

/** During TUMBLING (alive, airborne/just-ejected) muscles drop to a fraction of full strength -- a
 * flailing-but-slightly-protective tone, not a firm brace (arms pull toward the head, see active.ts). */
export const MUSCLE_TUMBLING_SCALE = 0.35;

/**
 * LIFE/DEATH MODEL. Peak head OR torso linear acceleration during the whole scenario, expressed in g
 * (using 9.81 m/s^2 as the g unit for comparison with real-world crash-safety figures even though the
 * sim's gravity is 10 m/s^2). Above this -> the occupant is KILLED (motors off, springs off, pure limp
 * ragdoll forever, active.ts). Real-world calibration: real belted-occupant chest/head accelerometer
 * traces put ~50% fatality risk (AIS-5+/skull-fracture territory) around 60-70g of CFC-filtered peak
 * accel; 65g sits centered in that band.
 *
 * OCCUPANT DE-ALIASING RE-DERIVATION (2026-07-12): this constant is now measured against the WINDOWED
 * peakAccelG (active.ts's updateLifeDeath(), same 2-step/33ms sliding-window technique as game/src/lab/
 * instrumentation.ts's ChassisDecelTracker -- see that file's doc comment for the shared root cause).
 * The PRE-FIX raw single-step reading aliased the same way the chassis metric did: it ran roughly 1.7-2x
 * the windowed value at every speed tested (measured sweep below), which is what made lab NHTSA-56
 * (56km/h) belted occupants read 69-71g raw against this same 65g threshold and die outright -- a speed
 * real belted NCAP dummies survive. Fixing the MEASUREMENT (not this threshold) resolves it: this value
 * is unchanged from its prior calibration because that calibration's real-world grounding (60-70g ~
 * 50%-fatality band) was always meant for a filtered/windowed reading, not a raw 60Hz sample derivative --
 * the raw form was simply the wrong signal feeding a right-sized gate.
 *
 * MEASURED SWEEP (sim, browser-faithful loop incl. damage system, windowed peakAccelG, wall crash from
 * a settled rig): 30km/h ~8g (all seated) / 40km/h ~26g (all seated) / 45km/h front ~31-32g seated,
 * rear ~44g ejected-alive / 55km/h front ~41g seated, rear ~52-54g ejected-alive / 64km/h front ~48g
 * seated, rear ~54-55g ejected-alive-settled / 70km/h front ~52g seated, rear ~54-55g ejected-alive-
 * settled / 80km/h front ~68g DEAD, rear ~76-77g DEAD / 140km/h ~131-146g DEAD. The lethal crossover
 * sits cleanly between 70 and 80km/h (all 4 alive through 70, all 4 dead by 80) -- physically sensible
 * tiers: low speed (30-40) genuinely safe, mid speed (45-70) ejects the unbelted rears but everyone
 * SURVIVES (belted fronts never even eject), high speed (80+) is lethal for all. Cross-referenced
 * against game/verify/crash-lab.mjs's real-GLB NHTSA-56 (56km/h) run, which now reads belted occupants
 * alive with a comparable windowed peak (see that file's assertion). */
export const DEATH_PEAK_ACCEL_G = 65;
export const GRAVITY_G_UNIT = 9.81;

/**
 * SELF-PRESERVATION FSM timings (seconds) + geometry. See active.ts's state machine. Honest-physics
 * disclosure lives on STABILIZE_* below and in active.ts's module doc: seated bracing + the life/death
 * model + the muscle-overwhelm gradient are all real torque-limited physics; the post-crash get-up and
 * flee-walk ride on a DOCUMENTED stabilization ASSIST (a velocity-level kinematic servo on the core
 * column standing in for the balance controller + foot-ground-reaction loop a real biped needs),
 * clearly labelled, not emergent balance. */
export const FSM_SETTLE_SECONDS = 1.0; // time settled-on-ground before attempting to get up
export const FSM_RECOVER_SECONDS = 2.5; // get-up duration before transitioning to flee-walk
export const FSM_TUMBLE_MIN_SECONDS = 0.4; // minimum flail time before "settled" can latch
/** How far from the car (meters) the occupant tries to flee, and the "safe" arrival radius. */
export const FLEE_DISTANCE_M = 15;
export const FLEE_ARRIVED_M = 12;
/** Below this ground speed (m/s) AND angular speed (rad/s) the pelvis counts as "settled". */
export const SETTLE_LINEAR_SPEED_MS = 1.2;
export const SETTLE_ANGULAR_SPEED_RAD_S = 2.5;

/**
 * DOCUMENTED STABILIZATION ASSIST (active.ts, RECOVER/FLEE/SAFE only -- NEVER while seated, NEVER while
 * dead, NEVER during TUMBLING). This is the honest-physics boundary: an 11-capsule ragdoll cannot
 * balance/stand/walk from pure joint motors without a full balance controller (ZMP/foot-placement +
 * ground-reaction loop) that is out of scope here. Instead, once an occupant has settled and starts to
 * recover, we drive its PELVIS with a VELOCITY-LEVEL (kinematic) servo -- each step SETTING the pelvis's
 * linear & angular velocity toward the standing target (Body.setLinearVelocity/setAngularVelocity)
 * while the muscle PD drags the rest of the body along like a puppet. Velocity-level control is
 * UNCONDITIONALLY STABLE, unlike a stiff force/torque servo on the light (~6kg) pelvis body (which
 * oscillates it to box3d's per-step rotation clamp, ~45 rad/s). The pelvis servo IS the assist -- it
 * substitutes for the legs' ground reaction + the balance loop. Labelled as such in code + in the
 * return-to-user; NOT sold as emergent locomotion. */
/**
 * GROUND-RELATIVE RECOVERY (user-playtest defect: the recovery puppet held a half-crouch HOVERING
 * mid-air). All STABILIZE heights below are ABOVE THE MEASURED GROUND under the occupant, not
 * absolute world Y: the original code assumed ground == y=0, which the terrain wave (400x400
 * heightfield) invalidated -- an occupant recovering where the terrain sits below/above 0 hovered
 * mid-air / was driven into the dirt. active.ts now raycasts straight down under the pelvis every
 * ejected step (World.castRayClosest, masked to EJECTED_MARKER_BIT so it can never hit the ejected
 * ragdoll's own capsules -- see physics.ts) and drives pelvis height relative to that hit. If no
 * ground was ever measured, the occupant stays DOWN (settled) rather than attempting a float-stand;
 * if the stand is physically blocked mid-recover (pelvis can't follow the ramp), it gives up and
 * stays down for good -- visibly wrong beats subtly fake. */
export const GROUND_RAY_UP_M = 1.5; // ray origin height above the pelvis
export const GROUND_RAY_DOWN_M = 25; // ray length downward
/** Pelvis height (above ground) the RECOVER ramp starts from (crouched, grounded). */
export const RECOVER_CROUCH_PELVIS_Y_M = 0.2;
/** Late in RECOVER (past this ramp fraction), a pelvis still below RECOVER_BLOCKED_PELVIS_Y_M above
 * ground counts as blocked; RECOVER_BLOCKED_MAX_STEPS consecutive blocked steps = give up, stay down. */
export const RECOVER_BLOCKED_RAMP_FRACTION = 0.6;
export const RECOVER_BLOCKED_PELVIS_Y_M = 0.45;
export const RECOVER_BLOCKED_MAX_STEPS = 45;

export const STABILIZE_STAND_PELVIS_Y_M = 0.92; // target pelvis height ABOVE MEASURED GROUND standing (column sags ~6cm under gravity, so aim high enough that the head clears ground+1.2m)
export const STABILIZE_WALK_SPEED_MS = 1.5; // capped horizontal flee speed
export const STABILIZE_LIN_GAIN = 6; // desired pelvis speed per meter of position error (1/s)
export const STABILIZE_MAX_LIN_SPEED_MS = 3.0; // clamp on the assisted pelvis speed (>= walk + rise)
export const STABILIZE_ANG_GAIN = 6; // desired pelvis angular speed per radian of tilt-from-upright (1/s)
export const STABILIZE_MAX_ANG_SPEED_RAD_S = 4.5; // clamp on the assisted uprighting rate
/** Subtle alternating hip pitch (radians) + frequency (Hz) giving the flee-walk a visible stepping gait
 * on top of the pelvis drift -- cosmetic, layered into the hip muscle targets during FLEE. */
export const STABILIZE_STEP_AMPLITUDE_RAD = 0.5;
export const STABILIZE_STEP_HZ = 1.4;

// RETIRED (Tier-3 Stage 2, the FILTER PATH): the GLASS_* trajectory-plane-crossing constants and the
// HULL_AABB_* car-collision-re-enable extents are gone. Glass shatter is now literal contact physics
// -- two SOLID pane shapes on the chassis (vehicle.ts GLASS_ENTITY_ID, geometry.ts
// buildGlassPaneShapes()) whose hit events the damage system's central drain consumes (system.ts:
// glassShattered + destroy the pane) -- and ejected occupants keep ONE honest filter for their whole
// lifetime (physics.ts: OCCUPANT_GROUP_INDEX + the occupant category/mask bits registered in
// vehicle/tuning.ts), colliding with the car's interior shells/glass/world (and, once ejected, the
// panels) from the first step, so there is no "re-enable once clear of an AABB" moment anymore.
// (Door-window note kept for the record: the Mustang asset's door glass is baked into the door
// PANEL meshes, so the two pane shapes -- 'Windshield' incl. the front quarter glass, and
// 'RearWindow' -- are the only dedicated panes; a side ejection exits through the genuinely open
// window aperture between the pillars.)
