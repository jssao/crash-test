// SPDX-License-Identifier: MIT
// Stage-2 diagnosis probe 5 (vite-node): car dynamics through the seated-stability phases WITHOUT
// occupants -- speed, lateral accel, yaw rate -- to judge how violent the 'left' flick really is.
import { createSim } from '../harness.mjs';

const sim = await createSim();
for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
const phases = [
	{ name: 'launch', throttle: 1, brake: 0, steer: 0 },
	{ name: 'right', throttle: 0.6, brake: 0, steer: 0.2 },
	{ name: 'left', throttle: 0.6, brake: 0, steer: -0.2 },
	{ name: 'brake', throttle: 0, brake: 0.5, steer: 0 },
];
let step = 0;
let prevV = sim.vehicle.chassis.getLinearVelocity();
for (const phase of phases) {
	let peakA = 0;
	let peakYaw = 0;
	for (let i = 0; i < 150; i++, step++) {
		sim.step({ throttle: phase.throttle, brake: phase.brake, steer: phase.steer, handbrake: false });
		const v = sim.vehicle.chassis.getLinearVelocity();
		const a = Math.hypot(v.x - prevV.x, v.y - prevV.y, v.z - prevV.z) * 60 / 10; // g (g=10)
		prevV = v;
		const w = sim.vehicle.chassis.getAngularVelocity();
		peakA = Math.max(peakA, a);
		peakYaw = Math.max(peakYaw, Math.abs(w.y));
		if (step >= 330 && step <= 355) {
			console.log(`step=${step} speed=${Math.hypot(v.x, v.z).toFixed(1)}m/s accel=${a.toFixed(2)}g yawRate=${w.y.toFixed(2)}rad/s`);
		}
	}
	const v = sim.vehicle.chassis.getLinearVelocity();
	console.log(`phase=${phase.name}: endSpeed=${Math.hypot(v.x, v.z).toFixed(1)}m/s peakAccel=${peakA.toFixed(2)}g peakYawRate=${peakYaw.toFixed(2)}rad/s`);
}
sim.destroy();
