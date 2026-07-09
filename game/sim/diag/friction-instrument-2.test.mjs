// DIAGNOSTIC ONLY, follow-up to friction-instrument.test.mjs: cross-checks whether the wheel
// suspension is genuinely carrying the car's weight (via getSuspensionDeflection(), independent of
// the possibly-unreliable joint.getConstraintForce() readback) with panels attached vs. relocated
// away, to disambiguate "wheels truly unloaded" from "constraint-force readback quirk".
import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { getSuspensionDeflection } from '../../src/vehicle/vehicle.ts';
import { PANEL_KEYS } from '../../src/damage/panels.ts';

describe('diag: friction instrument 2 (suspension deflection cross-check)', () => {
	it('per-wheel suspension deflection at rest: panels attached vs relocated-away', async () => {
		const simA = await createSim();
		const simB = await createSim();
		try {
			for (const key of PANEL_KEYS) {
				const p = simB.vehicle.panels[key];
				if (p.weldJoint) {
					p.weldJoint.destroy();
					p.weldJoint = null;
				}
				const pos = p.body.getPosition();
				p.body.setTransform({ x: pos.x, y: pos.y + 200, z: pos.z }, p.body.getRotation());
			}
			for (let i = 0; i < 60; i++) {
				simA.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				simB.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
			}
			const defA = {};
			const defB = {};
			for (const key of Object.keys(simA.vehicle.wheels)) {
				defA[key] = getSuspensionDeflection(simA.vehicle, key);
				defB[key] = getSuspensionDeflection(simB.vehicle, key);
			}
			console.log(`[deflection-at-rest] A(panels attached)=${JSON.stringify(defA)}`);
			console.log(`[deflection-at-rest] B(panels relocated)=${JSON.stringify(defB)}`);
			console.log(`[deflection-at-rest] chassisY A=${simA.vehicle.chassis.getPosition().y.toFixed(4)} B=${simB.vehicle.chassis.getPosition().y.toFixed(4)}`);
		} finally {
			simA.destroy();
			simB.destroy();
		}
	});
});
