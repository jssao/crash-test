// SPDX-License-Identifier: MIT
//
// THROWAWAY diagnostic (P001 fix support): determine the RevoluteJoint angle sign convention for the
// knee hinge (thigh <-> shin) empirically, rather than trusting a hand-derived quaternion chain. Seats
// one occupant, disables the passive hinge spring's restoring pull by driving the kneeL body with a
// small constant angular velocity via setAngularVelocity for a few steps, and logs:
//   - kneeL.getAngle() over time (sign + magnitude)
//   - the world height of the shin's ankle-end (local -halfLen point) relative to the knee point --
//     if the ankle point RISES toward the thigh (folding into it, the bug) as angle goes positive,
//     positive = flexion-past-seated (bad direction to allow much of). If the ankle point drops further
//     (extension, leg straightening) as angle goes positive, positive = extension (safe to allow more).
// Run: npx vite-node sim/diag/knee-hinge-sign-probe.mjs   (from game/)
import { createSim } from '../harness.mjs';
import {
	createOccupant,
	createSeatPan,
} from '../../src/world/features/occupants/physics.ts';
import { ATTACH, PART_DIMS } from '../../src/world/features/occupants/tuning.ts';

const sim = await createSim();
const chassis = sim.vehicle.chassis;
const t = chassis.getTransform();
const pan = createSeatPan(sim.world, chassis, 'frontLeft', t.position, t.rotation);
const occ = createOccupant(sim.world, chassis, 0, 'frontLeft', t.position, t.rotation);

// Let the settle-drop resolve.
for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

const shinHalfLen = PART_DIMS.shin.halfLen;
const thighHalfLen = PART_DIMS.thigh.halfLen;

/** Standard quaternion-vector rotation: v' = v + 2*q.w*(q.xyz x v) + 2*(q.xyz x (q.xyz x v)). */
function rotateVec(q, v) {
	const qv = { x: q.x, y: q.y, z: q.z };
	const cross1 = { x: qv.y * v.z - qv.z * v.y, y: qv.z * v.x - qv.x * v.z, z: qv.x * v.y - qv.y * v.x };
	const t = { x: 2 * cross1.x, y: 2 * cross1.y, z: 2 * cross1.z };
	const cross2 = { x: qv.y * t.z - qv.z * t.y, y: qv.z * t.x - qv.x * t.z, z: qv.x * t.y - qv.y * t.x };
	return {
		x: v.x + q.w * t.x + cross2.x,
		y: v.y + q.w * t.y + cross2.y,
		z: v.z + q.w * t.z + cross2.z,
	};
}

function report(label) {
	const angle = occ.joints.kneeL.getAngle();
	const shinBody = occ.parts.shinL.body;
	const thighBody = occ.parts.thighL.body;
	const shinPos = shinBody.getPosition();
	const shinRot = shinBody.getRotation();
	const thighPos = thighBody.getPosition();
	const thighRot = thighBody.getRotation();
	// Ankle-end of the shin (local -halfLen along its own Y axis -- the "far" end from the knee).
	const ankleLocal = { x: 0, y: -shinHalfLen, z: 0 };
	const ankleWorld = { x: shinPos.x + rotateVec(shinRot, ankleLocal).x, y: shinPos.y + rotateVec(shinRot, ankleLocal).y, z: shinPos.z + rotateVec(shinRot, ankleLocal).z };
	// Hip-end of the thigh (local -halfLen -- the "far" end from the knee, i.e. toward the pelvis).
	const hipLocal = { x: 0, y: -thighHalfLen, z: 0 };
	const hipWorld = { x: thighPos.x + rotateVec(thighRot, hipLocal).x, y: thighPos.y + rotateVec(thighRot, hipLocal).y, z: thighPos.z + rotateVec(thighRot, hipLocal).z };
	// Distance from the ankle to the thigh's hip-end -- if this SHRINKS, the shin is swinging up toward/
	// into the thigh (bad, flexion-past-seated). If it GROWS, the leg is extending/straightening.
	const ankleToHip = Math.hypot(ankleWorld.x - hipWorld.x, ankleWorld.y - hipWorld.y, ankleWorld.z - hipWorld.z);
	// Ankle height relative to the knee point (thigh's own knee-end, local +halfLen) -- rising = folding up.
	const kneeLocal = { x: 0, y: thighHalfLen, z: 0 };
	const kneeWorld = { x: thighPos.x + rotateVec(thighRot, kneeLocal).x, y: thighPos.y + rotateVec(thighRot, kneeLocal).y, z: thighPos.z + rotateVec(thighRot, kneeLocal).z };
	const ankleHeightAboveKnee = ankleWorld.y - kneeWorld.y;
	console.log(`${label}: angle=${angle.toFixed(3)} ankleToHipDist=${ankleToHip.toFixed(3)} ankleHeightAboveKnee=${ankleHeightAboveKnee.toFixed(3)}`);
}

report('at rest (angle~0, seated)');

// Drive the shin's angular velocity directly (bypassing the spring/limit -- disable the limit first so
// we can see the FULL range of motion and correlate angle sign with visible geometry).
occ.joints.kneeL.enableLimit(false);
const shinBody = occ.parts.shinL.body;

// Phase 1: spin +X (world/chassis lateral axis -- the hinge axis at rest, per HINGE_AXIS_ROTATION).
for (let i = 0; i < 40; i++) {
	shinBody.setAngularVelocity({ x: 1.5, y: 0, z: 0 });
	sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
}
report('after +X angular velocity spin (40 steps @ 1.5rad/s)');

sim.destroy();

// Fresh occupant for the opposite-direction test (avoid accumulated state from phase 1).
const sim2 = await createSim();
const t2 = sim2.vehicle.chassis.getTransform();
const pan2 = createSeatPan(sim2.world, sim2.vehicle.chassis, 'frontLeft', t2.position, t2.rotation);
const occ2 = createOccupant(sim2.world, sim2.vehicle.chassis, 0, 'frontLeft', t2.position, t2.rotation);
for (let i = 0; i < 30; i++) sim2.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
occ2.joints.kneeL.enableLimit(false);
function report2(label) {
	const angle = occ2.joints.kneeL.getAngle();
	const shinBody2 = occ2.parts.shinL.body;
	const thighBody2 = occ2.parts.thighL.body;
	const shinPos = shinBody2.getPosition();
	const shinRot = shinBody2.getRotation();
	const thighPos = thighBody2.getPosition();
	const thighRot = thighBody2.getRotation();
	const ankleWorld = { x: shinPos.x + rotateVec(shinRot, { x: 0, y: -shinHalfLen, z: 0 }).x, y: shinPos.y + rotateVec(shinRot, { x: 0, y: -shinHalfLen, z: 0 }).y, z: shinPos.z + rotateVec(shinRot, { x: 0, y: -shinHalfLen, z: 0 }).z };
	const hipWorld = { x: thighPos.x + rotateVec(thighRot, { x: 0, y: -thighHalfLen, z: 0 }).x, y: thighPos.y + rotateVec(thighRot, { x: 0, y: -thighHalfLen, z: 0 }).y, z: thighPos.z + rotateVec(thighRot, { x: 0, y: -thighHalfLen, z: 0 }).z };
	const ankleToHip = Math.hypot(ankleWorld.x - hipWorld.x, ankleWorld.y - hipWorld.y, ankleWorld.z - hipWorld.z);
	console.log(`${label}: angle=${angle.toFixed(3)} ankleToHipDist=${ankleToHip.toFixed(3)}`);
}
report2('occ2 at rest');
for (let i = 0; i < 40; i++) {
	occ2.parts.shinL.body.setAngularVelocity({ x: -1.5, y: 0, z: 0 });
	sim2.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
}
report2('occ2 after -X angular velocity spin (40 steps @ -1.5rad/s)');

sim2.destroy();

// ---- Elbow sign check (upperArmL <-> forearmL) ----
// At rest the arm hangs straight down (both upperArm and forearm REST_OFFSET are identity) -- angle=0
// should already be a STRAIGHT arm, unlike the knee's pre-bent zero. Determine which sign is "curl
// forward" (natural flexion, should get the generous range) vs "swing backward" (hyperextension,
// anatomically near-zero, should be tightly capped).
const sim3 = await createSim();
const t3 = sim3.vehicle.chassis.getTransform();
const pan3 = createSeatPan(sim3.world, sim3.vehicle.chassis, 'frontLeft', t3.position, t3.rotation);
const occ3 = createOccupant(sim3.world, sim3.vehicle.chassis, 0, 'frontLeft', t3.position, t3.rotation);
for (let i = 0; i < 30; i++) sim3.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
occ3.joints.elbowL.enableLimit(false);
const forearmHalfLen = PART_DIMS.forearm.halfLen;
function reportElbow(label) {
	const angle = occ3.joints.elbowL.getAngle();
	const forearmBody = occ3.parts.forearmL.body;
	const fPos = forearmBody.getPosition();
	const fRot = forearmBody.getRotation();
	// Wrist end (local -halfLen, the free/hand end).
	const wristLocal = { x: 0, y: -forearmHalfLen, z: 0 };
	const wristWorld = { x: fPos.x + rotateVec(fRot, wristLocal).x, y: fPos.y + rotateVec(fRot, wristLocal).y, z: fPos.z + rotateVec(fRot, wristLocal).z };
	// wristWorld.z relative to the elbow point (fPos + rotateVec(fRot, {0,+halfLen,0})) tells us
	// forward(+Z, chassis front)/backward(-Z) swing.
	const elbowPtLocal = { x: 0, y: forearmHalfLen, z: 0 };
	const elbowPt = { x: fPos.x + rotateVec(fRot, elbowPtLocal).x, y: fPos.y + rotateVec(fRot, elbowPtLocal).y, z: fPos.z + rotateVec(fRot, elbowPtLocal).z };
	const wristForwardOffset = wristWorld.z - elbowPt.z; // + = wrist swung forward (chassis +Z), - = backward
	console.log(`${label}: angle=${angle.toFixed(3)} wristForwardOffsetZ=${wristForwardOffset.toFixed(3)}`);
}
reportElbow('elbow at rest (angle~0, straight arm)');
for (let i = 0; i < 40; i++) {
	occ3.parts.forearmL.body.setAngularVelocity({ x: 1.5, y: 0, z: 0 });
	sim3.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
}
reportElbow('elbow after +X angular velocity spin (40 steps @ 1.5rad/s)');
sim3.destroy();

console.log('done');
