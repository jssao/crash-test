// SPDX-License-Identifier: MIT
//
// 'buildings' WorldFeature tuning: material presets (mass/friction/weld-break thresholds) + structure
// layout. Renderer-free (no three/DOM import), same convention as world/tuning.ts.
//
// ZONE (COMPOUND overhaul): the buildings are PULLED IN to ring the compound yard (the terrain's flat
// APRON, world/terrain/heightfield.ts). All centres sit inside the yard's hard-flat interior (|x|<=~34,
// z in [24,44], which is h==0) so every piece spawned at y=0 seats on the ground, and each is still
// approached head-on from -Z (the crash tests drive +Z into it):
//   - SHED       NW corner of the yard, just west of the crate tower (crates read as "by the shed").
//   - HOUSE-CNR  NE corner of the yard.
//   - BRICK WALL a low garden-wall DIVIDER mid-yard, just south of the barrel triangle ("by the wall").
//   - FENCES     the north PERIMETER run facing the driveway, split by a central GATE gap (x in
//                [-8,8]) the driveway spur passes through (see heightfield.ts's DIRT_SPUR).
// The kicker lane (x=0) and the ramps (world/tuning.ts's RAMP_CONFIGS) are left clear.

import type { Q4, V3 } from '../../../vehicle/mathUtil';
import { IDENTITY_Q } from '../../../vehicle/mathUtil';

export { IDENTITY_Q };
export type { Q4, V3 };

// ---------------------------------------------------------------------------------------------
// Material presets: mass/friction + per-joint weld break thresholds (Newtons / Newton-meters).
// Car total mass ~1438kg (vehicle/tuning.ts's CHASSIS_MASS_KG + wheels) -- thresholds tuned so a
// ~50km/h hit punches straight through drywall, a ~70km/h hit visibly scatters >=15 bricks, and a
// ~40km/h hit breaks >=3 fence pieces free (see game/sim/features-buildings.test.mjs for the exact
// calibration runs).
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// DEBRIS SETTLE DAMPING (playtest issue #1: "debris keeps spinning/rolling ages after it should
// settle"). box3d's per-shape rollingResistance applies ONLY to spheres/capsules (types.h:407), so
// box/hull debris (bricks, planks, studs, drywall, blocks, crates, poles, barrel hulls) gets a
// game-side body-level angularDamping instead (BodyOptions.angularDamping -> b3DefaultBodyDef(),
// already wired through createBody()). Applied at SPAWN on every dynamic destructible: mild enough
// not to alter the crash's break dynamics (it only bleeds residual spin so pieces cross box3d's sleep
// threshold and thud to rest) yet firm enough that a freed brick/plank stops pirouetting within ~1-2s.
// Bricks/wood are "high" (masonry/lumber does not keep spinning), barrels/pipes "moderate" (a drum or
// a length of pipe legitimately rolls a little before stopping). LINEAR damping is kept tiny so the
// debris still FLIES on a hard hit -- only the eternal SPIN is what we kill. See tests/
// rolling-resistance.test.ts for the mechanism validation and game/sim/materials-truth*.test.mjs for
// the in-structure settle assertion.
// ---------------------------------------------------------------------------------------------
export const WOOD_ANGULAR_DAMPING = 1.3;
export const WOOD_LINEAR_DAMPING = 0.08;
export const DRYWALL_ANGULAR_DAMPING = 1.1;
export const DRYWALL_LINEAR_DAMPING = 0.1;
export const BRICK_ANGULAR_DAMPING = 1.7;
export const BRICK_LINEAR_DAMPING = 0.15;
/** Pipe is a CAPSULE, so it also gets true rolling resistance (spheres/capsules only) on top of a
 * moderate angular damping -- a length of galvanized pipe rings and rolls a bit, then stops. */
export const PIPE_ROLLING_RESISTANCE = 0.35;
export const PIPE_ANGULAR_DAMPING = 0.5;
export const PIPE_LINEAR_DAMPING = 0.05;
export const FENCE_ANGULAR_DAMPING = 1.2;
export const FENCE_LINEAR_DAMPING = 0.08;

// Softwood framing. Mass toward a kiln-dried density (~470 kg/m^3): a 2.2-2.4m 58mm-square stud is
// ~3.5kg. See docs/build-log/specs/materials-truth.md (a real 2x4 is 38x89mm; modelled as an
// equal-cross-sectional-area 58mm square to avoid a rectangular-stud refactor).
export const WOOD_STUD_MASS_KG = 3.5;
export const WOOD_PLANK_MASS_KG = 5; // ~19mm cladding board (kept moderate so the shed stays smashable)
export const WOOD_FRICTION = 0.7; // was 0.6 -- freed planks/studs clatter to rest instead of sliding forever
export const WOOD_RESTITUTION = 0.12; // wood clatters (a little bounce), not a dead thud
/** Studs/planks: low-medium weld strength -- a stud frame yields well before masonry. */
export const WOOD_BREAK_FORCE_N = 3500;
export const WOOD_BREAK_TORQUE_NM = 1800;

// Gypsum wallboard: 12.7mm (1/2") thick. A real 1.2x2.4m sheet is ~26kg (9 kg/m^2); kept lighter here
// (a gameplay call, same as the legacy wall blocks) so "the car punches through easily" stays true --
// documented in materials-truth.md. Half-thickness fixed from 24mm to the real 12.7mm.
export const DRYWALL_PANEL_MASS_KG = 12;
export const DRYWALL_FRICTION = 0.34; // was 0.4 -- lower so burst drywall sheets flutter-slide flat
export const DRYWALL_RESTITUTION = 0.0; // drywall doesn't bounce
/** Lowest threshold in the whole feature -- "the car punches through easily" per spec. Nudged up with
 * the heavier (truer) panel mass so panels still detach on a real hit without the car stalling. */
export const DRYWALL_BREAK_FORCE_N = 1100;
export const DRYWALL_BREAK_TORQUE_NM = 520;

// Real fired-clay brick: 194 x 92 x 57 mm, 2.7 kg (density ~2655 kg/m^3) -- see
// docs/build-log/specs/materials-truth.md. Was a 400 x 200 x 200 mm block at 2.6 kg, i.e. 162 kg/m^3
// (styrofoam!) -- the single largest truth deviation in the sandbox.
export const BRICK_MASS_KG = 2.7;
export const BRICK_FRICTION = 0.9; // was 0.75 -- bricks thud and tumble to rest quickly, not skate
export const BRICK_RESTITUTION = 0.0; // masonry does not bounce
/** Per-mortar-joint threshold between adjacent bricks. A real car impact exceeds it along a wide front
 * so many joints crack and bricks cascade free; away from the impact zone joints survive and 2-4
 * welded bricks tumble as a CLUMP (playtest issue #3: mortar cracks crisply in clumps, no global jelly
 * wobble). P005 bug fix (re-tuned for the taller BRICK_WALL_ROWS wall, game/sim/features-buildings.test.mjs
 * calibration): LOWERED from 3200/650. Counter-intuitive but empirically verified -- the taller wall's
 * upper courses are only tied together by the SAME-ROW horizontal mortar chain, which (given box3d's
 * weld joints solve the "rigid" case via a finite ~60Hz/dampingRatio-2 default constraint stiffness --
 * see vendor/box3d/src/joint.c's b3PrepareJoint()/constraintHertz, NOT exposed for override by this
 * repo's src/ts binding -- confirmed insensitive to raising these same thresholds 100x, so it is NOT a
 * break-threshold problem) behaves as one loosely-compliant continuous "cap" under a hard hit: without
 * a LOWER mortar threshold letting a crack open a few bricks out from the impact, that cap's sway drags
 * even far-away columns down with it. A lower threshold lets a local crack form sooner, isolating the
 * disturbed cap section mechanically -- verified (probe sweep) to raise the >=2m-lateral "still
 * standing" count from ~4/90 to ~12-15/90 bricks at 40-50km/h. Full containment is NOT achievable via
 * this feature's constants alone -- see this task's report for the root-cause writeup. */
export const BRICK_BREAK_FORCE_N = 1500;
export const BRICK_BREAK_TORQUE_NM = 300;
/** Bottom-course brick-to-FOOTING welds are much stronger than brick-to-brick mortar. A thin
 * single-wythe wall would otherwise just tip over as one rigid slab at any speed (the base is its only
 * anchor); a strong base means a low-speed hit instead cracks the inter-brick joints LOCALLY near the
 * impact (a chunk sheds, the rest stands), and only a hard hit overwhelms the base and takes the whole
 * wall. This is what restores the low/mid/high staging with real (small, light) bricks. RAISED from
 * 11000/2600 (P005) to keep the taller wall's base anchor comfortably strong relative to its greater
 * dead-weight/leverage. */
export const BRICK_FOOTING_BREAK_FORCE_N = 30000;
export const BRICK_FOOTING_BREAK_TORQUE_NM = 7000;

export const PIPE_MASS_KG = 4;
export const PIPE_FRICTION = 0.3;
export const PIPE_RESTITUTION = 0.28; // galvanized pipe rings and rolls
export const PIPE_RADIUS_M = 0.05;
export const PIPE_HALF_LENGTH_M = 0.55; // 1.1m pipe segments

export const FENCE_MASS_KG = 2.5;
export const FENCE_FRICTION = 0.6; // was 0.5 (posts/rails are 'wood' material -> WOOD_RESTITUTION)
/** Low thresholds -- fences are meant to break away easily. */
export const FENCE_BREAK_FORCE_N = 700;
export const FENCE_BREAK_TORQUE_NM = 350;

// ---------------------------------------------------------------------------------------------
// PLASTIC-YIELD PROFILES (destruction-feel: bend-then-break). Generalizes damage/welds.ts's panel
// LOOSEN->BREAK escalation to structures: a weld under over-YIELD (but under-BREAK) load softens IN
// PLACE (runtime hertz/damping setters, exactly like loosenPanelWeld()) so the piece visibly leans/
// bulges/creases and BLEEDS impact energy, instead of every weld snapping rigid->free in one step.
// This is what interrupts the brick-wall cascade at low speed (a slow nudge now bulges/slumps a few
// courses instead of vaporizing all 120 bricks) while a fast hit still spikes past BREAK on the first
// contact step and sprays. See structures.ts's pollStructureBreaks() for the state machine.
//
// - yieldForceFrac/yieldTorqueFrac: onset of plastic yield, as a fraction of the piece's BREAK
//   threshold. Below this the weld is rigid (hertz 0).
// - yield{Linear,Angular}Hertz + yieldDampingRatio: the softened spring once yielded. Lower Hz = the
//   piece leans/sags further before load re-balances.
// - ductileBreakMult: from the yielded (bent) stage the weld only fully separates once force exceeds
//   BREAK * this. 1 = brittle (masonry/drywall: yields a touch then sprays). >1 = ductile (studs/
//   posts: crease and lean, stay attached unless hit HARD again -- "permanently bent").
// - breakSpeedCapMs/breakSpinCapRad: at the instant a weld breaks, the freed piece's velocity is
//   clamped to these (impulse-proportional release) so debris thuds/tumbles instead of rocketing
//   tens of metres (baseline had single bricks flung 77m). Generous enough to still read as a spray.
// ---------------------------------------------------------------------------------------------

export interface YieldProfile {
	readonly yieldForceFrac: number;
	readonly yieldTorqueFrac: number;
	readonly yieldLinearHertz: number;
	readonly yieldAngularHertz: number;
	readonly yieldDampingRatio: number;
	readonly ductileBreakMult: number;
	readonly breakSpeedCapMs: number;
	readonly breakSpinCapRad: number;
	/** When true the weld NEVER enters the soft plastic-yield stage -- it stays fully rigid until it
	 * cracks (break-only). This is what mortar joints do: they crack crisply, they do not wobble. Set
	 * for masonry so the brick wall no longer moves as one compliant jelly blob (playtest issue #3);
	 * ductile materials (studs/posts) leave this false and keep the lean-then-break yield model. */
	readonly breakOnly?: boolean;
}

/** Masonry: BRITTLE and break-ONLY. A mortar joint is rigid until it cracks, then it's gone -- no soft
 * intermediate stage, so the wall never wobbles as a jelly blob. Low-speed hits crack a handful of
 * joints locally (a chunk breaks off); high-speed hits crack many (a spray). Staging is carried by HOW
 * MANY joints crack, not by wobble (playtest issue #3). Cap keeps the spray from rocketing. */
export const BRICK_PROFILE: YieldProfile = {
	yieldForceFrac: 1.0, // unused (breakOnly) -- kept for the shared shape
	yieldTorqueFrac: 1.0,
	yieldLinearHertz: 0,
	yieldAngularHertz: 0,
	yieldDampingRatio: 1.0,
	ductileBreakMult: 1.0,
	breakSpeedCapMs: 6.0,
	breakSpinCapRad: 14,
	breakOnly: true,
};

/** Drywall: near-brittle (punches through easily, per spec) -- barely softens before bursting. */
export const DRYWALL_PROFILE: YieldProfile = {
	yieldForceFrac: 0.75,
	yieldTorqueFrac: 0.75,
	yieldLinearHertz: 8,
	yieldAngularHertz: 6,
	yieldDampingRatio: 0.4,
	ductileBreakMult: 1.0,
	breakSpeedCapMs: 12,
	breakSpinCapRad: 24,
};

/** Wood stud/plank frame: DUCTILE -- creases and leans under load and stays attached (studs bow at the
 * base, planks hang askew) unless a much harder hit finally snaps them free. */
export const WOOD_STUD_PROFILE: YieldProfile = {
	yieldForceFrac: 0.35,
	yieldTorqueFrac: 0.35,
	yieldLinearHertz: 5,
	yieldAngularHertz: 3.5,
	yieldDampingRatio: 0.5,
	ductileBreakMult: 2.4,
	breakSpeedCapMs: 10,
	breakSpinCapRad: 18,
};

/** Light roof panel: brittle-ish, snaps off on a real hit but sags first. */
export const ROOF_PROFILE: YieldProfile = {
	yieldForceFrac: 0.5,
	yieldTorqueFrac: 0.5,
	yieldLinearHertz: 7,
	yieldAngularHertz: 5,
	yieldDampingRatio: 0.45,
	ductileBreakMult: 1.15,
	breakSpeedCapMs: 12,
	breakSpinCapRad: 22,
};

/** Fence: leans at the base first, then breaks away readily (fences are meant to give way). */
export const FENCE_PROFILE: YieldProfile = {
	yieldForceFrac: 0.45,
	yieldTorqueFrac: 0.45,
	yieldLinearHertz: 6,
	yieldAngularHertz: 4,
	yieldDampingRatio: 0.5,
	ductileBreakMult: 1.25,
	breakSpeedCapMs: 11,
	breakSpinCapRad: 20,
};

// ---------------------------------------------------------------------------------------------
// 1) Garden shed -- wood stud frame + plank walls + light roof panels.
// ---------------------------------------------------------------------------------------------

export const SHED_CENTER: V3 = { x: -30, y: 0, z: 34 };
export const SHED_WIDTH_M = 3.6; // along X
export const SHED_DEPTH_M = 3.0; // along Z
export const SHED_WALL_HEIGHT_M = 2.2;
export const SHED_STUD_SPACING_M = 0.9;
export const SHED_STUD_HALF_CROSS_M = 0.029; // 58mm square = a real 2x4's cross-sectional area (38x89mm)
export const SHED_PLANK_THICKNESS_HALF_M = 0.0095; // 19mm cladding board (was 40mm)
export const SHED_ROOF_HEIGHT_M = 1.0; // ridge rise above the wall top
export const SHED_ROOF_PANEL_SPLITS = 3; // panels per roof slope

// ---------------------------------------------------------------------------------------------
// 2) House corner -- 2 framed wall segments (wood studs + drywall both sides) meeting at a right
// angle, with 2-3 vertical pipes standing free in the cavity (unwelded -- they scatter physically
// once the drywall bursts, no weld release needed).
// ---------------------------------------------------------------------------------------------

export const CORNER_POINT: V3 = { x: 34, y: 0, z: 40 };
export const CORNER_SEGMENT_LENGTH_M = 4;
export const CORNER_WALL_HEIGHT_M = 2.4;
export const CORNER_STUD_SPACING_M = 0.6;
export const CORNER_STUD_HALF_CROSS_M = 0.029; // 58mm square = a real 2x4's cross-section area (38x89mm)
export const CORNER_DRYWALL_HALF_THICKNESS_M = 0.00635; // real 12.7mm (1/2") board (was 24mm)
export const CORNER_DRYWALL_SHEET_WIDTH_M = 1.2;
export const CORNER_PIPE_COUNT = 3;

// ---------------------------------------------------------------------------------------------
// 3) Free-standing brick wall -- ~120 bricks in running-bond pattern, weld lattice brick-to-brick
// (vertical, running-bond overlap) + brick-to-footing (bottom row), high per-joint threshold.
// ---------------------------------------------------------------------------------------------

export const BRICK_WALL_CENTER: V3 = { x: 16, y: 0, z: 24 };
// Real brick 194 x 92 x 57 mm (laid flat: 194 length along the wall X, 57 course height Y, 92 depth
// through the wall Z -- single-wythe). A full 6m x 1.6m masonry wall of these is ~850 bricks (past the
// physics/perf budget). P005 bug fix: the previous 10 cols x 16 courses (160 bricks, ~1.94m long x
// 0.91m tall) read as a trivial garden divider in the crash-lab/gameplay target -- the reference photos
// (a car punching a car-shaped hole through a real chest/head-height property wall, with far sections
// still standing) need real wall proportions. Bumped to 16 cols x 30 courses = 480 bricks, ~3.10m long
// x 1.71m tall -- 3x the previous piece/joint count (well under the documented 850-brick "past budget"
// case for a full 6m wall) and long enough that an off-center impact still leaves a far corner
// >=2m from the impact point (game/sim/features-buildings.test.mjs's dedicated P005 assertion). See
// docs/build-log/specs/materials-truth.md for the size trade-off rationale.
export const BRICK_HALF_EXTENTS: V3 = { x: 0.097, y: 0.0285, z: 0.046 };
export const BRICK_WALL_COLUMNS = 16; // 16 * 0.194m = 3.104m long (was 10 / 1.94m)
export const BRICK_WALL_ROWS = 30; // 30 * 0.057m = 1.71m tall (was 16 / 0.912m)
export const BRICK_WALL_LENGTH_M = BRICK_WALL_COLUMNS * BRICK_HALF_EXTENTS.x * 2; // 3.104m, keeps footing/columns consistent

// ---------------------------------------------------------------------------------------------
// CRASH-LAB WIDE brick wall (P005 gate fix). The BRICK_WALL above is a narrow ~3.1m garden divider
// — barely wider than the car, so a localized hole is structurally impossible and a hit takes the
// WHOLE panel (the gate's core finding: "~0% remains upright"). The crash-lab "brick wall" target is
// instead a REAL ~8.2m x 1.71m property wall so a centre hit leaves large flanking sections standing,
// exactly like the reference photos (car buried in a car-shaped breach, wall standing on both sides).
//
// It is built as N SEGMENTS: each is an INDEPENDENTLY-FOOTED brick panel separated from its neighbours
// by a ~4cm expansion joint that NO weld crosses. This is STRUCTURAL isolation, not mortar re-tuning —
// and that is deliberate: box3d's weld joints solve the rigid case at a finite ~60Hz constraint
// stiffness this repo's binding can't override (see BRICK_BREAK_FORCE_N's doc), so a single tall
// continuous lattice sways as one loosely-compliant cap and drags far columns down under a hard hit no
// matter how the break thresholds are set (verified insensitive to raising them 100x). Separate footed
// panels simply cannot transmit the struck panel's collapse across the gap, so the flanking panels STAY
// UP — the support-graph union-find (support.ts) sees them as distinct anchored components and never
// wakes them. Panels keep the gameplay BRICK_BREAK mortar strength (isolation is geometric, not a
// weakening); an early probe sweep confirmed that WEAKENING inter-brick welds actually HURT here (a
// disturbed flanking panel then crumbles instead of shrugging off the struck panel's debris) — the
// opposite of the continuous-wall finding, because segmentation already supplies the crack isolation.
// The ~4cm joint (vs a hairline 2cm) is what keeps the struck panel's debris from jamming the flanking
// panel's inner edge and cascading it: probe-measured centre-hit flanking far-standing was 0.55 at a
// 2cm joint but 1.00 at 4cm. Panels use BOUNDED running bond (odd rows inset half a brick on each end,
// no overhang) so the thin joint stays collision-free — unlike BRICK_WALL's half-brick overhang
// simplification, whose 0.097m odd-row overhang would jam into the neighbouring panel.
export const BRICK_WALL_LAB_SEGMENTS = 3;
export const BRICK_WALL_LAB_COLUMNS_PER_SEGMENT = 14; // 14 * 0.194m = 2.716m per panel
export const BRICK_WALL_LAB_ROWS = 30; // 30 * 0.057m = 1.71m tall (matches BRICK_WALL_ROWS)
export const BRICK_WALL_SEGMENT_GAP_M = 0.04; // expansion joint between panels (no weld crosses it)
// Total span = 3 * 2.716 + 2 * 0.04 = 8.23m — well over the car's ~1.85m width and the >=8m target.
export const BRICK_WALL_LAB_SPAN_M = BRICK_WALL_LAB_SEGMENTS * BRICK_WALL_LAB_COLUMNS_PER_SEGMENT * BRICK_HALF_EXTENTS.x * 2 + (BRICK_WALL_LAB_SEGMENTS - 1) * BRICK_WALL_SEGMENT_GAP_M;

// ---------------------------------------------------------------------------------------------
// 4) Perimeter fence -- posts + 2 rails per span, low thresholds. The compound's NORTH frontage: six
// 6m fence runs laid end-to-end along the yard's north edge (z=46, inside the flat interior so each
// footing seats on h=0), split by a central GATE gap (x in [-8,8]) that the driveway spur passes
// through. So the run covers x in [-26,-8] and [8,26] with a 16m gate opening on the drive. Each line
// is built along X (buildFenceLine spans X at fixed z), which is exactly the perimeter orientation
// here. FENCE_CONFIGS[0] keeps a clear 10m south approach for the fence-smash sim/verify.
// ---------------------------------------------------------------------------------------------

export interface FenceConfig {
	id: string;
	center: V3;
}

export const FENCE_CONFIGS: readonly FenceConfig[] = [
	{ id: 'fence-w3', center: { x: -23, y: 0, z: 46 } },
	{ id: 'fence-w2', center: { x: -17, y: 0, z: 46 } },
	{ id: 'fence-w1', center: { x: -11, y: 0, z: 46 } },
	{ id: 'fence-e1', center: { x: 11, y: 0, z: 46 } },
	{ id: 'fence-e2', center: { x: 17, y: 0, z: 46 } },
	{ id: 'fence-e3', center: { x: 23, y: 0, z: 46 } },
];

export const FENCE_SPAN_COUNT = 4; // 5 posts, 4 spans
export const FENCE_SPAN_LENGTH_M = 1.5; // 6m total fence length
export const FENCE_POST_HEIGHT_M = 1.1;
export const FENCE_POST_HALF_CROSS_M = 0.05;
export const FENCE_RAIL_HALF_HEIGHT_M = 0.04;
export const FENCE_RAIL_HALF_DEPTH_M = 0.03;
export const FENCE_RAIL_HEIGHTS_M: readonly number[] = [0.35, 0.85]; // 2 rails per span
