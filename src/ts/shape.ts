// SPDX-License-Identifier: MIT

import type { Native } from "./native.js";
import type { World } from "./world.js";
import { registerHandle, unregisterHandle } from "./registry.js";
import { withFloatOutBuffer } from "./scratch.js";
import { DEFAULT_CATEGORY_BITS, DEFAULT_MASK_BITS, VEC3_ZERO, type Vec3 } from "./math.js";

/** Mirrors b3Filter (box3d/types.h): categoryBits/maskBits (uint64) + groupIndex (int32). */
export interface ShapeFilter {
	categoryBits: bigint;
	maskBits: bigint;
	groupIndex: number;
}

/**
 * Mirrors b3SurfaceMaterial (box3d/types.h): friction, restitution, rollingResistance (spheres/
 * capsules only), tangentVelocity (conveyor-belt surface speed, projected onto the contact plane),
 * and userMaterialId (an opaque application tag -- arrives back on hit events, see
 * HitEventCursor.userMaterialIdA/B in events.ts). `customColor` (debug-draw only) is intentionally
 * not exposed -- see Shape.setSurfaceMaterial()'s doc comment.
 */
export interface SurfaceMaterial {
	friction: number;
	restitution: number;
	rollingResistance: number;
	tangentVelocity: Vec3;
	/** Opaque application tag, e.g. for surface-typed impact audio (metal vs concrete vs glass). */
	userMaterialId: bigint;
}

/** A single entry in a mesh/height-field shape's per-triangle material array (see
 * MeshShapeOptions.materials / HeightFieldShapeOptions.materials). Only friction/restitution/
 * rollingResistance are settable at creation time -- tangentVelocity/userMaterialId per entry can be
 * set afterward via Shape.setMeshMaterial(index, ...) once the shape exists. */
export interface MeshMaterialEntry {
	friction?: number;
	restitution?: number;
	rollingResistance?: number;
}

/** Common fields shared by every shape type. Mirrors b3ShapeDef's scalar fields (box3d/types.h). */
export interface ShapeOptions {
	/** kg/m^3. Default 1000 (water), matching b3DefaultShapeDef(). */
	density?: number;
	/** Coulomb friction, [0,1] typical. Default 0.6, matching b3DefaultSurfaceMaterial(). */
	friction?: number;
	/** Restitution (bounciness), [0,1] typical. Default 0. */
	restitution?: number;
	/** Only used for spheres/capsules. Default 0. */
	rollingResistance?: number;
	/** Populate world.hitEvents()/contact touch bookkeeping for this shape's contacts. Default false. */
	enableContactEvents?: boolean;
	/** Populate world.hitEvents() for this shape. Default false. */
	enableHitEvents?: boolean;
	/** Overlap-only, no collision response. Default false. */
	isSensor?: boolean;
	/** Default: all bits set (collides with / belongs to every category), matching b3DefaultFilter(). */
	categoryBits?: bigint;
	maskBits?: bigint;
	groupIndex?: number;
	/** Entity id tag. Falls back to the owning body's userData for event resolution if left at 0. */
	userData?: number;
	/** b3SurfaceMaterial.userMaterialId (types.h) -- an opaque application tag that arrives back on
	 * hit events (see HitEventCursor.userMaterialIdA/B, events.ts). Default 0n. */
	userMaterialId?: bigint;
}

function shapeDefaults( options: ShapeOptions ) {
	return {
		density: options.density ?? 1000,
		friction: options.friction ?? 0.6,
		restitution: options.restitution ?? 0,
		rollingResistance: options.rollingResistance ?? 0,
		enableContactEvents: options.enableContactEvents ?? false,
		enableHitEvents: options.enableHitEvents ?? false,
		isSensor: options.isSensor ?? false,
		categoryBits: options.categoryBits ?? DEFAULT_CATEGORY_BITS,
		maskBits: options.maskBits ?? DEFAULT_MASK_BITS,
		groupIndex: options.groupIndex ?? 0,
		userData: options.userData ?? 0,
		userMaterialId: options.userMaterialId ?? 0n,
	};
}

export interface SphereShapeOptions extends ShapeOptions {
	center?: Vec3;
	radius?: number;
}

export interface CapsuleShapeOptions extends ShapeOptions {
	center1?: Vec3;
	center2?: Vec3;
	radius?: number;
}

export interface BoxShapeOptions extends ShapeOptions {
	/** Half-widths along x/y/z. Default {x:0.5,y:0.5,z:0.5} (a 1m cube). */
	halfExtents?: Vec3;
}

/** A handle to a shape attached to a body. Create via Body.create*Shape(); destroy via .destroy(). */
export class Shape {
	private destroyed = false;

	/** @internal use Body.create*Shape() instead. */
	constructor( private readonly native: Native, private readonly world: World, readonly handle: bigint ) {
		registerHandle( handle, "shape" );
	}

	isValid(): boolean {
		return this.native._b3js_Shape_IsValid( this.handle ) !== 0;
	}

	setUserData( userData: number ): void {
		this.native._b3js_Shape_SetUserData( this.handle, userData );
	}

	getUserData(): number {
		return this.native._b3js_Shape_GetUserData( this.handle );
	}

	enableContactEvents( flag: boolean ): void {
		this.native._b3js_Shape_EnableContactEvents( this.handle, flag ? 1 : 0 );
	}

	enableHitEvents( flag: boolean ): void {
		this.native._b3js_Shape_EnableHitEvents( this.handle, flag ? 1 : 0 );
	}

	/**
	 * Changes this shape's collision filter after creation (b3Shape_SetFilter's own doc comment:
	 * "almost as expensive as recreating the shape"). Needed e.g. to flip a ragdoll occupant from
	 * "no-collide with car interior" to "collide with everything" on ejection.
	 * @param invokeContacts if true, recompute this shape's contacts against the new filter on the
	 * next step (expensive -- only needed if overlapping bodies should immediately react). Default false.
	 */
	setFilter( filter: ShapeFilter, invokeContacts = false ): void {
		this.native._b3js_Shape_SetFilter( this.handle, filter.categoryBits, filter.maskBits, filter.groupIndex,
			invokeContacts ? 1 : 0 );
	}

	getFilter(): ShapeFilter {
		return {
			categoryBits: this.native._b3js_Shape_GetFilterCategoryBits( this.handle ),
			maskBits: this.native._b3js_Shape_GetFilterMaskBits( this.handle ),
			groupIndex: this.native._b3js_Shape_GetFilterGroupIndex( this.handle ),
		};
	}

	/** Runtime friction setter (b3Shape_SetFriction, box3d.h) -- distinct from setSurfaceMaterial()
	 * below (which overwrites the whole material); this only touches friction. */
	setFriction( friction: number ): void {
		this.native._b3js_Shape_SetFriction( this.handle, friction );
	}

	getFriction(): number {
		return this.native._b3js_Shape_GetFriction( this.handle );
	}

	/** Runtime restitution (bounciness) setter (b3Shape_SetRestitution, box3d.h). */
	setRestitution( restitution: number ): void {
		this.native._b3js_Shape_SetRestitution( this.handle, restitution );
	}

	getRestitution(): number {
		return this.native._b3js_Shape_GetRestitution( this.handle );
	}

	/**
	 * Overwrites this shape's base surface material (friction, restitution, rollingResistance,
	 * tangentVelocity, userMaterialId) in one call -- e.g. a mid-session wet-road/ice grip change, or
	 * tagging a shape's userMaterialId after creation. `customColor` (debug-draw only) is left
	 * untouched -- see b3js_Shape_SetSurfaceMaterial's doc comment, src/wasm-shim/binding.c.
	 */
	setSurfaceMaterial( material: SurfaceMaterial ): void {
		this.native._b3js_Shape_SetSurfaceMaterial(
			this.handle, material.friction, material.restitution, material.rollingResistance,
			material.tangentVelocity.x, material.tangentVelocity.y, material.tangentVelocity.z,
			material.userMaterialId
		);
	}

	getSurfaceMaterial(): SurfaceMaterial {
		let userMaterialId = 0n;
		return withFloatOutBuffer(
			this.native, 6,
			( ptr ) => { userMaterialId = this.native._b3js_Shape_GetSurfaceMaterial( this.handle, ptr ); },
			( f, i ) => ( {
				friction: f[i], restitution: f[i + 1], rollingResistance: f[i + 2],
				tangentVelocity: { x: f[i + 3], y: f[i + 4], z: f[i + 5] },
				userMaterialId,
			} )
		);
	}

	/** Number of per-triangle materials on a mesh/height-field shape (always >= 1 -- see
	 * MeshShapeOptions.materials/HeightFieldShapeOptions.materials). Index 0 always exists (and
	 * aliases the base material) even on shapes created without per-triangle materials. */
	getMeshMaterialCount(): number {
		return this.native._b3js_Shape_GetMeshMaterialCount( this.handle );
	}

	/**
	 * Sets the surface material at `index` on a mesh/height-field shape created with 2+ materials
	 * (MeshShapeOptions.materials/HeightFieldShapeOptions.materials) -- or index 0 on any shape.
	 * @param index MUST be < getMeshMaterialCount() -- box3d's own bounds check on this is compiled
	 * out in this Release build (see b3js_Shape_SetMeshMaterial's doc comment, binding.c), so an
	 * out-of-range index is a real memory-safety hazard, not just a thrown error.
	 */
	setMeshMaterial( index: number, material: SurfaceMaterial ): void {
		this.native._b3js_Shape_SetMeshMaterial(
			this.handle, index, material.friction, material.restitution, material.rollingResistance,
			material.tangentVelocity.x, material.tangentVelocity.y, material.tangentVelocity.z,
			material.userMaterialId
		);
	}

	/** @param index see setMeshMaterial()'s bounds-safety warning -- the same applies here. */
	getMeshSurfaceMaterial( index: number ): SurfaceMaterial {
		let userMaterialId = 0n;
		return withFloatOutBuffer(
			this.native, 6,
			( ptr ) => { userMaterialId = this.native._b3js_Shape_GetMeshSurfaceMaterial( this.handle, index, ptr ); },
			( f, i ) => ( {
				friction: f[i], restitution: f[i + 1], rollingResistance: f[i + 2],
				tangentVelocity: { x: f[i + 3], y: f[i + 4], z: f[i + 5] },
				userMaterialId,
			} )
		);
	}

	/** @param updateBodyMass recompute the owning body's mass from its remaining shapes (default true). */
	destroy( updateBodyMass = true ): void {
		if ( this.destroyed ) {
			throw new Error( "box3d-js: Shape already destroyed" );
		}
		this.destroyed = true;
		unregisterHandle( this.handle, "shape" );
		this.world._untrackShape( this.handle );
		this.native._b3js_DestroyShape( this.handle, updateBodyMass ? 1 : 0 );
	}
}

/** @internal shared by Body's create*Shape() methods. */
export function buildSphereArgs( options: SphereShapeOptions ) {
	const d = shapeDefaults( options );
	const center = options.center ?? VEC3_ZERO;
	return { center, radius: options.radius ?? 0.5, ...d };
}

export function buildCapsuleArgs( options: CapsuleShapeOptions ) {
	const d = shapeDefaults( options );
	const center1 = options.center1 ?? { x: 0, y: -0.5, z: 0 };
	const center2 = options.center2 ?? { x: 0, y: 0.5, z: 0 };
	return { center1, center2, radius: options.radius ?? 0.5, ...d };
}

export function buildBoxArgs( options: BoxShapeOptions ) {
	const d = shapeDefaults( options );
	const halfExtents = options.halfExtents ?? { x: 0.5, y: 0.5, z: 0.5 };
	return { halfExtents, ...d };
}

export function buildShapeArgs( options: ShapeOptions ) {
	return shapeDefaults( options );
}
