// SPDX-License-Identifier: MIT
//
// Plain {x,y,z}/{x,y,z,w} vector-quaternion math for the vehicle physics core. Deliberately does
// NOT import three -- see the module doc on vehicle.ts: the physics core must stay renderer-free so
// game/sim/harness.mjs (plain node, no three/DOM) can share it verbatim.

export interface V3 {
	x: number;
	y: number;
	z: number;
}

export interface Q4 {
	x: number;
	y: number;
	z: number;
	w: number;
}

export const ZERO: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 0 });
export const IDENTITY_Q: Readonly<Q4> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

export function add(a: V3, b: V3): V3 {
	return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: V3, b: V3): V3 {
	return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: V3, s: number): V3 {
	return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: V3, b: V3): number {
	return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: V3, b: V3): V3 {
	return {
		x: a.y * b.z - a.z * b.y,
		y: a.z * b.x - a.x * b.z,
		z: a.x * b.y - a.y * b.x,
	};
}

export function length(a: V3): number {
	return Math.sqrt(dot(a, a));
}

export function normalize(a: V3): V3 {
	const len = length(a);
	if (len < 1e-9) return { x: 0, y: 0, z: 0 };
	return scale(a, 1 / len);
}

/** Quaternion (x,y,z,w) representing a rotation of `angleRad` about the given (unit) axis. */
export function quatFromAxisAngle(axis: V3, angleRad: number): Q4 {
	const half = angleRad / 2;
	const s = Math.sin(half);
	return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
}

/** Rotate a vector by a quaternion (standard v' = q * v * q^-1, expanded). */
export function rotateVector(q: Q4, v: V3): V3 {
	// t = 2 * cross(q.xyz, v)
	const qv = { x: q.x, y: q.y, z: q.z };
	const t = scale(cross(qv, v), 2);
	// v' = v + q.w * t + cross(q.xyz, t)
	return add(add(v, scale(t, q.w)), cross(qv, t));
}

export function multiplyQuat(a: Q4, b: Q4): Q4 {
	return {
		x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	};
}

export function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * clamp(t, 0, 1);
}

/** Local chassis-space unit axes, matching car-map.ts's axis convention (Y-up, X-right, Z-forward). */
export const LOCAL_RIGHT: Readonly<V3> = Object.freeze({ x: 1, y: 0, z: 0 });
export const LOCAL_UP: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });
export const LOCAL_FORWARD: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 1 });

/**
 * Wheel-joint frame A (on the chassis) rotation. box3d's wheel joint (vendor/box3d/src/wheel_joint.c)
 * uses frame A's basis for THREE things at once:
 *   - suspension translates along frame A's local X axis (matrixA.cx)
 *   - steering rotates about frame A's local X axis too (the strut/kingpin axis does double duty,
 *     matching a simplified MacPherson-strut kinematic: same axis for damper travel and steer pivot)
 *   - the steering angle itself is measured as the angle between frame B's spin axis (matrixB.cz)
 *     and frame A's local Z axis (matrixA.cz), within the plane frame A's Y/Z span
 * So frame A's local basis must map: X -> chassis "up", Z -> chassis "lateral" (matching the wheel's
 * unsteered spin axis, see WHEEL_FRAME_B_ROTATION below), and (by right-handed orthonormality) then
 * Y -> chassis "forward". That's the axis-cyclic rotation X->Y->Z->X composed to hit (up, forward,
 * lateral) for (X,Y,Z) respectively: a 120 degree rotation about the (1,1,1) axis, which works out to
 * the exact quaternion (0.5, 0.5, 0.5, 0.5) -- verified numerically (see game/sim's harness dev notes)
 * rather than assumed: rotateVector(q, X)=up, rotateVector(q, Y)=forward, rotateVector(q, Z)=lateral.
 */
export const WHEEL_FRAME_A_ROTATION: Readonly<Q4> = Object.freeze({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });

/**
 * Wheel-joint frame B (on the wheel body) rotation so that frame B's local +Z axis (the joint's
 * spin axis) maps to the wheel body's local +X (the lateral/axle direction, matching the chassis's
 * local +X since wheel bodies spawn with identity rotation): a +90 degree rotation about local Y.
 */
export const WHEEL_FRAME_B_ROTATION: Readonly<Q4> = Object.freeze(quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2));
