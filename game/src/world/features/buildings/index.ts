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
import { buildAllStructures, pollStructureBreaks, resetStructure, totalBrokenJointCount, totalPieceCount } from './structures';
import {
	applyBuildingsVisuals,
	disposeBuildingsVisuals,
	resnapBuildingsVisuals,
	sampleBuildingsVisuals,
	buildBuildingsVisuals,
} from './visuals';

export default function createBuildingsFeature(ctx: FeatureContext): WorldFeature {
	const structures = buildAllStructures(ctx.world);
	const visuals = buildBuildingsVisuals(structures);
	ctx.scene.add(visuals.group);

	return {
		name: 'buildings',

		afterFixedStep() {
			for (const structure of structures) pollStructureBreaks(structure);
			sampleBuildingsVisuals(visuals);
		},

		applyVisuals(alpha: number) {
			applyBuildingsVisuals(visuals, alpha);
		},

		reset(kind) {
			if (kind !== 'world') return; // car repair alone doesn't touch world structures
			for (const structure of structures) resetStructure(ctx.world, structure);
			resnapBuildingsVisuals(visuals);
		},

		bodyCount() {
			return totalPieceCount(structures);
		},

		hooks: {
			structures: structures.map((s) => ({ id: s.id, pieceCount: s.pieces.length, jointCount: s.joints.length })),
			totalPieceCount: () => totalPieceCount(structures),
			totalBrokenJointCount: () => totalBrokenJointCount(structures),
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
