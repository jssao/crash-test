// SPDX-License-Identifier: MIT

import type { Native } from "./native.js";
import { registerHandle, unregisterHandle, forgetHandle } from "./registry.js";
import { withFloatOutBuffer } from "./scratch.js";
import { DEFAULT_CATEGORY_BITS, DEFAULT_GRAVITY, DEFAULT_MASK_BITS, type Vec3 } from "./math.js";
import { HitEventsView, JointEventsView, MoveEventsView } from "./events.js";
import { Body, defaultBodyOptions, type BodyOptions } from "./body.js";
import type { RayCastResult } from "./body.js";
import {
	DistanceJoint,
	RevoluteJoint,
	SphericalJoint,
	WeldJoint,
	WheelJoint,
	distanceJointArgs,
	revoluteJointArgs,
	sphericalJointArgs,
	weldJointArgs,
	wheelJointArgs,
	type DistanceJointOptions,
	type RevoluteJointOptions,
	type SphericalJointOptions,
	type WeldJointOptions,
	type WheelJointOptions,
} from "./joint.js";

/** Mirrors b3WorldDef's scalar fields exposed by the shim. Always starts from b3DefaultWorldDef(). */
export interface WorldOptions {
	/** Default (0, -10, 0) -- Y-up, matching upstream's b3DefaultWorldDef() and Three.js. */
	gravity?: Vec3;
	/** m/s; collisions faster than this can generate hit events. Default 1. */
	hitEventThreshold?: number;
	/** Contact stiffness, Hz. Default 30. */
	contactHertz?: number;
	/** Contact damping ratio. Default 10. */
	contactDampingRatio?: number;
	enableSleep?: boolean;
	enableContinuous?: boolean;
}

export interface RayCastOptions {
	categoryBits?: bigint;
	maskBits?: bigint;
}

/**
 * A Box3D simulation world. Create bodies/joints on it, then `step()` it at a fixed dt and read
 * back `moveEvents()`/`hitEvents()` -- see the module docs on math.ts and events.ts for the
 * conventions (up-axis, quaternion layout, zero-allocation event cursors).
 */
export class World {
	readonly handle: bigint;
	private destroyed = false;
	private readonly bodyHandles = new Set<bigint>();
	private readonly shapeHandles = new Set<bigint>();
	private readonly jointHandles = new Set<bigint>();

	constructor( private readonly native: Native, options: WorldOptions = {} ) {
		const gravity = options.gravity ?? DEFAULT_GRAVITY;
		this.handle = native._b3js_CreateWorld(
			gravity.x, gravity.y, gravity.z,
			options.hitEventThreshold ?? 1,
			options.contactHertz ?? 30,
			options.contactDampingRatio ?? 10,
			options.enableSleep ?? true ? 1 : 0,
			options.enableContinuous ?? true ? 1 : 0
		);
		registerHandle( this.handle, "world" );
	}

	isValid(): boolean {
		return this.native._b3js_World_IsValid( this.handle ) !== 0;
	}

	/** Steps the simulation AND drains this step's move/hit/joint events (see b3js_Step). */
	step( dt: number, subStepCount = 4 ): void {
		this.native._b3js_Step( this.handle, dt, subStepCount );
	}

	setGravity( gravity: Vec3 ): void {
		this.native._b3js_World_SetGravity( this.handle, gravity.x, gravity.y, gravity.z );
	}

	getGravity(): Vec3 {
		return withFloatOutBuffer(
			this.native, 3,
			( ptr ) => this.native._b3js_World_GetGravity( this.handle, ptr ),
			( f, i ) => ( { x: f[i], y: f[i + 1], z: f[i + 2] } )
		);
	}

	/** Zero-allocation (beyond this one view object) cursor over this step's body-move events. */
	moveEvents(): MoveEventsView {
		const ptr = this.native._b3js_GetMoveEventsPtr( this.handle );
		const count = this.native._b3js_GetMoveEventsCount( this.handle );
		return new MoveEventsView( this.native, ptr, count );
	}

	/** Zero-allocation cursor over this step's hit events. */
	hitEvents(): HitEventsView {
		const ptr = this.native._b3js_GetHitEventsPtr( this.handle );
		const count = this.native._b3js_GetHitEventsCount( this.handle );
		return new HitEventsView( this.native, ptr, count );
	}

	/** Zero-allocation cursor over this step's joint (force/torque threshold) events. */
	jointEvents(): JointEventsView {
		const ptr = this.native._b3js_GetJointEventsPtr( this.handle );
		const count = this.native._b3js_GetJointEventsCount( this.handle );
		return new JointEventsView( this.native, ptr, count );
	}

	castRayClosest( origin: Vec3, translation: Vec3, options: RayCastOptions = {} ): RayCastResult {
		const ptr = this.native._malloc( 8 * 4 );
		try {
			const entityId = this.native._b3js_CastRayClosest(
				this.handle, origin.x, origin.y, origin.z, translation.x, translation.y, translation.z,
				options.categoryBits ?? DEFAULT_CATEGORY_BITS, options.maskBits ?? DEFAULT_MASK_BITS, ptr
			);
			const f = this.native.HEAPF32;
			const i = ptr >> 2;
			return {
				hit: f[i] !== 0,
				point: { x: f[i + 1], y: f[i + 2], z: f[i + 3] },
				normal: { x: f[i + 4], y: f[i + 5], z: f[i + 6] },
				fraction: f[i + 7],
				entityId,
			};
		} finally {
			this.native._free( ptr );
		}
	}

	createBody( options: BodyOptions = {} ): Body {
		const o = defaultBodyOptions( options );
		const handle = this.native._b3js_CreateBody(
			this.handle, o.type, o.position.x, o.position.y, o.position.z,
			o.rotation.x, o.rotation.y, o.rotation.z, o.rotation.w,
			o.linearDamping, o.angularDamping, o.gravityScale,
			o.enableSleep ? 1 : 0, o.isBullet ? 1 : 0, o.allowFastRotation ? 1 : 0, o.userData
		);
		const body = new Body( this.native, this, handle );
		this.bodyHandles.add( handle );
		return body;
	}

	createWeldJoint( bodyA: Body, bodyB: Body, options: WeldJointOptions = {} ): WeldJoint {
		const args = weldJointArgs( this.handle, bodyA.handle, bodyB.handle, options );
		const handle = this.native._b3js_CreateWeldJoint( ...args );
		const joint = new WeldJoint( this.native, this, handle );
		this.jointHandles.add( handle );
		return joint;
	}

	createSphericalJoint( bodyA: Body, bodyB: Body, options: SphericalJointOptions = {} ): SphericalJoint {
		const args = sphericalJointArgs( this.handle, bodyA.handle, bodyB.handle, options );
		const handle = this.native._b3js_CreateSphericalJoint( ...args );
		const joint = new SphericalJoint( this.native, this, handle );
		this.jointHandles.add( handle );
		return joint;
	}

	createWheelJoint( bodyChassis: Body, bodyWheel: Body, options: WheelJointOptions = {} ): WheelJoint {
		const args = wheelJointArgs( this.handle, bodyChassis.handle, bodyWheel.handle, options );
		const handle = this.native._b3js_CreateWheelJoint( ...args );
		const joint = new WheelJoint( this.native, this, handle );
		this.jointHandles.add( handle );
		return joint;
	}

	createRevoluteJoint( bodyA: Body, bodyB: Body, options: RevoluteJointOptions = {} ): RevoluteJoint {
		const args = revoluteJointArgs( this.handle, bodyA.handle, bodyB.handle, options );
		const handle = this.native._b3js_CreateRevoluteJoint( ...args );
		const joint = new RevoluteJoint( this.native, this, handle );
		this.jointHandles.add( handle );
		return joint;
	}

	createDistanceJoint( bodyA: Body, bodyB: Body, options: DistanceJointOptions = {} ): DistanceJoint {
		const args = distanceJointArgs( this.handle, bodyA.handle, bodyB.handle, options );
		const handle = this.native._b3js_CreateDistanceJoint( ...args );
		const joint = new DistanceJoint( this.native, this, handle );
		this.jointHandles.add( handle );
		return joint;
	}

	/** @internal called by Shape.destroy()/Body.destroy()/Joint.destroy(). */
	_untrackBody( handle: bigint ): void {
		this.bodyHandles.delete( handle );
	}

	/** @internal called by Body.create*Shape(). */
	_trackShape( handle: bigint ): void {
		this.shapeHandles.add( handle );
	}

	/** @internal called by Shape.destroy(). */
	_untrackShape( handle: bigint ): void {
		this.shapeHandles.delete( handle );
	}

	/** @internal called by Joint.destroy(). */
	_untrackJoint( handle: bigint ): void {
		this.jointHandles.delete( handle );
	}

	/**
	 * Destroys the world and every body/shape/joint still attached to it (box3d itself frees them
	 * internally -- see b3DestroyWorld). Child handles are dropped from the live-handle registry
	 * without an explicit per-child native destroy call, since calling e.g. b3DestroyBody after its
	 * owning world is gone would touch already-freed memory.
	 */
	destroy(): void {
		if ( this.destroyed ) {
			throw new Error( "box3d-js: World already destroyed" );
		}
		this.destroyed = true;
		for ( const h of this.jointHandles ) forgetHandle( h, "joint" );
		for ( const h of this.shapeHandles ) forgetHandle( h, "shape" );
		for ( const h of this.bodyHandles ) forgetHandle( h, "body" );
		this.jointHandles.clear();
		this.shapeHandles.clear();
		this.bodyHandles.clear();
		unregisterHandle( this.handle, "world" );
		this.native._b3js_DestroyWorld( this.handle );
	}
}
