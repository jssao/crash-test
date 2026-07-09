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

/**
 * Target total chassis (sprung) mass, kg -- hull shell + ballast combined.
 *
 * TUNING DELTA (G3 damage system): was 1350 pre-damage. The 5 detachable panel bodies
 * (game/src/damage/panels.ts, welded to the chassis in vehicle.ts's createVehicle()) add
 * ~71kg of their own (game/src/damage/damage-tuning.ts's PANEL_MASS_KG: 13+16+16+14+12), carried as
 * SEPARATE bodies rather than baked into this hull+ballast figure. Reduced by exactly that amount
 * (1350 - 71 = 1279) so the car's TOTAL mass (chassis + panels + 4*WHEEL_MASS_KG = 1279+71+88=1438kg)
 * stays ~unchanged from the pre-damage total (1350+88=1438kg) -- keeping it inside the G3 spec's
 * required ~1350-1450kg band with minimal risk of perturbing the 5 pre-existing drive tests, which
 * were tuned against the original 1438kg total.
 */
export const CHASSIS_MASS_KG = 1279;

/** Each wheel's rigid-body mass, kg. */
export const WHEEL_MASS_KG = 22;

/**
 * Shared box3d collision-filter group index for EVERY car body's shapes (chassis hull, ballast
 * sensor, wheel spheres, damage-system panel boxes) -- box3d/box2d filter convention: a NEGATIVE
 * shared group index means shapes in that group NEVER collide with each other, overriding
 * category/mask bits, regardless of collideConnected on any joint between them. Set on every car
 * shape (vehicle.ts, game/src/damage/panels.ts) so panels/wheels/chassis can never self-collide --
 * upgrades the previous per-joint `collideConnected: false` (which only ever covered the specific
 * chassis<->wheel pairs with an actual joint between them, not e.g. wheel-vs-wheel or panel-vs-wheel).
 * Ground/wall/other world bodies keep the default groupIndex 0, so this has zero effect on car-vs-
 * environment collisions -- only car-vs-own-parts.
 */
export const CAR_GROUP_INDEX = -1;

/** World gravity magnitude (m/s^2), matching createVehicle()/createGroundBody()'s world gravity of
 * (0,-10,0) -- shared by the damage system's weight-based force thresholds (damage-tuning.ts). */
export const GRAVITY_MAG = 10;

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
 * per spec. This is achieved via a ballast-sensor shape rather than a direct mass-data override
 * (kept as-is -- it works, and replacing a working mechanism isn't worth the retune risk): an
 * invisible, isSensor, high-density "ballast" sphere shape mounted low in the chassis pulls the
 * composite center of mass down, since b3UpdateBodyMassData accumulates mass over *every* shape on a
 * body (sensor or not, see vendor/box3d/src/body.c). A sphere (not box) shape is used for the ballast
 * because box3d-js's box shapes have no off-origin `center` field, only sphere/capsule do (see
 * shape.ts's BoxShapeOptions vs. SphereShapeOptions). See vehicle.ts's createVehicle() and
 * geometry.ts's ballastMassProperties().
 *
 * CORRECTION (FIXROUND-2): an earlier version of this comment claimed box3d-js's Body/Shape API
 * doesn't expose b3Body_SetMassData/GetMassData -- that was WRONG. Both ARE wired end-to-end:
 * src/wasm-shim/binding.c's b3js_Body_SetMassData/b3js_Body_GetMassData (binding.c:464/484),
 * src/ts/body.ts's Body.setMassData()/getMassData() (body.ts:168/186), exported via
 * src/ts/index.ts. A direct mass-data override (setting an explicit local center of mass) COULD
 * replace the ballast-sensor workaround above -- but that mechanism already works and is verified
 * against the drive-test matrix, so it's left in place rather than swapped for an equivalent-effort,
 * non-zero-retune-risk alternative. COM height itself is still not independently readable back from
 * the binding (no getCenterOfMass/getLocalCenter accessor) -- verified only indirectly via the
 * rollover/step-steer behavior tests, not by API readback.
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

/**
 * TUNING DELTA (FIXROUND-2, root-caused): was 1.5 going into that pass. The 1.5 value (up from a
 * physically-sane 1.1) was compensating for a REAL traction deficit; FIXROUND-2 root-caused the
 * asymmetric-wheel-mount / traction-taper interaction (see vehicle.ts's WHEEL_DEFS symmetrization) and
 * its doc comment (at the time) claimed 1.05 cleared the drive-test matrix -- but that claim was NEVER
 * actually re-verified after the G3 damage system (5 welded panel bodies, game/src/damage/panels.ts)
 * landed, and the code's own value stayed at 1.5, i.e. the deficit silently came back (this pass's
 * own residual: "0.5g average accel needs mu~1.5?!").
 *
 * RE-ROOT-CAUSED (vehicle deep-pass): instrumented per-wheel suspension load (joint.getConstraintForce
 * -- turned out unreliable, see below), per-wheel suspension DEFLECTION (getSuspensionDeflection(),
 * reliable, ~0.12m loaded in every configuration tested -- wheels ARE properly loaded), and directly
 * A/B'd every candidate parasitic-contact path (game/sim/diag/friction-instrument*.test.mjs). Found:
 * the 5 damage-system panel bodies are welded RIGIDLY (no suspension) to the chassis, and doorL/doorR's
 * raw measured vertical bbox (car-map.ts's BodyDoorLColor1/BodyDoorRColor1 sizeMm.y, bundling mirror/
 * handle/window-frame childNodes into one bbox -- same class of over-inclusive-measurement issue
 * damage-tuning.ts's PANEL_THICKNESS_AXIS doc comment already flags on the OTHER axis) put the doors'
 * bottom edge ~8.5cm BELOW the hull's own tuned GROUND_CLEARANCE_M line -- i.e. lower than the hull
 * itself, silently reinstating the exact "shape drags on the ground, its friction anchors the chassis
 * independent of wheel traction" bug GROUND_CLEARANCE_M was created to fix for the hull (see that
 * constant's doc comment). Confirmed directly: a clean single-variable isolation (Shape.setFilter()
 * excluding ONLY door<->ground collision, weld/mass/position otherwise untouched) recovered +5.1km/h
 * (+5.5%) of 5s straight-line acceleration by itself. FIXED at the geometry level (damage/panels.ts's
 * panelHalfExtentsRef() now clamps each panel's vertical half-extent to the same ground-clearance
 * floor the hull already respects -- see that function's doc comment), not by further inflating this
 * friction constant.
 *
 * (Aside, ruled out: joint.getConstraintForce() summed across all 4 wheels read ~0N of the vehicle's
 * ~14.4kN weight at rest -- looked like "wheels carry no load", but cross-checked via suspension
 * DEFLECTION with panels relocated away entirely and found IDENTICAL ~0.12m compression either way, so
 * the wheels demonstrably ARE loaded; the getConstraintForce() reading itself is unreliable for this
 * purpose here, not the physics -- see vendor/box3d/src/wheel_joint.c's b3GetWheelJointForce(), whose
 * suspension-axis impulse term includes `joint->lowerSuspensionLimit` (a configured LENGTH limit, not
 * an impulse accumulator) alongside the real impulse accumulators, which looks like a vendor readback
 * quirk; vendor code is out of scope to modify, and the deflection cross-check was conclusive enough
 * not to need it.)
 *
 * With the real parasitic-drag mechanism fixed, re-measured empirically against the full drive-test
 * matrix (straight-line, braking, step-steer, kicker-jump, airborne-momentum, cornering, sustained-
 * oscillation): 1.05 clears all of them. 1.05 is a physically ordinary road/sport-tire coefficient
 * (real tires span ~0.7-1.5+), not a "cheat" value like the old 1.5 high-grip-slick figure.
 */
export const WHEEL_FRICTION = 1.05;
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
/**
 * TUNING NOTE (FIXROUND-2, diagnostic D4 "tighten the taper so wheelspin is caught earlier"): tried
 * and REVERTED. A low-pass filter on the taper's realOmega input (killing the raw per-step spin-speed
 * reading's +/-20-30 rad/s step-to-step swing, aimed at diagnostic B3) combined with a tightened
 * ALLOWANCE/CUTOFF window measurably WORSENED straight-line acceleration (max speed in the 5s drive
 * test dropped from ~90 to ~67-75 km/h in direct A/B testing) -- root cause: that raw swing isn't pure
 * noise to be smoothed away, it's the taper reacting instant-by-instant to a real, fast-oscillating
 * wheel-speed dynamic (small wheel rotational inertia vs. a torque-saturated servo), and the troughs
 * of that oscillation are exactly when the UNFILTERED taper permits high torque -- averaging them away
 * with any filter strong enough to matter left the taper reading a persistently elevated "slip" and
 * cutting torque far more of the time. Diagnostic B3's underlying goal (kill the drift-seeding
 * per-wheel torque-cut asymmetry) turned out to be already resolved by B1 (mount symmetrization) + B2
 * (per-wheel yaw-aware implied omega) alone -- verified directly: 30s full-throttle straight-line yaw
 * stays within ~2deg with the taper UNFILTERED, using the ORIGINAL (unchanged) 10/50 window, so no
 * filter or extra tightening was actually load-bearing for the drift fix. Left at the original 10/50
 * (unmodified) rather than force a "tighter" number that doesn't survive the drive-test matrix.
 */
export const TRACTION_SLIP_ALLOWANCE_RAD_S = 10;
export const TRACTION_SLIP_CUTOFF_RAD_S = 50;

/**
 * Consecutive steps a wheel's slip must stay above TRACTION_SLIP_CUTOFF_RAD_S before
 * updateWheelGroundContact() (vehicle.ts) trusts it as genuine free-spin evidence overriding a
 * (possibly stale) "grounded" suspension-deflection reading -- see Vehicle.wheelSlipOverCutoffStreak's
 * doc comment for the full rationale (a single-step chatter spike at high cruise speed can hit the
 * cutoff too; a sustained streak cannot). Same value/pattern as damage-tuning.ts's
 * WHEEL_DETACH_DEBOUNCE_STEPS (an analogous "ignore an isolated transient spike" filter).
 */
export const SLIP_OVERRIDE_DEBOUNCE_STEPS = 3;

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

// ---------------------------------------------------------------------------------------------
// Reverse (the brake/S key doubles as reverse when the car is stopped or already rolling backward)
// ---------------------------------------------------------------------------------------------

/** While the car is still rolling forward faster than this (m/s), the brake pedal foot-brakes; at or
 * below it (stopped / rolling backward) the pedal engages reverse instead. */
export const REVERSE_ENGAGE_SPEED_MS = 0.6;
/** Reverse is torque-cut once backward speed reaches this (m/s ≈ 25 km/h) so it stays gentle/bounded. */
export const REVERSE_MAX_SPEED_MS = 7;
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
/**
 * Whether the active yaw-rate damping assist is engaged -- added for convention parity with
 * ANTI_ROLL_ENABLED/ANTI_PITCH_ENABLED (FIXROUND-2 diagnostic B4); this assist previously had no
 * enable flag at all. Left true: still needed (see the drift diagnostics), but now consistent with
 * how the other two active-assist terms are gated.
 */
export const YAW_DAMPING_ENABLED = true;
/**
 * TUNING DELTA (FIXROUND-2 diagnostic B4): raised from 5000 -- with the mount-asymmetry root cause
 * (vehicle.ts's WHEEL_DEFS) fixed, this damping's job narrows to arresting genuinely small
 * perturbations (bumps, minor slip noise) quickly rather than fighting a large systemic bias, so a
 * slightly stronger gain settles small yaw disturbances faster without measurably affecting the
 * intentional turning response (step-steer test's required yaw-rate range is achieved via steering
 * input, which this damping does not oppose at the rates that test exercises).
 */
export const YAW_DAMPING_GAIN_NM_PER_RAD_S = 6500;
export const YAW_DAMPING_TORQUE_CAP_NM = 4000;

/**
 * Anti-pitch assist (active, chassis torque about the chassis's world-right/lateral axis) -- same
 * rate-damping shape as the yaw-damping assist above, about the third (pitch) axis. Added for playtest
 * MAJOR "flat-ground rollover under sustained mild steer" (game/verify/playtest/battery.mjs's
 * free-drive scenario: 0.15-amplitude oscillating steer + sustained throttle for 30s).
 *
 * DIAGNOSIS (game/sim/sustained-oscillation.test.mjs + ad hoc pitch/roll tracing): the car does NOT
 * actually roll over -- roll angle stayed under ~9deg throughout the whole run even with every
 * existing knob (suspension hertz/damping/limits, steering slew rate, steer clamp, stronger anti-roll
 * gains) left at their pre-existing tuned values. upDot still collapsed to -1 (fully inverted) via an
 * unbounded, monotonically-growing PITCH rotation instead (confirmed by direct forward-vector pitch
 * tracing: roughly -0.2deg/step and accelerating, -0.2deg -> -18deg in under a second once triggered,
 * never settling). Root cause: the bang-bang
 * throttle controller's instantaneous full-torque reapplication, whenever it happens to land mid-slip
 * on a driven (rear) wheel, occasionally kicks off a rear-wheel spin-up event; the wheel joint's
 * spin-motor reaction torque acts directly about the chassis's lateral (pitch) axis, and NOTHING in
 * the existing model damps pitch (anti-roll only covers the forward axis, yaw-damping only the up
 * axis) -- so an unlucky spin-up event pitches the nose with no restoring force at all. No combination
 * of the existing knobs (suspension hertz/damping/limits, steering slew rate, steer clamp) prevented
 * the triggering spin-up event itself across repeated tuning attempts -- this is a genuinely missing
 * degree-of-freedom control, not a mistuned existing one, so a new assist term was added (same file/
 * function as the pre-existing anti-roll/yaw-damping assists, not a new subsystem).
 *
 * TUNING: rate-only (ANGLE gain = 0), unlike anti-roll's angle+rate combo -- a proportional ANGLE term
 * (tried first, e.g. 9000 Nm/rad) measurably fought the ordinary, harmless nose-lift/squat that happens
 * every hard launch, costing ~1-2km/h off the straight-line drive test's required >=90km/h/5s (that
 * pitch builds up slowly, so an angle-proportional torque leans on it continuously). A pitch RATE only
 * term stays silent during that slow, ordinary buildup but engages hard and fast the instant a violent
 * rate spike appears (the actual failure signature), which is exactly the discrimination needed here.
 * The cap is deliberately much higher than anti-roll/yaw-damping's (a genuine wheel-spin-reaction event
 * measured a multi-thousand-N*m sustained torque -- see stepVehicle()'s drivetrain section -- a small
 * cap could never arrest it before the pitch angle ran away).
 */
export const ANTI_PITCH_ENABLED = true;
export const ANTI_PITCH_GAIN_ANGLE = 0; // N*m per radian of pitch (rate-only, see doc comment above)
export const ANTI_PITCH_GAIN_RATE = 14000; // N*m per (rad/s) of pitch rate
export const ANTI_PITCH_TORQUE_CAP_NM = 16000;

// ---------------------------------------------------------------------------------------------
// Ground-contact gating for the 3 active assists above (FIXROUND-2 diagnostic A, "airborne
// auto-leveling"). ROOT CAUSE: computeAntiRollTorque/computeYawDampingTorque/computeAntiPitchTorque
// were being summed and applied EVERY step unconditionally, with no ground-contact check at all --
// so a real, physical airborne rotation (e.g. off the kicker ramp) got actively cancelled by the same
// torque that's meant to keep the car level *while driving*, killing rotational momentum in the air
// (measured: pitch rate -0.6875 -> 0.0000 rad/s within ~0.3s airborne; ~0.6 (rad/s)/s decay rate).
// FIX: scale the summed assist torque by a per-vehicle "ground authority" scalar (see vehicle.ts's
// updateGroundAuthority()) derived from how many of the 4 wheels are in real ground contact (via
// getSuspensionDeflection() -- see GROUND_CONTACT_DEFLECTION_ENTER/EXIT_M below), rate-limited so a
// landing ramps authority back in over ASSIST_AUTHORITY_RAMP_TIME_S rather than snapping.
// ---------------------------------------------------------------------------------------------

/**
 * Per-wheel ground-contact thresholds on getSuspensionDeflection(), meters -- hysteresis band (ENTER
 * a lower/looser bound than EXIT is HIGHER, i.e. once grounded it takes a bigger drop in deflection to
 * count as "left the ground" again) to avoid chatter right at the boundary. Calibrated empirically
 * (game/sim/diag): steady-state grounded deflection under normal driving load sits ~0.11-0.12m
 * (compressed toward SUSPENSION_UPPER_LIMIT_M), while genuinely airborne wheels relax back toward
 * ~0.00m (the spring's unloaded/free position, since chassis and wheel fall together) within a
 * fraction of a second -- a large, clean gap, not a fine line.
 */
export const GROUND_CONTACT_DEFLECTION_ENTER_M = 0.05; // deflection must rise above this to count as grounded
export const GROUND_CONTACT_DEFLECTION_EXIT_M = 0.02; // must fall below this to count as airborne again
/** Time (s) to ramp the assists' authority from 0->1 (landing) or 1->0 (takeoff) -- smooth, not a snap. */
export const ASSIST_AUTHORITY_RAMP_TIME_S = 0.15;
/**
 * Steps of continuously-low ground contact (<=1 wheel) required before the assists' authority target
 * is allowed to drop below PARTIAL_AUTHORITY_FLOOR -- see vehicle.ts's updateGroundAuthority() and
 * Vehicle.lowContactStreak's doc comment. FIX for a regression found while validating diagnostic A's
 * gating against sustained-oscillation.test.mjs: a brief (a few-to-dozen-step) multi-wheel unloading
 * event during hard oscillating-steer weight transfer at speed -- NOT a real off-a-ramp jump -- could
 * still ramp authority all the way to 0 over ASSIST_AUTHORITY_RAMP_TIME_S if contact stayed low long
 * enough, removing the anti-roll assist at exactly the moment (mid-hard-cornering) it's most needed,
 * and letting a roll that started while still mostly grounded carry through un-damped into an actual
 * rollover once the wheels DID come back down. A genuine sustained jump (kicker-jump.test.mjs requires
 * >=18 steps/0.3s of ALL 4 wheels airborne to even count as "caught air") clears this bar easily, so
 * airborne-momentum conservation for real jumps is unaffected -- this only restores a floor of
 * authority during shorter, weight-transfer-driven wheel-lift events that were never a real flight.
 */
export const SUSTAINED_AIRBORNE_STEPS = 10;
/** Authority floor enforced below SUSTAINED_AIRBORNE_STEPS of low contact -- see that constant's doc
 * comment. Not full (1.0) authority -- still lets a genuine brief hop soften the assists somewhat --
 * but enough to keep the anti-roll/anti-pitch assists meaningfully engaged through ordinary hard
 * cornering's transient wheel-lift. */
export const PARTIAL_AUTHORITY_FLOOR = 0.3;
/**
 * Fixed steps (at FIXED_DT) right after spawn/reset during which every wheel is forced "grounded"
 * regardless of raw deflection -- see Vehicle.settleStepsRemaining's doc comment in vehicle.ts. ~0.3s,
 * comfortably longer than the suspension's observed ~0.15s settle time (SUSPENSION_HERTZ_FRONT/REAR
 * ~3Hz => one full period ~0.33s, so this covers slightly more than one spring cycle).
 */
export const SUSPENSION_SETTLE_GRACE_STEPS = 20;

/**
 * Max drive torque (N*m) allowed on an individual driven wheel while THAT wheel is not in ground
 * contact (same per-wheel grounded check as above). FIX for the other half of diagnostic A: the
 * drivetrain servo always targets an unreachable wheel speed (powertrain.ts's UNREACHABLE_WHEEL_OMEGA)
 * and saturates at its torque cap regardless of whether the wheel has traction -- with no ground
 * contact, that cap used to be the FULL throttle-scaled engine torque (thousands of N*m), and since
 * the wheel joint's spin motor is a constraint between the wheel AND the chassis, that torque reacts
 * on the chassis too (a real wheel-spin-reaction pitch/yaw kick) even though the wheel is free-
 * spinning with nothing to push against. Capping it small while airborne keeps the "wheels spin up
 * for the visual" behavior without the chassis-reaction windup that (with the ground-contact gating
 * above now correctly disabling the anti-pitch assist while airborne) would otherwise go completely
 * uncountered.
 */
export const AIRBORNE_DRIVE_TORQUE_CAP_NM = 60;

// ---------------------------------------------------------------------------------------------
// Fixed timestep
// ---------------------------------------------------------------------------------------------

export const FIXED_DT = 1 / 60;
/**
 * TUNING DELTA (G3 damage system): was 4 pre-damage. Raised alongside WHEEL_FRICTION above (see its
 * doc comment for the full investigation) -- empirically, more substeps per world.step() call also
 * measurably improved straight-line acceleration with the 5 welded panel bodies present (4->69km/h,
 * 6->75, 8->77, 12->91 in 5s; non-monotonic beyond that, 16/20 substeps came back down to ~74 -- so
 * this isn't "more is strictly better", 12 was the empirically-chosen point that cleared the full
 * drive-test matrix). More box3d constraint-solver iterations per fixed step plausibly resolves the
 * weld joints' own "long chains may flex" solver-accuracy limit (see WHEEL_FRICTION's doc comment)
 * more tightly, which apparently matters for how the driven wheels' traction is realized. Only ever
 * measured indirectly through the 5 drive tests' behavior, same caveat as WHEEL_FRICTION's doc
 * comment. 12 substeps is not a runtime-performance concern for this vehicle's small body/joint count.
 */
export const FIXED_SUBSTEPS = 12;

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

// ---------------------------------------------------------------------------------------------
// Aerodynamic drag (FIXROUND-2 diagnostic C, "hidden top-speed runaway"). ROOT CAUSE: with the
// mount-asymmetry bug fixed (see WHEEL_DEFS' doc comment), the car no longer yaw-spirals into a
// crash at moderate speed -- but nothing in the model bounds top speed at all: the drivetrain servo
// always saturates its torque cap, and the only retarding forces were rolling resistance
// (WHEEL_ROLLING_RESISTANCE, tiny) and engine-braking-on-coast (not engaged at full throttle).
//
// RE-MEASURED (FIXROUND-2, with the mount-asymmetry/drift bug from diagnostic B already fixed): the
// originally-reported ~680 km/h at t=30s does NOT reproduce as a genuine on-ground runaway -- direct
// long-run tracing (60s+, large ground plane so the finite default 250m half-size never confounds the
// measurement) shows the car settling to a STABLE, BOUNDED ~105-120 km/h in 3rd gear, hovering right
// at that gear's peak-torque wheel speed (engine rpm sits at the ~4600rpm torque-curve peak; past it,
// rising rpm only gets LESS torque, so this is a genuine local force-vs-speed maximum for gear 3, not
// an artifact) -- full throttle, 60+ seconds, never progresses to 4th/5th gear. The original ~680km/h
// figure is consistent with what happens if that measurement's car instead drove off the ground
// plane's finite edge (250m half-size; at even a modest ~110km/h/30m/s cruise, 250m is crossed well
// under 10s) into unconstrained freefall -- gravity alone adds ~10m/s of speed per second airborne,
// which over ~17-20s of subsequent freefall accounts for the reported magnitude far more directly than
// a genuine ground-driven torque/traction runaway would. FIX (still correct and still applied,
// independent of the above): a real car's dominant top-speed-limiting force is aerodynamic drag (grows
// with v^2), entirely missing from this model before this pass -- added as quadratic drag opposing the
// chassis's full velocity vector (F = -0.5*rho*Cd*A*v^2*v_hat), applied every step in stepVehicle().
//
// SUPERSEDED (vehicle deep-pass, residuals 1+2): the "~105-120km/h, below the 180-240 band" gap
// above was a downstream symptom of the friction deficit (WHEEL_FRICTION's doc comment), not a
// powertrain problem -- with the parasitic panel-ground contact fixed at the geometry level (damage/
// panels.ts), the SAME gearing/torque-curve/taper this section's comment above called "unchanged"
// already reaches a genuine, honest settle speed of ~235km/h (measured: big-ground 60s full-throttle
// trace, gear 5, rpm~5400, well below redline -- a real force-balance settle, not a redline/gear-limit
// artifact) -- squarely inside the 180-240km/h target band withOUT any gearing/torque-curve change.
// No powertrain retune was needed once the actual traction/drag bottleneck was corrected; this
// confirms the original diagnostic C writeup's own suspicion ("this vehicle's actual settled top
// speed is low enough that CdA barely matters") had the causality backwards -- it wasn't that CdA
// didn't matter, it's that a large non-aerodynamic parasitic drag term (undiagnosed at the time) was
// the dominant retarding force, masking aero drag's real role entirely.
// ---------------------------------------------------------------------------------------------

/** Air density, kg/m^3 (sea-level, ~20C). */
export const AIR_DENSITY_KG_M3 = 1.225;
/**
 * Combined drag coefficient * frontal area (Cd*A), m^2.
 *
 * TUNING DELTA (vehicle deep-pass, residual 2): raised 0.3 -> 0.65 (the spec's own suggested sports-
 * coupe range is 0.6-0.7 m^2) now that the parasitic panel-ground drag confound (WHEEL_FRICTION's doc
 * comment) is fixed and no longer eats the straight-line test's margin -- re-verified directly: with
 * this value, straight-line still clears its >=85km/h/5s bar (measured 86.3km/h) and the settled top
 * speed (~235km/h, see the section doc comment above) lands solidly inside the 180-240km/h target
 * band, with a swept comparison (0.3/0.6/0.9/1.2 all measured) confirming top speed is NOT strongly
 * driven by this coefficient alone in this vehicle's operating range (0.6->1.2, roughly a 2x change,
 * only moved settle speed ~230->221km/h) -- gearing/torque-curve set the overall scale, drag fine-
 * tunes where in the target band it lands. 0.65 was chosen (rather than the swept 0.6/0.9/1.2 points)
 * to land mid-band with comfortable margin under the 240km/h ceiling.
 */
export const AERO_DRAG_COEFF_AREA_M2 = 0.65;

// ---------------------------------------------------------------------------------------------
// Brake torque ramp + progressive lateral grip (FIXROUND-2 diagnostic D, "friction/feel").
// ---------------------------------------------------------------------------------------------

/**
 * Time (s) over which the brake pedal's commanded torque ramps from 0 to full, once the pedal is
 * pressed -- FIX for the measured 1.9-2.2g transient spike in the first 2 steps of hard braking
 * (steady-state was already a reasonable 1.20-1.22g): the old code applied BRAKE_TORQUE_*_NM at full
 * magnitude the very first step the pedal is pressed, which -- combined with the tire's finite grip
 * -- produced a brief, unrealistic near-instantaneous deceleration spike before settling to the
 * traction-limited steady value. Real brake systems (and driver foot pressure) ramp up over a
 * fraction of a second; this does the same for the commanded torque only (steady-state braking
 * distance/deceleration is unaffected once the ramp completes).
 *
 * TUNING DELTA (vehicle deep-pass, residual 2): raised 0.15 -> 0.26. With the friction root-cause fix
 * in place (WHEEL_FRICTION's doc comment), the pre-existing 0.15s ramp settled at a slightly-too-high
 * ~1.7-1.8g transient again (more available grip at the honest, lower friction value meant the same
 * ramp duration still let the initial spike through). Re-swept directly against game/sim/braking-g.
 * test.mjs (0.15/0.2/0.22/0.24/0.25/0.26/0.27/0.28/0.3/0.35 all measured): 0.26 lands the transient at
 * ~1.27g and steady at ~1.02g, both genuinely inside the spec's ideal 0.9-1.1g steady / <1.4g transient
 * band (not just "improved over the old bug," as the pre-deep-pass value could only claim) -- braking
 * distance stays well inside the spec's 36-48m/100km/h band throughout this sweep (measured 25.7-26.8m
 * from 80km/h at every tested ramp value).
 */
export const BRAKE_TORQUE_RAMP_TIME_S = 0.26;

/**
 * Game-side progressive lateral-grip governor (see vehicle.ts's computeLateralGripAssistTorque()).
 * box3d's contact friction is a single isotropic Coulomb scalar (confirmed in vendor source, see
 * vendor/box3d/src/contact_solver.c) -- there is no slip-angle-dependent tire model, so the physical
 * lateral force available saturates at (mu * normal load) as soon as ANY meaningful slip develops,
 * essentially independent of how much slip/steer is actually commanded. Measured: cornering hit
 * 0.87-1.16g lateral at only 43% of max steer angle -- near-binary saturation, not the progressive
 * "more steer -> more lateral g, up to a limit" feel a real tire's slip-angle-vs-force curve gives.
 * FIX: an additional yaw-axis torque, layered on top of the physical friction response (not a
 * replacement for it -- WHEEL_FRICTION above still sets the underlying grip ceiling), that
 * softens/suppresses REALIZED lateral acceleration in proportion to how far the CURRENT commanded
 * steering angle is below the speed-sensitive max lock (speedSensitiveSteerClamp()), progressively
 * releasing that suppression as commanded steer approaches full lock. Deliberately keyed off
 * COMMANDED steer (not a measured body/tire slip angle) so it shapes the steering-authority curve
 * specifically without also damping genuine power-oversteer (a rear-wheel-drive slide with the wheel
 * held straight is NOT suppressed by this term -- "controllable power-oversteer" stays intact, per
 * the spec's explicit "car still fun" requirement).
 */
export const LATERAL_GRIP_PEAK_G = 0.95; // target peak lateral g at/near full steer lock
/** Progressive-ramp shaping exponent (>1 => slower initial rise, "materially below max at 50%
 * steer" -- e.g. ramp(0.5) = 0.5^1.8 =~ 0.29, i.e. ~29% of peak grip authority at half steer). */
export const LATERAL_GRIP_RAMP_EXPONENT = 1.8;
/** Gain (N*m per (m/s^2) of excess realized lateral accel above the ramp's allowance) and cap (N*m)
 * for the corrective yaw torque -- same shape as the pre-existing anti-roll/anti-pitch assists. */
export const LATERAL_GRIP_ASSIST_GAIN_NM_PER_MS2 = 900;
export const LATERAL_GRIP_ASSIST_TORQUE_CAP_NM = 5000;
/** Below this forward speed (m/s), the lateral-grip governor is inert (avoids divide-by-near-zero /
 * meaningless slip-angle-proxy behavior at a standstill or crawl). */
export const LATERAL_GRIP_MIN_SPEED_MS = 2;
