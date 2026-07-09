// SPDX-License-Identifier: MIT
//
// 'buildings' WorldFeature tuning: material presets (mass/friction/weld-break thresholds) + structure
// layout. Renderer-free (no three/DOM import), same convention as world/tuning.ts.
//
// ZONE: x > +30 (east side), >=15m clearance from the nearest existing body (wall-right, centered
// x=22, right edge ~23.5 -- see world/tuning.ts's WALL_CONFIGS/RAMP_CONFIGS/POLE_POSITIONS, all of
// which stay at x<=23.5). Every structure below starts no closer than x=40.2 (16.7m clearance) and
// stays under x=90 (well inside the physics ground's half-size and comfortably inside the visual
// ground plane too -- see scene/buildScene.ts's buildGround(200, 40)). None of it touches the main
// z-corridor (|x|<20) or the kicker lane (x=0).

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
 * wobble). */
export const BRICK_BREAK_FORCE_N = 3200;
export const BRICK_BREAK_TORQUE_NM = 650;
/** Bottom-course brick-to-FOOTING welds are much stronger than brick-to-brick mortar. A thin
 * single-wythe wall would otherwise just tip over as one rigid slab at any speed (the base is its only
 * anchor); a strong base means a low-speed hit instead cracks the inter-brick joints LOCALLY near the
 * impact (a chunk sheds, the rest stands), and only a hard hit overwhelms the base and takes the whole
 * wall. This is what restores the low/mid/high staging with real (small, light) bricks. */
export const BRICK_FOOTING_BREAK_FORCE_N = 11000;
export const BRICK_FOOTING_BREAK_TORQUE_NM = 2600;

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

export const SHED_CENTER: V3 = { x: 42, y: 0, z: 20 };
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

export const CORNER_POINT: V3 = { x: 55, y: 0, z: 20 };
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

export const BRICK_WALL_CENTER: V3 = { x: 68, y: 0, z: 20 };
// Real brick 194 x 92 x 57 mm (laid flat: 194 length along the wall X, 57 course height Y, 92 depth
// through the wall Z -- single-wythe). A full 6m x 1.6m masonry wall of these is ~850 bricks (past the
// physics/perf budget), so this is a compact garden wall: 10 cols x 16 courses = 160 bricks,
// ~1.94m long x 0.91m tall -- tall enough that a low-speed hit reaches only the lower courses (real
// staging: a nudge sheds a chunk, a fast car plows through). See
// docs/build-log/specs/materials-truth.md for the size trade-off rationale.
export const BRICK_HALF_EXTENTS: V3 = { x: 0.097, y: 0.0285, z: 0.046 };
export const BRICK_WALL_COLUMNS = 10; // 10 * 0.194m = 1.94m long
export const BRICK_WALL_ROWS = 16; // 16 * 0.057m = 0.912m tall
export const BRICK_WALL_LENGTH_M = BRICK_WALL_COLUMNS * BRICK_HALF_EXTENTS.x * 2; // 1.94m, keeps footing/columns consistent

// ---------------------------------------------------------------------------------------------
// 4) Fence lines -- posts + 2 rails per span, low thresholds. Two parallel lines across the same
// lane (x=80) so a run can smash through the first, then the second.
// ---------------------------------------------------------------------------------------------

export interface FenceConfig {
	id: string;
	center: V3;
}

export const FENCE_CONFIGS: readonly FenceConfig[] = [
	{ id: 'fence-near', center: { x: 80, y: 0, z: 14 } },
	{ id: 'fence-far', center: { x: 80, y: 0, z: 30 } },
];

export const FENCE_SPAN_COUNT = 4; // 5 posts, 4 spans
export const FENCE_SPAN_LENGTH_M = 1.5; // 6m total fence length
export const FENCE_POST_HEIGHT_M = 1.1;
export const FENCE_POST_HALF_CROSS_M = 0.05;
export const FENCE_RAIL_HALF_HEIGHT_M = 0.04;
export const FENCE_RAIL_HALF_DEPTH_M = 0.03;
export const FENCE_RAIL_HEIGHTS_M: readonly number[] = [0.35, 0.85]; // 2 rails per span
