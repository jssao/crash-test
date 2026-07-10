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

/** Front cabin wall Z (chassis-local): rear face of the solid nose / engine-bay volume. */
const FIREWALL_Z_M = 0.7;
/** Rear cabin wall Z: front face of the solid tail / trunk volume. */
const BULKHEAD_Z_M = -0.64;
/** Top of the sills / bottom of the window aperture (chassis-local Y). */
const BELTLINE_Y_M = 0.52;
/** Top face Y of the floorpan slab (thin: HULL_BOTTOM_Y_M .. this). */
const FLOORPAN_TOP_Y_M = 0.06;
/** Bottom of the roof panel / top of the window aperture (chassis-local Y). */
const CANTRAIL_Y_M = 0.85;
/** Inboard X face of the sills (cabin floor half-width kept clear inboard of this). */
const SILL_INNER_X_M = 0.7;

/** Top-face front/rear Z edges of the bevelled envelope (roofline), from the hull tuning. */
const TOP_FRONT_Z_M = HULL_TOP_CENTER_Z_M + HULL_TOP_HALF_LENGTH_M;
const TOP_REAR_Z_M = HULL_TOP_CENTER_Z_M - HULL_TOP_HALF_LENGTH_M;

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
	const bhl = HULL_BOTTOM_HALF_LENGTH_M;
	const thw = HULL_TOP_HALF_WIDTH_M;
	const belt = BELTLINE_Y_M;
	const sw = envHalfWidth(belt); // envelope half-width at the beltline (top of the sills)

	const shapes: CabinShapeDef[] = [];

	// 1. Floorpan: thin bottom slab spanning the CABIN only. The nose and tail are solid down to the
	//    footprint bottom over their own z-ranges, so together the three abutting slabs reconstruct the
	//    full flat BOTTOM face (ground clearance) with NO overlap into the crush zones -- an overlapping
	//    floorpan would double-fire hit events with the nose on a frontal wall hit and inflate the dent.
	shapes.push({ name: 'floorpan', points: boxPoints(-bhw, bhw, by, FLOORPAN_TOP_Y_M, BULKHEAD_Z_M, FIREWALL_Z_M) });

	// 2. Nose crush volume (solid): front face = the old hull's EXACT 4 front vertices (bevel preserved),
	//    swept back to the firewall. This is the face every frontal crash test contacts.
	// prettier-ignore
	shapes.push({ name: 'nose', points: new Float32Array([
		-bhw, by, bhl,   bhw, by, bhl,                         // front-bottom (full width, footprint front)
		-thw, ty, TOP_FRONT_Z_M,  thw, ty, TOP_FRONT_Z_M,      // front-top (roofline front, set back = bevel)
		-bhw, by, FIREWALL_Z_M,   bhw, by, FIREWALL_Z_M,       // back-bottom at the firewall
		-thw, ty, FIREWALL_Z_M,   thw, ty, FIREWALL_Z_M,       // back-top at the firewall
	]) });

	// 3. Tail crush volume (solid): rear face = the old hull's EXACT 4 rear vertices, swept to the bulkhead.
	// prettier-ignore
	shapes.push({ name: 'tail', points: new Float32Array([
		-bhw, by, -bhl,  bhw, by, -bhl,                        // rear-bottom (footprint rear)
		-thw, ty, TOP_REAR_Z_M,   thw, ty, TOP_REAR_Z_M,       // rear-top (roofline rear)
		-bhw, by, BULKHEAD_Z_M,   bhw, by, BULKHEAD_Z_M,       // front-bottom at the bulkhead
		-thw, ty, BULKHEAD_Z_M,   thw, ty, BULKHEAD_Z_M,       // front-top at the bulkhead
	]) });

	// 4. Roof panel: thin top slab over the cabin greenhouse -- reproduces the TOP face for the cabin gap
	//    (nose/tail already cover the top outside [BULKHEAD_Z, FIREWALL_Z]; small overlap avoids a seam).
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
		B: [-0.09, 0.09], // mid cabin
		C: [BULKHEAD_Z_M, BULKHEAD_Z_M + 0.18], // rear
	};
	const px0 = 0.66;
	const px1 = 0.8;
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
 * forward of the glass line instead: bottom rail (0.42, 0.92), top rail (0.84, 1.00), thickness -z
 * (toward the cabin). Measured clearances: front head 0.41m, torso more, knees/thighs 0.10m below
 * the bottom rail -- ordinary bumps/braces never reach it, while a genuinely ejecting body crosses
 * the gap and strikes it at full fly-out speed. Outer rails stay >=0.02m inside the nose's front
 * bevel (bevel z at y 0.84 is 1.023). The escape slivers around the rails (roof front edge above,
 * a descending sub-rail path below) are all under a head's diameter for plausible trajectories.
 */
const WINDSHIELD_BOTTOM = { y: 0.42, z: 0.92 };
const WINDSHIELD_TOP = { y: 0.84, z: 1.0 };
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
 */
const REAR_WINDOW_TOP = { y: 0.95, z: -1.14 };
const REAR_WINDOW_BOTTOM = { y: BELTLINE_Y_M - 0.02, z: -1.52 };

/** Pane half-widths, tapered with the envelope loft so the slab never pokes out of the body side
 * (envelope half-width at the beltline ~0.85, at y 0.95 ~0.76). The A/C pillars (x 0.66..0.80)
 * overlap the windshield's edges, so no head-sized gap exists at the aperture corners. */
const WINDSHIELD_HALF_WIDTH_BOTTOM_M = 0.84;
const WINDSHIELD_HALF_WIDTH_TOP_M = 0.76;
const REAR_WINDOW_HALF_WIDTH_BOTTOM_M = 0.84;
const REAR_WINDOW_HALF_WIDTH_TOP_M = 0.74;

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
