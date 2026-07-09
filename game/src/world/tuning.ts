// SPDX-License-Identifier: MIT
//
// Destructible-world tuning constants (G4 spec): stacked-block walls, crate tower, barrel bowling
// triangle, tippable poles + 2 static ramps. Renderer-free (no three/DOM import) so this file is
// shared verbatim by the browser game (main.ts) and the headless perf-bench harness
// (game/sim/perf-bench.mjs), same convention as game/src/vehicle/tuning.ts.
//
// LAYOUT (playtest MAJOR fix -- "kicker ramp unreachable"): 7 parallel lanes fanning out from the
// car's spawn point (0,0,0), facing +Z, each with its OWN clear straight approach (nothing else sits
// in a lane closer to spawn than that lane's own target) -- x positions below, ordered left to right:
//   x=-22  wall-left (brick),        clear approach, z=20
//   x=-16  crate tower,              clear approach, z=34
//   x=-9   wall-center (concrete),   clear approach, z=18 -- closest/easiest target, no longer at x=0
//   x=0    kicker ramp,              clear approach, ~43m ahead (nothing between spawn and it, and
//                                    the landing zone beyond it -- x~0, z>45 -- is also clear, so a
//                                    jump can be followed by more driving without hitting anything)
//   x=+9   wide ramp,                clear approach, z=8 (a quick, close jump)
//   x=+16  barrel triangle,          clear approach, z=34
//   x=+22  wall-right (concrete),    clear approach, z=20
// TUNING DELTA: previously the kicker ramp sat at x=-11 (11m lateral, 8m ahead -- unreachable at speed
// from a straight-ahead approach) and wall-left/crate-tower shared that SAME x=-11 lane behind it (so
// reaching them meant crossing the kicker first); wide-ramp/wall-right/barrel-triangle had the same
// problem on the x=+11 side. Every lane above is now independent -- no lane requires crossing a ramp
// (or any other body) to reach a DIFFERENT lane's target -- which also fixes the reported minor "side
// walls barely scatter" (wall-left/wall-right previously only ever took a glancing hit while
// maneuvering around a ramp; each now gets a clean, direct, head-on approach like wall-center always
// had). Poles are scattered in the gaps BETWEEN lanes (never blocking any lane's own clear approach)
// for variety/slalom flavor. All Z values are comfortably within the ground plane's play area
// (buildGround(200,40) / the physics ground half-size of 250).

import type { Q4, V3 } from '../vehicle/mathUtil';
import { IDENTITY_Q } from '../vehicle/mathUtil';

export { IDENTITY_Q };
export type { Q4 };

// ---------------------------------------------------------------------------------------------
// Stacked-block walls
// ---------------------------------------------------------------------------------------------

/** Half-extents of one wall block, meters (full size 0.5 x 0.35 x 0.35m per spec). */
export const WALL_BLOCK_HALF_EXTENTS_M: V3 = { x: 0.25, y: 0.175, z: 0.175 };
export const WALL_BLOCK_GAP_M = 0.01;
export const WALL_COLS = 6;
export const WALL_ROWS = 3;
/** Mass varies by row (bottom row heaviest, like real foundation-vs-cap masonry): row 0 (bottom)
 * = MAX, top row = MIN, linearly interpolated -- satisfies the spec's "masses varied 8-30kg". */
export const WALL_BLOCK_MASS_MIN_KG = 8;
export const WALL_BLOCK_MASS_MAX_KG = 30;
export const WALL_BLOCK_FRICTION = 0.7;
/** Effective bulk density implied by the mass/size above (~490-1840 kg/m^3, well under solid
 * concrete/brick's real ~1900-2400 kg/m^3) -- deliberately lighter than a literal solid block so a
 * whole wall stays fun/scatterable on impact rather than immovable; documented plainly as a gameplay
 * choice, same convention as game/src/damage/damage-tuning.ts's TUNING DELTA comments. */
export type WallMaterial = 'concrete' | 'brick';

export interface WallConfig {
	id: string;
	/** World position of the wall's horizontal center, at ground level (base row sits on y=0). */
	center: V3;
	material: WallMaterial;
}

export const WALL_CONFIGS: readonly WallConfig[] = [
	{ id: 'wall-center', center: { x: -9, y: 0, z: 18 }, material: 'concrete' },
	{ id: 'wall-left', center: { x: -22, y: 0, z: 20 }, material: 'brick' },
	{ id: 'wall-right', center: { x: 22, y: 0, z: 20 }, material: 'concrete' },
];

// ---------------------------------------------------------------------------------------------
// Crate tower
// ---------------------------------------------------------------------------------------------

export const CRATE_HALF_EXTENT_M = 0.3; // 0.6m cube
export const CRATE_MASS_KG = 15;
export const CRATE_GAP_M = 0.02;
export const CRATE_FRICTION = 0.65;
/** 8 layers tall (per spec); the top 2 layers taper from a 3x3 to a 2x2 footprint so the tower
 * silhouette narrows toward the top rather than reading as a plain rectangular block. */
export const CRATE_TOWER_LAYERS = 8;
export const CRATE_TOWER_WIDE_LAYERS = 6;
export const CRATE_TOWER_CENTER: V3 = { x: -16, y: 0, z: 34 };

// ---------------------------------------------------------------------------------------------
// Barrel bowling triangle (10 barrels, 4 rows: 1+2+3+4)
// ---------------------------------------------------------------------------------------------

export const BARREL_RADIUS_M = 0.3;
export const BARREL_HEIGHT_M = 0.9;
export const BARREL_SIDES = 12;
export const BARREL_MASS_KG = 25;
export const BARREL_FRICTION = 0.5;
export type BarrelMaterial = 'barrelBlue' | 'barrelRust';
/** Apex barrel position (row 1); rows 2-4 extend toward +Z (away from spawn), so a car approaching
 * from spawn hits the apex first, like a bowling ball. */
export const BARREL_TRIANGLE_APEX: V3 = { x: 16, y: 0, z: 34 };
export const BARREL_ROW_SPACING_M = BARREL_RADIUS_M * Math.sqrt(3) * 1.05;
export const BARREL_LATERAL_SPACING_M = BARREL_RADIUS_M * 2 * 1.05;

// ---------------------------------------------------------------------------------------------
// Tippable poles.
//
// SPEC NOTE ("base slightly heavier via two-shape compound of boxes if easy, else uniform"): NOT
// easy, so this falls back to the spec's explicit "uniform" alternative -- box3d-js's box shapes have
// no off-origin `center` field (only sphere/capsule do -- see ../vehicle/geometry.ts's ballast doc
// comment on vehicle/tuning.ts's COM_LOWER_OFFSET_M, which hit the exact same limitation for the
// chassis), so a literal "shaft box + separately-positioned heavier base box" compound isn't
// constructible in this binding (both boxes would sit at the same body-local origin). A uniform
// single box (post) is used instead -- documented plainly as a scope cut, not silently downgraded.
// ---------------------------------------------------------------------------------------------

/** Half-extents, meters (0.15 x 2.5m post). Body origin sits at half-height so the post's bottom
 * face rests on the ground (y=0) -- see bodies.ts's buildPoles(). */
export const POLE_SHAFT_HALF_EXTENTS_M: V3 = { x: 0.075, y: 1.25, z: 0.075 };
export const POLE_MASS_KG = 40;
export const POLE_FRICTION = 0.6;

// Positioned in the GAPS between the 7 lanes above (see this file's LAYOUT doc comment) -- close
// enough to slalom near, never inside any lane's own clear straight approach.
export const POLE_POSITIONS: readonly V3[] = [
	{ x: -19, y: 0, z: 15 }, // between wall-left (-22) and crate tower (-16)
	{ x: -12.5, y: 0, z: 22 }, // between crate tower (-16) and wall-center (-9)
	{ x: -4.5, y: 0, z: 12 }, // between wall-center (-9) and kicker (0)
	{ x: 4.5, y: 0, z: 12 }, // between kicker (0) and wide ramp (+9)
	{ x: 12.5, y: 0, z: 22 }, // between wide ramp (+9) and barrel triangle (+16)
];

// ---------------------------------------------------------------------------------------------
// Static ramps -- convex-hull wedges (box3d computes the hull itself from a flat point cloud, same
// pattern as vehicle/geometry.ts's buildChassisHullPoints()): a flat rectangular base plus a raised
// front ridge, giving a single inclined face at atan(height/length).
// ---------------------------------------------------------------------------------------------

export interface RampConfig {
	id: 'kicker' | 'wide';
	angleDeg: number;
	width: number;
	length: number;
	height: number;
	/** World Z of the ramp's low (entry) edge; the raised edge sits at backZ + length. */
	backZ: number;
	centerX: number;
}

const KICKER_HEIGHT_M = 1.2;
const KICKER_ANGLE_DEG = 30;
const KICKER_LENGTH_M = KICKER_HEIGHT_M / Math.tan((KICKER_ANGLE_DEG * Math.PI) / 180);

const WIDE_RAMP_ANGLE_DEG = 15;
const WIDE_RAMP_LENGTH_M = 4;
const WIDE_RAMP_HEIGHT_M = WIDE_RAMP_LENGTH_M * Math.tan((WIDE_RAMP_ANGLE_DEG * Math.PI) / 180);

// TUNING DELTA (playtest MAJOR "kicker ramp unreachable"): the kicker used to sit at centerX=-11,
// backZ=8 -- 8m ahead but 11m lateral from spawn, so a straight-ahead approach at speed could never
// line up with it. Moved to centerX=0 (directly ahead of spawn, which is itself at x=0 --
// vehicle.ts's createVehicle() default spawnPosition), backZ=43 (~45m ahead including the ramp's own
// length, per this file's LAYOUT doc comment) -- a genuinely clear, reachable straight shot. The wide
// ramp moves from centerX=11 to +9 (still its own dedicated lane, just renumbered to fit the new
// 7-lane spacing -- see the LAYOUT doc comment above).
export const RAMP_CONFIGS: readonly RampConfig[] = [
	{ id: 'kicker', angleDeg: KICKER_ANGLE_DEG, width: 2.4, length: KICKER_LENGTH_M, height: KICKER_HEIGHT_M, backZ: 43, centerX: 0 },
	{ id: 'wide', angleDeg: WIDE_RAMP_ANGLE_DEG, width: 3, length: WIDE_RAMP_LENGTH_M, height: WIDE_RAMP_HEIGHT_M, backZ: 8, centerX: 9 },
];

export const RAMP_FRICTION = 0.9;
