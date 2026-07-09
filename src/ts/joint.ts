// SPDX-License-Identifier: MIT

import type { Native } from "./native.js";
import type { World } from "./world.js";
import { registerHandle, unregisterHandle } from "./registry.js";
import { withFloatOutBuffer } from "./scratch.js";
import { TRANSFORM_IDENTITY, type Transform, type Vec3 } from "./math.js";

/** Local joint frame, measured from each body's own origin (not its center of mass). */
export interface JointFrame extends Transform {}

/** Fields shared by every joint type (b3JointDef's non-body fields, box3d/types.h). */
export interface JointOptionsBase {
	/** Local frame on body A. Default identity (frame origin coincides with body A's origin). */
	frameA?: JointFrame;
	/** Local frame on body B. Default identity. */
	frameB?: JointFrame;
	/** Should the two connected bodies still collide with each other? Default false. */
	collideConnected?: boolean;
	userData?: number;
}

function frameArgs( f: JointFrame | undefined ) {
	const t = f ?? TRANSFORM_IDENTITY;
	return [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w] as const;
}

/** Base class for every joint type. Create via World.create*Joint(); destroy via .destroy(). */
export class Joint {
	private destroyed = false;

	/** @internal use World.create*Joint() instead. */
	constructor( protected readonly native: Native, protected readonly world: World, readonly handle: bigint ) {
		registerHandle( handle, "joint" );
	}

	isValid(): boolean {
		return this.native._b3js_Joint_IsValid( this.handle ) !== 0;
	}

	getConstraintForce(): Vec3 {
		return withFloatOutBuffer(
			this.native, 3,
			( ptr ) => this.native._b3js_Joint_GetConstraintForce( this.handle, ptr ),
			( f, i ) => ( { x: f[i], y: f[i + 1], z: f[i + 2] } )
		);
	}

	getConstraintTorque(): Vec3 {
		return withFloatOutBuffer(
			this.native, 3,
			( ptr ) => this.native._b3js_Joint_GetConstraintTorque( this.handle, ptr ),
			( f, i ) => ( { x: f[i], y: f[i + 1], z: f[i + 2] } )
		);
	}

	setUserData( userData: number ): void {
		this.native._b3js_Joint_SetUserData( this.handle, userData );
	}

	getUserData(): number {
		return this.native._b3js_Joint_GetUserData( this.handle );
	}

	/** @param wakeAttached wake both attached bodies (default true). */
	destroy( wakeAttached = true ): void {
		if ( this.destroyed ) {
			throw new Error( "box3d-js: Joint already destroyed" );
		}
		this.destroyed = true;
		unregisterHandle( this.handle, "joint" );
		this.world._untrackJoint( this.handle );
		this.native._b3js_DestroyJoint( this.handle, wakeAttached ? 1 : 0 );
	}
}

// =================================================================================================
// Weld joint
// =================================================================================================

export interface WeldJointOptions extends JointOptionsBase {
	/** Hertz; 0 = maximum stiffness (rigid). Default 0. */
	linearHertz?: number;
	angularHertz?: number;
	/** Non-dimensional; 1 = critical damping. Default 1. */
	linearDampingRatio?: number;
	angularDampingRatio?: number;
}

export class WeldJoint extends Joint {
	setLinearHertz( hertz: number ): void {
		this.native._b3js_WeldJoint_SetLinearHertz( this.handle, hertz );
	}

	setAngularHertz( hertz: number ): void {
		this.native._b3js_WeldJoint_SetAngularHertz( this.handle, hertz );
	}

	setLinearDampingRatio( dampingRatio: number ): void {
		this.native._b3js_WeldJoint_SetLinearDampingRatio( this.handle, dampingRatio );
	}

	setAngularDampingRatio( dampingRatio: number ): void {
		this.native._b3js_WeldJoint_SetAngularDampingRatio( this.handle, dampingRatio );
	}
}

/** @internal used by World.createWeldJoint(). */
export function weldJointArgs( worldHandle: bigint, bodyA: bigint, bodyB: bigint, options: WeldJointOptions ) {
	return [
		worldHandle, bodyA, bodyB,
		...frameArgs( options.frameA ), ...frameArgs( options.frameB ),
		options.collideConnected ? 1 : 0,
		options.linearHertz ?? 0, options.angularHertz ?? 0,
		options.linearDampingRatio ?? 1, options.angularDampingRatio ?? 1,
		options.userData ?? 0,
	] as const;
}

// =================================================================================================
// Wheel joint. Body A is the chassis, body B is the wheel (see b3WheelJointDef's doc comment,
// box3d/types.h): the wheel spins about local frame B's z-axis and (optionally)
// translates/suspends along local frame A's x-axis.
// =================================================================================================

export interface WheelJointOptions extends JointOptionsBase {
	enableSuspensionSpring?: boolean;
	suspensionHertz?: number;
	suspensionDampingRatio?: number;
	enableSuspensionLimit?: boolean;
	lowerSuspensionLimit?: number;
	upperSuspensionLimit?: number;

	enableSpinMotor?: boolean;
	maxSpinTorque?: number;
	spinSpeed?: number;

	enableSteering?: boolean;
	steeringHertz?: number;
	steeringDampingRatio?: number;
	targetSteeringAngle?: number;
	maxSteeringTorque?: number;
	enableSteeringLimit?: boolean;
	lowerSteeringLimit?: number;
	upperSteeringLimit?: number;
}

export class WheelJoint extends Joint {
	enableSuspension( flag: boolean ): void {
		this.native._b3js_WheelJoint_EnableSuspension( this.handle, flag ? 1 : 0 );
	}

	setSuspensionLimits( lower: number, upper: number ): void {
		this.native._b3js_WheelJoint_SetSuspensionLimits( this.handle, lower, upper );
	}

	enableSpinMotor( flag: boolean ): void {
		this.native._b3js_WheelJoint_EnableSpinMotor( this.handle, flag ? 1 : 0 );
	}

	setSpinMotorSpeed( speed: number ): void {
		this.native._b3js_WheelJoint_SetSpinMotorSpeed( this.handle, speed );
	}

	setMaxSpinTorque( torque: number ): void {
		this.native._b3js_WheelJoint_SetMaxSpinTorque( this.handle, torque );
	}

	/** Measured relative spin speed (rad/s) between chassis and wheel about the spin axis. */
	getSpinSpeed(): number {
		return this.native._b3js_WheelJoint_GetSpinSpeed( this.handle );
	}

	getSpinTorque(): number {
		return this.native._b3js_WheelJoint_GetSpinTorque( this.handle );
	}

	enableSteering( flag: boolean ): void {
		this.native._b3js_WheelJoint_EnableSteering( this.handle, flag ? 1 : 0 );
	}

	setTargetSteeringAngle( radians: number ): void {
		this.native._b3js_WheelJoint_SetTargetSteeringAngle( this.handle, radians );
	}

	setMaxSteeringTorque( torque: number ): void {
		this.native._b3js_WheelJoint_SetMaxSteeringTorque( this.handle, torque );
	}

	setSteeringLimits( lower: number, upper: number ): void {
		this.native._b3js_WheelJoint_SetSteeringLimits( this.handle, lower, upper );
	}

	getSteeringAngle(): number {
		return this.native._b3js_WheelJoint_GetSteeringAngle( this.handle );
	}
}

/** @internal used by World.createWheelJoint(). */
export function wheelJointArgs( worldHandle: bigint, bodyChassis: bigint, bodyWheel: bigint,
	options: WheelJointOptions ) {
	return [
		worldHandle, bodyChassis, bodyWheel,
		...frameArgs( options.frameA ), ...frameArgs( options.frameB ),
		options.collideConnected ? 1 : 0,
		options.enableSuspensionSpring ? 1 : 0, options.suspensionHertz ?? 2, options.suspensionDampingRatio ?? 0.7,
		options.enableSuspensionLimit ? 1 : 0, options.lowerSuspensionLimit ?? -1, options.upperSuspensionLimit ?? 1,
		options.enableSpinMotor ? 1 : 0, options.maxSpinTorque ?? 10, options.spinSpeed ?? 0,
		options.enableSteering ? 1 : 0, options.steeringHertz ?? 5, options.steeringDampingRatio ?? 0.7,
		options.targetSteeringAngle ?? 0, options.maxSteeringTorque ?? 10,
		options.enableSteeringLimit ? 1 : 0, options.lowerSteeringLimit ?? -0.5, options.upperSteeringLimit ?? 0.5,
		options.userData ?? 0,
	] as const;
}

// =================================================================================================
// Revolute joint
// =================================================================================================

export interface RevoluteJointOptions extends JointOptionsBase {
	targetAngle?: number;
	enableSpring?: boolean;
	hertz?: number;
	dampingRatio?: number;
	enableLimit?: boolean;
	lowerAngle?: number;
	upperAngle?: number;
	enableMotor?: boolean;
	maxMotorTorque?: number;
	motorSpeed?: number;
}

export class RevoluteJoint extends Joint {
	enableMotor( flag: boolean ): void {
		this.native._b3js_RevoluteJoint_EnableMotor( this.handle, flag ? 1 : 0 );
	}

	setMotorSpeed( speed: number ): void {
		this.native._b3js_RevoluteJoint_SetMotorSpeed( this.handle, speed );
	}

	setMaxMotorTorque( torque: number ): void {
		this.native._b3js_RevoluteJoint_SetMaxMotorTorque( this.handle, torque );
	}

	getAngle(): number {
		return this.native._b3js_RevoluteJoint_GetAngle( this.handle );
	}
}

/** @internal used by World.createRevoluteJoint(). */
export function revoluteJointArgs( worldHandle: bigint, bodyA: bigint, bodyB: bigint,
	options: RevoluteJointOptions ) {
	return [
		worldHandle, bodyA, bodyB,
		...frameArgs( options.frameA ), ...frameArgs( options.frameB ),
		options.collideConnected ? 1 : 0,
		options.targetAngle ?? 0, options.enableSpring ? 1 : 0, options.hertz ?? 0, options.dampingRatio ?? 0,
		options.enableLimit ? 1 : 0, options.lowerAngle ?? -3.1, options.upperAngle ?? 3.1,
		options.enableMotor ? 1 : 0, options.maxMotorTorque ?? 0, options.motorSpeed ?? 0,
		options.userData ?? 0,
	] as const;
}

// =================================================================================================
// Distance joint
// =================================================================================================

export interface DistanceJointOptions extends JointOptionsBase {
	length?: number;
	enableSpring?: boolean;
	lowerSpringForce?: number;
	upperSpringForce?: number;
	hertz?: number;
	dampingRatio?: number;
	enableLimit?: boolean;
	minLength?: number;
	maxLength?: number;
	enableMotor?: boolean;
	maxMotorForce?: number;
	motorSpeed?: number;
}

export class DistanceJoint extends Joint {
	setLength( length: number ): void {
		this.native._b3js_DistanceJoint_SetLength( this.handle, length );
	}

	enableMotor( flag: boolean ): void {
		this.native._b3js_DistanceJoint_EnableMotor( this.handle, flag ? 1 : 0 );
	}

	setMotorSpeed( speed: number ): void {
		this.native._b3js_DistanceJoint_SetMotorSpeed( this.handle, speed );
	}

	getCurrentLength(): number {
		return this.native._b3js_DistanceJoint_GetCurrentLength( this.handle );
	}
}

/** @internal used by World.createDistanceJoint(). */
export function distanceJointArgs( worldHandle: bigint, bodyA: bigint, bodyB: bigint,
	options: DistanceJointOptions ) {
	const length = options.length ?? 1;
	return [
		worldHandle, bodyA, bodyB,
		...frameArgs( options.frameA ), ...frameArgs( options.frameB ),
		options.collideConnected ? 1 : 0,
		length, options.enableSpring ? 1 : 0, options.lowerSpringForce ?? 0, options.upperSpringForce ?? 0,
		options.hertz ?? 0, options.dampingRatio ?? 0,
		options.enableLimit ? 1 : 0, options.minLength ?? 0, options.maxLength ?? Math.max( length, 1000 ),
		options.enableMotor ? 1 : 0, options.maxMotorForce ?? 0, options.motorSpeed ?? 0,
		options.userData ?? 0,
	] as const;
}
