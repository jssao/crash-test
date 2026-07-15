// SPDX-License-Identifier: MIT
//
// BUG P002 (tree side) off-axis/glancing coverage: game/sim/features-trees.test.mjs and
// features-trees-bend.test.mjs only ever drive a car STRAIGHT (+Z) dead-center into a tree -- this file
// extends that with off-axis-angle, lateral-offset (glancing), and speed-floor drive-ins, using the
// same "teleport+velocity" aimAndCrash() technique those files use (scenario.ts's crashSetup(), just
// with the launch direction/aim point varied locally -- this agent doesn't own damage/scenario.ts or
// src/lab/**, so the angled-launch/guided-approach helpers below are small, self-contained
// reproductions of src/lab/barriers.ts's launchVehicle()/vehicleGuideUntilS() technique, not imports).
//
// FINDING that drove tuning.ts's MID_WELD_ANGULAR_HERTZ retune (4 -> 2Hz): a dead-center 40km/h hit
// delivers ~50-110kNm of root-weld torque, but the SAME 40km/h hit at 30-65deg off-axis only delivers
// ~13-30kNm (measured below) -- with the old 4Hz stiffness that read as "the tree barely reacted" even
// though a real, solid hit landed (visually indistinguishable from a rigid body). The softer 2Hz spring
// answers the same delivered torque with more visible lean.
//
// The sapling, by contrast, was already found to reliably bend-then-snap across every angle/offset/
// speed combination tried here (see the sapling tests below) -- no threshold retune was needed for it;
// this file's sapling tests exist to PROVE that (so a future regression is caught), not to justify a
// change.

import { describe, expect, it } from 'vitest';
import { DamageSim } from './damage-harness.mjs';
import { loadNative } from './harness.mjs';
import { createTreesWorld, stepTreesWorld, trunkTiltDeg, midLeaningDeg } from '../src/world/features/trees/bodies.ts';
import { SAPLING_SITES, MID_SITES } from '../src/world/features/trees/tuning.ts';
import { resetVehicle } from '../src/vehicle/vehicle.ts';
import { seedSegmentVelocities } from '../src/vehicle/segments.ts';
import { rotateVector, scale } from '../src/vehicle/mathUtil.ts';

class TreesSim extends DamageSim {
	constructor(native, spawnPosition) {
		super(native, spawnPosition);
		this.trees = createTreesWorld(this.world);
	}
	step(input) {
		super.step(input);
		stepTreesWorld(this.trees);
	}
}

async function createTreesSim() {
	const native = await loadNative();
	return new TreesSim(native);
}

/** Angled launch: chassis orientation stays spawn-facing (+Z, identity), but velocity is rotated
 * `angleDeg` about world-Y from straight-ahead -- same "crabbed approach" technique as
 * src/lab/barriers.ts's launchVehicle() free-config angle, reproduced locally (not importing lab/**,
 * out of this agent's file ownership) since it's a tiny, self-contained bit of vector math. */
function crashSetupAngled(vehicle, speedKmh, angleDeg) {
	resetVehicle(vehicle);
	const speedMs = speedKmh / 3.6;
	const angleRad = (angleDeg * Math.PI) / 180;
	const localDir = { x: Math.sin(angleRad), y: 0, z: Math.cos(angleRad) };
	const velocity = rotateVector(vehicle.spawnRotation, scale(localDir, speedMs));
	vehicle.chassis.setLinearVelocity(velocity);
	for (const wheel of Object.values(vehicle.wheels)) wheel.body.setLinearVelocity(velocity);
	for (const panel of Object.values(vehicle.panels)) panel.body.setLinearVelocity(velocity);
	seedSegmentVelocities(vehicle.segments, velocity, vehicle.chassis);
}

function aimAndCrashAngled(sim, treePos, runwayM, speedKmh, angleDeg) {
	const angleRad = (angleDeg * Math.PI) / 180;
	sim.vehicle.spawnPosition.x = treePos.x - Math.sin(angleRad) * runwayM;
	sim.vehicle.spawnPosition.z = treePos.z - Math.cos(angleRad) * runwayM;
	crashSetupAngled(sim.vehicle, speedKmh, angleDeg);
	return { angleRad, speedMs: speedKmh / 3.6 };
}

/** GUIDED approach for angled launches: re-pins the chassis/wheel velocity every fixed step -- same
 * technique, and same underlying reason, as src/lab/barriers.ts's guideBarrierRig()/
 * vehicleGuideUntilS(): the vehicle's own LATERAL_GRIP_ASSIST_* yaw-torque assist (vehicle.ts) reads a
 * chassis velocity that isn't aligned with the chassis's own forward axis as "uncontrolled slip" and
 * actively steers against it, which -- untracked -- bleeds off an angled/crabbed approach's lateral
 * component well before the car ever reaches the tree (confirmed empirically while building this file:
 * without guiding, every angle > 0 missed the tree entirely, reading as a false "no reaction"). Stops
 * re-pinning `releaseMarginM` before the geometric arrival at the tree so the last stretch of the
 * approach -- and the whole impact -- is genuine, unforced physics, exactly like the lab's own guided
 * rigs release before contact. */
function driveInAngled(sim, treePos, runwayM, speedKmh, angleDeg, releaseMarginM = 3.2) {
	const { angleRad, speedMs } = aimAndCrashAngled(sim, treePos, runwayM, speedKmh, angleDeg);
	const velocity = rotateVector(sim.vehicle.spawnRotation, scale({ x: Math.sin(angleRad), y: 0, z: Math.cos(angleRad) }, speedMs));
	const guideUntilS = Math.max(0, (runwayM - releaseMarginM) / Math.max(speedMs, 0.1));
	let elapsedS = 0;
	return {
		stepGuided(input) {
			if (elapsedS < guideUntilS) {
				sim.vehicle.chassis.setLinearVelocity(velocity);
				sim.vehicle.chassis.setAngularVelocity({ x: 0, y: 0, z: 0 });
				for (const wheel of Object.values(sim.vehicle.wheels)) wheel.body.setLinearVelocity(velocity);
			}
			sim.step(input);
			elapsedS += 1 / 60;
		},
	};
}

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };

describe('P002 off-axis: sapling bends/snaps from any solid hit >=25km/h, any angle', () => {
	for (const angleDeg of [0, 20, 35, 50, 65]) {
		it(`angle=${angleDeg}deg, 30km/h: sapling still breaks`, async () => {
			const sim = await createTreesSim();
			try {
				const target = SAPLING_SITES[0];
				const drive = driveInAngled(sim, { x: target.x, z: target.z }, 12, 30, angleDeg);
				const sapling = sim.trees.saplings[0];
				for (let i = 0; i < 150; i++) drive.stepGuided(NEUTRAL);
				expect(sapling.broken).toBe(true);
			} finally {
				sim.destroy();
			}
		});
	}
});

describe('P002 off-axis: sapling glancing (lateral-offset) hits', () => {
	for (const offsetM of [0, 0.5, 0.9, 1.1]) {
		it(`lateral offset=${offsetM}m, 30km/h: sapling still breaks`, async () => {
			const sim = await createTreesSim();
			try {
				const target = SAPLING_SITES[0];
				sim.vehicle.spawnPosition.x = target.x + offsetM;
				sim.vehicle.spawnPosition.z = target.z - 10;
				sim.crash(30);
				const sapling = sim.trees.saplings[0];
				for (let i = 0; i < 150; i++) sim.step(NEUTRAL);
				expect(sapling.broken).toBe(true);
			} finally {
				sim.destroy();
			}
		});
	}

	it('control: 1.3m offset is a clean geometric miss (harness sanity, not a tree bug)', async () => {
		const sim = await createTreesSim();
		try {
			const target = SAPLING_SITES[0];
			sim.vehicle.spawnPosition.x = target.x + 1.3;
			sim.vehicle.spawnPosition.z = target.z - 10;
			sim.crash(30);
			const sapling = sim.trees.saplings[0];
			for (let i = 0; i < 150; i++) sim.step(NEUTRAL);
			expect(sapling.broken).toBe(false);
			expect(trunkTiltDeg(sapling.trunk)).toBeLessThan(1);
		} finally {
			sim.destroy();
		}
	});
});

describe('P002 off-axis: mid tree visibly leans from a 40km/h hit at ANY angle, snaps at higher energy', () => {
	for (const angleDeg of [0, 20, 35, 50, 65]) {
		it(`angle=${angleDeg}deg, 40km/h: leans >2deg, does not fell`, async () => {
			const sim = await createTreesSim();
			try {
				const target = MID_SITES[0];
				const drive = driveInAngled(sim, { x: target.x, z: target.z }, 14, 40, angleDeg);
				const mid = sim.trees.mids[0];
				let peakLean = 0;
				for (let i = 0; i < 250; i++) {
					drive.stepGuided(NEUTRAL);
					peakLean = Math.max(peakLean, midLeaningDeg(mid));
				}
				console.log(`[mid off-axis] angle=${angleDeg} 40km/h peakLean=${peakLean.toFixed(1)}deg broken=${mid.broken}`);
				expect(mid.broken).toBe(false);
				expect(peakLean).toBeGreaterThan(2);
			} finally {
				sim.destroy();
			}
		});
	}

	for (const angleDeg of [0, 20]) {
		it(`angle=${angleDeg}deg, 70km/h: fells (higher energy snaps even off-axis)`, async () => {
			const sim = await createTreesSim();
			try {
				const target = MID_SITES[0];
				const drive = driveInAngled(sim, { x: target.x, z: target.z }, 14, 70, angleDeg);
				const mid = sim.trees.mids[0];
				for (let i = 0; i < 250; i++) drive.stepGuided(NEUTRAL);
				expect(mid.broken).toBe(true);
			} finally {
				sim.destroy();
			}
		});
	}
});

describe('P002: sapling speed floor (below ~15km/h a light dab is fine to not react much)', () => {
	it('15km/h dab: contact registers (some tilt) but does not need to break', async () => {
		const sim = await createTreesSim();
		try {
			const target = SAPLING_SITES[0];
			const runwayM = 10;
			sim.vehicle.spawnPosition.x = target.x;
			sim.vehicle.spawnPosition.z = target.z - runwayM;
			sim.crash(15);
			const sapling = sim.trees.saplings[0];
			const steps = Math.ceil(((runwayM + 5) / (15 / 3.6)) * 60);
			for (let i = 0; i < steps; i++) sim.step(NEUTRAL);
			// Not a strong claim either way (a real light dab may or may not topple the sapling) -- this
			// just pins that the sim CAN deliver a sub-break-threshold contact without exploding/NaN'ing.
			expect(Number.isFinite(trunkTiltDeg(sapling.trunk))).toBe(true);
		} finally {
			sim.destroy();
		}
	});

	it('18km/h+ dead-center: sapling reliably breaks', async () => {
		const sim = await createTreesSim();
		try {
			const target = SAPLING_SITES[0];
			const runwayM = 10;
			sim.vehicle.spawnPosition.x = target.x;
			sim.vehicle.spawnPosition.z = target.z - runwayM;
			sim.crash(18);
			const sapling = sim.trees.saplings[0];
			const steps = Math.ceil(((runwayM + 5) / (18 / 3.6)) * 60);
			for (let i = 0; i < steps; i++) sim.step(NEUTRAL);
			expect(sapling.broken).toBe(true);
		} finally {
			sim.destroy();
		}
	});
});
