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
import { TERRAIN_COUNT, TERRAIN_HALF_M, TERRAIN_SCALE, buildTerrainHeights } from './heightfield';

/** Creates the game's terrain ground: one static height-field body centred on the world origin. */
export function createTerrainGroundBody(world: World): Body {
  const ground = world.createBody({ type: BodyType.Static, position: { x: -TERRAIN_HALF_M, y: 0, z: -TERRAIN_HALF_M } });
  const heights = buildTerrainHeights();
  ground.createHeightFieldShape(heights, TERRAIN_COUNT, TERRAIN_COUNT, TERRAIN_SCALE, { friction: GROUND_FRICTION });
  return ground;
}
