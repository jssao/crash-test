// SPDX-License-Identifier: MIT
//
// Extended playtest-battery coverage for the 'trees' world feature: asserts the SAPLING BEND phase
// (visible tilt while the root joint is still intact, before it snaps) that the RUN 1/gate-pass ledger
// flagged as unasserted -- existing coverage (game/sim/features-trees.test.mjs) only checks the
// eventual BREAK, never the bend leading up to it.
//
// Pushes sapling.trunk directly with Body.applyForce() at a point near the top of the trunk (a
// steady, gentle horizontal force -- NOT a car impact) so the joint bends well under its break
// threshold (SAPLING_FORCE_THRESHOLD_N/SAPLING_TORQUE_THRESHOLD_NM, see tuning.ts), asserts >8deg tilt
// while joint intact, then releases the force and asserts the spring (SAPLING_SPRING_HERTZ/
// SAPLING_SPRING_DAMPING_RATIO) pulls it back toward upright without ever breaking.
//
// Uses a bare World (no vehicle/ground needed -- the sapling's anchor is already a static body), same
// minimal-harness pattern as game/sim/harness.mjs's Sim but without the vehicle, since this test never
// drives a car into anything.

import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createTreesWorld, stepTreesWorld } from '../src/world/features/trees/bodies.ts';
import { SAPLING_TRUNK_HEIGHT_M } from '../src/world/features/trees/tuning.ts';
import { dot, LOCAL_UP, rotateVector } from '../src/vehicle/mathUtil.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';

let cachedNative = null;
async function loadNative() {
	if (cachedNative === null) cachedNative = init();
	return cachedNative;
}

function tiltDeg(rotation) {
	const up = rotateVector(rotation, LOCAL_UP);
	const c = Math.max(-1, Math.min(1, dot(up, { x: 0, y: 1, z: 0 })));
	return (Math.acos(c) * 180) / Math.PI;
}

describe('feature: trees -- sapling bend phase', () => {
	it('slow push below snap threshold: measurable tilt (>8deg) while joint intact, then spring-back on release', async () => {
		const native = await loadNative();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		const trees = createTreesWorld(world);
		try {
			const sapling = trees.saplings[0];
			sapling.trunk.setAwake(true);

			// Push point: near the top of the trunk capsule (world-space, matches
			// Body.applyForce(force, point)'s convention), horizontal force -- bends the trunk about
			// its root joint rather than just translating it.
			const pushForceN = 42; // well under what it'd take to hit the 6000N/2500Nm break thresholds
			const pushSteps = 150;
			const releaseSteps = 150;

			let brokeAtStep = -1;
			const tilts = [];
			for (let i = 0; i < pushSteps; i++) {
				const p = sapling.trunk.getPosition();
				sapling.trunk.applyForce({ x: pushForceN, y: 0, z: 0 }, { x: p.x, y: p.y + SAPLING_TRUNK_HEIGHT_M - 0.15, z: p.z }, true);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				stepTreesWorld(trees);
				if (brokeAtStep < 0 && sapling.broken) brokeAtStep = i;
				tilts.push(tiltDeg(sapling.trunk.getRotation()));
			}

			const peakTilt = Math.max(...tilts);
			console.log(`[sapling-bend] peakTiltDuringPush=${peakTilt.toFixed(1)}deg brokeAtStep=${brokeAtStep}`);

			expect(brokeAtStep).toBe(-1); // must NOT have broken -- this is the bend phase, not the break
			expect(sapling.broken).toBe(false);
			expect(peakTilt).toBeGreaterThan(8);

			// Release: stop pushing, let the spring (SAPLING_SPRING_HERTZ/DAMPING_RATIO) pull it back.
			const releaseTilts = [];
			for (let i = 0; i < releaseSteps; i++) {
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				stepTreesWorld(trees);
				releaseTilts.push(tiltDeg(sapling.trunk.getRotation()));
			}
			const finalTilt = releaseTilts[releaseTilts.length - 1];
			const minTiltAfterRelease = Math.min(...releaseTilts);
			console.log(`[sapling-bend] finalTiltAfterRelease=${finalTilt.toFixed(1)}deg minTiltAfterRelease=${minTiltAfterRelease.toFixed(1)}deg broken=${sapling.broken}`);

			expect(sapling.broken).toBe(false); // never broke, through push AND release
			// Spring-back: tilt measurably recovers toward upright (well below the push's peak).
			expect(minTiltAfterRelease).toBeLessThan(peakTilt * 0.5);
		} finally {
			world.destroy?.();
		}
	});
});
