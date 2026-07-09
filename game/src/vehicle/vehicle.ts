// SPDX-License-Identifier: MIT
//
// Renderer-free physics assembly for the crash-sandbox vehicle: 5 rigid bodies (chassis + 4 wheels)
// + 4 wheel joints (suspension, steering on the fronts, RWD spin motors on the rears) + the fixed-step
// update (drivetrain servo, brakes, steering slew, anti-roll assist). No `three` import anywhere in
// this file (or its imports) -- see tuning.ts/geometry.ts/powertrain.ts/mathUtil.ts -- so this same
// module is shared verbatim by the browser game (game/src/core/loop.ts) and the headless sim harness
// (game/sim/harness.mjs).
//
// Wheel-joint frame derivation (why the frame rotations below are what they are) is documented in
// mathUtil.ts's WHEEL_FRAME_A_ROTATION / WHEEL_FRAME_B_ROTATION doc comments.

import { Body, BodyType, World, WheelJoint, type Quat, type Vec3 } from '../../../src/ts/index.js';
import { createPanels, resetAttachedPanels, type PanelHandle, type PanelKey } from '../damage/panels';
import { buildChassisHullPoints, solveChassisDensities } from './geometry';
import {
	add,
	clamp,
	dot,
	IDENTITY_Q,
	LOCAL_FORWARD,
	LOCAL_RIGHT,
	LOCAL_UP,
	rotateVector,
	scale,
	sub,
	WHEEL_FRAME_A_ROTATION,
	WHEEL_FRAME_B_ROTATION,
	type Q4,
	type V3,
} from './mathUtil';
import { coastServoTarget, createGearboxState, driveServoTarget, engineTorqueAt, stepGearbox, type GearboxState } from './powertrain';
import {
	ANTI_ROLL_ENABLED,
	ANTI_ROLL_GAIN_ANGLE,
	ANTI_ROLL_GAIN_RATE,
	ANTI_ROLL_TORQUE_CAP_NM,
	BALLAST_LOCAL_Y_M,
	BALLAST_RADIUS_M,
	BRAKE_TORQUE_FRONT_NM,
	BRAKE_TORQUE_REAR_NM,
	CAR_GROUP_INDEX,
	CHASSIS_IS_BULLET,
	CHASSIS_ORIGIN_HEIGHT_M,
	ENGINE_BRAKE_TORQUE_NM,
	FRONT_PASSIVE_DRAG_NM,
	GROUND_FRICTION,
	HANDBRAKE_TORQUE_NM,
	STEER_CLAMP_MAX_RAD,
	STEER_CLAMP_MIN_RAD,
	STEER_CLAMP_SPEED_KMH,
	STEER_SLEW_RATE_RAD_S,
	STEERING_DAMPING_RATIO,
	STEERING_HERTZ,
	STEERING_LOWER_LIMIT_RAD,
	STEERING_MAX_TORQUE_NM,
	STEERING_UPPER_LIMIT_RAD,
	SUSPENSION_DAMPING_RATIO,
	SUSPENSION_HERTZ_FRONT,
	SUSPENSION_HERTZ_REAR,
	SUSPENSION_LOWER_LIMIT_M,
	SUSPENSION_UPPER_LIMIT_M,
	TRACTION_SLIP_ALLOWANCE_RAD_S,
	TRACTION_SLIP_CUTOFF_RAD_S,
	WHEEL_FRICTION,
	WHEEL_MASS_KG,
	WHEEL_RADIUS_FRONT_M,
	WHEEL_RADIUS_REAR_M,
	WHEEL_RESTITUTION,
	WHEEL_ROLLING_RESISTANCE,
	WHEEL_SPAWN_SETTLE_MARGIN_M,
	YAW_DAMPING_GAIN_NM_PER_RAD_S,
	YAW_DAMPING_TORQUE_CAP_NM,
} from './tuning';
import { CAR_MAP, type Vec3Mm } from '../assets/car-map';

export type WheelKey = 'fl' | 'fr' | 'rl' | 'rr';

/**
 * Entity ids tagged on the chassis/wheel bodies (Body userData), read back via hit events'
 * userDataA/userDataB (src/ts/events.ts's HitEventCursor) by the damage system (game/src/damage/
 * welds.ts, system.ts). Kept in a disjoint numeric range (1-5) from game/src/damage/panels.ts's
 * PANEL_ENTITY_ID (6-10) by convention, deliberately NOT via a shared import -- vehicle.ts already
 * imports panels.ts (createVehicle() below calls createPanels()), so panels.ts importing IDs back
 * from here would be a cycle.
 */
export const CAR_ENTITY_ID = {
	chassis: 1,
	wheel: { fl: 2, fr: 3, rl: 4, rr: 5 } as Record<WheelKey, number>,
} as const;

interface WheelDef {
	key: WheelKey;
	localMount: V3;
	radius: number;
	driven: boolean;
	steered: boolean;
}

function mmToLocalMount(centerMm: Vec3Mm): V3 {
	return {
		x: centerMm[0] / 1000,
		y: centerMm[1] / 1000 - CHASSIS_ORIGIN_HEIGHT_M,
		z: centerMm[2] / 1000,
	};
}

const WHEEL_DEFS: readonly WheelDef[] = [
	{ key: 'fl', localMount: mmToLocalMount(CAR_MAP.wheels.frontLeft.centerMm), radius: WHEEL_RADIUS_FRONT_M, driven: false, steered: true },
	{ key: 'fr', localMount: mmToLocalMount(CAR_MAP.wheels.frontRight.centerMm), radius: WHEEL_RADIUS_FRONT_M, driven: false, steered: true },
	{ key: 'rl', localMount: mmToLocalMount(CAR_MAP.wheels.rearLeft.centerMm), radius: WHEEL_RADIUS_REAR_M, driven: true, steered: false },
	{ key: 'rr', localMount: mmToLocalMount(CAR_MAP.wheels.rearRight.centerMm), radius: WHEEL_RADIUS_REAR_M, driven: true, steered: false },
];

export interface WheelHandle {
	def: WheelDef;
	body: Body;
	/**
	 * Null once the damage system detaches this wheel (game/src/damage/welds.ts destroys the wheel
	 * joint on a constraint-force spike -- see damage-tuning.ts's WHEEL_DETACH_FORCE_MULT). Every
	 * joint-method call site below (stepVehicle/getTelemetry) guards against null so the car keeps
	 * simulating -- and keeps responding to input on its remaining wheels -- with up to 3 wheels
	 * detached (spec: "drivetrain skips missing wheels").
	 */
	joint: WheelJoint | null;
}

export interface Vehicle {
	world: World;
	chassis: Body;
	wheels: Record<WheelKey, WheelHandle>;
	/** The 5 damage-system panel bodies (game/src/damage/panels.ts), rigidly welded to the chassis --
	 * see that module's createPanels() doc comment for why panels are part of the core assembly. */
	panels: Record<PanelKey, PanelHandle>;
	gearbox: GearboxState;
	commandedSteerRad: number;
	spawnPosition: V3;
	spawnRotation: Q4;
}

export interface VehicleInput {
	/** 0..1 */
	throttle: number;
	/** 0..1 */
	brake: number;
	/** -1..1, positive = one steer direction (sign not gameplay-validated, see mathUtil.ts doc) */
	steer: number;
	handbrake: boolean;
}

export const NEUTRAL_INPUT: Readonly<VehicleInput> = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: false });

/** Creates the ground static body (huge box, asphalt-ish friction) shared by the sim harness and the game scene. */
export function createGroundBody(world: World, halfSize = 250): Body {
	const ground = world.createBody({ type: BodyType.Static, position: { x: 0, y: -0.5, z: 0 } });
	ground.createBoxShape({ halfExtents: { x: halfSize, y: 0.5, z: halfSize }, friction: GROUND_FRICTION, density: 1 });
	return ground;
}

export function createVehicle(
	world: World,
	// See tuning.ts's WHEEL_SPAWN_SETTLE_MARGIN_M doc comment: a small deliberate initial penetration
	// below the ground, not the exact tangent height, is required for stable wheel-ground contact.
	spawnPosition: V3 = { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M - WHEEL_SPAWN_SETTLE_MARGIN_M, z: 0 },
	spawnRotation: Q4 = IDENTITY_Q,
): Vehicle {
	const chassis = world.createBody({
		type: BodyType.Dynamic,
		position: spawnPosition,
		rotation: spawnRotation,
		isBullet: CHASSIS_IS_BULLET,
		userData: CAR_ENTITY_ID.chassis,
	});

	const solved = solveChassisDensities();
	const hullPoints = buildChassisHullPoints();
	// enableHitEvents: the damage system (game/src/damage/system.ts) reacts to hit events on the
	// chassis (crash impacts) to drive plastic-crumple deformation + accumulated weld stress.
	// groupIndex: CAR_GROUP_INDEX (shared, negative) on every car shape -- see tuning.ts's doc
	// comment -- so the chassis hull never self-collides with wheels/panels.
	chassis.createHullShape(hullPoints, {
		density: solved.hullDensity,
		friction: 0.8,
		enableHitEvents: true,
		groupIndex: CAR_GROUP_INDEX,
	});
	chassis.createSphereShape({
		radius: BALLAST_RADIUS_M,
		center: { x: 0, y: BALLAST_LOCAL_Y_M, z: 0 },
		density: solved.ballastDensity,
		isSensor: true,
		groupIndex: CAR_GROUP_INDEX,
	});
	// Defensive: the two createXShape calls above already trigger b3UpdateBodyMassData each time
	// (see body.c), but recompute explicitly in case that default ever changes.
	chassis.applyMassFromShapes();

	const wheels = {} as Record<WheelKey, WheelHandle>;
	for (const def of WHEEL_DEFS) {
		const worldPos = add(spawnPosition, rotateVector(spawnRotation, def.localMount));
		// BINDFIX: allowFastRotation exempts wheel bodies from box3d's per-body angular-velocity
		// safety clamp (see tuning.ts's doc comment just after FIXED_SUBSTEPS) -- upstream's own
		// guidance is that this flag should only be used for circular objects, like wheels.
		const wheelBody = world.createBody({
			type: BodyType.Dynamic,
			position: worldPos,
			rotation: spawnRotation,
			allowFastRotation: true,
			userData: CAR_ENTITY_ID.wheel[def.key],
		});
		const wheelDensity = WHEEL_MASS_KG / ((4 / 3) * Math.PI * def.radius ** 3);
		wheelBody.createSphereShape({
			radius: def.radius,
			density: wheelDensity,
			friction: WHEEL_FRICTION,
			restitution: WHEEL_RESTITUTION,
			rollingResistance: WHEEL_ROLLING_RESISTANCE,
			enableContactEvents: false,
			enableHitEvents: false,
			// CAR_GROUP_INDEX (shared, negative) so wheels never self-collide with the chassis/other
			// wheels/panels -- upgrades the previous collideConnected:false on the wheel joint below,
			// which only ever covered THIS wheel's own joint pair, not e.g. wheel-vs-wheel.
			groupIndex: CAR_GROUP_INDEX,
		});

		const suspensionHertz = def.steered ? SUSPENSION_HERTZ_FRONT : SUSPENSION_HERTZ_REAR;
		const joint = world.createWheelJoint(chassis, wheelBody, {
			frameA: { position: def.localMount, rotation: WHEEL_FRAME_A_ROTATION },
			frameB: { position: { x: 0, y: 0, z: 0 }, rotation: WHEEL_FRAME_B_ROTATION },
			collideConnected: false,
			enableSuspensionSpring: true,
			suspensionHertz,
			suspensionDampingRatio: SUSPENSION_DAMPING_RATIO,
			enableSuspensionLimit: true,
			lowerSuspensionLimit: SUSPENSION_LOWER_LIMIT_M,
			upperSuspensionLimit: SUSPENSION_UPPER_LIMIT_M,
			enableSpinMotor: true,
			maxSpinTorque: 0,
			spinSpeed: 0,
			enableSteering: def.steered,
			steeringHertz: STEERING_HERTZ,
			steeringDampingRatio: STEERING_DAMPING_RATIO,
			targetSteeringAngle: 0,
			maxSteeringTorque: def.steered ? STEERING_MAX_TORQUE_NM : 0,
			enableSteeringLimit: def.steered,
			lowerSteeringLimit: STEERING_LOWER_LIMIT_RAD,
			upperSteeringLimit: STEERING_UPPER_LIMIT_RAD,
		});

		wheels[def.key] = { def, body: wheelBody, joint };
	}

	const panels = createPanels(world, chassis, spawnPosition, spawnRotation);

	return {
		world,
		chassis,
		wheels,
		panels,
		gearbox: createGearboxState(),
		commandedSteerRad: 0,
		spawnPosition,
		spawnRotation,
	};
}

export function resetVehicle(vehicle: Vehicle): void {
	vehicle.chassis.setTransform(vehicle.spawnPosition, vehicle.spawnRotation);
	vehicle.chassis.setLinearVelocity({ x: 0, y: 0, z: 0 });
	vehicle.chassis.setAngularVelocity({ x: 0, y: 0, z: 0 });
	vehicle.chassis.setAwake(true);
	for (const w of Object.values(vehicle.wheels)) {
		const worldPos = add(vehicle.spawnPosition, rotateVector(vehicle.spawnRotation, w.def.localMount));
		w.body.setTransform(worldPos, vehicle.spawnRotation);
		w.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		w.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		w.body.setAwake(true);
	}
	resetAttachedPanels(vehicle.panels, vehicle.spawnPosition, vehicle.spawnRotation);
	vehicle.gearbox.gear = 0;
	vehicle.gearbox.shiftCutMs = 0;
	vehicle.commandedSteerRad = 0;
}

export function speedSensitiveSteerClamp(speedKmh: number): number {
	const t = clamp(speedKmh / STEER_CLAMP_SPEED_KMH, 0, 1);
	return STEER_CLAMP_MAX_RAD + (STEER_CLAMP_MIN_RAD - STEER_CLAMP_MAX_RAD) * t;
}

function chassisForward(rotation: Q4): V3 {
	return rotateVector(rotation, LOCAL_FORWARD);
}

function chassisUp(rotation: Q4): V3 {
	return rotateVector(rotation, LOCAL_UP);
}

/**
 * Driven-wheel angular speed IMPLIED by chassis forward speed (v/r), not read from the wheel joint
 * itself. Used for the gearbox's rpm estimation, which wants a no-slip engine-to-wheel-hub estimate
 * regardless of what the tire contact patch is doing.
 */
function chassisImpliedRearOmega(vehicle: Vehicle): number {
	const forward = chassisForward(vehicle.chassis.getRotation());
	const forwardSpeed = dot(vehicle.chassis.getLinearVelocity(), forward);
	return Math.abs(forwardSpeed) / WHEEL_RADIUS_REAR_M;
}

/**
 * Traction-control-style torque taper: cuts a driven wheel's commanded max torque once its REAL
 * angular speed (`realOmega`, from joint.getSpinSpeed() -- meaningful now that allowFastRotation
 * lifts box3d's per-body rotation clamp, see the doc comment on TRACTION_SLIP_ALLOWANCE_RAD_S in
 * tuning.ts) runs measurably ahead of `impliedOmega` (chassisImpliedRearOmega() -- what the chassis's
 * own forward progress implies), i.e. genuine wheelspin rather than normal rolling. Full torque below
 * TRACTION_SLIP_ALLOWANCE_RAD_S of slip, linearly cut to zero by TRACTION_SLIP_CUTOFF_RAD_S.
 */
function tractionLimitedTorque(realOmega: number, impliedOmega: number, maxTorqueNm: number): number {
	const slip = Math.abs(realOmega) - impliedOmega;
	const t = clamp(
		(slip - TRACTION_SLIP_ALLOWANCE_RAD_S) / (TRACTION_SLIP_CUTOFF_RAD_S - TRACTION_SLIP_ALLOWANCE_RAD_S),
		0,
		1
	);
	return maxTorqueNm * (1 - t);
}

/** Active anti-roll torque about the chassis's world forward axis, proportional to roll angle & rate, capped. */
export function computeAntiRollTorque(rotation: Q4, angularVelocity: V3): V3 {
	if (!ANTI_ROLL_ENABLED) return { x: 0, y: 0, z: 0 };
	const forward = chassisForward(rotation);
	const right = rotateVector(rotation, LOCAL_RIGHT);
	// Roll angle proxy: how far "right" has tilted toward world-up (0 when level).
	const rollAngle = Math.asin(clamp(dot(right, { x: 0, y: 1, z: 0 }), -1, 1));
	const rollRate = dot(angularVelocity, forward);
	let magnitude = -ANTI_ROLL_GAIN_ANGLE * rollAngle - ANTI_ROLL_GAIN_RATE * rollRate;
	magnitude = clamp(magnitude, -ANTI_ROLL_TORQUE_CAP_NM, ANTI_ROLL_TORQUE_CAP_NM);
	return scale(forward, magnitude);
}

/**
 * Active yaw-rate damping torque about the chassis's world-up axis, proportional to yaw rate, capped
 * -- see YAW_DAMPING_GAIN_NM_PER_RAD_S's doc comment in tuning.ts for why this was added alongside the
 * pre-existing anti-roll assist above.
 */
function computeYawDampingTorque(rotation: Q4, angularVelocity: V3): V3 {
	const up = chassisUp(rotation);
	const yawRate = dot(angularVelocity, up);
	const magnitude = clamp(-YAW_DAMPING_GAIN_NM_PER_RAD_S * yawRate, -YAW_DAMPING_TORQUE_CAP_NM, YAW_DAMPING_TORQUE_CAP_NM);
	return scale(up, magnitude);
}

export interface Telemetry {
	speedKmh: number;
	gear: number;
	rpm: number;
	wheelOmegas: Record<WheelKey, number>;
	/** Rough per-wheel slip estimate, m/s: wheel contact-patch surface speed minus chassis forward
	 * speed (positive = wheel outpacing chassis / wheelspin, negative = wheel under-rotating). */
	slipHints: Record<WheelKey, number>;
	steeringAngle: number;
	chassisPos: V3;
	chassisQuat: Q4;
	rollAngleRad: number;
	yawRateRadS: number;
	upDot: number;
}

export function getTelemetry(vehicle: Vehicle): Telemetry {
	const transform = vehicle.chassis.getTransform();
	const vel = vehicle.chassis.getLinearVelocity();
	const speedMs = Math.sqrt(dot(vel, vel));
	const angularVel = vehicle.chassis.getAngularVelocity();
	const up = chassisUp(transform.rotation);
	const right = rotateVector(transform.rotation, LOCAL_RIGHT);
	const forward = chassisForward(transform.rotation);
	const forwardSpeed = dot(vel, forward);
	const wheelOmegas = {} as Record<WheelKey, number>;
	const slipHints = {} as Record<WheelKey, number>;
	for (const key of Object.keys(vehicle.wheels) as WheelKey[]) {
		const w = vehicle.wheels[key];
		// Detached wheel (damage system destroyed its joint, see WheelHandle.joint's doc comment):
		// no joint to read from -- report 0 rather than throwing.
		const omega = w.joint ? w.joint.getSpinSpeed() : 0;
		wheelOmegas[key] = omega;
		slipHints[key] = omega * w.def.radius - forwardSpeed;
	}
	const gearStep = stepGearboxPeek(vehicle.gearbox, chassisImpliedRearOmega(vehicle));

	return {
		speedKmh: speedMs * 3.6,
		gear: vehicle.gearbox.gear + 1,
		rpm: gearStep.engineRpm,
		wheelOmegas,
		slipHints,
		steeringAngle: vehicle.wheels.fl.joint ? vehicle.wheels.fl.joint.getSteeringAngle() : vehicle.commandedSteerRad,
		chassisPos: transform.position,
		chassisQuat: transform.rotation,
		rollAngleRad: Math.asin(clamp(dot(right, { x: 0, y: 1, z: 0 }), -1, 1)),
		yawRateRadS: dot(angularVel, up),
		upDot: dot(up, { x: 0, y: 1, z: 0 }),
	};
}

/**
 * Approximate suspension deflection (meters) for one wheel: the wheel body's position projected
 * onto the chassis's "up" axis, relative to where it would sit at zero suspension travel (its
 * nominal mount anchor). Not read from the joint directly (WheelJoint has no getSuspensionLength()/
 * getTranslation() accessor in this binding) -- reconstructed from body transforms instead, which is
 * exact at zero roll/pitch and a good approximation otherwise (adequate for drive-test assertions,
 * e.g. checking the suspension bump test stays within SUSPENSION_LOWER/UPPER_LIMIT_M).
 */
export function getSuspensionDeflection(vehicle: Vehicle, key: WheelKey): number {
	const w = vehicle.wheels[key];
	const chassisTransform = vehicle.chassis.getTransform();
	const anchorA = add(chassisTransform.position, rotateVector(chassisTransform.rotation, w.def.localMount));
	const wheelPos = w.body.getPosition();
	const upAxis = chassisUp(chassisTransform.rotation);
	return dot(sub(wheelPos, anchorA), upAxis);
}

/** Read-only peek at what stepGearbox() would report, without mutating shift state (telemetry only). */
function stepGearboxPeek(state: GearboxState, wheelOmegaAbs: number) {
	const copy = { gear: state.gear, shiftCutMs: state.shiftCutMs };
	return stepGearbox(copy, wheelOmegaAbs, 0);
}

/**
 * Advances the vehicle's control layer (drivetrain servo targets, brakes, steering) by one fixed
 * physics step. Call this immediately before world.step(dt, ...). Does not itself call world.step().
 */
export function stepVehicle(vehicle: Vehicle, input: VehicleInput, dt: number): void {
	const dtMs = dt * 1000;
	const rl = vehicle.wheels.rl;
	const rr = vehicle.wheels.rr;
	const impliedOmega = chassisImpliedRearOmega(vehicle);
	const gearStep = stepGearbox(vehicle.gearbox, impliedOmega, dtMs);

	const throttle = clamp(input.throttle, 0, 1);
	const brake = clamp(input.brake, 0, 1);
	const forwardSign: 1 | -1 = 1;

	// ---- Drivetrain (rear/driven wheels) ----
	// Every joint call below is guarded against a detached wheel (WheelHandle.joint === null, see its
	// doc comment) -- the damage system can destroy a wheel joint at runtime, and the car must keep
	// simulating/responding to input on its remaining wheels afterward (spec: "drivetrain skips
	// missing wheels").
	if (brake > 1e-3) {
		const torque = BRAKE_TORQUE_REAR_NM * brake;
		for (const w of [rl, rr]) {
			if (!w.joint) continue;
			w.joint.setSpinMotorSpeed(0);
			w.joint.setMaxSpinTorque(torque);
		}
	} else if (throttle > 1e-3) {
		const target = driveServoTarget(gearStep, throttle, forwardSign);
		for (const w of [rl, rr]) {
			if (!w.joint) continue;
			w.joint.setSpinMotorSpeed(target.spinTargetOmega);
			w.joint.setMaxSpinTorque(tractionLimitedTorque(w.joint.getSpinSpeed(), impliedOmega, target.maxSpinTorqueNm));
		}
	} else {
		const target = coastServoTarget(ENGINE_BRAKE_TORQUE_NM);
		for (const w of [rl, rr]) {
			if (!w.joint) continue;
			w.joint.setSpinMotorSpeed(target.spinTargetOmega);
			w.joint.setMaxSpinTorque(target.maxSpinTorqueNm);
		}
	}

	// ---- Handbrake (rear only, overrides drive/coast, not the footbrake) ----
	if (input.handbrake) {
		for (const w of [rl, rr]) {
			if (!w.joint) continue;
			w.joint.setSpinMotorSpeed(0);
			w.joint.setMaxSpinTorque(HANDBRAKE_TORQUE_NM);
		}
	}

	// ---- Front wheels: footbrake or light passive drag ----
	const fl = vehicle.wheels.fl;
	const fr = vehicle.wheels.fr;
	for (const w of [fl, fr]) {
		if (!w.joint) continue;
		if (brake > 1e-3) {
			w.joint.setSpinMotorSpeed(0);
			w.joint.setMaxSpinTorque(BRAKE_TORQUE_FRONT_NM * brake);
		} else {
			w.joint.setSpinMotorSpeed(w.joint.getSpinSpeed());
			w.joint.setMaxSpinTorque(FRONT_PASSIVE_DRAG_NM);
		}
	}

	// ---- Steering (front only): speed-sensitive clamp + slew-rate limit ----
	const speedKmh = Math.sqrt(dot(vehicle.chassis.getLinearVelocity(), vehicle.chassis.getLinearVelocity())) * 3.6;
	const maxAngle = speedSensitiveSteerClamp(speedKmh);
	const targetAngle = clamp(input.steer, -1, 1) * maxAngle;
	const maxDelta = STEER_SLEW_RATE_RAD_S * dt;
	const delta = clamp(targetAngle - vehicle.commandedSteerRad, -maxDelta, maxDelta);
	vehicle.commandedSteerRad += delta;
	if (fl.joint) fl.joint.setTargetSteeringAngle(vehicle.commandedSteerRad);
	if (fr.joint) fr.joint.setTargetSteeringAngle(vehicle.commandedSteerRad);

	// ---- Anti-roll assist + yaw damping ----
	const transform = vehicle.chassis.getTransform();
	const angularVel = vehicle.chassis.getAngularVelocity();
	const torque = add(
		computeAntiRollTorque(transform.rotation, angularVel),
		computeYawDampingTorque(transform.rotation, angularVel)
	);
	if (dot(torque, torque) > 0) {
		vehicle.chassis.applyTorque(torque, true);
	}
}

export { engineTorqueAt };
export type { Vec3, Quat };
