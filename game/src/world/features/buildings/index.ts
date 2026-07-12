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
//
// FRACTURE (docs/loom/d1-fracture-material-spec.md): rails/studs/planks/drywall SNAP into fragments
// in bending before their welds pop -- the fracture check rides the same poll (structures.ts's
// StructureFractureContext). This index owns the runtime plumbing: the per-step budget reset, the
// fragment store + age/distance despawn (panel-despawn constants reused verbatim via fracture.ts),
// the foreign-mass registry bookkeeping (spec §E), fragment visuals, and full reset.

import type { FeatureContext, WorldFeature } from '../feature';
import {
	createFractureBudget,
	createFractureIdAllocator,
	FRACTURE_FRAGMENT_ENTITY_ID_BASE,
	pollFragmentDespawn,
	resetFractureBudget,
} from '../fracture';
import {
	buildAllStructures,
	pollStructureBreaks,
	resetStructure,
	totalBrokenJointCount,
	totalFracturedPieceCount,
	totalPieceCount,
	totalYieldedJointCount,
	type StructureFractureContext,
} from './structures';
import { buildSupportGraph, collapsingBodyCount, pollStructureCollapse, resetSupportGraph } from './support';
import {
	applyBuildingsVisuals,
	disposeBuildingsVisuals,
	resnapBuildingsVisuals,
	sampleBuildingsVisuals,
	spawnFragmentVisuals,
	buildBuildingsVisuals,
} from './visuals';

/** Simultaneously-live fragment cap for this feature (spec §D's global 40-60 band, split with the
 * trees feature's much smaller worst case) -- at the cap, members fall back to weld-pop. */
const BUILDINGS_LIVE_FRAGMENT_CAP = 40;

export default function createBuildingsFeature(ctx: FeatureContext): WorldFeature {
	const structures = buildAllStructures(ctx.world);
	// STRUCTURAL COLLAPSE: one support graph per structure (bodies=nodes, welds=edges, footing=anchor).
	// Parallel array -- graphs[i] belongs to structures[i]. See ./support.ts. `let`: rebuilt on reset
	// because resetStructure() gives FRACTURED pieces brand-new bodies (stale handles otherwise).
	let graphs = structures.map((s) => buildSupportGraph(s));
	const visuals = buildBuildingsVisuals(structures);
	ctx.scene.add(visuals.group);

	// §E: register every dynamic piece's real mass so light debris deals mass-attenuated car damage.
	// Bodies were tagged with their entityId at spawn (structures.ts's addBoxPiece/addCapsulePiece).
	function registerPieceMasses(): void {
		for (const s of structures) for (const p of s.pieces) if (!p.isStatic) ctx.foreignMasses.set(p.entityId, p.massKg);
	}
	registerPieceMasses();

	// Fracture runtime state. Buildings' fragment ids take the HIGH half of the fracture range
	// (45,500,000+; trees own 45,000,000+ -- see fracture.ts's range doc).
	const fractureCtx: StructureFractureContext = {
		world: ctx.world,
		budget: createFractureBudget(1), // <=1 fracture event per fixed step (spec §D)
		idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE + 500_000),
		timeSec: 0,
		fragments: [],
		events: [],
		liveFragmentCap: BUILDINGS_LIVE_FRAGMENT_CAP,
		massRegistry: ctx.foreignMasses,
	};

	function destroyAllFragments(): void {
		for (const f of fractureCtx.fragments) {
			if (f.despawned) continue;
			f.shape.destroy(false);
			f.body.destroy();
			f.despawned = true;
			ctx.foreignMasses.delete(f.entityId);
		}
		fractureCtx.fragments.length = 0;
		fractureCtx.events.length = 0;
	}

	return {
		name: 'buildings',

		afterFixedStep(dt: number) {
			fractureCtx.timeSec += dt;
			resetFractureBudget(fractureCtx.budget);
			fractureCtx.events.length = 0;
			// Event-driven collapse: only recompute a structure's support graph on a step that actually
			// broke one of its welds (pollStructureBreaks returns the count -- a fracture severs welds
			// too, so a snap correctly triggers the same recompute). An untouched structure never breaks a
			// weld, so its graph never recomputes and nothing wakes -- zero idle cost.
			for (let i = 0; i < structures.length; i++) {
				const broke = pollStructureBreaks(structures[i], fractureCtx);
				if (broke > 0) pollStructureCollapse(structures[i], graphs[i]);
			}
			if (fractureCtx.events.length > 0) spawnFragmentVisuals(visuals, fractureCtx.events);
			// Despawn: age + distance-from-car, the panel-despawn rule verbatim (spec §D). getVehicle()
			// re-read every step (feature contract warning #2 -- the vehicle is replaced on car repair).
			const despawned = pollFragmentDespawn(fractureCtx.fragments, ctx.getVehicle().chassis.getPosition(), fractureCtx.timeSec);
			for (const id of despawned) ctx.foreignMasses.delete(id);
			sampleBuildingsVisuals(visuals);
		},

		applyVisuals(alpha: number) {
			applyBuildingsVisuals(visuals, alpha);
		},

		reset(kind) {
			if (kind !== 'world') return; // car repair alone doesn't touch world structures
			destroyAllFragments();
			for (const s of structures) resetStructure(ctx.world, s);
			// Rebuild (not just re-baseline) the support graphs: resetStructure() gives fractured pieces
			// brand-new bodies, so the old graphs' handle->index maps would be stale.
			graphs = structures.map((s) => buildSupportGraph(s));
			for (let i = 0; i < structures.length; i++) resetSupportGraph(structures[i], graphs[i]);
			registerPieceMasses(); // re-register rebuilt pieces (idempotent for the untouched ones)
			resnapBuildingsVisuals(visuals);
		},

		bodyCount() {
			// Honest live count: spawn-time pieces minus destroyed (fractured) parents plus live fragments.
			// (The CI band [200,260] asserts the totalPieceCount() HOOK below, which stays the spawn-time
			// piece count by design -- spec §D.)
			let live = 0;
			for (const f of fractureCtx.fragments) if (!f.despawned) live++;
			return totalPieceCount(structures) - totalFracturedPieceCount(structures) + live;
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
					.filter((p) => !p.isStatic && !p.fractured)
					.map((p) => {
						const pos = p.body.getPosition();
						return Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z);
					});
			},
			// ---- FRACTURE introspection (verify scripts / eyes-on battery) ----
			totalFracturedPieceCount: () => totalFracturedPieceCount(structures),
			fracturedPieceCountFor: (id: string): number => {
				const s = structures.find((x) => x.id === id);
				return s ? s.pieces.filter((p) => p.fractured).length : -1;
			},
			liveFragmentCount: () => fractureCtx.fragments.filter((f) => !f.despawned).length,
		},

		dispose() {
			disposeBuildingsVisuals(visuals);
		},
	};
}
