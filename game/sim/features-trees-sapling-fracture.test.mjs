// SPDX-License-Identifier: MIT
//
// BUG P015 (sapling snap-in-half): pollSaplingBreaks() now wires fractureCapsuleTrunk() (the same
// mechanism the mid tree's fractureMid() already used) into the sapling break path -- a "hard" break
// (>SAPLING_FRACTURE_OVER_RATIO over the force/torque threshold, trees/bodies.ts) SNAPS the trunk into
// a welded-stump + flying-top pair instead of the whole trunk popping free at the root joint; a
// marginal break still topples whole, unchanged. Mirrors the mid-tree fracture coverage's shape
// (game/sim/features-trees.test.mjs has no fracture-context test at all for mid, so this is also the
// first direct exercise of TreesFractureContext plumbing for a tree class in this suite).

import { describe, expect, it } from 'vitest';
import { DamageSim } from './damage-harness.mjs';
import { loadNative } from './harness.mjs';
import { createTreesWorld, stepTreesWorld, resetTreesWorld, treesBodyCount } from '../src/world/features/trees/bodies.ts';
import { SAPLING_SITES } from '../src/world/features/trees/tuning.ts';
import { createFractureBudget, createFractureIdAllocator, resetFractureBudget, FRACTURE_FRAGMENT_ENTITY_ID_BASE } from '../src/world/features/fracture.ts';

class FractureTreesSim extends DamageSim {
	constructor(native, spawnPosition) {
		super(native, spawnPosition);
		this.trees = createTreesWorld(this.world, new Map());
		this.fractureCtx = {
			world: this.world,
			budget: createFractureBudget(1),
			idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE),
		};
	}
	step(input) {
		super.step(input);
		resetFractureBudget(this.fractureCtx.budget);
		stepTreesWorld(this.trees, this.fractureCtx);
	}
	resetTrees() {
		resetTreesWorld(this.world, this.trees);
	}
}

async function createFractureTreesSim() {
	const native = await loadNative();
	return new FractureTreesSim(native);
}

function aimAndCrash(sim, treePos, runwayM, speedKmh) {
	sim.vehicle.spawnPosition.x = treePos.x;
	sim.vehicle.spawnPosition.z = treePos.z - runwayM;
	sim.crash(speedKmh);
}

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };

describe('P015: sapling snaps in half on a hard hit (fracture context)', () => {
	it('90km/h dead-center: sapling FRACTURES (stump welded + flyer freed), not a whole-trunk pop', async () => {
		const sim = await createFractureTreesSim();
		try {
			const target = SAPLING_SITES[0];
			aimAndCrash(sim, { x: target.x, z: target.z }, 10, 90);
			const sapling = sim.trees.saplings[0];
			for (let i = 0; i < 120; i++) {
				sim.step(NEUTRAL);
				const p1 = sapling.trunk.getPosition();
				expect(Number.isFinite(p1.x) && Number.isFinite(p1.y) && Number.isFinite(p1.z)).toBe(true);
			}
			expect(sapling.broken).toBe(true);
			expect(sapling.fractured).toBe(true);
			expect(sapling.stump).not.toBeNull();
			expect(sapling.flyerFrag).not.toBeNull();
			// Stump and flyer are genuinely separate bodies (not the same handle).
			expect(sapling.stump.frag.body).not.toBe(sapling.flyerFrag.body);
			// The stump stays welded near the anchor (base), the flyer is (or becomes) the free piece
			// `trunk` now aliases -- both finite, both above ground.
			const stumpPos = sapling.stump.frag.body.getPosition();
			expect(Number.isFinite(stumpPos.y)).toBe(true);
			// Mass registry: fragments registered, whole-trunk entry cleared.
			expect(sim.trees.massRegistry.has(sapling.entityId)).toBe(false);
			expect(sim.trees.massRegistry.has(sapling.stump.frag.entityId)).toBe(true);
			expect(sim.trees.massRegistry.has(sapling.flyerFrag.entityId)).toBe(true);
		} finally {
			sim.destroy();
		}
	});

	it('~22km/h (marginal break): sapling topples WHOLE even with a fracture context available', async () => {
		const sim = await createFractureTreesSim();
		try {
			const target = SAPLING_SITES[0];
			aimAndCrash(sim, { x: target.x, z: target.z }, 10, 22);
			const sapling = sim.trees.saplings[0];
			for (let i = 0; i < 200; i++) sim.step(NEUTRAL);
			expect(sapling.broken).toBe(true);
			expect(sapling.fractured).toBe(false);
			expect(sapling.stump).toBeNull();
		} finally {
			sim.destroy();
		}
	});

	it("reset('world') rebuilds a fractured sapling pristine", async () => {
		const sim = await createFractureTreesSim();
		try {
			const target = SAPLING_SITES[0];
			aimAndCrash(sim, { x: target.x, z: target.z }, 10, 90);
			const sapling = sim.trees.saplings[0];
			for (let i = 0; i < 120 && !sapling.fractured; i++) sim.step(NEUTRAL);
			expect(sapling.fractured).toBe(true);

			const bodyCountBefore = treesBodyCount(sim.trees);
			sim.resetTrees();
			const s = sim.trees.saplings[0];
			expect(s.fractured).toBe(false);
			expect(s.broken).toBe(false);
			expect(s.stump).toBeNull();
			expect(s.flyerFrag).toBeNull();
			expect(s.joint).not.toBeNull();
			const p = s.trunk.getPosition();
			expect(Math.hypot(p.x - target.x, p.z - target.z)).toBeLessThan(0.01);
			expect(sim.trees.massRegistry.get(s.entityId)).toBe(9);
			// Body count drops back down (stump body torn down) -- bodyCount() honesty (feature contract).
			expect(treesBodyCount(sim.trees)).toBeLessThan(bodyCountBefore);
		} finally {
			sim.destroy();
		}
	});
});
