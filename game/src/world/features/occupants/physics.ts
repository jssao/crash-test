// SPDX-License-Identifier: MIT
//
// Renderer-free physics assembly for one seated ragdoll occupant (11 capsule bodies + 11 joints) plus
// its minimal welded seat pan. No `three` import -- shared by the browser feature (./index.ts, ./
// visuals.ts) and the headless sim test (game/sim/features-occupants.test.mjs), same convention as
// game/src/vehicle/vehicle.ts.
//
// KINEMATIC-CHAIN MATH: every part's capsule is authored along its OWN local Y axis (center1=
// (0,-halfLen,0), center2=(0,+halfLen,0) -- matching Shape.ts's own capsule default), and REST_OFFSET
// (tuning.ts) is the fixed rotation, relative to the CHASSIS's own rotation, that turns that "vertical
// in body-local space" into the part's actual seated-pose direction (e.g. a thigh's local Y maps to
// chassis-forward Z). Given that, every part's rest-pose WORLD position is built by walking the chain
// from a parent's own attach point out to the child's matching attach point (childCenterFromParent()),
// and every joint's frameA/frameB rotations are derived (not guessed) so the joint's own reference
// frames exactly coincide in world space at that rest pose (buildBallFrames()/buildHingeFrames()) --
// derivation: requiring parentWorldRot*frameA == childWorldRot*frameB at rest, with parentWorldRot =
// chassisRot*parentOffset and childWorldRot = chassisRot*childOffset, cancels chassisRot entirely
// (quaternion product is associative) -- so frameA/frameB depend only on the two parts' fixed
// REST_OFFSETs, never on the chassis's current world rotation. That's what makes every internal joint
// (spine/neck/shoulder/elbow/hip/knee) start at zero constraint error at spawn/reset regardless of how
// the car is currently oriented.
//
// SEAT PLACEMENT: SEAT_LOCAL (tuning.ts) is an approximate cabin placement derived from car-map.ts's
// wheelbase/track (NOT scanned interior/seat geometry -- no seat nodes exist in car-map.ts), verified
// visually (game/verify/feature-occupants.mjs) and physically (features-occupants.test.mjs: settles
// without NaN, without falling through the floor, restraint force stays within the tuned no-break
// range under mild driving).
//
// SETTLE: occupants spawn SETTLE_DROP_M above their rest pose (only the pelvis<->chassis lap-restraint
// joint has this deliberate initial offset -- every OTHER joint in the chain starts at zero error, see
// above) and the restraint's own spring pulls the whole character down onto the seat pan over the
// first few real fixed steps of gameplay. Deliberately NOT done by pre-stepping the shared `world` in
// the factory: world.step() would also advance the vehicle/destructible-world's own physics (and, for
// the vehicle specifically, its drivetrain/suspension-settle bookkeeping only updates inside
// stepVehicle(), which nothing here calls) by however many steps this feature pre-stepped -- an
// unintended side effect on other owners' state. The visible cost is a very brief (a few frames)
// in-place settle the first time the game renders, which is imperceptible and matches "let them settle
// for a few warmup steps" without touching anyone else's fixed-step bookkeeping.
//
// COLLISION FILTERING (Tier-3 STAGE 2, the FILTER PATH -- see vehicle/tuning.ts's collision-filter
// bit registry and docs/build-log/specs/compound-hull-design.md): occupant capsules carry ONE honest
// filter for their whole lifetime --
//   categoryBits = OCCUPANT_CATEGORY_BIT (their only bit; rays that must never hit a ragdoll, e.g.
//                  active.ts's ground raycast, mask it out),
//   maskBits     = seated:  OCCUPANT_COLLIDABLE_BIT | SEAT_PAN_CATEGORY_BITS[own seat] (own pan
//                           ONLY -- the other three rigid pans are transparent, tuning.ts seat-pan doc)
//                  ejected: OCCUPANT_COLLIDABLE_BIT | OCCUPANT_EJECTED_COLLIDABLE_BIT
//                  so they REALLY collide with the cabin interior shells (floorpan/sills/roof/
//                  pillars) and the whole world; the car volumes that would fight the seated pose
//                  -- the solid NOSE/TAIL crush volumes (front legs/feet live inside the nose, rear
//                  torsos inside the tail; measured), the wheels, and the cardetail parts -- cleared
//                  those bits from their categories (OCCUPANT_TRANSPARENT_CATEGORY_BITS) and are
//                  permanently occupant-transparent. The damage PANELS + the GLASS PANES are
//                  ejected-only (EJECTED_ONLY_OCCUPANT_CATEGORY_BITS): a corpse rests ON the hood
//                  from outside and an ejectee punches THROUGH the windshield pane, but a seated
//                  torso never fights the hood's cowl edge, the door boxes' window band, or the
//                  pane band from inside (measured spikes -- see vehicle/tuning.ts's
//                  OCCUPANT_EJECTED_COLLIDABLE_BIT doc),
//   groupIndex   = OCCUPANT_GROUP_INDEX (-2): a shared negative group of occupants' OWN, preserving
//                  the no-self-collision + no-occupant-vs-occupant suppression the old shared car
//                  group provided, while car-vs-occupant pairs now fall through to category/mask.
// On ejection the mask swaps own-pan bit -> panel bit (a body flying across the cabin must not be
// arrested by a rigid-welded pan, but must land on the hood outside); the ejectee then punches the
// SOLID windshield pane -- a real contact whose hit event the damage system consumes (glassShattered
// + destroy the pane, system.ts) -- and exits through the genuinely open aperture. The seat pan
// keeps its neutral group + SEAT_PAN_CATEGORY_BIT-only category exactly as before.
//
// CHASSIS-ATTACHED-JOINT LIFECYCLE HAZARD: a full car repair (main.ts's doCarRepair()) destroys the
// OLD chassis body outright (vehicle.ts's destroyVehicle()) before this feature's reset() ever runs --
// per box3d/box2d-v3 convention (see src/ts/world.ts's World.destroy() doc comment for the same
// reasoning applied one level up), destroying a body natively destroys every joint still attached to
// it as a side effect. That means THIS feature's lap-restraint joint (chassis<->pelvis) and seat-pan
// weld joint (chassis<->seat pan) are ALREADY natively gone by the time reset() fires, even though
// their JS wrapper objects don't know it. Calling .destroy() on them again would touch already-freed
// native memory (exactly the hazard World.destroy() itself avoids via forgetHandle()) -- so
// teardownOccupant()/teardownSeatPan() below use forgetHandle() (registry bookkeeping only, no native
// call) for JUST those two chassis-attached joints, and ordinary .destroy() for everything else this
// feature owns outright (the 11 capsule bodies/shapes + 10 purely-internal ragdoll joints per
// occupant, which never touch the chassis and so are never invalidated by a car repair).

import {
	Body,
	BodyType,
	forgetHandle,
	RevoluteJoint,
	Shape,
	SphericalJoint,
	WeldJoint,
	World,
	type Quat,
} from '../../../../../src/ts/index.js';
import { add, length, multiplyQuat, rotateVector, sub, type Q4 as MQ4, type V3 } from '../../../vehicle/mathUtil';
import { FIXED_DT, GRAVITY_MAG, OCCUPANT_CATEGORY_BIT, OCCUPANT_COLLIDABLE_BIT, OCCUPANT_EJECTED_COLLIDABLE_BIT, OCCUPANT_ENTITY_ID_BASE } from '../../../vehicle/tuning';
import {
	ATTACH,
	BALL_SPRING_DAMPING,
	BALL_SPRING_HERTZ,
	EJECTED_FRICTION,
	EJECTION_KICK_NS,
	OCCUPANT_GROUP_INDEX,
	HINGE_LOWER_RAD,
	HINGE_SPRING_DAMPING,
	HINGE_SPRING_HERTZ,
	HINGE_UPPER_RAD,
	HIP_CONE_RAD,
	HIP_TWIST_RAD,
	MASS_FRACTION,
	NECK_CONE_RAD,
	NECK_TWIST_RAD,
	OCCUPANT_FRICTION,
	OCCUPANT_MASS_KG,
	OCCUPANT_RESTITUTION,
	OCCUPANT_ROLLING_RESISTANCE,
	PART_DIMS,
	PART_KEYS,
	REST_OFFSET,
	RESTRAINT_ARM_STEPS,
	RESTRAINT_BREACH_STEPS,
	RESTRAINT_CONE_RAD,
	RESTRAINT_ACCEL_WINDOW_POLLS,
	RESTRAINT_BREAK_MIN_CHASSIS_ACCEL_G,
	RESTRAINT_FORCE_THRESHOLD_N,
	RESTRAINT_TWIST_RAD,
	SEAT_KEYS,
	SEAT_LOCAL,
	SEAT_PAN_CATEGORY_BITS,
	SEAT_PAN_DROP_M,
	SEAT_PAN_FRICTION,
	SEAT_PAN_HALF_EXTENTS,
	SEAT_PAN_MASS_KG,
	SETTLE_DROP_M,
	SHOULDER_CONE_RAD,
	SHOULDER_TWIST_RAD,
	SPINE_CONE_RAD,
	SPINE_TWIST_RAD,
	baseOf,
	type PartKey,
	type SeatKey,
	type Side,
} from './tuning';

const IDENTITY_Q: MQ4 = { x: 0, y: 0, z: 0, w: 1 };
const ZERO: V3 = { x: 0, y: 0, z: 0 };
/** Maps local Z -> local X (a fixed +90deg rotation about Y) -- used as every hinge (elbow/knee)
 * joint's shared reference so its swing axis lands on the lateral axis regardless of which body's
 * REST_OFFSET it's composed against, see buildHingeFrames(). */
const HINGE_AXIS_ROTATION: MQ4 = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

function conjugate(q: MQ4): MQ4 {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Chassis-relative center of a child part, given its parent's ALREADY-COMPUTED chassis-relative
 * center + each body's own rest-rotation OFFSET + the local attach point on each side -- see this
 * module's doc comment. */
function childCenterFromParent(parentCenterLocal: V3, parentOffset: MQ4, parentAttachLocal: V3, childOffset: MQ4, childAttachLocal: V3): V3 {
	const attachChassisRel = add(parentCenterLocal, rotateVector(parentOffset, parentAttachLocal));
	return sub(attachChassisRel, rotateVector(childOffset, childAttachLocal));
}

function capsuleVolume(radius: number, halfLen: number): number {
	return Math.PI * radius * radius * (2 * halfLen) + (4 / 3) * Math.PI * radius ** 3;
}

/** Every part's REST-POSE chassis-relative center, rooted at the given (possibly settle-dropped)
 * chassis-relative seat/pelvis-root point -- see buildSpawnCentersLocal(). */
function buildCentersLocal(rootSeatLocal: V3): Record<PartKey, V3> {
	const pelvis = childCenterFromParent(rootSeatLocal, IDENTITY_Q, ZERO, REST_OFFSET.pelvis, ATTACH.pelvisRestraint);
	const torso = childCenterFromParent(pelvis, REST_OFFSET.pelvis, ATTACH.pelvisTop, REST_OFFSET.torso, ATTACH.torsoBottom);
	const head = childCenterFromParent(torso, REST_OFFSET.torso, ATTACH.torsoTop, REST_OFFSET.head, ATTACH.headBottom);
	const sideCenters = (side: Side) => {
		const upperArm = childCenterFromParent(torso, REST_OFFSET.torso, ATTACH.torsoShoulder(side), REST_OFFSET.upperArm, ATTACH.upperArmTop);
		const forearm = childCenterFromParent(upperArm, REST_OFFSET.upperArm, ATTACH.upperArmBottom, REST_OFFSET.forearm, ATTACH.forearmTop);
		const thigh = childCenterFromParent(pelvis, REST_OFFSET.pelvis, ATTACH.pelvisHip(side), REST_OFFSET.thigh, ATTACH.thighHip);
		const shin = childCenterFromParent(thigh, REST_OFFSET.thigh, ATTACH.thighKnee, REST_OFFSET.shin, ATTACH.shinKnee);
		return { upperArm, forearm, thigh, shin };
	};
	const L = sideCenters('L');
	const R = sideCenters('R');
	return {
		pelvis,
		torso,
		head,
		upperArmL: L.upperArm,
		upperArmR: R.upperArm,
		forearmL: L.forearm,
		forearmR: R.forearm,
		thighL: L.thigh,
		thighR: R.thigh,
		shinL: L.shin,
		shinR: R.shin,
	};
}

/** Rest centers, with the pelvis (and everything hanging off it) rooted SETTLE_DROP_M above the seat
 * point -- the ONLY joint this leaves un-coincident at spawn is the lap-restraint (chassis<->pelvis),
 * by design (see this module's SETTLE doc comment); buildCentersLocal() is linear in its root point
 * (pure vector addition/rotation-of-fixed-constants), so raising the root by SETTLE_DROP_M raises
 * every returned center by exactly the same amount, preserving every OTHER joint's zero-error rest
 * alignment. */
function buildSpawnCentersLocal(seatLocal: V3): Record<PartKey, V3> {
	return buildCentersLocal(add(seatLocal, { x: 0, y: SETTLE_DROP_M, z: 0 }));
}

export interface OccupantPartBody {
	body: Body;
	shape: Shape;
}

/** Named references to each articulated joint, so the active/muscle layer (./active.ts) can address a
 * specific joint (e.g. widen a hip's cone limit to let the leg straighten for a get-up) without relying
 * on positional indices into internalJoints. Same objects as internalJoints, just keyed. */
export interface OccupantJoints {
	spine: SphericalJoint; // pelvis <-> torso
	neck: SphericalJoint; // torso <-> head
	shoulderL: SphericalJoint;
	shoulderR: SphericalJoint;
	elbowL: RevoluteJoint;
	elbowR: RevoluteJoint;
	hipL: SphericalJoint;
	hipR: SphericalJoint;
	kneeL: RevoluteJoint;
	kneeR: RevoluteJoint;
}

export interface Occupant {
	seatKey: SeatKey;
	seatIndex: number;
	/** The chassis body this occupant is belted to -- read by pollOccupantRestraint()'s crash-gate
	 * (chassis deceleration). Only dereferenced while restraintJoint is non-null, which a car repair
	 * nulls (teardownOccupant) before the chassis body is ever stale. */
	chassis: Body;
	/** Ring of the chassis velocity at each of the last RESTRAINT_ACCEL_WINDOW_POLLS restraint polls
	 * -- pollOccupantRestraint()'s crash-gate memory: the gate reads the mean chassis acceleration
	 * across the whole window, which (a) still sees a yank-style crash whose one-step velocity jump
	 * precedes the belt-force peak by a few steps, and (b) is blind to one-step chassis jolts from an
	 * occupant limb's own contact spike (measured: a 30kN single-step limb arrest jerks the 1300kg
	 * chassis >2.5g for exactly one poll, but moves its velocity only ~0.4m/s -- a real crash moves
	 * it 8-19m/s). */
	chassisVelRing: V3[];
	parts: Record<PartKey, OccupantPartBody>;
	/** Internal ragdoll joints (spine/neck/2x shoulder/2x elbow/2x hip/2x knee = 10) -- never touch the
	 * chassis, always safe to .destroy() normally. */
	internalJoints: (SphericalJoint | RevoluteJoint)[];
	/** The same 10 internal joints, keyed by name (see OccupantJoints). */
	joints: OccupantJoints;
	/** Lap-restraint joint (chassis<->pelvis) -- null once broken (ejected) or forgotten (car repair). */
	restraintJoint: SphericalJoint | null;
	restraintThresholdN: number;
	/** Polls seen since creation -- ejection is DISARMED for the first RESTRAINT_ARM_STEPS so the
	 * spawn/reset settle-drop transient can never break the belt (see tuning.ts EJECTION GATING). */
	restraintPollCount: number;
	/** Consecutive polls with force above threshold -- ejection requires RESTRAINT_BREACH_STEPS in a
	 * row (a real crash sustains the force; a solver spike lasts one step). */
	restraintBreachRun: number;
	ejected: boolean;
}

export interface SeatPan {
	seatKey: SeatKey;
	body: Body;
	shape: Shape;
	/** null once forgotten across a car repair (see teardownSeatPan()). */
	weldJoint: WeldJoint | null;
}

function buildBallFrames(parentOffset: MQ4, childOffset: MQ4): { frameA: MQ4; frameB: MQ4 } {
	return { frameA: multiplyQuat(conjugate(parentOffset), childOffset), frameB: IDENTITY_Q };
}

function buildHingeFrames(parentOffset: MQ4, childOffset: MQ4): { frameA: MQ4; frameB: MQ4 } {
	return {
		frameA: multiplyQuat(conjugate(parentOffset), HINGE_AXIS_ROTATION),
		frameB: multiplyQuat(conjugate(childOffset), HINGE_AXIS_ROTATION),
	};
}

/** Entity-id tag for occupant N's (0-3) 11 parts, inside the registered occupant band
 * (vehicle/tuning.ts's OCCUPANT_ENTITY_ID_BASE..END) -- the damage system's central drain uses the
 * band to keep occupant-sourced interior hit events out of the crumple/weld models
 * (game/src/damage/system.ts), and glass-pane hits carry it as the striking side. */
function entityIdFor(seatIndex: number, partIndex: number): number {
	return OCCUPANT_ENTITY_ID_BASE + seatIndex * 100 + partIndex;
}

// PAN-SUPPORT NOTE: every part's SEATED mask includes the occupant's OWN seat-pan bit -- narrowing
// to pelvis/thighs (and then pelvis/thighs/shins) was TRIED and reverted: the seated rest pose
// genuinely leans limbs on the pan (rear shins prop on the bench edge, forearms rest near the lap),
// and removing those props left the arms in perpetual slow swing + the feet chattering on the world
// ground plane -- idle head/torso sway RMS (escalation-1's bar) went 0.02 -> 0.09-0.11 rad/s,
// measured per-part in sim/diag/stage2-idle-sway-probe.mjs. The wedge spikes that motivated the
// narrowing (a limb pinched between its own pan and the sill mid-flick) are defused at the EJECTION
// mechanism instead (pollOccupantRestraint()'s crash-gate: a wedge spike arrives under an
// ordinary-driving chassis and can no longer break the belt).

/** One occupant part capsule with the Stage-2 lifetime filter (module doc, COLLISION FILTERING):
 * `seated` only decides the mask's third bit -- the occupant's OWN seat pan while seated (other
 * seats' pans stay transparent, tuning.ts seat-pan doc), panels once ejected -- everything else is
 * identical seated vs ejected. */
function addCapsuleShape(body: Body, partKey: PartKey, friction: number, entityId: number, seatIndex: number, seated: boolean): Shape {
	const dims = PART_DIMS[baseOf(partKey)];
	const massKg = MASS_FRACTION[partKey] * OCCUPANT_MASS_KG;
	const density = massKg / capsuleVolume(dims.radius, dims.halfLen);
	return body.createCapsuleShape({
		center1: { x: 0, y: -dims.halfLen, z: 0 },
		center2: { x: 0, y: dims.halfLen, z: 0 },
		radius: dims.radius,
		density,
		friction,
		restitution: OCCUPANT_RESTITUTION,
		rollingResistance: OCCUPANT_ROLLING_RESISTANCE,
		categoryBits: OCCUPANT_CATEGORY_BIT,
		maskBits: seated
			? OCCUPANT_COLLIDABLE_BIT | SEAT_PAN_CATEGORY_BITS[seatIndex]
			: OCCUPANT_COLLIDABLE_BIT | OCCUPANT_EJECTED_COLLIDABLE_BIT,
		groupIndex: OCCUPANT_GROUP_INDEX,
		userData: entityId,
	});
}

function createCapsulePart(world: World, partKey: PartKey, center: V3, rotation: MQ4, entityId: number, seatIndex: number): OccupantPartBody {
	const body = world.createBody({
		type: BodyType.Dynamic,
		position: center,
		rotation: rotation as Quat,
		userData: entityId,
	});
	const shape = addCapsuleShape(body, partKey, OCCUPANT_FRICTION, entityId, seatIndex, true);
	return { body, shape };
}

/**
 * Builds one fully-jointed occupant, seated per SEAT_LOCAL[seatKey], welded (via its lap-restraint) to
 * `chassis`. `chassisPos`/`chassisRot` are the CURRENT chassis world transform (read once, at creation
 * time -- never cached across a car repair, per feature.ts's contract note #2).
 */
export function createOccupant(
	world: World,
	chassis: Body,
	seatIndex: number,
	seatKey: SeatKey,
	chassisPos: V3,
	chassisRot: MQ4,
): Occupant {
	const seatLocal = SEAT_LOCAL[seatKey];
	const centers = buildSpawnCentersLocal(seatLocal);

	const parts = {} as Record<PartKey, OccupantPartBody>;
	PART_KEYS.forEach((key, i) => {
		const base = baseOf(key);
		const worldRot = multiplyQuat(chassisRot, REST_OFFSET[base]);
		const worldPos = add(chassisPos, rotateVector(chassisRot, centers[key]));
		parts[key] = createCapsulePart(world, key, worldPos, worldRot, entityIdFor(seatIndex, i), seatIndex);
	});

	const internalJoints: (SphericalJoint | RevoluteJoint)[] = [];

	function ball(parentKey: PartKey, childKey: PartKey, parentAttach: V3, childAttach: V3, coneRad: number, twistRad: number): SphericalJoint {
		const { frameA, frameB } = buildBallFrames(REST_OFFSET[baseOf(parentKey)], REST_OFFSET[baseOf(childKey)]);
		const joint = world.createSphericalJoint(parts[parentKey].body, parts[childKey].body, {
			frameA: { position: parentAttach, rotation: frameA as Quat },
			frameB: { position: childAttach, rotation: frameB as Quat },
			collideConnected: false,
			enableSpring: true,
			hertz: BALL_SPRING_HERTZ,
			dampingRatio: BALL_SPRING_DAMPING,
			enableConeLimit: true,
			coneAngle: coneRad,
			enableTwistLimit: true,
			lowerTwistAngle: -twistRad,
			upperTwistAngle: twistRad,
		});
		internalJoints.push(joint);
		return joint;
	}

	function hinge(parentKey: PartKey, childKey: PartKey, parentAttach: V3, childAttach: V3): RevoluteJoint {
		const { frameA, frameB } = buildHingeFrames(REST_OFFSET[baseOf(parentKey)], REST_OFFSET[baseOf(childKey)]);
		const joint = world.createRevoluteJoint(parts[parentKey].body, parts[childKey].body, {
			frameA: { position: parentAttach, rotation: frameA as Quat },
			frameB: { position: childAttach, rotation: frameB as Quat },
			collideConnected: false,
			targetAngle: 0,
			enableSpring: true,
			hertz: HINGE_SPRING_HERTZ,
			dampingRatio: HINGE_SPRING_DAMPING,
			enableLimit: true,
			lowerAngle: HINGE_LOWER_RAD,
			upperAngle: HINGE_UPPER_RAD,
		});
		internalJoints.push(joint);
		return joint;
	}

	const spine = ball('pelvis', 'torso', ATTACH.pelvisTop, ATTACH.torsoBottom, SPINE_CONE_RAD, SPINE_TWIST_RAD);
	const neck = ball('torso', 'head', ATTACH.torsoTop, ATTACH.headBottom, NECK_CONE_RAD, NECK_TWIST_RAD);
	const shoulderL = ball('torso', 'upperArmL', ATTACH.torsoShoulder('L'), ATTACH.upperArmTop, SHOULDER_CONE_RAD, SHOULDER_TWIST_RAD);
	const elbowL = hinge('upperArmL', 'forearmL', ATTACH.upperArmBottom, ATTACH.forearmTop);
	const hipL = ball('pelvis', 'thighL', ATTACH.pelvisHip('L'), ATTACH.thighHip, HIP_CONE_RAD, HIP_TWIST_RAD);
	const kneeL = hinge('thighL', 'shinL', ATTACH.thighKnee, ATTACH.shinKnee);
	const shoulderR = ball('torso', 'upperArmR', ATTACH.torsoShoulder('R'), ATTACH.upperArmTop, SHOULDER_CONE_RAD, SHOULDER_TWIST_RAD);
	const elbowR = hinge('upperArmR', 'forearmR', ATTACH.upperArmBottom, ATTACH.forearmTop);
	const hipR = ball('pelvis', 'thighR', ATTACH.pelvisHip('R'), ATTACH.thighHip, HIP_CONE_RAD, HIP_TWIST_RAD);
	const kneeR = hinge('thighR', 'shinR', ATTACH.thighKnee, ATTACH.shinKnee);
	const joints: OccupantJoints = { spine, neck, shoulderL, shoulderR, elbowL, elbowR, hipL, hipR, kneeL, kneeR };

	// Lap-restraint: chassis (frameA, position = the seat's own chassis-local hip point) <-> pelvis
	// (frameB, position = ATTACH.pelvisRestraint). The chassis's own REST_OFFSET is IDENTITY (it's the
	// reference frame everything else is expressed relative to).
	const { frameA: rFrameA, frameB: rFrameB } = buildBallFrames(IDENTITY_Q, REST_OFFSET.pelvis);
	const restraintJoint = world.createSphericalJoint(chassis, parts.pelvis.body, {
		frameA: { position: seatLocal, rotation: rFrameA as Quat },
		frameB: { position: ATTACH.pelvisRestraint, rotation: rFrameB as Quat },
		collideConnected: false,
		enableSpring: true,
		hertz: BALL_SPRING_HERTZ,
		dampingRatio: BALL_SPRING_DAMPING,
		enableConeLimit: true,
		coneAngle: RESTRAINT_CONE_RAD,
		enableTwistLimit: true,
		lowerTwistAngle: -RESTRAINT_TWIST_RAD,
		upperTwistAngle: RESTRAINT_TWIST_RAD,
	});

	return {
		seatKey,
		seatIndex,
		chassis,
		chassisVelRing: [],
		parts,
		internalJoints,
		joints,
		restraintJoint,
		restraintThresholdN: RESTRAINT_FORCE_THRESHOLD_N[seatKey],
		restraintPollCount: 0,
		restraintBreachRun: 0,
		ejected: false,
	};
}

/** Polls the lap-restraint's constraint force (AFTER world.step(), matching game/src/damage/welds.ts's
 * own polled-force pattern -- avoids the joint-break-EVENT path's documented sleeping-joint gotcha
 * entirely). On threshold breach: ejectOccupant() below. Returns true the step ejection happens.
 *
 * EJECTION GATING (Tier-3 Stage-2 recalibration -- measured bands in tuning.ts's doc comments):
 *   (1) ARMED only after RESTRAINT_ARM_STEPS (spawn/reset settle transient can never eject);
 *   (2) CRASH-BREAK: force over threshold WHILE the CHASSIS itself is undergoing a crash-magnitude
 *       velocity change (mean acceleration across the RESTRAINT_ACCEL_WINDOW_POLLS-poll window >=
 *       RESTRAINT_BREAK_MIN_CHASSIS_ACCEL_G) -> break NOW. This is the real-crash path: an
 *       over-threshold belt force during a multi-g chassis deceleration is the body's own inertia
 *       loading the restraint (the exact question "would a real belt/seat-grip have held this?").
 *       Contact-era solver spikes (a limb catching the sill, the torso arrested by interior
 *       geometry mid-flick) reach 3x+ threshold for a single step -- force MAGNITUDE cannot
 *       separate the regimes (measured: driving artifacts 3.1-3.4x vs honest 70km/h crash loads
 *       1.9-2.1x, INVERTED) -- and such a 30kN one-step spike even jerks the 1300kg chassis itself
 *       past 2.5g for ONE poll, so the gate reads the MEAN acceleration over the window: a real
 *       crash moves the chassis 8-19m/s across it (6-11g mean), a limb spike ~0.4m/s (~0.2g). Same
 *       doctrine as the damage system's impact-gated wheel detach (game/src/damage/welds.ts).
 *   (3) SUSTAIN fallback (ungated): force over threshold RESTRAINT_BREACH_STEPS consecutive polls --
 *       covers slow-crush/pinned loads with no crash deceleration; driving spikes last 1-2 polls.
 * The chassis-velocity ring is updated EVERY poll -- a yank-style crash puts the whole velocity jump
 * on one step while the belt force peaks a few steps later as the spring loads, so the gate needs
 * this short memory, not an instantaneous read.
 */
export function pollOccupantRestraint(occupant: Occupant): boolean {
	if (!occupant.restraintJoint || occupant.ejected) return false;
	occupant.restraintPollCount++;
	// Crash-gate memory update (every poll, armed or not, so the gate is warm the moment arming ends).
	const cv = occupant.chassis.getLinearVelocity();
	occupant.chassisVelRing.push(cv);
	if (occupant.chassisVelRing.length > RESTRAINT_ACCEL_WINDOW_POLLS) occupant.chassisVelRing.shift();
	if (occupant.restraintPollCount <= RESTRAINT_ARM_STEPS) return false;
	const forceMag = length(occupant.restraintJoint.getConstraintForce());
	if (forceMag <= occupant.restraintThresholdN) {
		occupant.restraintBreachRun = 0;
		return false;
	}
	occupant.restraintBreachRun++;
	const ring = occupant.chassisVelRing;
	const oldest = ring[0];
	const windowAccelG =
		ring.length > 1
			? Math.hypot(cv.x - oldest.x, cv.y - oldest.y, cv.z - oldest.z) / ((ring.length - 1) * FIXED_DT) / GRAVITY_MAG
			: 0;
	const crashing = windowAccelG >= RESTRAINT_BREAK_MIN_CHASSIS_ACCEL_G;
	if (!crashing && occupant.restraintBreachRun < RESTRAINT_BREACH_STEPS) return false;

	ejectOccupant(occupant);
	return true;
}

/** The ejection state change itself (belt gone, ejected friction/filter swap, release kick), shared
 * by pollOccupantRestraint()'s force-breach path and scripted test scenarios that need a
 * deterministic ejected occupant without manufacturing a crash (e.g. the corpse-on-the-hood rest
 * test, game/sim/occupants-escalation.test.mjs). The friction/filter swap mirrors game/src/damage/
 * panels.ts's breakPanelWeld() shape-swap pattern (destroy the old shape with updateBodyMass=false,
 * create a same-geometry/mass replacement -- a capsule has no runtime friction setter, see Shape.ts);
 * EJECTED_FRICTION because the seated-grippy friction otherwise glues a freed occupant to the seat
 * pan (measured, tuning.ts). Idempotent. */
export function ejectOccupant(occupant: Occupant): void {
	if (occupant.ejected) return;
	if (occupant.restraintJoint) {
		occupant.restraintJoint.destroy();
		occupant.restraintJoint = null;
	}
	occupant.ejected = true;
	PART_KEYS.forEach((key, partIndex) => {
		const part = occupant.parts[key];
		const entityId = entityIdFor(occupant.seatIndex, partIndex);
		part.shape.destroy(false);
		part.shape = addCapsuleShape(part.body, key, EJECTED_FRICTION, entityId, occupant.seatIndex, false);
	});
	// EJECTION_KICK_NS release impulse -- see tuning.ts's doc comment.
	const pelvisBody = occupant.parts.pelvis.body;
	const v = pelvisBody.getLinearVelocity();
	const speed = length(v);
	if (speed > 0.1) {
		const dir = { x: v.x / speed, y: v.y / speed, z: v.z / speed };
		pelvisBody.applyLinearImpulseToCenter({ x: dir.x * EJECTION_KICK_NS, y: dir.y * EJECTION_KICK_NS, z: dir.z * EJECTION_KICK_NS });
	}
}

/**
 * DEATH: makes an occupant a pure limp ragdoll forever -- disables the restoring spring on every
 * internal ball/hinge joint so nothing pulls it back toward any pose (the active.ts muscle layer also
 * stops applying torque once dead). Idempotent. The joints THEMSELVES stay (the skeleton doesn't
 * fall apart -- cone/twist/hinge LIMITS still hold the body together); only their pose-restoring
 * springs go slack, which -- combined with muscles off -- is what "limp" means here. */
export function setOccupantLimp(occupant: Occupant): void {
	for (const joint of occupant.internalJoints) {
		if (joint instanceof SphericalJoint) joint.enableSpring(false);
		else joint.enableMotor(false);
	}
	// A killed BELTED occupant still hangs in the belt, but limp -- drop the (possibly braced-stiffened,
	// see active.ts) lap-restraint spring back to slack so the pelvis flops instead of being held upright.
	if (occupant.restraintJoint) occupant.restraintJoint.enableSpring(false);
}

// RETIRED (Tier-3 Stage 2): enableOccupantCarCollision() + EJECTED_MARKER_BIT are gone -- an ejected
// occupant's lifetime filter (module doc, COLLISION FILTERING) already collides with the interior
// shells/glass/panels/world from the moment the belt breaks, so there is no deferred "re-enable once
// clear of the hull AABB" moment (and no marker bit for the ground ray, which now masks out
// OCCUPANT_CATEGORY_BIT directly -- see active.ts's sampleGroundY()).

/** Sets every seated (non-ejected) part's linear velocity -- used by crash-test setup (headless sim +
 * browser verify hooks) to put the occupant "already riding along" at the chassis's velocity BEFORE a
 * wall impact, avoiding an artificial t=0 relative-velocity spike across the restraint (mirrors
 * game/src/damage/scenario.ts's crashSetup() doc comment, extended to occupants). Also SEEDS the
 * restraint crash-gate's chassis-velocity ring with the injected velocity (and clears any breach
 * run): "already riding along" means no crash has happened yet, so the teleport-style speed
 * injection must be invisible to the gate's windowed chassis-acceleration read (measured: an
 * unseeded ring saw the 0->19.4m/s injection as a 12g "crash" and, combined with the injection's own
 * 1-2 step belt transient, ejected the rears 20m before the wall) -- while everything AFTER the
 * injection (the wall impact, or a scripted yank to zero) still registers at full magnitude. */
export function matchOccupantVelocity(occupant: Occupant, velocity: V3): void {
	for (const key of PART_KEYS) {
		occupant.parts[key].body.setLinearVelocity(velocity);
		occupant.parts[key].body.setAngularVelocity({ x: 0, y: 0, z: 0 });
	}
	occupant.chassisVelRing.length = 0;
	for (let i = 0; i < RESTRAINT_ACCEL_WINDOW_POLLS; i++) occupant.chassisVelRing.push({ x: velocity.x, y: velocity.y, z: velocity.z });
	occupant.restraintBreachRun = 0;
}

/** Same as matchOccupantVelocity() but for a seat pan -- ALSO required for the same reason: a seat pan
 * is rigidly welded (hertz=0) to the chassis, so if a crash-test setup jumps the chassis's velocity
 * instantly without this, the weld has to yank the pan from ~0 to full speed in one substep, producing
 * a spurious force spike that (measured directly) bleeds into the seated occupant's restraint-force
 * reading on the very same step and falsely ejects it before any real impact occurs. */
export function matchSeatPanVelocity(pan: SeatPan, velocity: V3): void {
	pan.body.setLinearVelocity(velocity);
	pan.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
}

/**
 * Full teardown: destroys every internal joint + all 11 body/shapes normally, and the lap-restraint
 * joint via forgetHandle() ONLY (never .destroy() -- see this module's LIFECYCLE HAZARD doc comment)
 * since by the time this is called the chassis it was attached to is already gone.
 */
export function teardownOccupant(occupant: Occupant): void {
	if (occupant.restraintJoint) {
		forgetHandle(occupant.restraintJoint.handle, 'joint');
		occupant.restraintJoint = null;
	}
	for (const joint of occupant.internalJoints) joint.destroy();
	occupant.internalJoints.length = 0;
	for (const key of PART_KEYS) {
		const part = occupant.parts[key];
		part.shape.destroy(false);
		part.body.destroy();
	}
}

export function createSeatPan(world: World, chassis: Body, seatKey: SeatKey, chassisPos: V3, chassisRot: MQ4): SeatPan {
	const seatLocal = SEAT_LOCAL[seatKey];
	const localCenter: V3 = { x: seatLocal.x, y: seatLocal.y - SEAT_PAN_DROP_M, z: seatLocal.z };
	const worldPos = add(chassisPos, rotateVector(chassisRot, localCenter));
	const body = world.createBody({ type: BodyType.Dynamic, position: worldPos, rotation: chassisRot as Quat });
	const massKg = SEAT_PAN_MASS_KG;
	const volume = 8 * SEAT_PAN_HALF_EXTENTS.x * SEAT_PAN_HALF_EXTENTS.y * SEAT_PAN_HALF_EXTENTS.z;
	const shape = body.createBoxShape({
		halfExtents: SEAT_PAN_HALF_EXTENTS,
		density: massKg / volume,
		friction: SEAT_PAN_FRICTION,
		// Deliberately NEUTRAL (default, group 0) group, not CAR_GROUP_INDEX -- see this module's
		// COLLISION FILTERING doc comment: the seat pan needs to actually collide with the occupant
		// capsules resting on it. categoryBits reduced to THIS SEAT's dedicated pan bit so only the
		// occupant seated ON this pan collides with it -- EJECTED occupants (which drop all pan bits
		// from their mask) fly straight through pans instead of being lethally arrested by a
		// rigid-welded box mid-cabin, and OTHER seated occupants sliding across the cabin under
		// braking/cornering pass through it too instead of taking crash-magnitude arrest spikes --
		// see tuning.ts's seat-pan doc comment (everything else's default mask still includes the
		// bit, so ground/wall collisions are unchanged).
		categoryBits: SEAT_PAN_CATEGORY_BITS[SEAT_KEYS.indexOf(seatKey)],
	});
	const weldJoint = world.createWeldJoint(chassis, body, {
		frameA: { position: localCenter, rotation: { x: 0, y: 0, z: 0, w: 1 } },
		frameB: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
		collideConnected: false,
		linearHertz: 0,
		angularHertz: 0,
		linearDampingRatio: 1,
		angularDampingRatio: 1,
	});
	return { seatKey, body, shape, weldJoint };
}

/** See teardownOccupant()'s doc comment -- same forgetHandle()-for-the-chassis-joint,
 * destroy()-for-everything-else split. */
export function teardownSeatPan(pan: SeatPan): void {
	if (pan.weldJoint) {
		forgetHandle(pan.weldJoint.handle, 'joint');
		pan.weldJoint = null;
	}
	pan.shape.destroy(false);
	pan.body.destroy();
}
