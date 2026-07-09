// SPDX-License-Identifier: MIT
//
// The GAME's real terrain: a deterministic height field + zone system that replaces the old flat
// infinite plane. Renderer-free and box3d-free (pure math, no `three`/DOM/native import) so it is
// shared VERBATIM by:
//   - the physics ground body (./terrainBody.ts -> box3d heightfield shape),
//   - the visual ground mesh (./terrainMesh.ts -> a THREE mesh built from the SAME height data),
//   - the headless determinism/flatness test (game/sim/terrain.test.mjs).
// Same "renderer-free tuning is shared, not duplicated" convention as game/src/world/tuning.ts and
// game/src/vehicle/tuning.ts.
//
// GRID CONVENTION (validated end-to-end in tests/heightfield-basic.test.ts / heightfield-scale.test.ts
// and game/sim/heightfield-drive.test.mjs): heights[] is ROW-MAJOR, index = row*countX + col, with
// x-axis = columns and z-axis = rows. box3d's height-field shape has its LOCAL origin at the grid
// CORNER (col=0,row=0), so to center the field on the world origin the static body must be placed at
// (-HALF_SIZE, 0, -HALF_SIZE). buildTerrainHeights() below fills each cell by evaluating
// terrainHeight() in WORLD (x,z) (i.e. AFTER that centering offset), so world (0,0) is the field
// center and terrainHeight() is the single source of truth for both physics and visuals.
//
// ZONES (world XZ, origin = spawn):
//   APRON     flat h=0 asphalt pad: spawn + all legacy destructibles + ramps live here. HARD FLAT
//             (a mask forces h to exactly 0) so every existing sim test/verify scenario keeps working.
//   DIRT ROAD an elliptical loop north of the apron with potholes / washboard / rolling undulation --
//             the suspension showcase, reached by driving straight forward (+Z) out of the apron.
//   FOREST    flat h=0 region to the WEST -- the trees feature is relocated/expanded here (its bodies
//             spawn at y=0, so the terrain under them must be exactly 0).
//   BUILDINGS flat h=0 region to the EAST -- the buildings feature sits here (also spawns at y=0).
//   MEADOW    everything else reachable: gentle long-wavelength grass undulation.

// --------------------------------------------------------------------------------------------------
// Field dimensions. 400m span (>=4x the old ~100m content radius). count 400 -> ~1.0m cells: fine
// enough for the pothole/washboard relief to read in physics (validated: 256/400m creates in ~4ms,
// 400/400m is ~1.0m cells and still a one-time ~10ms create), coarse enough to stay cheap.
// --------------------------------------------------------------------------------------------------

export const TERRAIN_SPAN_M = 400;
export const TERRAIN_COUNT = 512; // grid points per axis (~0.78m cells -- resolves the dirt washboard)
export const TERRAIN_HALF_M = TERRAIN_SPAN_M / 2;
/** Cell size, meters (SCALE.x / SCALE.z for the box3d height-field shape). */
export const TERRAIN_CELL_M = TERRAIN_SPAN_M / (TERRAIN_COUNT - 1);
export const TERRAIN_SCALE = { x: TERRAIN_CELL_M, y: 1, z: TERRAIN_CELL_M };

// --------------------------------------------------------------------------------------------------
// Zone geometry (world meters).
// --------------------------------------------------------------------------------------------------

/** Flat asphalt apron: rounded rectangle. Contains spawn (0,0), the legacy destructibles
 * (x in [-23.5,23.5], z in [8,47]) and both ramps, with margin. */
export const APRON = { cx: 0, cz: 16, halfX: 36, halfZ: 42, corner: 9, feather: 6 } as const;

/** Flat forest region (west). Trees are relocated here (see features/trees/tuning.ts). Feathered edge
 * blends into meadow grass; the interior is hard-flat so tree trunks (spawned at y=0) sit on y=0. */
export const FOREST = { minX: -186, maxX: -46, minZ: -74, maxZ: 132, feather: 10 } as const;

/** Flat buildings region (east). The buildings feature sits here (spawns at y=0). */
export const BUILDINGS = { minX: 36, maxX: 98, minZ: -10, maxZ: 48, feather: 8 } as const;

/** Dirt-road loop: an elliptical annulus north of the apron. Centred slightly EAST (cx=18) so its
 * west arc (min x = cx-rx = -34) clears the forest flat zone (x<=-46) entirely and its south reach
 * (min z = cz-rz = 77) clears both the apron (z<=58) and the east buildings (z<=48). Driving straight
 * north from spawn (x=0) meets the road band at z~80, so it is reachable straight ahead. */
export const DIRT_LOOP = { cx: 18, cz: 125, rx: 52, rz: 48, halfWidthFrac: 0.13 } as const;

/** Straight dirt SPUR: a washboarded ~9m-wide track running due north out of the apron (x=0) that
 * connects the apron to the loop. This is the drive-straight-ahead suspension SHOWCASE -- a sustained
 * run of transverse washboard + potholes along the exact line the car takes leaving spawn. */
export const DIRT_SPUR = { cx: 0, halfWidth: 8, zStart: 54, zEnd: 100, feather: 5 } as const;

// --------------------------------------------------------------------------------------------------
// Small deterministic helpers.
// --------------------------------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Rounded-rect signed "insideness" with a feathered border: 1 deep inside, 0 outside the feather. */
function roundedRectMask(
  x: number,
  z: number,
  cx: number,
  cz: number,
  halfX: number,
  halfZ: number,
  corner: number,
  feather: number,
): number {
  // Distance outside the rounded rectangle (0 inside, grows outside) -- standard rounded-box SDF.
  const qx = Math.abs(x - cx) - (halfX - corner);
  const qz = Math.abs(z - cz) - (halfZ - corner);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - corner;
  // outside <= -feather => fully inside (1); outside >= 0 => outside (0).
  return 1 - smoothstep(-feather, 0, outside);
}

/** Axis-aligned rect insideness with a feathered border. */
function rectMask(x: number, z: number, minX: number, maxX: number, minZ: number, maxZ: number, feather: number): number {
  const mx = Math.min(smoothstep(minX - feather, minX, x), smoothstep(maxX + feather, maxX, x));
  const mz = Math.min(smoothstep(minZ - feather, minZ, z), smoothstep(maxZ + feather, maxZ, z));
  return Math.min(mx, mz);
}

export function apronMask(x: number, z: number): number {
  return roundedRectMask(x, z, APRON.cx, APRON.cz, APRON.halfX, APRON.halfZ, APRON.corner, APRON.feather);
}
export function forestMask(x: number, z: number): number {
  return rectMask(x, z, FOREST.minX, FOREST.maxX, FOREST.minZ, FOREST.maxZ, FOREST.feather);
}
export function buildingsMask(x: number, z: number): number {
  return rectMask(x, z, BUILDINGS.minX, BUILDINGS.maxX, BUILDINGS.minZ, BUILDINGS.maxZ, BUILDINGS.feather);
}

/** Union of all HARD-FLAT zones (apron + forest + buildings). Where this is 1, terrainHeight()==0. */
export function flatMask(x: number, z: number): number {
  return Math.max(apronMask(x, z), forestMask(x, z), buildingsMask(x, z));
}

// --------------------------------------------------------------------------------------------------
// Dirt-road loop profile.
// --------------------------------------------------------------------------------------------------

/** Elliptical "radius" of a point relative to the loop centre: E==1 is exactly on the centreline. */
function loopE(x: number, z: number): number {
  const ex = (x - DIRT_LOOP.cx) / DIRT_LOOP.rx;
  const ez = (z - DIRT_LOOP.cz) / DIRT_LOOP.rz;
  return Math.sqrt(ex * ex + ez * ez);
}

/** Loop-road membership in [0,1]: 1 on the loop centreline, feathering to 0 at the band edges. */
function loopRoadWeight(x: number, z: number): number {
  const d = Math.abs(loopE(x, z) - 1);
  return 1 - smoothstep(0, DIRT_LOOP.halfWidthFrac, d);
}

/** Straight-spur membership in [0,1]: 1 on the spur centreline (x=0), feathering out to its width and
 * fading in/out along z at the apron and loop ends. */
function spurRoadWeight(x: number, z: number): number {
  const across = 1 - smoothstep(DIRT_SPUR.halfWidth, DIRT_SPUR.halfWidth + DIRT_SPUR.feather, Math.abs(x - DIRT_SPUR.cx));
  const along = Math.min(
    smoothstep(DIRT_SPUR.zStart - DIRT_SPUR.feather, DIRT_SPUR.zStart, z),
    smoothstep(DIRT_SPUR.zEnd + DIRT_SPUR.feather, DIRT_SPUR.zEnd, z),
  );
  return Math.min(across, along);
}

/** Total dirt-road membership (loop OR spur) -- used for texture blending. */
export function dirtRoadWeight(x: number, z: number): number {
  return Math.max(loopRoadWeight(x, z), spurRoadWeight(x, z));
}

/** Potholes distributed around the loop (parametric angle, depth 0.15-0.35m, radius 1.8-2.6m). Placed
 * ON the loop centreline (E=1) so they always fall inside the drivable band. Deterministic list. */
export const DIRT_POTHOLES: readonly { x: number; z: number; depth: number; radius: number }[] = (() => {
  const specs: { angDeg: number; depth: number; radius: number }[] = [
    { angDeg: 8, depth: 0.32, radius: 2.4 },
    { angDeg: 34, depth: 0.2, radius: 1.9 },
    { angDeg: 61, depth: 0.35, radius: 2.6 },
    { angDeg: 88, depth: 0.16, radius: 1.8 },
    { angDeg: 116, depth: 0.28, radius: 2.2 },
    { angDeg: 145, depth: 0.34, radius: 2.5 },
    { angDeg: 173, depth: 0.18, radius: 1.9 },
    { angDeg: 202, depth: 0.3, radius: 2.3 },
    { angDeg: 231, depth: 0.22, radius: 2.0 },
    { angDeg: 259, depth: 0.35, radius: 2.6 },
    { angDeg: 288, depth: 0.15, radius: 1.8 },
    { angDeg: 317, depth: 0.29, radius: 2.2 },
    { angDeg: 344, depth: 0.33, radius: 2.4 },
  ];
  return specs.map((s) => {
    const a = (s.angDeg * Math.PI) / 180;
    return { x: DIRT_LOOP.cx + DIRT_LOOP.rx * Math.cos(a), z: DIRT_LOOP.cz + DIRT_LOOP.rz * Math.sin(a), depth: s.depth, radius: s.radius };
  });
})();

/** Potholes along the straight spur (x=0), spaced up its length. Kept toward the SHALLOW end of the
 * 0.15-0.35m spec band (and offset from dead-centre) so the car jolts through them on the drive-through
 * showcase rather than bellying out and getting trapped -- the deep dramatic potholes live on the LOOP
 * (DIRT_POTHOLES), which is a crash target rather than a straight-through line. */
export const SPUR_POTHOLES: readonly { x: number; z: number; depth: number; radius: number }[] = [
  { x: -1.8, z: 66, depth: 0.18, radius: 2.2 },
  { x: 2.0, z: 79, depth: 0.2, radius: 2.4 },
  { x: -1.4, z: 91, depth: 0.16, radius: 2.1 },
];

/** Raw dirt-road relief. Loop ripples are weighted by the loop membership, spur ripples (transverse
 * washboard + rolling) by the spur membership; both sets of gaussian potholes are added directly
 * (their own falloff localises them). */
function dirtRoadProfile(x: number, z: number, loopW: number, spurW: number): number {
  const theta = Math.atan2(z - DIRT_LOOP.cz, x - DIRT_LOOP.cx);
  const loopRipple = (0.13 * Math.sin(theta * 3 + 0.6) + 0.045 * Math.sin(theta * 90)) * loopW;
  // Spur: transverse washboard (two frequencies of ridges across the track, ~3.5m + ~5.5m wavelength,
  // comfortably resolved by the 0.78m cells and near the suspension's ~2.2Hz resonance at road speed
  // so it genuinely works the springs) + gentle rolling.
  const spurRipple = (0.058 * Math.sin(z * 1.8) + 0.04 * Math.sin(z * 1.15 + 0.7) + 0.07 * Math.sin(z * 0.32 + 0.4)) * spurW;
  let h = loopRipple + spurRipple;
  for (const p of DIRT_POTHOLES) {
    const d2 = (x - p.x) ** 2 + (z - p.z) ** 2;
    h -= p.depth * Math.exp(-d2 / (2 * p.radius * p.radius));
  }
  for (const p of SPUR_POTHOLES) {
    const d2 = (x - p.x) ** 2 + (z - p.z) ** 2;
    h -= p.depth * Math.exp(-d2 / (2 * p.radius * p.radius));
  }
  return h;
}

// --------------------------------------------------------------------------------------------------
// Meadow undulation (gentle, long wavelength). Kept modest (|h| < ~0.32m) so it is always drivable and
// never lifts the ground near the chase camera's min-height clamp.
// --------------------------------------------------------------------------------------------------

function meadowUndulation(x: number, z: number): number {
  return (
    0.17 * Math.sin(x * 0.045) * Math.cos(z * 0.038) +
    0.09 * Math.sin(x * 0.09 + 1.7) * Math.sin(z * 0.07 + 0.5) +
    0.05 * Math.cos((x + z) * 0.11)
  );
}

// --------------------------------------------------------------------------------------------------
// Master height function -- the single source of truth for physics AND visuals.
// --------------------------------------------------------------------------------------------------

export function terrainHeight(x: number, z: number): number {
  const flat = flatMask(x, z);
  if (flat >= 0.9999) return 0;
  const loopW = loopRoadWeight(x, z);
  const spurW = spurRoadWeight(x, z);
  const natural = meadowUndulation(x, z) + dirtRoadProfile(x, z, loopW, spurW);
  // Fade the natural relief to 0 as we enter any hard-flat zone (apron/forest/buildings).
  return natural * (1 - flat);
}

/** Terrain surface slope at (x,z) in DEGREES (central-difference of terrainHeight). Used by the
 * flatness test (apron must be < 2 deg) and could gate feature placement. */
export function terrainSlopeDeg(x: number, z: number, eps = TERRAIN_CELL_M): number {
  const dhdx = (terrainHeight(x + eps, z) - terrainHeight(x - eps, z)) / (2 * eps);
  const dhdz = (terrainHeight(x, z + eps) - terrainHeight(x, z - eps)) / (2 * eps);
  return (Math.atan(Math.hypot(dhdx, dhdz)) * 180) / Math.PI;
}

/** Zone texture-blend weights for the visual mesh (normalized to sum 1): grass / dirt / forest. The
 * apron is drawn by a separate asphalt pad mesh, so it is folded into "grass" here (it is hidden). */
export function terrainBlendWeights(x: number, z: number): { grass: number; dirt: number; forest: number } {
  const forest = forestMask(x, z);
  const dirt = dirtRoadWeight(x, z) * (1 - forest);
  const grass = Math.max(0, 1 - forest - dirt);
  const sum = grass + dirt + forest || 1;
  return { grass: grass / sum, dirt: dirt / sum, forest: forest / sum };
}

// --------------------------------------------------------------------------------------------------
// Row-major height buffer for the box3d height-field shape (and the visual mesh samples the SAME
// terrainHeight(), so the two surfaces are identical by construction).
// --------------------------------------------------------------------------------------------------

export function buildTerrainHeights(): Float32Array {
  const heights = new Float32Array(TERRAIN_COUNT * TERRAIN_COUNT);
  for (let row = 0; row < TERRAIN_COUNT; row++) {
    const worldZ = row * TERRAIN_SCALE.z - TERRAIN_HALF_M;
    for (let col = 0; col < TERRAIN_COUNT; col++) {
      const worldX = col * TERRAIN_SCALE.x - TERRAIN_HALF_M;
      heights[row * TERRAIN_COUNT + col] = terrainHeight(worldX, worldZ);
    }
  }
  return heights;
}
