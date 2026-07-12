// SPDX-License-Identifier: MIT
//
// STRUCTURAL CRUSH VISUAL PASS -- the rendered shell follows the MECHANICAL crush.
//
// WHY (playtest finding "this isn't close at all", 2026-07-10, vs the NHTSA 56 km/h reference): the
// contact-dent pipeline (damage/crumple.ts) displaces vertices along the contact normal only, so all
// of its damage lands on the face pressed AGAINST the barrier -- the one surface nobody can see -- and
// the car reads pristine from every visible angle even while segment telemetry reports 0.42m of real
// mechanical shortening. Real frontal crush is a STRUCTURAL event: the whole front clip accordions
// rearward (bumper-to-wheel gap collapses in silhouette), sheet metal buckles UP and OUT (volume
// conservation folds, not inward dents), and the hood tents at mid-span while staying attached.
//
// WHAT: a pure, deterministic per-vertex displacement field over the registered deformable meshes
// (scene/carDeformables.ts bindings), driven ONLY by vehicle/segments.ts's SegmentTelemetry (the
// physics truth the crash already computes). Applied at render-sync time on top of the crumple
// registry's own offsets -- the registry (instrumentation, panel-hull refresh, every game/sim test)
// never sees it, so the calibrated crush-band/threshold behavior is byte-identical.
//
// Deliberately renderer-free (typed arrays + plain objects, no three/DOM import) so game/sim tests
// can drive it headlessly against synthetic grid meshes, mirroring damage/crumple.ts's own split.
//
// Determinism: crease jitter reuses crumple.ts's integer-hash jitter (vertex index + mesh-id seed) --
// no Math.random()/Date.now() (game/sim/damage-determinism.test.mjs convention).

import type { DeformableMeshHandle } from '../damage/crumple';
import { coherentCreaseNoise, stringSeed } from '../damage/crumple';
import type { SegmentTelemetry } from '../vehicle/segments';
import { FIREWALL_Z_M, BULKHEAD_Z_M } from '../vehicle/geometry';

// ---------------------------------------------------------------------------------------------
// Tuning -- all visual-layer constants live here (no damage-tuning.ts entry: nothing below feeds
// back into physics or telemetry).
// ---------------------------------------------------------------------------------------------

/** Recompute the field only when any driving crush value moved this far (m) since the last build --
 * crush is monotonic and converges within the crash's ~1s window, so this bounds recomputes to a
 * handful per crash instead of one per fixed step. */
export const STRUCT_REBUILD_EPSILON_M = 0.005;

/** Compaction exponent: rearward displacement = crush * t^EXP (t = 0 at the crush-zone root, 1 at
 * the nose/tail tip) -- >1 concentrates shortening toward the tip, the accordion look. */
const COMPACT_EXPONENT = 1.7;

/** Upward buckle amplitude as a fraction of local crush depth (volume-conservation fold: fender
 * tops / cowl-adjacent metal rises as the clip shortens). */
const BUCKLE_UP_RATIO = 0.26;

/** Outboard bulge amplitude as a fraction of local crush depth (fenders wrinkle outward). */
const BUCKLE_OUT_RATIO = 0.16;

/** Vertices below this height (body-local y, m) get only a fraction of the upward buckle -- the
 * lower valance/rail region folds under rather than lifting. */
const BUCKLE_LOW_Y_M = 0.15;
const BUCKLE_LOW_FACTOR = 0.35;

/** Crease jitter fraction of the local displacement magnitude (reads as folded sheet metal, not a
 * smooth morph). */
const STRUCT_JITTER_FRACTION = 0.22;

/** Hood tent: peak upward buckle as a fraction of mechanical front crush (NHTSA 56 reference photos
 * show a ~0.2-0.3m tent on a ~0.5m-crush hit). */
const HOOD_TENT_RATIO = 0.55;
/** Hood tent apex position along the hood's own length (0 = rear/cowl edge, 1 = front edge) --
 * biased forward of center, where real hoods fold. */
const HOOD_TENT_APEX_EXPONENT = 0.85; // apex of sin(pi*u^e) sits forward of u=0.5 for e<1
/** Hood front-edge rearward trail as a fraction of mechanical front crush (the front edge follows
 * the collapsing radiator support; the rear edge stays hinged at the cowl). */
const HOOD_TRAIL_RATIO = 0.5;
/** Lateral cupping: hood edges (|x| toward the fenders) lift slightly less than the centerline. */
const HOOD_CUP_FACTOR = 0.25;
/** Trunk lid mirror of the hood tent for rear impacts, slightly shallower (trunk lids are shorter
 * and stiffer; rear crush rarely tents as tall as a hood). */
const TRUNK_TENT_RATIO = 0.4;
const TRUNK_TRAIL_RATIO = 0.45;

/** Minimum mechanical crush (m) before the structural field switches on at all -- parking taps and
 * sub-structural nudges should not warp the shell. */
const STRUCT_MIN_CRUSH_M = 0.03;

/** Half-width (m) used to normalize lateral position for the side-asymmetry blend -- car half-width
 * ~0.97m (lab/protocols.ts CAR_HALF_WIDTH_M), kept slightly inside so the blend saturates at the
 * fenders. */
const SIDE_BLEND_HALF_WIDTH_M = 0.8;

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export interface StructuralCrushInputs {
	frontCrushM: number;
	rearCrushM: number;
	/** Per-side front crush (m): pos = +x half, neg = -x half. */
	frontPosM: number;
	frontNegM: number;
}

export interface MeshField {
	handle: DeformableMeshHandle;
	/** Lazily allocated on first nonzero field; null while this mesh has never needed one. */
	offsets: Float32Array | null;
	/** True while `offsets` holds any nonzero displacement (false after reset / below-threshold). */
	active: boolean;
	/** Last StructuralCrushState.version whose field this consumer already baked into its rendered
	 * normals -- owned/written by scene/carDeformables.ts's sync, read nowhere else. */
	lastSyncedVersion: number;
	/** Cached hood/trunk mesh extents (panel meshes only). */
	zMin: number;
	zMax: number;
	xHalf: number;
}

export interface StructuralCrushState {
	fields: MeshField[];
	byHandle: Map<DeformableMeshHandle, MeshField>;
	/** Bumped every time the field arrays are rebuilt -- consumers use it to invalidate normals. */
	version: number;
	lastInputs: StructuralCrushInputs;
	/** Cached front/rear tips of the chassis shell (max/min base z over chassis meshes). */
	noseZ: number;
	tailZ: number;
}

export function createStructuralCrushState(handles: readonly DeformableMeshHandle[]): StructuralCrushState {
	let noseZ = FIREWALL_Z_M + 0.5;
	let tailZ = BULKHEAD_Z_M - 0.5;
	const fields: MeshField[] = [];
	for (const handle of handles) {
		let zMin = Infinity;
		let zMax = -Infinity;
		let xHalf = 0;
		for (let i = 0; i < handle.vertexCount; i++) {
			const x = handle.basePositions[i * 3];
			const z = handle.basePositions[i * 3 + 2];
			if (z < zMin) zMin = z;
			if (z > zMax) zMax = z;
			if (Math.abs(x) > xHalf) xHalf = Math.abs(x);
		}
		if (handle.kind === 'chassis') {
			if (zMax > noseZ) noseZ = zMax;
			if (zMin < tailZ) tailZ = zMin;
		}
		fields.push({ handle, offsets: null, active: false, lastSyncedVersion: -1, zMin, zMax, xHalf });
	}
	const byHandle = new Map<DeformableMeshHandle, MeshField>();
	for (const f of fields) byHandle.set(f.handle, f);
	return {
		fields,
		byHandle,
		version: 0,
		lastInputs: { frontCrushM: 0, rearCrushM: 0, frontPosM: 0, frontNegM: 0 },
		noseZ,
		tailZ,
	};
}

/** Derives the field's driving inputs from segment telemetry: mechanical crush sets the DEPTH, the
 * per-side core retreat sets the left/right RATIO (offset-crash asymmetry). */
export function structuralInputsFromTelemetry(seg: SegmentTelemetry): StructuralCrushInputs {
	const front = Math.max(0, seg.frontCrushM);
	let pos = Math.max(0, seg.coreRetreatFrontM.pos);
	let neg = Math.max(0, seg.coreRetreatFrontM.neg);
	const deeper = Math.max(pos, neg);
	if (deeper > 1e-6) {
		// Rescale so the deeper side equals the mechanical crush (segment displacement usually runs
		// a little deeper than bare core-face retreat); the shallower side keeps its measured ratio.
		const s = front / deeper;
		pos *= s;
		neg *= s;
	} else {
		pos = front;
		neg = front;
	}
	return { frontCrushM: front, rearCrushM: Math.max(0, seg.rearCrushM), frontPosM: pos, frontNegM: neg };
}

function inputsMoved(a: StructuralCrushInputs, b: StructuralCrushInputs): boolean {
	return (
		Math.abs(a.frontCrushM - b.frontCrushM) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(a.rearCrushM - b.rearCrushM) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(a.frontPosM - b.frontPosM) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(a.frontNegM - b.frontNegM) > STRUCT_REBUILD_EPSILON_M
	);
}

/** Smooth 0..1 ramp. */
function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------------------------
// Field construction
// ---------------------------------------------------------------------------------------------

function buildChassisField(state: StructuralCrushState, f: MeshField, inp: StructuralCrushInputs): boolean {
	const { handle } = f;
	const seed = stringSeed(handle.id) ^ 0x51ab;
	const frontSpan = state.noseZ - FIREWALL_Z_M;
	const rearSpan = BULKHEAD_Z_M - state.tailZ;
	const frontOn = inp.frontCrushM > STRUCT_MIN_CRUSH_M && frontSpan > 0.1;
	const rearOn = inp.rearCrushM > STRUCT_MIN_CRUSH_M && rearSpan > 0.1;
	if (!frontOn && !rearOn) {
		const wasActive = f.active;
		if (f.offsets) f.offsets.fill(0);
		f.active = false;
		return wasActive;
	}
	if (!f.offsets) f.offsets = new Float32Array(handle.vertexCount * 3);
	const off = f.offsets;
	off.fill(0);
	let wroteAny = false;
	for (let i = 0; i < handle.vertexCount; i++) {
		const bx = handle.basePositions[i * 3];
		const by = handle.basePositions[i * 3 + 1];
		const bz = handle.basePositions[i * 3 + 2];
		let dx = 0;
		let dy = 0;
		let dz = 0;
		if (frontOn && bz > FIREWALL_Z_M) {
			const t = clamp01((bz - FIREWALL_Z_M) / frontSpan);
			const sideBlend = clamp01(bx / (2 * SIDE_BLEND_HALF_WIDTH_M) + 0.5); // 0 at far -x, 1 at far +x
			const crush = inp.frontNegM + (inp.frontPosM - inp.frontNegM) * sideBlend;
			if (crush > STRUCT_MIN_CRUSH_M) {
				const bulge = Math.sin(Math.PI * t);
				const upFactor = by < BUCKLE_LOW_Y_M ? BUCKLE_LOW_FACTOR : 1;
				dz = -crush * Math.pow(t, COMPACT_EXPONENT);
				dy = BUCKLE_UP_RATIO * crush * bulge * upFactor;
				dx = BUCKLE_OUT_RATIO * crush * bulge * Math.tanh(bx / 0.6);
			}
		} else if (rearOn && bz < BULKHEAD_Z_M) {
			const t = clamp01((BULKHEAD_Z_M - bz) / rearSpan);
			const crush = inp.rearCrushM;
			const bulge = Math.sin(Math.PI * t);
			const upFactor = by < BUCKLE_LOW_Y_M ? BUCKLE_LOW_FACTOR : 1;
			dz = crush * Math.pow(t, COMPACT_EXPONENT);
			dy = BUCKLE_UP_RATIO * crush * bulge * upFactor;
			dx = BUCKLE_OUT_RATIO * crush * bulge * Math.tanh(bx / 0.6);
		}
		if (dx !== 0 || dy !== 0 || dz !== 0) {
			// Coherent fixed-wavelength crease noise at the rest position (see crumple.ts's
			// coherentCreaseNoise doc -- index-hashed jitter turned into foil noise on dense meshes).
			const j = 1 + STRUCT_JITTER_FRACTION * coherentCreaseNoise(bx, by, bz, seed);
			off[i * 3] = dx * j;
			off[i * 3 + 1] = dy * j;
			off[i * 3 + 2] = dz * j;
			wroteAny = true;
		}
	}
	const changed = wroteAny || f.active;
	f.active = wroteAny;
	return changed;
}

/** Hood tent / trunk-lid buckle, computed over the PANEL's own mesh extent in its body-local frame
 * (panel worldQuat is identity for this car -- carDeformables.ts registers panel meshes in the panel
 * BODY's frame, axes aligned with the chassis). u runs 0 at the hinged edge, 1 at the free edge. */
function buildPanelField(f: MeshField, inp: StructuralCrushInputs, key: string): boolean {
	const isHood = key === 'hood';
	const crush = isHood ? inp.frontCrushM : inp.rearCrushM;
	const tentRatio = isHood ? HOOD_TENT_RATIO : TRUNK_TENT_RATIO;
	const trailRatio = isHood ? HOOD_TRAIL_RATIO : TRUNK_TRAIL_RATIO;
	const { handle } = f;
	if (crush <= STRUCT_MIN_CRUSH_M * 2) {
		const wasActive = f.active;
		if (f.offsets) f.offsets.fill(0);
		f.active = false;
		return wasActive;
	}
	const span = f.zMax - f.zMin;
	if (span < 0.2) return false;
	if (!f.offsets) f.offsets = new Float32Array(handle.vertexCount * 3);
	const off = f.offsets;
	off.fill(0);
	const seed = stringSeed(handle.id) ^ 0x7e47;
	const amp = tentRatio * crush;
	const xHalf = Math.max(0.3, f.xHalf);
	for (let i = 0; i < handle.vertexCount; i++) {
		const bx = handle.basePositions[i * 3];
		const by = handle.basePositions[i * 3 + 1];
		const bz = handle.basePositions[i * 3 + 2];
		// Hood: hinged at the REAR (cowl) edge, free edge at the nose (+z). Trunk lid: hinged at its
		// FORWARD edge, free edge at the tail (-z).
		const u = isHood ? clamp01((bz - f.zMin) / span) : clamp01((f.zMax - bz) / span);
		const tent = Math.sin(Math.PI * Math.pow(u, HOOD_TENT_APEX_EXPONENT));
		const cup = 1 - HOOD_CUP_FACTOR * Math.pow(Math.abs(bx) / xHalf, 2);
		// Coherent fixed-wavelength crease noise (see crumple.ts's coherentCreaseNoise doc).
		const j = 1 + STRUCT_JITTER_FRACTION * 0.6 * coherentCreaseNoise(bx, by, bz, seed);
		off[i * 3 + 1] = amp * tent * cup * j;
		off[i * 3 + 2] = (isHood ? -1 : 1) * trailRatio * crush * u * u * j;
	}
	f.active = true;
	return true;
}

/**
 * Rebuilds the per-vertex field arrays if the telemetry-derived inputs moved by more than
 * STRUCT_REBUILD_EPSILON_M since the last build. Returns true when anything changed (consumers
 * should then re-upload positions and recompute normals). Panels other than hood/trunk and glass
 * meshes are left to the contact-dent pipeline alone.
 */
export function updateStructuralCrush(state: StructuralCrushState, inputs: StructuralCrushInputs): boolean {
	if (!inputsMoved(inputs, state.lastInputs)) return false;
	state.lastInputs = { ...inputs };
	let any = false;
	for (const f of state.fields) {
		if (f.handle.kind === 'chassis') {
			if (buildChassisField(state, f, inputs)) any = true;
		} else if (f.handle.kind === 'panel' && (f.handle.attachedTo === 'hood' || f.handle.attachedTo === 'trunk')) {
			if (buildPanelField(f, inputs, f.handle.attachedTo)) any = true;
		}
	}
	if (any) state.version++;
	return any;
}

/** Resets every field to zero (car repaired) and bumps the version so consumers re-sync. */
export function resetStructuralCrush(state: StructuralCrushState): void {
	for (const f of state.fields) {
		if (f.offsets) f.offsets.fill(0);
		f.active = false;
	}
	state.lastInputs = { frontCrushM: 0, rearCrushM: 0, frontPosM: 0, frontNegM: 0 };
	state.version++;
}

/** The field record for one handle (null when this handle was never registered with the state).
 * Consumers read `offsets`/`active` and own `lastSyncedVersion` (see MeshField doc). */
export function structuralFieldFor(state: StructuralCrushState, handle: DeformableMeshHandle): MeshField | null {
	return state.byHandle.get(handle) ?? null;
}

/** Max structural displacement magnitude (m) over every ACTIVE field -- diagnostic/verify readout. */
export function maxStructuralOffsetM(state: StructuralCrushState): number {
	let max = 0;
	for (const f of state.fields) {
		if (!f.active || !f.offsets) continue;
		for (let i = 0; i < f.offsets.length; i += 3) {
			const m = Math.hypot(f.offsets[i], f.offsets[i + 1], f.offsets[i + 2]);
			if (m > max) max = m;
		}
	}
	return max;
}
