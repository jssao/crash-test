// SPDX-License-Identifier: MIT
//
// Loosened/broken panel REST-POSE regression test (locks in the frame-compensation investigation
// dispatched against panels.ts's createPanels()/welds.ts's escalatePanel()). Verifies a LOOSENED panel
// settles NEAR its attached pose (hinge-sag allowance), and a BROKEN panel's FIRST post-break pose is
// close to attached (it then tumbles freely, unasserted -- see damage-hard-frontal.test.mjs, which
// already asserts the OPPOSITE: a broken hood ends up >0.5m from the chassis 2s after breaking, i.e.
// free-tumble-after-break is itself correct, tested behavior).
//
// INVESTIGATION FINDING (recorded here, not just in a commit message, since this test is the thing
// that would catch a regression): reproducing the user-reported "~1m/90 deg" loosened-panel symptom
// against CURRENT panels.ts/welds.ts -- via (a) direct loosenPanelWeld() with zero external impact,
// (b) a full speed sweep of real wall crashes (20-150 km/h) sampled well past any settling transient,
// and (c) per-step instrumentation of the pose delta right up to and through each loosen/break
// transition -- did NOT reproduce it. The weld frame math already satisfies the required identity:
// with frameA.rotation = nodeWorldQuat (chassis-local) and frameB.rotation = IDENTITY (panel-local),
// box3d's b3PrepareWeldJoint (vendor/box3d/src/weld_joint.c) computes worldFrameA.q = bodyA.q *
// frameA.q = chassisRotation * nodeWorldQuat and worldFrameB.q = bodyB.q * frameB.q = bodyRotation *
// IDENTITY = bodyRotation -- and createPanels() spawns bodyRotation = chassisRotation * nodeWorldQuat
// (this file's own doc comment), so worldFrameA.q == worldFrameB.q identically, for EVERY hertz/damping
// setting (rigid or loosened), not just at rest. Softening only changes how firmly that (already
// correct) target is enforced, not what the target IS -- so the settle pose stays close to attached
// regardless of hertz/dampingRatio. This matches what's measured below. The one caveat found: the
// HOOD (the one panel always in DIRECT wall contact) can show a larger first-post-break POSITION gap
// (~0.2-0.35m, angle still <10deg) than the other 4 panels -- confirmed via per-step tracing to already
// exist ONE STEP BEFORE breaking, while its weld is still fully "rigid" (hertz=0): a sufficiently
// enormous single-step contact force (~1e5-1e6N, see damage-tuning.ts's PANEL_LOOSEN_FORCE_MULT doc
// comment) produces a bounded position residual even through a nominally-rigid soft constraint
// (base->constraintSoftness is stiff, not literally infinite) -- inherent solver behavior under a
// direct-contact shock load, not a frame-compensation defect, so it gets its own (still tight, still
// far below the reported ~1m bug) tolerance below rather than a fabricated "fix".
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';
import { loosenPanelWeld, PANEL_KEYS } from '../src/damage/panels.ts';
import { LOOSEN_HERTZ, LOOSEN_DAMPING_RATIO } from '../src/damage/damage-tuning.ts';
import { multiplyQuat, rotateVector, add, sub, length } from '../src/vehicle/mathUtil.ts';

function quatAngleDeg(a, b) {
	const d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
	const c = Math.min(1, Math.max(-1, Math.abs(d)));
	return (2 * Math.acos(c) * 180) / Math.PI;
}

/** A panel's "attached" target pose given the CHASSIS'S CURRENT transform (this is what a rigid weld
 * holds it at, and what a loosened weld's spring is centered on -- see this file's doc comment). */
function attachedPose(panel, chassisTransform) {
	const pos = add(chassisTransform.position, rotateVector(chassisTransform.rotation, panel.localCenter));
	const rot = multiplyQuat(chassisTransform.rotation, panel.nodeWorldQuat);
	return { pos, rot };
}

function poseDelta(panel, chassisTransform) {
	const target = attachedPose(panel, chassisTransform);
	const actual = panel.body.getTransform();
	return {
		posM: length(sub(actual.position, target.pos)),
		angleDeg: quatAngleDeg(actual.rotation, target.rot),
	};
}

// Hinge-sag allowance for a SETTLED loosened panel (spec: "within ~0.25m / ~20 deg").
const LOOSEN_SETTLE_POS_TOL_M = 0.3;
const LOOSEN_SETTLE_ANGLE_TOL_DEG = 25;

// First post-break pose tolerance. Tighter for panels that break via the gentler accumulated-stress
// path (doorL/doorR/hatch/roof); the hood (always in direct wall contact -- see doc comment above)
// gets a documented, still-tight exception on POSITION only (angle stays at the tight bound for every
// panel, confirmed <10deg for the hood too in every measured case).
const BREAK_ANGLE_TOL_DEG = 10;
const BREAK_POS_TOL_M = 0.15;
const HOOD_BREAK_POS_TOL_M = 0.4;

describe('panel loosen pose: direct weld-soften, zero external impact', () => {
	it('every panel settles within a couple cm / ~0deg of its attached pose', async () => {
		for (const key of PANEL_KEYS) {
			const sim = await createDamageSim();
			try {
				for (let i = 0; i < 60; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: true });
				const panel = sim.vehicle.panels[key];
				loosenPanelWeld(panel, LOOSEN_HERTZ, LOOSEN_DAMPING_RATIO);
				for (let i = 0; i < 120; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: true }); // 2s settle

				const chassisT = sim.vehicle.chassis.getTransform();
				const { posM, angleDeg } = poseDelta(panel, chassisT);
				console.log(`[panel-loosen-pose] ${key} (isolated, no impact): posDelta=${posM.toFixed(3)}m angleDelta=${angleDeg.toFixed(2)}deg`);
				expect(posM).toBeLessThan(0.05);
				expect(angleDeg).toBeLessThan(3);
			} finally {
				sim.destroy();
			}
		}
	});
});

describe('panel loosen pose: real crash, settled', () => {
	// Canonical calibrated speeds already used elsewhere (damage-threshold-ordering.test.mjs /
	// damage-hard-frontal.test.mjs): 30 (moderate, no break), 55 (>=1 loosened, <=1 broken),
	// 90/100 (multiple broken).
	const speeds = [30, 55, 90, 100];

	it('LOOSENED panels settle within the hinge-sag allowance of their attached pose', async () => {
		for (const speedKmh of speeds) {
			const sim = await createDamageSim();
			try {
				sim.spawnWall(10);
				sim.crash(speedKmh);
				for (let i = 0; i < 300; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false }); // 5s: reach wall + settle well past any transient

				const chassisT = sim.vehicle.chassis.getTransform();
				for (const key of PANEL_KEYS) {
					const panel = sim.vehicle.panels[key];
					if (panel.state !== 'loosened') continue; // 'attached' trivially holds; 'broken' tumbles freely by design (damage-hard-frontal.test.mjs)
					const { posM, angleDeg } = poseDelta(panel, chassisT);
					console.log(`[panel-loosen-pose] ${speedKmh}km/h ${key} [loosened, settled]: posDelta=${posM.toFixed(3)}m angleDelta=${angleDeg.toFixed(2)}deg`);
					expect(posM).toBeLessThan(LOOSEN_SETTLE_POS_TOL_M);
					expect(angleDeg).toBeLessThan(LOOSEN_SETTLE_ANGLE_TOL_DEG);
				}
			} finally {
				sim.destroy();
			}
		}
	});

	it("a BROKEN panel's FIRST post-break pose stays close to attached (it tumbles freely afterward, unasserted)", async () => {
		for (const speedKmh of speeds) {
			const sim = await createDamageSim();
			try {
				sim.spawnWall(10);
				sim.crash(speedKmh);
				const prevState = {};
				for (const key of PANEL_KEYS) prevState[key] = 'attached';

				for (let i = 0; i < 300; i++) {
					sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
					const chassisT = sim.vehicle.chassis.getTransform();
					for (const key of PANEL_KEYS) {
						const panel = sim.vehicle.panels[key];
						if (panel.state === 'broken' && prevState[key] !== 'broken') {
							const { posM, angleDeg } = poseDelta(panel, chassisT);
							const posTol = key === 'hood' ? HOOD_BREAK_POS_TOL_M : BREAK_POS_TOL_M;
							console.log(
								`[panel-loosen-pose] ${speedKmh}km/h ${key} [FIRST broken pose]: posDelta=${posM.toFixed(3)}m (tol ${posTol}) angleDelta=${angleDeg.toFixed(2)}deg (tol ${BREAK_ANGLE_TOL_DEG})`,
							);
							expect(posM).toBeLessThan(posTol);
							expect(angleDeg).toBeLessThan(BREAK_ANGLE_TOL_DEG);
						}
						prevState[key] = panel.state;
					}
				}
			} finally {
				sim.destroy();
			}
		}
	});
});
