// DIAGNOSTIC ONLY (vehicle deep-pass, residual 1: friction-deficit root-cause). Instruments, on the
// UNMODIFIED shipped model, exactly what the task brief asks for: per-wheel suspension normal force,
// spin torque vs actual acceleration budget, and a direct geometric check for parasitic contacts
// (panel bodies vs ground -- the hull's own GROUND_CLEARANCE_M workaround is documented as already
// fixing the hull; this checks whether the 5 damage-system panel bodies, added AFTER that fix,
// reintroduce the same class of bug).
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { CHASSIS_MASS_KG, WHEEL_MASS_KG, GRAVITY_MAG, WHEEL_RADIUS_REAR_M, GROUND_CLEARANCE_M } from '../../src/vehicle/tuning.ts';
import { PANEL_KEYS } from '../../src/damage/panels.ts';
import { rotateVector } from '../../src/vehicle/mathUtil.ts';

/** World-space half-height (Y-extent) of a box with body-local halfExtents `he`, rotated by `rot` --
 * exact for axis-permutation rotations (true for every panel body here, see panels.ts's doc comment). */
function worldHalfY(rot, he) {
	const ex = rotateVector(rot, { x: he.x, y: 0, z: 0 });
	const ey = rotateVector(rot, { x: 0, y: he.y, z: 0 });
	const ez = rotateVector(rot, { x: 0, y: 0, z: he.z });
	return Math.abs(ex.y) + Math.abs(ey.y) + Math.abs(ez.y);
}

describe('diag: friction instrument', () => {
	it('per-panel + hull world-space bottom-edge height above ground at rest and under hard launch', async () => {
		const sim = await createSim();
		try {
			for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

			function panelBottoms(label) {
				const rows = [];
				for (const key of PANEL_KEYS) {
					const p = sim.vehicle.panels[key];
					const pos = p.body.getPosition();
					const rot = p.body.getRotation();
					const bottomY = pos.y - worldHalfY(rot, p.halfExtents);
					rows.push(`${key}=${bottomY.toFixed(3)}`);
				}
				const chassisPos = sim.vehicle.chassis.getPosition();
				console.log(`[panel-ground-clearance:${label}] chassisY=${chassisPos.y.toFixed(3)} hullBottomApprox=${(chassisPos.y - GROUND_CLEARANCE_M - 0).toFixed(3)}(needs origin-height correction, see console note) ` + rows.join(' '));
			}

			panelBottoms('at-rest');

			let minDoorLBottom = Infinity;
			let minDoorRBottom = Infinity;
			let minAnyPanelBottom = Infinity;
			let minAnyPanelKey = '';
			for (let i = 0; i < 120; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				for (const key of PANEL_KEYS) {
					const p = sim.vehicle.panels[key];
					const pos = p.body.getPosition();
					const rot = p.body.getRotation();
					const bottomY = pos.y - worldHalfY(rot, p.halfExtents);
					if (key === 'doorL') minDoorLBottom = Math.min(minDoorLBottom, bottomY);
					if (key === 'doorR') minDoorRBottom = Math.min(minDoorRBottom, bottomY);
					if (bottomY < minAnyPanelBottom) {
						minAnyPanelBottom = bottomY;
						minAnyPanelKey = key;
					}
				}
			}
			panelBottoms('after-2s-launch');
			console.log(
				`[panel-ground-clearance] min doorL bottom during launch=${minDoorLBottom.toFixed(4)}m min doorR bottom=${minDoorRBottom.toFixed(4)}m ` +
					`lowest-of-all-panels=${minAnyPanelKey}@${minAnyPanelBottom.toFixed(4)}m (ground=0; NEGATIVE = penetrating/resting on ground)`,
			);
		} finally {
			sim.destroy();
		}
	});

	it('A/B: does welding the panels out of the way (no ground contact, no weld-reaction) change straight-line acceleration?', async () => {
		// Control A: shipped model, unmodified.
		const simA = await createSim();
		try {
			for (let i = 0; i < 300; i++) simA.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
			const tA = simA.telemetry();
			console.log(`[panel-ab] A (shipped, panels attached): speed@5s=${tA.speedKmh.toFixed(1)}km/h disp=${tA.chassisPos.z.toFixed(2)}m`);

			// Variant B: destroy every panel weld + relocate the panel bodies 200m straight up (out of
			// contact range with anything) BEFORE driving, isolating "panels physically present and
			// welded" as the only difference from A.
			const simB = await createSim();
			for (const key of PANEL_KEYS) {
				const p = simB.vehicle.panels[key];
				if (p.weldJoint) {
					p.weldJoint.destroy();
					p.weldJoint = null;
				}
				const pos = p.body.getPosition();
				p.body.setTransform({ x: pos.x, y: pos.y + 200, z: pos.z }, p.body.getRotation());
				p.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
				p.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
			}
			for (let i = 0; i < 300; i++) simB.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
			const tB = simB.telemetry();
			console.log(`[panel-ab] B (panels relocated away, welds destroyed): speed@5s=${tB.speedKmh.toFixed(1)}km/h disp=${tB.chassisPos.z.toFixed(2)}m`);
			console.log(`[panel-ab] delta = ${(tB.speedKmh - tA.speedKmh).toFixed(2)}km/h`);
			simB.destroy();
		} finally {
			simA.destroy();
		}
	});

	it('per-wheel suspension vertical load (joint.getConstraintForce() . world-up) vs total vehicle weight', async () => {
		const sim = await createSim();
		try {
			for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });

			const totalMassKg = CHASSIS_MASS_KG + 4 * WHEEL_MASS_KG + 71;
			const weightN = totalMassKg * GRAVITY_MAG;

			function sumWheelVerticalLoad() {
				let sum = 0;
				const perWheel = {};
				for (const key of Object.keys(sim.vehicle.wheels)) {
					const w = sim.vehicle.wheels[key];
					if (!w.joint) continue;
					const f = w.joint.getConstraintForce();
					perWheel[key] = f.y;
					sum += f.y;
				}
				return { sum, perWheel };
			}

			const rest = sumWheelVerticalLoad();
			console.log(`[wheel-load:at-rest] sum=${rest.sum.toFixed(0)}N weight=${weightN.toFixed(0)}N ratio=${(rest.sum / weightN).toFixed(3)} perWheel=${JSON.stringify(rest.perWheel)}`);

			for (let i = 0; i < 60; i++) sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
			const launch = sumWheelVerticalLoad();
			console.log(`[wheel-load:1s-launch] sum=${launch.sum.toFixed(0)}N weight=${weightN.toFixed(0)}N ratio=${(launch.sum / weightN).toFixed(3)} perWheel=${JSON.stringify(launch.perWheel)}`);
		} finally {
			sim.destroy();
		}
	});

	it('actual longitudinal force delivered (measured accel * mass) vs torque/radius available at the rear contact patch', async () => {
		const sim = await createSim();
		try {
			for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
			const totalMassKg = CHASSIS_MASS_KG + 4 * WHEEL_MASS_KG + 71;

			let prevSpeedMs = 0;
			const rows = [];
			for (let i = 0; i < 90; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				const t = sim.telemetry();
				const speedMs = t.speedKmh / 3.6;
				const accelMs2 = (speedMs - prevSpeedMs) / (1 / 60);
				prevSpeedMs = speedMs;
				const measuredForceN = accelMs2 * totalMassKg;
				let spinTorqueSum = 0;
				for (const key of ['rl', 'rr']) {
					const w = sim.vehicle.wheels[key];
					if (w.joint) spinTorqueSum += Math.abs(w.joint.getSpinTorque());
				}
				const wheelForceFromTorqueN = spinTorqueSum / WHEEL_RADIUS_REAR_M;
				if (i % 6 === 0) {
					rows.push(
						`t=${(i / 60).toFixed(2)} speed=${t.speedKmh.toFixed(1)}km/h measuredF=${measuredForceN.toFixed(0)}N ` +
							`wheelTorqueF=${wheelForceFromTorqueN.toFixed(0)}N ratio=${(measuredForceN / wheelForceFromTorqueN).toFixed(3)} gear=${t.gear}`,
					);
				}
			}
			console.log('[force-budget]\n' + rows.join('\n'));
		} finally {
			sim.destroy();
		}
	});
});
