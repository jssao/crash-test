// SPDX-License-Identifier: MIT

import type { Native } from "./native.js";
import type { World } from "./world.js";
import { registerHandle, unregisterHandle } from "./registry.js";
import { DEFAULT_CATEGORY_BITS, DEFAULT_MASK_BITS, VEC3_ZERO, type Vec3 } from "./math.js";

/** Mirrors b3Filter (box3d/types.h): categoryBits/maskBits (uint64) + groupIndex (int32). */
export interface ShapeFilter {
	categoryBits: bigint;
	maskBits: bigint;
	groupIndex: number;
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
