// SPDX-License-Identifier: MIT
//
// 'trees' world feature: 3 size classes of physics trees the car can crash into (see ./bodies.ts's
// module doc for the full design). Self-contained per the feature contract (./../feature.ts) --
// auto-discovered by ./../registry.ts, zero edits to any shared file.

import type { FeatureContext, WorldFeature } from '../feature';
import {
	createTreesWorld,
	largeBranchDroopCount,
	midLeaningDeg,
	MID_LEAN_REPORT_DEG,
	resetTreesWorld,
	stepTreesWorld,
	treesBodyCount,
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
	const trees: TreesWorld = createTreesWorld(ctx.world);
	const visuals: TreesVisualBundle = buildTreesVisuals(trees);
	ctx.scene.add(visuals.group);

	return {
		name: 'trees',

		afterFixedStep(_dt: number) {
			// stepTreesWorld() must run AFTER world.step() (already true -- main.ts calls
			// features.afterFixedStep() post-step, per the feature contract) since it polls each
			// intact joint's THIS-STEP constraint force/torque (see bodies.ts's pollSaplingBreaks()
			// et al., the same per-step-polling technique game/src/damage/welds.ts uses, chosen over
			// world.jointEvents() since that only reports for awake joints -- feature contract
			// warning notwithstanding, a car impact always wakes the joint it's hitting).
			stepTreesWorld(trees);
			sampleTreesVisuals(trees, visuals);
		},

		applyVisuals(alpha: number) {
			applyTreesVisuals(visuals, alpha);
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
				mids: trees.mids.map((m) => ({ id: m.id, broken: m.broken, leaning: midLeaningDeg(m) > MID_LEAN_REPORT_DEG })),
				larges: trees.larges.map((l) => ({
					id: l.id,
					branchesBroken: l.branches.filter((b) => b.broken).length,
					branchesDrooping: largeBranchDroopCount(l),
					branchesTotal: l.branches.length,
				})),
			}),
		},

		dispose() {
			ctx.scene.remove(visuals.group);
			disposeTreesVisuals(visuals);
		},
	};
}
