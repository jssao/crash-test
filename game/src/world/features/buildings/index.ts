// SPDX-License-Identifier: MIT
//
// 'buildings' WorldFeature: destructible structures the car crashes THROUGH with material-
// differentiated breakup (wood studs/planks, drywall panels, brick lattice, free capsule pipes) plus
// low-threshold fence lines. See ./structures.ts for the physics assembly and ./tuning.ts for the
// material presets + layout (zone: x > +30).
//
// Weld breaking: POLLED constraint force/torque (same pattern as damage/welds.ts's panel-weld model,
// not world.jointEvents()) -- checked every fixed step, after world.step(), so it naturally covers the
// "sleeping joints report nothing" gotcha (feature.ts's warning): a structure sleeps until the car's
// contact wakes its island, and the very next poll then sees the real (non-stale) constraint force.

import type { FeatureContext, WorldFeature } from '../feature';
import { buildAllStructures, pollStructureBreaks, resetStructure, totalBrokenJointCount, totalPieceCount, totalYieldedJointCount } from './structures';
import { buildSupportGraph, collapsingBodyCount, pollStructureCollapse, resetSupportGraph } from './support';
import {
	applyBuildingsVisuals,
	disposeBuildingsVisuals,
	resnapBuildingsVisuals,
	sampleBuildingsVisuals,
	buildBuildingsVisuals,
} from './visuals';

export default function createBuildingsFeature(ctx: FeatureContext): WorldFeature {
	const structures = buildAllStructures(ctx.world);
	// STRUCTURAL COLLAPSE: one support graph per structure (bodies=nodes, welds=edges, footing=anchor).
	// Parallel array -- graphs[i] belongs to structures[i]. See ./support.ts.
	const graphs = structures.map((s) => buildSupportGraph(s));
	const visuals = buildBuildingsVisuals(structures);
	ctx.scene.add(visuals.group);

	return {
		name: 'buildings',

		afterFixedStep() {
			// Event-driven collapse: only recompute a structure's support graph on a step that actually
			// broke one of its welds (pollStructureBreaks returns the count). An untouched structure never
			// breaks a weld, so its graph never recomputes and nothing wakes -- zero idle cost.
			for (let i = 0; i < structures.length; i++) {
				const broke = pollStructureBreaks(structures[i]);
				if (broke > 0) pollStructureCollapse(structures[i], graphs[i]);
			}
			sampleBuildingsVisuals(visuals);
		},

		applyVisuals(alpha: number) {
			applyBuildingsVisuals(visuals, alpha);
		},

		reset(kind) {
			if (kind !== 'world') return; // car repair alone doesn't touch world structures
			for (let i = 0; i < structures.length; i++) {
				resetStructure(ctx.world, structures[i]);
				resetSupportGraph(structures[i], graphs[i]); // rebaseline: everything anchored + asleep again
			}
			resnapBuildingsVisuals(visuals);
		},

		bodyCount() {
			return totalPieceCount(structures);
		},

		hooks: {
			structures: structures.map((s) => ({ id: s.id, pieceCount: s.pieces.length, jointCount: s.joints.length })),
			totalPieceCount: () => totalPieceCount(structures),
			totalBrokenJointCount: () => totalBrokenJointCount(structures),
			/** Joints currently plastically bent (yielded but not broken) -- the "bulge/slump/lean"
			 * signal the destruction-feel work introduced. */
			totalYieldedJointCount: () => totalYieldedJointCount(structures),
			/** Bodies currently flagged as part of a collapsed (support-orphaned) chunk -- the structural-
			 * collapse signal. 0 until a weld break orphans a component. */
			totalCollapsingBodyCount: () => graphs.reduce((n, g) => n + collapsingBodyCount(g), 0),
			collapsingBodyCountFor: (id: string): number => {
				const i = structures.findIndex((x) => x.id === id);
				return i >= 0 ? collapsingBodyCount(graphs[i]) : -1;
			},
			yieldedJointCountFor: (id: string): number => {
				const s = structures.find((x) => x.id === id);
				return s ? s.joints.filter((j) => !j.broken && j.stage === 'yielded').length : -1;
			},
			brokenJointCountFor: (id: string): number => {
				const s = structures.find((x) => x.id === id);
				return s ? s.joints.filter((j) => j.broken).length : -1;
			},
			pieceDisplacements: (id: string): number[] => {
				const s = structures.find((x) => x.id === id);
				if (!s) return [];
				return s.pieces
					.filter((p) => !p.isStatic)
					.map((p) => {
						const pos = p.body.getPosition();
						return Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z);
					});
			},
		},

		dispose() {
			disposeBuildingsVisuals(visuals);
		},
	};
}
