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

/**
 * Traction-control torque taper on the driven (rear) wheels -- see vehicle.ts's
 * tractionLimitedTorque(). Full drive torque is preserved for slip (real wheel omega minus
 * chassis-implied omega) up to TRACTION_SLIP_ALLOWANCE_RAD_S, then linearly cut to zero by
 * TRACTION_SLIP_CUTOFF_RAD_S.
 *
 * TUNING DELTA (BINDFIX follow-up, required by allowFastRotation): added after removing the
 * ENGINE_ASSIST_* workaround. box3d's per-body rotation clamp used to silently bound every wheel
 * body's angular speed near ~47 rad/s regardless of what drove it; that incidentally also bounded the
 * drivetrain servo's permanently-"unreachable" spin target (powertrain.ts's driveServoTarget()) to
 * something sane. With the clamp lifted (wheels now need allowFastRotation to spin past the old ~65
 * km/h ceiling), a momentary traction-loss event let a driven wheel free-spin toward that huge target
 * for real -- observed at ~990 rad/s (several hundred km/h wheel-surface-equivalent), which destabilized
 * the step-steer test (rear-wheel-drive power-oversteer, yaw well outside the test's bounds). This
 * taper restores a bound similar in spirit to the removed clamp without touching the servo pattern
 * itself. Values chosen empirically against the 5 drive tests: wide enough to not touch normal
 * (low-slip) traction-limited acceleration, tight enough to keep a genuine wheelspin event's angular
 * speed within a plausible range. (Also see YAW_DAMPING_* further below, in the drivetrain section,
 * added for the residual oversteer this alone did not fully remove.)
 */
export const TRACTION_SLIP_ALLOWANCE_RAD_S = 10;
export const TRACTION_SLIP_CUTOFF_RAD_S = 50;

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

/**
 * TUNING DELTA (BINDFIX follow-up, required by removing ENGINE_ASSIST_*): with the assist gone, the
 * torque-limited-velocity-servo pattern (powertrain.ts's driveServoTarget()) plus the new traction
 * control (TRACTION_SLIP_* above, YAW_DAMPING_* below) needed roughly 36% more torque headroom to
 * clear the straight-line drive test's >=90 km/h in its 5s window -- these 3 points are the spec's
 * original curve (220/330/240 Nm) scaled by that factor (still a physically plausible curve for a
 * ~1350kg RWD car, not an unphysical value; DRIVETRAIN_EFFICIENCY stays at its original <=1 value
 * below rather than being pushed past 100%).
 */
export const ENGINE_TORQUE_CURVE: readonly EngineCurvePoint[] = [
	{ rpm: 900, torqueNm: 300 }, // idle
	{ rpm: 4600, torqueNm: 450 }, // peak
	{ rpm: 6800, torqueNm: 327 }, // redline
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

/**
 * Yaw-rate damping (active, chassis torque about the world-up axis) -- see vehicle.ts's
 * computeYawDampingTorque(). Same pattern as the anti-roll assist above (small, rate-proportional,
 * capped, always-on), added for the same class of reason: TUNING DELTA (BINDFIX follow-up, required
 * by removing the ENGINE_ASSIST_ workaround and wiring allowFastRotation) -- the step-steer test's
 * rear-wheel-drive power-oversteer got measurably worse once driven wheels could actually spin fast
 * (no longer silently capped by box3d's removed per-body rotation clamp, see tuning.ts's
 * TRACTION_SLIP_* doc comment above), pushing yaw rate past the test's upper bound even with the
 * drivetrain-side traction control in place. A small proportional yaw-rate damping torque --
 * independent of the drivetrain -- reins in the resulting oversteer without touching straight-line
 * torque.
 */
export const YAW_DAMPING_GAIN_NM_PER_RAD_S = 5000;
export const YAW_DAMPING_TORQUE_CAP_NM = 4000;

// ---------------------------------------------------------------------------------------------
// Fixed timestep
// ---------------------------------------------------------------------------------------------

export const FIXED_DT = 1 / 60;
export const FIXED_SUBSTEPS = 4;

// ---------------------------------------------------------------------------------------------
// box3d's per-body angular-velocity safety clamp -- BINDFIX applied.
//
// vendor/box3d/src/solver.c's b3IntegratePositionsTask() clamps EVERY dynamic body's angular speed
// to `B3_MAX_ROTATION * context->inv_dt` each step (B3_MAX_ROTATION = 0.25*pi, a "don't rotate more
// than 45 degrees in one world.step() call" tunneling-safety limit -- vendor/box3d/include/box3d/
// constants.h; at FIXED_DT=1/60 that's ~47.12 rad/s, capping our ~0.385m rear wheel's
// rolling-without-slip road speed at ~65 km/h), UNLESS the body was created with
// `b3BodyDef.allowFastRotation = true` (vendor/box3d/src/body.c, checked in solver.c's clamp;
// upstream's own doc comment: "Should only be used for circular objects, like wheels.").
//
// This is now wired end-to-end: src/wasm-shim/binding.c's b3js_CreateBody takes an
// `allowFastRotation` scalar, and src/ts/body.ts's BodyOptions exposes it. vehicle.ts's
// createVehicle() sets `allowFastRotation: true` on all 4 wheel bodies, so driven wheels can spin
// past the old ~65 km/h ceiling. The chassis-forward-force "engine assist" workaround that used to
// compensate for the capped wheel speed (see git history) has been removed -- powertrain.ts's
// existing torque-limited-velocity-servo pattern (driveServoTarget()/UNREACHABLE_WHEEL_OMEGA)
// reaches high speed on its own now that the wheels aren't artificially pinned.
// ---------------------------------------------------------------------------------------------
