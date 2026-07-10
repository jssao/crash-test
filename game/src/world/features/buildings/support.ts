// SPDX-License-Identifier: MIT
//
// STRUCTURAL COLLAPSE support graph for the 'buildings' feature. Renderer-free (no `three`/DOM import)
// so headless sim tests import it directly, same convention as structures.ts.
//
// THE PROBLEM. A structure is a weld lattice: bodies are nodes, welds are edges, and the static
// footing is the sole ANCHOR to ground. box3d's own Joint.destroy() force-wakes the two bodies a
// breaking weld was attached to and island-propagates the wake across still-live welds, so a chunk
// sheared off by a hard hit usually falls on its own. But it does NOT reason about SUPPORT: once a
// chunk is ASLEEP and no longer has a weld path to an anchor, box3d never wakes it again -- gravity
// does not integrate a sleeping body -- so a roof whose studs were knocked out HANGS IN THE AIR on
// phantom rigidity until something touches it. This happens whenever a chunk was briefly supported,
// settled, got slept, and only THEN lost its last anchor weld (or the reset path re-slept the whole
// structure with a weld already gone).
//
// THE FIX (event-driven, not per-step). We keep a tiny dependency graph alongside each Structure.
// After ANY weld break (the structures.ts poll already detects them), we re-run union-find over the
// still-live welds: any component with no static member has lost its anchor. A component that JUST lost
// its anchor (it held a previously-supported body) is a freshly-collapsing chunk -- we WAKE all its
// bodies (box3d gravity does the rest -- NO fake impulses) and SOFTEN its internal welds one plastic-
// yield stage (exactly structures.ts's yield trick) so the falling chunk is compliant and crumples on
// landing instead of dropping as one rigid welded slab. Components that were ALREADY unsupported at
// build time (the house-corner's free-standing pipes have no welds at all) are never woken -- only the
// supported -> unsupported TRANSITION fires, so an untouched structure recomputes nothing and stays
// asleep.

import type { Body } from '../../../../../src/ts/index.js';
import type { Structure, StructureJointRecord } from './structures';

export interface SupportGraph {
	/** Piece body handle -> dense node index (0..n-1), one per piece (static footings included). */
	readonly index: Map<bigint, number>;
	/** node index -> piece body. */
	readonly bodies: Body[];
	/** node index -> true for the static footing anchors. */
	readonly isAnchor: boolean[];
	/** node index -> supported-as-of-last-recompute (a weld path to an anchor exists). The BASELINE the
	 * transition test compares against; updated in place every recompute. */
	readonly supported: boolean[];
	/** node index -> true once this body has been flagged as part of a collapsing (orphaned) chunk;
	 * introspection only (hooks / tests), reset by resetSupportGraph(). */
	readonly collapsed: boolean[];
	// Reusable union-find scratch (sized n) so a recompute allocates nothing on the hot path.
	readonly parent: Int32Array;
	readonly rank: Uint16Array;
	readonly anchoredRoot: Uint8Array;
}

export interface CollapseResult {
	/** Bodies that transitioned supported -> unsupported on THIS poll (the freshly-orphaned chunk). */
	readonly newlyUnsupported: bigint[];
	/** How many bodies were woken this poll (== newlyUnsupported.length; kept explicit for the hooks). */
	readonly wokenBodies: number;
	/** How many internal welds of collapsing chunks were softened one yield stage this poll. */
	readonly softenedJoints: number;
}

const EMPTY_RESULT: CollapseResult = { newlyUnsupported: [], wokenBodies: 0, softenedJoints: 0 };

function makeGraph(structure: Structure): SupportGraph {
	const n = structure.pieces.length;
	const index = new Map<bigint, number>();
	const bodies: Body[] = new Array(n);
	const isAnchor: boolean[] = new Array(n);
	for (let i = 0; i < n; i++) {
		const p = structure.pieces[i];
		index.set(p.body.handle, i);
		bodies[i] = p.body;
		isAnchor[i] = p.isStatic;
	}
	return {
		index,
		bodies,
		isAnchor,
		supported: new Array(n).fill(false),
		collapsed: new Array(n).fill(false),
		parent: new Int32Array(n),
		rank: new Uint16Array(n),
		anchoredRoot: new Uint8Array(n),
	};
}

function find(parent: Int32Array, i: number): number {
	let root = i;
	while (parent[root] !== root) root = parent[root];
	// Path compression.
	while (parent[i] !== root) {
		const next = parent[i];
		parent[i] = root;
		i = next;
	}
	return root;
}

function union(parent: Int32Array, rank: Uint16Array, a: number, b: number): void {
	const ra = find(parent, a);
	const rb = find(parent, b);
	if (ra === rb) return;
	if (rank[ra] < rank[rb]) parent[ra] = rb;
	else if (rank[ra] > rank[rb]) parent[rb] = ra;
	else {
		parent[rb] = ra;
		rank[ra]++;
	}
}

/** Runs union-find over every UNBROKEN weld, then marks `anchoredRoot[root]` for each component that
 * contains a static footing. Leaves the disjoint-set forest in `parent` for the caller to inspect. */
function computeConnectivity(structure: Structure, graph: SupportGraph): void {
	const { parent, rank, anchoredRoot, isAnchor, index } = graph;
	const n = graph.bodies.length;
	for (let i = 0; i < n; i++) {
		parent[i] = i;
		rank[i] = 0;
		anchoredRoot[i] = 0;
	}
	for (const j of structure.joints) {
		if (j.broken || !j.joint) continue;
		const a = index.get(j.spec.bodyA.handle);
		const b = index.get(j.spec.bodyB.handle);
		if (a === undefined || b === undefined) continue;
		union(parent, rank, a, b);
	}
	for (let i = 0; i < n; i++) {
		if (isAnchor[i]) anchoredRoot[find(parent, i)] = 1;
	}
}

/**
 * Builds a SupportGraph for `structure` and captures the intact-lattice support baseline (called once,
 * right after the structure is assembled -- every weld is live, so every welded piece is supported and
 * every unwelded piece, e.g. a free pipe, is not). Wakes NOTHING: the baseline is only recorded, so the
 * unwelded pipes -- unsupported from birth -- never count as a "newly collapsing" transition.
 */
export function buildSupportGraph(structure: Structure): SupportGraph {
	const graph = makeGraph(structure);
	computeConnectivity(structure, graph);
	const { parent, anchoredRoot, supported } = graph;
	for (let i = 0; i < graph.bodies.length; i++) supported[i] = anchoredRoot[find(parent, i)] === 1;
	return graph;
}

/**
 * Softens one weld one plastic-yield stage IN PLACE -- byte-for-byte the yield transition in
 * structures.ts's pollStructureBreaks(), reproduced here (rather than exported from there) so the
 * collapse pass can pre-crease a falling chunk's internal welds without reaching into that state
 * machine. No-op on a masonry/break-only weld (it has no soft stage) or one already past rigid.
 * Returns true if it actually softened.
 */
function softenInternalWeld(record: StructureJointRecord): boolean {
	if (record.broken || !record.joint) return false;
	if (record.profile.breakOnly) return false;
	if (record.stage !== 'rigid') return false;
	record.joint.setLinearHertz(record.profile.yieldLinearHertz);
	record.joint.setAngularHertz(record.profile.yieldAngularHertz);
	record.joint.setLinearDampingRatio(record.profile.yieldDampingRatio);
	record.joint.setAngularDampingRatio(record.profile.yieldDampingRatio);
	record.stage = 'yielded';
	return true;
}

/**
 * Recomputes support connectivity and collapses any freshly-orphaned component. Call AFTER a weld break
 * was detected this step (event-driven -- do NOT call every step; on an untouched structure no weld
 * breaks so this never runs and nothing wakes). Idempotent: calling it when nothing changed returns the
 * empty result and touches nothing.
 *
 *   1. Union-find over live welds -> which components still reach an anchor.
 *   2. A component is FRESHLY collapsing if it is now anchor-less AND at least one of its members was
 *      supported at the previous baseline (so free pipes, unsupported from birth, are excluded). For
 *      each such component: wake every non-static member (gravity does the rest) and soften every
 *      internal live weld one yield stage.
 *   3. Update the baseline in place.
 */
export function pollStructureCollapse(structure: Structure, graph: SupportGraph): CollapseResult {
	computeConnectivity(structure, graph);
	const { parent, anchoredRoot, supported, collapsed, isAnchor, bodies } = graph;
	const n = bodies.length;

	// Pass 1: which roots are freshly collapsing (now anchor-less, previously held a supported body)?
	const nowSupported: boolean[] = new Array(n);
	const freshRoot = new Set<number>();
	for (let i = 0; i < n; i++) {
		const root = find(parent, i);
		const sup = anchoredRoot[root] === 1;
		nowSupported[i] = sup;
		if (!sup && supported[i]) freshRoot.add(root); // this body just lost its anchor path
	}

	if (freshRoot.size === 0) {
		// Still update the baseline (a break may have re-anchored nothing but changed connectivity), then
		// bail cheaply.
		for (let i = 0; i < n; i++) supported[i] = nowSupported[i];
		return EMPTY_RESULT;
	}

	// Pass 2: wake every non-static body in a freshly-collapsing component.
	const newlyUnsupported: bigint[] = [];
	for (let i = 0; i < n; i++) {
		if (isAnchor[i]) continue;
		if (!freshRoot.has(find(parent, i))) continue;
		bodies[i].setAwake(true);
		collapsed[i] = true;
		newlyUnsupported.push(bodies[i].handle);
	}

	// Pass 3: soften the internal welds of freshly-collapsing components so the chunk crumples on
	// landing (an internal weld = both endpoints in the same freshly-collapsing component).
	let softenedJoints = 0;
	for (const record of structure.joints) {
		if (record.broken || !record.joint) continue;
		const a = graph.index.get(record.spec.bodyA.handle);
		const b = graph.index.get(record.spec.bodyB.handle);
		if (a === undefined || b === undefined) continue;
		const ra = find(parent, a);
		if (ra !== find(parent, b)) continue; // spans two components -- not internal
		if (!freshRoot.has(ra)) continue;
		if (softenInternalWeld(record)) softenedJoints++;
	}

	for (let i = 0; i < n; i++) supported[i] = nowSupported[i];
	return { newlyUnsupported, wokenBodies: newlyUnsupported.length, softenedJoints };
}

/**
 * Re-baselines the graph after the structure was reset (structures.ts's resetStructure() rebuilt every
 * weld and re-slept every piece). Recomputes the intact-lattice support set and clears the collapsed
 * bookkeeping, so the very next pollStructureCollapse() on the restored structure flags nothing.
 * Also safe to call after a settle phase to rebaseline (no welds broke -> support set unchanged).
 */
export function resetSupportGraph(structure: Structure, graph: SupportGraph): void {
	computeConnectivity(structure, graph);
	const { parent, anchoredRoot, supported, collapsed } = graph;
	for (let i = 0; i < graph.bodies.length; i++) {
		supported[i] = anchoredRoot[find(parent, i)] === 1;
		collapsed[i] = false;
	}
}

/** Count of bodies currently flagged as part of a collapsed (orphaned) chunk -- introspection for the
 * feature's playtest hooks and the collapse test. Reset to 0 by resetSupportGraph(). */
export function collapsingBodyCount(graph: SupportGraph): number {
	let n = 0;
	for (let i = 0; i < graph.collapsed.length; i++) if (graph.collapsed[i]) n++;
	return n;
}
