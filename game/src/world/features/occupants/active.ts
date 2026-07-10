// SPDX-License-Identifier: MIT
//
// ACTIVE-OCCUPANT layer: the "muscle", life/death, and self-preservation-FSM behaviour that turns the
// passive ragdolls (./physics.ts) into occupants that BRACE against g-forces, get KILLED by lethal
// impacts, and (if they survive) get up and flee the wreck. Renderer-free (no `three`), same convention
// as physics.ts -- so both the browser feature (./index.ts) and the headless sim test
// (game/sim/occupants-active.test.mjs) drive the exact same code. Driven once per fixed step, AFTER
// world.step(), via updateOccupantActive().
//
// HONEST-PHYSICS DISCLOSURE (also surfaced in the return-to-user):
//   * SEATED bracing is SOLVER-SPRING bracing with gain scheduling (rebuilt after the user playtest
//     found the original per-step PD muscles oscillating at 60Hz -- measured 24 rad/s head RMS at
//     IDLE, see tuning.ts's MUSCLE DISCRETE-TIME STABILITY note): while alive+seated, the ball
//     joints' own solver-integrated springs (SphericalJoint hertz/dampingRatio -- unconditionally
//     stable) hold the seated pose, staying at the passive hertz while the chassis is calm (occupant
//     VISUALLY STILL, zero active torque) and ramping up under measured chassis g-load (the visible
//     "brace"). The crash drama gradient is real: solver springs are soft constraints a violent
//     angular impulse overwhelms, and a real crash's sustained belt force still snaps the restraint.
//   * The ejected-FSM poses (tumble flail / settle / get-up / walk) run the PD MUSCLE layer: each
//     powered joint's corrective torque is HARD-CLAMPED to a human-plausible N*m ceiling (tuning.ts
//     MUSCLE_*), applied as a momentum-conserving equal-and-opposite Body.applyTorque pair, with
//     effective gains capped per body at the 60Hz discrete-stability bounds and a small deadband
//     (so a settled joint applies exactly zero torque instead of chattering against the clamp).
//   * The post-crash GET-UP + FLEE-WALK ride on a DOCUMENTED STABILIZATION ASSIST: an 11-capsule
//     ragdoll cannot balance/stand/walk from joint motors alone without a full balance controller
//     (foot-placement / ZMP / ground-reaction loop) that is out of scope. So RECOVER/FLEE/SAFE
//     KINEMATICALLY drive the CORE COLUMN (pelvis + torso + head) toward a standing pose via
//     velocity-level control (Body.setLinearVelocity/setAngularVelocity each step, capped), while the
//     muscle PD poses the arms & legs. Velocity-level control is used (not a stiff force/torque servo)
//     because the light pelvis body oscillates to the solver's ~45 rad/s rotation clamp under stiff
//     torque; and the WHOLE column is driven (not just the pelvis) because the ~55kg hanging body drags
//     a pelvis-only puppet back down. This is the legs' ground-reaction + the balance loop, substituted
//     by an honest puppet -- NOT emergent balance. Labelled `assist` throughout; NEVER runs while
//     seated, dead, or tumbling.
//   * Seated CORE bracing is not a muscle torque at all: it stiffens the lap-belt SPRING (solver-
//     integrated, stable on the light pelvis) while alive+seated, and drops it slack on death. See
//     tuning.ts RESTRAINT_BRACE_HERTZ.
//
// The MUSCLE PD is computed entirely in WORLD space: for a joint (parent body P, child body C) with a
// desired child-relative-to-parent orientation qRel, the desired child world orientation is
// qC_desired = qP * qRel; the world error rotation is qErr = qC_desired * conj(qC); its shortest-arc
// axis*angle vector `rv` is the proportional term. torque = Kp*rv - Kd*(wC - wP), clamped, applied +to
// C / -to P. (For the revolute knee/elbow the off-hinge-axis component of that torque is simply absorbed
// by the joint constraint, so the same routine straightens them -- no separate hinge math needed.)

import { DEFAULT_MASK_BITS, type Body, type World } from '../../../../../src/ts/index.js';
import { OCCUPANT_CATEGORY_BIT } from '../../../vehicle/tuning';
import {
	add,
	clamp,
	cross,
	length,
	multiplyQuat,
	normalize,
	quatFromAxisAngle,
	scale,
	sub,
	type Q4 as MQ4,
	type V3,
} from '../../../vehicle/mathUtil';
import { setOccupantLimp, type Occupant } from './physics';
import {
	BALL_SPRING_HERTZ,
	BRACE_ATTACK_TAU_S,
	BRACE_G_HI,
	BRACE_G_LO,
	BRACE_G_SMOOTH_TAU_S,
	BRACE_RELEASE_TAU_S,
	DEATH_PEAK_ACCEL_G,
	FLEE_ARRIVED_M,
	FLEE_DISTANCE_M,
	FSM_RECOVER_SECONDS,
	FSM_SETTLE_SECONDS,
	FSM_TUMBLE_MIN_SECONDS,
	GRAVITY_G_UNIT,
	GROUND_RAY_DOWN_M,
	GROUND_RAY_UP_M,
	MUSCLE_DEADBAND_RAD,
	MUSCLE_DEADBAND_RAD_S,
	MUSCLE_HIP,
	MUSCLE_KD_STABLE_FRACTION,
	MUSCLE_KP_STABLE_FRACTION,
	MUSCLE_NECK,
	MUSCLE_SHOULDER,
	MUSCLE_SPINE,
	MUSCLE_TUMBLING_SCALE,
	partTransverseInertia,
	RECOVER_BLOCKED_MAX_STEPS,
	RECOVER_BLOCKED_PELVIS_Y_M,
	RECOVER_BLOCKED_RAMP_FRACTION,
	RECOVER_CROUCH_PELVIS_Y_M,
	REST_OFFSET,
	RESTRAINT_BRACE_DAMPING,
	RESTRAINT_BRACE_HERTZ,
	SEATED_BRACE_HERTZ,
	SEAT_PAN_ALL_CATEGORY_BITS,
	SETTLE_ANGULAR_SPEED_RAD_S,
	SETTLE_LINEAR_SPEED_MS,
	STABILIZE_ANG_GAIN,
	STABILIZE_LIN_GAIN,
	STABILIZE_MAX_ANG_SPEED_RAD_S,
	STABILIZE_MAX_LIN_SPEED_MS,
	STABILIZE_STAND_PELVIS_Y_M,
	STABILIZE_STEP_AMPLITUDE_RAD,
	STABILIZE_STEP_HZ,
	STABILIZE_WALK_SPEED_MS,
	type MuscleGains,
} from './tuning';

const WORLD_UP: V3 = { x: 0, y: 1, z: 0 };
const IDENTITY_Q: MQ4 = { x: 0, y: 0, z: 0, w: 1 };
/** Widened hip cone (radians) applied on RECOVER entry so the seated 90-degree hip bend can straighten
 * into a standing pose -- the as-built HIP_CONE_RAD (seated) is far too tight to reach vertical legs. */
const RECOVER_HIP_CONE_RAD = 1.9;
/**
 * Fraction of a muscle's corrective torque applied back onto the PARENT body as the equal-and-opposite
 * reaction. A muscle physically pulls both bones it spans, so 1.0 is the momentum-conserving ideal --
 * but in this chain the parent of the root muscles (spine, hips) is the pelvis, which is only lightly
 * anchored (the restraint spring seated / the pelvis servo standing), so a full reaction from several
 * muscles at once destabilizes the very body they hang off (measured: full reaction made a braced torso
 * deviate ~2x MORE than a limp one under hard braking). Applying a REDUCED reaction keeps most of the
 * momentum-conserving behaviour while treating the anchored parent chain as a partial reference frame --
 * a standard active-ragdoll stabilization. 0 = pure child-drive (parent treated as a fixed anchor). */
const MUSCLE_REACTION_FRACTION = 1.0;

// Per-part approximate transverse inertias (kg*m^2), feeding the discrete-stability gain caps in
// applyMuscle() -- see tuning.ts's MUSCLE DISCRETE-TIME STABILITY doc comment. Each muscle pair is
// capped by the SMALLER of its two bodies' inertias (the reaction torque hits the parent too, and the
// lighter side is the one an over-tuned gain destabilizes -- measured: the head, I~0.02, diverged to a
// 24 rad/s limit cycle under the raw kd=9 neck damping at 60Hz).
const I_PELVIS = partTransverseInertia('pelvis');
const I_TORSO = partTransverseInertia('torso');
const I_HEAD = partTransverseInertia('head');
const I_UPPER_ARM = partTransverseInertia('upperArmL');
const I_THIGH = partTransverseInertia('thighL');
const I_SHIN = partTransverseInertia('shinL');
const PAIR_SPINE = Math.min(I_PELVIS, I_TORSO);
const PAIR_NECK = Math.min(I_TORSO, I_HEAD);
const PAIR_SHOULDER = Math.min(I_TORSO, I_UPPER_ARM);
const PAIR_HIP = Math.min(I_PELVIS, I_THIGH);
const PAIR_KNEE = Math.min(I_THIGH, I_SHIN);

function conj(q: MQ4): MQ4 {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function negate(v: V3): V3 {
	return { x: -v.x, y: -v.y, z: -v.z };
}

/** Shortest-arc axis*angle (rotation vector, world space) of a quaternion. */
function quatToRotationVector(q: MQ4): V3 {
	let { x, y, z, w } = q;
	if (w < 0) {
		x = -x;
		y = -y;
		z = -z;
		w = -w;
	}
	const vlen = Math.hypot(x, y, z);
	if (vlen < 1e-8) return { x: 0, y: 0, z: 0 };
	const angle = 2 * Math.atan2(vlen, w);
	const s = angle / vlen;
	return { x: x * s, y: y * s, z: z * s };
}

function clampMagnitude(v: V3, maxMag: number): V3 {
	const m = length(v);
	if (m <= maxMag || m < 1e-9) return v;
	return scale(v, maxMag / m);
}

/** Rotation quaternion whose local +Y maps to `up` and local +Z maps to `forward` (matching the body
 * axis convention: +Y up, +Z forward, +X = left). Used for the pelvis uprighting target. */
function quatFromForwardUp(forward: V3, up: V3): MQ4 {
	const f = normalize(forward);
	let r = cross(up, f); // local +X (car left)
	if (length(r) < 1e-6) r = { x: 1, y: 0, z: 0 };
	r = normalize(r);
	const u = cross(f, r); // re-orthonormalized local +Y
	// Rotation matrix columns (images of basis axes): cx=r, cy=u, cz=f. Convert to quaternion.
	const m00 = r.x, m10 = r.y, m20 = r.z;
	const m01 = u.x, m11 = u.y, m21 = u.z;
	const m02 = f.x, m12 = f.y, m22 = f.z;
	const trace = m00 + m11 + m22;
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		return { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
	}
	if (m00 > m11 && m00 > m22) {
		const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
		return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
	}
	if (m11 > m22) {
		const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
		return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
	}
	const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
	return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
}

// -- Muscle target relative poses (child relative to parent), constant per state ------------------
// Seated targets reproduce the as-built rest pose: qRel_rest = conj(parentOffset) * childOffset. Since
// every REST_OFFSET except thigh is identity, the only non-identity seated target is the hip (the baked
// seated 90-degree hip bend). Standing targets straighten the legs (thigh & shin point DOWN).
const SEATED_HIP_REL = multiplyQuat(conj(REST_OFFSET.pelvis), REST_OFFSET.thigh); // = REST_OFFSET.thigh
const STANDING_HIP_REL = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI); // thigh local +Y -> down
const STRAIGHT_REL = IDENTITY_Q; // knee: shin parallel to thigh (straight leg); spine/neck/shoulder upright
/** Protective tumbling arm raise (upper-arm swung forward/up toward the head). */
const TUMBLE_SHOULDER_REL = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, 1.25);

export type FsmState = 'seated' | 'tumbling' | 'settled' | 'recover' | 'flee' | 'safe' | 'dead';

export interface OccupantRuntime {
	timeSec: number;
	alive: boolean;
	state: FsmState;
	/** Peak head/torso linear acceleration seen so far, in g (9.81 m/s^2 units). */
	peakAccelG: number;
	/** Previous-step linear velocities for the accel estimate (head + torso drive life/death). */
	prevHeadVel: V3 | null;
	prevTorsoVel: V3 | null;
	// FSM bookkeeping
	tumbleStartSec: number;
	settledStartSec: number;
	recoverStartSec: number;
	hipConeWidened: boolean;
	// Seated solver-spring bracing (gain-scheduled on measured chassis g -- see tuning.ts SEATED_BRACE_*)
	/** Smoothed chassis g-load estimate (EMA of |dv|/dt in g). */
	gLoadSmoothed: number;
	/** Current brace level 0 (relaxed, passive springs) .. 1 (fully braced). */
	braceLevel: number;
	/** Brace level last actually written to the joint springs (-1 = never; setters are only called on
	 * a material change, so converged occupants make zero native calls and can go to sleep). */
	appliedBraceLevel: number;
	/** Previous-step chassis velocity for the g-load estimate (null after external velocity sets). */
	prevChassisVel: V3 | null;
	// Ground-relative recovery (see tuning.ts GROUND-RELATIVE RECOVERY)
	/** Latest measured ground height under the pelvis (world Y), null until first successful ray. */
	groundY: number | null;
	/** Consecutive RECOVER steps with the pelvis failing to follow the stand ramp (blocked). */
	recoverBlockedSteps: number;
	/** Latched once a stand attempt was abandoned -- the occupant stays down for good. */
	recoverGiveUp: boolean;
	/** Flee target (world, horizontal), captured on RECOVER entry. */
	fleeTarget: V3 | null;
	/** Pelvis XZ frozen at RECOVER start (rise-in-place), and the moving "carrot" target for FLEE. */
	standAnchor: V3 | null;
}

export function createOccupantRuntime(): OccupantRuntime {
	return {
		timeSec: 0,
		alive: true,
		state: 'seated',
		peakAccelG: 0,
		prevHeadVel: null,
		prevTorsoVel: null,
		tumbleStartSec: 0,
		settledStartSec: 0,
		recoverStartSec: 0,
		hipConeWidened: false,
		gLoadSmoothed: 0,
		braceLevel: 0,
		appliedBraceLevel: -1,
		prevChassisVel: null,
		groundY: null,
		recoverBlockedSteps: 0,
		recoverGiveUp: false,
		fleeTarget: null,
		standAnchor: null,
	};
}

/** Re-baselines the accel estimator (call right after any EXTERNAL velocity set -- crashSetup /
 * matchOccupantVelocity -- so the artificial one-step velocity jump isn't read as a lethal impact). */
export function resetOccupantAccelBaseline(occupant: Occupant, runtime: OccupantRuntime): void {
	runtime.prevHeadVel = occupant.parts.head.body.getLinearVelocity();
	runtime.prevTorsoVel = occupant.parts.torso.body.getLinearVelocity();
	// Also re-baseline the chassis g-load estimator (same reason: an external velocity jump is not a
	// real acceleration, and must neither kill the occupant nor spike the brace scheduler).
	runtime.prevChassisVel = null;
}

export interface ActiveStepContext {
	chassisPos: V3;
	chassisRot: MQ4;
	chassisVel: V3;
	/** Physics world, for the ground raycast under recovering occupants. Optional for backward
	 * compatibility: without it, ground is assumed at world y=0 (the pre-terrain flat-plane model). */
	world?: World;
}

/** One PD "muscle": momentum-conserving torque pair driving child body toward `targetRel` (its desired
 * orientation relative to the parent body), clamped to the muscle's N*m ceiling. `scaleFactor` lets a
 * state (e.g. tumbling) run at reduced strength. `pairInertia` (min of the two bodies' transverse
 * inertias) caps the EFFECTIVE gains at the 60Hz discrete-stability bounds (kd <= f*I/dt diverges the
 * light head/arms otherwise -- see tuning.ts), and a small deadband keeps a joint AT its target from
 * chattering against the torque clamp (drive-to-zero instead of oscillate-around-zero). */
function applyMuscle(parent: Body, child: Body, targetRel: MQ4, gains: MuscleGains, scaleFactor: number, pairInertia: number, dt: number): void {
	const qP = parent.getRotation();
	const qC = child.getRotation();
	const qDesired = multiplyQuat(qP, targetRel);
	const qErr = multiplyQuat(qDesired, conj(qC));
	const rv = quatToRotationVector(qErr);
	const wRel = sub(child.getAngularVelocity(), parent.getAngularVelocity());
	if (length(rv) < MUSCLE_DEADBAND_RAD && length(wRel) < MUSCLE_DEADBAND_RAD_S) return;
	const kp = Math.min(gains.kp, (MUSCLE_KP_STABLE_FRACTION * pairInertia) / (dt * dt));
	const kd = Math.min(gains.kd, (MUSCLE_KD_STABLE_FRACTION * pairInertia) / dt);
	let torque = sub(scale(rv, kp), scale(wRel, kd));
	torque = clampMagnitude(torque, gains.maxTorqueNm * scaleFactor);
	child.applyTorque(torque);
	parent.applyTorque(scale(torque, -MUSCLE_REACTION_FRACTION));
}

/** Applies the whole upper-body brace/hold at a given strength scale, with a swappable hip target
 * (seated bend vs standing straighten) and optional knee straighten. Shared by seated bracing, settled,
 * recover, flee and safe -- only the targets/scale differ. */
function applyBodyPose(
	occupant: Occupant,
	scaleFactor: number,
	dt: number,
	opts: { shoulderRel: MQ4; hipRel: MQ4; straightenKnees: boolean; stepPhase?: number },
): void {
	const p = occupant.parts;
	applyMuscle(p.pelvis.body, p.torso.body, STRAIGHT_REL, MUSCLE_SPINE, scaleFactor, PAIR_SPINE, dt);
	applyMuscle(p.torso.body, p.head.body, STRAIGHT_REL, MUSCLE_NECK, scaleFactor, PAIR_NECK, dt);
	applyMuscle(p.torso.body, p.upperArmL.body, opts.shoulderRel, MUSCLE_SHOULDER, scaleFactor, PAIR_SHOULDER, dt);
	applyMuscle(p.torso.body, p.upperArmR.body, opts.shoulderRel, MUSCLE_SHOULDER, scaleFactor, PAIR_SHOULDER, dt);
	// Stepping gait: a small alternating fore/aft hip pitch layered on the base hip target during FLEE.
	const stepL = opts.stepPhase !== undefined ? quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.sin(opts.stepPhase) * STABILIZE_STEP_AMPLITUDE_RAD) : IDENTITY_Q;
	const stepR = opts.stepPhase !== undefined ? quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.sin(opts.stepPhase + Math.PI) * STABILIZE_STEP_AMPLITUDE_RAD) : IDENTITY_Q;
	applyMuscle(p.pelvis.body, p.thighL.body, multiplyQuat(opts.hipRel, stepL), MUSCLE_HIP, scaleFactor, PAIR_HIP, dt);
	applyMuscle(p.pelvis.body, p.thighR.body, multiplyQuat(opts.hipRel, stepR), MUSCLE_HIP, scaleFactor, PAIR_HIP, dt);
	if (opts.straightenKnees) {
		applyMuscle(p.thighL.body, p.shinL.body, STRAIGHT_REL, MUSCLE_HIP, 0.4 * scaleFactor, PAIR_KNEE, dt);
		applyMuscle(p.thighR.body, p.shinR.body, STRAIGHT_REL, MUSCLE_HIP, 0.4 * scaleFactor, PAIR_KNEE, dt);
	}
}

/** SEATED solver-spring brace at `level` (0 = passive BALL_SPRING_HERTZ, 1 = fully braced): writes
 * the scheduled hertz onto the six powered ball joints (spine/neck/shoulders/hips) and the lap-belt.
 * Solver-integrated springs are unconditionally stable at 60Hz on the light bodies -- the entire
 * reason seated bracing moved here from explicit per-step PD torques (user-visible jitter fix).
 * Callers only invoke on a material level change, so a calm occupant makes zero native calls. */
function applySeatedBraceSprings(occupant: Occupant, level: number): void {
	const hertz = BALL_SPRING_HERTZ + (SEATED_BRACE_HERTZ - BALL_SPRING_HERTZ) * level;
	const j = occupant.joints;
	for (const joint of [j.spine, j.neck, j.shoulderL, j.shoulderR, j.hipL, j.hipR]) {
		joint.setSpringHertz(hertz);
	}
	if (occupant.restraintJoint) {
		occupant.restraintJoint.setSpringHertz(BALL_SPRING_HERTZ + (RESTRAINT_BRACE_HERTZ - BALL_SPRING_HERTZ) * level);
		occupant.restraintJoint.setSpringDampingRatio(RESTRAINT_BRACE_DAMPING);
	}
}

/** TUMBLING protective tone: neck + shoulders ONLY (parent = torso), so no reaction torque hits the
 * light pelvis to spin it on the low-friction ground and block "settled". Arms swing toward the head. */
function applyTumblePose(occupant: Occupant, scaleFactor: number, dt: number): void {
	const p = occupant.parts;
	applyMuscle(p.torso.body, p.head.body, STRAIGHT_REL, MUSCLE_NECK, scaleFactor, PAIR_NECK, dt);
	applyMuscle(p.torso.body, p.upperArmL.body, TUMBLE_SHOULDER_REL, MUSCLE_SHOULDER, scaleFactor, PAIR_SHOULDER, dt);
	applyMuscle(p.torso.body, p.upperArmR.body, TUMBLE_SHOULDER_REL, MUSCLE_SHOULDER, scaleFactor, PAIR_SHOULDER, dt);
}

/** Standing-column vertical offsets (chassis-agnostic): pelvis center -> torso center is pelvisTop(0.05)
 * + torsoBottom(0.16); torso -> head is torsoTop(0.16) + headBottom(0.02). So above a pelvis at height
 * h the standing torso sits at h+0.21 and the head at h+0.39. */
const STAND_TORSO_RISE_M = 0.21;
const STAND_HEAD_RISE_M = 0.39;

/** VELOCITY-LEVEL (kinematic) drive of one body toward `targetPos` (capped speed) + an upright
 * orientation facing `faceDir` (capped rate). Unconditionally stable (no stiff force/torque on a light
 * body). */
function driveBodyKinematic(body: Body, targetPos: V3, faceDir: V3): void {
	const desiredVel = clampMagnitude(scale(sub(targetPos, body.getPosition()), STABILIZE_LIN_GAIN), STABILIZE_MAX_LIN_SPEED_MS);
	body.setLinearVelocity(desiredVel);
	const targetQ = quatFromForwardUp(faceDir, WORLD_UP);
	const rv = quatToRotationVector(multiplyQuat(targetQ, conj(body.getRotation())));
	const desiredAngVel = clampMagnitude(scale(rv, STABILIZE_ANG_GAIN), STABILIZE_MAX_ANG_SPEED_RAD_S);
	body.setAngularVelocity(desiredAngVel);
}

/**
 * DOCUMENTED STABILIZATION ASSIST (see module doc). Kinematically drives the CORE COLUMN -- pelvis +
 * torso + head -- toward a standing pose stacked above `pelvisTargetPos`, facing `faceDir`, via
 * velocity-level control. Puppeting only the pelvis cannot lift the ~55kg ragdoll against gravity
 * through the joints (the hanging body weight drags the pelvis back down); driving the whole spine
 * column reliably stands it up, while the arms & legs follow from the muscle PD + gravity. This is the
 * balance/ground-reaction SUBSTITUTE -- an honest puppet, NOT emergent balance -- and it is the reason
 * this feature can promise a get-up at all. Never runs while seated, dead, or tumbling. */
function applyCoreColumnAssist(occupant: Occupant, pelvisTargetPos: V3, faceDir: V3): void {
	driveBodyKinematic(occupant.parts.pelvis.body, pelvisTargetPos, faceDir);
	driveBodyKinematic(occupant.parts.torso.body, add(pelvisTargetPos, { x: 0, y: STAND_TORSO_RISE_M, z: 0 }), faceDir);
	driveBodyKinematic(occupant.parts.head.body, add(pelvisTargetPos, { x: 0, y: STAND_HEAD_RISE_M, z: 0 }), faceDir);
}

// -- Life/death ------------------------------------------------------------------------------------

function updateLifeDeath(occupant: Occupant, runtime: OccupantRuntime, dt: number): void {
	const headVel = occupant.parts.head.body.getLinearVelocity();
	const torsoVel = occupant.parts.torso.body.getLinearVelocity();
	if (runtime.prevHeadVel && runtime.prevTorsoVel && dt > 0) {
		const headAccelG = length(sub(headVel, runtime.prevHeadVel)) / dt / GRAVITY_G_UNIT;
		const torsoAccelG = length(sub(torsoVel, runtime.prevTorsoVel)) / dt / GRAVITY_G_UNIT;
		const peak = Math.max(headAccelG, torsoAccelG);
		if (peak > runtime.peakAccelG) runtime.peakAccelG = peak;
		if (peak > DEATH_PEAK_ACCEL_G && runtime.alive) {
			runtime.alive = false;
			runtime.state = 'dead';
			setOccupantLimp(occupant); // motors off + springs off -> pure limp ragdoll forever
		}
	}
	runtime.prevHeadVel = headVel;
	runtime.prevTorsoVel = torsoVel;
}

// RETIRED (Tier-3 Stage 2, the FILTER PATH): detectGlassCrossing() (trajectory-plane glass hack)
// and tryEnableCarCollision() (hull-AABB-exit filter flip) are gone. Glass shatter is literal
// contact physics against the SOLID pane shapes (vehicle.ts GLASS_ENTITY_ID), consumed by the damage
// system's central hit drain (system.ts); and an ejected occupant's lifetime filter already collides
// with the car's interior/glass/panels/world from the first step (physics.ts, COLLISION FILTERING),
// so there is no deferred re-enable moment to detect.

// -- FSM (ejected + alive) -------------------------------------------------------------------------

function pelvisState(occupant: Occupant): { pos: V3; speed: number; angSpeed: number } {
	const b = occupant.parts.pelvis.body;
	return { pos: b.getPosition(), speed: length(b.getLinearVelocity()), angSpeed: length(b.getAngularVelocity()) };
}

/** Measures the ground height under the occupant's pelvis (world Y) via a straight-down raycast,
 * caching it in runtime.groundY. The ray masks OUT the occupant category (all ragdoll capsules --
 * this occupant's AND every other one's -- carry only OCCUPANT_CATEGORY_BIT) plus the seat pans, so
 * it can only hit the actual world (terrain/props/car), never the ragdoll lying in its own path.
 * Without a world in ctx (legacy callers) falls back to the pre-terrain flat-plane assumption
 * (ground = y 0). */
function sampleGroundY(occupant: Occupant, runtime: OccupantRuntime, ctx: ActiveStepContext): void {
	if (!ctx.world) {
		runtime.groundY = runtime.groundY ?? 0;
		return;
	}
	const p = occupant.parts.pelvis.body.getPosition();
	const hit = ctx.world.castRayClosest(
		{ x: p.x, y: p.y + GROUND_RAY_UP_M, z: p.z },
		{ x: 0, y: -(GROUND_RAY_UP_M + GROUND_RAY_DOWN_M), z: 0 },
		// Everything except occupant capsules (their only category bit) and the cabin seat pans --
		// the same effective target set the retired EJECTED_MARKER_BIT mask hit: the world, terrain,
		// props, and the car itself, never a ragdoll lying in the ray's path.
		{ maskBits: DEFAULT_MASK_BITS & ~(OCCUPANT_CATEGORY_BIT | SEAT_PAN_ALL_CATEGORY_BITS) },
	);
	if (hit.hit) runtime.groundY = hit.point.y;
	// miss: keep the last measurement (null if never measured -> the FSM prefers staying down).
}

function updateEjectedFsm(occupant: Occupant, runtime: OccupantRuntime, dt: number, ctx: ActiveStepContext): void {
	const ps = pelvisState(occupant);
	sampleGroundY(occupant, runtime, ctx);
	const groundY = runtime.groundY;

	switch (runtime.state) {
		case 'tumbling': {
			// Low-tone protective flail: arms swing toward the head, head held from lolling -- reduced
			// strength (the crash overwhelmed the brace). Deliberately ONLY neck + shoulders (parent =
			// torso): applying hip/spine muscle here dumps reaction torque into the light pelvis and spins
			// it on the low-friction ground forever, which would block "settled" from ever latching.
			applyTumblePose(occupant, MUSCLE_TUMBLING_SCALE, dt);
			const airtime = runtime.timeSec - runtime.tumbleStartSec;
			// Height gate is RELATIVE TO MEASURED GROUND (user defect: absolute y<0.7 never latched --
			// or latched mid-air -- once the terrain wave moved the ground off y=0).
			const nearGround = groundY !== null && ps.pos.y - groundY < 0.7;
			const settled = airtime > FSM_TUMBLE_MIN_SECONDS && nearGround && ps.speed < SETTLE_LINEAR_SPEED_MS && ps.angSpeed < SETTLE_ANGULAR_SPEED_RAD_S;
			if (settled) {
				runtime.state = 'settled';
				runtime.settledStartSec = runtime.timeSec;
			}
			break;
		}
		case 'settled': {
			// Lie still and gather -- minimal tone. If a previous stand attempt was abandoned (blocked /
			// no measurable ground), stay down for good: visibly wrong beats subtly fake.
			applyBodyPose(occupant, 0.4, dt, { shoulderRel: STRAIGHT_REL, hipRel: SEATED_HIP_REL, straightenKnees: false });
			if (runtime.recoverGiveUp) break;
			if (runtime.timeSec - runtime.settledStartSec > FSM_SETTLE_SECONDS && groundY !== null) {
				// Enter RECOVER: widen hips so legs can straighten, capture flee direction + stand anchor.
				if (!runtime.hipConeWidened) {
					occupant.joints.hipL.setConeLimit(RECOVER_HIP_CONE_RAD);
					occupant.joints.hipR.setConeLimit(RECOVER_HIP_CONE_RAD);
					runtime.hipConeWidened = true;
				}
				const away = fleeDirection(ps.pos, ctx);
				runtime.fleeTarget = { x: ctx.chassisPos.x + away.x * FLEE_DISTANCE_M, y: 0, z: ctx.chassisPos.z + away.z * FLEE_DISTANCE_M };
				runtime.standAnchor = { x: ps.pos.x, y: 0, z: ps.pos.z };
				runtime.recoverStartSec = runtime.timeSec;
				runtime.recoverBlockedSteps = 0;
				runtime.state = 'recover';
			}
			break;
		}
		case 'recover': {
			// Get up IN PLACE: ramp pelvis height from a grounded crouch to standing over the recover
			// window -- both heights ABOVE THE MEASURED GROUND under the occupant (user defect: the old
			// absolute-Y ramp held a hovering half-crouch wherever terrain height differed from 0).
			const g = groundY ?? 0;
			const t = clamp((runtime.timeSec - runtime.recoverStartSec) / FSM_RECOVER_SECONDS, 0, 1);
			const targetY = g + RECOVER_CROUCH_PELVIS_Y_M + (STABILIZE_STAND_PELVIS_Y_M - RECOVER_CROUCH_PELVIS_Y_M) * t;
			const anchor = runtime.standAnchor!;
			const faceDir = fleeDirection(ps.pos, ctx);
			applyCoreColumnAssist(occupant, { x: anchor.x, y: targetY, z: anchor.z }, faceDir);
			applyBodyPose(occupant, 1, dt, { shoulderRel: STRAIGHT_REL, hipRel: STANDING_HIP_REL, straightenKnees: true });
			// Blocked-stand detection: late in the ramp the pelvis should genuinely be rising off the
			// ground; if something (wreckage, a tree, a ditch lip) keeps it pinned, give up and stay
			// down instead of grinding the servo against the obstruction forever.
			if (t > RECOVER_BLOCKED_RAMP_FRACTION && ps.pos.y - g < RECOVER_BLOCKED_PELVIS_Y_M) runtime.recoverBlockedSteps++;
			else runtime.recoverBlockedSteps = 0;
			if (runtime.recoverBlockedSteps >= RECOVER_BLOCKED_MAX_STEPS) {
				runtime.recoverGiveUp = true;
				runtime.state = 'settled';
				runtime.settledStartSec = runtime.timeSec;
				break;
			}
			if (t >= 1) runtime.state = 'flee';
			break;
		}
		case 'flee': {
			// Stumble-walk toward the flee point at a capped speed (moving-carrot pelvis target), pelvis
			// held at standing height above the ground measured under it each step (walks real slopes).
			const target = runtime.fleeTarget!;
			const anchor = runtime.standAnchor!;
			const toTarget = { x: target.x - anchor.x, y: 0, z: target.z - anchor.z };
			const distToTarget = length(toTarget);
			if (distToTarget > 1e-3) {
				const stepDist = Math.min(STABILIZE_WALK_SPEED_MS * dt, distToTarget);
				const dir = scale(toTarget, 1 / distToTarget);
				anchor.x += dir.x * stepDist;
				anchor.z += dir.z * stepDist;
			}
			const faceDir = normalize({ x: target.x - ps.pos.x, y: 0, z: target.z - ps.pos.z });
			applyCoreColumnAssist(occupant, { x: anchor.x, y: (groundY ?? 0) + STABILIZE_STAND_PELVIS_Y_M, z: anchor.z }, length(faceDir) > 1e-3 ? faceDir : { x: 0, y: 0, z: 1 });
			applyBodyPose(occupant, 1, dt, { shoulderRel: STRAIGHT_REL, hipRel: STANDING_HIP_REL, straightenKnees: true, stepPhase: runtime.timeSec * STABILIZE_STEP_HZ * 2 * Math.PI });
			const distFromCar = Math.hypot(ps.pos.x - ctx.chassisPos.x, ps.pos.z - ctx.chassisPos.z);
			if (distFromCar >= FLEE_ARRIVED_M) runtime.state = 'safe';
			break;
		}
		case 'safe': {
			// Idle stand at the arrival spot; occasionally glance back at the wreck (deterministic sine).
			const anchor = runtime.standAnchor!;
			const toCar = normalize({ x: ctx.chassisPos.x - ps.pos.x, y: 0, z: ctx.chassisPos.z - ps.pos.z });
			applyCoreColumnAssist(occupant, { x: anchor.x, y: (groundY ?? 0) + STABILIZE_STAND_PELVIS_Y_M, z: anchor.z }, length(toCar) > 1e-3 ? toCar : { x: 0, y: 0, z: 1 });
			const glance = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.3 * Math.sin(runtime.timeSec * 0.6));
			applyBodyPose(occupant, 1, dt, { shoulderRel: STRAIGHT_REL, hipRel: STANDING_HIP_REL, straightenKnees: true });
			applyMuscle(occupant.parts.torso.body, occupant.parts.head.body, glance, MUSCLE_NECK, 1, PAIR_NECK, dt);
			break;
		}
		default:
			break;
	}
}

/** Horizontal unit direction the occupant flees: AWAY FROM THE WRECK (from car to the occupant's
 * current position -- the direction they were flung), falling back to opposite the car's velocity
 * vector, then to a default. Documented interpretation of the spec's "away from its velocity vector":
 * either way the occupant moves away from the car, never back into it. */
function fleeDirection(occupantPos: V3, ctx: ActiveStepContext): V3 {
	const fromCar = { x: occupantPos.x - ctx.chassisPos.x, y: 0, z: occupantPos.z - ctx.chassisPos.z };
	if (length(fromCar) > 0.5) return normalize(fromCar);
	const vel = { x: ctx.chassisVel.x, y: 0, z: ctx.chassisVel.z };
	if (length(vel) > 0.5) return normalize(negate(vel));
	return { x: 0, y: 0, z: 1 };
}

/**
 * Drives one occupant's active behaviour for a single fixed step (call AFTER world.step()). Glass
 * shatter is no longer surfaced here -- an ejecting body physically strikes the solid pane shapes and
 * the damage system's central drain consumes those hits (system.ts) -- so this returns nothing.
 */
export function updateOccupantActive(occupant: Occupant, runtime: OccupantRuntime, dt: number, ctx: ActiveStepContext): void {
	runtime.timeSec += dt;

	updateLifeDeath(occupant, runtime, dt);
	// Dead = pure limp ragdoll: no muscle, no FSM -- and (Stage 2) no bookkeeping either: a corpse's
	// capsules already carry the honest lifetime filter, so they shatter glass by contact and rest ON
	// the wreck (hood/roof/panels) with no phase-out possible by construction.
	if (!runtime.alive) return;

	if (!occupant.ejected) {
		// SEATED + ALIVE: solver-spring bracing, gain-scheduled on the measured chassis g-load (see
		// tuning.ts SEATED_BRACE_*). Calm chassis -> passive springs, occupant VISUALLY STILL (the
		// original per-step PD muscles oscillated at 60Hz -- the user-reported constant jitter). Real
		// g (hard braking/cornering/impact) -> ball-joint + lap-belt springs ramp stiff: the brace.
		runtime.state = 'seated';
		let gLoad = 0;
		if (runtime.prevChassisVel && dt > 0) gLoad = length(sub(ctx.chassisVel, runtime.prevChassisVel)) / dt / GRAVITY_G_UNIT;
		runtime.prevChassisVel = ctx.chassisVel;
		runtime.gLoadSmoothed += (gLoad - runtime.gLoadSmoothed) * Math.min(1, dt / BRACE_G_SMOOTH_TAU_S);
		const braceTarget = clamp((runtime.gLoadSmoothed - BRACE_G_LO) / (BRACE_G_HI - BRACE_G_LO), 0, 1);
		// Fast attack (a startle is quick), slow release (no brace flicker over rough ground).
		const tau = braceTarget > runtime.braceLevel ? BRACE_ATTACK_TAU_S : BRACE_RELEASE_TAU_S;
		runtime.braceLevel += (braceTarget - runtime.braceLevel) * Math.min(1, dt / tau);
		if (Math.abs(runtime.braceLevel - runtime.appliedBraceLevel) > 0.01) {
			runtime.appliedBraceLevel = runtime.braceLevel;
			applySeatedBraceSprings(occupant, runtime.braceLevel);
		}
		return;
	}

	// EJECTED + ALIVE: enter the self-preservation FSM on the first ejected step.
	if (runtime.state === 'seated') {
		runtime.state = 'tumbling';
		runtime.tumbleStartSec = runtime.timeSec;
		// Drop any brace stiffness back to the passive spring values: a freed tumbling body must
		// flail on the passive ragdoll springs, not stay rigidly pulled toward the seated pose.
		applySeatedBraceSprings(occupant, 0);
		runtime.appliedBraceLevel = 0;
		runtime.braceLevel = 0;
	}
	updateEjectedFsm(occupant, runtime, dt, ctx);
}
