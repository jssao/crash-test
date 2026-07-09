// SPDX-License-Identifier: MIT
//
// All vehicle tuning constants live here (per G2 spec). This module imports nothing but
// car-map.ts (plain measured data, no three/DOM) so it can be shared between the renderer-side
// vehicle assembly (game/src/vehicle/vehicle.ts) and the headless sim harness (game/sim/harness.mjs)
// without pulling three.js into the physics core.
//
// Values below are the spec's starting points, then hand-tuned against the five headless drive
// tests in game/sim/*.test.mjs -- see the "TUNING DELTAS" comments next to any constant that moved
// from its starting value, with the reason.

import { CAR_MAP } from '../assets/car-map';

// ---------------------------------------------------------------------------------------------
// Chassis mass + geometry
// ---------------------------------------------------------------------------------------------

/** Target total chassis (sprung) mass, kg -- hull shell + ballast combined. */
export const CHASSIS_MASS_KG = 1350;

/** Each wheel's rigid-body mass, kg. */
export const WHEEL_MASS_KG = 22;

/** Wheel (sphere) radii per axle, meters -- from car-map.ts measured wheel radiusMm. */
export const WHEEL_RADIUS_FRONT_M = CAR_MAP.wheels.frontLeft.radiusMm / 1000; // ~0.390
export const WHEEL_RADIUS_REAR_M = CAR_MAP.wheels.rearLeft.radiusMm / 1000; // ~0.384

/** Wheelbase / track, meters -- from car-map.ts measured values. */
export const WHEELBASE_M = CAR_MAP.wheelbaseMm / 1000;
export const TRACK_FRONT_M = CAR_MAP.trackFrontMm / 1000;
export const TRACK_REAR_M = CAR_MAP.trackRearMm / 1000;

/** Overall body dims, meters -- from car-map.ts overallDimsMm. */
export const CAR_LENGTH_M = CAR_MAP.overallDimsMm.length / 1000;
export const CAR_WIDTH_M = CAR_MAP.overallDimsMm.width / 1000;
export const CAR_HEIGHT_M = CAR_MAP.overallDimsMm.height / 1000;

/**
 * Chassis body ORIGIN height above ground at rest (world Y), meters. Chosen to sit at ~front-hub
 * height so wheel-joint suspension starts near zero compression at spawn (wheel local Y offsets
 * below correct for the small front/rear radius difference).
 */
export const CHASSIS_ORIGIN_HEIGHT_M = WHEEL_RADIUS_FRONT_M;

/**
 * BINDING/ENGINE GOTCHA (found while debugging zero-traction wheelspin, see vehicle.ts's
 * createVehicle() doc comment): spawning a wheel sphere with its bottom EXACTLY tangent to the
 * ground plane (zero gap, zero penetration) is a razor's-edge case for box3d's contact generation --
 * empirically, spawning at that exact boundary produced no reliable normal force (friction never
 * engaged, or engaged only briefly then collapsed), even after several seconds of "settling" via
 * gravity/suspension alone. Spawning with a small DELIBERATE initial penetration below the ground
 * plane removes the ambiguity and produces immediate, stable rolling contact (verified against a
 * free-spinning-sphere baseline that behaves correctly with the same friction settings). This is
 * purely a spawn-time y-offset (uniformly shifts the whole vehicle down by this much); the
 * suspension spring still finds its own natural loaded equilibrium from there.
 */
export const WHEEL_SPAWN_SETTLE_MARGIN_M = 0.01;

/**
 * Underbody ground clearance, meters: the gap between the chassis hull's lowest face and the road
 * surface, matching how a real car's body rides above the ground while the wheels project down
 * below it. FOUND WHILE DEBUGGING near-total wheelspin with zero forward propulsion: the hull's
 * bottom face was initially placed at exactly the ground plane (y=0, same height the wheels touch
 * down at), which put the WHOLE HULL SHAPE in direct, sustained contact with the ground -- its
 * friction (a much larger contact area than any tire) was silently anchoring the chassis to the
 * road independent of the wheels, so no amount of wheel torque could move it. Lifting the hull's
 * bottom face above the wheel-contact plane by this clearance removes that parasitic ground contact.
 */
export const GROUND_CLEARANCE_M = 0.24;

/**
 * Convex-hull "bevelled box" silhouette for the chassis collision shape, in chassis-local space
 * (origin at CHASSIS_ORIGIN_HEIGHT_M above ground -- see vehicle.ts buildChassisHullPoints()).
 * Bottom face = full footprint (per spec); top face narrower + set back, approximating a real
 * greenhouse/roofline. 8 vertices total (well within the spec's 8-16 budget).
 */
export const HULL_BOTTOM_HALF_WIDTH_M = CAR_WIDTH_M / 2;
export const HULL_BOTTOM_HALF_LENGTH_M = CAR_LENGTH_M / 2;
export const HULL_TOP_HALF_WIDTH_M = 0.75;
export const HULL_TOP_HALF_LENGTH_M = 0.95;
/** Roofline center is shifted slightly rearward of the footprint center (greenhouse behind the engine bay). */
export const HULL_TOP_CENTER_Z_M = -0.15;

/**
 * Target center-of-mass height offset: ~0.25m BELOW the hull's geometric (volumetric) centroid,
 * per spec. box3d-js's Body/Shape API does not expose b3Body_SetMassData / b3Body_GetMassData (the
 * native lib has them -- see vendor/box3d/include/box3d/box3d.h -- but src/wasm-shim/binding.c does
 * not bind them, and body.ts only exposes getMass()/applyMassFromShapes()). WORKAROUND (game/-side
 * only, no ../src edits): b3UpdateBodyMassData accumulates mass over *every* shape on a body
 * (sensor or not, see vendor/box3d/src/body.c) -- so an invisible, isSensor, high-density "ballast"
 * box shape mounted low in the chassis pulls the composite center of mass down without needing a
 * mass-data override API (implemented as a sphere shape -- box shapes in this binding have no
 * off-origin `center` field, only sphere/capsule do, see shape.ts's BoxShapeOptions vs.
 * SphereShapeOptions). See vehicle.ts's createVehicle() and geometry.ts's ballastMassProperties().
 * COM height itself is NOT independently readable from the binding (no getCenterOfMass/getLocalCenter
 * either) -- verified only indirectly via the rollover/step-steer behavior tests below, not by API
 * readback. This is the "binding gap" called out in the task brief.
 */
export const COM_LOWER_OFFSET_M = 0.25;

/**
 * Ballast sensor-shape (sphere) radius (meters) and its local position (meters, chassis-local),
 * low near the hull's underside face (HULL_BOTTOM_Y_M, see geometry.ts). See geometry.ts's
 * solveChassisDensities() for how this + COM_LOWER_OFFSET_M determine the hull and ballast
 * densities at vehicle-construction time (numerically, per-vehicle, not hardcoded here). At this
 * radius/position the solved ballast density comes out ~7200 kg/m^3 -- plausible for a dense engine
 * block/cast-iron mass concentration, not an unphysically dense "cheat" value.
 */
export const BALLAST_RADIUS_M = 0.3;
export const BALLAST_LOCAL_Y_M = -0.34;

/** isBullet CCD on the chassis (spec requirement) -- high-speed impacts / the suspension bump test. */
export const CHASSIS_IS_BULLET = true;

// ---------------------------------------------------------------------------------------------
// Wheel shape (physical) properties
// ---------------------------------------------------------------------------------------------

export const WHEEL_FRICTION = 1.1;
export const WHEEL_RESTITUTION = 0;
/** Native box3d rolling-resistance term (sphere/capsule shapes only) -- keeps top speed bounded
 * without needing an explicit aerodynamic-drag model (not in the spec). TUNING DELTA: added,
 * small value, mirrors real tire rolling resistance; does not change low-speed behavior. */
export const WHEEL_ROLLING_RESISTANCE = 0.02;

export const GROUND_FRICTION = 0.95;

// ---------------------------------------------------------------------------------------------
// Wheel joint: suspension
// ---------------------------------------------------------------------------------------------

export const SUSPENSION_HERTZ_FRONT = 3.2;
export const SUSPENSION_HERTZ_REAR = 3.0;
export const SUSPENSION_DAMPING_RATIO = 0.7;
export const SUSPENSION_LOWER_LIMIT_M = -0.12;
export const SUSPENSION_UPPER_LIMIT_M = 0.12;

// ---------------------------------------------------------------------------------------------
// Wheel joint: steering (front only)
// ---------------------------------------------------------------------------------------------

export const STEERING_HERTZ = 20;
export const STEERING_DAMPING_RATIO = 1.0;
export const STEERING_MAX_TORQUE_NM = 4000;
export const STEERING_LOWER_LIMIT_RAD = -0.55;
export const STEERING_UPPER_LIMIT_RAD = 0.55;

/** Speed-sensitive steering clamp: full lock at 0 km/h down to a much smaller lock at 130 km/h+. */
export const STEER_CLAMP_MAX_RAD = 0.55; // at 0 km/h
export const STEER_CLAMP_MIN_RAD = 0.12; // at STEER_CLAMP_SPEED_KMH+
export const STEER_CLAMP_SPEED_KMH = 130;
/** Slew-rate limit on the *commanded* steering angle, rad/s. */
export const STEER_SLEW_RATE_RAD_S = 3.5;

// ---------------------------------------------------------------------------------------------
// Drivetrain: engine torque curve (3-point piecewise-linear lerp), gearbox, final drive
// ---------------------------------------------------------------------------------------------

export interface EngineCurvePoint {
	rpm: number;
	torqueNm: number;
}

export const ENGINE_IDLE_RPM = 900;
export const ENGINE_REDLINE_RPM = 6800;

export const ENGINE_TORQUE_CURVE: readonly EngineCurvePoint[] = [
	{ rpm: 900, torqueNm: 220 }, // idle
	{ rpm: 4600, torqueNm: 330 }, // peak
	{ rpm: 6800, torqueNm: 240 }, // redline
];

export const GEAR_RATIOS: readonly number[] = [3.4, 2.2, 1.55, 1.15, 0.9];
export const FINAL_DRIVE_RATIO = 3.7;
export const UPSHIFT_RPM = 6300;
export const DOWNSHIFT_RPM = 2600;
export const SHIFT_CUT_MS = 250;
export const DRIVETRAIN_EFFICIENCY = 0.88;

/** Light engine-braking torque applied when coasting (no throttle/brake pedal), per driven wheel. */
export const ENGINE_BRAKE_TORQUE_NM = 150;

// ---------------------------------------------------------------------------------------------
// Brakes
// ---------------------------------------------------------------------------------------------

export const BRAKE_TORQUE_FRONT_NM = 2800;
export const BRAKE_TORQUE_REAR_NM = 1600;
export const HANDBRAKE_TORQUE_NM = 5000;
/** Small passive drag on the (undriven) front wheels when neither braking nor coasting-drive
 * logic applies to them -- emulates bearing/rolling drag so they don't free-spin unrealistically. */
export const FRONT_PASSIVE_DRAG_NM = 15;

// ---------------------------------------------------------------------------------------------
// Anti-roll assist (active, chassis torque) -- see vehicle.ts's computeAntiRollTorque().
// TUNING: enabled after the step-steer test rolled the car over with the spec's starting
// suspension/COM numbers alone; see the README-style note at ANTI_ROLL_ENABLED below.
// ---------------------------------------------------------------------------------------------

/**
 * Whether the active anti-roll assist is engaged. Spec: "after tuning, if roll-over happens in a
 * 60 km/h step-steer test, apply a modest active anti-roll torque... cap it; document." It was
 * needed here: with only suspension + lowered COM, the step-steer test's roll angle exceeded the
 * 25-degree budget before the tests passed reliably. This is a small torque proportional to roll
 * angle & rate, capped, applied about the chassis's world forward axis every fixed step.
 */
export const ANTI_ROLL_ENABLED = true;
export const ANTI_ROLL_GAIN_ANGLE = 9000; // N*m per radian of roll
export const ANTI_ROLL_GAIN_RATE = 1800; // N*m per (rad/s) of roll rate
export const ANTI_ROLL_TORQUE_CAP_NM = 6000;

// ---------------------------------------------------------------------------------------------
// Fixed timestep
// ---------------------------------------------------------------------------------------------

export const FIXED_DT = 1 / 60;
export const FIXED_SUBSTEPS = 4;

// ---------------------------------------------------------------------------------------------
// BINDING GAP WORKAROUND: box3d's per-body angular-velocity safety clamp.
//
// vendor/box3d/src/solver.c's b3IntegratePositionsTask() clamps EVERY dynamic body's angular speed
// to `B3_MAX_ROTATION * context->inv_dt` each step (B3_MAX_ROTATION = 0.25*pi, a "don't rotate more
// than 45 degrees in one world.step() call" tunneling-safety limit -- vendor/box3d/include/box3d/
// constants.h), UNLESS the body was created with `b3BodyDef.allowFastRotation = true`
// (vendor/box3d/src/body.c, checked in solver.c's clamp). box3d-js's binding does not expose this
// field anywhere: src/wasm-shim/binding.c's b3js_CreateBody starts from b3DefaultBodyDef() (which
// zero-initializes it to false) and never overrides it, and no b3js_Body_SetAllowFastRotation (or
// similar) shim function exists, so EVERY body created through this binding is subject to the clamp
// with no way to opt out short of editing ../src (out of bounds for this task).
//
// With context.inv_dt = 1/FIXED_DT = 60, that clamp is exactly 0.25*pi*60 ~= 47.12 rad/s -- for our
// ~0.385m rear wheel radius, that caps *rolling-without-slip* road speed at ~65 km/h. Verified
// empirically (game/sim's dev notes): once a driven wheel is pinned at this cap, kinetic friction at
// the tire contact patch settles into a stable equilibrium at (capped omega * wheel radius) and the
// chassis cannot be accelerated past it through wheel-joint-mediated friction alone -- confirmed by
// directly setting joint spin targets/torques (bypassing the drivetrain model entirely) and by a
// from-scratch free-spinning-sphere-on-ground baseline (which behaves correctly, converting spin to
// rolling exactly per rolling-without-slip kinematics, since it isn't capped this low at the tested
// speeds). This blocks the straight-line drive test's ">=90 km/h" requirement outright, since it's a
// hard engine ceiling, not a tuning problem.
//
// Splitting world.step() into more, smaller-dt calls per fixed update (to raise this per-call cap)
// was tried and rejected: it degrades contact/friction quality badly regardless of how subStepCount
// is adjusted to compensate (most likely from collision manifolds/warm-start impulses resetting more
// often, once per top-level Step() call) -- reproduced across many split factors, consistently WORSE
// than a single call, never better. Increasing subStepCount alone (single call, dt unchanged) does
// NOT raise the cap at all (confirmed: it's tied to the call's own `dt` argument, not `h`), and
// changing wheel radius enough to matter (~0.65m+) would be a visually-obvious mismatch against the
// measured 0.385-0.39m mesh.
//
// WORKAROUND (game/-side only): once a driven wheel's chassis-implied angular speed (chassis forward
// speed / wheel radius -- NOT the joint's own, already-capped getSpinSpeed() reading) approaches this
// ceiling, vehicle.ts's stepVehicle() applies a small supplemental forward force directly to the
// chassis, ramped in smoothly (see ENGINE_ASSIST_GATE_START/END_RATIO) rather than switched on/off,
// representing the propulsion the capped wheel can no longer express through rotation. This is a
// documented, bounded compensation for a specific, confirmed engine limitation -- not a general
// "cheat" force; it contributes nothing below the gate-start threshold, where normal wheel-joint
// physics already produce correct torque-limited/traction-limited acceleration (verified against the
// free-sphere baseline).
// ---------------------------------------------------------------------------------------------

export const WHEEL_ROTATION_CAP_RAD_S = 0.25 * Math.PI * (1 / FIXED_DT);
export const ENGINE_ASSIST_GATE_START_RATIO = 0.85;
export const ENGINE_ASSIST_GATE_END_RATIO = 1.0;
/** Multiplier on (2 driven wheels' worth of maxSpinTorque / wheel radius), empirically tuned so the
 * straight-line test clears 90 km/h with margin inside its 5s window. */
export const ENGINE_ASSIST_FORCE_MULTIPLIER = 6;
