// SPDX-License-Identifier: MIT
//
// Low-level Emscripten module loader for box3d.wasm.
//
// This is NOT the ergonomic API -- see world.ts/body.ts/shape.ts/joint.ts for the classes games
// actually use. This file only loads the Emscripten-generated ES module and types its raw exports.
//
// Handle ABI: every Box3D handle (world/body/shape/joint) crosses this boundary as a JS `bigint`,
// because the wasm module is built with -sWASM_BIGINT (scripts/wasm/CMakeLists.txt) and the shim
// (src/wasm-shim/binding.c) bit-casts each id struct into a `uint64_t`. Pointers (out-buffers, event
// array addresses) are plain `number` byte offsets into the module's linear memory. The raw
// `_b3js_*` exports are called directly (no cwrap layer) -- Emscripten already attaches every name
// listed in scripts/exports.json straight onto the module object, so this is just a typed view over
// them.

/** The subset of the Emscripten module surface this binding depends on. */
export interface Native {
	HEAP8: Int8Array;
	HEAPU8: Uint8Array;
	HEAP32: Int32Array;
	HEAPU32: Uint32Array;
	HEAPF32: Float32Array;
	_malloc( size: number ): number;
	_free( ptr: number ): void;

	// ---- World ----
	_b3js_CreateWorld( gx: number, gy: number, gz: number, hitEventThreshold: number, contactHertz: number,
		contactDampingRatio: number, enableSleep: number, enableContinuous: number ): bigint;
	_b3js_DestroyWorld( worldId: bigint ): void;
	_b3js_World_IsValid( worldId: bigint ): number;
	_b3js_Step( worldId: bigint, dt: number, subStepCount: number ): void;
	_b3js_World_SetGravity( worldId: bigint, gx: number, gy: number, gz: number ): void;
	_b3js_World_GetGravity( worldId: bigint, outPtr: number ): void;
	_b3js_GetMoveEventsPtr( worldId: bigint ): number;
	_b3js_GetMoveEventsCount( worldId: bigint ): number;
	_b3js_GetHitEventsPtr( worldId: bigint ): number;
	_b3js_GetHitEventsCount( worldId: bigint ): number;
	_b3js_GetJointEventsPtr( worldId: bigint ): number;
	_b3js_GetJointEventsCount( worldId: bigint ): number;
	_b3js_CastRayClosest( worldId: bigint, ox: number, oy: number, oz: number, tx: number, ty: number, tz: number,
		categoryBits: bigint, maskBits: bigint, outPtr: number ): number;

	// ---- Body ----
	_b3js_CreateBody( worldId: bigint, type: number, px: number, py: number, pz: number, qx: number, qy: number,
		qz: number, qw: number, linearDamping: number, angularDamping: number, gravityScale: number,
		enableSleep: number, isBullet: number, allowFastRotation: number, userData: number ): bigint;
	_b3js_DestroyBody( bodyId: bigint ): void;
	_b3js_Body_IsValid( bodyId: bigint ): number;
	_b3js_Body_GetTransform( bodyId: bigint, outPtr: number ): void;
	_b3js_Body_SetTransform( bodyId: bigint, px: number, py: number, pz: number, qx: number, qy: number, qz: number,
		qw: number ): void;
	_b3js_Body_GetLinearVelocity( bodyId: bigint, outPtr: number ): void;
	_b3js_Body_SetLinearVelocity( bodyId: bigint, x: number, y: number, z: number ): void;
	_b3js_Body_GetAngularVelocity( bodyId: bigint, outPtr: number ): void;
	_b3js_Body_SetAngularVelocity( bodyId: bigint, x: number, y: number, z: number ): void;
	_b3js_Body_ApplyForce( bodyId: bigint, fx: number, fy: number, fz: number, px: number, py: number, pz: number,
		wake: number ): void;
	_b3js_Body_ApplyForceToCenter( bodyId: bigint, fx: number, fy: number, fz: number, wake: number ): void;
	_b3js_Body_ApplyTorque( bodyId: bigint, tx: number, ty: number, tz: number, wake: number ): void;
	_b3js_Body_ApplyLinearImpulse( bodyId: bigint, ix: number, iy: number, iz: number, px: number, py: number,
		pz: number, wake: number ): void;
	_b3js_Body_ApplyLinearImpulseToCenter( bodyId: bigint, ix: number, iy: number, iz: number, wake: number ): void;
	_b3js_Body_ApplyAngularImpulse( bodyId: bigint, ix: number, iy: number, iz: number, wake: number ): void;
	_b3js_Body_GetMass( bodyId: bigint ): number;
	_b3js_Body_ApplyMassFromShapes( bodyId: bigint ): void;
	_b3js_Body_GetMassData( bodyId: bigint, outPtr: number ): void;
	_b3js_Body_SetMassData( bodyId: bigint, mass: number, centerX: number, centerY: number, centerZ: number,
		cxX: number, cxY: number, cxZ: number, cyX: number, cyY: number, cyZ: number, czX: number, czY: number,
		czZ: number ): void;
	_b3js_Body_GetLocalCenter( bodyId: bigint, outPtr: number ): void;
	_b3js_Body_SetAwake( bodyId: bigint, awake: number ): void;
	_b3js_Body_IsAwake( bodyId: bigint ): number;
	_b3js_Body_EnableSleep( bodyId: bigint, enable: number ): void;
	_b3js_Body_SetUserData( bodyId: bigint, userData: number ): void;
	_b3js_Body_GetUserData( bodyId: bigint ): number;

	// ---- Shapes ----
	_b3js_CreateSphereShape( bodyId: bigint, cx: number, cy: number, cz: number, radius: number, density: number,
		friction: number, restitution: number, rollingResistance: number, enableContactEvents: number,
		enableHitEvents: number, isSensor: number, categoryBits: bigint, maskBits: bigint, groupIndex: number,
		userData: number ): bigint;
	_b3js_CreateCapsuleShape( bodyId: bigint, c1x: number, c1y: number, c1z: number, c2x: number, c2y: number,
		c2z: number, radius: number, density: number, friction: number, restitution: number,
		rollingResistance: number, enableContactEvents: number, enableHitEvents: number, isSensor: number,
		categoryBits: bigint, maskBits: bigint, groupIndex: number, userData: number ): bigint;
	_b3js_CreateBoxShape( bodyId: bigint, hx: number, hy: number, hz: number, density: number, friction: number,
		restitution: number, rollingResistance: number, enableContactEvents: number, enableHitEvents: number,
		isSensor: number, categoryBits: bigint, maskBits: bigint, groupIndex: number, userData: number ): bigint;
	_b3js_CreateHullShape( bodyId: bigint, pointsPtr: number, pointCount: number, density: number, friction: number,
		restitution: number, rollingResistance: number, enableContactEvents: number, enableHitEvents: number,
		isSensor: number, categoryBits: bigint, maskBits: bigint, groupIndex: number, userData: number ): bigint;
	_b3js_CreateMeshShape( bodyId: bigint, verticesPtr: number, vertexCount: number, indicesPtr: number,
		triangleCount: number, sx: number, sy: number, sz: number, density: number, friction: number,
		restitution: number, rollingResistance: number, enableContactEvents: number, enableHitEvents: number,
		isSensor: number, categoryBits: bigint, maskBits: bigint, groupIndex: number, userData: number ): bigint;
	_b3js_CreateHeightFieldShape( bodyId: bigint, heightsPtr: number, countX: number, countZ: number, sx: number,
		sy: number, sz: number, globalMin: number, globalMax: number, clockwise: number, density: number,
		friction: number, restitution: number, rollingResistance: number, enableContactEvents: number,
		enableHitEvents: number, isSensor: number, categoryBits: bigint, maskBits: bigint, groupIndex: number,
		userData: number ): bigint;
	_b3js_DestroyShape( shapeId: bigint, updateBodyMass: number ): void;
	_b3js_Shape_IsValid( shapeId: bigint ): number;
	_b3js_Shape_SetUserData( shapeId: bigint, userData: number ): void;
	_b3js_Shape_GetUserData( shapeId: bigint ): number;
	_b3js_Shape_EnableContactEvents( shapeId: bigint, flag: number ): void;
	_b3js_Shape_EnableHitEvents( shapeId: bigint, flag: number ): void;
	_b3js_Shape_SetFilter( shapeId: bigint, categoryBits: bigint, maskBits: bigint, groupIndex: number,
		invokeContacts: number ): void;
	_b3js_Shape_GetFilterCategoryBits( shapeId: bigint ): bigint;
	_b3js_Shape_GetFilterMaskBits( shapeId: bigint ): bigint;
	_b3js_Shape_GetFilterGroupIndex( shapeId: bigint ): number;

	// ---- Joints (common) ----
	_b3js_DestroyJoint( jointId: bigint, wakeAttached: number ): void;
	_b3js_Joint_IsValid( jointId: bigint ): number;
	_b3js_Joint_GetConstraintForce( jointId: bigint, outPtr: number ): void;
	_b3js_Joint_GetConstraintTorque( jointId: bigint, outPtr: number ): void;
	_b3js_Joint_SetUserData( jointId: bigint, userData: number ): void;
	_b3js_Joint_GetUserData( jointId: bigint ): number;
	_b3js_Joint_SetForceThreshold( jointId: bigint, threshold: number ): void;
	_b3js_Joint_GetForceThreshold( jointId: bigint ): number;
	_b3js_Joint_SetTorqueThreshold( jointId: bigint, threshold: number ): void;
	_b3js_Joint_GetTorqueThreshold( jointId: bigint ): number;

	// ---- Weld joint ----
	_b3js_CreateWeldJoint( worldId: bigint, bodyA: bigint, bodyB: bigint, faPx: number, faPy: number, faPz: number,
		faQx: number, faQy: number, faQz: number, faQw: number, fbPx: number, fbPy: number, fbPz: number,
		fbQx: number, fbQy: number, fbQz: number, fbQw: number, collideConnected: number, linearHertz: number,
		angularHertz: number, linearDampingRatio: number, angularDampingRatio: number, userData: number ): bigint;
	_b3js_WeldJoint_SetLinearHertz( jointId: bigint, hertz: number ): void;
	_b3js_WeldJoint_SetAngularHertz( jointId: bigint, hertz: number ): void;
	_b3js_WeldJoint_SetLinearDampingRatio( jointId: bigint, dampingRatio: number ): void;
	_b3js_WeldJoint_SetAngularDampingRatio( jointId: bigint, dampingRatio: number ): void;

	// ---- Spherical joint ----
	_b3js_CreateSphericalJoint( worldId: bigint, bodyA: bigint, bodyB: bigint, faPx: number, faPy: number,
		faPz: number, faQx: number, faQy: number, faQz: number, faQw: number, fbPx: number, fbPy: number,
		fbPz: number, fbQx: number, fbQy: number, fbQz: number, fbQw: number, collideConnected: number,
		enableSpring: number, hertz: number, dampingRatio: number, targetRotQx: number, targetRotQy: number,
		targetRotQz: number, targetRotQw: number, enableConeLimit: number, coneAngle: number,
		enableTwistLimit: number, lowerTwistAngle: number, upperTwistAngle: number, enableMotor: number,
		maxMotorTorque: number, motorVelX: number, motorVelY: number, motorVelZ: number, userData: number ): bigint;
	_b3js_SphericalJoint_EnableConeLimit( jointId: bigint, flag: number ): void;
	_b3js_SphericalJoint_IsConeLimitEnabled( jointId: bigint ): number;
	_b3js_SphericalJoint_GetConeLimit( jointId: bigint ): number;
	_b3js_SphericalJoint_SetConeLimit( jointId: bigint, angleRadians: number ): void;
	_b3js_SphericalJoint_GetConeAngle( jointId: bigint ): number;
	_b3js_SphericalJoint_EnableTwistLimit( jointId: bigint, flag: number ): void;
	_b3js_SphericalJoint_IsTwistLimitEnabled( jointId: bigint ): number;
	_b3js_SphericalJoint_GetLowerTwistLimit( jointId: bigint ): number;
	_b3js_SphericalJoint_GetUpperTwistLimit( jointId: bigint ): number;
	_b3js_SphericalJoint_SetTwistLimits( jointId: bigint, lower: number, upper: number ): void;
	_b3js_SphericalJoint_GetTwistAngle( jointId: bigint ): number;
	_b3js_SphericalJoint_EnableSpring( jointId: bigint, flag: number ): void;
	_b3js_SphericalJoint_IsSpringEnabled( jointId: bigint ): number;
	_b3js_SphericalJoint_SetSpringHertz( jointId: bigint, hertz: number ): void;
	_b3js_SphericalJoint_GetSpringHertz( jointId: bigint ): number;
	_b3js_SphericalJoint_SetSpringDampingRatio( jointId: bigint, dampingRatio: number ): void;
	_b3js_SphericalJoint_GetSpringDampingRatio( jointId: bigint ): number;
	_b3js_SphericalJoint_SetTargetRotation( jointId: bigint, qx: number, qy: number, qz: number, qw: number ): void;
	_b3js_SphericalJoint_GetTargetRotation( jointId: bigint, outPtr: number ): void;
	_b3js_SphericalJoint_EnableMotor( jointId: bigint, flag: number ): void;
	_b3js_SphericalJoint_IsMotorEnabled( jointId: bigint ): number;
	_b3js_SphericalJoint_SetMotorVelocity( jointId: bigint, x: number, y: number, z: number ): void;
	_b3js_SphericalJoint_GetMotorVelocity( jointId: bigint, outPtr: number ): void;
	_b3js_SphericalJoint_GetMotorTorque( jointId: bigint, outPtr: number ): void;
	_b3js_SphericalJoint_SetMaxMotorTorque( jointId: bigint, torque: number ): void;
	_b3js_SphericalJoint_GetMaxMotorTorque( jointId: bigint ): number;

	// ---- Wheel joint ----
	_b3js_CreateWheelJoint( worldId: bigint, bodyChassis: bigint, bodyWheel: bigint, faPx: number, faPy: number,
		faPz: number, faQx: number, faQy: number, faQz: number, faQw: number, fbPx: number, fbPy: number,
		fbPz: number, fbQx: number, fbQy: number, fbQz: number, fbQw: number, collideConnected: number,
		enableSuspensionSpring: number, suspensionHertz: number, suspensionDampingRatio: number,
		enableSuspensionLimit: number, lowerSuspensionLimit: number, upperSuspensionLimit: number,
		enableSpinMotor: number, maxSpinTorque: number, spinSpeed: number, enableSteering: number,
		steeringHertz: number, steeringDampingRatio: number, targetSteeringAngle: number, maxSteeringTorque: number,
		enableSteeringLimit: number, lowerSteeringLimit: number, upperSteeringLimit: number,
		userData: number ): bigint;
	_b3js_WheelJoint_EnableSuspension( jointId: bigint, flag: number ): void;
	_b3js_WheelJoint_SetSuspensionLimits( jointId: bigint, lower: number, upper: number ): void;
	_b3js_WheelJoint_EnableSpinMotor( jointId: bigint, flag: number ): void;
	_b3js_WheelJoint_SetSpinMotorSpeed( jointId: bigint, speed: number ): void;
	_b3js_WheelJoint_SetMaxSpinTorque( jointId: bigint, torque: number ): void;
	_b3js_WheelJoint_GetSpinSpeed( jointId: bigint ): number;
	_b3js_WheelJoint_GetSpinTorque( jointId: bigint ): number;
	_b3js_WheelJoint_EnableSteering( jointId: bigint, flag: number ): void;
	_b3js_WheelJoint_SetTargetSteeringAngle( jointId: bigint, radians: number ): void;
	_b3js_WheelJoint_SetMaxSteeringTorque( jointId: bigint, torque: number ): void;
	_b3js_WheelJoint_SetSteeringLimits( jointId: bigint, lower: number, upper: number ): void;
	_b3js_WheelJoint_GetSteeringAngle( jointId: bigint ): number;

	// ---- Revolute joint ----
	_b3js_CreateRevoluteJoint( worldId: bigint, bodyA: bigint, bodyB: bigint, faPx: number, faPy: number,
		faPz: number, faQx: number, faQy: number, faQz: number, faQw: number, fbPx: number, fbPy: number,
		fbPz: number, fbQx: number, fbQy: number, fbQz: number, fbQw: number, collideConnected: number,
		targetAngle: number, enableSpring: number, hertz: number, dampingRatio: number, enableLimit: number,
		lowerAngle: number, upperAngle: number, enableMotor: number, maxMotorTorque: number, motorSpeed: number,
		userData: number ): bigint;
	_b3js_RevoluteJoint_EnableMotor( jointId: bigint, flag: number ): void;
	_b3js_RevoluteJoint_SetMotorSpeed( jointId: bigint, speed: number ): void;
	_b3js_RevoluteJoint_SetMaxMotorTorque( jointId: bigint, torque: number ): void;
	_b3js_RevoluteJoint_GetAngle( jointId: bigint ): number;
	_b3js_RevoluteJoint_EnableLimit( jointId: bigint, flag: number ): void;
	_b3js_RevoluteJoint_IsLimitEnabled( jointId: bigint ): number;
	_b3js_RevoluteJoint_GetLowerLimit( jointId: bigint ): number;
	_b3js_RevoluteJoint_GetUpperLimit( jointId: bigint ): number;
	_b3js_RevoluteJoint_SetLimits( jointId: bigint, lower: number, upper: number ): void;

	// ---- Distance joint ----
	_b3js_CreateDistanceJoint( worldId: bigint, bodyA: bigint, bodyB: bigint, faPx: number, faPy: number,
		faPz: number, faQx: number, faQy: number, faQz: number, faQw: number, fbPx: number, fbPy: number,
		fbPz: number, fbQx: number, fbQy: number, fbQz: number, fbQw: number, collideConnected: number,
		length: number, enableSpring: number, lowerSpringForce: number, upperSpringForce: number, hertz: number,
		dampingRatio: number, enableLimit: number, minLength: number, maxLength: number, enableMotor: number,
		maxMotorForce: number, motorSpeed: number, userData: number ): bigint;
	_b3js_DistanceJoint_SetLength( jointId: bigint, length: number ): void;
	_b3js_DistanceJoint_EnableMotor( jointId: bigint, flag: number ): void;
	_b3js_DistanceJoint_SetMotorSpeed( jointId: bigint, speed: number ): void;
	_b3js_DistanceJoint_GetCurrentLength( jointId: bigint ): number;
}

/** Signature of the default export of the Emscripten-generated box3d.mjs (MODULARIZE=1). */
export type Box3DFactory = ( moduleOverrides?: Record<string, unknown> ) => Promise<Native>;

export interface InitOptions {
	/**
	 * Override where box3d.mjs is loaded from. Defaults to `build/wasm/box3d.mjs` relative to the
	 * repo root (matching scripts/build-wasm.sh's output path). Accepts anything `import()` accepts:
	 * an absolute path/URL, a `file://` URL, or a bare specifier your bundler resolves.
	 */
	wasmUrl?: string | URL;
}

/** Default location of the compiled wasm loader, matching build-wasm.sh's OUT_DIR. */
function defaultWasmUrl(): URL {
	return new URL( "../../build/wasm/box3d.mjs", import.meta.url );
}

/**
 * Turns a wasm-loader location into the string handed to dynamic `import()`.
 *
 * `URL#toString()` percent-encodes reserved characters, so a `file://` URL built from a repo path
 * containing a space (e.g. this project's own checkout, ".../crash test/build/wasm/box3d.mjs")
 * comes out as ".../crash%20test/...". Node's native ESM loader decodes that fine, but Vite's own
 * module resolver -- which is what's actually loading this file when it's imported as TypeScript
 * under vitest/vite (see game/sim/harness.mjs, tests/helpers.ts) -- treats the dynamic import()
 * argument as an opaque module id and matches it against the filesystem WITHOUT first
 * URL-decoding it, so the encoded "%20" no longer matches the real on-disk "crash test" directory
 * and the load fails with "Failed to load url .../crash%20test/... Does the file exist?".
 *
 * Decoding a `file:` URL's pathname back into a plain filesystem path before handing it to
 * import() sidesteps that mismatch entirely -- Node's loader accepts plain absolute paths as
 * specifiers too, so this is safe there as well. Non-`file:` locations (http(s) URLs in the
 * browser build, bare specifiers) are returned unchanged.
 */
function toImportSpecifier( url: string | URL ): string {
	let asUrl: URL | undefined;
	if ( url instanceof URL ) {
		asUrl = url;
	} else {
		try {
			asUrl = new URL( url );
		} catch {
			asUrl = undefined; // not a parseable URL (e.g. a bare specifier) -- pass through as-is
		}
	}
	if ( asUrl && asUrl.protocol === "file:" ) {
		return decodeURIComponent( asUrl.pathname );
	}
	return url.toString();
}

/**
 * Loads box3d.mjs and returns the initialized Emscripten module (typed as {@link Native}). This is
 * the only async step in the whole binding -- everything built on top (World/Body/Shape/Joint) is
 * synchronous.
 */
export async function init( options: InitOptions = {} ): Promise<Native> {
	const url = options.wasmUrl ?? defaultWasmUrl();
	const mod = ( await import( /* @vite-ignore */ toImportSpecifier( url ) ) ) as { default: Box3DFactory };
	return mod.default();
}
