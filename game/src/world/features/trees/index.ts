// SPDX-License-Identifier: MIT
//
// 'trees' world feature: 3 size classes of physics trees the car can crash into (see ./bodies.ts's
// module doc for the full design). Self-contained per the feature contract (./../feature.ts) --
// auto-discovered by ./../registry.ts, zero edits to any shared file.

import type { FeatureContext, WorldFeature } from '../feature';
import { createFractureBudget, createFractureIdAllocator, FRACTURE_FRAGMENT_ENTITY_ID_BASE, resetFractureBudget } from '../fracture';
import {
	createTreesWorld,
	largeBranchDroopCount,
	midLeaningDeg,
	MID_LEAN_REPORT_DEG,
	resetTreesWorld,
	stepTreesWorld,
	treesBodyCount,
	type TreesFractureContext,
	type TreesWorld,
} from './bodies';
import {
	applyTreesVisuals,
	buildTreesVisuals,
	disposeTreesVisuals,
	resnapTreesVisuals,
	sampleTreesVisuals,
	type TreesVisualBundle,
} from './visuals';

export default function createTreesFeature(ctx: FeatureContext): WorldFeature {
	// massRegistry: the damage system's foreign-mass Map (fracture spec §E) -- trees register their
	// members' real masses so a 9kg sapling no longer deals wall-strength car damage.
	const trees: TreesWorld = createTreesWorld(ctx.world, ctx.foreignMasses);
	const visuals: TreesVisualBundle = buildTreesVisuals(trees);
	ctx.scene.add(visuals.group);

	// FRACTURE (docs/loom/d1-fracture-material-spec.md): mid trunks SNAP into stump+flyer past the
	// fell threshold. Trees' fragment ids take the LOW half of the fracture-fragment range
	// (45,000,000+); buildings' take 45,500,000+ -- see fracture.ts's range doc.
	const fractureCtx: TreesFractureContext = {
		world: ctx.world,
		budget: createFractureBudget(1), // <=1 fracture event per fixed step (spec §D)
		idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE),
	};

	return {
		name: 'trees',

		afterFixedStep(_dt: number) {
			// stepTreesWorld() must run AFTER world.step() (already true -- main.ts calls
			// features.afterFixedStep() post-step, per the feature contract) since it polls each
			// intact joint's THIS-STEP constraint force/torque (see bodies.ts's pollSaplingBreaks()
			// et al., the same per-step-polling technique game/src/damage/welds.ts uses, chosen over
			// world.jointEvents() since that only reports for awake joints -- feature contract
			// warning notwithstanding, a car impact always wakes the joint it's hitting).
			resetFractureBudget(fractureCtx.budget);
			stepTreesWorld(trees, fractureCtx);
			sampleTreesVisuals(trees, visuals);
		},

		applyVisuals(alpha: number) {
			// Pass the car position as the distance-LOD focus (getVehicle() is re-fetched every frame —
			// never cache it, per the feature contract; the vehicle is replaced on repair).
			applyTreesVisuals(visuals, alpha, ctx.getVehicle().chassis.getPosition());
		},

		reset(kind: 'car' | 'world') {
			if (kind !== 'world') return; // trees don't care about car repair
			resetTreesWorld(ctx.world, trees);
			resnapTreesVisuals(trees, visuals);
		},

		bodyCount() {
			return treesBodyCount(trees);
		},

		hooks: {
			/** Read-only playtest snapshot -- window.__GAME__.features.trees.snapshot(). */
			snapshot: () => ({
				saplings: trees.saplings.map((s) => ({ id: s.id, broken: s.broken })),
				mids: trees.mids.map((m) => ({ id: m.id, broken: m.broken, fractured: m.fractured, leaning: midLeaningDeg(m) > MID_LEAN_REPORT_DEG })),
				larges: trees.larges.map((l) => ({
					id: l.id,
					branchesBroken: l.branches.filter((b) => b.broken).length,
					branchesDrooping: largeBranchDroopCount(l),
					branchesTotal: l.branches.length,
				})),
			}),
			/** Fracture introspection for verify scripts: how many mid trunks are currently SNAPPED. */
			fracturedMidCount: () => trees.mids.filter((m) => m.fractured).length,
		},

		dispose() {
			ctx.scene.remove(visuals.group);
			disposeTreesVisuals(visuals);
		},
	};
}
