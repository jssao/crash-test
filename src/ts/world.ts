// SPDX-License-Identifier: MIT

import type { Native } from "./native.js";
import { registerHandle, unregisterHandle, forgetHandle } from "./registry.js";
import { withFloatOutBuffer } from "./scratch.js";
import { DEFAULT_CATEGORY_BITS, DEFAULT_GRAVITY, DEFAULT_MASK_BITS, type Vec3 } from "./math.js";
import { ContactEventsView, HitEventsView, JointEventsView, MoveEventsView, SensorEventsView } from "./events.js";
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

/** Mirrors b3ShapeProxy (types.h) -- the generic "convex point cloud + radius" cast shape
 * b3World_CastShape sweeps through the world (see World.castShapeClosest()). A sphere is 1 point with
 * a nonzero radius; a capsule is 2 points with a nonzero radius; a box/hull is its corner/vertex
 * points with radius 0. */
export interface ShapeCastProxy {
	/** Up to B3_MAX_SHAPE_CAST_POINTS (64) points; extras are dropped -- see b3js_CastShapeClosest's
	 * doc comment, src/wasm-shim/binding.c. */
	points: Vec3[];
	/** External radius of the point cloud. 0 for a plain point-cloud/box/hull cast. */
	radius?: number;
}

/** Mirrors b3ExplosionDef (types.h) -- see World.explode(). Upstream's own default def
 * (b3DefaultExplosionDef()) only seeds maskBits; radius/falloff/impulsePerArea have no meaningful
 * default, so they are required here. */
export interface ExplosionOptions {
	/** Center of the explosion in world space. */
	position: Vec3;
	/** Shapes farther than this from `position` feel no impulse. */
	radius: number;
	/** Falloff distance beyond `radius` -- impulse ramps down to zero over this distance. */
	falloff: number;
	/** Impulse per unit shape area facing the explosion. Only applies to spheres, capsules, and
	 * hulls (box3d.h's b3World_Explode doc comment). Negative values implode instead. */
	impulsePerArea: number;
	/** Filters which shapes are affected. Default: all bits set (affects everything). */
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

	/**
	 * Zero-allocation cursor over this step's contact begin-touch events (types.h's
	 * b3ContactBeginTouchEvent) -- fires once when two shapes start touching. Only reported for
	 * shapes created with `enableContactEvents: true` (Shape.enableContactEvents()/ShapeOptions).
	 * Pairs with contactEndEvents() for sustained-contact tracking (e.g. scrape/skid detection) that
	 * one-shot hitEvents() cannot express.
	 */
	contactBeginEvents(): ContactEventsView {
		const ptr = this.native._b3js_GetContactBeginEventsPtr( this.handle );
		const count = this.native._b3js_GetContactBeginEventsCount( this.handle );
		return new ContactEventsView( this.native, ptr, count );
	}

	/** Zero-allocation cursor over this step's contact end-touch events (types.h's
	 * b3ContactEndTouchEvent) -- fires once when two shapes stop touching. See contactBeginEvents(). */
	contactEndEvents(): ContactEventsView {
		const ptr = this.native._b3js_GetContactEndEventsPtr( this.handle );
		const count = this.native._b3js_GetContactEndEventsCount( this.handle );
		return new ContactEventsView( this.native, ptr, count );
	}

	/**
	 * Zero-allocation cursor over this step's sensor begin-touch events (types.h's
	 * b3SensorBeginTouchEvent) -- fires once when a shape starts overlapping a sensor shape. Poll-free
	 * trigger volumes (occupant-in-seat, checkpoint, "entered structure"). Requires the sensor shape
	 * created with `isSensor: true` PLUS `Shape.enableSensorEvents(true)` called on BOTH the sensor
	 * shape and the visitor shape -- sensor events are disabled by default even on sensors, and (per
	 * this shim's own empirical verification, tests/sensor-events.test.ts) enabling it on only one side
	 * of the pair reports nothing; see b3js_Shape_EnableSensorEvents's doc comment, src/wasm-shim/
	 * binding.c. Pairs with sensorEndEvents().
	 */
	sensorBeginEvents(): SensorEventsView {
		const ptr = this.native._b3js_GetSensorBeginEventsPtr( this.handle );
		const count = this.native._b3js_GetSensorBeginEventsCount( this.handle );
		return new SensorEventsView( this.native, ptr, count );
	}

	/** Zero-allocation cursor over this step's sensor end-touch events (types.h's
	 * b3SensorEndTouchEvent) -- fires once when a shape stops overlapping a sensor shape (including
	 * when either shape is destroyed -- see sensorUserData/visitorUserData's fallback-to-0 behavior on
	 * an already-destroyed shape, b3js_EntityIdFromShapeOrZero in binding.c). See sensorBeginEvents(). */
	sensorEndEvents(): SensorEventsView {
		const ptr = this.native._b3js_GetSensorEndEventsPtr( this.handle );
		const count = this.native._b3js_GetSensorEndEventsCount( this.handle );
		return new SensorEventsView( this.native, ptr, count );
	}

	/**
	 * Applies a radial explosion (b3World_Explode, box3d.h) -- an area-aware impulse to spheres/
	 * capsules/hulls within `options.radius` (+`options.falloff`) of `options.position`. Takes effect
	 * immediately (not queued for the next step).
	 */
	explode( options: ExplosionOptions ): void {
		this.native._b3js_World_Explode(
			this.handle, options.maskBits ?? DEFAULT_MASK_BITS,
			options.position.x, options.position.y, options.position.z,
			options.radius, options.falloff, options.impulsePerArea
		);
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

	/**
	 * Sweeps `proxy` (see ShapeCastProxy) from `origin` by `translation` and returns only the closest
	 * hit (b3World_CastShape, box3d.h -- see b3js_CastShapeClosest's doc comment, src/wasm-shim/
	 * binding.c, for why this is a thin "closest" wrapper over the engine's callback-based cast).
	 * Ignores initial overlap at the origin, same as castRayClosest(). Core use case: chase-cam
	 * occlusion -- sphere-cast camera-\>car each frame and pull the camera in when it would clip a
	 * wall/building.
	 */
	castShapeClosest( proxy: ShapeCastProxy, origin: Vec3, translation: Vec3,
		options: RayCastOptions = {} ): RayCastResult {
		const pointCount = proxy.points.length;
		const flatPoints = new Float32Array( pointCount * 3 );
		for ( let i = 0; i < pointCount; i++ ) {
			flatPoints[i * 3] = proxy.points[i].x;
			flatPoints[i * 3 + 1] = proxy.points[i].y;
			flatPoints[i * 3 + 2] = proxy.points[i].z;
		}

		const pointsPtr = this.native._malloc( flatPoints.byteLength );
		const outPtr = this.native._malloc( 8 * 4 );
		try {
			this.native.HEAPF32.set( flatPoints, pointsPtr >> 2 );
			const entityId = this.native._b3js_CastShapeClosest(
				this.handle, pointsPtr, pointCount, proxy.radius ?? 0,
				origin.x, origin.y, origin.z, translation.x, translation.y, translation.z,
				options.categoryBits ?? DEFAULT_CATEGORY_BITS, options.maskBits ?? DEFAULT_MASK_BITS, outPtr
			);
			const f = this.native.HEAPF32;
			const i = outPtr >> 2;
			return {
				hit: f[i] !== 0,
				point: { x: f[i + 1], y: f[i + 2], z: f[i + 3] },
				normal: { x: f[i + 4], y: f[i + 5], z: f[i + 6] },
				fraction: f[i + 7],
				entityId,
			};
		} finally {
			this.native._free( pointsPtr );
			this.native._free( outPtr );
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
