// SPDX-License-Identifier: MIT
//
// The GAME's ground physics body: a box3d height-field static shape built from the shared terrain
// height data (./heightfield.ts). This REPLACES the flat play-plane for the browser game only --
// the headless vehicle harness (game/src/vehicle/vehicle.ts's createGroundBody) keeps its flat default
// so the 95 existing sim tests are completely untouched (they never import this module).
//
// The height-field's local origin is the grid corner, so the static body is placed at
// (-HALF, 0, -HALF) to centre the field on the world origin -- exactly the convention validated in
// tests/heightfield-basic.test.ts and game/sim/heightfield-drive.test.mjs.

import { BodyType, type Body, type World } from '../../../../src/ts/index.js';
import { GROUND_FRICTION } from '../../vehicle/tuning';
import {
  DIRT_MATERIAL,
  NATURAL_MATERIAL,
  TERRAIN_COUNT,
  TERRAIN_HALF_M,
  TERRAIN_SCALE,
  buildTerrainHeights,
  buildTerrainMaterialIndices,
  type TerrainSurfaceMaterial,
} from './heightfield';

/** Concrete per-zone materials, indexed by SURFACE_ASPHALT/DIRT/NATURAL (heightfield.ts). Asphalt
 * reuses GROUND_FRICTION verbatim (the SAME number the flat headless-harness ground already used
 * uniformly) so the compound apron/kicker/every existing drive test's feel is EXACTLY unchanged --
 * only the dirt road and forest-floor/meadow zones actually differ now. Index order MUST match
 * SURFACE_ASPHALT=0/SURFACE_DIRT=1/SURFACE_NATURAL=2. */
const TERRAIN_SURFACE_MATERIALS: readonly TerrainSurfaceMaterial[] = [
  { friction: GROUND_FRICTION, restitution: 0, rollingResistance: 0 }, // SURFACE_ASPHALT
  DIRT_MATERIAL, // SURFACE_DIRT
  NATURAL_MATERIAL, // SURFACE_NATURAL
];

/** Creates the game's terrain ground: one static height-field body centred on the world origin, with
 * per-triangle (per-cell) surface materials assigned from the SAME zone masks the visuals blend on
 * (asphalt apron / packed dirt road / forest-floor+meadow -- see heightfield.ts's "Per-zone surface
 * materials" section). */
export function createTerrainGroundBody(world: World): Body {
  const ground = world.createBody({ type: BodyType.Static, position: { x: -TERRAIN_HALF_M, y: 0, z: -TERRAIN_HALF_M } });
  const heights = buildTerrainHeights();
  const materialIndices = buildTerrainMaterialIndices();
  ground.createHeightFieldShape(heights, TERRAIN_COUNT, TERRAIN_COUNT, TERRAIN_SCALE, {
    friction: GROUND_FRICTION, // fallback base material; every cell is actually covered by materials[] below
    materials: TERRAIN_SURFACE_MATERIALS as TerrainSurfaceMaterial[],
    materialIndices,
  });
  return ground;
}
