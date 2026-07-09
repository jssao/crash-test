// SPDX-License-Identifier: MIT
//
// box3d-js public entry point.
//
// Usage:
//
//   import { init, World, BodyType } from "box3d-js";
//
//   const native = await init();             // loads build/wasm/box3d.mjs (path configurable)
//   const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
//   const ground = world.createBody({ type: BodyType.Static });
//   ground.createBoxShape({ halfExtents: { x: 10, y: 0.5, z: 10 } });
//   const box = world.createBody({ position: { x: 0, y: 5, z: 0 } });
//   box.createBoxShape();
//   world.step(1 / 60);
//   for (let i = 0; i < world.moveEvents().count; i++) { /* ... */ }
//   world.destroy();
//
// See src/ts/math.ts for the up-axis/quaternion/units conventions this binding follows.

export { init } from "./native.js";
export type { Native, InitOptions, Box3DFactory } from "./native.js";

export {
	VEC3_ZERO,
	QUAT_IDENTITY,
	TRANSFORM_IDENTITY,
	DEFAULT_GRAVITY,
	DEFAULT_CATEGORY_BITS,
	DEFAULT_MASK_BITS,
} from "./math.js";
export type { Vec3, Quat, Transform, Matrix3 } from "./math.js";

export { World } from "./world.js";
export type { WorldOptions, RayCastOptions } from "./world.js";

export { Body, BodyType, defaultBodyOptions } from "./body.js";
export type { BodyOptions, RayCastResult, MassData } from "./body.js";

export { Shape } from "./shape.js";
export type { ShapeOptions, SphereShapeOptions, CapsuleShapeOptions, BoxShapeOptions } from "./shape.js";

export { Joint, WeldJoint, WheelJoint, RevoluteJoint, DistanceJoint } from "./joint.js";
export type {
	JointFrame,
	JointOptionsBase,
	WeldJointOptions,
	WheelJointOptions,
	RevoluteJointOptions,
	DistanceJointOptions,
} from "./joint.js";

export { MoveEventsView, HitEventsView, JointEventsView } from "./events.js";
export type { MoveEventCursor, HitEventCursor, JointEventCursor } from "./events.js";

export {
	registerHandle,
	unregisterHandle,
	forgetHandle,
	isHandleLive,
	liveHandleCount,
} from "./registry.js";
export type { HandleKind } from "./registry.js";
