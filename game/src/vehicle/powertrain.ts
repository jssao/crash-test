// SPDX-License-Identifier: MIT
//
// RWD drivetrain model: 3-point engine torque curve, auto gearbox with shift-cut, and the
// torque-limited-velocity-servo helper used to drive each rear wheel joint's spin motor. Pure
// functions/small state objects, no three/DOM/binding import (physics core).

import { clamp } from './mathUtil';
import {
	DOWNSHIFT_RPM,
	DRIVETRAIN_EFFICIENCY,
	ENGINE_IDLE_RPM,
	ENGINE_REDLINE_RPM,
	ENGINE_TORQUE_CURVE,
	FINAL_DRIVE_RATIO,
	GEAR_RATIOS,
	SHIFT_CUT_MS,
	UPSHIFT_RPM,
} from './tuning';

const RAD_S_PER_RPM = Math.PI / 30; // 2*pi/60

/** Piecewise-linear lerp across ENGINE_TORQUE_CURVE's 3 (rpm, torque) points; clamps outside range. */
export function engineTorqueAt(rpm: number): number {
	const pts = ENGINE_TORQUE_CURVE;
	if (rpm <= pts[0].rpm) return pts[0].torqueNm;
	for (let i = 0; i < pts.length - 1; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		if (rpm <= b.rpm) {
			const t = (rpm - a.rpm) / (b.rpm - a.rpm);
			return a.torqueNm + (b.torqueNm - a.torqueNm) * t;
		}
	}
	return pts[pts.length - 1].torqueNm;
}

export interface GearboxState {
	/** 0-based index into GEAR_RATIOS. */
	gear: number;
	/** Milliseconds remaining in the post-shift torque cut. */
	shiftCutMs: number;
}

export function createGearboxState(): GearboxState {
	return { gear: 0, shiftCutMs: 0 };
}

export interface GearboxStep {
	gear: number;
	ratio: number;
	totalRatio: number;
	engineRpm: number;
	shiftCutActive: boolean;
}

/**
 * Advances gearbox shift state (mutates `state` in place) from the current absolute driven-wheel
 * angular speed, and returns the resulting gear/ratio/estimated-engine-rpm for this step.
 *
 * The engine is not simulated with its own rotational inertia -- rpm is *estimated* every step from
 * the driven wheels' measured angular speed through the current gear ratio (i.e. a rigid, no-slip
 * drivetrain from engine to wheel hub; only the tire/ground contact is allowed to slip). This is
 * exactly what the spec asks for ("Engine rpm estimated from driven-wheel average ω x ratios,
 * clamped to [idle, redline]").
 */
export function stepGearbox(state: GearboxState, wheelOmegaAbs: number, dtMs: number): GearboxStep {
	if (state.shiftCutMs > 0) {
		state.shiftCutMs = Math.max(0, state.shiftCutMs - dtMs);
	}

	const rpmFor = (gear: number) => {
		const ratio = GEAR_RATIOS[gear] * FINAL_DRIVE_RATIO;
		const raw = (wheelOmegaAbs * ratio) / RAD_S_PER_RPM;
		return clamp(raw, ENGINE_IDLE_RPM, ENGINE_REDLINE_RPM);
	};

	let rpm = rpmFor(state.gear);
	if (state.shiftCutMs <= 0) {
		if (rpm >= UPSHIFT_RPM && state.gear < GEAR_RATIOS.length - 1) {
			state.gear += 1;
			state.shiftCutMs = SHIFT_CUT_MS;
		} else if (rpm <= DOWNSHIFT_RPM && state.gear > 0) {
			state.gear -= 1;
			state.shiftCutMs = SHIFT_CUT_MS;
		}
	}
	rpm = rpmFor(state.gear);

	const ratio = GEAR_RATIOS[state.gear];
	return {
		gear: state.gear,
		ratio,
		totalRatio: ratio * FINAL_DRIVE_RATIO,
		engineRpm: rpm,
		shiftCutActive: state.shiftCutMs > 0,
	};
}

export interface DriveServoTarget {
	/** Wheel angular velocity (rad/s) the spin motor should pull toward -- see the module doc. */
	spinTargetOmega: number;
	/** Max torque (N*m) the spin motor may exert to reach it. */
	maxSpinTorqueNm: number;
}

/**
 * An intentionally-unreachable wheel angular speed (rad/s). WheelJoint.getSpinSpeed()/
 * setSpinMotorSpeed() operate on the RELATIVE spin speed between wheel and chassis about the spin
 * axis (see joint.ts's doc comment) -- NOT the vehicle's road speed. That matters a lot here: an
 * earlier version of this function targeted "this gear's redline-equivalent wheel speed" literally,
 * which the servo could satisfy purely by free-spinning the wheel *relative to the chassis*, with
 * zero need to ever push against the ground -- so the chassis never accelerated at all (the servo's
 * error hit ~0 from free-spin alone, well before any traction force was required). Using a target
 * far beyond anything physically reachable (in any gear, at any speed the tests exercise) forces the
 * servo to perpetually saturate at setMaxSpinTorque()'s cap -- i.e. genuinely constant-torque drive --
 * so real acceleration is governed entirely by torque vs. tire/ground traction, which is what
 * "wheelspin/traction emerges from the physics" requires.
 */
const UNREACHABLE_WHEEL_OMEGA = 1000;

/**
 * Torque-limited velocity servo target for a driven (rear) wheel under throttle: the servo always
 * targets UNREACHABLE_WHEEL_OMEGA (see its doc comment) -- perpetually saturating at
 * setMaxSpinTorque() (throttle-scaled engine torque x total ratio x efficiency, divided between the
 * 2 driven wheels). Traction (tire friction vs. the ground) then decides whether that torque moves
 * the car or spins the tire -- wheelspin emerges from the physics rather than being scripted.
 */
export function driveServoTarget(gearStep: GearboxStep, throttle01: number, forwardSign: 1 | -1): DriveServoTarget {
	const availableTorque = gearStep.shiftCutActive ? 0 : engineTorqueAt(gearStep.engineRpm);
	const maxSpinTorquePerWheel = (availableTorque * gearStep.totalRatio * DRIVETRAIN_EFFICIENCY * clamp(throttle01, 0, 1)) / 2;
	return {
		spinTargetOmega: forwardSign * UNREACHABLE_WHEEL_OMEGA,
		maxSpinTorqueNm: maxSpinTorquePerWheel,
	};
}

/**
 * Light engine-braking target used while coasting (no throttle, no brake pedal): targets zero wheel
 * speed with a small torque cap. DELIBERATE DEVIATION from a literal "toward idle-rpm's wheel-
 * equivalent speed" reading of the spec: that reading creates standstill idle-creep (the servo
 * perpetually pulling a stationary wheel toward a nonzero idle-equivalent speed), which fights the
 * idle-stability drive test's <0.05m/10s drift budget. Targeting zero gives the same qualitative
 * "light engine braking while coasting" behavior (a gentle decelerating pull while moving) with zero
 * commanded speed error -- hence zero torque -- at a genuine standstill.
 */
export function coastServoTarget(engineBrakeTorqueNm: number): DriveServoTarget {
	return { spinTargetOmega: 0, maxSpinTorqueNm: engineBrakeTorqueNm };
}
