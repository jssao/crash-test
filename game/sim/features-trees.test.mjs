// SPDX-License-Identifier: MIT
//
// Headless sim tests for the 'trees' world feature (3 size classes): scripted drive-ins targeting
// one instance of each class directly (custom vehicle spawn position/velocity aimed straight at that
// tree's trunk, same "teleport+velocity" technique as game/src/damage/scenario.ts's crashSetup()),
// verifying the class-specific crash behavior the orchestrator spec'd. Imports the feature module
// directly (skip the registry -- see world/features/registry.ts's module doc) and extends the
// existing damage-test harness (game/sim/damage-harness.mjs) so 'car damage event fired' can be
// checked against the SAME central damage system the browser game uses.

import { describe, expect, it } from 'vitest';
import { DamageSim } from './damage-harness.mjs';
import { loadNative } from './harness.mjs';
import { createTreesWorld, stepTreesWorld, resetTreesWorld, treesBodyCount } from '../src/world/features/trees/bodies.ts';
import { SAPLING_SITES, MID_SITES, LARGE_SITES } from '../src/world/features/trees/tuning.ts';
import { dot, LOCAL_UP, rotateVector } from '../src/vehicle/mathUtil.ts';
import { CHASSIS_ORIGIN_HEIGHT_M } from '../src/vehicle/tuning.ts';

class TreesSim extends DamageSim {
	constructor(native, spawnPosition) {
		super(native, spawnPosition);
		this.trees = createTreesWorld(this.world);
	}

	step(input) {
		super.step(input);
		stepTreesWorld(this.trees);
	}

	resetTrees() {
		resetTreesWorld(this.world, this.trees);
	}
}

async function createTreesSim(spawnPosition) {
	const native = await loadNative();
	return new TreesSim(native, spawnPosition);
}

function tiltDeg(rotation) {
	const up = rotateVector(rotation, LOCAL_UP);
	const c = Math.max(-1, Math.min(1, dot(up, { x: 0, y: 1, z: 0 })));
	return (Math.acos(c) * 180) / Math.PI;
}

function forwardSpeed(chassis) {
	const v = chassis.getLinearVelocity();
	return Math.hypot(v.x, v.z);
}

function distXZ(a, b) {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Aim the car straight (+Z) at `treePos`, starting `runwayM` meters short of it, at `speedKmh`. */
function aimAndCrash(sim, treePos, runwayM, speedKmh) {
	sim.vehicle.spawnPosition.x = treePos.x;
	sim.vehicle.spawnPosition.z = treePos.z - runwayM;
	sim.crash(speedKmh);
}

function checkAllFinite(sim) {
	const t = sim.vehicle.chassis.getTransform();
	const vals = [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w];
	for (const v of vals) expect(Number.isFinite(v)).toBe(true);
	for (const s of sim.trees.saplings) {
		const p = s.trunk.getPosition();
		expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
	}
	for (const m of sim.trees.mids) {
		const p = m.trunk.getPosition();
		expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
	}
	for (const l of sim.trees.larges) {
		for (const b of l.branches) {
			const p = b.body.getPosition();
			expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
		}
	}
}

describe('feature: trees', () => {
	it('bodyCount is honest and non-zero', async () => {
		const sim = await createTreesSim();
		try {
			const n = treesBodyCount(sim.trees);
			expect(n).toBeGreaterThan(0);
			console.log(`[trees] treesBodyCount=${n} saplings=${sim.trees.saplings.length} mids=${sim.trees.mids.length} larges=${sim.trees.larges.length}`);
		} finally {
			sim.destroy();
		}
	});

	it('sapling at ~30km/h: joint breaks, car keeps most of its speed, sapling topples', async () => {
		const sim = await createTreesSim();
		try {
			const target = SAPLING_SITES[0];
			const runway = 10;
			const speedKmh = 30;
			aimAndCrash(sim, { x: target.x, z: target.z }, runway, speedKmh);
			const initialSpeed = forwardSpeed(sim.vehicle.chassis);

			const sapling = sim.trees.saplings[0];
			let brokeAtStep = -1;
			const steps = 200;
			// SAMPLE_LAG_STEPS after the break (not the run's arbitrary end): the freed trunk gets
			// flung, tumbles, and can eventually land back in the car's path -- letting the sim run
			// on for hundreds more steps and reading "final" speed there conflates the CRASH's own
			// speed loss with the car later re-grinding over a fallen branch (and, separately, with
			// this coasting rig's own baseline drag/rolling-resistance decel at zero throttle, which
			// alone costs ~25% of initial speed over ~1.5s -- confirmed by a throwaway no-tree control
			// run while calibrating this test). Sampling shortly after the break isolates the crash's
			// own effect, which is what "car keeps >60% of speed" is actually about.
			const SAMPLE_LAG_STEPS = 40;
			const speeds = [];
			const tilts = [];
			for (let i = 0; i < steps; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				checkAllFinite(sim);
				if (brokeAtStep < 0 && sapling.broken) brokeAtStep = i;
				speeds.push(forwardSpeed(sim.vehicle.chassis));
				tilts.push(tiltDeg(sapling.trunk.getRotation()));
			}

			expect(brokeAtStep).toBeGreaterThanOrEqual(0);
			const sampleAt = Math.min(brokeAtStep + SAMPLE_LAG_STEPS, steps - 1);
			const finalSpeed = speeds[sampleAt];
			const finalTilt = tilts[sampleAt];
			console.log(
				`[sapling] brokeAtStep=${brokeAtStep} sampleAt=${sampleAt} initialSpeed=${initialSpeed.toFixed(2)}m/s finalSpeed=${finalSpeed.toFixed(2)}m/s ` +
					`(${((finalSpeed / initialSpeed) * 100).toFixed(0)}%) finalTilt=${finalTilt.toFixed(1)}deg`,
			);

			expect(sapling.broken).toBe(true);
			expect(finalSpeed).toBeGreaterThan(initialSpeed * 0.6);
			expect(finalTilt).toBeGreaterThan(45);
		} finally {
			sim.destroy();
		}
	});

	it('mid tree at ~80km/h: root weld breaks, trunk displaced, car speed drops materially', async () => {
		const sim = await createTreesSim();
		try {
			const target = MID_SITES[0];
			const runway = 12;
			const speedKmh = 80;
			aimAndCrash(sim, { x: target.x, z: target.z }, runway, speedKmh);
			const initialSpeed = forwardSpeed(sim.vehicle.chassis);

			const mid = sim.trees.mids[0];
			let brokeAtStep = -1;
			const steps = 300;
			for (let i = 0; i < steps; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				checkAllFinite(sim);
				if (brokeAtStep < 0 && mid.broken) brokeAtStep = i;
			}

			const finalSpeed = forwardSpeed(sim.vehicle.chassis);
			const displacement = distXZ(mid.trunk.getPosition(), mid.spawnPos);
			console.log(
				`[mid] brokeAtStep=${brokeAtStep} initialSpeed=${initialSpeed.toFixed(2)}m/s finalSpeed=${finalSpeed.toFixed(2)}m/s ` +
					`displacement=${displacement.toFixed(2)}m`,
			);

			expect(brokeAtStep).toBeGreaterThanOrEqual(0);
			expect(mid.broken).toBe(true);
			expect(displacement).toBeGreaterThan(0.5);
			expect(finalSpeed).toBeLessThan(initialSpeed * 0.8);
		} finally {
			sim.destroy();
		}
	});

	it('large tree at ~80km/h: car stops dead, trunk unmoved, a branch detaches, a damage event fires', async () => {
		const sim = await createTreesSim();
		try {
			const target = LARGE_SITES[0];
			const runway = 12;
			const speedKmh = 80;
			aimAndCrash(sim, { x: target.x, z: target.z }, runway, speedKmh);

			const large = sim.trees.larges[0];
			const trunkSpawn = { x: large.spawnPos.x, y: large.spawnPos.y, z: large.spawnPos.z };

			const steps = 90; // 1.5s @ 60Hz
			for (let i = 0; i < steps; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				checkAllFinite(sim);
			}

			const finalSpeedKmh = forwardSpeed(sim.vehicle.chassis) * 3.6;
			const trunkDrift = distXZ(large.trunk.getPosition(), trunkSpawn);
			const anyBranchBroken = large.branches.some((b) => b.broken);
			const impactEvents = sim.damage.emitter.history.filter((e) => e.type === 'impact');
			console.log(
				`[large] finalSpeedKmh=${finalSpeedKmh.toFixed(1)} trunkDrift=${trunkDrift.toFixed(4)}m ` +
					`anyBranchBroken=${anyBranchBroken} impactEvents=${impactEvents.length}`,
			);

			expect(finalSpeedKmh).toBeLessThan(10);
			expect(trunkDrift).toBeLessThan(0.01);
			expect(anyBranchBroken).toBe(true);
			expect(impactEvents.length).toBeGreaterThanOrEqual(1);
		} finally {
			sim.destroy();
		}
	});

	it("reset('world') restores broken trees", async () => {
		const sim = await createTreesSim();
		try {
			const target = SAPLING_SITES[0];
			aimAndCrash(sim, { x: target.x, z: target.z }, 10, 30);
			const sapling = sim.trees.saplings[0];
			for (let i = 0; i < 200 && !sapling.broken; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
			expect(sapling.broken).toBe(true);

			sim.resetTrees();
			checkAllFinite(sim);

			const s = sim.trees.saplings[0];
			expect(s.broken).toBe(false);
			expect(s.joint).not.toBeNull();
			const p = s.trunk.getPosition();
			expect(Math.hypot(p.x - target.x, p.z - target.z)).toBeLessThan(0.01);
			expect(tiltDeg(s.trunk.getRotation())).toBeLessThan(1);
		} finally {
			sim.destroy();
		}
	});
});
