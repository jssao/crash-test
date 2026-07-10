// SPDX-License-Identifier: MIT
//
// Crash Lab protocol definitions: standardized NHTSA/IIHS-style test configurations, sourced against
// docs/build-log/specs/crash-deformation-reference.md (which itself cites the public IIHS/NHTSA
// protocol documents -- see that file's "Sources" section). Pure data (no three/DOM/physics import),
// consumed by src/lab/barriers.ts (rig geometry) and src/lab/main.ts (run flow + instrumentation).
//
// APPROXIMATIONS (declared plainly, per this task's brief -- "rigid ok, note it"):
//   - The IIHS moderate/small overlap protocols use a real DEFORMABLE barrier face in the actual test;
//     this lab approximates it as RIGID (same simplification the existing headless crash-realism
//     harness/tests already use -- see damage/scenario.ts's spawnTestWall + crash-realism-harness.mjs's
//     spawnOffsetWall). The moderate-overlap geometry (lateralOffsetM=1.55, barrierHalfWidthM=1.2)
//     is the EXACT, already-validated calibration from game/sim/crash-realism.test.mjs (proven to
//     concentrate crush on the struck corner while keeping both doors attached at 40/64/80 km/h) --
//     reused verbatim rather than re-derived. The small-overlap geometry is a new, hand-picked
//     approximation (no prior calibration exists for it in this codebase): a narrower barrier
//     (barrierHalfWidthM=0.75) positioned so its inner edge sits just inside the car's outer edge
//     (lateralOffsetM=1.235), i.e. it clips mostly OUTBOARD of the car's structure -- qualitatively
//     matching the real test's defining trait (missing the front frame rails), not a literal
//     percentage-of-width computation.
//   - The side MDB and rear-impact rigs are "guided trolleys": a heavy dynamic body with gravity
//     disabled, whose linear velocity (and zero angular velocity) is re-asserted every fixed step for
//     the whole run (src/lab/barriers.ts's GuidedTrolley) -- a rail-guided/powered sled never gets
//     knocked off its line by the crash reaction force, which is the real rig's whole point.
//   - The rigid pole side impact reuses the existing crash-realism-harness.mjs side-impact convention
//     (car given lateral velocity into a fixed obstacle at the flank) with a capsule shape standing in
//     for a real ~250mm-diameter pole.

export type BarrierKind = 'rigid-full' | 'rigid-offset' | 'rigid-pole' | 'mdb-trolley' | 'rear-trolley';

/** Which region of the car's shell the instrumentation panel should call out as "the" crush metric
 * for this protocol (src/lab/instrumentation.ts's measureCrush) -- the readout always shows all four
 * regions, this just picks which one gets the headline treatment. */
export type CrushRegion = 'front' | 'rear' | 'left' | 'right';

export interface CrashProtocol {
	id: string;
	label: string;
	/** One-line plain-English description shown in the protocol list. */
	summary: string;
	/** Source citation, echoed in the exported report. */
	reference: string;
	speedKmh: number;
	barrier: BarrierKind;
	/** 'rigid-offset' only: lateral offset (m) of the barrier's center from the car's centerline. */
	lateralOffsetM?: number;
	/** 'rigid-offset' only: half-width (m) of the offset barrier. */
	barrierHalfWidthM?: number;
	/** Struck side, for offset/pole/mdb rigs (which side of the car the rig sits on / approaches from). */
	side: 'left' | 'right';
	crushRegion: CrushRegion;
	/** 'mdb-trolley' / 'rear-trolley' only: guided-trolley mass (kg). */
	trolleyMassKg?: number;
	/** Meters of guided run-up before the rig geometry is reached (deterministic "spawn on a guide,
	 * coast to impact at a fixed closing speed" -- same convention as damage/scenario.ts's crashSetup:
	 * velocity is SET, not throttle-accelerated, so every run is bit-identical run to run). */
	approachDistanceM: number;
	/** True only for the one synthetic "Free configuration" entry -- main.ts reads live slider values
	 * (speed/offset/angle) instead of this object's own speedKmh/lateralOffsetM at run time. */
	isFreeConfig?: boolean;
}

// Mustang-65 half-width is ~0.97m (car-map.ts derived, see crash-realism.test.mjs's comments) -- the
// offset geometry below is calibrated against that, not re-derived here (avoids a physics/vehicle
// import into this pure-data file).
const CAR_HALF_WIDTH_M = 0.97;

export const PROTOCOLS: readonly CrashProtocol[] = [
	{
		id: 'nhtsa-frontal-56',
		label: 'NHTSA Full Frontal — 56 km/h',
		summary: 'Full-width rigid barrier, straight-on. NCAP full-frontal equivalent (35 mph).',
		reference: 'NHTSA NCAP full-frontal, 56 km/h (35 mph) rigid barrier, full width.',
		speedKmh: 56,
		barrier: 'rigid-full',
		side: 'right',
		crushRegion: 'front',
		approachDistanceM: 10,
	},
	{
		id: 'iihs-moderate-64',
		label: 'IIHS Moderate Overlap — 64 km/h (40%)',
		summary: '40% driver-side overlap into a barrier (rigid-approximated). Struck corner takes the crush.',
		reference: 'IIHS moderate overlap front, 64 km/h (40 mph), 40% overlap deformable barrier (rigid here).',
		speedKmh: 64,
		barrier: 'rigid-offset',
		lateralOffsetM: 1.55,
		barrierHalfWidthM: 1.2,
		side: 'right',
		crushRegion: 'front',
		approachDistanceM: 10,
	},
	{
		id: 'iihs-small-64',
		label: 'IIHS Small Overlap — 64 km/h (25%)',
		summary: '25% overlap, outboard of the frame rails — the test that defeats traditional crush structures.',
		reference: 'IIHS small overlap front, 64 km/h (40 mph), 25% overlap rigid barrier.',
		speedKmh: 64,
		barrier: 'rigid-offset',
		lateralOffsetM: CAR_HALF_WIDTH_M + 0.265, // inner edge ~ CAR_HALF_WIDTH_M - 0.25*(2*CAR_HALF_WIDTH_M)
		barrierHalfWidthM: 0.75,
		side: 'right',
		crushRegion: 'front',
		approachDistanceM: 10,
	},
	{
		id: 'side-mdb-50',
		label: 'Side MDB — 50 km/h',
		summary: 'Guided 1500 kg trolley strikes the near-side door at an angle-free 50 km/h.',
		reference: 'NHTSA/IIHS side MDB, ~50 km/h moving deformable barrier into the driver door (approximated rigid, guided).',
		speedKmh: 50,
		barrier: 'mdb-trolley',
		trolleyMassKg: 1500,
		side: 'right',
		crushRegion: 'right',
		approachDistanceM: 6,
	},
	{
		id: 'side-pole-32',
		label: 'Rigid Pole Side — 32 km/h',
		summary: 'Car launched sideways into a fixed rigid pole at the B-pillar/door.',
		reference: 'NHTSA oblique pole side impact, ~32 km/h (20 mph), rigid pole.',
		speedKmh: 32,
		barrier: 'rigid-pole',
		side: 'right',
		crushRegion: 'right',
		approachDistanceM: 6,
	},
	{
		id: 'rear-80',
		label: 'Rear Impact — 80 km/h (trolley)',
		summary: 'Guided trolley strikes the stationary car from behind at 80 km/h.',
		reference: 'FMVSS-301-style rear moving-barrier impact, high-severity 80 km/h case.',
		speedKmh: 80,
		barrier: 'rear-trolley',
		trolleyMassKg: 1500,
		side: 'right',
		crushRegion: 'rear',
		approachDistanceM: 8,
	},
	{
		id: 'free',
		label: 'Free Configuration',
		summary: 'Speed, lateral offset and approach angle all under your control.',
		reference: 'Free-config (no fixed real-world protocol) — for exploring the model outside the standardized bands.',
		speedKmh: 56,
		barrier: 'rigid-offset',
		lateralOffsetM: 0,
		barrierHalfWidthM: 4, // wide: offset=0 reads as an effectively-full-width wall
		side: 'right',
		crushRegion: 'front',
		approachDistanceM: 10,
		isFreeConfig: true,
	},
];

export function findProtocol(id: string): CrashProtocol {
	const p = PROTOCOLS.find((x) => x.id === id);
	if (!p) throw new Error(`[crash-lab] unknown protocol id "${id}"`);
	return p;
}

/** Free-config's live slider state -- speed always applies; offset/angle only matter for the 'free'
 * protocol id (every other protocol's geometry is fixed by its own PROTOCOLS entry above). */
export interface FreeConfigState {
	speedKmh: number;
	/** Lateral barrier offset, meters, signed (+ = toward the protocol's `side`). */
	offsetM: number;
	/** Approach angle, degrees, rotates the car's launch velocity about world-up from straight-ahead. */
	angleDeg: number;
}

export const FREE_CONFIG_DEFAULT: FreeConfigState = { speedKmh: 56, offsetM: 0, angleDeg: 0 };
export const FREE_CONFIG_SPEED_RANGE: readonly [number, number] = [20, 160];
export const FREE_CONFIG_OFFSET_RANGE: readonly [number, number] = [-2, 2];
export const FREE_CONFIG_ANGLE_RANGE: readonly [number, number] = [-45, 45];
