// SPDX-License-Identifier: MIT

import type { Native } from "./native.js";
import type { World } from "./world.js";
import { registerHandle, unregisterHandle } from "./registry.js";
import { withFloatOutBuffer, withInputFloatBuffer, withInputInt32Buffer, withInputUint8Buffer } from "./scratch.js";
import { QUAT_IDENTITY, VEC3_ZERO, type Matrix3, type Quat, type Transform, type Vec3 } from "./math.js";
import {
	Shape,
	buildBoxArgs,
	buildCapsuleArgs,
	buildShapeArgs,
	buildSphereArgs,
	type BoxShapeOptions,
	type CapsuleShapeOptions,
	type MeshMaterialEntry,
	type ShapeOptions,
	type SphereShapeOptions,
} from "./shape.js";

/** @internal flattens an optional per-triangle/per-cell materials array into the
 * (friction,restitution,rollingResistance) triples the shim's b3js_BuildTriangleMaterials expects. */
function flattenMeshMaterials( materials: MeshMaterialEntry[] | undefined ): Float32Array | undefined {
	if ( materials === undefined || materials.length < 2 ) {
		return undefined;
	}
	const flat = new Float32Array( materials.length * 3 );
	for ( let i = 0; i < materials.length; i++ ) {
		const m = materials[i];
		flat[i * 3] = m.friction ?? 0.6;
		flat[i * 3 + 1] = m.restitution ?? 0;
		flat[i * 3 + 2] = m.rollingResistance ?? 0;
	}
	return flat;
}

/** Mirrors b3BodyType (box3d/types.h): static=0, kinematic=1, dynamic=2. */
export enum BodyType {
	Static = 0,
	Kinematic = 1,
	Dynamic = 2,
}

/** Mirrors b3BodyDef's scalar fields. Always starts from b3DefaultBodyDef() in the shim. */
export interface BodyOptions {
	type?: BodyType;
	position?: Vec3;
	rotation?: Quat;
	linearDamping?: number;
	angularDamping?: number;
	/** Default 1 (matching b3DefaultBodyDef()). */
	gravityScale?: number;
	enableSleep?: boolean;
	isBullet?: boolean;
	/**
	 * Exempts this body from box3d's per-step angular-velocity safety clamp (B3_MAX_ROTATION*inv_dt,
	 * ~47 rad/s at 60Hz -- see vendor/box3d/src/solver.c's b3IntegratePositionsTask()). Upstream's own
	 * doc comment: "Should only be used for circular objects, like wheels." Default false.
	 */
	allowFastRotation?: boolean;
	/** Entity id tag read back by move/hit events (falls back to the body's shapes if a shape has none). */
	userData?: number;
}

/** Mirrors b3MassData (box3d/types.h): mass, local-space center of mass, and the inertia tensor
 * (about that center of mass) as a 3x3 matrix. See Body.getMassData()/setMassData(). */
export interface MassData {
	mass: number;
	center: Vec3;
	inertia: Matrix3;
}

export interface RayCastResult {
	hit: boolean;
	point: Vec3;
	normal: Vec3;
	fraction: number;
	/** The entity id of the hit shape (or its owning body), 0 if nothing was hit. */
	entityId: number;
}

/** A rigid body handle. Create via World.createBody(); destroy via .destroy(). */
export class Body {
	private destroyed = false;

	/** @internal use World.createBody() instead. */
	constructor( private readonly native: Native, private readonly world: World, readonly handle: bigint ) {
		registerHandle( handle, "body" );
	}

	isValid(): boolean {
		return this.native._b3js_Body_IsValid( this.handle ) !== 0;
	}

	getTransform(): Transform {
		return withFloatOutBuffer(
			this.native,
			7,
			( ptr ) => this.native._b3js_Body_GetTransform( this.handle, ptr ),
			( f, i ) => ( {
				position: { x: f[i], y: f[i + 1], z: f[i + 2] },
				rotation: { x: f[i + 3], y: f[i + 4], z: f[i + 5], w: f[i + 6] },
			} )
		);
	}

	getPosition(): Vec3 {
		return this.getTransform().position;
	}

	getRotation(): Quat {
		return this.getTransform().rotation;
	}

	setTransform( position: Vec3, rotation: Quat = QUAT_IDENTITY ): void {
		this.native._b3js_Body_SetTransform(
			this.handle,
			position.x, position.y, position.z,
			rotation.x, rotation.y, rotation.z, rotation.w
		);
	}

	getLinearVelocity(): Vec3 {
		return withFloatOutBuffer(
			this.native,
			3,
			( ptr ) => this.native._b3js_Body_GetLinearVelocity( this.handle, ptr ),
			( f, i ) => ( { x: f[i], y: f[i + 1], z: f[i + 2] } )
		);
	}

	setLinearVelocity( v: Vec3 ): void {
		this.native._b3js_Body_SetLinearVelocity( this.handle, v.x, v.y, v.z );
	}

	getAngularVelocity(): Vec3 {
		return withFloatOutBuffer(
			this.native,
			3,
			( ptr ) => this.native._b3js_Body_GetAngularVelocity( this.handle, ptr ),
			( f, i ) => ( { x: f[i], y: f[i + 1], z: f[i + 2] } )
		);
	}

	setAngularVelocity( v: Vec3 ): void {
		this.native._b3js_Body_SetAngularVelocity( this.handle, v.x, v.y, v.z );
	}

	applyForce( force: Vec3, point: Vec3, wake = true ): void {
		this.native._b3js_Body_ApplyForce( this.handle, force.x, force.y, force.z, point.x, point.y, point.z,
			wake ? 1 : 0 );
	}

	applyForceToCenter( force: Vec3, wake = true ): void {
		this.native._b3js_Body_ApplyForceToCenter( this.handle, force.x, force.y, force.z, wake ? 1 : 0 );
	}

	applyTorque( torque: Vec3, wake = true ): void {
		this.native._b3js_Body_ApplyTorque( this.handle, torque.x, torque.y, torque.z, wake ? 1 : 0 );
	}

	applyLinearImpulse( impulse: Vec3, point: Vec3, wake = true ): void {
		this.native._b3js_Body_ApplyLinearImpulse( this.handle, impulse.x, impulse.y, impulse.z, point.x, point.y,
			point.z, wake ? 1 : 0 );
	}

	applyLinearImpulseToCenter( impulse: Vec3, wake = true ): void {
		this.native._b3js_Body_ApplyLinearImpulseToCenter( this.handle, impulse.x, impulse.y, impulse.z,
			wake ? 1 : 0 );
	}

	applyAngularImpulse( impulse: Vec3, wake = true ): void {
		this.native._b3js_Body_ApplyAngularImpulse( this.handle, impulse.x, impulse.y, impulse.z, wake ? 1 : 0 );
	}

	getMass(): number {
		return this.native._b3js_Body_GetMass( this.handle );
	}

	/** Recompute mass/inertia from the body's current shapes (needed if any shape used updateBodyMass=false). */
	applyMassFromShapes(): void {
		this.native._b3js_Body_ApplyMassFromShapes( this.handle );
	}

	getMassData(): MassData {
		return withFloatOutBuffer(
			this.native,
			13,
			( ptr ) => this.native._b3js_Body_GetMassData( this.handle, ptr ),
			( f, i ) => ( {
				mass: f[i],
				center: { x: f[i + 1], y: f[i + 2], z: f[i + 3] },
				inertia: {
					cx: { x: f[i + 4], y: f[i + 5], z: f[i + 6] },
					cy: { x: f[i + 7], y: f[i + 8], z: f[i + 9] },
					cz: { x: f[i + 10], y: f[i + 11], z: f[i + 12] },
				},
			} )
		);
	}

	/** Override this body's mass properties. Lost if a shape is added/removed or the body type changes. */
	setMassData( data: MassData ): void {
		this.native._b3js_Body_SetMassData(
			this.handle, data.mass, data.center.x, data.center.y, data.center.z,
			data.inertia.cx.x, data.inertia.cx.y, data.inertia.cx.z,
			data.inertia.cy.x, data.inertia.cy.y, data.inertia.cy.z,
			data.inertia.cz.x, data.inertia.cz.y, data.inertia.cz.z
		);
	}

	/** Center of mass position in body-local space. */
	getLocalCenter(): Vec3 {
		return withFloatOutBuffer(
			this.native,
			3,
			( ptr ) => this.native._b3js_Body_GetLocalCenter( this.handle, ptr ),
			( f, i ) => ( { x: f[i], y: f[i + 1], z: f[i + 2] } )
		);
	}

	setAwake( awake: boolean ): void {
		this.native._b3js_Body_SetAwake( this.handle, awake ? 1 : 0 );
	}

	isAwake(): boolean {
		return this.native._b3js_Body_IsAwake( this.handle ) !== 0;
	}

	enableSleep( enable: boolean ): void {
		this.native._b3js_Body_EnableSleep( this.handle, enable ? 1 : 0 );
	}

	/** Runtime CCD toggle (b3Body_SetBullet, box3d.h) -- creation-time BodyOptions.isBullet already
	 * covers bodies known to need it up front; this lets a runtime-spawned body (e.g. a fast
	 * projectile) opt in afterward. */
	setBullet( flag: boolean ): void {
		this.native._b3js_Body_SetBullet( this.handle, flag ? 1 : 0 );
	}

	isBullet(): boolean {
		return this.native._b3js_Body_IsBullet( this.handle ) !== 0;
	}

	/** Runtime gravity-scale setter (b3Body_SetGravityScale, box3d.h) -- e.g. making a hit prop float
	 * after an explosion. Creation-time BodyOptions.gravityScale already covers the initial value. */
	setGravityScale( gravityScale: number ): void {
		this.native._b3js_Body_SetGravityScale( this.handle, gravityScale );
	}

	getGravityScale(): number {
		return this.native._b3js_Body_GetGravityScale( this.handle );
	}

	setUserData( userData: number ): void {
		this.native._b3js_Body_SetUserData( this.handle, userData );
	}

	getUserData(): number {
		return this.native._b3js_Body_GetUserData( this.handle );
	}

	// ---- Shapes ----

	createSphereShape( options: SphereShapeOptions = {} ): Shape {
		const a = buildSphereArgs( options );
		const handle = this.native._b3js_CreateSphereShape(
			this.handle, a.center.x, a.center.y, a.center.z, a.radius,
			a.density, a.friction, a.restitution, a.rollingResistance,
			a.enableContactEvents ? 1 : 0, a.enableHitEvents ? 1 : 0, a.isSensor ? 1 : 0,
			a.categoryBits, a.maskBits, a.groupIndex, a.userData, a.userMaterialId
		);
		const shape = new Shape( this.native, this.world, handle );
		this.world._trackShape( handle );
		return shape;
	}

	createCapsuleShape( options: CapsuleShapeOptions = {} ): Shape {
		const a = buildCapsuleArgs( options );
		const handle = this.native._b3js_CreateCapsuleShape(
			this.handle, a.center1.x, a.center1.y, a.center1.z, a.center2.x, a.center2.y, a.center2.z, a.radius,
			a.density, a.friction, a.restitution, a.rollingResistance,
			a.enableContactEvents ? 1 : 0, a.enableHitEvents ? 1 : 0, a.isSensor ? 1 : 0,
			a.categoryBits, a.maskBits, a.groupIndex, a.userData, a.userMaterialId
		);
		const shape = new Shape( this.native, this.world, handle );
		this.world._trackShape( handle );
		return shape;
	}

	/** Box collider, built from upstream's b3MakeBoxHull (see src/wasm-shim/binding.c). */
	createBoxShape( options: BoxShapeOptions = {} ): Shape {
		const a = buildBoxArgs( options );
		const handle = this.native._b3js_CreateBoxShape(
			this.handle, a.halfExtents.x, a.halfExtents.y, a.halfExtents.z,
			a.density, a.friction, a.restitution, a.rollingResistance,
			a.enableContactEvents ? 1 : 0, a.enableHitEvents ? 1 : 0, a.isSensor ? 1 : 0,
			a.categoryBits, a.maskBits, a.groupIndex, a.userData, a.userMaterialId
		);
		const shape = new Shape( this.native, this.world, handle );
		this.world._trackShape( handle );
		return shape;
	}

	/** Generic convex hull from a flat (x,y,z)-tuple point array. */
	createHullShape( points: Float32Array, options: ShapeOptions = {} ): Shape {
		const a = buildShapeArgs( options );
		const pointCount = points.length / 3;
		const handle = withInputFloatBuffer( this.native, points, ( ptr ) =>
			this.native._b3js_CreateHullShape(
				this.handle, ptr, pointCount,
				a.density, a.friction, a.restitution, a.rollingResistance,
				a.enableContactEvents ? 1 : 0, a.enableHitEvents ? 1 : 0, a.isSensor ? 1 : 0,
				a.categoryBits, a.maskBits, a.groupIndex, a.userData, a.userMaterialId
			) );
		const shape = new Shape( this.native, this.world, handle );
		this.world._trackShape( handle );
		return shape;
	}

	/**
	 * Static triangle mesh shape. `vertices` is a flat (x,y,z)-tuple array, `indices` is a flat
	 * (i0,i1,i2)-per-triangle array. Intended for static props/terrain created a handful of times,
	 * not per-frame -- see the leak caveat on b3js_CreateMeshShape in src/wasm-shim/binding.c.
	 *
	 * `options.materials` (2+ entries) + `options.materialIndices` (one uint8 per triangle, indexing
	 * into `materials`) wire b3ShapeDef's per-triangle surface material path (types.h) -- e.g. a mud
	 * patch vs asphalt on the one terrain mesh. Omit both for the ordinary single-material shape every
	 * other shape kind uses.
	 */
	createMeshShape( vertices: Float32Array, indices: Int32Array, scale: Vec3 = { x: 1, y: 1, z: 1 },
		options: ShapeOptions & { materials?: MeshMaterialEntry[]; materialIndices?: Uint8Array } = {} ): Shape {
		const a = buildShapeArgs( options );
		const vertexCount = vertices.length / 3;
		const triangleCount = indices.length / 3;
		const flatMaterials = flattenMeshMaterials( options.materials );
		const materialCount = flatMaterials !== undefined ? options.materials!.length : 0;
		const materialIndices = flatMaterials !== undefined ?
			( options.materialIndices ?? new Uint8Array( triangleCount ) ) : new Uint8Array( 0 );

		const handle = withInputFloatBuffer( this.native, vertices, ( verticesPtr ) =>
			withInputInt32Buffer( this.native, indices, ( indicesPtr ) =>
				withInputFloatBuffer( this.native, flatMaterials ?? new Float32Array( 0 ), ( materialsPtr ) =>
					withInputUint8Buffer( this.native, materialIndices, ( materialIndicesPtr ) =>
						this.native._b3js_CreateMeshShape(
							this.handle, verticesPtr, vertexCount, indicesPtr, triangleCount,
							scale.x, scale.y, scale.z,
							a.density, a.friction, a.restitution, a.rollingResistance,
							a.enableContactEvents ? 1 : 0, a.enableHitEvents ? 1 : 0, a.isSensor ? 1 : 0,
							a.categoryBits, a.maskBits, a.groupIndex, a.userData, a.userMaterialId,
							materialsPtr, materialCount, materialIndicesPtr
						) ) ) ) );
		const shape = new Shape( this.native, this.world, handle );
		this.world._trackShape( handle );
		return shape;
	}

	/**
	 * Height field terrain shape. `heights` is row-major, countX*countZ floats. Same "create a
	 * handful of times" caveat as createMeshShape(), and the same optional `materials`/
	 * `materialIndices` per-cell material scheme (materialIndices: one uint8 per cell,
	 * (countX-1)*(countZ-1) of them).
	 */
	createHeightFieldShape( heights: Float32Array, countX: number, countZ: number,
		scale: Vec3 = { x: 1, y: 1, z: 1 }, options: ShapeOptions & { globalMinimumHeight?: number;
			globalMaximumHeight?: number; clockwiseWinding?: boolean; materials?: MeshMaterialEntry[];
			materialIndices?: Uint8Array } = {} ): Shape {
		const a = buildShapeArgs( options );
		let min = options.globalMinimumHeight;
		let max = options.globalMaximumHeight;
		if ( min === undefined || max === undefined ) {
			min = Infinity;
			max = -Infinity;
			for ( let i = 0; i < heights.length; i++ ) {
				if ( heights[i] < min ) min = heights[i];
				if ( heights[i] > max ) max = heights[i];
			}
			if ( min > max ) {
				min = 0;
				max = 0;
			}
		}
		const cellCount = ( countX - 1 ) * ( countZ - 1 );
		const flatMaterials = flattenMeshMaterials( options.materials );
		const materialCount = flatMaterials !== undefined ? options.materials!.length : 0;
		const materialIndices = flatMaterials !== undefined ?
			( options.materialIndices ?? new Uint8Array( Math.max( cellCount, 0 ) ) ) : new Uint8Array( 0 );

		const handle = withInputFloatBuffer( this.native, heights, ( ptr ) =>
			withInputFloatBuffer( this.native, flatMaterials ?? new Float32Array( 0 ), ( materialsPtr ) =>
				withInputUint8Buffer( this.native, materialIndices, ( materialIndicesPtr ) =>
					this.native._b3js_CreateHeightFieldShape(
						this.handle, ptr, countX, countZ, scale.x, scale.y, scale.z, min!, max!,
						options.clockwiseWinding ? 1 : 0,
						a.density, a.friction, a.restitution, a.rollingResistance,
						a.enableContactEvents ? 1 : 0, a.enableHitEvents ? 1 : 0, a.isSensor ? 1 : 0,
						a.categoryBits, a.maskBits, a.groupIndex, a.userData, a.userMaterialId,
						materialsPtr, materialCount, materialIndicesPtr
					) ) ) );
		const shape = new Shape( this.native, this.world, handle );
		this.world._trackShape( handle );
		return shape;
	}

	destroy(): void {
		if ( this.destroyed ) {
			throw new Error( "box3d-js: Body already destroyed" );
		}
		this.destroyed = true;
		unregisterHandle( this.handle, "body" );
		this.world._untrackBody( this.handle );
		this.native._b3js_DestroyBody( this.handle );
	}
}

export function defaultBodyOptions( options: BodyOptions ) {
	return {
		type: options.type ?? BodyType.Dynamic,
		position: options.position ?? VEC3_ZERO,
		rotation: options.rotation ?? QUAT_IDENTITY,
		linearDamping: options.linearDamping ?? 0,
		angularDamping: options.angularDamping ?? 0,
		gravityScale: options.gravityScale ?? 1,
		enableSleep: options.enableSleep ?? true,
		isBullet: options.isBullet ?? false,
		allowFastRotation: options.allowFastRotation ?? false,
		userData: options.userData ?? 0,
	};
}
