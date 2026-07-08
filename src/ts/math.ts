// SPDX-License-Identifier: MIT
//
// Shared math types + the coordinate/quaternion conventions this binding follows.
//
// UP-AXIS / HANDEDNESS: Box3D itself declares no fixed up-vector (see b3WorldDef's doc comment in
// vendor/box3d/include/box3d/types.h: "Gravity vector. Box3D has no up-vector defined."). In
// practice, though, upstream's own b3DefaultWorldDef() sets gravity = (0, -10, 0) -- see
// vendor/box3d/src/types.c -- i.e. **Y-up, gravity along -Y**, matching Three.js's convention
// exactly. This wrapper's WorldOptions.gravity defaults to the same (0, -10, 0).
//
// QUATERNION LAYOUT: b3Quat is `{ v: {x,y,z}, s }` (vector part + scalar part). That maps directly
// onto `THREE.Quaternion(x, y, z, w)` with `w = s` -- no component reordering or sign flips needed.
// All quaternions crossing this binding are `{x,y,z,w}` using that mapping.
//
// PRECISION / UNITS: the wasm build is single precision (BOX3D_DOUBLE_PRECISION=OFF, see
// scripts/wasm/CMakeLists.txt) with the default length-units-per-meter (1.0), so positions are plain
// float meters -- also matching Three.js's usual convention.

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

export interface Quat {
	x: number;
	y: number;
	z: number;
	w: number;
}

export interface Transform {
	position: Vec3;
	rotation: Quat;
}

export const VEC3_ZERO: Readonly<Vec3> = Object.freeze( { x: 0, y: 0, z: 0 } );
export const QUAT_IDENTITY: Readonly<Quat> = Object.freeze( { x: 0, y: 0, z: 0, w: 1 } );
export const TRANSFORM_IDENTITY: Readonly<Transform> = Object.freeze( {
	position: VEC3_ZERO,
	rotation: QUAT_IDENTITY,
} );

/** Default world gravity, matching upstream's b3DefaultWorldDef() (Y-up, see module doc above). */
export const DEFAULT_GRAVITY: Readonly<Vec3> = Object.freeze( { x: 0, y: -10, z: 0 } );

/**
 * b3Filter defaults -- upstream's b3DefaultFilter() sets categoryBits = maskBits = UINT64_MAX (see
 * B3_DEFAULT_CATEGORY_BITS / B3_DEFAULT_MASK_BITS in box3d/types.h): collide with everything,
 * belong to every category, until the caller narrows it down.
 */
export const DEFAULT_CATEGORY_BITS = 0xffffffffffffffffn;
export const DEFAULT_MASK_BITS = 0xffffffffffffffffn;
