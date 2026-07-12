// SPDX-License-Identifier: MIT
//
// Renderer-free physics assembly for the crash-sandbox vehicle: 5 rigid bodies (chassis + 4 wheels)
// + 4 wheel joints (suspension, steering on the fronts, RWD spin motors on the rears) + the fixed-step
// update (drivetrain servo, brakes, steering slew, anti-roll assist). No `three` import anywhere in
// this file (or its imports) -- see tuning.ts/geometry.ts/powertrain.ts/mathUtil.ts -- so this same
// module is shared verbatim by the browser game (game/src/core/loop.ts) and the headless sim harness
// (game/sim/harness.mjs).
//
// Wheel-joint frame derivation (why the frame rotations below are what they are) is documented in
// mathUtil.ts's WHEEL_FRAME_A_ROTATION / WHEEL_FRAME_B_ROTATION doc comments.

import { Body, BodyType, Shape, World, WheelJoint, type Quat, type Vec3 } from '../../../src/ts/index.js';
import { createPanels, resetAttachedPanels, type PanelHandle, type PanelKey } from '../damage/panels';
import { buildCabinShapes, buildChassisHullPoints, buildGlassPaneShapes, deductSegmentsFromParity, solveChassisDensities, type GlassPaneKey } from './geometry';
import { createSegments, destroySegments, resetSegments, segmentMassSpecs, type SegmentAssembly } from './segments';
import {
	add,
	clamp,
	dot,
	IDENTITY_Q,
	length,
	LOCAL_FORWARD,
	LOCAL_RIGHT,
	LOCAL_UP,
	normalize,
	rotateVector,
	scale,
	sub,
	WHEEL_FRAME_A_ROTATION,
	WHEEL_FRAME_B_ROTATION,
	type Q4,
	type V3,
} from './mathUtil';
import { coastServoTarget, createGearboxState, driveServoTarget, engineTorqueAt, stepGearbox, type GearboxState } from './powertrain';
import {
	AERO_DRAG_COEFF_AREA_M2,
	AIRBORNE_DRIVE_TORQUE_CAP_NM,
	AIR_DENSITY_KG_M3,
	ANTI_PITCH_ENABLED,
	ANTI_PITCH_GAIN_ANGLE,
	ANTI_PITCH_GAIN_RATE,
	ANTI_PITCH_TORQUE_CAP_NM,
	ANTI_ROLL_ENABLED,
	ANTI_ROLL_GAIN_ANGLE,
	ANTI_ROLL_GAIN_RATE,
	ANTI_ROLL_TORQUE_CAP_NM,
	ASSIST_AUTHORITY_RAMP_TIME_S,
	BALLAST_LOCAL_Y_M,
	BALLAST_RADIUS_M,
	BRAKE_TORQUE_FRONT_NM,
	BRAKE_TORQUE_REAR_NM,
	BRAKE_TORQUE_RAMP_TIME_S,
	CAR_GROUP_INDEX,
	CHASSIS_IS_BULLET,
	CHASSIS_ORIGIN_HEIGHT_M,
	ENGINE_BRAKE_TORQUE_NM,
	FRONT_PASSIVE_DRAG_NM,
	GRAVITY_MAG,
	GROUND_CONTACT_DEFLECTION_ENTER_M,
	GROUND_CONTACT_DEFLECTION_EXIT_M,
	GROUND_FRICTION,
	HANDBRAKE_TORQUE_NM,
	LATERAL_GRIP_ASSIST_GAIN_NM_PER_MS2,
	LATERAL_GRIP_ASSIST_TORQUE_CAP_NM,
	LATERAL_GRIP_MIN_SPEED_MS,
	LATERAL_GRIP_PEAK_G,
	LATERAL_GRIP_RAMP_EXPONENT,
	EJECTED_ONLY_OCCUPANT_CATEGORY_BITS,
	OCCUPANT_TRANSPARENT_CATEGORY_BITS,
	REVERSE_ENGAGE_SPEED_MS,
	REVERSE_MAX_SPEED_MS,
	REVERSE_MAX_DRIVE_TORQUE_NM,
	STEER_CLAMP_MAX_RAD,
	STEER_CLAMP_MIN_RAD,
	STEER_CLAMP_SPEED_KMH,
	STEER_SLEW_RATE_RAD_S,
	STEERING_DAMPING_RATIO,
	STEERING_HERTZ,
	STEERING_LOWER_LIMIT_RAD,
	STEERING_MAX_TORQUE_NM,
	STEERING_UPPER_LIMIT_RAD,
	SUSPENSION_DAMPING_RATIO,
	SUSPENSION_HERTZ_FRONT,
	SUSPENSION_HERTZ_REAR,
	SUSPENSION_LOWER_LIMIT_M,
	SUSPENSION_RESTLENGTH_OFFSET_M,
	SUSPENSION_SETTLE_GRACE_STEPS,
	SUSPENSION_UPPER_LIMIT_M,
	SLIP_OVERRIDE_DEBOUNCE_STEPS,
	TRACTION_SLIP_ALLOWANCE_RAD_S,
	TRACTION_SLIP_CUTOFF_RAD_S,
	WHEEL_FRICTION,
	WHEEL_MASS_KG,
	WHEEL_RADIUS_FRONT_M,
	WHEEL_RADIUS_REAR_M,
	WHEEL_RESTITUTION,
	WHEEL_ROLLING_RESISTANCE,
	WHEEL_SPAWN_SETTLE_MARGIN_M,
	YAW_DAMPING_ENABLED,
	YAW_DAMPING_GAIN_NM_PER_RAD_S,
	YAW_DAMPING_TORQUE_CAP_NM,
} from './tuning';
import { CAR_MAP, type Vec3Mm } from '../assets/car-map';

export type WheelKey = 'fl' | 'fr' | 'rl' | 'rr';

/**
 * Entity ids tagged on the chassis/wheel bodies (Body userData), read back via hit events'
 * userDataA/userDataB (src/ts/events.ts's HitEventCursor) by the damage system (game/src/damage/
 * welds.ts, system.ts). Kept in a disjoint numeric range (1-5) from game/src/damage/panels.ts's
 * PANEL_ENTITY_ID (6-11) by convention, deliberately NOT via a shared import -- vehicle.ts already
 * imports panels.ts (createVehicle() below calls createPanels()), so panels.ts importing IDs back
 * from here would be a cycle.
 */
export const CAR_ENTITY_ID = {
	chassis: 1,
	wheel: { fl: 2, fr: 3, rl: 4, rr: 5 } as Record<WheelKey, number>,
} as const;

/**
 * Entity ids tagged on the two GLASS PANE shapes (Tier-3 Stage 2, geometry.ts buildGlassPaneShapes())
 * -- shape-level userData, which hit events report INSTEAD of the owning chassis body's tag (see
 * src/ts/events.ts), so the damage system's central drain (game/src/damage/system.ts) can tell "a
 * pane was struck" apart from "the hull was struck" and route the hit to the glass-shatter model
 * (emit glassShattered + destroy the pane) instead of the crumple/weld models. 12-13 extends the
 * car's reserved id range (chassis/wheels 1-5, panels 6-11 -- same disjoint-by-convention scheme as
 * CAR_ENTITY_ID's doc comment).
 *
 * RENUMBERED 2026-07-11 (S90 swap): was 11-12 before the rear-door panels (doorRL/doorRR) took the
 * only free panel slot -- shifted +1 to 12-13, and segments.ts's SEGMENT_ENTITY_ID/CORE_ENTITY_ID
 * shifted +1 in lockstep (14-25). See docs/loom/p0b-mustang-coupling.md section 5.
 */
export const GLASS_ENTITY_ID: Record<GlassPaneKey, number> = {
	windshield: 12,
	rearWindow: 13,
} as const;

/** The visual glass mesh node (car-map.ts glassMeshNodes) each pane corresponds to -- system.ts uses
 * this to mark the matching registered glass deformable shattered so the browser's material swap +
 * telemetry stay in sync with the physical pane. */
export const GLASS_MESH_NODE: Record<GlassPaneKey, string> = {
	windshield: 'Windshield',
	rearWindow: 'RearWindow',
} as const;

/** One destroyable glass pane on the chassis: `shape` is null once shattered (the aperture is then
 * genuinely open -- nothing occupies that collision space until a full car repair rebuilds the
 * vehicle). */
export interface GlassPaneHandle {
	key: GlassPaneKey;
	shape: Shape | null;
}

interface WheelDef {
	key: WheelKey;
	localMount: V3;
	radius: number;
	driven: boolean;
	steered: boolean;
}

function mmToLocalMount(centerMm: Vec3Mm): V3 {
	return {
		x: centerMm[0] / 1000,
		y: centerMm[1] / 1000 - CHASSIS_ORIGIN_HEIGHT_M,
		z: centerMm[2] / 1000,
	};
}

/**
 * Symmetrized per-axle mount (x mirrored +/-, y/z averaged across the L/R pair) built from the raw
 * (asymmetric) scanned car-map centers -- FIX for diagnostic B ("straight-line drift"): the raw
 * scanned wheel mounts are asymmetric (measured: FL x=975mm vs FR x=-977mm; RL x=985mm vs RR
 * x=-984mm -- 1-2mm, small in isolation, but each wheel's own traction-taper feedback loop
 * (tractionLimitedTorque()) amplified that per-wheel asymmetry into a chaotic yaw runaway: -157deg
 * at t=10s, then ~50m-radius circling). Symmetrizing eliminates the seed: measured post-fix yaw
 * converges to 4.14deg at t=10s with yaw rate -> 0.0000. Averaging (not picking one side) keeps the
 * effective track width equal to the measured value (975+977 == 2*avg(975,977)), so this does not
 * change TRACK_FRONT_M/TRACK_REAR_M's derivation from car-map.ts. Done here (not in car-map.ts,
 * which is owned by another worker in this pass) per this task's explicit ownership split.
 */
function symmetrizedAxleMounts(left: Vec3Mm, right: Vec3Mm): { left: V3; right: V3 } {
	const x = (Math.abs(left[0]) + Math.abs(right[0])) / 2;
	const y = (left[1] + right[1]) / 2;
	const z = (left[2] + right[2]) / 2;
	return {
		left: mmToLocalMount([x, y, z] as unknown as Vec3Mm),
		right: mmToLocalMount([-x, y, z] as unknown as Vec3Mm),
	};
}

/** Lowers a symmetrized axle mount by SUSPENSION_RESTLENGTH_OFFSET_M (the strut rest-length lift, see
 * tuning.ts): the JOINT anchor (frameA / zero-deflection point, and the reference getSuspensionDeflection()
 * measures against) sits this much lower in the chassis, so the body rides that much higher above the
 * ground-resting wheels. The wheel BODY still spawns at its true car-map ground-contact height -- the
 * offset is added back when computing each wheel's spawn worldPos below -- so this changes resting ride
 * height only, not where the tires touch down. */
function withRestLengthLift(m: V3): V3 {
	return { x: m.x, y: m.y - SUSPENSION_RESTLENGTH_OFFSET_M, z: m.z };
}

const FRONT_AXLE_MOUNTS = symmetrizedAxleMounts(CAR_MAP.wheels.frontLeft.centerMm, CAR_MAP.wheels.frontRight.centerMm);
const REAR_AXLE_MOUNTS = symmetrizedAxleMounts(CAR_MAP.wheels.rearLeft.centerMm, CAR_MAP.wheels.rearRight.centerMm);

const WHEEL_DEFS: readonly WheelDef[] = [
	{ key: 'fl', localMount: withRestLengthLift(FRONT_AXLE_MOUNTS.left), radius: WHEEL_RADIUS_FRONT_M, driven: false, steered: true },
	{ key: 'fr', localMount: withRestLengthLift(FRONT_AXLE_MOUNTS.right), radius: WHEEL_RADIUS_FRONT_M, driven: false, steered: true },
	{ key: 'rl', localMount: withRestLengthLift(REAR_AXLE_MOUNTS.left), radius: WHEEL_RADIUS_REAR_M, driven: true, steered: false },
	{ key: 'rr', localMount: withRestLengthLift(REAR_AXLE_MOUNTS.right), radius: WHEEL_RADIUS_REAR_M, driven: true, steered: false },
];

export interface WheelHandle {
	def: WheelDef;
	body: Body;
	/**
	 * Null once the damage system detaches this wheel (game/src/damage/welds.ts destroys the wheel
	 * joint on a constraint-force spike -- see damage-tuning.ts's WHEEL_DETACH_FORCE_MULT). Every
	 * joint-method call site below (stepVehicle/getTelemetry) guards against null so the car keeps
	 * simulating -- and keeps responding to input on its remaining wheels -- with up to 3 wheels
	 * detached (spec: "drivetrain skips missing wheels").
	 */
	joint: WheelJoint | null;
	/** @internal kept so destroyVehicle() can explicitly unregister this shape from the box3d-js
	 * live-handle registry before destroying the owning body (see that function's doc comment). */
	shape: Shape;
}

export interface Vehicle {
	world: World;
	chassis: Body;
	/** @internal chassis collision shapes -- the Tier-3 concave cabin-tub decomposition (~12 convex
	 * shapes: floorpan/nose/tail/roof/sills/pillars, see geometry.ts buildCabinShapes()). Kept only so
	 * destroyVehicle() can explicitly destroy each before destroying the chassis body (see that
	 * function's doc comment) -- createVehicle() itself never reads these back. Mass/COM/inertia are
	 * hard-set via setMassData() to the pre-Tier-3 single-hull values, so no ballast shape is needed. */
	chassisShapes: { cabin: Shape[] };
	/** Tier-3 Stage 2: the 2 destroyable solid glass panes (windshield/rear window) on the chassis --
	 * see GLASS_ENTITY_ID's doc comment. The damage system nulls a pane's shape when it shatters. */
	glass: Record<GlassPaneKey, GlassPaneHandle>;
	/** Crush M1 (crush-architecture.md §A): the 9 welded crush-segment bodies (bumperBeam/crushRails/
	 * engineCradle front, trunkFloor/rearRails rear) + their 9 chassis-anchored rigid welds, replacing
	 * the chassis's old solid NOSE/TAIL shapes. Their masses are deducted from the chassis via the
	 * setMassData parity capture below, so total car mass/COM/inertia are unchanged. See segments.ts. */
	segments: SegmentAssembly;
	wheels: Record<WheelKey, WheelHandle>;
	/** The 5 damage-system panel bodies (game/src/damage/panels.ts), rigidly welded to the chassis --
	 * see that module's createPanels() doc comment for why panels are part of the core assembly. */
	panels: Record<PanelKey, PanelHandle>;
	gearbox: GearboxState;
	commandedSteerRad: number;
	spawnPosition: V3;
	spawnRotation: Q4;
	/**
	 * Per-wheel ground-contact state (hysteresis latch, see updateWheelGroundContact()) -- FIXROUND-2
	 * addition (diagnostic A). `groundAuthority` is the rate-limited 0..1 scalar the ground-only
	 * assists (anti-roll/yaw-damping/anti-pitch/lateral-grip) are scaled by; `brakeRamp` is the
	 * analogous 0..1 ramp for commanded brake torque (diagnostic D3).
	 */
	wheelGrounded: Record<WheelKey, boolean>;
	groundAuthority: number;
	brakeRamp: number;
	/**
	 * Steps remaining in the post-spawn/post-reset suspension-SETTLE grace window, during which every
	 * wheel is forced "grounded" regardless of the raw deflection reading. FIX (found while validating
	 * diagnostic A's gating against the straight-line launch test): getSuspensionDeflection() is
	 * reconstructed from body positions, so right after spawn/reset the spring hasn't yet compressed
	 * up to its loaded equilibrium (~0.15s of settling, see WHEEL_SPAWN_SETTLE_MARGIN_M's doc comment)
	 * -- during that window deflection reads near 0, which the hysteresis latch (initialized
	 * "grounded") reads as "left the ground" on literally the first step, even though the wheel is
	 * physically in contact throughout (a real normal force is present; only the SPRING's dynamic
	 * response lags). Without this grace window, every launch spent its first ~0.15s with drivetrain
	 * torque wrongly capped to AIRBORNE_DRIVE_TORQUE_CAP_NM, costing measurable straight-line
	 * acceleration for no physical reason.
	 */
	settleStepsRemaining: number;
	/**
	 * Per-wheel count of CONSECUTIVE steps this wheel's slip (real spin speed vs
	 * chassisImpliedWheelOmega()) has stayed above TRACTION_SLIP_CUTOFF_RAD_S -- debounce for
	 * updateWheelGroundContact()'s slip-based ungrounded override (see that function's doc comment).
	 * FIX for a false-positive found while validating that fix: the pre-existing per-step wheel-speed
	 * CHATTER (tuning.ts's TRACTION_SLIP_ALLOWANCE_RAD_S doc comment) grows in absolute magnitude at
	 * high cruise speed and can spike briefly above the cutoff during perfectly ordinary, fully-
	 * grounded high-speed driving (measured: single-step slip up to ~48 rad/s at a genuine, grounded
	 * ~235km/h cruise, right at the cutoff's edge) -- an isolated single-step reading above cutoff is
	 * therefore NOT reliable evidence of genuine free-spin/airborne on its own. A genuine airborne
	 * free-spin event, by contrast, SUSTAINS well above cutoff for many consecutive steps (measured:
	 * 15+ steps in the kicker-flight repro), so requiring a short streak (see
	 * SLIP_OVERRIDE_DEBOUNCE_STEPS) before trusting the override -- the same "filter a single-step
	 * transient spike" pattern damage-tuning.ts's WHEEL_DETACH_DEBOUNCE_STEPS already uses for an
	 * analogous problem -- discriminates the two cleanly without touching the chatter itself (which is
	 * load-bearing for straight-line acceleration, see TRACTION_SLIP_ALLOWANCE_RAD_S's doc comment).
	 */
	wheelSlipOverCutoffStreak: Record<WheelKey, number>;
	/**
	 * DIAGNOSTIC (read-only, no gameplay effect): a snapshot of the drivetrain decision + per-driven-
	 * wheel spin-motor command from the MOST RECENT stepVehicle() call. Written every step so a headless
	 * reverse/traction probe (game/verify/reverse-check.mjs) can read the actual branch taken and the
	 * commanded spin target/max torque per rear wheel, rather than inferring them from pose deltas.
	 */
	driveDebug: {
		branch: 'footBrake' | 'reverse' | 'throttle' | 'coast' | 'none';
		wantReverse: boolean;
		forwardSpeed: number;
		rl: { spinTarget: number; maxTorque: number; grounded: boolean };
		rr: { spinTarget: number; maxTorque: number; grounded: boolean };
	};
}

export interface VehicleInput {
	/** 0..1 */
	throttle: number;
	/** 0..1 */
	brake: number;
	/** -1..1, positive = one steer direction (sign not gameplay-validated, see mathUtil.ts doc) */
	steer: number;
	handbrake: boolean;
}

export const NEUTRAL_INPUT: Readonly<VehicleInput> = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: false });

/**
 * Creates the ground static body (huge box, asphalt-ish friction) shared by the sim harness and the
 * game scene.
 *
 * TUNING DELTA (FIXROUND-2): default halfSize raised from 250 to 1000. ROOT-CAUSED while chasing
 * diagnostic C's "hidden top-speed runaway" and a sustained-oscillation.test.mjs regression: what
 * looked like an unbounded speed/rollover runaway in both cases was actually the car driving straight
 * off the finite 250m ground plane's edge (easily reached within a 30s full-throttle or hard-cornering
 * run once diagnostic B's drift bug no longer bleeds off speed/distance) into permanent freefall --
 * gravity alone adds ~10m/s of speed every second falling (accounting for the previously-reported
 * huge speed figures) and, once diagnostic A correctly stops artificially leveling a genuinely
 * airborne car, an existing small rotation rate integrates into a large one over that much
 * uncontested fall time (accounting for the reported rollover). 1000m half-size comfortably contains
 * a 30s run at this vehicle's actual achievable speeds (verified empirically) while remaining a tiny,
 * single static shape (negligible broad-phase cost).
 *
 * TUNING DELTA (vehicle deep-pass, residuals 1+2): raised 1000 -> 5000. The friction root-cause fix
 * (see damage/panels.ts's ground-clearance clamp doc comment) plus the resulting honest powertrain
 * settle speed (~235km/h, inside the 180-240 target band -- see AERO_DRAG_COEFF_AREA_M2's doc comment
 * below) mean a genuinely-driving car now covers much more ground per second than the pre-fix model
 * did: re-measured directly, a 30s full-throttle run can cover ~2000m, which the OLD 1000m half-size
 * no longer comfortably contains -- confirmed by reproducing the EXACT same "looks like a runaway/
 * rollover" artifact this function's own doc comment above already diagnosed once before (the car
 * drove off the 1000m edge into freefall mid-run, inflating speedKmh and integrating rotation
 * unchecked). 5000m keeps the same "tiny single static shape, negligible cost" profile while
 * comfortably containing the new, honest top speed for any test running up to ~30-45s.
 */
export function createGroundBody(world: World, halfSize = 5000): Body {
	const ground = world.createBody({ type: BodyType.Static, position: { x: 0, y: -0.5, z: 0 } });
	ground.createBoxShape({ halfExtents: { x: halfSize, y: 0.5, z: halfSize }, friction: GROUND_FRICTION, density: 1 });
	return ground;
}

/**
 * One extra rigid sprung-mass point welded into the chassis body, in chassis-local meters. SIM-ONLY:
 * the real game never passes any (its extra sprung weight comes from the actual cardetail parts +
 * occupant ragdolls the WorldFeatures attach/rest on the chassis). Used by the ride-height /
 * suspension-feel sim tests to reproduce that ~240kg feature load as a distributed chassis ballast, so
 * the headless drive tests measure the vehicle at its REAL laden operating point rather than the
 * unladen bare-vehicle one -- see game/sim/ride-height.test.mjs's LADEN_FEATURE_BALLAST. Modeled as
 * chassis-baked mass (not separate welded bodies) because static ride height / deflection is identical
 * either way, and it keeps the sim harness a single body.
 */
export interface SprungBallastPoint {
	massKg: number;
	localCenterM: V3;
}

export function createVehicle(
	world: World,
	// See tuning.ts's WHEEL_SPAWN_SETTLE_MARGIN_M doc comment: a small deliberate initial penetration
	// below the ground, not the exact tangent height, is required for stable wheel-ground contact.
	spawnPosition: V3 = { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M - WHEEL_SPAWN_SETTLE_MARGIN_M, z: 0 },
	spawnRotation: Q4 = IDENTITY_Q,
	sprungBallast: readonly SprungBallastPoint[] = [],
): Vehicle {
	const chassis = world.createBody({
		type: BodyType.Dynamic,
		position: spawnPosition,
		rotation: spawnRotation,
		isBullet: CHASSIS_IS_BULLET,
		userData: CAR_ENTITY_ID.chassis,
	});

	const solved = solveChassisDensities();

	// ---- Tier-3 STAGE 1: concave cabin tub + MASS PARITY (docs/build-log/specs/compound-hull-design.md)
	// The chassis is now a HOLLOW multi-shape composite (geometry.ts buildCabinShapes()), not one convex
	// hull. To keep ALL vehicle calibration byte-identical, its mass/COM/inertia are hard-set to what the
	// pre-Tier-3 single-hull chassis produced: build that exact legacy shape set FIRST, let box3d compute
	// its mass data, capture it, then destroy those temp shapes and stamp the captured MassData back onto
	// the real (cabin-shape) body via setMassData(). No world.step() happens in between, so the temp
	// legacy shapes never collide -- they exist purely to reproduce the engine's own mass integration.
	const TEST_BALLAST_RADIUS_M = 0.15;
	const legacyHull = chassis.createHullShape(buildChassisHullPoints(), {
		density: solved.hullDensity,
		groupIndex: CAR_GROUP_INDEX,
	});
	const legacyBallast = chassis.createSphereShape({
		radius: BALLAST_RADIUS_M,
		center: { x: 0, y: BALLAST_LOCAL_Y_M, z: 0 },
		density: solved.ballastDensity,
		isSensor: true,
		groupIndex: CAR_GROUP_INDEX,
	});
	const legacyTestBallast: Shape[] = sprungBallast.map((b) =>
		chassis.createSphereShape({
			radius: TEST_BALLAST_RADIUS_M,
			center: b.localCenterM,
			density: b.massKg / ((4 / 3) * Math.PI * TEST_BALLAST_RADIUS_M ** 3),
			isSensor: true,
			groupIndex: CAR_GROUP_INDEX,
		}),
	);
	chassis.applyMassFromShapes();
	const massParity = chassis.getMassData(); // exact HEAD chassis mass/COM/inertia (incl. sim ballast)
	legacyHull.destroy(false);
	legacyBallast.destroy(false);
	for (const b of legacyTestBallast) b.destroy(false);

	// Build the real collision geometry: the ~12 convex cabin-tub shapes. Densities are NOMINAL (mass is
	// overridden below); only geometry matters. enableHitEvents on every shape so a crash contacting ANY
	// exterior face drives the damage system's plastic crumple exactly as the single hull did (they carry
	// no own userData, so hit events fall back to the chassis body's CAR_ENTITY_ID.chassis tag).
	// groupIndex CAR_GROUP_INDEX so no cabin shape self-collides with wheels/panels.
	//
	// Tier-3 STAGE 2 (filter path): the solid NOSE and TAIL crush volumes and the FLOORPAN get
	// OCCUPANT_TRANSPARENT_CATEGORY_BITS -- seated front occupants' legs/feet live inside the nose,
	// rear occupants' torsos/heads inside the tail, and BOTH rows' lower legs dangle BELOW the
	// floorpan's top face by construction (measured, hull-cabin-tub/occupants probes: feet y -0.16..
	// -0.26 vs floor top 0.06), so the floorpan's rear face is otherwise a 13cm wall square in front
	// of the rear shins -- ordinary bump/cornering lurches arrested against it pumped 19.5kN
	// single-step spikes through the rear belts (measured). Occupant capsules therefore pass through
	// these three volumes while genuinely colliding with the UPPER interior shells (sills/roof/
	// pillars, which keep the default category); a body that slips below the cabin falls out under
	// the wreck, which reads naturally. Masks stay default, so world contacts / rays / hit events
	// against nose/tail/floorpan are byte-identical.
	// (crush M1: 'nose'/'tail' became welded segment bodies + the chassis-owned crush cores --
	// segments.ts carries the occupant transparency for all of those itself.)
	const OCCUPANT_TRANSPARENT_CABIN_SHAPES = new Set(['floorpan']);
	const cabinShapes: Shape[] = buildCabinShapes().map((def) =>
		chassis.createHullShape(def.points, {
			density: solved.hullDensity,
			friction: 0.8,
			enableHitEvents: true,
			groupIndex: CAR_GROUP_INDEX,
			...(OCCUPANT_TRANSPARENT_CABIN_SHAPES.has(def.name) ? { categoryBits: OCCUPANT_TRANSPARENT_CATEGORY_BITS } : {}),
		}),
	);
	// Tier-3 STAGE 2: the 2 solid glass panes (windshield/rear window), created BEFORE the mass-parity
	// stamp below so setMassData() overrides their nominal mass contribution too. Ejected-only occupant
	// category (see below), CAR_GROUP_INDEX (never self-collides with car parts), and their own
	// shape-level GLASS_ENTITY_ID + enableHitEvents so the damage system's central drain can consume a
	// pane strike as a glass-shatter event (system.ts). Both panes sit fully INSIDE the nose/tail crush
	// volumes (geometry.ts's Stage-2 section doc), so the outside world never reaches them -- only
	// occupants (and debris that has already penetrated the hull deeply) can.
	const glassPanePoints = buildGlassPaneShapes();
	const glass = {} as Record<GlassPaneKey, GlassPaneHandle>;
	for (const key of Object.keys(glassPanePoints) as GlassPaneKey[]) {
		glass[key] = {
			key,
			shape: chassis.createHullShape(glassPanePoints[key], {
				density: solved.hullDensity,
				friction: 0.2,
				enableHitEvents: true,
				groupIndex: CAR_GROUP_INDEX,
				// EJECTED-only occupant collision (same word as the damage panels): a SEATED occupant
				// never touches a pane -- a soft-belted torso lurching into the pane band mid-flick got
				// solver-squeezed between belt and pane for crash-magnitude belt spikes and would
				// false-shatter the windshield during hard driving (measured, sim/diag/stage2 probes) --
				// while an EJECTED body (belt broken, genuinely flying) punches it, shatters it, and
				// exits through the open aperture. See tuning.ts's OCCUPANT_EJECTED_COLLIDABLE_BIT doc.
				categoryBits: EJECTED_ONLY_OCCUPANT_CATEGORY_BITS,
				userData: GLASS_ENTITY_ID[key],
			}),
		};
	}
	// Crush structure BEFORE the parity stamp below: createSegments() adds the two crush-core shapes
	// to the CHASSIS body (their nominal shape mass must be overridden by setMassData like every other
	// chassis shape's).
	const segments = createSegments(world, chassis, spawnPosition, spawnRotation);

	// Stamp mass parity -- crush M1: the chassis is stamped with the parity REMAINDER (captured
	// single-hull mass/COM/inertia minus every welded crush segment's box contribution, geometry.ts's
	// deductSegmentsFromParity()), so the rigid composite chassis+segments reproduces the legacy
	// mass/COM/full-inertia exactly (proven by sim/segment-mass-parity.test.mjs +
	// sim/segment-structure.test.mjs's engine-integrated recomposition check).
	// setMassData is retained as long as no shape is added/removed afterward -- wheels,
	// panels and segments below are SEPARATE bodies, so this holds for the chassis body's whole
	// lifetime... with TWO deliberate exceptions: shattering a glass pane destroys that shape with
	// updateBodyMass=false (system.ts), which box3d treats as "no mass recompute", and the M2 yield
	// mechanic mutates the crush-core shapes IN PLACE via Shape.setHull (no shape add/remove at all,
	// and setHull does not recompute body mass) -- the parity mass data survives both.
	chassis.setMassData(deductSegmentsFromParity(massParity, segmentMassSpecs()));

	const wheels = {} as Record<WheelKey, WheelHandle>;
	for (const def of WHEEL_DEFS) {
		// Spawn the wheel body at its TRUE (un-lifted) car-map mount so it touches down on the ground
		// exactly as before, regardless of the rest-length lift baked into def.localMount (the joint
		// anchor). The car then settles with the chassis riding SUSPENSION_RESTLENGTH_OFFSET_M higher.
		const spawnMount = { x: def.localMount.x, y: def.localMount.y + SUSPENSION_RESTLENGTH_OFFSET_M, z: def.localMount.z };
		const worldPos = add(spawnPosition, rotateVector(spawnRotation, spawnMount));
		// BINDFIX: allowFastRotation exempts wheel bodies from box3d's per-body angular-velocity
		// safety clamp (see tuning.ts's doc comment just after FIXED_SUBSTEPS) -- upstream's own
		// guidance is that this flag should only be used for circular objects, like wheels.
		const wheelBody = world.createBody({
			type: BodyType.Dynamic,
			position: worldPos,
			rotation: spawnRotation,
			allowFastRotation: true,
			userData: CAR_ENTITY_ID.wheel[def.key],
		});
		const wheelDensity = WHEEL_MASS_KG / ((4 / 3) * Math.PI * def.radius ** 3);
		const wheelShape = wheelBody.createSphereShape({
			radius: def.radius,
			density: wheelDensity,
			friction: WHEEL_FRICTION,
			restitution: WHEEL_RESTITUTION,
			rollingResistance: WHEEL_ROLLING_RESISTANCE,
			enableContactEvents: false,
			enableHitEvents: false,
			// CAR_GROUP_INDEX (shared, negative) so wheels never self-collide with the chassis/other
			// wheels/panels -- upgrades the previous collideConnected:false on the wheel joint below,
			// which only ever covered THIS wheel's own joint pair, not e.g. wheel-vs-wheel.
			groupIndex: CAR_GROUP_INDEX,
			// Tier-3 STAGE 2: occupant-transparent (occupant capsules left the shared car group to gain
			// real interior collision, and a spinning wheel sphere is nothing an occupant should ever
			// contact -- see tuning.ts's OCCUPANT_TRANSPARENT_CATEGORY_BITS doc). Mask stays default, so
			// ground/world contact is byte-identical.
			categoryBits: OCCUPANT_TRANSPARENT_CATEGORY_BITS,
		});

		const suspensionHertz = def.steered ? SUSPENSION_HERTZ_FRONT : SUSPENSION_HERTZ_REAR;
		const joint = world.createWheelJoint(chassis, wheelBody, {
			frameA: { position: def.localMount, rotation: WHEEL_FRAME_A_ROTATION },
			frameB: { position: { x: 0, y: 0, z: 0 }, rotation: WHEEL_FRAME_B_ROTATION },
			collideConnected: false,
			enableSuspensionSpring: true,
			suspensionHertz,
			suspensionDampingRatio: SUSPENSION_DAMPING_RATIO,
			enableSuspensionLimit: true,
			lowerSuspensionLimit: SUSPENSION_LOWER_LIMIT_M,
			upperSuspensionLimit: SUSPENSION_UPPER_LIMIT_M,
			enableSpinMotor: true,
			maxSpinTorque: 0,
			spinSpeed: 0,
			enableSteering: def.steered,
			steeringHertz: STEERING_HERTZ,
			steeringDampingRatio: STEERING_DAMPING_RATIO,
			targetSteeringAngle: 0,
			maxSteeringTorque: def.steered ? STEERING_MAX_TORQUE_NM : 0,
			enableSteeringLimit: def.steered,
			lowerSteeringLimit: STEERING_LOWER_LIMIT_RAD,
			upperSteeringLimit: STEERING_UPPER_LIMIT_RAD,
		});

		wheels[def.key] = { def, body: wheelBody, joint, shape: wheelShape };
	}

	const panels = createPanels(world, chassis, spawnPosition, spawnRotation);

	return {
		world,
		chassis,
		chassisShapes: { cabin: cabinShapes },
		glass,
		segments,
		wheels,
		panels,
		gearbox: createGearboxState(),
		commandedSteerRad: 0,
		spawnPosition,
		spawnRotation,
		// Spawns with the deliberate small ground penetration (WHEEL_SPAWN_SETTLE_MARGIN_M), so treat
		// every wheel as grounded from the first step rather than waiting for the hysteresis latch to
		// catch up (avoids a spurious one-step "airborne" authority dip right at spawn).
		wheelGrounded: { fl: true, fr: true, rl: true, rr: true },
		groundAuthority: 1,
		brakeRamp: 0,
		settleStepsRemaining: SUSPENSION_SETTLE_GRACE_STEPS,
		wheelSlipOverCutoffStreak: { fl: 0, fr: 0, rl: 0, rr: 0 },
		driveDebug: {
			branch: 'none',
			wantReverse: false,
			forwardSpeed: 0,
			rl: { spinTarget: 0, maxTorque: 0, grounded: true },
			rr: { spinTarget: 0, maxTorque: 0, grounded: true },
		},
	};
}

/**
 * FULL teardown of every car body/shape/joint (chassis, wheels + their joints, panels + their welds),
 * for the "R = full car repair" reset (main.ts) -- as opposed to resetVehicle() above, which only
 * teleports bodies in place and can't undo destructive damage-system state (a broken weld/detached
 * wheel joint is gone for good; resetVehicle() only repositions still-`attached` panels, see
 * panels.ts's resetAttachedPanels()). Call createVehicle() again immediately after this to rebuild.
 *
 * Explicitly destroys each shape/joint BEFORE its owning body (mirroring panels.ts's
 * breakPanelWeld()'s own ordering) so every native handle this module created is unregistered from
 * the box3d-js live-handle registry (../../../src/ts/registry.ts) -- destroying a body alone frees its
 * shapes/joints natively too, but would leave their JS-side Shape/Joint wrapper objects' registry
 * entries stuck "live" forever (there would be no way to call .destroy() on them afterward, since the
 * Vehicle/WheelHandle/PanelHandle types already retain every shape/joint handle specifically so this
 * function can avoid that leak) -- see main.ts's full-reset handler, which checks
 * liveHandleCount() before/after a repeated R press to confirm zero net growth.
 */
export function destroyVehicle(vehicle: Vehicle): void {
	for (const w of Object.values(vehicle.wheels)) {
		if (w.joint) {
			w.joint.destroy();
			w.joint = null;
		}
		w.shape.destroy(false);
		w.body.destroy();
	}
	for (const p of Object.values(vehicle.panels)) {
		if (p.weldJoint) {
			p.weldJoint.destroy();
			p.weldJoint = null;
		}
		if (!p.despawned) {
			p.shape.destroy(false);
			p.body.destroy();
		}
	}
	// Crush segments: welds first (the cradle/trunk welds attach to the chassis, which dies below),
	// then shapes before bodies -- see destroySegments()'s doc comment.
	destroySegments(vehicle.segments);
	for (const s of vehicle.chassisShapes.cabin) s.destroy(false);
	// A shattered pane's shape was already destroyed (and nulled) by the damage system.
	for (const pane of Object.values(vehicle.glass)) {
		if (pane.shape) {
			pane.shape.destroy(false);
			pane.shape = null;
		}
	}
	vehicle.chassis.destroy();
}

export function resetVehicle(vehicle: Vehicle): void {
	vehicle.chassis.setTransform(vehicle.spawnPosition, vehicle.spawnRotation);
	vehicle.chassis.setLinearVelocity({ x: 0, y: 0, z: 0 });
	vehicle.chassis.setAngularVelocity({ x: 0, y: 0, z: 0 });
	vehicle.chassis.setAwake(true);
	for (const w of Object.values(vehicle.wheels)) {
		// Un-lift the joint mount back to the true car-map ground-contact height for the wheel body's
		// reset pose (mirrors createVehicle()'s spawnMount) -- def.localMount carries the rest-length lift.
		const spawnMount = { x: w.def.localMount.x, y: w.def.localMount.y + SUSPENSION_RESTLENGTH_OFFSET_M, z: w.def.localMount.z };
		const worldPos = add(vehicle.spawnPosition, rotateVector(vehicle.spawnRotation, spawnMount));
		w.body.setTransform(worldPos, vehicle.spawnRotation);
		w.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		w.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		w.body.setAwake(true);
	}
	resetAttachedPanels(vehicle.panels, vehicle.spawnPosition, vehicle.spawnRotation);
	resetSegments(vehicle.segments, vehicle.world, vehicle.spawnPosition, vehicle.spawnRotation);
	vehicle.gearbox.gear = 0;
	vehicle.gearbox.shiftCutMs = 0;
	vehicle.commandedSteerRad = 0;
	for (const key of Object.keys(vehicle.wheels) as WheelKey[]) {
		vehicle.wheelGrounded[key] = true;
		vehicle.wheelSlipOverCutoffStreak[key] = 0;
	}
	vehicle.groundAuthority = 1;
	vehicle.brakeRamp = 0;
	vehicle.settleStepsRemaining = SUSPENSION_SETTLE_GRACE_STEPS;
}

export function speedSensitiveSteerClamp(speedKmh: number): number {
	const t = clamp(speedKmh / STEER_CLAMP_SPEED_KMH, 0, 1);
	return STEER_CLAMP_MAX_RAD + (STEER_CLAMP_MIN_RAD - STEER_CLAMP_MAX_RAD) * t;
}

function chassisForward(rotation: Q4): V3 {
	return rotateVector(rotation, LOCAL_FORWARD);
}

function chassisUp(rotation: Q4): V3 {
	return rotateVector(rotation, LOCAL_UP);
}

/**
 * Per-wheel angular speed IMPLIED by chassis motion (v/r), INCLUDING a yaw-rate term for the wheel's
 * lateral offset from the chassis centerline (v_wheel = forwardSpeed +/- yawRate*halfTrack) -- FIX for
 * diagnostic B ("straight-line drift"): the previous single shared scalar (chassis forward speed
 * only, no yaw term) fed the SAME implied-omega value to both left and right driven wheels, so any
 * yaw rate at all (even the small residual kind a real car has mid-correction) made one wheel's real
 * omega look like genuine wheelspin relative to that shared estimate and the other look like
 * under-rotation -- an artificial per-wheel asymmetry in tractionLimitedTorque() layered on top of
 * (and, before the mount-symmetrization fix above, amplifying) the mount-asymmetry bug. Using each
 * wheel's OWN implied omega (accounting for its own lateral offset) removes that artificial asymmetry.
 */
function chassisImpliedWheelOmega(vehicle: Vehicle, wheelDef: WheelDef): number {
	const rotation = vehicle.chassis.getRotation();
	const forward = chassisForward(rotation);
	const forwardSpeed = dot(vehicle.chassis.getLinearVelocity(), forward);
	const up = chassisUp(rotation);
	const yawRate = dot(vehicle.chassis.getAngularVelocity(), up);
	// Tangential forward-direction contribution of yaw rotation at this wheel's lateral offset (see
	// mathUtil.ts's LOCAL_RIGHT convention -- localMount.x is signed per side, so this needs no
	// separate "which side" lookup): v = cross(angularVelocity, offset), forward component = -yawRate*x.
	const wheelForwardSpeed = forwardSpeed - yawRate * wheelDef.localMount.x;
	return Math.abs(wheelForwardSpeed) / wheelDef.radius;
}

/**
 * Driven-wheel angular speed IMPLIED by chassis forward speed alone (no per-wheel yaw term) -- used
 * ONLY for the gearbox's rpm estimation, which wants a single no-slip engine-to-wheel-hub estimate
 * regardless of what the tire contact patch (or yaw rate) is doing. Equal to the average of the two
 * rear wheels' chassisImpliedWheelOmega() (their yaw-rate terms are equal and opposite about the
 * centerline, so they cancel in the average) -- kept as an explicit average rather than re-deriving
 * the forward-speed formula so this stays obviously consistent with the per-wheel version above.
 */
function chassisImpliedRearOmega(vehicle: Vehicle): number {
	const rl = vehicle.wheels.rl.def;
	const rr = vehicle.wheels.rr.def;
	return (chassisImpliedWheelOmega(vehicle, rl) + chassisImpliedWheelOmega(vehicle, rr)) / 2;
}

/**
 * Traction-control-style torque taper: cuts a driven wheel's commanded max torque once its REAL
 * angular speed (`realOmega`, from joint.getSpinSpeed() -- meaningful now that allowFastRotation
 * lifts box3d's per-body rotation clamp, see the doc comment on TRACTION_SLIP_ALLOWANCE_RAD_S in
 * tuning.ts) runs measurably ahead of `impliedOmega` (chassisImpliedWheelOmega() -- what THIS wheel's
 * own chassis motion implies), i.e. genuine wheelspin rather than normal rolling. Full torque below
 * TRACTION_SLIP_ALLOWANCE_RAD_S of slip, linearly cut to zero by TRACTION_SLIP_CUTOFF_RAD_S.
 *
 * NOTE: deliberately reads realOmega RAW (unfiltered) -- see tuning.ts's TRACTION_SLIP_ALLOWANCE_RAD_S
 * doc comment for why a low-pass filter here was tried and reverted (it measurably crushed
 * straight-line acceleration; the per-wheel yaw-aware impliedOmega below already resolves diagnostic
 * B's drift on its own).
 */
function tractionLimitedTorque(realOmega: number, impliedOmega: number, maxTorqueNm: number): number {
	const slip = Math.abs(realOmega) - impliedOmega;
	const t = clamp(
		(slip - TRACTION_SLIP_ALLOWANCE_RAD_S) / (TRACTION_SLIP_CUTOFF_RAD_S - TRACTION_SLIP_ALLOWANCE_RAD_S),
		0,
		1
	);
	return maxTorqueNm * (1 - t);
}

/**
 * Updates (and returns) this wheel's ground-contact latch for this step, from getSuspensionDeflection()
 * -- FIX for diagnostic A ("airborne auto-leveling"). Hysteresis (ENTER lower than EXIT is higher,
 * see tuning.ts's doc comment) avoids chatter right at the boundary: once grounded, deflection has to
 * drop further (below EXIT) to count as airborne again, and vice versa.
 *
 * FIX (vehicle deep-pass, GATE-A item 4 regression -- reintroduced airborne auto-leveling via a
 * different path): getSuspensionDeflection() is a real-time PROXY for ground contact, not a direct
 * measurement, and it has a genuine blind spot: a wheel that leaves the ground while its suspension is
 * still heavily loaded (e.g. launching hard off a ramp under full throttle -- confirmed directly, see
 * game/sim/diag/airborne-pitch-check-*.test.mjs) keeps reading "compressed" (deflection > ENTER) for
 * up to roughly one natural spring period (SUSPENSION_HERTZ_REAR ~3Hz => ~0.3s) after truly leaving the
 * surface, simply because the spring hasn't mechanically rebounded yet -- the friction root-cause fix
 * (this pass) makes launches meaningfully harder/more heavily loaded at the moment of departure, so
 * this previously-minor lag became long enough to matter: the anti-roll/anti-pitch/yaw-damping/
 * lateral-grip assists stayed at full ground authority for a real ~0.2-0.3s after the rear wheels
 * genuinely left the kicker ramp, damping out the very airborne rotation diagnostic A's fix was meant
 * to preserve. A driven wheel that's ACTUALLY airborne has nothing to push against and free-spins --
 * this shows up as gross slip (real spin speed vs. chassisImpliedWheelOmega()) far beyond anything a
 * genuine traction-limited event produces. Reusing TRACTION_SLIP_CUTOFF_RAD_S (the taper's own
 * already-tuned "definitely no meaningful traction left" threshold, tuning.ts) as an independent,
 * deflection-lag-immune override: if a wheel's slip is this large, it cannot be meaningfully grounded
 * regardless of what the deflection proxy still reads. Confirmed safe for genuine on-ground wheelspin
 * (e.g. a hard launch from standstill): at that same slip level the taper has ALREADY cut drive torque
 * to zero anyway, and updateGroundAuthority() only drops below full authority once <2 wheels report
 * grounded, so an isolated wheel (or even both driven wheels) losing its "grounded" vote during a
 * genuine, still-on-the-ground wheelspin event doesn't change assist authority as long as the other
 * (undriven, not subject to this override) wheels still read grounded.
 *
 * DEBOUNCED (found while validating the above against sustained high-speed cruising): a single-step
 * slip reading above TRACTION_SLIP_CUTOFF_RAD_S is NOT on its own reliable evidence of free-spin --
 * the pre-existing per-step wheel-speed CHATTER (TRACTION_SLIP_ALLOWANCE_RAD_S's doc comment) grows in
 * absolute magnitude at high cruise speed and can spike briefly above the cutoff during perfectly
 * ordinary, fully-grounded ~235km/h driving (measured up to ~48 rad/s single-step, right at the
 * cutoff's edge) -- which falsely ungrounded the car mid-cruise (top-speed-bounded.test.mjs/
 * straight-line-30s.test.mjs regression). A genuine airborne free-spin event, by contrast, SUSTAINS
 * well above cutoff for many consecutive steps (measured 15+ in the kicker-flight repro) where
 * ordinary chatter alternates step to step. Requiring SLIP_OVERRIDE_DEBOUNCE_STEPS of consecutive
 * over-cutoff readings (see Vehicle.wheelSlipOverCutoffStreak's doc comment -- same debounce pattern
 * damage-tuning.ts's WHEEL_DETACH_DEBOUNCE_STEPS already uses for an analogous transient-spike problem)
 * discriminates the two without touching the chatter itself (load-bearing for straight-line
 * acceleration).
 */
function updateWheelGroundContact(vehicle: Vehicle, key: WheelKey): boolean {
	// Post-spawn/post-reset settle grace window (see Vehicle.settleStepsRemaining's doc comment):
	// the suspension spring hasn't caught up to its loaded equilibrium yet, so the deflection-based
	// heuristic below isn't trustworthy -- assume grounded unconditionally until it elapses.
	if (vehicle.settleStepsRemaining > 0) {
		vehicle.wheelGrounded[key] = true;
		vehicle.wheelSlipOverCutoffStreak[key] = 0;
		return true;
	}
	const deflection = getSuspensionDeflection(vehicle, key);
	const wasGrounded = vehicle.wheelGrounded[key];
	let grounded = wasGrounded ? deflection > GROUND_CONTACT_DEFLECTION_EXIT_M : deflection > GROUND_CONTACT_DEFLECTION_ENTER_M;

	const w = vehicle.wheels[key];
	if (w.joint) {
		const slip = Math.abs(w.joint.getSpinSpeed()) - chassisImpliedWheelOmega(vehicle, w.def);
		vehicle.wheelSlipOverCutoffStreak[key] = slip > TRACTION_SLIP_CUTOFF_RAD_S ? vehicle.wheelSlipOverCutoffStreak[key] + 1 : 0;
		if (grounded && vehicle.wheelSlipOverCutoffStreak[key] >= SLIP_OVERRIDE_DEBOUNCE_STEPS) grounded = false;
	}

	vehicle.wheelGrounded[key] = grounded;
	return grounded;
}

/**
 * Ground-only assist authority, STRICTLY gated to >=3-wheel ground contact -- ASYMMETRIC-LAUNCH
 * HONESTY REWRITE (airborne round 3, user escalation: a car launching HALF-ON the kicker ramp
 * "corrects itself flat before landing instead of flipping"). The old policy (full authority at >=2
 * grounded, PARTIAL_AUTHORITY_FLOOR below that until SUSTAINED_AIRBORNE_STEPS elapsed, symmetric
 * ramp in both directions) had two dishonesty leaks for asymmetric launches specifically:
 *   1. A half-on-ramp launch keeps EXACTLY 2 wheels (the off-ramp side) grounded until the lip --
 *      the >=2 rule held the assists at FULL authority while the ramp geometry was actively
 *      imparting the roll rate, killing the rotation at its source.
 *   2. The symmetric ASSIST_AUTHORITY_RAMP_TIME_S ramp bled decaying-but-nonzero authority into the
 *      first ~0.15s of genuine flight (takeoff reused the ramp that only ever made sense for
 *      landing re-entry smoothing).
 * New policy (every claim re-measured against the full battery -- see tuning.ts's assist-retirement
 * audit doc comment above ANTI_ROLL_ENABLED):
 *   - target 1 ONLY at >=3 wheels grounded (one lifted wheel in ordinary hard cornering is still
 *     real suspension feedback); 0 at <=2 (that state is either a genuine launch developing or a
 *     two-wheel balance no leveling torque should be faking stability for).
 *   - DOWNWARD: instant cut, zero authority bleed into flight (removing an assist torque is not a
 *     physical discontinuity -- it just stops fighting whatever rotation is real).
 *   - UPWARD: still ramped over ASSIST_AUTHORITY_RAMP_TIME_S -- landing-only smoothing, so touchdown
 *     doesn't snap full-strength leveling torque on against whatever attitude the car landed at.
 * The lowContactStreak/SUSTAINED_AIRBORNE_STEPS/PARTIAL_AUTHORITY_FLOOR machinery this replaces was
 * removed rather than kept as dead complexity -- it existed to protect a sustained-oscillation
 * rollover mode that was re-measured green under the new hard-cut policy (see tuning.ts).
 */
function updateGroundAuthority(vehicle: Vehicle, groundedCount: number, dt: number): number {
	// WHEEL-SUPPORT PLAUSIBILITY (measured leak, asym-launch probe at 20m/s half-on the kicker):
	// mid-tumble, the wheels swing on their springs from ROTATIONAL/INERTIAL load alone --
	// getSuspensionDeflection() read >ENTER on 3 wheels for ~5 consecutive steps with every wheel
	// >0.18m clear of the ground (and again for a step during the mid-trajectory ROOF slam), ramping
	// authority to 0.444 in genuine mid-flight: the deflection proxy cannot see rotation-induced
	// spring load on its own. Every measured leak step had the car past 90deg of roll/pitch (upDot
	// -0.89..-1.00), which points at the physical discriminator: suspension springs can only push
	// along chassis-down, so with upDot <= 0.5 their vertical support component is under half its
	// magnitude and "3+ wheels are carrying the car" is implausible regardless of what deflection
	// reads -- and a leveling torque against a car on its roof/side is exactly the auto-leveling
	// dishonesty this gating exists to prevent. (A stricter chassis free-fall-acceleration gate was
	// prototyped and REMOVED: redundant with this check for every measured leak, and it measurably
	// perturbed the crash suites -- a hard wall crash contains real 1-3-step free-fall-grade bounce
	// windows whose assist cut reshuffled cardetail-containment's detach outcomes.)
	const wheelsCanSupport = dot(chassisUp(vehicle.chassis.getRotation()), { x: 0, y: 1, z: 0 }) > 0.5;

	const target = groundedCount >= 3 && wheelsCanSupport ? 1 : 0;
	if (target < vehicle.groundAuthority) {
		vehicle.groundAuthority = target; // takeoff/contact-loss: instant, no authority bleed into flight
	} else {
		const maxDelta = dt / ASSIST_AUTHORITY_RAMP_TIME_S;
		vehicle.groundAuthority = clamp(vehicle.groundAuthority + Math.min(target - vehicle.groundAuthority, maxDelta), 0, 1);
	}
	return vehicle.groundAuthority;
}

/** Rate-limits the commanded brake torque's 0..1 ramp fraction -- see tuning.ts's
 * BRAKE_TORQUE_RAMP_TIME_S doc comment (diagnostic D3, braking transient spike). */
function updateBrakeRamp(vehicle: Vehicle, braking: boolean, dt: number): number {
	const target = braking ? 1 : 0;
	const maxDelta = dt / BRAKE_TORQUE_RAMP_TIME_S;
	vehicle.brakeRamp = clamp(vehicle.brakeRamp + clamp(target - vehicle.brakeRamp, -maxDelta, maxDelta), 0, 1);
	return vehicle.brakeRamp;
}

/**
 * Aerodynamic drag force opposing the chassis's full velocity vector -- FIX for diagnostic C ("hidden
 * top-speed runaway"). See tuning.ts's AERO_DRAG_COEFF_AREA_M2 doc comment.
 */
export function computeAeroDragForce(velocity: V3): V3 {
	const speed = length(velocity);
	if (speed < 1e-3) return { x: 0, y: 0, z: 0 };
	const dragMagnitude = 0.5 * AIR_DENSITY_KG_M3 * AERO_DRAG_COEFF_AREA_M2 * speed * speed;
	return scale(normalize(velocity), -dragMagnitude);
}

/**
 * Game-side progressive lateral-grip governor -- FIX for diagnostic D2. See tuning.ts's
 * LATERAL_GRIP_PEAK_G doc comment for the full rationale (box3d's isotropic Coulomb friction
 * saturates near-instantly regardless of slip angle; this shapes a progressive commanded-steer ->
 * lateral-g curve on top of it, without damping power-oversteer that happens with the wheel centered).
 */
export function computeLateralGripAssistTorque(
	rotation: Q4,
	angularVelocity: V3,
	forwardSpeed: number,
	commandedSteerRad: number,
	speedKmh: number
): V3 {
	if (Math.abs(forwardSpeed) < LATERAL_GRIP_MIN_SPEED_MS) return { x: 0, y: 0, z: 0 };
	const up = chassisUp(rotation);
	const yawRate = dot(angularVelocity, up);
	// Steady-state circular-motion proxy for realized lateral acceleration (m/s^2), signed to match
	// yawRate's turn direction -- same proxy used by the friction-feel diagnostic.
	const actualLatAccel = yawRate * forwardSpeed;
	const maxSteerAngle = speedSensitiveSteerClamp(speedKmh);
	const steerFraction = maxSteerAngle > 1e-6 ? clamp(Math.abs(commandedSteerRad) / maxSteerAngle, 0, 1) : 0;
	const rampFraction = Math.pow(steerFraction, LATERAL_GRIP_RAMP_EXPONENT);
	const allowedLatAccel = LATERAL_GRIP_PEAK_G * GRAVITY_MAG * rampFraction;
	const excess = Math.abs(actualLatAccel) - allowedLatAccel;
	if (excess <= 0) return { x: 0, y: 0, z: 0 };
	const magnitude = clamp(LATERAL_GRIP_ASSIST_GAIN_NM_PER_MS2 * excess, 0, LATERAL_GRIP_ASSIST_TORQUE_CAP_NM);
	const direction = actualLatAccel >= 0 ? -1 : 1;
	return scale(up, magnitude * direction);
}

/** Active anti-roll torque about the chassis's world forward axis, proportional to roll angle & rate, capped. */
export function computeAntiRollTorque(rotation: Q4, angularVelocity: V3): V3 {
	if (!ANTI_ROLL_ENABLED) return { x: 0, y: 0, z: 0 };
	const forward = chassisForward(rotation);
	const right = rotateVector(rotation, LOCAL_RIGHT);
	// Roll angle proxy: how far "right" has tilted toward world-up (0 when level).
	const rollAngle = Math.asin(clamp(dot(right, { x: 0, y: 1, z: 0 }), -1, 1));
	const rollRate = dot(angularVelocity, forward);
	let magnitude = -ANTI_ROLL_GAIN_ANGLE * rollAngle - ANTI_ROLL_GAIN_RATE * rollRate;
	magnitude = clamp(magnitude, -ANTI_ROLL_TORQUE_CAP_NM, ANTI_ROLL_TORQUE_CAP_NM);
	return scale(forward, magnitude);
}

/**
 * Active yaw-rate damping torque about the chassis's world-up axis, proportional to yaw rate, capped
 * -- see YAW_DAMPING_GAIN_NM_PER_RAD_S's doc comment in tuning.ts for why this was added alongside the
 * pre-existing anti-roll assist above.
 */
function computeYawDampingTorque(rotation: Q4, angularVelocity: V3): V3 {
	if (!YAW_DAMPING_ENABLED) return { x: 0, y: 0, z: 0 };
	const up = chassisUp(rotation);
	const yawRate = dot(angularVelocity, up);
	const magnitude = clamp(-YAW_DAMPING_GAIN_NM_PER_RAD_S * yawRate, -YAW_DAMPING_TORQUE_CAP_NM, YAW_DAMPING_TORQUE_CAP_NM);
	return scale(up, magnitude);
}

/**
 * Active anti-pitch torque about the chassis's world-right (lateral) axis, proportional to pitch
 * angle & rate, capped -- same shape as computeAntiRollTorque() above, about the other horizontal axis.
 * See ANTI_PITCH_GAIN_ANGLE's doc comment in tuning.ts for the sustained-oscillation rollover-via-
 * pitch this fixes.
 */
export function computeAntiPitchTorque(rotation: Q4, angularVelocity: V3): V3 {
	if (!ANTI_PITCH_ENABLED) return { x: 0, y: 0, z: 0 };
	const forward = chassisForward(rotation);
	const right = rotateVector(rotation, LOCAL_RIGHT);
	// Pitch angle proxy: how far "forward" has tilted toward world-up (0 when level, matching
	// computeAntiRollTorque()'s rollAngle proxy on "right").
	const pitchAngle = Math.asin(clamp(dot(forward, { x: 0, y: 1, z: 0 }), -1, 1));
	const pitchRate = dot(angularVelocity, right);
	let magnitude = -ANTI_PITCH_GAIN_ANGLE * pitchAngle - ANTI_PITCH_GAIN_RATE * pitchRate;
	magnitude = clamp(magnitude, -ANTI_PITCH_TORQUE_CAP_NM, ANTI_PITCH_TORQUE_CAP_NM);
	return scale(right, magnitude);
}

export interface Telemetry {
	speedKmh: number;
	gear: number;
	rpm: number;
	wheelOmegas: Record<WheelKey, number>;
	/** Rough per-wheel slip estimate, m/s: wheel contact-patch surface speed minus chassis forward
	 * speed (positive = wheel outpacing chassis / wheelspin, negative = wheel under-rotating). */
	slipHints: Record<WheelKey, number>;
	steeringAngle: number;
	chassisPos: V3;
	chassisQuat: Q4;
	rollAngleRad: number;
	yawRateRadS: number;
	upDot: number;
	/** Number of the 4 wheels currently latched as grounded (see updateWheelGroundContact()), and the
	 * rate-limited 0..1 authority scalar the ground-only assists are scaled by (see
	 * updateGroundAuthority()) -- both as of the most recent stepVehicle() call. FIXROUND-2 addition
	 * (diagnostic A), useful for regression tests asserting the airborne/grounded gating itself. */
	groundedWheelCount: number;
	assistAuthority: number;
}

export function getTelemetry(vehicle: Vehicle): Telemetry {
	const transform = vehicle.chassis.getTransform();
	const vel = vehicle.chassis.getLinearVelocity();
	const speedMs = Math.sqrt(dot(vel, vel));
	const angularVel = vehicle.chassis.getAngularVelocity();
	const up = chassisUp(transform.rotation);
	const right = rotateVector(transform.rotation, LOCAL_RIGHT);
	const forward = chassisForward(transform.rotation);
	const forwardSpeed = dot(vel, forward);
	const wheelOmegas = {} as Record<WheelKey, number>;
	const slipHints = {} as Record<WheelKey, number>;
	for (const key of Object.keys(vehicle.wheels) as WheelKey[]) {
		const w = vehicle.wheels[key];
		// Detached wheel (damage system destroyed its joint, see WheelHandle.joint's doc comment):
		// no joint to read from -- report 0 rather than throwing.
		const omega = w.joint ? w.joint.getSpinSpeed() : 0;
		wheelOmegas[key] = omega;
		slipHints[key] = omega * w.def.radius - forwardSpeed;
	}
	const gearStep = stepGearboxPeek(vehicle.gearbox, chassisImpliedRearOmega(vehicle));

	return {
		speedKmh: speedMs * 3.6,
		gear: vehicle.gearbox.gear + 1,
		rpm: gearStep.engineRpm,
		wheelOmegas,
		slipHints,
		steeringAngle: vehicle.wheels.fl.joint ? vehicle.wheels.fl.joint.getSteeringAngle() : vehicle.commandedSteerRad,
		chassisPos: transform.position,
		chassisQuat: transform.rotation,
		rollAngleRad: Math.asin(clamp(dot(right, { x: 0, y: 1, z: 0 }), -1, 1)),
		yawRateRadS: dot(angularVel, up),
		upDot: dot(up, { x: 0, y: 1, z: 0 }),
		groundedWheelCount: (Object.keys(vehicle.wheels) as WheelKey[]).filter((key) => vehicle.wheelGrounded[key]).length,
		assistAuthority: vehicle.groundAuthority,
	};
}

/**
 * Approximate suspension deflection (meters) for one wheel: the wheel body's position projected
 * onto the chassis's "up" axis, relative to where it would sit at zero suspension travel (its
 * nominal mount anchor). Not read from the joint directly (WheelJoint has no getSuspensionLength()/
 * getTranslation() accessor in this binding) -- reconstructed from body transforms instead, which is
 * exact at zero roll/pitch and a good approximation otherwise (adequate for drive-test assertions,
 * e.g. checking the suspension bump test stays within SUSPENSION_LOWER/UPPER_LIMIT_M).
 */
export function getSuspensionDeflection(vehicle: Vehicle, key: WheelKey): number {
	const w = vehicle.wheels[key];
	const chassisTransform = vehicle.chassis.getTransform();
	const anchorA = add(chassisTransform.position, rotateVector(chassisTransform.rotation, w.def.localMount));
	const wheelPos = w.body.getPosition();
	const upAxis = chassisUp(chassisTransform.rotation);
	return dot(sub(wheelPos, anchorA), upAxis);
}

/** Read-only peek at what stepGearbox() would report, without mutating shift state (telemetry only). */
function stepGearboxPeek(state: GearboxState, wheelOmegaAbs: number) {
	const copy = { gear: state.gear, shiftCutMs: state.shiftCutMs };
	return stepGearbox(copy, wheelOmegaAbs, 0);
}

/**
 * Advances the vehicle's control layer (drivetrain servo targets, brakes, steering) by one fixed
 * physics step. Call this immediately before world.step(dt, ...). Does not itself call world.step().
 */
export function stepVehicle(vehicle: Vehicle, input: VehicleInput, dt: number): void {
	// FIX (suspension-feel pass, found via game/sim/damage-moderate-impact.test.mjs regression):
	// box3d puts a body to sleep after it's held near-zero velocity for its own internal time
	// threshold (vendor/box3d), and NEITHER WheelJoint.setSpinMotorSpeed()/setMaxSpinTorque() NOR
	// Body.setTargetSteeringAngle() wake a sleeping body as a side effect (confirmed: neither
	// b3WheelJoint_SetSpinMotorSpeed nor _SetMaxSpinTorque in vendor/box3d/src/wheel_joint.c calls
	// any wake function) -- so a car that has settled to a genuine full stop and fallen asleep
	// previously stayed asleep FOREVER even under full throttle, since every joint command below was
	// silently a no-op on a sleeping body. This was a LATENT, pre-existing gap (nothing here is
	// suspension-specific), but the properly-sprung suspension this pass adds settles to true rest
	// measurably FASTER than the old bump-stop-pinned one (that's the point of fixing it) -- which
	// finally gave a stationary post-crash car enough uninterrupted low-velocity time within this
	// test's fixed settle window to actually cross box3d's sleep threshold, exposing the gap (a
	// same-class bug: a player parking, waiting, then mashing the throttle again would hit this too).
	// Any meaningful input wakes the chassis + every wheel body before the drivetrain/brake/steering
	// commands below are issued, same as resetVehicle()'s explicit setAwake(true) calls.
	const hasActiveInput = input.throttle > 1e-3 || input.brake > 1e-3 || input.handbrake || Math.abs(input.steer) > 1e-3;
	if (hasActiveInput && !vehicle.chassis.isAwake()) {
		vehicle.chassis.setAwake(true);
		for (const w of Object.values(vehicle.wheels)) w.body.setAwake(true);
	}

	const dtMs = dt * 1000;
	const rl = vehicle.wheels.rl;
	const rr = vehicle.wheels.rr;
	const impliedOmega = chassisImpliedRearOmega(vehicle);
	const gearStep = stepGearbox(vehicle.gearbox, impliedOmega, dtMs);

	const throttle = clamp(input.throttle, 0, 1);
	const brake = clamp(input.brake, 0, 1);

	// ---- Ground contact (diagnostic A: airborne auto-leveling) ----
	// Updated once per step, before anything below reads grounded state, so the drivetrain's per-wheel
	// airborne torque cap and the end-of-step assist-authority gating both see the SAME snapshot.
	if (vehicle.settleStepsRemaining > 0) vehicle.settleStepsRemaining--;
	let groundedCount = 0;
	for (const key of Object.keys(vehicle.wheels) as WheelKey[]) {
		if (updateWheelGroundContact(vehicle, key)) groundedCount++;
	}
	const groundAuthority = updateGroundAuthority(vehicle, groundedCount, dt);

	// Signed road speed along the chassis's own forward axis (+ = forward, - = backward). The brake
	// pedal (S) doubles as reverse: it foot-brakes while rolling forward, but once the car is at rest
	// or already rolling backward it drives the rear wheels in reverse instead.
	const forwardAxis = chassisForward(vehicle.chassis.getRotation());
	const forwardSpeed = dot(vehicle.chassis.getLinearVelocity(), forwardAxis);
	const wantReverse = brake > 1e-3 && forwardSpeed <= REVERSE_ENGAGE_SPEED_MS;
	const footBraking = brake > 1e-3 && !wantReverse;
	// DIAGNOSTIC snapshot (read-only, no gameplay effect) -- see Vehicle.driveDebug.
	vehicle.driveDebug.wantReverse = wantReverse;
	vehicle.driveDebug.forwardSpeed = forwardSpeed;
	vehicle.driveDebug.branch = footBraking ? 'footBrake' : wantReverse ? 'reverse' : throttle > 1e-3 ? 'throttle' : 'coast';
	// FIX (diagnostic D3, braking transient spike): commanded brake torque ramps in over
	// BRAKE_TORQUE_RAMP_TIME_S rather than snapping to full magnitude the instant the pedal is pressed.
	const brakeRamp = updateBrakeRamp(vehicle, footBraking, dt);

	/** Caps a driven wheel's commanded torque to a small value while it's off the ground AND genuinely
	 * free-spinning (diagnostic A, "free-spin look without chassis reaction windup" -- see tuning.ts's
	 * AIRBORNE_DRIVE_TORQUE_CAP_NM doc comment: the wheel joint's spin motor reacts on the chassis too,
	 * so an airborne wheel chasing an unreachable servo target at full torque would otherwise pitch/
	 * yaw-kick the chassis with nothing countering it).
	 *
	 * REVERSE-FIX (measured, game/verify/reverse-check.mjs): the cap's real failure mode -- a wheel
	 * spinning against nothing -- ALWAYS shows up as gross free-spin (real spin speed far above the
	 * chassis-implied rolling speed). It is now gated on that evidence rather than the deflection-proxy
	 * grounded flag ALONE. getSuspensionDeflection() is a lagging, pitch-sensitive proxy (its own doc
	 * comment flags this): the reverse spin-motor reaction transiently pitches the rear and drops that
	 * proxy below its ground threshold even though the rear tyre is demonstrably still on the ground
	 * (rear wheel world-Y measured dead steady), and because this car's laden REAR static deflection
	 * (~0.048m) sits just UNDER GROUND_CONTACT_DEFLECTION_ENTER_M (0.05m), the rear then latches
	 * "airborne" permanently -- capping reverse drive torque to AIRBORNE_DRIVE_TORQUE_CAP_NM and freezing
	 * the car (forward is immune: forward drive squats the rear, raising its deflection above the
	 * threshold). A wheel the proxy reads as ungrounded but that is NOT free-spinning (its real spin
	 * speed still tracks the chassis-implied rolling speed, slip < TRACTION_SLIP_ALLOWANCE_RAD_S) is not
	 * in the windup failure mode, so it keeps full torque. A genuinely airborne driven wheel free-spins
	 * to slip >> allowance within a step or two and is still capped exactly as before -- so this is a
	 * no-op for the airborne/kicker/crash suite (verified), fixing ONLY the false-airborne reverse case. */
	function airborneCappedTorque(key: WheelKey, torqueNm: number, realOmega: number, wheelImpliedOmega: number): number {
		if (vehicle.wheelGrounded[key]) return torqueNm;
		const slip = Math.abs(realOmega) - wheelImpliedOmega;
		if (slip < TRACTION_SLIP_ALLOWANCE_RAD_S) return torqueNm; // not free-spinning -> not the reaction-windup case
		return Math.min(torqueNm, AIRBORNE_DRIVE_TORQUE_CAP_NM);
	}

	// ---- Drivetrain (rear/driven wheels) ----
	// Every joint call below is guarded against a detached wheel (WheelHandle.joint === null, see its
	// doc comment) -- the damage system can destroy a wheel joint at runtime, and the car must keep
	// simulating/responding to input on its remaining wheels afterward (spec: "drivetrain skips
	// missing wheels").
	if (footBraking) {
		const torque = BRAKE_TORQUE_REAR_NM * brake * brakeRamp;
		for (const w of [rl, rr]) {
			if (!w.joint) continue;
			w.joint.setSpinMotorSpeed(0);
			w.joint.setMaxSpinTorque(torque);
		}
	} else if (wantReverse) {
		// Same torque-limited-servo pattern as forward drive, but negative target spin (forwardSign
		// -1) using low-gear torque (gearStep is gear 0 at these speeds). The SAME traction-control
		// taper as forward is essential: without it the unreachable -1000 target just free-spins the
		// wheels into a backward burnout (they hit -1000 rad/s while the car stays put -- the exact
		// no-traction failure tractionLimitedTorque() exists to prevent). Torque is also cut once the
		// reverse speed cap is reached so backing up stays gentle and bounded.
		const atReverseCap = forwardSpeed <= -REVERSE_MAX_SPEED_MS;
		const target = driveServoTarget(gearStep, brake, -1);
		for (const w of [rl, rr]) {
			if (!w.joint) continue;
			const wheelImplied = chassisImpliedWheelOmega(vehicle, w.def);
			const realOmega = w.joint.getSpinSpeed();
			w.joint.setSpinMotorSpeed(target.spinTargetOmega);
			// REVERSE-FIX: cap the reverse drive torque well below the forward-launch torque -- keeps the
			// spin-motor pitch reaction from lifting this nose-heavy car's lightly-loaded rear into a
			// pitch-runaway rock (see tuning.ts's REVERSE_MAX_DRIVE_TORQUE_NM for the measured rationale).
			const torque = atReverseCap ? 0 : Math.min(tractionLimitedTorque(realOmega, wheelImplied, target.maxSpinTorqueNm), REVERSE_MAX_DRIVE_TORQUE_NM);
			const capped = airborneCappedTorque(w.def.key, torque, realOmega, wheelImplied);
			w.joint.setMaxSpinTorque(capped);
			vehicle.driveDebug[w.def.key === 'rl' ? 'rl' : 'rr'] = { spinTarget: target.spinTargetOmega, maxTorque: capped, grounded: vehicle.wheelGrounded[w.def.key] };
		}
	} else if (throttle > 1e-3) {
		const target = driveServoTarget(gearStep, throttle, 1);
		for (const w of [rl, rr]) {
			if (!w.joint) continue;
			const wheelImplied = chassisImpliedWheelOmega(vehicle, w.def);
			const realOmega = w.joint.getSpinSpeed();
			w.joint.setSpinMotorSpeed(target.spinTargetOmega);
			const torque = tractionLimitedTorque(realOmega, wheelImplied, target.maxSpinTorqueNm);
			w.joint.setMaxSpinTorque(airborneCappedTorque(w.def.key, torque, realOmega, wheelImplied));
		}
	} else {
		const target = coastServoTarget(ENGINE_BRAKE_TORQUE_NM);
		for (const w of [rl, rr]) {
			if (!w.joint) continue;
			w.joint.setSpinMotorSpeed(target.spinTargetOmega);
			w.joint.setMaxSpinTorque(target.maxSpinTorqueNm);
		}
	}

	// ---- Handbrake (rear only, overrides drive/coast, not the footbrake) ----
	if (input.handbrake) {
		for (const w of [rl, rr]) {
			if (!w.joint) continue;
			w.joint.setSpinMotorSpeed(0);
			w.joint.setMaxSpinTorque(HANDBRAKE_TORQUE_NM);
		}
	}

	// ---- Front wheels: footbrake or light passive drag ----
	const fl = vehicle.wheels.fl;
	const fr = vehicle.wheels.fr;
	for (const w of [fl, fr]) {
		if (!w.joint) continue;
		// footBraking (not just brake>0): while reversing, the fronts must freewheel, not lock.
		if (footBraking) {
			w.joint.setSpinMotorSpeed(0);
			w.joint.setMaxSpinTorque(BRAKE_TORQUE_FRONT_NM * brake * brakeRamp);
		} else {
			w.joint.setSpinMotorSpeed(w.joint.getSpinSpeed());
			w.joint.setMaxSpinTorque(FRONT_PASSIVE_DRAG_NM);
		}
	}

	// ---- Steering (front only): speed-sensitive clamp + slew-rate limit ----
	const speedKmh = Math.sqrt(dot(vehicle.chassis.getLinearVelocity(), vehicle.chassis.getLinearVelocity())) * 3.6;
	const maxAngle = speedSensitiveSteerClamp(speedKmh);
	// Negated so the player's steer convention (steer > 0 = the D / Right key) turns the car to the
	// player's right. box3d's wheel-joint steering-angle sign (see mathUtil.ts's frame doc) runs the
	// opposite way and the chase camera looks along the car's forward axis, so a positive joint angle
	// curved the car to screen-left; negating maps D -> right, A -> left as a driver expects.
	const targetAngle = -clamp(input.steer, -1, 1) * maxAngle;
	const maxDelta = STEER_SLEW_RATE_RAD_S * dt;
	const delta = clamp(targetAngle - vehicle.commandedSteerRad, -maxDelta, maxDelta);
	vehicle.commandedSteerRad += delta;
	if (fl.joint) fl.joint.setTargetSteeringAngle(vehicle.commandedSteerRad);
	if (fr.joint) fr.joint.setTargetSteeringAngle(vehicle.commandedSteerRad);

	// ---- Ground-only assists, gated by ground authority ----
	// These terms only make physical sense while the car is meaningfully in contact with the ground --
	// summed, then scaled by groundAuthority (1 ONLY at >=3 wheels grounded, 0 at <=2; instant cut on
	// contact loss, ramped back in on landing only -- see updateGroundAuthority()) rather than applied
	// unconditionally every step regardless of airborne state.
	const transform = vehicle.chassis.getTransform();
	const angularVel = vehicle.chassis.getAngularVelocity();
	const assistTorque = add(
		add(
			add(computeAntiRollTorque(transform.rotation, angularVel), computeYawDampingTorque(transform.rotation, angularVel)),
			computeAntiPitchTorque(transform.rotation, angularVel)
		),
		computeLateralGripAssistTorque(transform.rotation, angularVel, forwardSpeed, vehicle.commandedSteerRad, speedKmh)
	);
	const gatedTorque = scale(assistTorque, groundAuthority);
	if (dot(gatedTorque, gatedTorque) > 0) {
		vehicle.chassis.applyTorque(gatedTorque, true);
	}

	// ---- Aerodynamic drag (diagnostic C: unbounded top speed) ----
	// Unlike the assists above, drag applies regardless of ground contact (a real car's aero drag
	// doesn't care whether the wheels are loaded).
	const dragForce = computeAeroDragForce(vehicle.chassis.getLinearVelocity());
	if (dot(dragForce, dragForce) > 0) {
		vehicle.chassis.applyForceToCenter(dragForce, true);
	}
}

export { engineTorqueAt };
export type { Vec3, Quat };
