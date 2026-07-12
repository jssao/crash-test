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
// Chassis peak deceleration (g) -- running-max of the chassis velocity delta over a TWO-fixed-step
// (33.3ms) sliding window, sampled once per fixed step from the chassis's own linear velocity.
//
// PHASE R ANTI-ALIASING FIX (2026-07-12). This metric was originally the raw single-step |dv|/dt --
// and that raw form is what produced the "91.7g at NHTSA-56" R3 debt. Root-caused by step-by-step
// CDP tracing of the lab NHTSA-56 run (scratchpad phase-r/exp1-guide.log + exp2-noocc.log):
//   - The physical stop is REAL and multi-step: the car crushes 0.46m of working structure over
//     steps 27-29 of the run (speed 15.385 -> 14.862 -> 1.548 -> ~1.2 m/s), i.e. ~42-47g AVERAGED
//     over the actual event -- squarely the NCAP-like pulse the reference asks for.
//   - But the solver concentrates most of that Dv (13.3 of 15.4 m/s) inside ONE 16.7ms fixed step,
//     and WHICH step-bin it lands in depends on where the barrier-vs-core continuous-collision TOI
//     falls WITHIN a step -- pure sampling phase. Measured phase sensitivity: the sim proxy reads
//     46.9g at CRUSH_CORE_INITIAL_RECESS_M=0.15 but 88.9g at 0.13 and 92.4g at 0.14 (a 1-2cm
//     geometry change flips the bin split); the Mustang-era blessed lab baseline "46.8g" is almost
//     exactly HALF the S90's 91.7g -- its contact TOI happened to land mid-step, splitting the same
//     kill across two sample bins. The S90's longer nose/approach geometry shifted the phase so the
//     kill lands in one bin. Two other candidate mechanisms were experimentally RULED OUT first:
//     the guided approach releases 6 full steps before first contact (speed trace shows ballistic
//     decay 15.556->15.385 pre-contact), and running the lab with the occupant feature disabled
//     (?noocc) moves the peak <1g (91.75 -> 90.83).
//   - A raw 60Hz single-sample derivative therefore ALIASES the pulse: it can read anywhere from
//     ~46 to ~92 for the IDENTICAL crash depending on centimeter-scale rig phase. Real crash-test
//     peak-g figures are never raw sample derivatives either -- SAE J211 mandates CFC filtering --
//     and a 60Hz-stepped sim cannot resolve pulse content above 30Hz (Nyquist) in the first place.
//
// FIX: measure |dv| over a 2-step (33.3ms) sliding window / (2*dt). Phase-robust by construction
// (ANY 2-step window contains the whole 1-2 step kill regardless of TOI phase: lab 91.7 -> ~42-43g,
// sim 46.9 -> ~46g -- both now read the same crash the same way), and honest against the reference
// band (the pulse's real duration is ~2 steps, so the window average IS the event's deceleration,
// not a smoothing-away of a longer event). The raw single-step reading is retained as peakG1Step
// for diagnostics -- it is deliberately NOT the headline metric.
// ---------------------------------------------------------------------------------------------

const GRAVITY_G_UNIT = 9.81;

export interface ChassisDecelTracker {
	/** Anti-aliased peak decel (g): max |dv| over any 2-fixed-step window / (2*dt). The headline
	 * readout (HUD + verify assertions). */
	peakG: number;
	/** Raw single-step peak (g) -- phase-aliased (see the section doc comment); diagnostic only. */
	peakG1Step: number;
	prevVel: { x: number; y: number; z: number } | null;
	prevPrevVel: { x: number; y: number; z: number } | null;
}

export function createChassisDecelTracker(): ChassisDecelTracker {
	return { peakG: 0, peakG1Step: 0, prevVel: null, prevPrevVel: null };
}

export function resetChassisDecelTracker(t: ChassisDecelTracker): void {
	t.peakG = 0;
	t.peakG1Step = 0;
	t.prevVel = null;
	t.prevPrevVel = null;
}

export function sampleChassisDecel(t: ChassisDecelTracker, vel: { x: number; y: number; z: number }, dt: number): void {
	if (t.prevVel && dt > 0) {
		const aG1 = Math.hypot(vel.x - t.prevVel.x, vel.y - t.prevVel.y, vel.z - t.prevVel.z) / dt / GRAVITY_G_UNIT;
		if (aG1 > t.peakG1Step) t.peakG1Step = aG1;
	}
	if (t.prevPrevVel && dt > 0) {
		const aG2 = Math.hypot(vel.x - t.prevPrevVel.x, vel.y - t.prevPrevVel.y, vel.z - t.prevPrevVel.z) / (2 * dt) / GRAVITY_G_UNIT;
		if (aG2 > t.peakG) t.peakG = aG2;
	}
	t.prevPrevVel = t.prevVel;
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
	/** Anti-aliased (2-step windowed) peak -- see active.ts's updateLifeDeath() doc comment. */
	peakAccelG: number;
	/** Raw single-step peak -- phase-aliased diagnostic only, optional for callers that predate it. */
	peakAccelG1Step?: number;
}

export interface OccupantSummary {
	seatKey: string;
	alive: boolean;
	ejected: boolean;
	state: string;
	peakAccelG: number;
	peakAccelG1Step?: number;
}

export function summarizeOccupants(states: readonly OccupantStateLike[]): OccupantSummary[] {
	return states.map((s) => ({
		seatKey: s.seatKey,
		alive: s.alive,
		ejected: s.ejected,
		state: s.state,
		peakAccelG: s.peakAccelG,
		peakAccelG1Step: s.peakAccelG1Step,
	}));
}
