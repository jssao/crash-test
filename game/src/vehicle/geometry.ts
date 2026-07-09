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
