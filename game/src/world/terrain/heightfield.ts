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
// ZONES (world XZ, origin = spawn) -- "a rural workshop COMPOUND in the middle of a forest":
//   COMPOUND  flat h=0 yard (the old APRON, grown to ~90x76m): spawn + all legacy destructibles + the
//   (APRON)   two ramps + the pulled-in buildings (shed/house-corner/brick divider/perimeter fences)
//             live here. HARD FLAT (a mask forces h to exactly 0) so every existing sim test/verify
//             scenario keeps working and every building/destructible spawned at y=0 seats on the ground.
//   FOREST    a hard-flat RING that ENCLOSES the compound on every side (a big rounded-rect outer
//             boundary minus an inner clearing minus the road corridors) -- the trees feature is
//             scattered densely through it (bodies spawn at y=0, so the ring floor is exactly 0). This
//             is what makes the compound read as sitting in the woods.
//   DIRT ROAD an elliptical loop that now winds THROUGH the forest ring (trees press to its edges),
//             plus a straight driveway SPUR out the compound's north gate up to the loop -- potholes /
//             washboard / rolling undulation, the suspension showcase, reached by driving forward (+Z).
//   MEADOW    the clearing ring between the yard fence and the treeline, and everything beyond the
//             forest out to the field edge: gentle long-wavelength grass undulation.

// --------------------------------------------------------------------------------------------------
// Field dimensions (terrain GROW, user directive: "grow the terrain A LOT"). 800m span (2x the old
// 400m, ~8x the old ~100m content radius) so the enclosing forest + winding road have room to read as
// real distance. count stays 512 (orchestrator-committed "512x512 grid") -> ~1.57m cells: the
// heightfield build is O(count^2) so its cost is UNCHANGED by the span grow (measured: 512^2 builds in
// ~37ms one-time, 1.0MiB, whether the span is 400 or 800 -- reported in tests/heightfield-scale +
// game/sim/terrain.test.mjs). 1.57m cells still resolve the ~4-5m road washboard and the wide compound/
// forest flats; the finer sub-cell relief is carried by the visual mesh's normal maps as before.
// --------------------------------------------------------------------------------------------------

export const TERRAIN_SPAN_M = 800;
export const TERRAIN_COUNT = 512; // grid points per axis (~1.57m cells at the grown 800m span)
export const TERRAIN_HALF_M = TERRAIN_SPAN_M / 2;
/** Cell size, meters (SCALE.x / SCALE.z for the box3d height-field shape). */
export const TERRAIN_CELL_M = TERRAIN_SPAN_M / (TERRAIN_COUNT - 1);
export const TERRAIN_SCALE = { x: TERRAIN_CELL_M, y: 1, z: TERRAIN_CELL_M };

// --------------------------------------------------------------------------------------------------
// Zone geometry (world meters).
// --------------------------------------------------------------------------------------------------

/** Flat COMPOUND yard (the old asphalt apron, grown): rounded rectangle ~90x76m centred on spawn.
 * Contains spawn (0,0), the legacy destructibles (x in [-23.5,23.5], z up to ~36) BOTH ramps (the
 * kicker's far edge reaches z~45), and the pulled-in buildings/perimeter fences -- all with margin so
 * they sit on the hard-flat interior (h==0). Every building/fence centre placed inside this rect at
 * z <= ~48 (interior, mask==1) seats exactly on the ground. */
export const APRON = { cx: 0, cz: 16, halfX: 45, halfZ: 38, corner: 10, feather: 6 } as const;

/** Enclosing FOREST ring: a big rounded-rect OUTER boundary minus an INNER clearing (the compound plus
 * a meadow buffer) minus the road corridors. The band between them is hard-flat so the densely scattered
 * trees (features/trees/tuning.ts, all spawned at y=0) seat on y=0, and it wraps the compound on every
 * side so the yard reads as sitting in the woods. Feathered on both the inner and outer edges so it
 * blends into the meadow. */
export const FOREST_OUTER = { cx: 0, cz: 30, halfX: 168, halfZ: 168, corner: 46, feather: 14 } as const;
export const FOREST_INNER = { cx: 0, cz: 16, halfX: 55, halfZ: 49, corner: 16, feather: 10 } as const;
/** Radial band (distance from world origin) the tree scatter is confined to -- kept strictly inside the
 * ring's feathered edges so every trunk lands on hard-flat floor. Exported for the trees tuning + the
 * terrain determinism/flatness test. */
export const FOREST_RING = { rMin: 58, rMax: 152 } as const;

/** Dirt-road loop: an elliptical annulus that now sits WELL inside the forest ring (its whole span
 * z in [77,173] falls in the flat forest band, so trees press right to the road edges). Centred
 * slightly EAST (cx=18). Driving straight north from spawn (x=0) up the driveway spur meets the loop's
 * south arc at z~80, so it is still reachable straight ahead out of the compound. */
export const DIRT_LOOP = { cx: 18, cz: 125, rx: 52, rz: 48, halfWidthFrac: 0.13 } as const;

/** Straight dirt SPUR = the compound's DRIVEWAY: a washboarded ~16m-wide track running due north out
 * of the yard's north GATE (x=0, the gap in the north perimeter-fence run -- see
 * features/buildings/tuning.ts's FENCE_CONFIGS) that connects the yard to the loop. zStart 54 == the
 * compound's north edge (APRON.cz + APRON.halfZ) so the driveway begins exactly at the gate. This is
 * the drive-straight-ahead suspension SHOWCASE -- a sustained run of transverse washboard + potholes
 * along the exact line the car takes leaving spawn, out the gate, up to the forest loop. */
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

export function apronMask(x: number, z: number): number {
  return roundedRectMask(x, z, APRON.cx, APRON.cz, APRON.halfX, APRON.halfZ, APRON.corner, APRON.feather);
}

/** The enclosing forest RING: inside the outer rounded-rect AND outside the inner clearing AND off the
 * road (roads punch through so their washboard/potholes survive and the forest floor texture yields to
 * dirt on the track). Feathered on both the outer and inner edges. `rectMask` isn't used for this --
 * a ring needs the rounded-rect SDF insideness on both boundaries. */
export function forestMask(x: number, z: number): number {
  const inOuter = roundedRectMask(x, z, FOREST_OUTER.cx, FOREST_OUTER.cz, FOREST_OUTER.halfX, FOREST_OUTER.halfZ, FOREST_OUTER.corner, FOREST_OUTER.feather);
  const inInner = roundedRectMask(x, z, FOREST_INNER.cx, FOREST_INNER.cz, FOREST_INNER.halfX, FOREST_INNER.halfZ, FOREST_INNER.corner, FOREST_INNER.feather);
  const ring = Math.min(inOuter, 1 - inInner);
  return ring * (1 - dirtRoadWeight(x, z));
}

/** Union of all HARD-FLAT zones (compound yard + forest ring). Where this is 1, terrainHeight()==0.
 * The buildings no longer get their own flat zone -- they are pulled INTO the compound yard (apron),
 * whose flat interior already covers them. */
export function flatMask(x: number, z: number): number {
  return Math.max(apronMask(x, z), forestMask(x, z));
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
// CONTAINMENT BERM (world-edge freefall fix): the heightfield's outer ~3 grid cells are raised into a
// steep enclosing ridge so driving off the far edge of the 800m field is physically impossible instead
// of an infinite accelerating fall into the void (repro: game/verify/playtest-r3/diag-topspeed.mjs
// measured 668km/h at y=-3969 driving straight out past +-400m). This is layer (a) of the two-layer
// containment fix -- layer (b) is main.ts's kill-plane (chassis y < -10 -> automatic resetCar()),
// a last-resort safety net for this or any FUTURE escape.
//
// Only the outermost BERM_WIDTH_M band rises (everything further in -- meadow, forest, roads -- is
// completely unaffected, verified by game/sim/terrain.test.mjs's flatness/site-placement checks, which
// never sample anywhere near +-400m); `d` is the distance to the NEAREST of the 4 edges, so the ridge
// wraps the entire perimeter and miters naturally at the 4 corners (same rounded-rect-adjacent idea as
// this file's other masks, just edge-relative instead of center-relative). t*t (an extra ease on top of
// the smoothstep already inside it) keeps the rise flush with the meadow until deep into the last
// stretch, then climbs hard -- reads as a natural earthwork embankment, not a sudden wall, while still
// being FAR too steep (average slope BERM_HEIGHT_M/BERM_WIDTH_M ~ 70+deg) for any car to climb.
// Additive on top of the existing profile (not folded into the flat-zone fade above) so it can never be
// masked out by a future flat-zone change -- deterministic, pure function of (x,z) like everything else
// here, so buildTerrainHeights()/the physics body/the visual mesh all pick it up identically for free.
export const BERM_WIDTH_M = TERRAIN_CELL_M * 3; // ~4.7m -- "the outer ~3 cells" per the containment fix brief
export const BERM_HEIGHT_M = 14; // unclimbable at any speed; comfortably taller than any observed runaway could loft

function bermRise(x: number, z: number): number {
  const distToEdge = Math.min(TERRAIN_HALF_M - Math.abs(x), TERRAIN_HALF_M - Math.abs(z));
  const t = 1 - smoothstep(0, BERM_WIDTH_M, distToEdge);
  return t * t * BERM_HEIGHT_M;
}

// --------------------------------------------------------------------------------------------------
// Master height function -- the single source of truth for physics AND visuals.
// --------------------------------------------------------------------------------------------------

export function terrainHeight(x: number, z: number): number {
  const flat = flatMask(x, z);
  const berm = bermRise(x, z); // always 0 except within BERM_WIDTH_M of the +-400m field edge (see above)
  if (flat >= 0.9999) return berm;
  const loopW = loopRoadWeight(x, z);
  const spurW = spurRoadWeight(x, z);
  const natural = meadowUndulation(x, z) + dirtRoadProfile(x, z, loopW, spurW);
  // Fade the natural relief to 0 as we enter any hard-flat zone (apron/forest/buildings).
  return natural * (1 - flat) + berm;
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
