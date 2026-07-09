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

export const WOOD_STUD_MASS_KG = 3;
export const WOOD_PLANK_MASS_KG = 4;
export const WOOD_FRICTION = 0.6;
/** Studs/planks: low-medium weld strength -- a stud frame yields well before masonry. */
export const WOOD_BREAK_FORCE_N = 3500;
export const WOOD_BREAK_TORQUE_NM = 1800;

export const DRYWALL_PANEL_MASS_KG = 7;
export const DRYWALL_FRICTION = 0.4;
/** Lowest threshold in the whole feature -- "the car punches through easily" per spec. */
export const DRYWALL_BREAK_FORCE_N = 900;
export const DRYWALL_BREAK_TORQUE_NM = 450;

export const BRICK_MASS_KG = 2.6;
export const BRICK_FRICTION = 0.75;
/** High per-joint threshold -- individually strong, but a real car impact exceeds it along a wide
 * front so many bricks still cascade free ("the box3d showcase" per spec). */
export const BRICK_BREAK_FORCE_N = 6000;
export const BRICK_BREAK_TORQUE_NM = 2200;

export const PIPE_MASS_KG = 4;
export const PIPE_FRICTION = 0.3;
export const PIPE_RADIUS_M = 0.05;
export const PIPE_HALF_LENGTH_M = 0.55; // 1.1m pipe segments

export const FENCE_MASS_KG = 2.5;
export const FENCE_FRICTION = 0.5;
/** Low thresholds -- fences are meant to break away easily. */
export const FENCE_BREAK_FORCE_N = 700;
export const FENCE_BREAK_TORQUE_NM = 350;

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
