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
import { coherentCreaseNoise, smoothFalloff, stringSeed } from '../damage/crumple';
import { CRUMPLE_DENT_EPSILON_M } from '../damage/damage-tuning';
import type { SegmentTelemetry } from '../vehicle/segments';
import { FIREWALL_Z_M, BULKHEAD_Z_M, HULL_TOP_Y_M, CRUSH_CORE_INITIAL_RECESS_M, CRUSH_CORE_MAX_RETREAT_FRONT_M } from '../vehicle/geometry';

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
// EXTREME TIER (Stream C slice C2, 2026-07-12): 100-200mph reference footage reads as crush
// reaching PAST the engine bay into the cabin itself -- "crushed all the way to the A-pillar" at
// 100mph, cabin collapse beginning by 120mph. The NCAP-tier field above only ever displaces
// vertices strictly ahead of FIREWALL_Z_M (bz > FIREWALL_Z_M); below reuses the SAME field/noise
// machinery (coherentCreaseNoise, the sin/tanh falloff shapes) to extend a SECOND, independently-
// gated field past the firewall plane into the front-seat/A-pillar zone, gated on MECHANICAL front
// crush (segments.ts telemetry, rig-independent) rather than raw speed -- so this is scaled by how
// far the crash genuinely exceeds the NCAP band, not a flat speed lookup.
//
// GATE: CABIN_EXTEND_MECH_CRUSH_GATE_M is derived from geometry.ts's OWN core-retreat ceiling
// (CRUSH_CORE_INITIAL_RECESS_M + CRUSH_CORE_MAX_RETREAT_FRONT_M = 0.63, + a small safety margin),
// the true pre-extreme-tier maximum segments.ts's mechanical telemetry (frontCrushM) can EVER reach
// -- NOT damage-tuning.ts's CRUMPLE_CLAMP_CHASSIS_M (0.58), which is a DIFFERENT metric (the cosmetic
// contact-dent mesh clamp on a different deformable proxy). MEASURED BUG caught by sim/extreme-tier.
// test.mjs's guard test: gating on 0.58 spuriously engaged the cabin-extension field at 80 km/h,
// whose real frontCrushM (0.5936m) already exceeds 0.58 even with segments.ts's own extreme tier
// (gated at 35 m/s / 126 km/h -- see that file's EXTREME_GATE_SPEED_MS doc) never engaging there --
// deriving the gate from the SAME constants segments.ts's ceiling uses makes this self-consistent
// regardless of future retuning of either. The +0.02m margin covers sim/segment-yield.test.mjs's
// pinned 120 km/h band (measured up to 0.640m, i.e. within 1cm of the bare 0.63 ceiling) with room
// to spare, so the cabin field stays provably inert for that calibrated case too.
// ---------------------------------------------------------------------------------------------

/** Mechanical front crush (m, segments.ts SegmentTelemetry.frontCrushM) at/under which the cabin
 * extension contributes nothing -- the true pre-extreme-tier ceiling this game's ≤120 km/h calibrated
 * matrix can ever reach, plus a small margin (see this section's doc above for why this is NOT
 * CRUMPLE_CLAMP_CHASSIS_M). */
const CABIN_EXTEND_MECH_CRUSH_GATE_M = CRUSH_CORE_INITIAL_RECESS_M + CRUSH_CORE_MAX_RETREAT_FRONT_M + 0.02;

/** Mech front crush (m) at which the cabin-extension field reaches its full (1.0) scale -- past
 * this, more crush deepens the field elsewhere (nose/A-pillar zone itself) but doesn't extend the
 * cabin reach further; the ~200mph "near-total destruction" tier reads through the front-zone
 * field's own magnitude (already saturated) plus this cabin field at full scale, not a longer reach.
 * EYES-ON RETUNE (orchestrator-eyes read of the 161 km/h 3q screenshot): 1.5 left 161 km/h at only
 * cabinT~0.55 -- hood torn/doors sprung read correctly, but the A-pillar/windshield frame itself
 * barely moved, failing the reference's "crushed all the way to the A-pillar" read at the 100mph
 * tier. Lowered to 1.2 (just above 161's measured 1.115m) so 161 already reads at cabinT~0.85 (strong
 * cabin intrusion); 193/322 km/h (1.56/1.63m) both saturate to the same full cabin-scale -- fine per
 * this constant's own doc, since their escalation over 161 still reads through deeper nose crush,
 * more broken panels, and wheel loss, not a longer cabin reach. */
const CABIN_EXTEND_MECH_CRUSH_FULL_M = 1.2;

/** How far past FIREWALL_Z_M (m, chassis-local +z is forward, so the zone spans
 * [FIREWALL_Z_M - this, FIREWALL_Z_M]) the cabin-extension field reaches at full scale -- the
 * A-pillar / front-seat roofline zone, deliberately not the whole cabin. Widened 0.9 -> 1.1m in the
 * same eyes-on retune (161 km/h read) so the field's reach genuinely covers the A-pillar/windshield
 * header zone, not just the firewall's immediate vicinity. */
const CABIN_EXTEND_DEPTH_M = 1.1;

/** Peak roofline drop (m, -Y) at full scale over the front-seat zone (roof vertices only, see
 * CABIN_ROOF_Y_FRAC). EYES-ON RETUNE: 0.22 -> 0.4 (see CABIN_EXTEND_MECH_CRUSH_FULL_M's doc). */
const CABIN_ROOF_DROP_M = 0.4;

/** Peak A-pillar lean-back (additional rearward -Z, m) at full scale, roof vertices only -- the
 * windshield frame folding back over the front row. EYES-ON RETUNE: 0.35 -> 0.7. */
const CABIN_PILLAR_LEANBACK_M = 0.7;

/** Peak dash/cowl rearward displacement (m, -Z) at full scale, applied across the whole cabin-
 * extension zone (not just roof vertices) -- the firewall/dash structure pushed toward the seats.
 * EYES-ON RETUNE: 0.3 -> 0.55. */
const CABIN_DASH_PUSH_M = 0.55;

/** Body-local height (fraction of HULL_TOP_Y_M) above which a vertex counts as "roofline" for the
 * roof-drop/pillar-leanback terms (below this, only the dash-push term applies). */
const CABIN_ROOF_Y_FRAC = 0.55;

// ---------------------------------------------------------------------------------------------
// LATERAL FIELD (Stream C slice C3, 2026-07-12): side-impact / small-overlap crashes only ever got
// LOCAL contact dents (damage/crumple.ts) -- from a TOP VIEW the silhouette barely changes, the same
// class of bug the front/rear field above was built to fix, because vehicle/segments.ts's telemetry
// (this field's only other driver) has NO lateral channel at all: SegmentTelemetry tracks front/rear
// compaction and the offset-frontal L/R core-retreat ratio, never a side-flank crush depth.
//
// FIX: derive a per-side ("pos" = +x half, "neg" = -x half) cave-depth/longitudinal-center/spread
// statistic straight from the CRUMPLE REGISTRY's own accumulated per-vertex offsets on CHASSIS-kind
// meshes (damage/crumple.ts) -- that registry is already the persistent physics-truth record of where
// a side hit landed and how hard (every qualifying contact event, including a side impact, deposits
// its dent there via applyCrumpleEvent/applyImpactToMesh), so it needs no new physics/telemetry wiring
// at all. lateralInputsFromRegistry() below is the pure derivation (mirrors structuralInputsFromTelemetry()'s
// role for the front/rear field); callers (main.ts/lab/main.ts) merge its result into the same
// StructuralCrushInputs object passed to updateStructuralCrush(), which rebuilds the field under the
// SAME hysteresis/version machinery (STRUCT_REBUILD_EPSILON_M) the front/rear field already uses.
// ---------------------------------------------------------------------------------------------

/** Car half-width (m) -- same measured S90 value SIDE_BLEND_HALF_WIDTH_M's doc cites (lab/protocols.ts
 * CAR_HALF_WIDTH_M). Duplicated here (not imported) rather than threading a parameter through every
 * call site: src/lab/** already depends on scene/**, so importing the other way would invert that
 * layering, and this module deliberately stays free of any src/lab import. */
const FLANK_HALF_WIDTH_M = 1.01;

/** Fraction of FLANK_HALF_WIDTH_M beyond which a chassis vertex counts as being in the lateral
 * "flank band" for the driver-stats derivation below -- narrow enough to exclude the floorpan/
 * driveline centerline (which never legitimately reads as a side-impact site), wide enough to catch
 * the sill/rocker/door-aperture region a real side hit actually lands on. */
const LATERAL_BAND_FRAC = 0.55;

/** Robust "high-percentile" depth statistic: the mean of the top (1 - this fraction) of in-band
 * TOUCHED vertices (by inward-|x| magnitude). Neither a bare max (one noisy vertex could dominate) nor
 * a bare mean (diluted by the many untouched flank vertices even in a genuine hit, since only the
 * struck patch actually dents) is the right shape here -- this reads close to "how deep did the worst
 * genuinely-struck patch of this flank cave" while staying a deterministic, allocation-light stat. */
const LATERAL_DEPTH_PERCENTILE = 0.85;

/** Floor (m) for the derived longitudinal spread (spanM) -- guards the falloff denominator against a
 * single-vertex sample, whose std would otherwise read exactly 0 and produce a divide-by-zero-width
 * (infinitely sharp) falloff. */
const LATERAL_SPAN_FLOOR_M = 0.12;

/** How many std-widths (LateralSideStats.spanM) the longitudinal falloff reaches before fully fading.
 * A narrow, deep hit (pole -- small spanM) reads as a narrow deep cave; a broad hit (MDB face -- larger
 * spanM) reads as a wider one, the same "reuse the falloff shape, let the driver stats set its width"
 * idea the front field's t^COMPACT_EXPONENT already uses for depth. */
const LATERAL_FALLOFF_SPAN_MULT = 1.6;

// Minimum per-side depth (m) before the lateral field switches on for that side at all mirrors
// STRUCT_MIN_CRUSH_M's role for the front/rear field (parking taps / sub-structural nudges shouldn't
// warp the shell) -- reuses STRUCT_MIN_CRUSH_M itself directly, no separate constant needed.

/** Fraction of a flank's cave depth applied as roof-EDGE droop directly above the strike (reference:
 * NHTSA side-MDB top view shows "the roof edge buckles slightly over the strike"). */
const LATERAL_ROOF_DROP_RATIO = 0.22;

/** Body-local height fraction (of HULL_TOP_Y_M) above which a vertex counts as "roofline" for the
 * lateral roof-edge droop -- higher than CABIN_ROOF_Y_FRAC since this is deliberately just the roof
 * rail immediately over the strike, not the whole upper cabin. */
const LATERAL_ROOF_Y_FRAC = 0.75;

/** UNDERSIDE COHERENCE (Stream C slice C3): max fraction of a vertex's OWN |base x| that the TOTAL
 * combined x-displacement (frontal outboard bulge + lateral cave, now both live in the same field) may
 * ever reach. A cave can approach but must never cross the centerline, and this is also the fold-
 * through guard the combine rule needs: without it, a deep lateral cave on one flank plus that same
 * vertex's own frontal bulge could in principle add past x=0 and pass the floorpan through itself from
 * below. Scales with the vertex's OWN |base x| (0 exactly at the literal centerline, where any sideways
 * motion at all risks a fold), applied to EVERY chassis vertex every build -- inert for the pre-existing
 * frontal-only fields (their bulge magnitude never remotely approaches this fraction), so this is a
 * pure safety net, not a retune of anything already calibrated. */
const LATERAL_MAX_X_FRACTION_OF_BASE = 0.85;

/** Door cave depth as a fraction of the chassis-derived flank depth -- door skin is thin sheet with far
 * less structure behind it than the sill/rocker the chassis reading is dominated by, so it plausibly
 * caves at least as deep; kept just under 1x rather than over it (the chassis reading already reflects
 * the harder-to-move structural members). */
const DOOR_CAVE_DEPTH_RATIO = 0.85;
/** Absolute safety cap (m) on door cave depth -- door travel/thickness is small; keeps the panel's
 * collision hull (damage-tuning.ts's PANEL_HULL_* rebuild) sane even for a saturated flank reading. */
const DOOR_CAVE_MAX_M = 0.3;

/** Which flank (+x / -x) each door panel key sits on -- panels.ts's PANEL_WORLD_QUAT is identity for
 * every panel on this car (see carDeformables.ts's module doc), so a door panel mesh's own local frame
 * is chassis-axis-aligned, just translated by its localCenter -- this module never needs that
 * localCenter (or any panels.ts import) to know which DIRECTION is "inward" for a given door, only
 * which side it's mounted on. Mirrors panels.ts's own DOOR_OPEN_SIGN doc comment convention: doorL/
 * doorRL sit on the +X flank, doorR/doorRR on the -X flank. */
const DOOR_FLANK_SIGN: Partial<Record<string, 1 | -1>> = { doorL: 1, doorRL: 1, doorR: -1, doorRR: -1 };

/** SMALL-OVERLAP CORNER ACCENT: how much deeper the struck side's mechanical front crush must be than
 * the intact side's (as a fraction of the struck side's own depth) before the wheel-arch band below
 * gets an extra push -- gates this OFF for an ordinary symmetric full-frontal (nhtsa-56, whose
 * frontPosM==frontNegM) and only fires for a genuinely offset/small-overlap corner load. Tight gating
 * (plus the narrow t-band below) keeps this provably inert against every EXISTING pinned frontal unit
 * test in structural-crush-visual.test.mjs -- see this constant's use-site doc comment for the exact
 * argument. */
const WHEEL_ARCH_ASYMMETRY_MIN_FRAC = 0.3;
/** Fraction-of-frontSpan band (t, 0=firewall .. 1=nose) the corner accent applies within -- roughly
 * where a front wheel/arch sits relative to the firewall-to-nose span. */
const WHEEL_ARCH_T_MIN = 0.1;
const WHEEL_ARCH_T_MAX = 0.4;
/** Extra crush (fraction of the struck side's own mechanical front crush) added within the wheel-arch
 * band on the struck side only -- the small-overlap reference's "struck wheel torn/shoved back" read,
 * approximated visually (the wheel RIG body itself isn't a carDeformables member, so this can only ever
 * shove the surrounding sheet metal/arch, not the wheel mesh -- see this task's dispatch notes on the
 * measured wheel-detach outcome at iihs-small-64). */
const WHEEL_ARCH_EXTRA_RATIO = 0.3;

export interface LateralSideStats {
	/** High-percentile inward |x| displacement (m) among in-band CHASSIS vertices -- see
	 * LATERAL_DEPTH_PERCENTILE's doc comment. */
	depthM: number;
	/** Offset-weighted mean base z (m) of the contributing vertices -- the strike's longitudinal center. */
	centerZ: number;
	/** Offset-weighted std of base z (m) -- how spread out the strike is longitudinally (narrow pole hit
	 * vs. a wider MDB-face hit). Floored at LATERAL_SPAN_FLOOR_M. */
	spanM: number;
}

const ZERO_SIDE_STATS: LateralSideStats = { depthM: 0, centerZ: 0, spanM: LATERAL_SPAN_FLOOR_M };

function lateralSideStatsFromSamples(samples: readonly { z: number; mag: number }[]): LateralSideStats {
	if (samples.length === 0) return ZERO_SIDE_STATS;
	let sumMag = 0;
	let sumMagZ = 0;
	for (const s of samples) {
		sumMag += s.mag;
		sumMagZ += s.mag * s.z;
	}
	const centerZ = sumMag > 1e-9 ? sumMagZ / sumMag : 0;
	let sumMagDz2 = 0;
	for (const s of samples) {
		const dz = s.z - centerZ;
		sumMagDz2 += s.mag * dz * dz;
	}
	const spanM = Math.max(LATERAL_SPAN_FLOOR_M, sumMag > 1e-9 ? Math.sqrt(sumMagDz2 / sumMag) : LATERAL_SPAN_FLOOR_M);
	const sorted = samples.slice().sort((a, b) => b.mag - a.mag);
	const topCount = Math.max(1, Math.ceil(sorted.length * (1 - LATERAL_DEPTH_PERCENTILE)));
	let topSum = 0;
	for (let i = 0; i < topCount; i++) topSum += sorted[i].mag;
	return { depthM: topSum / topCount, centerZ, spanM };
}

/**
 * Derives the lateral field's driver stats straight from the crumple registry's accumulated offsets on
 * CHASSIS-kind meshes -- the registry is the only physics-truth record a side hit leaves (see this
 * section's module doc for why segments.ts telemetry can't drive this). Each side (pos = +x half,
 * neg = -x half) is fully independent: a vertex only ever contributes to whichever side its OWN base x
 * sits on, so an untouched flank always resolves to ZERO_SIDE_STATS, never a fraction of the struck
 * side's reading -- "intact side gets NOTHING" holds by construction, not by a subsequent zeroing step.
 */
export function lateralInputsFromRegistry(meshes: readonly DeformableMeshHandle[]): { sidePos: LateralSideStats; sideNeg: LateralSideStats } {
	const bandX = LATERAL_BAND_FRAC * FLANK_HALF_WIDTH_M;
	const pos: { z: number; mag: number }[] = [];
	const neg: { z: number; mag: number }[] = [];
	for (const mesh of meshes) {
		if (mesh.kind !== 'chassis') continue;
		for (let i = 0; i < mesh.vertexCount; i++) {
			const bx = mesh.basePositions[i * 3];
			if (Math.abs(bx) < bandX) continue;
			// Sign convention mirrors lab/instrumentation.ts's measureCrush(): for a +x-side vertex,
			// inward is the -x direction (toward centerline); for a -x-side vertex, inward is +x.
			const inward = bx > 0 ? -mesh.offsets[i * 3] : mesh.offsets[i * 3];
			if (inward <= CRUMPLE_DENT_EPSILON_M) continue; // untouched, or bulged outward: not a cave
			const bz = mesh.basePositions[i * 3 + 2];
			(bx > 0 ? pos : neg).push({ z: bz, mag: inward });
		}
	}
	return { sidePos: lateralSideStatsFromSamples(pos), sideNeg: lateralSideStatsFromSamples(neg) };
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export interface StructuralCrushInputs {
	frontCrushM: number;
	rearCrushM: number;
	/** Per-side front crush (m): pos = +x half, neg = -x half. */
	frontPosM: number;
	frontNegM: number;
	/** Lateral (side-impact) driver stats -- see this file's LATERAL FIELD section doc. Optional so
	 * every pre-existing call site/fixture (frontal-only telemetry, sim tests) keeps compiling and
	 * behaving byte-identically; undefined resolves to ZERO_SIDE_STATS (front-field results unchanged
	 * when no side hits, per this slice's TESTS requirement). */
	sidePos?: LateralSideStats;
	sideNeg?: LateralSideStats;
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
	const aPos = a.sidePos ?? ZERO_SIDE_STATS;
	const bPos = b.sidePos ?? ZERO_SIDE_STATS;
	const aNeg = a.sideNeg ?? ZERO_SIDE_STATS;
	const bNeg = b.sideNeg ?? ZERO_SIDE_STATS;
	return (
		Math.abs(a.frontCrushM - b.frontCrushM) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(a.rearCrushM - b.rearCrushM) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(a.frontPosM - b.frontPosM) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(a.frontNegM - b.frontNegM) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(aPos.depthM - bPos.depthM) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(aNeg.depthM - bNeg.depthM) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(aPos.centerZ - bPos.centerZ) > STRUCT_REBUILD_EPSILON_M ||
		Math.abs(aNeg.centerZ - bNeg.centerZ) > STRUCT_REBUILD_EPSILON_M
	);
}

/** Smooth 0..1 ramp. */
function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------------------------
// Field construction
// ---------------------------------------------------------------------------------------------

/** Lateral flank-cave contribution (dx toward centerline, dy roof-edge droop) for one vertex against
 * one side's driver stats -- see this file's LATERAL FIELD section doc. Independent of the front/rear/
 * cabin z-region logic below: it reaches across the WHOLE chassis z-span (a side hit's strike center
 * can land anywhere from the B-pillar to well forward/aft of it), so it's applied as an ADD-ON, not a
 * fourth mutually-exclusive branch. */
function lateralFlankXY(by: number, bz: number, stats: LateralSideStats, sideSign: 1 | -1): { dx: number; dy: number } {
	const t = Math.abs(bz - stats.centerZ) / (stats.spanM * LATERAL_FALLOFF_SPAN_MULT);
	const falloff = smoothFalloff(t);
	const mag = stats.depthM * falloff;
	const roofFrac = clamp01((by / HULL_TOP_Y_M - LATERAL_ROOF_Y_FRAC) / (1 - LATERAL_ROOF_Y_FRAC));
	return { dx: -sideSign * mag, dy: -LATERAL_ROOF_DROP_RATIO * mag * roofFrac };
}

function buildChassisField(state: StructuralCrushState, f: MeshField, inp: StructuralCrushInputs): boolean {
	const { handle } = f;
	const seed = stringSeed(handle.id) ^ 0x51ab;
	const frontSpan = state.noseZ - FIREWALL_Z_M;
	const rearSpan = BULKHEAD_Z_M - state.tailZ;
	const frontOn = inp.frontCrushM > STRUCT_MIN_CRUSH_M && frontSpan > 0.1;
	const rearOn = inp.rearCrushM > STRUCT_MIN_CRUSH_M && rearSpan > 0.1;
	// EXTREME TIER (Stream C C2): cabin-extension scale, 0 at/under the NCAP-tier ceiling (see this
	// file's CABIN_EXTEND_MECH_CRUSH_GATE_M section doc) -- whenever this is > 0, frontOn is already
	// true too (frontCrushM > 0.58 implies > STRUCT_MIN_CRUSH_M), so no extra early-exit gating needed.
	const cabinT = clamp01((inp.frontCrushM - CABIN_EXTEND_MECH_CRUSH_GATE_M) / (CABIN_EXTEND_MECH_CRUSH_FULL_M - CABIN_EXTEND_MECH_CRUSH_GATE_M));
	const cabinZMin = FIREWALL_Z_M - CABIN_EXTEND_DEPTH_M;
	// LATERAL FIELD (Stream C C3): per-side gate on the registry-derived depth stat (this file's
	// LATERAL FIELD section doc) -- independent of frontOn/rearOn/cabinT, so a PURE side hit (zero
	// mechanical front/rear crush) still switches this field on.
	const sidePos = inp.sidePos ?? ZERO_SIDE_STATS;
	const sideNeg = inp.sideNeg ?? ZERO_SIDE_STATS;
	const sidePosOn = sidePos.depthM > STRUCT_MIN_CRUSH_M;
	const sideNegOn = sideNeg.depthM > STRUCT_MIN_CRUSH_M;
	// SMALL-OVERLAP CORNER ACCENT gate (this file's WHEEL_ARCH_* doc comment): only a genuinely
	// asymmetric frontal (offset/small-overlap) engages it -- an ordinary symmetric full-frontal
	// (frontPosM==frontNegM, e.g. nhtsa-56) always reads frontAsymmetric=false here, so this is
	// provably inert for every existing symmetric-frontal pinned test.
	const deeperFront = Math.max(inp.frontPosM, inp.frontNegM);
	const shallowerFront = Math.min(inp.frontPosM, inp.frontNegM);
	const frontAsymmetric = deeperFront > STRUCT_MIN_CRUSH_M && (deeperFront - shallowerFront) / deeperFront > WHEEL_ARCH_ASYMMETRY_MIN_FRAC;
	const struckSideIsPos = inp.frontPosM >= inp.frontNegM;
	if (!frontOn && !rearOn && !sidePosOn && !sideNegOn && cabinT <= 0) {
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
				// SMALL-OVERLAP CORNER ACCENT: extra push concentrated in the wheel-arch t-band, struck
				// side only -- see WHEEL_ARCH_* doc comments. Tightly gated (frontAsymmetric + narrow
				// t-band) so this never fires for structural-crush-visual.test.mjs's existing symmetric
				// fixtures, and its one asymmetric fixture only samples the nose row (t~0.93, outside
				// this band) -- provably inert against every pre-existing pinned assertion.
				if (frontAsymmetric && t > WHEEL_ARCH_T_MIN && t < WHEEL_ARCH_T_MAX) {
					const onStruckSide = struckSideIsPos ? bx > 0 : bx < 0;
					if (onStruckSide) {
						const archT = clamp01((t - WHEEL_ARCH_T_MIN) / (WHEEL_ARCH_T_MAX - WHEEL_ARCH_T_MIN));
						const archBulge = Math.sin(Math.PI * archT); // 0 at both band edges, peak mid-band
						const extra = WHEEL_ARCH_EXTRA_RATIO * deeperFront * archBulge;
						dz -= extra;
						dx += (bx > 0 ? -1 : 1) * extra * 0.6;
					}
				}
			}
		} else if (rearOn && bz < BULKHEAD_Z_M) {
			const t = clamp01((BULKHEAD_Z_M - bz) / rearSpan);
			const crush = inp.rearCrushM;
			const bulge = Math.sin(Math.PI * t);
			const upFactor = by < BUCKLE_LOW_Y_M ? BUCKLE_LOW_FACTOR : 1;
			dz = crush * Math.pow(t, COMPACT_EXPONENT);
			dy = BUCKLE_UP_RATIO * crush * bulge * upFactor;
			dx = BUCKLE_OUT_RATIO * crush * bulge * Math.tanh(bx / 0.6);
		} else if (cabinT > 0 && bz <= FIREWALL_Z_M && bz > cabinZMin) {
			// EXTREME TIER (Stream C C2): cabin-extension field -- reuses the same smooth-ramp +
			// coherent-crease-noise machinery as the front/rear fields above, gated by cabinT (this
			// file's module doc). u = 0 at the firewall plane (deepest reach), 1 at the back edge of the
			// extension zone (fully faded) -- decay = 1-u concentrates the displacement near the firewall,
			// same "localised crease, not a broad wrinkle" shape the reference targets.
			const u = clamp01((FIREWALL_Z_M - bz) / CABIN_EXTEND_DEPTH_M);
			const decay = 1 - u;
			const roofFrac = clamp01((by / HULL_TOP_Y_M - CABIN_ROOF_Y_FRAC) / (1 - CABIN_ROOF_Y_FRAC));
			dz = -cabinT * decay * (CABIN_DASH_PUSH_M + CABIN_PILLAR_LEANBACK_M * roofFrac);
			dy = -cabinT * decay * CABIN_ROOF_DROP_M * roofFrac;
		}
		// LATERAL FIELD (Stream C C3): an ADD-ON to whatever the front/rear/cabin branch above already
		// wrote for this vertex (usually nothing, in the cabin/B-pillar z-range no other branch reaches)
		// -- see lateralFlankXY()'s doc comment. Struck flank only; the intact flank's gate is always
		// false when that side was never hit, so it contributes literally nothing.
		if (sidePosOn && bx > 0) {
			const lat = lateralFlankXY(by, bz, sidePos, 1);
			dx += lat.dx;
			dy += lat.dy;
		} else if (sideNegOn && bx < 0) {
			const lat = lateralFlankXY(by, bz, sideNeg, -1);
			dx += lat.dx;
			dy += lat.dy;
		}
		// UNDERSIDE COHERENCE (Stream C C3): clamp the TOTAL combined x-displacement so the cave can
		// never cross (or fold through) the centerline -- see LATERAL_MAX_X_FRACTION_OF_BASE's doc
		// comment. Scales with this vertex's OWN |bx| (0 at the literal centerline), applied uniformly;
		// inert for the pre-existing frontal-only bulge (never remotely approaches this fraction).
		const maxAbsDx = LATERAL_MAX_X_FRACTION_OF_BASE * Math.abs(bx);
		if (dx > maxAbsDx) dx = maxAbsDx;
		else if (dx < -maxAbsDx) dx = -maxAbsDx;
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

/** Struck-side DOOR PANEL cave field (Stream C C3): the same silhouette-changing displacement the
 * chassis field above gets, applied to a door's own mesh so the visible door SKIN follows the cave
 * (reference: "door region bows inward", "door skin peeled/damaged"). Computed purely over the door's
 * OWN local z-extent (f.zMin/zMax, already cached generically for every registered mesh -- see
 * createStructuralCrushState) rather than trying to align with the chassis-frame strike center: the
 * door is a narrow panel, so a bell-curve centered on its own geometric middle reads correctly without
 * needing this module to import panels.ts's localCenter data. */
function buildDoorCaveField(f: MeshField, side: LateralSideStats, sideSign: 1 | -1): boolean {
	const { handle } = f;
	const on = side.depthM > STRUCT_MIN_CRUSH_M;
	if (!on) {
		const wasActive = f.active;
		if (f.offsets) f.offsets.fill(0);
		f.active = false;
		return wasActive;
	}
	if (!f.offsets) f.offsets = new Float32Array(handle.vertexCount * 3);
	const off = f.offsets;
	off.fill(0);
	const seed = stringSeed(handle.id) ^ 0x3fa9;
	const span = Math.max(0.2, f.zMax - f.zMin);
	const zCenter = (f.zMax + f.zMin) / 2;
	const depth = Math.min(DOOR_CAVE_MAX_M, DOOR_CAVE_DEPTH_RATIO * side.depthM);
	let wroteAny = false;
	for (let i = 0; i < handle.vertexCount; i++) {
		const bx = handle.basePositions[i * 3];
		const by = handle.basePositions[i * 3 + 1];
		const bz = handle.basePositions[i * 3 + 2];
		const t = clamp01(Math.abs(bz - zCenter) / (span * 0.75));
		const mag = depth * smoothFalloff(t);
		if (mag <= 1e-9) continue;
		const j = 1 + STRUCT_JITTER_FRACTION * coherentCreaseNoise(bx, by, bz, seed);
		off[i * 3] = -sideSign * mag * j; // bows inward toward the chassis centerline
		wroteAny = true;
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
 * should then re-upload positions and recompute normals). Panels other than hood/trunk/doors and glass
 * meshes are left to the contact-dent pipeline alone.
 */
export function updateStructuralCrush(state: StructuralCrushState, inputs: StructuralCrushInputs): boolean {
	if (!inputsMoved(inputs, state.lastInputs)) return false;
	state.lastInputs = { ...inputs };
	const sidePos = inputs.sidePos ?? ZERO_SIDE_STATS;
	const sideNeg = inputs.sideNeg ?? ZERO_SIDE_STATS;
	let any = false;
	for (const f of state.fields) {
		if (f.handle.kind === 'chassis') {
			if (buildChassisField(state, f, inputs)) any = true;
		} else if (f.handle.kind === 'panel' && (f.handle.attachedTo === 'hood' || f.handle.attachedTo === 'trunk')) {
			if (buildPanelField(f, inputs, f.handle.attachedTo)) any = true;
		} else if (f.handle.kind === 'panel' && DOOR_FLANK_SIGN[f.handle.attachedTo]) {
			const sideSign = DOOR_FLANK_SIGN[f.handle.attachedTo]!;
			const side = sideSign > 0 ? sidePos : sideNeg;
			if (buildDoorCaveField(f, side, sideSign)) any = true;
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
