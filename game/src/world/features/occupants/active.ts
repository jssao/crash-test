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
//   * MUSCLE bracing (seated), the LIFE/DEATH model, and the MUSCLE-OVERWHELM gradient are all REAL,
//     torque-limited physics: each powered joint runs a PD controller whose corrective torque is
//     HARD-CLAMPED to a human-plausible N*m ceiling (tuning.ts MUSCLE_*), applied as a momentum-
//     conserving equal-and-opposite Body.applyTorque pair. Ordinary g's stay inside the budget (brace);
//     a crash's angular impulse blows past it (limp flail). Nothing fakes this.
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

import type { Body } from '../../../../../src/ts/index.js';
import {
	add,
	clamp,
	cross,
	length,
	multiplyQuat,
	normalize,
	quatFromAxisAngle,
	rotateVector,
	scale,
	sub,
	type Q4 as MQ4,
	type V3,
} from '../../../vehicle/mathUtil';
import { enableOccupantCarCollision, setOccupantLimp, type Occupant } from './physics';
import {
	DEATH_PEAK_ACCEL_G,
	FLEE_ARRIVED_M,
	FLEE_DISTANCE_M,
	FSM_RECOVER_SECONDS,
	FSM_SETTLE_SECONDS,
	FSM_TUMBLE_MIN_SECONDS,
	GLASS_NODE_DOOR_LEFT,
	GLASS_NODE_DOOR_RIGHT,
	GLASS_NODE_REAR,
	GLASS_NODE_WINDSHIELD,
	GLASS_REAR_Z_M,
	GLASS_SIDE_X_M,
	GLASS_WINDSHIELD_Z_M,
	GLASS_Y_MAX_M,
	GLASS_Y_MIN_M,
	GRAVITY_G_UNIT,
	HULL_AABB_CLEAR_MARGIN_M,
	HULL_AABB_HALF_X_M,
	HULL_AABB_HALF_Z_M,
	HULL_AABB_Y_MAX_M,
	HULL_AABB_Y_MIN_M,
	MUSCLE_HIP,
	MUSCLE_NECK,
	MUSCLE_SHOULDER,
	MUSCLE_SPINE,
	MUSCLE_TUMBLING_SCALE,
	PART_DIMS,
	PART_KEYS,
	REST_OFFSET,
	RESTRAINT_BRACE_DAMPING,
	RESTRAINT_BRACE_HERTZ,
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
	baseOf,
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
	carCollisionEnabled: boolean;
	/** Flee target (world, horizontal), captured on RECOVER entry. */
	fleeTarget: V3 | null;
	/** Pelvis XZ frozen at RECOVER start (rise-in-place), and the moving "carrot" target for FLEE. */
	standAnchor: V3 | null;
	// Glass shatter surfacing (drained by index.ts into the damage emitter; read directly by the test)
	shatteredGlass: Set<string>;
	newlyShatteredGlass: string[];
	/** Previous-step chassis-local head/torso Z & X, for outward glass-plane crossing detection. */
	prevLocalHead: V3 | null;
	prevLocalTorso: V3 | null;
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
		carCollisionEnabled: false,
		fleeTarget: null,
		standAnchor: null,
		shatteredGlass: new Set(),
		newlyShatteredGlass: [],
		prevLocalHead: null,
		prevLocalTorso: null,
	};
}

/** Re-baselines the accel estimator (call right after any EXTERNAL velocity set -- crashSetup /
 * matchOccupantVelocity -- so the artificial one-step velocity jump isn't read as a lethal impact). */
export function resetOccupantAccelBaseline(occupant: Occupant, runtime: OccupantRuntime): void {
	runtime.prevHeadVel = occupant.parts.head.body.getLinearVelocity();
	runtime.prevTorsoVel = occupant.parts.torso.body.getLinearVelocity();
}

export interface ActiveStepContext {
	chassisPos: V3;
	chassisRot: MQ4;
	chassisVel: V3;
}

/** World -> chassis-local point (inverse of chassisPos + rotate(chassisRot, .)). */
function toChassisLocal(p: V3, ctx: ActiveStepContext): V3 {
	return rotateVector(conj(ctx.chassisRot), sub(p, ctx.chassisPos));
}

/** One PD "muscle": momentum-conserving torque pair driving child body toward `targetRel` (its desired
 * orientation relative to the parent body), clamped to the muscle's N*m ceiling. `scaleFactor` lets a
 * state (e.g. tumbling) run at reduced strength. */
function applyMuscle(parent: Body, child: Body, targetRel: MQ4, gains: MuscleGains, scaleFactor: number): void {
	const qP = parent.getRotation();
	const qC = child.getRotation();
	const qDesired = multiplyQuat(qP, targetRel);
	const qErr = multiplyQuat(qDesired, conj(qC));
	const rv = quatToRotationVector(qErr);
	const wRel = sub(child.getAngularVelocity(), parent.getAngularVelocity());
	let torque = sub(scale(rv, gains.kp), scale(wRel, gains.kd));
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
	opts: { shoulderRel: MQ4; hipRel: MQ4; straightenKnees: boolean; stepPhase?: number },
): void {
	const p = occupant.parts;
	applyMuscle(p.pelvis.body, p.torso.body, STRAIGHT_REL, MUSCLE_SPINE, scaleFactor);
	applyMuscle(p.torso.body, p.head.body, STRAIGHT_REL, MUSCLE_NECK, scaleFactor);
	applyMuscle(p.torso.body, p.upperArmL.body, opts.shoulderRel, MUSCLE_SHOULDER, scaleFactor);
	applyMuscle(p.torso.body, p.upperArmR.body, opts.shoulderRel, MUSCLE_SHOULDER, scaleFactor);
	// Stepping gait: a small alternating fore/aft hip pitch layered on the base hip target during FLEE.
	const stepL = opts.stepPhase !== undefined ? quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.sin(opts.stepPhase) * STABILIZE_STEP_AMPLITUDE_RAD) : IDENTITY_Q;
	const stepR = opts.stepPhase !== undefined ? quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.sin(opts.stepPhase + Math.PI) * STABILIZE_STEP_AMPLITUDE_RAD) : IDENTITY_Q;
	applyMuscle(p.pelvis.body, p.thighL.body, multiplyQuat(opts.hipRel, stepL), MUSCLE_HIP, scaleFactor);
	applyMuscle(p.pelvis.body, p.thighR.body, multiplyQuat(opts.hipRel, stepR), MUSCLE_HIP, scaleFactor);
	if (opts.straightenKnees) {
		applyMuscle(p.thighL.body, p.shinL.body, STRAIGHT_REL, MUSCLE_HIP, 0.4 * scaleFactor);
		applyMuscle(p.thighR.body, p.shinR.body, STRAIGHT_REL, MUSCLE_HIP, 0.4 * scaleFactor);
	}
}

/** TUMBLING protective tone: neck + shoulders ONLY (parent = torso), so no reaction torque hits the
 * light pelvis to spin it on the low-friction ground and block "settled". Arms swing toward the head. */
function applyTumblePose(occupant: Occupant, scaleFactor: number): void {
	const p = occupant.parts;
	applyMuscle(p.torso.body, p.head.body, STRAIGHT_REL, MUSCLE_NECK, scaleFactor);
	applyMuscle(p.torso.body, p.upperArmL.body, TUMBLE_SHOULDER_REL, MUSCLE_SHOULDER, scaleFactor);
	applyMuscle(p.torso.body, p.upperArmR.body, TUMBLE_SHOULDER_REL, MUSCLE_SHOULDER, scaleFactor);
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

// -- Glass-plane crossing detection ----------------------------------------------------------------

function detectGlassCrossing(occupant: Occupant, runtime: OccupantRuntime, ctx: ActiveStepContext): void {
	const localHead = toChassisLocal(occupant.parts.head.body.getPosition(), ctx);
	const localTorso = toChassisLocal(occupant.parts.torso.body.getPosition(), ctx);
	const prevH = runtime.prevLocalHead;
	const prevT = runtime.prevLocalTorso;
	runtime.prevLocalHead = localHead;
	runtime.prevLocalTorso = localTorso;
	if (!prevH || !prevT) return;

	const fire = (node: string): void => {
		if (runtime.shatteredGlass.has(node)) return;
		runtime.shatteredGlass.add(node);
		runtime.newlyShatteredGlass.push(node);
	};
	const inYBand = (p: V3) => p.y >= GLASS_Y_MIN_M && p.y <= GLASS_Y_MAX_M;
	// Check head + torso; a crossing by either fires the window once.
	for (const [prev, now] of [
		[prevH, localHead],
		[prevT, localTorso],
	] as const) {
		if (!inYBand(now)) continue;
		// Windshield: crossed +Z outward.
		if (prev.z < GLASS_WINDSHIELD_Z_M && now.z >= GLASS_WINDSHIELD_Z_M) fire(GLASS_NODE_WINDSHIELD);
		// Rear window: crossed -Z outward.
		if (prev.z > GLASS_REAR_Z_M && now.z <= GLASS_REAR_Z_M) fire(GLASS_NODE_REAR);
		// Side windows: crossed |x| outward (+X = car left).
		if (prev.x < GLASS_SIDE_X_M && now.x >= GLASS_SIDE_X_M) fire(GLASS_NODE_DOOR_LEFT);
		if (prev.x > -GLASS_SIDE_X_M && now.x <= -GLASS_SIDE_X_M) fire(GLASS_NODE_DOOR_RIGHT);
	}
}

// -- Car-collision re-enable (only once the whole body clears the chassis hull AABB + margin) -------

function tryEnableCarCollision(occupant: Occupant, runtime: OccupantRuntime, ctx: ActiveStepContext): void {
	if (runtime.carCollisionEnabled) return;
	// Occupant AABB in chassis-local space (part centers +/- radius), vs the inflated hull AABB.
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
	for (const key of PART_KEYS) {
		const lp = toChassisLocal(occupant.parts[key].body.getPosition(), ctx);
		const r = PART_DIMS[baseOf(key)].radius;
		minX = Math.min(minX, lp.x - r); maxX = Math.max(maxX, lp.x + r);
		minY = Math.min(minY, lp.y - r); maxY = Math.max(maxY, lp.y + r);
		minZ = Math.min(minZ, lp.z - r); maxZ = Math.max(maxZ, lp.z + r);
	}
	const m = HULL_AABB_CLEAR_MARGIN_M;
	const separated =
		maxX < -HULL_AABB_HALF_X_M - m || minX > HULL_AABB_HALF_X_M + m ||
		maxZ < -HULL_AABB_HALF_Z_M - m || minZ > HULL_AABB_HALF_Z_M + m ||
		maxY < HULL_AABB_Y_MIN_M - m || minY > HULL_AABB_Y_MAX_M + m;
	if (separated) {
		enableOccupantCarCollision(occupant);
		runtime.carCollisionEnabled = true;
	}
}

// -- FSM (ejected + alive) -------------------------------------------------------------------------

function pelvisState(occupant: Occupant): { pos: V3; speed: number; angSpeed: number } {
	const b = occupant.parts.pelvis.body;
	return { pos: b.getPosition(), speed: length(b.getLinearVelocity()), angSpeed: length(b.getAngularVelocity()) };
}

function updateEjectedFsm(occupant: Occupant, runtime: OccupantRuntime, ctx: ActiveStepContext): void {
	const ps = pelvisState(occupant);

	switch (runtime.state) {
		case 'tumbling': {
			// Low-tone protective flail: arms swing toward the head, head held from lolling -- reduced
			// strength (the crash overwhelmed the brace). Deliberately ONLY neck + shoulders (parent =
			// torso): applying hip/spine muscle here dumps reaction torque into the light pelvis and spins
			// it on the low-friction ground forever, which would block "settled" from ever latching.
			applyTumblePose(occupant, MUSCLE_TUMBLING_SCALE);
			const airtime = runtime.timeSec - runtime.tumbleStartSec;
			const settled = airtime > FSM_TUMBLE_MIN_SECONDS && ps.pos.y < 0.7 && ps.speed < SETTLE_LINEAR_SPEED_MS && ps.angSpeed < SETTLE_ANGULAR_SPEED_RAD_S;
			if (settled) {
				runtime.state = 'settled';
				runtime.settledStartSec = runtime.timeSec;
			}
			break;
		}
		case 'settled': {
			// Lie still and gather -- minimal tone.
			applyBodyPose(occupant, 0.4, { shoulderRel: STRAIGHT_REL, hipRel: SEATED_HIP_REL, straightenKnees: false });
			if (runtime.timeSec - runtime.settledStartSec > FSM_SETTLE_SECONDS) {
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
				runtime.state = 'recover';
			}
			break;
		}
		case 'recover': {
			// Get up IN PLACE: ramp pelvis height to standing over the recover window, full-body PD to
			// a standing pose (assist doc: pelvis servo is the balance/ground-reaction substitute).
			const t = clamp((runtime.timeSec - runtime.recoverStartSec) / FSM_RECOVER_SECONDS, 0, 1);
			const targetY = 0.2 + (STABILIZE_STAND_PELVIS_Y_M - 0.2) * t;
			const anchor = runtime.standAnchor!;
			const faceDir = fleeDirection(ps.pos, ctx);
			applyCoreColumnAssist(occupant, { x: anchor.x, y: targetY, z: anchor.z }, faceDir);
			applyBodyPose(occupant, 1, { shoulderRel: STRAIGHT_REL, hipRel: STANDING_HIP_REL, straightenKnees: true });
			if (t >= 1) runtime.state = 'flee';
			break;
		}
		case 'flee': {
			// Stumble-walk toward the flee point at a capped speed (moving-carrot pelvis target).
			const target = runtime.fleeTarget!;
			const anchor = runtime.standAnchor!;
			const toTarget = { x: target.x - anchor.x, y: 0, z: target.z - anchor.z };
			const distToTarget = length(toTarget);
			if (distToTarget > 1e-3) {
				const stepDist = Math.min(STABILIZE_WALK_SPEED_MS * (1 / 60), distToTarget);
				const dir = scale(toTarget, 1 / distToTarget);
				anchor.x += dir.x * stepDist;
				anchor.z += dir.z * stepDist;
			}
			const faceDir = normalize({ x: target.x - ps.pos.x, y: 0, z: target.z - ps.pos.z });
			applyCoreColumnAssist(occupant, { x: anchor.x, y: STABILIZE_STAND_PELVIS_Y_M, z: anchor.z }, length(faceDir) > 1e-3 ? faceDir : { x: 0, y: 0, z: 1 });
			applyBodyPose(occupant, 1, { shoulderRel: STRAIGHT_REL, hipRel: STANDING_HIP_REL, straightenKnees: true, stepPhase: runtime.timeSec * STABILIZE_STEP_HZ * 2 * Math.PI });
			const distFromCar = Math.hypot(ps.pos.x - ctx.chassisPos.x, ps.pos.z - ctx.chassisPos.z);
			if (distFromCar >= FLEE_ARRIVED_M) runtime.state = 'safe';
			break;
		}
		case 'safe': {
			// Idle stand at the arrival spot; occasionally glance back at the wreck (deterministic sine).
			const anchor = runtime.standAnchor!;
			const toCar = normalize({ x: ctx.chassisPos.x - ps.pos.x, y: 0, z: ctx.chassisPos.z - ps.pos.z });
			applyCoreColumnAssist(occupant, { x: anchor.x, y: STABILIZE_STAND_PELVIS_Y_M, z: anchor.z }, length(toCar) > 1e-3 ? toCar : { x: 0, y: 0, z: 1 });
			const glance = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.3 * Math.sin(runtime.timeSec * 0.6));
			applyBodyPose(occupant, 1, { shoulderRel: STRAIGHT_REL, hipRel: STANDING_HIP_REL, straightenKnees: true });
			applyMuscle(occupant.parts.torso.body, occupant.parts.head.body, glance, MUSCLE_NECK, 1);
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
 * Drives one occupant's active behaviour for a single fixed step (call AFTER world.step()). Returns the
 * list of glass nodes that newly shattered THIS step (index.ts forwards them to the damage emitter).
 */
export function updateOccupantActive(occupant: Occupant, runtime: OccupantRuntime, dt: number, ctx: ActiveStepContext): string[] {
	runtime.timeSec += dt;
	runtime.newlyShatteredGlass.length = 0;

	updateLifeDeath(occupant, runtime, dt);
	if (!runtime.alive) return runtime.newlyShatteredGlass; // dead = pure limp ragdoll, nothing more

	if (!occupant.ejected) {
		// SEATED + ALIVE: brace. Muscle PD holds the seated posture against g-forces (head up under
		// braking/cornering, torso recovers upright after a jostle). Overwhelmed past the torque cap in a
		// real crash -- that's the drama gradient, emergent from the clamp.
		runtime.state = 'seated';
		// Stiffen the lap belt so the pelvis stays upright (stable core brace, see RESTRAINT_BRACE_HERTZ).
		if (occupant.restraintJoint) {
			occupant.restraintJoint.setSpringHertz(RESTRAINT_BRACE_HERTZ);
			occupant.restraintJoint.setSpringDampingRatio(RESTRAINT_BRACE_DAMPING);
		}
		applyBodyPose(occupant, 1, { shoulderRel: STRAIGHT_REL, hipRel: SEATED_HIP_REL, straightenKnees: false });
		return runtime.newlyShatteredGlass;
	}

	// EJECTED + ALIVE: enter the self-preservation FSM on the first ejected step.
	if (runtime.state === 'seated') {
		runtime.state = 'tumbling';
		runtime.tumbleStartSec = runtime.timeSec;
	}
	updateEjectedFsm(occupant, runtime, ctx);
	detectGlassCrossing(occupant, runtime, ctx);
	tryEnableCarCollision(occupant, runtime, ctx);
	return runtime.newlyShatteredGlass;
}
