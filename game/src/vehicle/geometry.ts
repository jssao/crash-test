// SPDX-License-Identifier: MIT
//
// Chassis hull-point generation + a from-scratch mass/centroid estimator for the tuning workaround
// described in tuning.ts's COM_LOWER_OFFSET_M doc comment. No three/DOM import (physics core).

import type { V3 } from './mathUtil';
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
