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

export const WOOD_STUD_MASS_KG = 3;
export const WOOD_PLANK_MASS_KG = 4;
export const WOOD_FRICTION = 0.7; // was 0.6 -- freed planks/studs clatter to rest instead of sliding forever
export const WOOD_RESTITUTION = 0.12; // wood clatters (a little bounce), not a dead thud
/** Studs/planks: low-medium weld strength -- a stud frame yields well before masonry. */
export const WOOD_BREAK_FORCE_N = 3500;
export const WOOD_BREAK_TORQUE_NM = 1800;

export const DRYWALL_PANEL_MASS_KG = 7;
export const DRYWALL_FRICTION = 0.34; // was 0.4 -- lower so burst drywall sheets flutter-slide flat
export const DRYWALL_RESTITUTION = 0.0; // drywall doesn't bounce
/** Lowest threshold in the whole feature -- "the car punches through easily" per spec. */
export const DRYWALL_BREAK_FORCE_N = 900;
export const DRYWALL_BREAK_TORQUE_NM = 450;

export const BRICK_MASS_KG = 2.6;
export const BRICK_FRICTION = 0.9; // was 0.75 -- bricks thud and tumble to rest quickly, not skate
export const BRICK_RESTITUTION = 0.0; // masonry does not bounce
/** High per-joint threshold -- individually strong, but a real car impact exceeds it along a wide
 * front so many bricks still cascade free ("the box3d showcase" per spec). */
export const BRICK_BREAK_FORCE_N = 6000;
export const BRICK_BREAK_TORQUE_NM = 2200;

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
}

/** Masonry: brittle, but yields a little first so a low-speed hit bulges/slumps a course rather than
 * detonating the whole wall. Cap keeps the spray from rocketing. */
export const BRICK_PROFILE: YieldProfile = {
	yieldForceFrac: 0.4,
	yieldTorqueFrac: 0.4,
	yieldLinearHertz: 14,
	yieldAngularHertz: 10,
	yieldDampingRatio: 0.8,
	ductileBreakMult: 1.0,
	breakSpeedCapMs: 7.5,
	breakSpinCapRad: 16,
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
export const SHED_STUD_HALF_CROSS_M = 0.04; // 8cm square studs
export const SHED_PLANK_THICKNESS_HALF_M = 0.02; // 4cm plank
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
export const CORNER_STUD_HALF_CROSS_M = 0.045;
export const CORNER_DRYWALL_HALF_THICKNESS_M = 0.012;
export const CORNER_DRYWALL_SHEET_WIDTH_M = 1.2;
export const CORNER_PIPE_COUNT = 3;

// ---------------------------------------------------------------------------------------------
// 3) Free-standing brick wall -- ~120 bricks in running-bond pattern, weld lattice brick-to-brick
// (vertical, running-bond overlap) + brick-to-footing (bottom row), high per-joint threshold.
// ---------------------------------------------------------------------------------------------

export const BRICK_WALL_CENTER: V3 = { x: 68, y: 0, z: 20 };
export const BRICK_WALL_LENGTH_M = 6; // along X
export const BRICK_HALF_EXTENTS: V3 = { x: 0.2, y: 0.1, z: 0.1 }; // 0.4 x 0.2 x 0.2m brick
export const BRICK_WALL_COLUMNS = 15; // 15 * 0.4m = 6m
export const BRICK_WALL_ROWS = 8; // 8 * 0.2m = 1.6m tall

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
