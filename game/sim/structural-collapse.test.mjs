// SPDX-License-Identifier: MIT
//
// Headless sim test for STRUCTURAL COLLAPSE (game/src/world/features/buildings/support.ts). Imports the
// renderer-free structures + support modules DIRECTLY (skips the WorldFeature registry, per
// features/registry.ts's doc comment). The support graph turns box3d's weld lattice into a data-driven
// dependency graph: bodies=nodes, welds=edges, the static footing=anchor. When a weld breaks, any
// component that no longer has a path to an anchor is "unsupported" and must fall.
//
// WHY THIS IS NEEDED (the phantom-rigidity bug this feature fixes): box3d's Joint.destroy() force-wakes
// the TWO bodies it was attached to and island-propagates across still-live welds, so a chunk cut free
// by a hard car hit usually does fall on its own. But once a chunk is ASLEEP and unsupported -- e.g. it
// was briefly supported, settled, box3d slept it, and only THEN did its last anchor weld break, or the
// reset path re-slept the whole structure -- box3d never wakes it again: gravity does not act on a
// sleeping body, so an unsupported roof HANGS IN THE AIR until something touches it. The
// `PHANTOM (control)` case below reproduces exactly that (drop==0). The support graph is what detects
// the orphaned component and wakes it.
import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import {
	buildAllStructures,
	buildBrickWall,
	buildShed,
	pollStructureBreaks,
	resetStructure,
} from '../src/world/features/buildings/structures.ts';
import {
	buildSupportGraph,
	collapsingBodyCount,
	pollStructureCollapse,
	resetSupportGraph,
} from '../src/world/features/buildings/support.ts';
import {
	BRICK_HALF_EXTENTS,
	BRICK_WALL_COLUMNS,
	SHED_CENTER,
	SHED_DEPTH_M,
} from '../src/world/features/buildings/tuning.ts';

let cachedNative = null;
async function loadNative() {
	if (cachedNative === null) cachedNative = init();
	return cachedNative;
}

async function makeWorld() {
	const native = await loadNative();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, 250);
	return world;
}

/** Break (destroy + mark) every weld that anchors one of `pieceHandles` DIRECTLY to a static footing --
 * i.e. "knock the studs/bricks out at the base". Mirrors what a low car hit does to those welds, but
 * deterministically and in isolation. Returns the number broken. */
function severBaseWelds(structure, pieceHandles) {
	const footingHandles = new Set(structure.pieces.filter((p) => p.isStatic).map((p) => p.body.handle));
	let n = 0;
	for (const j of structure.joints) {
		if (j.broken || !j.joint) continue;
		const aFoot = footingHandles.has(j.spec.bodyA.handle);
		const bFoot = footingHandles.has(j.spec.bodyB.handle);
		const aTarget = pieceHandles.has(j.spec.bodyA.handle);
		const bTarget = pieceHandles.has(j.spec.bodyB.handle);
		if ((aFoot && bTarget) || (bFoot && aTarget)) {
			j.joint.destroy();
			j.joint = null;
			j.broken = true;
			n++;
		}
	}
	return n;
}

function meanY(pieces) {
	return pieces.reduce((s, p) => s + p.body.getPosition().y, 0) / pieces.length;
}

describe('structural-collapse', () => {
	// (a) --------------------------------------------------------------------------------------------
	it('(a) shed: knock out a wall\'s studs -> roof + top structure falls within 3s (measured Y drop)', async () => {
		const world = await makeWorld();
		try {
			const shed = buildShed(world);
			const graph = buildSupportGraph(shed);
			for (let i = 0; i < 30; i++) world.step(FIXED_DT, FIXED_SUBSTEPS); // settle
			resetSupportGraph(shed, graph); // rebaseline after settle (nothing broke -- all still supported)

			const zFront = SHED_CENTER.z - SHED_DEPTH_M / 2;
			const frontRoof = shed.pieces.filter((p) => p.kind === 'roof' && p.spawnPos.z < SHED_CENTER.z);
			const frontStudHandles = new Set(
				shed.pieces.filter((p) => p.kind === 'stud' && Math.abs(p.spawnPos.z - zFront) < 0.05).map((p) => p.body.handle),
			);
			const roofY0 = meanY(frontRoof);

			// Knock out the front wall's studs at the base, then FORCE the structure asleep -- reproduces the
			// phantom-rigidity state (an unsupported chunk box3d will never wake on its own).
			const severed = severBaseWelds(shed, frontStudHandles);
			for (const p of shed.pieces) if (!p.isStatic) p.body.setAwake(false);
			expect(severed).toBe(frontStudHandles.size);

			// The collapse pass must detect the orphaned front assembly (studs + planks + front roof slope)
			// and wake it. Report which bodies it flagged as newly unsupported.
			const result = pollStructureCollapse(shed, graph);
			const flagged = new Set(result.newlyUnsupported);
			const roofFlagged = frontRoof.filter((p) => flagged.has(p.body.handle)).length;
			console.log(
				`[a/shed] severed=${severed} newlyUnsupportedBodies=${result.newlyUnsupported.length} roofPanelsFlagged=${roofFlagged}/${frontRoof.length} softenedWelds=${result.softenedJoints}`,
			);
			expect(roofFlagged).toBe(frontRoof.length); // every front roof panel is now unsupported

			// PHANTOM (control): had we NOT run collapse, the asleep chunk would hang forever. Verify the
			// premise by measuring a fresh identical shed with collapse SKIPPED.
			{
				const w2 = await makeWorld();
				const shed2 = buildShed(w2);
				buildSupportGraph(shed2);
				for (let i = 0; i < 30; i++) w2.step(FIXED_DT, FIXED_SUBSTEPS);
				const fr2 = shed2.pieces.filter((p) => p.kind === 'roof' && p.spawnPos.z < SHED_CENTER.z);
				const fs2 = new Set(shed2.pieces.filter((p) => p.kind === 'stud' && Math.abs(p.spawnPos.z - zFront) < 0.05).map((p) => p.body.handle));
				severBaseWelds(shed2, fs2);
				for (const p of shed2.pieces) if (!p.isStatic) p.body.setAwake(false);
				const y0 = meanY(fr2);
				for (let i = 0; i < 180; i++) w2.step(FIXED_DT, FIXED_SUBSTEPS); // no collapse
				const controlDrop = y0 - meanY(fr2);
				console.log(`[a/shed] PHANTOM control (no collapse) roofDrop=${controlDrop.toFixed(3)}m`);
				expect(controlDrop).toBeLessThan(0.05); // hangs in the air -- proves collapse is load-bearing
				w2.destroy();
			}

			// WITH collapse: step 3s, the woken chunk falls under gravity (no fake impulses).
			for (let i = 0; i < 180; i++) {
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				const broke = pollStructureBreaks(shed);
				if (broke > 0) pollStructureCollapse(shed, graph);
			}
			const roofDrop = roofY0 - meanY(frontRoof);
			console.log(`[a/shed] WITH collapse roofDrop=${roofDrop.toFixed(3)}m in 3s`);
			expect(roofDrop).toBeGreaterThan(0.8); // roof + top structure actually fell

			world.destroy();
		} catch (e) {
			world.destroy();
			throw e;
		}
	});

	// (b) --------------------------------------------------------------------------------------------
	it('(b) brick wall: breach a bottom section -> bricks above the breach come down (count displaced)', async () => {
		const world = await makeWorld();
		try {
			const wall = buildBrickWall(world);
			const graph = buildSupportGraph(wall);
			for (let i = 0; i < 30; i++) world.step(FIXED_DT, FIXED_SUBSTEPS);
			resetSupportGraph(wall, graph);

			const half = BRICK_HALF_EXTENTS;
			// Breach: the car punches out the bottom 8 courses of the wall. We model a knocked-out brick as
			// "welds severed + brick swept out of the wall" (teleported far below): a real breach removes
			// the bricks, it does not leave them dry-stacked in place (leaving them stacked would let the
			// upper wall simply rest on them via contact -- no collapse). The upper half (rows 8..15) is then
			// orphaned: no weld path to the footing AND nothing beneath it. THAT is what must come down.
			const BREACH_ROWS = 8;
			const breachY = half.y * (2 * BREACH_ROWS); // top face of the last breached course
			const knockedOut = (p) => p.kind === 'brick' && p.spawnPos.y < breachY;
			const above = wall.pieces.filter((p) => p.kind === 'brick' && p.spawnPos.y >= breachY);
			const aboveHandles = new Set(above.map((p) => p.body.handle));
			const knockedHandles = new Set(wall.pieces.filter(knockedOut).map((p) => p.body.handle));
			let severed = 0;
			for (const j of wall.joints) {
				if (j.broken || !j.joint) continue;
				if (knockedHandles.has(j.spec.bodyA.handle) || knockedHandles.has(j.spec.bodyB.handle)) {
					j.joint.destroy();
					j.joint = null;
					j.broken = true;
					severed++;
				}
			}
			// Sweep the knocked-out bricks out of the wall (down and away), so there is a genuine gap.
			for (const p of wall.pieces) {
				if (knockedOut(p)) {
					p.body.setTransform({ x: p.spawnPos.x, y: -50, z: p.spawnPos.z + 5 }, p.spawnRot);
					p.body.setAwake(false);
				}
			}
			for (const p of wall.pieces) if (!p.isStatic && !knockedOut(p)) p.body.setAwake(false); // phantom state
			const yAbove0 = meanY(above);

			const result = pollStructureCollapse(wall, graph);
			const flagged = new Set(result.newlyUnsupported);
			const aboveFlagged = [...aboveHandles].filter((h) => flagged.has(h)).length;
			console.log(
				`[b/brick] severed=${severed} bricksAbove=${above.length} flaggedUnsupported=${aboveFlagged} softenedWelds=${result.softenedJoints}`,
			);
			// Every above-breach brick is orphaned (a full-width breach cuts the running-bond lattice
			// cleanly -- there is no lateral weld path down to the footing left).
			expect(aboveFlagged).toBe(above.length);

			// PHANTOM (control): identical breach on a fresh wall, collapse SKIPPED -> the orphaned top slab
			// hangs asleep in the air (drop ~0).
			{
				const w2 = await makeWorld();
				const wall2 = buildBrickWall(w2);
				buildSupportGraph(wall2);
				for (let i = 0; i < 30; i++) w2.step(FIXED_DT, FIXED_SUBSTEPS);
				const above2 = wall2.pieces.filter((p) => p.kind === 'brick' && p.spawnPos.y >= breachY);
				const knocked2 = new Set(wall2.pieces.filter(knockedOut).map((p) => p.body.handle));
				for (const j of wall2.joints) {
					if (j.broken || !j.joint) continue;
					if (knocked2.has(j.spec.bodyA.handle) || knocked2.has(j.spec.bodyB.handle)) { j.joint.destroy(); j.joint = null; j.broken = true; }
				}
				for (const p of wall2.pieces) {
					if (knockedOut(p)) { p.body.setTransform({ x: p.spawnPos.x, y: -50, z: p.spawnPos.z + 5 }, p.spawnRot); p.body.setAwake(false); }
					else if (!p.isStatic) p.body.setAwake(false);
				}
				const y0 = meanY(above2);
				for (let i = 0; i < 180; i++) w2.step(FIXED_DT, FIXED_SUBSTEPS); // no collapse
				const controlDrop = y0 - meanY(above2);
				console.log(`[b/brick] PHANTOM control (no collapse) meanDrop=${controlDrop.toFixed(3)}m`);
				expect(controlDrop).toBeLessThan(0.05);
				w2.destroy();
			}

			for (let i = 0; i < 180; i++) {
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				const broke = pollStructureBreaks(wall);
				if (broke > 0) pollStructureCollapse(wall, graph);
			}
			const displaced = above.filter((p) => {
				const pos = p.body.getPosition();
				return Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z) > 0.3;
			}).length;
			const drop = yAbove0 - meanY(above);
			console.log(`[b/brick] WITH collapse displacedAbove(>0.3m)=${displaced}/${above.length} meanDrop=${drop.toFixed(3)}m`);
			expect(drop).toBeGreaterThan(0.3); // the orphaned top slab came down
			expect(displaced).toBeGreaterThanOrEqual(Math.floor(above.length * 0.5));

			world.destroy();
		} catch (e) {
			world.destroy();
			throw e;
		}
	});

	// (c) --------------------------------------------------------------------------------------------
	it('(c) untouched structures stay asleep: 0 awake, collapse flags nothing over a long idle', async () => {
		const world = await makeWorld();
		try {
			const structures = buildAllStructures(world);
			const graphs = structures.map((s) => buildSupportGraph(s));
			let everFlagged = 0;
			let maxAwake = 0;
			// Idle 8s. Nothing touches the structures; poll+collapse run every step exactly as the game wires
			// them. Not one body may wake and not one component may be flagged as collapsing.
			for (let i = 0; i < 480; i++) {
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				for (let s = 0; s < structures.length; s++) {
					const broke = pollStructureBreaks(structures[s]);
					if (broke > 0) {
						const r = pollStructureCollapse(structures[s], graphs[s]);
						everFlagged += r.newlyUnsupported.length;
					}
				}
			}
			for (const s of structures) {
				const awake = s.pieces.filter((p) => !p.isStatic && p.body.isAwake()).length;
				maxAwake = Math.max(maxAwake, awake);
			}
			const collapsing = structures.reduce((n, s, i) => n + collapsingBodyCount(graphs[i]), 0);
			console.log(`[c/idle] everFlagged=${everFlagged} maxAwakeInAnyStructure=${maxAwake} collapsingBodies=${collapsing}`);
			expect(everFlagged).toBe(0);
			expect(maxAwake).toBe(0);
			expect(collapsing).toBe(0);

			world.destroy();
		} catch (e) {
			world.destroy();
			throw e;
		}
	});

	// (d) --------------------------------------------------------------------------------------------
	it('(d) reset restores: after a collapse, resetStructure + resetSupportGraph rebuild the anchored graph', async () => {
		const world = await makeWorld();
		try {
			const shed = buildShed(world);
			const graph = buildSupportGraph(shed);
			for (let i = 0; i < 30; i++) world.step(FIXED_DT, FIXED_SUBSTEPS);
			resetSupportGraph(shed, graph);

			const zFront = SHED_CENTER.z - SHED_DEPTH_M / 2;
			const frontStuds = new Set(shed.pieces.filter((p) => p.kind === 'stud' && Math.abs(p.spawnPos.z - zFront) < 0.05).map((p) => p.body.handle));
			severBaseWelds(shed, frontStuds);
			for (const p of shed.pieces) if (!p.isStatic) p.body.setAwake(false);
			const collapseResult = pollStructureCollapse(shed, graph);
			expect(collapseResult.newlyUnsupported.length).toBeGreaterThan(0);
			for (let i = 0; i < 120; i++) {
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				const broke = pollStructureBreaks(shed);
				if (broke > 0) pollStructureCollapse(shed, graph);
			}
			expect(collapsingBodyCount(graph)).toBeGreaterThan(0); // stuff has collapsed

			// Reset.
			resetStructure(world, shed);
			resetSupportGraph(shed, graph);

			// Graph fully rebaselined: nothing is collapsing, every non-static piece is supported+asleep,
			// and a fresh collapse poll on the intact structure flags nothing.
			expect(collapsingBodyCount(graph)).toBe(0);
			const asleep = shed.pieces.filter((p) => !p.isStatic).every((p) => !p.body.isAwake());
			expect(asleep).toBe(true);
			const postReset = pollStructureCollapse(shed, graph);
			expect(postReset.newlyUnsupported.length).toBe(0);

			// And drift is ~0 (pieces teleported home).
			let maxDrift = 0;
			for (const p of shed.pieces) {
				const pos = p.body.getPosition();
				maxDrift = Math.max(maxDrift, Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z));
			}
			console.log(`[d/reset] maxDriftAfterReset=${maxDrift.toFixed(4)}m`);
			expect(maxDrift).toBeLessThan(0.001);

			world.destroy();
		} catch (e) {
			world.destroy();
			throw e;
		}
	});
});
