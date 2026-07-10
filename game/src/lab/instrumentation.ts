// SPDX-License-Identifier: MIT
//
// Crash Lab instrumentation: reads (never mutates) the damage system's CrumpleRegistry + the
// occupants feature's own hooks to compute the readout panel's numbers. No three/DOM import.
//
// CRUSH-DEPTH PROBE: the existing sim harness's crushDepth() (game/sim/crash-realism-harness.mjs)
// only works because its synthetic 'chassis-front' grid-plane mesh id is known ahead of time -- the
// REAL browser registration (game/src/scene/carDeformables.ts) auto-generates ids per GLB mesh node
// (`chassis-${mesh.name}-${n}`), so there's no single fixed id to look up here. Reimplemented as a
// REGIONAL probe instead: same technique (max signed accumulated displacement along the locally-
// relevant chassis axis, over every registered 'chassis'-kind mesh vertex whose BASE position falls in
// that region), generalized to work over however many real shell meshes got registered, in whichever
// order. Reads only the already-public DeformableMeshHandle fields (basePositions/offsets/dentedFlags)
// every other consumer of the crumple registry (crash-realism-harness.mjs, damage/system.ts itself)
// already reads the same way -- no game/src/damage/** file is touched.

import type { DamageSystem } from '../damage/system';
import type { CrushRegion } from './protocols';

const REGION_MIN_EXTENT_M = 0.3; // ignore near-centerline/near-midship vertices (ambiguous region)

function inRegion(region: CrushRegion, bx: number, bz: number): boolean {
	switch (region) {
		case 'front':
			return bz > REGION_MIN_EXTENT_M;
		case 'rear':
			return bz < -REGION_MIN_EXTENT_M;
		case 'left':
			return bx < -REGION_MIN_EXTENT_M;
		case 'right':
			return bx > REGION_MIN_EXTENT_M;
	}
}

/** Index (0=x, 2=z) of the axis + sign such that a positive result means "displaced further INTO the
 * car" for that region -- e.g. front vertices (base z>0) cave inward along -z; rear vertices (base
 * z<0) cave inward along +z; see damage/crumple.ts's applyImpactToMesh() doc comment for the sign
 * convention this mirrors ("-Z is rearward/into the car" for a frontal hit). */
const AXIS_INDEX: Record<CrushRegion, 0 | 2> = { front: 2, rear: 2, left: 0, right: 0 };
const AXIS_SIGN: Record<CrushRegion, 1 | -1> = { front: -1, rear: 1, left: 1, right: -1 };

export interface CrushMeasurement {
	/** Max inward displacement (meters) of any vertex in this region -- the lab's "crush depth". */
	depthM: number;
	/** Count of vertices in this region that ever crossed the dent epsilon (see damage-tuning.ts's
	 * CRUMPLE_DENT_EPSILON_M) -- a discretisation-robust "how much of the region actually creased". */
	dentedCount: number;
}

/** Measures crush for one region over every registered 'chassis'-kind deformable mesh (the shell —
 * panels/glass are excluded, matching the sim harness's own chassis-front-only convention). */
export function measureCrush(system: DamageSystem, region: CrushRegion): CrushMeasurement {
	const axis = AXIS_INDEX[region];
	const sign = AXIS_SIGN[region];
	let depthM = 0;
	let dentedCount = 0;
	for (const mesh of system.registry.meshes) {
		if (mesh.kind !== 'chassis') continue;
		for (let v = 0; v < mesh.vertexCount; v++) {
			const bx = mesh.basePositions[v * 3];
			const bz = mesh.basePositions[v * 3 + 2];
			if (!inRegion(region, bx, bz)) continue;
			const inward = sign * mesh.offsets[v * 3 + axis];
			if (inward > depthM) depthM = inward;
			if (mesh.dentedFlags[v]) dentedCount++;
		}
	}
	return { depthM, dentedCount };
}

export const CRUSH_REGIONS: readonly CrushRegion[] = ['front', 'rear', 'left', 'right'];

export function measureAllCrush(system: DamageSystem): Record<CrushRegion, CrushMeasurement> {
	const out = {} as Record<CrushRegion, CrushMeasurement>;
	for (const region of CRUSH_REGIONS) out[region] = measureCrush(system, region);
	return out;
}

// ---------------------------------------------------------------------------------------------
// Chassis peak deceleration (g) -- a simple running-max of |dv/dt| / g, sampled once per fixed step
// from the chassis's own linear velocity (no damage-system coupling needed).
// ---------------------------------------------------------------------------------------------

const GRAVITY_G_UNIT = 9.81;

export interface ChassisDecelTracker {
	peakG: number;
	prevVel: { x: number; y: number; z: number } | null;
}

export function createChassisDecelTracker(): ChassisDecelTracker {
	return { peakG: 0, prevVel: null };
}

export function resetChassisDecelTracker(t: ChassisDecelTracker): void {
	t.peakG = 0;
	t.prevVel = null;
}

export function sampleChassisDecel(t: ChassisDecelTracker, vel: { x: number; y: number; z: number }, dt: number): void {
	if (t.prevVel && dt > 0) {
		const dvx = vel.x - t.prevVel.x;
		const dvy = vel.y - t.prevVel.y;
		const dvz = vel.z - t.prevVel.z;
		const aG = Math.hypot(dvx, dvy, dvz) / dt / GRAVITY_G_UNIT;
		if (aG > t.peakG) t.peakG = aG;
	}
	t.prevVel = { x: vel.x, y: vel.y, z: vel.z };
}

// ---------------------------------------------------------------------------------------------
// Occupant summary -- thin reshaping of the occupants feature's own occupantStates() hook (that
// feature is owned by another worker this wave; this only reads its already-public hook return shape,
// see world/features/occupants/index.ts's hooks.occupantStates doc comment).
// ---------------------------------------------------------------------------------------------

export interface OccupantStateLike {
	seatKey: string;
	alive: boolean;
	state: string;
	ejected: boolean;
	peakAccelG: number;
}

export interface OccupantSummary {
	seatKey: string;
	alive: boolean;
	ejected: boolean;
	state: string;
	peakAccelG: number;
}

export function summarizeOccupants(states: readonly OccupantStateLike[]): OccupantSummary[] {
	return states.map((s) => ({ seatKey: s.seatKey, alive: s.alive, ejected: s.ejected, state: s.state, peakAccelG: s.peakAccelG }));
}
