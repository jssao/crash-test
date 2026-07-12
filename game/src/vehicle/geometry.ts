// SPDX-License-Identifier: MIT
//
// Chassis hull-point generation + a from-scratch mass/centroid estimator for the tuning workaround
// described in tuning.ts's COM_LOWER_OFFSET_M doc comment. No three/DOM import (physics core).

import { add, dot, sub, type V3 } from './mathUtil';
import {
	BALLAST_LOCAL_Y_M,
	BALLAST_RADIUS_M,
	CAR_HEIGHT_M,
	CHASSIS_MASS_KG,
	CHASSIS_ORIGIN_HEIGHT_M,
	COM_LOWER_OFFSET_M,
	GROUND_CLEARANCE_M,
	HULL_BOTTOM_HALF_LENGTH_M,
	HULL_BOTTOM_HALF_WIDTH_M,
	HULL_TOP_CENTER_Z_M,
	HULL_TOP_HALF_LENGTH_M,
	HULL_TOP_HALF_WIDTH_M,
} from './tuning';

/**
 * Bottom-face Y (chassis-local; world ground = 0, chassis origin sits at CHASSIS_ORIGIN_HEIGHT_M
 * above it). Raised above the wheel-contact plane by GROUND_CLEARANCE_M -- see that constant's doc
 * comment for why the hull must NOT touch the ground directly.
 */
export const HULL_BOTTOM_Y_M = -CHASSIS_ORIGIN_HEIGHT_M + GROUND_CLEARANCE_M;
/** Top-face Y (roofline), chassis-local. */
export const HULL_TOP_Y_M = CAR_HEIGHT_M - CHASSIS_ORIGIN_HEIGHT_M;

/**
 * The chassis convex-hull's 8 vertices (bevelled box: full-footprint bottom, narrower + rearward
 * top), flattened (x,y,z)-tuples in chassis-local space, ready for Body.createHullShape().
 */
export function buildChassisHullPoints(): Float32Array {
	const by = HULL_BOTTOM_Y_M;
	const ty = HULL_TOP_Y_M;
	const bw = HULL_BOTTOM_HALF_WIDTH_M;
	const bl = HULL_BOTTOM_HALF_LENGTH_M;
	const tw = HULL_TOP_HALF_WIDTH_M;
	const tl = HULL_TOP_HALF_LENGTH_M;
	const tz = HULL_TOP_CENTER_Z_M;

	// prettier-ignore
	const points = new Float32Array([
		// bottom face (full footprint) -- point cloud only, box3d computes the hull itself.
		-bw, by, -bl,
		 bw, by, -bl,
		 bw, by,  bl,
		-bw, by,  bl,
		// top face (narrower, shifted rearward by tz)
		-tw, ty, tz - tl,
		 tw, ty, tz - tl,
		 tw, ty, tz + tl,
		-tw, ty, tz + tl,
	]);

	return points;
}

// ---------------------------------------------------------------------------------------------
// Tier-3 STAGE 1: concave cabin-tub decomposition (docs/build-log/specs/compound-hull-design.md)
// ---------------------------------------------------------------------------------------------
// Replaces the single bevelled-box hull (buildChassisHullPoints() above -- KEPT, still used for the
// mass-parity capture in vehicle.ts) with a set of convex shapes on the one dynamic chassis body.
// box3d bodies carry N shapes natively (mass accumulates per shape), so N convex shapes = a concave
// composite with a genuinely HOLLOW cabin cavity -- the interior Tier-3 stage 2 drops the occupant
// filter into.
//
// PARITY PRINCIPLE: mass/COM/inertia are hard-set identical in vehicle.ts via setMassData(), so these
// shapes' densities are NOMINAL and only their COLLISION geometry matters. The crash/drive tests only
// ever contact the car FRONT-ON (drive +Z into a wall) or from BELOW (ground/terrain), so the union
// here reconstructs the old hull's exact FRONT (nose) face, full BOTTOM (floorpan) face, REAR (tail)
// face and TOP (roof) face; the cabin's greenhouse SIDES (window band) are left as genuine open
// apertures -- no test contacts them, and that openness is the whole point of the concave cabin.
//
// The nose and tail are SOLID crush volumes in stage 1 (identical to the old solid hull there); the
// engine bay is opened into a cavity only in stage 3. Their inward faces (FIREWALL_Z / BULKHEAD_Z)
// are the cabin's front/rear walls.

/**
 * RE-MEASURED 2026-07-11 (Mustang fastback -> Volvo S90 4-door sedan swap). Directly measured off the
 * GLB (game's own load-time frame, car-map.ts axis convention): DoorL front face z~0.944, Hood rear
 * face z~0.994 -- the firewall sits in that ~0.05m gap (the cowl), so FIREWALL_Z_M = 0.95. The S90's
 * cabin is genuinely longer than the Mustang's (a real 4-door layout with 2 full seat rows, not a
 * 2-door fastback + backless rear bench crammed in the tail -- see occupants/tuning.ts's SEAT_LOCAL
 * doc for the derivation): the "Rear Seats" node's own backrest extent reaches z~-1.274, so
 * BULKHEAD_Z_M = -1.25 sits just behind it (giving the rear seatback its own structural depth) --
 * unlike the Mustang, this puts the S90's rear occupants (SEAT_LOCAL z~-0.75) genuinely INSIDE the
 * cabin (z > BULKHEAD_Z_M), not in the crush-zone tail volume.
 */
export const FIREWALL_Z_M = 0.95;
/** Rear cabin wall Z: front face of the rear crush zone (segments.ts trunkFloor abuts it). */
export const BULKHEAD_Z_M = -1.25;
/**
 * Cabin Y-band constants (BELTLINE/FLOORPAN/CANTRAIL), RE-DERIVED 2026-07-11 for the S90: rather than
 * eyeballing raw mesh bboxes (noisy -- door/seat meshes bundle window glass + frame + floor-mount
 * detail into one AABB, see damage-tuning.ts's PANEL_THICKNESS_AXIS doc for the same "bundled bbox"
 * caveat), each Mustang value was re-expressed as its FRACTIONAL position within the Mustang's own
 * [HULL_BOTTOM_Y_M, HULL_TOP_Y_M] band (both already CAR_MAP-derived, so this preserves the tuned
 * cabin-tub PROPORTIONS while adapting to the S90's different origin height/roof height) and that same
 * fraction re-applied within the S90's [HULL_BOTTOM_Y_M, HULL_TOP_Y_M] band (S90: -0.119 .. 1.075 m).
 * Cross-checked against direct measurement where practical (window-band height via the fractional
 * method: 0.369m vs a CAR_HEIGHT_M-ratio estimate of 0.362m -- close agreement; floorpan thickness via
 * the fractional method: 0.145m vs the Mustang's 0.13m -- plausible, floor-pan thickness is one of the
 * least car-size-dependent measurements). Re-measure/adjust if sim/hull-cabin-tub.test.mjs's
 * cabin-cavity probe bounds surface a mismatch.
 */
const BELTLINE_Y_M = 0.54;
/** Top face Y of the floorpan slab (thin: HULL_BOTTOM_Y_M .. this). */
const FLOORPAN_TOP_Y_M = 0.03;
/** Bottom of the roof panel / top of the window aperture (chassis-local Y). */
const CANTRAIL_Y_M = 0.91;
/** Inboard X face of the sills (cabin floor half-width kept clear inboard of this) -- scaled by the
 * S90/Mustang body-width ratio (2.011/1.936 = 1.039) from the Mustang's measured 0.7m. */
const SILL_INNER_X_M = 0.73;

/** Top-face front/rear Z edges of the bevelled envelope (roofline), from the hull tuning. */
const TOP_FRONT_Z_M = HULL_TOP_CENTER_Z_M + HULL_TOP_HALF_LENGTH_M;
const TOP_REAR_Z_M = HULL_TOP_CENTER_Z_M - HULL_TOP_HALF_LENGTH_M;

// ---------------------------------------------------------------------------------------------
// CRUSH CORES (crush M1 structure + M2 yield mechanic). A recessed chassis-owned backstop solid at
// each end: the barrier bottoms out against it once the (compliant) segment layer is exhausted --
// the physical "engine mass / rear bulkhead meets the barrier" stop, with the full chassis mass
// directly in the contact row (MEASURED necessity: any light welded body between barrier and chassis
// stores the stroke elastically and trampolines the car -- see segments.ts's weld-compliance doc).
// The M2 yield mechanic then makes the core face itself RETREAT plastically under staged
// deceleration thresholds (Shape.setHull, the M0b runtime-geometry machinery): that retreat is what
// makes total mechanical crush ENERGY-scaled (a 40km/h stop ends at the initial recess + a little;
// an 80km/h stop drives the face 0.3m+ deeper), reproducing the reference crush-vs-speed curve
// mechanically. See segments.ts's stepSegmentYield().
// ---------------------------------------------------------------------------------------------

/** Where the pristine core faces sit behind the bumper/tail contact faces: the structure's ELASTIC
 * give (bumper system + weld compliance) before plastic collapse begins -- a below-yield tap springs
 * back from inside this zone leaving only cosmetic marks. */
export const CRUSH_CORE_INITIAL_RECESS_M = 0.1;
/** Max plastic face retreat (front/rear): initial recess + retreat = the reference table's absolute
 * crush clamp (~0.58m front; rear kept a little shorter -- no tabulated rear band). */
export const CRUSH_CORE_MAX_RETREAT_FRONT_M = 0.48;
export const CRUSH_CORE_MAX_RETREAT_REAR_M = 0.42;

/** Which lateral half of the car a (front) crush core covers: 'pos' = +x half, 'neg' = -x half,
 * 'full' = full width (the rear core). The FRONT core is SPLIT into two independent half-width
 * cores since crush M2 so a moderate-overlap (offset) barrier collapses ONLY the struck side's
 * hard structure -- the intact side's face stays put and the struck side's rail cells carry the
 * crush, exactly the IIHS-style asymmetry the crash lab's offset protocol measures. */
export type CrushCoreHalf = 'pos' | 'neg' | 'full';

/** Point cloud for one crush core at the given plastic retreat (m). Front cores: firewall plane back
 * face, yielding front face, one per lateral half; rear mirrored (bulkhead / yielding rear face),
 * full width. Same 0.64 half-width / beltline-ish height band as the old solid volumes' structural
 * lower band (S90 swap 2026-07-11: half-width scaled by the body-width ratio 1.039 from the Mustang's
 * 0.62; the 0.5/0.42 height literals below scaled via the same fractional-rescale method as
 * BELTLINE_Y_M/CANTRAIL_Y_M -> 0.52/0.43). */
export function buildCrushCorePoints(end: 'front' | 'rear', retreatM: number, half: CrushCoreHalf = 'full'): Float32Array {
	const by = HULL_BOTTOM_Y_M;
	const x0 = half === 'pos' ? 0 : -0.64;
	const x1 = half === 'neg' ? 0 : 0.64;
	if (end === 'front') {
		const face = HULL_BOTTOM_HALF_LENGTH_M - CRUSH_CORE_INITIAL_RECESS_M - retreatM;
		return boxPoints(x0, x1, by, 0.52, FIREWALL_Z_M, face);
	}
	const face = -(HULL_BOTTOM_HALF_LENGTH_M - CRUSH_CORE_INITIAL_RECESS_M - retreatM);
	return boxPoints(x0, x1, by, 0.43, face, BULKHEAD_Z_M);
}

/** Half-width (x) of the bevelled-box envelope at chassis-local height y (linear loft between the
 * full-footprint bottom and the narrower roofline top -- the SAME loft buildChassisHullPoints()
 * encodes), so every reconstructed outer face sits exactly on the old hull's bevelled side surface. */
function envHalfWidth(y: number): number {
	const t = (y - HULL_BOTTOM_Y_M) / (HULL_TOP_Y_M - HULL_BOTTOM_Y_M);
	return HULL_BOTTOM_HALF_WIDTH_M + (HULL_TOP_HALF_WIDTH_M - HULL_BOTTOM_HALF_WIDTH_M) * t;
}

/** 8-corner box as a flat (x,y,z) point cloud (box3d computes the hull). */
function boxPoints(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): Float32Array {
	// prettier-ignore
	return new Float32Array([
		minX, minY, minZ,  maxX, minY, minZ,  maxX, minY, maxZ,  minX, minY, maxZ,
		minX, maxY, minZ,  maxX, maxY, minZ,  maxX, maxY, maxZ,  minX, maxY, maxZ,
	]);
}

export interface CabinShapeDef {
	name: string;
	points: Float32Array;
}

/**
 * The chassis's concave cabin-tub decomposition: ~12 convex shapes (flattened (x,y,z) point clouds in
 * chassis-local space) whose union reconstructs the old hull's front/bottom/rear/top surfaces while
 * leaving the cabin greenhouse a hollow, open-window cavity. See this section's doc comment.
 */
export function buildCabinShapes(): CabinShapeDef[] {
	const by = HULL_BOTTOM_Y_M;
	const ty = HULL_TOP_Y_M;
	const bhw = HULL_BOTTOM_HALF_WIDTH_M;
	const thw = HULL_TOP_HALF_WIDTH_M;
	const belt = BELTLINE_Y_M;
	const sw = envHalfWidth(belt); // envelope half-width at the beltline (top of the sills)

	const shapes: CabinShapeDef[] = [];

	// 1. Floorpan: thin bottom slab spanning the CABIN only. The front/rear crush-zone bottoms are
	//    reconstructed by the SEGMENT bodies (segments.ts -- crush M1) abutting this slab at the
	//    firewall/bulkhead planes, so the three abutting pieces still tile the BOTTOM face with NO
	//    overlap into the crush zones -- an overlapping floorpan would double-fire hit events with the
	//    front segments on a frontal wall hit and inflate the dent.
	shapes.push({ name: 'floorpan', points: boxPoints(-bhw, bhw, by, FLOORPAN_TOP_Y_M, BULKHEAD_Z_M, FIREWALL_Z_M) });

	// 2./3. The solid NOSE and TAIL crush volumes that used to occupy [FIREWALL_Z..front] and
	// [rear..BULKHEAD_Z] were REPLACED in crush M1 (crush-architecture.md §A step 1) by REAL welded
	// segment BODIES -- bumperBeam/crushRails/engineCradle front, trunkFloor/rearRails rear, see
	// segments.ts -- so a frontal wall now meets a bumper+rail chain instead of one monolithic convex
	// piece. The segments carry the same occupant-transparent filter the nose/tail did. NOTE the old
	// raked front/rear hull faces above the beltline (fender tops / cowl) are no longer collision-solid:
	// the hood/trunk PANEL bodies (damage/panels.ts) own those top surfaces, and the crush chain owns
	// the structure below them.
	//
	// 2b./3b. The CRUSH CORES (recessed chassis-owned backstop solids the barrier bottoms out against,
	// and the M2 yield mechanic's plastically-retreating faces) are chassis shapes too, but they are
	// created/owned by segments.ts's createSegments() (they are crush structure, and the yield stepper
	// mutates them via Shape.setHull) -- see buildCrushCorePoints() below and segments.ts's
	// stepSegmentYield().

	// 4. Roof panel: thin top slab over the cabin greenhouse -- reproduces the TOP face for the cabin gap
	//    (small rearward overlap avoids a seam at the C-pillars).
	shapes.push({ name: 'roof', points: boxPoints(-thw, thw, CANTRAIL_Y_M, ty, TOP_REAR_Z_M + 0.35, TOP_FRONT_Z_M) });

	// 5/6. Sills: lower cabin side walls (below the beltline), outer face bevelled onto the envelope side,
	//      inboard face at SILL_INNER_X_M leaving the cabin floor open. Left = +X, right = -X.
	// prettier-ignore
	const sillL = new Float32Array([
		SILL_INNER_X_M, by, BULKHEAD_Z_M,  bhw, by, BULKHEAD_Z_M,  bhw, by, FIREWALL_Z_M,  SILL_INNER_X_M, by, FIREWALL_Z_M,
		SILL_INNER_X_M, belt, BULKHEAD_Z_M, sw,  belt, BULKHEAD_Z_M, sw, belt, FIREWALL_Z_M, SILL_INNER_X_M, belt, FIREWALL_Z_M,
	]);
	shapes.push({ name: 'sillL', points: sillL });
	shapes.push({ name: 'sillR', points: mirrorX(sillL) });

	// 7-12. A/B/C pillars: thin verticals bridging the sill top and the roof at the cabin corners/mid,
	//       leaving the window apertures open BETWEEN them. Placed outboard (near the doors), clear of the
	//       seated occupants that stage 2 drops into the cavity. Left = +X, right = -X.
	const pillarZ: Record<string, [number, number]> = {
		A: [FIREWALL_Z_M - 0.18, FIREWALL_Z_M], // windshield base
		// S90 SWAP 2026-07-11: was [-0.09,0.09] (Mustang 2-door "mid cabin", no physical B-pillar
		// reference since there's only one door per side). The S90 has a REAL B-pillar between the
		// front and rear doors -- measured directly: DoorL's rear face z~-0.262, DoorRL's front face
		// z~-0.112, so the B-pillar sits in that ~0.15m gap, centered ~-0.19.
		B: [-0.28, -0.1],
		C: [BULKHEAD_Z_M, BULKHEAD_Z_M + 0.18], // rear
	};
	// S90 SWAP: scaled by the body-width ratio (2.011/1.936 = 1.039) from the Mustang's measured 0.66/0.8.
	const px0 = 0.69;
	const px1 = 0.83;
	const py0 = belt - 0.02;
	const py1 = CANTRAIL_Y_M + 0.01;
	for (const key of ['A', 'B', 'C'] as const) {
		const [z0, z1] = pillarZ[key];
		const left = boxPoints(px0, px1, py0, py1, z0, z1);
		shapes.push({ name: `pillar${key}L`, points: left });
		shapes.push({ name: `pillar${key}R`, points: mirrorX(left) });
	}

	return shapes;
}

// ---------------------------------------------------------------------------------------------
// Tier-3 STAGE 2: solid glass panes (docs/build-log/specs/compound-hull-design.md, S2.1/S2.2)
// ---------------------------------------------------------------------------------------------
// Windshield + rear window as thin SOLID convex slabs on the chassis body, gating the cabin's
// front/rear escape paths. Both panes sit fully INSIDE the solid nose/tail crush volumes (which are
// occupant-transparent, so only occupants/deep debris ever reach the panes), and the outside world's
// contacts always resolve against the nose/tail/roof exterior surfaces first -- so the panes NEVER
// touch walls/ground in the crash suites and exist solely as occupant-facing collision gates. A hit
// on a pane is consumed by the damage system's central drain (system.ts): glassShattered + destroy
// the pane, so the aperture becomes genuinely open and the occupant flies out through REAL contact
// physics.
//
// Seated-clearance ground truth (chassis-local probe, Stage-2 round 2 + re-measured this round):
// BOTH panes deliberately sit ~0.25-0.4m outboard of the visual glass lines, clear of the seated
// occupants' whole measured spawn/settle/jostle envelopes -- see the WINDSHIELD_BOTTOM and
// REAR_WINDOW_TOP doc comments for the measured failures that forced each off the visual line.

/** Pane slab thickness, meters (along z -- the slabs are sheared, so normal thickness is ~4% less). */
const GLASS_THICKNESS_M = 0.04;

/**
 * Windshield rails. MEASURED CORRECTION (mirror of the rear-window one below): a pane on the visual
 * glass line (beltline/firewall corner up to the roof-front edge) leaves only ~0.045m between its
 * inner plane and the braced front torsos -- a mere 30km/h wall BUMP pitches the torsos into it, and
 * the contact-vs-belt fight pumped a measured 26.7/58.7kN through the front restraints (vs
 * 4.8/5.4kN pane-less), snapping all four belts on a bump that must eject nobody. The pane is a
 * collision GATE inside the occupant-transparent nose, not the visual glass, so it sits ~0.25m
 * forward of the glass line instead: bottom rail (0.34, 0.90), top rail (0.84, 1.00), thickness -z
 * (toward the cabin). Measured clearances: front head 0.41m, torso more, and seated knees/thighs at
 * y~0.32 stay (just) below the bottom rail -- ordinary bumps/braces never reach it, while a genuinely
 * ejecting body crosses the gap and strikes it at full fly-out speed. Outer rails stay >=0.02m inside
 * the nose's front bevel (bevel z at y 0.84 is 1.023). The escape slivers around the rails (roof
 * front edge above, a sub-rail path below) are all under a head's diameter for plausible trajectories.
 *
 * CRUSH M1 RAIL EXTENSION (0.42 -> 0.34, measured): the pane doubles as the COWL/DASH gate -- in a
 * real car the band under the glass is solid cowl+dash structure, and this slab is the only catcher
 * for a forward ejectee (everything else ahead of the cabin is occupant-transparent crush zone).
 * Under the old solid-nose instant stop (one ~44g step) ejectee heads crossed the pane plane at
 * y~0.32 (head TOP ~0.44) and clipped the 0.42 rail by ~2cm -- already marginal. The crush-segment
 * front (compliant welds + recessed core, segments.ts) stops the car over ~0.1m more stroke, the
 * launch starts ~2 steps later, and the same trajectory arrives ~4cm lower (head top ~0.40):
 * a 70km/h ejectee slipped UNDER the pane into the (transparent) crush zone and the windshield never
 * shattered (measured, sim/diag/crush-eject-probe). 0.34 restores a solid head-top bite for the
 * honest post-crush trajectory while staying above the seated knee line (0.32) so a front EJECTEE
 * never spawns its knees inside the slab (depenetration pop on eject).
 *
 * S90 SWAP RE-DERIVATION (2026-07-11): Y rails kept close to the Mustang's tuned values (0.34/0.84 ->
 * 0.34/0.90) -- the fractional-rescale method used for BELTLINE_Y_M/CANTRAIL_Y_M above lands almost
 * exactly here too (0.339/0.898), cross-confirming occupant head/knee heights don't change much with
 * car size. Z rail is anchored to the OCCUPANT (occupants/tuning.ts's SEAT_LOCAL.frontLeft/Right.z =
 * 0.35, was 0.55 for the Mustang), NOT to FIREWALL_Z_M -- a first attempt tracked the firewall instead
 * (which moved the OPPOSITE direction, 0.7->0.95) and left the pane ~0.75m ahead of the seat, too far
 * for an ejecting occupant to ever reach within the crash's flight window (measured: sim/occupants-
 * active.test.mjs's 70km/h ejection never touched the pane, paneShape stayed ALIVE). The pane's real
 * job is "just ahead of the seated occupant's reach, inside the ejection flight path" -- preserving the
 * Mustang's measured seat-to-pane gap (0.35m to the bottom rail, 0.45m to the top rail) against the
 * S90's own (rearward-shifted) seat position gives z 0.70/0.80.
 */
const WINDSHIELD_BOTTOM = { y: 0.34, z: 0.7 };
const WINDSHIELD_TOP = { y: 0.9, z: 0.8 };
/**
 * Rear-window rails. MEASURED CORRECTION to the handoff's first-guess span (top z -0.64 -> bottom
 * -1.10, the visual fastback glass line): the rear seats sit INSIDE the tail volume with no seat
 * backs, so the SPAWN pose puts the rear heads (center y 0.63, z ~-1.09, r 0.09) a full radius
 * ACROSS that pane plane (center measured 0.072m outside it), and over the first ~1s of settle the
 * unsupported rear torsos slump rearward-down to a torso-top endpoint at ~(y 0.38, z -1.35). A pane
 * on the visual glass line therefore spawn-overlaps the heads -- depenetration snapped all four
 * belts AT IDLE when tried (occupants-escalation went from idleRMS 0.001 to 1.87 rad/s with 4/4
 * ejected). The pane is a COLLISION gate, not the visual glass (the tail volume it hides in is
 * occupant-transparent anyway), so it sits BEHIND the whole measured spawn->slump swept envelope
 * instead: bottom rail (0.50, -1.52), top rail (0.95, -1.14), thickness +z (toward the cabin).
 * Clearances vs the swept envelope >=0.08m everywhere in the pane's y band; outer rails stay
 * >=0.015m inside the tail's rear bevel (envelope z at y 0.95 is -1.155, at 0.50 is -1.615). The
 * 5cm slit above the top rail (y 0.95..1.00 at z -1.10) is under a third of a head's diameter. A
 * rearward ejectee crosses the open cabin band, enters the (transparent) tail, and strikes this
 * gate exactly as it would the visual glass -- same event, same shatter, ~0.4m deeper.
 *
 * S90 SWAP RE-DERIVATION (2026-07-11): TWO earlier attempts (anchor to BULKHEAD_Z_M, then anchor to
 * the seat with the Mustang's measured seat-to-pane gap) both left this pane unreached -- traced
 * directly (sim/occupants-escalation.test.mjs's 70km/h rear-ejection scenario, per-step pelvis/head
 * position logging): because the S90's rear occupants now sit on a REAL cabin floor (unlike the
 * Mustang's rear bench in the occupant-transparent tail), the restraint fails and they fall through
 * the (occupant-transparent) FLOORPAN almost immediately -- gravity dominates before much forward-or-
 * backward travel accumulates, then they SLIDE along the real ground at near-floor height, ending up
 * FAR to the rear (measured peak chassis-local z: -1.79 and -2.89 for the two rear occupants -- an
 * asymmetric, chaotic slide, not a clean ballistic arc). The pane must be repositioned to actually
 * intercept that slide: wide Y coverage (-0.2..1.05, near-ground to near-roof, since the sliding body
 * is near ground level) and a z-band (-1.5..-1.9) that both measured trajectories demonstrably cross
 * en route to their final rest point. This is a broader "backstop" gate than the Mustang's tight
 * clearance-envelope design, reflecting the genuinely different (more correct) cabin/ejection
 * dynamics now that rear occupants are properly seated. Re-measure if a rear-ejection test still
 * shows a pane miss (this file's own instrumentation approach: temporarily log pelvis/head chassis-
 * relative position every step through the crash+settle window).
 */
const REAR_WINDOW_TOP = { y: 1.05, z: -1.9 };
const REAR_WINDOW_BOTTOM = { y: -0.2, z: -1.5 };

/** Pane half-widths, tapered with the envelope loft so the slab never pokes out of the body side
 * (envelope half-width at the beltline ~0.85, at y 0.95 ~0.76). The A/C pillars (x 0.66..0.80)
 * overlap the windshield's edges, so no head-sized gap exists at the aperture corners.
 * S90 SWAP: scaled by the body-width ratio (2.011/1.936 = 1.039) from the Mustang's measured values. */
const WINDSHIELD_HALF_WIDTH_BOTTOM_M = 0.87;
const WINDSHIELD_HALF_WIDTH_TOP_M = 0.79;
const REAR_WINDOW_HALF_WIDTH_BOTTOM_M = 0.87;
const REAR_WINDOW_HALF_WIDTH_TOP_M = 0.77;

export type GlassPaneKey = 'windshield' | 'rearWindow';

/** One pane as an 8-point convex slab: bottom/top rails extruded GLASS_THICKNESS_M along z TOWARD
 * THE CABIN (`zSign` -1 for the windshield, +1 for the rear window; sheared slab -- fine for a
 * convex hull), so each pane's OUTER extreme is the rail plane itself and stays inside the
 * enclosing crush volume. */
function paneSlabPoints(bottom: { y: number; z: number }, top: { y: number; z: number }, wb: number, wt: number, zSign: 1 | -1): Float32Array {
	const t = GLASS_THICKNESS_M * zSign;
	// prettier-ignore
	return new Float32Array([
		-wb, bottom.y, bottom.z,   wb, bottom.y, bottom.z,
		-wb, bottom.y, bottom.z + t,   wb, bottom.y, bottom.z + t,
		-wt, top.y, top.z,   wt, top.y, top.z,
		-wt, top.y, top.z + t,   wt, top.y, top.z + t,
	]);
}

/** The 2 glass-pane shape defs (chassis-local point clouds), keyed for createVehicle(). */
export function buildGlassPaneShapes(): Record<GlassPaneKey, Float32Array> {
	return {
		windshield: paneSlabPoints(WINDSHIELD_BOTTOM, WINDSHIELD_TOP, WINDSHIELD_HALF_WIDTH_BOTTOM_M, WINDSHIELD_HALF_WIDTH_TOP_M, -1),
		rearWindow: paneSlabPoints(REAR_WINDOW_BOTTOM, REAR_WINDOW_TOP, REAR_WINDOW_HALF_WIDTH_BOTTOM_M, REAR_WINDOW_HALF_WIDTH_TOP_M, 1),
	};
}

// FOOTWELL-SHELF NEGATIVE RESULT (Tier-3 Stage 2, tried + reverted -- kept for the record): the
// seated occupants' feet dangle BELOW the belly line (shin capsule ends at chassis-local y ~-0.20 vs
// hull bottom -0.07) and stand on the WORLD GROUND PLANE through the occupant-transparent floorpan.
// An occupant-only "footwell shelf" slab on the chassis (top ~1cm above the laden ground line, so
// the feet would ride WITH the car) fixed every foot-drag artifact in isolation -- but box3d pair
// filtering is TWO-SIDED: (catA & maskB) && (catB & maskA), and the ground/terrain shapes carry the
// DEFAULT all-ones category, so a shelf whose mask is "occupants only" still collides with the
// ground (the ground's all-ones category intersects any nonzero mask) -- the car beached itself on
// its own invisible shelf (chassis pinned at exactly shelf-bottom height, wheels free-spinning, 0
// traction; sim/diag/stage2-pinch-probe.mjs). Making it work would require clearing a bit from the
// terrain feature's heightfield category (outside this slice's ownership). The feet-on-ground
// artifact instead stays (pre-Stage-2 status quo, all suites calibrated around it) and is defused
// where it BITES: foot-drag belt spikes can no longer eject anyone (pollOccupantRestraint()'s
// crash-gate + matchOccupantVelocity()'s ring seeding, occupants/physics.ts).

/** Mirror a flat (x,y,z) point cloud across the X=0 plane (left -> right cabin shape). */
function mirrorX(points: Float32Array): Float32Array {
	const out = new Float32Array(points.length);
	for (let i = 0; i < points.length; i += 3) {
		out[i] = -points[i];
		out[i + 1] = points[i + 1];
		out[i + 2] = points[i + 2];
	}
	return out;
}

export interface MassProps {
	mass: number;
	centroid: V3;
}

// ---------------------------------------------------------------------------------------------
// Crush-segment mass parity (crush-architecture.md §A step 1). The chassis's monolithic NOSE/TAIL
// crush volumes are being replaced by a chain of REAL welded segment bodies (bumperBeam / crush rails
// / engineCradle / rear rails). To keep total car mass/COM/inertia byte-stable, each segment's mass is
// DEDUCTED from the chassis via the existing setMassData parity capture: capture the single-hull
// parity (mass M0, COM C0, inertia I0 about C0, all chassis-local), then stamp the chassis with the
// REMAINDER so that the rigid composite (chassis + every welded segment) reproduces M0/C0/I0 exactly.
// This is a plain mass-deduction + parallel-axis inertia subtraction (rigid welds hold each segment at
// its chassis-local rest pose, so all math stays in the chassis-local frame). box3d's constrained
// multibody isn't bit-identical to one rigid body (weld compliance), but matching the aggregate
// mass/COM/inertia keeps first-order dynamics stable -- see the M1 gate ("crash/drive within noise").
// ---------------------------------------------------------------------------------------------

/** Symmetric 3x3 inertia tensor as three rows, mirroring src/ts/body.ts's MassData.inertia Matrix3
 * ({cx,cy,cz} row vectors) so a ParityMassData drops straight into Body.setMassData(). */
export interface Inertia3 {
	cx: V3;
	cy: V3;
	cz: V3;
}

/** A rigid mass distribution in chassis-local space: total mass, center of mass, inertia about that
 * center. Shaped identically to src/ts/body.ts's MassData (renderer-free duplicate so this physics-core
 * module needn't import the binding's Body type). */
export interface ParityMassData {
	mass: number;
	center: V3;
	inertia: Inertia3;
}

/** One welded segment body treated as a uniform solid box for the parity math: chassis-local center,
 * chassis-axis-aligned half-extents, and target mass. */
export interface SegmentMassSpec {
	center: V3;
	half: V3;
	massKg: number;
}

function addInertia(a: Inertia3, b: Inertia3): Inertia3 {
	return { cx: add(a.cx, b.cx), cy: add(a.cy, b.cy), cz: add(a.cz, b.cz) };
}

function subInertia(a: Inertia3, b: Inertia3): Inertia3 {
	return { cx: sub(a.cx, b.cx), cy: sub(a.cy, b.cy), cz: sub(a.cz, b.cz) };
}

/** Solid-box rotational inertia about the box's own center (chassis-aligned axes). For full dims
 * 2*half: Ixx = m/12*((2hy)^2+(2hz)^2) = m/3*(hy^2+hz^2), cyclically. */
export function boxInertiaAboutCenter(massKg: number, half: V3): Inertia3 {
	const ixx = (massKg / 3) * (half.y * half.y + half.z * half.z);
	const iyy = (massKg / 3) * (half.x * half.x + half.z * half.z);
	const izz = (massKg / 3) * (half.x * half.x + half.y * half.y);
	return { cx: { x: ixx, y: 0, z: 0 }, cy: { x: 0, y: iyy, z: 0 }, cz: { x: 0, y: 0, z: izz } };
}

/** Parallel-axis tensor m*((d.d)I - d(x)d) for a mass m displaced by d from the reference point. */
export function parallelAxisTensor(massKg: number, d: V3): Inertia3 {
	const dd = dot(d, d);
	return {
		cx: { x: massKg * (dd - d.x * d.x), y: -massKg * d.x * d.y, z: -massKg * d.x * d.z },
		cy: { x: -massKg * d.y * d.x, y: massKg * (dd - d.y * d.y), z: -massKg * d.y * d.z },
		cz: { x: -massKg * d.z * d.x, y: -massKg * d.z * d.y, z: massKg * (dd - d.z * d.z) },
	};
}

/** Combined mass/COM of a set of segment boxes (chassis-local). */
export function segmentCompositeMass(segments: readonly SegmentMassSpec[]): MassProps {
	let mass = 0;
	let mx = 0;
	let my = 0;
	let mz = 0;
	for (const s of segments) {
		mass += s.massKg;
		mx += s.massKg * s.center.x;
		my += s.massKg * s.center.y;
		mz += s.massKg * s.center.z;
	}
	return { mass, centroid: mass > 0 ? { x: mx / mass, y: my / mass, z: mz / mass } : { x: 0, y: 0, z: 0 } };
}

/**
 * Chassis MassData to stamp so the rigid composite (chassis + welded segments) reproduces `parity`
 * (the captured single-hull mass M0/COM C0/inertia I0). Deducts each segment's mass, recomputes the
 * chassis COM to hold the aggregate COM at C0, and subtracts every segment's box inertia + its
 * parallel-axis contribution (plus the chassis's own shift to C0) from I0. Throws if the segments
 * outweigh the parity mass (a sign the per-segment masses are mis-set).
 */
export function deductSegmentsFromParity(parity: ParityMassData, segments: readonly SegmentMassSpec[]): ParityMassData {
	const M0 = parity.mass;
	const C0 = parity.center;
	const sat = segmentCompositeMass(segments);
	const mCh = M0 - sat.mass;
	if (mCh <= 0) {
		throw new Error(`geometry.ts: deductSegmentsFromParity() would leave chassis mass ${mCh.toFixed(1)}kg <= 0 (segments total ${sat.mass}kg vs parity ${M0}kg)`);
	}
	// Chassis COM so that mCh*cCh + satMass*satCOM == M0*C0.
	const cCh: V3 = {
		x: (M0 * C0.x - sat.mass * sat.centroid.x) / mCh,
		y: (M0 * C0.y - sat.mass * sat.centroid.y) / mCh,
		z: (M0 * C0.z - sat.mass * sat.centroid.z) / mCh,
	};
	// I0(about C0) = I_ch(cCh) + PA(mCh, C0-cCh) + sum[ boxI(m_i) + PA(m_i, C0-c_i) ]
	//   => I_ch(cCh) = I0 - PA(mCh, C0-cCh) - sum[ boxI(m_i) + PA(m_i, C0-c_i) ].
	let inertia = subInertia(parity.inertia, parallelAxisTensor(mCh, sub(C0, cCh)));
	for (const s of segments) {
		inertia = subInertia(inertia, boxInertiaAboutCenter(s.massKg, s.half));
		inertia = subInertia(inertia, parallelAxisTensor(s.massKg, sub(C0, s.center)));
	}
	return { mass: mCh, center: cCh, inertia };
}

/** Recompose the full composite mass/COM/inertia (about `aboutPoint`) from a chassis remainder + its
 * welded segments -- the inverse check for deductSegmentsFromParity(), used by its unit test to prove
 * round-trip identity. */
export function composeSegmentsWithChassis(chassis: ParityMassData, segments: readonly SegmentMassSpec[], aboutPoint: V3): ParityMassData {
	const specs: SegmentMassSpec[] = [{ center: chassis.center, half: { x: 0, y: 0, z: 0 }, massKg: chassis.mass }, ...segments];
	const total = segmentCompositeMass(specs);
	let inertia = addInertia(chassis.inertia, parallelAxisTensor(chassis.mass, sub(aboutPoint, chassis.center)));
	for (const s of segments) {
		inertia = addInertia(inertia, boxInertiaAboutCenter(s.massKg, s.half));
		inertia = addInertia(inertia, parallelAxisTensor(s.massKg, sub(aboutPoint, s.center)));
	}
	return { mass: total.mass, center: total.centroid, inertia };
}

/**
 * Numeric (Riemann-sum) volume + centroid of the bevelled-box hull described above, at a given
 * density. The hull is a "prismatoid" (parallel rectangular cross sections lofted linearly between
 * bottom and top), so a fine slice count converges essentially exactly. This is a JS-side ESTIMATE
 * used only to pick tuning constants (ballast density/position) that plausibly hit the spec's
 * "~0.25m below geometric center" COM target -- box3d itself computes the ACTUAL mass/inertia of the
 * hull shape internally (via its own convex-hull mass integrator), and that is what really drives
 * the simulation. Nothing in the box3d-js binding exposes a way to read the engine's own computed
 * center of mass back out (no getCenterOfMass / getLocalCenter shim function), so this estimate
 * cannot be cross-checked against the engine -- see tuning.ts's COM_LOWER_OFFSET_M comment for the
 * full explanation of that binding gap.
 */
export function hullMassProperties(density: number, slices = 2000): MassProps {
	const by = HULL_BOTTOM_Y_M;
	const ty = HULL_TOP_Y_M;
	const h = ty - by;
	const bw = HULL_BOTTOM_HALF_WIDTH_M * 2;
	const bl = HULL_BOTTOM_HALF_LENGTH_M * 2;
	const tw = HULL_TOP_HALF_WIDTH_M * 2;
	const tl = HULL_TOP_HALF_LENGTH_M * 2;
	const tz = HULL_TOP_CENTER_Z_M;
	const z0 = 0; // bottom face z-center (footprint centered at chassis x=0,z=0)

	let volume = 0;
	let momentY = 0;
	let momentZ = 0;

	for (let i = 0; i < slices; i++) {
		const t = (i + 0.5) / slices;
		const y = by + t * h;
		const width = bw + (tw - bw) * t;
		const lengthAtT = bl + (tl - bl) * t;
		const zCenter = z0 + (tz - z0) * t;
		const area = width * lengthAtT;
		const dV = area * (h / slices);
		volume += dV;
		momentY += y * dV;
		momentZ += zCenter * dV;
	}

	const mass = volume * density;
	return {
		mass,
		centroid: { x: 0, y: volume > 0 ? momentY / volume : 0, z: volume > 0 ? momentZ / volume : 0 },
	};
}

/** Exact mass/centroid of the ballast sphere primitive (see tuning.ts's BALLAST_* constants). */
export function ballastMassProperties(density: number): MassProps {
	const volume = (4 / 3) * Math.PI * BALLAST_RADIUS_M ** 3;
	return { mass: volume * density, centroid: { x: 0, y: BALLAST_LOCAL_Y_M, z: 0 } };
}

/** Combine two mass properties into a composite mass-weighted centroid (standard parallel-mass rule). */
export function combineMassProperties(a: MassProps, b: MassProps): MassProps {
	const mass = a.mass + b.mass;
	if (mass <= 0) return { mass: 0, centroid: { x: 0, y: 0, z: 0 } };
	return {
		mass,
		centroid: {
			x: (a.centroid.x * a.mass + b.centroid.x * b.mass) / mass,
			y: (a.centroid.y * a.mass + b.centroid.y * b.mass) / mass,
			z: (a.centroid.z * a.mass + b.centroid.z * b.mass) / mass,
		},
	};
}

/** Volumetric centroid of the bare hull alone (density-independent), used as the "geometric center"
 * reference point the spec's COM_LOWER_OFFSET_M is measured from. */
export function hullGeometricCenterY(): number {
	return hullMassProperties(1).centroid.y;
}

export interface ChassisDensitySolution {
	hullDensity: number;
	ballastDensity: number;
	hullMass: number;
	ballastMass: number;
	geometricCenterY: number;
	targetCentroidY: number;
}

/**
 * Solves for (hullDensity, ballastDensity) such that:
 *   1) hullMass + ballastMass == CHASSIS_MASS_KG
 *   2) the composite centroid Y == the hull's own geometric center Y minus COM_LOWER_OFFSET_M
 * Both mass and centroid are LINEAR in density for a single homogeneous shape, so this is a plain
 * 2x2 linear solve (see the derivation this function implements): with Vh/Ch the hull's per-unit-
 * density volume/centroid and Vb/Cb the ballast's, and M/Ct the target mass/centroid,
 *   ballastMass = M * (Ct - Ch) / (Cb - Ch)
 *   hullMass    = M - ballastMass
 * Throws if the solution would require a negative mass (i.e. the ballast position/size can't pull
 * the centroid down far enough, or pulls it down too far) -- a sign the tuning constants need
 * adjusting, not a runtime condition to silently tolerate.
 */
export function solveChassisDensities(): ChassisDensitySolution {
	const hullUnit = hullMassProperties(1);
	const ballastUnit = ballastMassProperties(1);
	const Ch = hullUnit.centroid.y;
	const Cb = BALLAST_LOCAL_Y_M;
	const M = CHASSIS_MASS_KG;
	const Ct = Ch - COM_LOWER_OFFSET_M;

	const ballastMass = (M * (Ct - Ch)) / (Cb - Ch);
	const hullMass = M - ballastMass;

	if (ballastMass <= 0 || hullMass <= 0) {
		throw new Error(
			`geometry.ts: solveChassisDensities() produced a non-physical mass split ` +
				`(hullMass=${hullMass.toFixed(1)}, ballastMass=${ballastMass.toFixed(1)}) -- ` +
				`adjust BALLAST_LOCAL_Y_M/BALLAST_HALF_EXTENTS_M or COM_LOWER_OFFSET_M in tuning.ts.`,
		);
	}

	return {
		hullDensity: hullMass / hullUnit.mass,
		ballastDensity: ballastMass / ballastUnit.mass,
		hullMass,
		ballastMass,
		geometricCenterY: Ch,
		targetCentroidY: Ct,
	};
}
