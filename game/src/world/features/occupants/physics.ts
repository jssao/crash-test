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
// COLLISION FILTERING: seated occupant capsules use CAR_GROUP_INDEX (imported read-only from vehicle/
// tuning.ts, the SAME shared group every chassis/wheel/panel shape already uses) so they never fight
// the chassis hull, wheels, or damage panels (a same-negative-group pair never collides, box3d/box2d
// convention -- also suppresses occupant-vs-occupant self-collision, since every occupant shares this
// one group). The seat pan is left at the DEFAULT (neutral, groupIndex 0) filter instead: its own weld
// joint's default collideConnected:false already keeps it off the chassis specifically, and it's sized/
// placed well clear of the wheels/panels' bounding volumes (no shared joint needed there -- verified
// via the settle/stability sim test seeing no NaN/divergence). Because the seat pan's group (0) differs
// from the occupant's group (-1), they fall through to ordinary category/mask filtering (both default
// all-bits) and DO collide -- which is exactly what lets the pelvis rest on the seat via real contact.
// On ejection, the newly-free capsule's filter flips to the SAME neutral (groupIndex 0) filter
// breakPanelWeld() uses for a broken panel, "so it can now hit the car and the world".
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
	DEFAULT_CATEGORY_BITS,
	DEFAULT_MASK_BITS,
	forgetHandle,
	RevoluteJoint,
	Shape,
	SphericalJoint,
	WeldJoint,
	World,
	type Quat,
} from '../../../../../src/ts/index.js';
import { add, length, multiplyQuat, rotateVector, sub, type Q4 as MQ4, type V3 } from '../../../vehicle/mathUtil';
import { CAR_GROUP_INDEX } from '../../../vehicle/tuning';
import {
	ATTACH,
	BALL_SPRING_DAMPING,
	BALL_SPRING_HERTZ,
	EJECTED_FRICTION,
	EJECTION_KICK_NS,
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
	RESTRAINT_CONE_RAD,
	RESTRAINT_FORCE_THRESHOLD_N,
	RESTRAINT_TWIST_RAD,
	SEAT_LOCAL,
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
	parts: Record<PartKey, OccupantPartBody>;
	/** Internal ragdoll joints (spine/neck/2x shoulder/2x elbow/2x hip/2x knee = 10) -- never touch the
	 * chassis, always safe to .destroy() normally. */
	internalJoints: (SphericalJoint | RevoluteJoint)[];
	/** The same 10 internal joints, keyed by name (see OccupantJoints). */
	joints: OccupantJoints;
	/** Lap-restraint joint (chassis<->pelvis) -- null once broken (ejected) or forgotten (car repair). */
	restraintJoint: SphericalJoint | null;
	restraintThresholdN: number;
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

/** Base entity-id tag for occupant N's (0-3) 11 parts -- purely for debugging/telemetry; no shared
 * system currently consumes it (occupants don't feed the damage system: no enableHitEvents). */
function entityIdFor(seatIndex: number, partIndex: number): number {
	return 1000 + seatIndex * 100 + partIndex;
}

function addCapsuleShape(body: Body, partKey: PartKey, friction: number, entityId: number): Shape {
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
		groupIndex: CAR_GROUP_INDEX,
		userData: entityId,
	});
}

function createCapsulePart(world: World, partKey: PartKey, center: V3, rotation: MQ4, entityId: number): OccupantPartBody {
	const body = world.createBody({
		type: BodyType.Dynamic,
		position: center,
		rotation: rotation as Quat,
		userData: entityId,
	});
	const shape = addCapsuleShape(body, partKey, OCCUPANT_FRICTION, entityId);
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
		parts[key] = createCapsulePart(world, key, worldPos, worldRot, entityIdFor(seatIndex, i));
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
		parts,
		internalJoints,
		joints,
		restraintJoint,
		restraintThresholdN: RESTRAINT_FORCE_THRESHOLD_N[seatKey],
		ejected: false,
	};
}

/**
 * MEASURED FINDING (features-occupants.test.mjs's ejection test, first attempt): flipping an ejected
 * occupant to the SAME neutral (groupIndex 0) filter breakPanelWeld() uses for a broken panel -- i.e.
 * making it collide with the chassis hull -- backfires. The chassis's collision hull (vehicle.ts's
 * buildChassisHullPoints()) is one SOLID convex volume approximating the car's exterior shell; it has
 * no window/door cutout, and an occupant's rest pose sits INSIDE that volume. The instant the filter
 * flips, the solver finds the capsule deeply interpenetrating the hull and just presses it back against
 * the (nearest) hull surface -- the ejected body ends up pinned within ~1m of the chassis indefinitely
 * (measured directly: pelvis-to-chassis separation barely changed over 3s of a 70km/h wall crash),
 * instead of flying clear. So this deliberately does NOT re-enable hull/wheel/panel collision on
 * ejection (an ejected occupant stays excluded from those, same CAR_GROUP_INDEX as while seated --
 * effectively "flies out through" the invisible collision hull, a stylized simplification consistent
 * with the windshield glass being a separate, purely-visual deformable mesh anyway) -- it keeps flying
 * clear via inertia once freed from the restraint, which is what the ejection test actually measures.
 * shape.setFilter() is still exercised (the task's explicit ask) via a harmless MARKER bit cleared from
 * categoryBits (maskBits/groupIndex unchanged, so no collision outcome changes) -- readable back via
 * Shape.getFilter() to identify "this occupant part has been ejected" from outside this module.
 */
const EJECTED_MARKER_BIT = 1n << 3n;

/** Polls the lap-restraint's constraint force (AFTER world.step(), matching game/src/damage/welds.ts's
 * own polled-force pattern -- avoids the joint-break-EVENT path's documented sleeping-joint gotcha
 * entirely). On threshold breach: destroys the restraint joint, marks every one of this occupant's 11
 * shapes ejected (see EJECTED_MARKER_BIT's doc comment for why this does NOT re-enable chassis/wheel/
 * panel collision), and swaps each shape to EJECTED_FRICTION (see tuning.ts's doc comment: measured
 * directly that the seated-grippy friction otherwise glues a freed occupant to the seat pan instead of
 * letting it separate). Shape swap mirrors game/src/damage/panels.ts's breakPanelWeld() (destroy the
 * old shape with updateBodyMass=false, create a same-geometry/mass replacement, since a capsule shape
 * has no runtime friction setter -- see Shape.ts). Returns true the step ejection actually happens. */
export function pollOccupantRestraint(occupant: Occupant): boolean {
	if (!occupant.restraintJoint || occupant.ejected) return false;
	const forceMag = length(occupant.restraintJoint.getConstraintForce());
	if (forceMag <= occupant.restraintThresholdN) return false;

	occupant.restraintJoint.destroy();
	occupant.restraintJoint = null;
	occupant.ejected = true;
	PART_KEYS.forEach((key, partIndex) => {
		const part = occupant.parts[key];
		const entityId = entityIdFor(occupant.seatIndex, partIndex);
		part.shape.destroy(false);
		part.shape = addCapsuleShape(part.body, key, EJECTED_FRICTION, entityId);
		part.shape.setFilter(
			{ categoryBits: DEFAULT_CATEGORY_BITS & ~EJECTED_MARKER_BIT, maskBits: DEFAULT_MASK_BITS, groupIndex: CAR_GROUP_INDEX },
			false,
		);
	});
	// EJECTION_KICK_NS release impulse -- see tuning.ts's doc comment.
	const pelvisBody = occupant.parts.pelvis.body;
	const v = pelvisBody.getLinearVelocity();
	const speed = length(v);
	if (speed > 0.1) {
		const dir = { x: v.x / speed, y: v.y / speed, z: v.z / speed };
		pelvisBody.applyLinearImpulseToCenter({ x: dir.x * EJECTION_KICK_NS, y: dir.y * EJECTION_KICK_NS, z: dir.z * EJECTION_KICK_NS });
	}
	return true;
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

/**
 * Re-enables occupant<->car collision on an already-ejected occupant by flipping every part's shape
 * from CAR_GROUP_INDEX (-1, never collides with any car body) back to the neutral group 0 (falls
 * through to ordinary category/mask filtering, so it DOES collide with the chassis hull / wheels /
 * panels again). Keeps the EJECTED_MARKER_BIT cleared so "this part is ejected" stays externally
 * readable. CALLER CONTRACT (active.ts): only ever call this once the occupant's whole body has
 * cleared the chassis hull AABB + margin -- flipping it while any part is still INSIDE the convex hull
 * is the explosive-depenetration hazard this feature is built to avoid (see the EJECTED_MARKER_BIT doc
 * comment). Idempotent-safe to call, but active.ts latches it to fire once. */
export function enableOccupantCarCollision(occupant: Occupant): void {
	for (const key of PART_KEYS) {
		occupant.parts[key].shape.setFilter(
			{ categoryBits: DEFAULT_CATEGORY_BITS & ~EJECTED_MARKER_BIT, maskBits: DEFAULT_MASK_BITS, groupIndex: 0 },
			false,
		);
	}
}

/** Sets every seated (non-ejected) part's linear velocity -- used by crash-test setup (headless sim +
 * browser verify hooks) to put the occupant "already riding along" at the chassis's velocity BEFORE a
 * wall impact, avoiding an artificial t=0 relative-velocity spike across the restraint (mirrors
 * game/src/damage/scenario.ts's crashSetup() doc comment, extended to occupants). */
export function matchOccupantVelocity(occupant: Occupant, velocity: V3): void {
	for (const key of PART_KEYS) {
		occupant.parts[key].body.setLinearVelocity(velocity);
		occupant.parts[key].body.setAngularVelocity({ x: 0, y: 0, z: 0 });
	}
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
		// Deliberately NEUTRAL (default) filter, not CAR_GROUP_INDEX -- see this module's COLLISION
		// FILTERING doc comment: the seat pan needs to actually collide with the (CAR_GROUP_INDEX)
		// occupant capsules resting on it.
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
