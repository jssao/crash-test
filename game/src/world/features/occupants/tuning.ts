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
export const SEAT_LOCAL: Record<SeatKey, V3> = {
	frontLeft: { x: 0.42, y: 0.22, z: 0.55 },
	frontRight: { x: -0.42, y: 0.22, z: 0.55 },
	rearLeft: { x: 0.42, y: 0.17, z: -1.05 },
	rearRight: { x: -0.42, y: 0.17, z: -1.05 },
};

/** Front 2 seats are belted (higher restraint force threshold, N); rear 2 are unbelted (lower) -- the
 * spec's "graded drama": a hard frontal ejects at least the unbelted ones, mild driving never breaks
 * either. Tuned against features-occupants.test.mjs (seated-stability / jostle / ejection). */
export const RESTRAINT_FORCE_THRESHOLD_N: Record<SeatKey, number> = {
	frontLeft: 16000,
	frontRight: 16000,
	rearLeft: 5300,
	rearRight: 5300,
};

/** Spawn drop, meters -- occupants spawn this far ABOVE their settled seat pose so the lap-restraint
 * joint's spring gently pulls the pelvis down onto the seat pan over the first few real fixed steps
 * (rather than snapping/spawning already mathematically perfect -- see physics.ts's module doc for why
 * this is done via ordinary in-loop settling instead of pre-stepping the shared world). */
export const SETTLE_DROP_M = 0.05;

/** Seat pan (my own minimal welded-to-chassis seat surface, self-contained per the task's ownership
 * split -- not depending on a 'cardetail' feature). */
export const SEAT_PAN_HALF_EXTENTS: V3 = { x: 0.22, y: 0.05, z: 0.22 };
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
 * ragdoll forever, active.ts). Real-world calibration: severe-but-survivable crash head loads run
 * ~40-60g, and the classic head-injury / skull-fracture / AIS-serious neighborhood begins ~60-80g+
 * (Head Injury Criterion territory); 65g sits at the lethal edge of that band. Measured against the
 * occupants-active tests: a ~70 km/h wall crash leaves ejected occupants below this (they survive and
 * flee), while a 140 km/h crash drives belted occupants well past it (they die in the seat). */
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
export const STABILIZE_STAND_PELVIS_Y_M = 0.92; // target pelvis height standing (column sags ~6cm under gravity, so aim high enough that the head clears 1.2m)
export const STABILIZE_WALK_SPEED_MS = 1.5; // capped horizontal flee speed
export const STABILIZE_LIN_GAIN = 6; // desired pelvis speed per meter of position error (1/s)
export const STABILIZE_MAX_LIN_SPEED_MS = 3.0; // clamp on the assisted pelvis speed (>= walk + rise)
export const STABILIZE_ANG_GAIN = 6; // desired pelvis angular speed per radian of tilt-from-upright (1/s)
export const STABILIZE_MAX_ANG_SPEED_RAD_S = 4.5; // clamp on the assisted uprighting rate
/** Subtle alternating hip pitch (radians) + frequency (Hz) giving the flee-walk a visible stepping gait
 * on top of the pelvis drift -- cosmetic, layered into the hip muscle targets during FLEE. */
export const STABILIZE_STEP_AMPLITUDE_RAD = 0.5;
export const STABILIZE_STEP_HZ = 1.4;

/**
 * GLASS-SHATTER TRIGGER geometry (chassis-local, same frame as SEAT_LOCAL: +X = car left, +Z = front,
 * y measured up from the chassis body origin). An ejecting occupant's head/torso trajectory crossing
 * one of these boundaries OUTWARD fires that window's glassShattered (active.ts records it; index.ts
 * forwards to the damage system's emitter via a sink main.ts wires in). Approximate cabin-boundary
 * planes derived from the seat geometry + car-map wheelbase (like SEAT_LOCAL -- not scanned glass
 * geometry), which is all the crossing test needs. Node names are car-map.ts's glassMeshNodes. */
export const GLASS_WINDSHIELD_Z_M = 0.95; // forward of the front seats (z=0.55); crossing +Z fires it
export const GLASS_SIDE_X_M = 0.6; // |x| beyond this (outward) fires that side's door window
export const GLASS_REAR_Z_M = -1.55; // behind the rear seats (z=-1.05); crossing -Z fires the rear window
/** Vertical band (chassis-local y) a crossing must fall within to count as "through the glass" rather
 * than under the floor / over the roof. */
export const GLASS_Y_MIN_M = 0.05;
export const GLASS_Y_MAX_M = 1.25;
export const GLASS_NODE_WINDSHIELD = 'BodyWindshield';
export const GLASS_NODE_DOOR_LEFT = 'BodyDoorLWindow';
export const GLASS_NODE_DOOR_RIGHT = 'BodyDoorRWindow';
export const GLASS_NODE_REAR = 'BodyRearwindow';

/**
 * CAR-COLLISION RE-ENABLE. An ejected occupant starts collision-filtered against the whole car (it
 * spawned INSIDE the single convex chassis hull -- un-filtering while still inside = explosive
 * depenetration, the hard constraint this feature is built around; see physics.ts's EJECTED_MARKER
 * doc). We re-enable car collision (flip groupIndex CAR_GROUP_INDEX -> 0) only once the occupant's
 * ENTIRE body AABB clears this chassis-local hull AABB + margin -- so they fly out through the
 * (now-shattered) glass unimpeded, then can land on / bounce off the car's exterior from OUTSIDE
 * without ever tunnelling back through it. Extents come from the real chassis hull silhouette
 * (vehicle/tuning.ts HULL_* + car dims), inflated to a safe enclosing box. */
export const HULL_AABB_HALF_X_M = 1.35;
export const HULL_AABB_HALF_Z_M = 2.3;
export const HULL_AABB_Y_MIN_M = -0.5; // chassis-local (origin ~hub height); ground is ~-0.39
export const HULL_AABB_Y_MAX_M = 0.9;
export const HULL_AABB_CLEAR_MARGIN_M = 0.2;
