# Asset Manifest — Environment Overhaul Sourcing Pass

Acquisition-only pass (no code changes). All files staged under `assets-src/`,
not yet wired into `game/src`. Total staged: **157MB** (budget was ~150MB;
~5% over, flagged — trim candidate is `terrain/` displacement maps if a hard
cap is enforced later). Every license below was verified on the asset's own
source page at retrieval time (2026-07-09), not assumed from site-wide policy.

## 1. Terrain textures — `assets-src/terrain/` (70MB, 5 sets)

All from Poly Haven, all **CC0 1.0 Universal** (https://polyhaven.com/license),
2k JPG, 2048x2048 confirmed by binary JPEG-header parse. Each set has
diffuse + OpenGL-space normal (`nor_gl`) + roughness + displacement.

| Set | Dir | Source | Notes |
|---|---|---|---|
| Muddy Tracks | `muddy_tracks/` | https://polyhaven.com/a/muddy_tracks | Tire-tracks/ruts character — matches "mud with potholes" brief item |
| Forest Floor | `forest_floor/` | https://polyhaven.com/a/forest_floor | Leaf litter + dirt |
| Stony Dirt Path | `stony_dirt_path/` | https://polyhaven.com/a/stony_dirt_path | Dirt road candidate |
| Sparse Grass | `sparse_grass/` | https://polyhaven.com/a/sparse_grass | Patchy grass (dirt showing through) |
| Mud Cracked Dry 03 | `mud_cracked_dry_03/` | https://polyhaven.com/a/mud_cracked_dry_03 | Dry cracked mud, secondary pothole-adjacent texture |

Author attribution not required under CC0 but each asset's author is listed
on its Poly Haven page (varies per texture; see per-page credit — not
duplicated here since CC0 carries no attribution obligation).

## 2. Trees — `assets-src/trees/` (12MB + bark below)

### Kenney Nature Kit — `trees/kenney-nature-kit/GLTF/` (3.7MB, 329 GLB files)
- **Source:** https://kenney.nl/assets/nature-kit (direct zip, no login)
- **License:** CC0 1.0 (license text bundled at `LICENSE.txt`, confirmed on kenney.nl page)
- **Author:** Kenney (www.kenney.nl)
- **Content used:** `tree_pineSmallA-D` (small class), `tree_default`/`tree_detailed`/`tree_pineDefaultA-B` (medium class), `tree_pineTallA-D`/`tree_tall` (tall class) — 3 size classes present as required. Also covers shopping-list item 3 (rocks/stumps/logs/bushes — see below).
- **Separability:** Verified by parsing GLB JSON chunk directly (node script, not just visual inspection): each tree is 1 mesh with 2 primitives sharing one POSITION accessor but **separate index buffers per material** (`woodBarkDark` trunk vs `leafsDark`/`leafsFall` canopy) — e.g. `tree_pineTallA.glb` has primitive 0 → material 0 (trunk), primitive 1 → material 1 (canopy), 136 shared vertices, distinct index accessors (3 vs 4). This is "clean enough to split" per brief, not true separate meshes.
- **Important honesty note:** these are flat-shaded low-poly (`baseColorFactor` only, no `images`/`textures` in the GLTF at all — confirmed via JSON inspection). They are **not textured/photoreal**; they satisfy "game-ready" but not "realistic" on their own.

### Bark texture (for reskinning Kenney trunks, or any custom trunk mesh) — `trees/bark_brown_01/` (8.7MB)
- **Source:** https://polyhaven.com/a/bark_brown_01 — Poly Haven, **CC0 1.0**
- diffuse + nor_gl + roughness, 2k, 2048x2048 confirmed
- **Why:** pairs with the Kenney low-poly trunks to give a realistic bark option without the enormous file cost of Poly Haven's full tree models (see rejected candidates below).

### Rejected/evaluated: Poly Haven realistic tree models (NOT staged)
Poly Haven has genuinely photoreal tree models with separate bark/trunk-variant/twig
materials (`pine_tree_01`, `fir_tree_01`, `pine_sapling_medium`, `pine_sapling_small`)
— exactly the "separable trunk vs canopy" structure wanted. **Rejected purely on
size**: their baked geometry (`.bin`) is enormous and scales steeply with tree size:
- `pine_sapling_small.bin` = 17.8MB (only this one is reasonable)
- `pine_sapling_medium.bin` = 263MB
- `pine_tree_01.bin` = 949MB
These are geometry-nodes/photogrammetry bakes with no LOD — not game-ready without
external decimation (out of scope for an acquisition-only pass). Documented here
so the team doesn't re-discover and re-download them expecting a normal texture-set size.

## 3. Rocks/boulders + forest scatter — `assets-src/rocks/` (12MB) + Kenney above

### Poly Haven realistic hero rocks/stump — `rocks/{boulder_01,rock_07,tree_stump_01}/`
- **License:** CC0 1.0 — https://polyhaven.com/a/boulder_01, /a/rock_07, /a/tree_stump_01
- 1k glTF + textures (diff/nor_gl/arm), each single-mesh, single-material, validated
  by parsing the `.gltf` JSON (mesh/accessor counts printed, no parse errors).
  Sizes: boulder_01 5.8MB, rock_07 2.2MB, tree_stump_01 3.9MB.
- **Intended use:** close-up "hero" scatter props (crash obstacles, foreground detail).

### Kenney Nature Kit (bulk scatter) — already covered above, same GLTF folder
`rock_largeA-F`, `rock_smallA-I`, `rock_smallFlatA-C`, `rock_tallA-J`, `stump_old`,
`stump_oldTall`, `stump_round(Detailed)`, `stump_square(Detailed/Wide)`, `log`,
`log_large`, `log_stack(Large)`, `plant_bush(Detailed/Large/Small/Triangle variants)`
— all CC0, all bulk/background scatter density. No extra download needed; this
single pack satisfies shopping-list item 3 in full.

## 4. Building material textures — `assets-src/buildings/` (32MB, 4 sets)

All Poly Haven, **CC0 1.0**, 2k JPG, 2048x2048 confirmed. Diffuse + nor_gl +
roughness only (displacement skipped for these — flat-wall use case doesn't
need it as much as terrain does; cut to stay near budget).

| Material | Dir | Source |
|---|---|---|
| Brick (red) | `brick_red/` | https://polyhaven.com/a/red_brick |
| Plaster wall | `plaster_wall/` | https://polyhaven.com/a/plastered_wall |
| Wood planks | `wood_planks/` | https://polyhaven.com/a/wood_planks |
| Corrugated iron (roofing) | `corrugated_iron/` | https://polyhaven.com/a/corrugated_iron — also includes a `metal` (metalness) map, useful for a proper roofing shader |

## 5. HDRI — `assets-src/hdri/je_gray_02_2k.hdr` (7.8MB, new)

- **Source:** https://polyhaven.com/a/je_gray_02 ("J&E Gray 02")
- **License:** CC0 1.0 Universal
- **Why this one:** Poly Haven categorizes it `high contrast` + `morning-afternoon`
  + `nature` (tags: forest, grass, pine, sun) — a sunny rural/forest daylight sky
  with real directional sun, as requested as an alternative to the current
  `derelict_airfield_01` (industrial/runway). Both prior HDRIs (`overcast_industrial_courtyard`,
  `derelict_airfield_01`) are untouched/still present.
- Verified: `file` reports valid Radiance HDR image data.

## 6. Car — evaluation only, nothing new staged, no integration

Current in-repo car (`car/CarConcept-Khronos/CarConcept.glb`, CC-BY-4.0, 213k tri,
separate wheel/panel nodes) was re-evaluated against fresh candidates:

| Candidate | License | Verdict |
|---|---|---|
| Sketchfab "Real Car 4 Separated Parts" (Maker Games Studios) | **Paid** (unitypackage/obj/fbx behind purchase) — confirmed on page, no free tier | Disqualified — not free |
| BlendSwap Lamborghini Miura (blend/13849) | Unknown — page returns HTTP 403 without an account login (confirmed via `curl -I`, no license visible pre-auth) | Can't verify license without creating an account; per project boundary (no account signups), not fetched |
| Sketchfab "Lotus 7 (CC0)" by britdawgmasterfunk | CC0 (per page title/tag) | Same as prior handoff finding — requires a Sketchfab account to download; not fetched, still just a documented option |
| Sketchfab Unity Fan "FREE Concept Car" series (e.g. `free-concept-car-025`) | CC0 ("public domain... can be used by anybody for anything") | This is the same CC0 lineage the current CarConcept was derived from before Khronos's CC-BY repackaging — no separate download attempted since it requires a Sketchfab account and offers no clear upgrade (no confirmed interior/panel separation info without downloading) |
| Poly Haven models catalog | N/A | Searched — no realistic drivable car; only "Covered Car" (car under a tarp, geometry not exposed as a vehicle) exists |

**Honest conclusion: no candidate beats the current Khronos CarConcept (CC-BY-4.0)
under these constraints** (free, no-signup-required license verification, separable
panels + interior). The one model with confirmed separate panels/interior/wheels
richer than CarConcept ("Real Car 4 Separated Parts") is paid, disqualifying it.
Recommend keeping CarConcept; revisit only if the team is willing to create Sketchfab/
BlendSwap accounts to unlock the CC0-tagged candidates above for direct inspection.

## Verification method (for all categories)

- Textures: binary JPEG SOF-marker parse (`struct.unpack` on the file bytes) to
  confirm actual pixel dimensions match the "2k" label — not just trusting the filename.
- glTF/GLB: parsed JSON (`.gltf`) or GLB JSON chunk (`.glb`, via header offset
  read) with Node, checked `meshes`/`accessors`/`materials`/`nodes` counts and,
  for the Kenney trees, compared primitive index buffers to confirm trunk/canopy
  separability rather than assuming it from the filename.
- HDRI: `file` confirms valid Radiance HDR data.
- License: read directly off each asset's own Poly Haven / kenney.nl page (or,
  for Kenney, the bundled `LICENSE.txt` inside the downloaded zip) at retrieval
  time — no site-wide license assumed.

## Gaps / honesty notes

- Total is 157MB vs the ~150MB target (~5% over) — flagged, not silently ignored.
- Terrain and buildings intentionally use 2k JPG (not EXR/PNG) to control size;
  displacement was kept for terrain (potholes/ruts matter there) but dropped for
  building materials.
- Trees are CC0 but stylized/flat-color (Kenney), not photoreal — the photoreal
  Poly Haven trees exist but are 20-950MB each and were rejected on size; this is
  a real gap against the "realistic-but-game-ready" ask, documented rather than
  quietly substituted.
- Car candidates search only turned up two directions: a paid model (disqualified)
  or account-walled CC0/unknown-license models (not fetched, per no-signup
  constraint) — genuinely empty of an actionable free-and-clear upgrade.

## Addendum (2026-07-09, tree-visuals task): leaf-cutout atlas acquisition

The "trees are stylized/flat-color, not photoreal" gap noted above (and the toy cone-canopy
placeholder it produced in `game/src/world/features/trees/visuals.ts`) is addressed for the
canopy specifically — not by staging one of the previously-rejected 20-950MB full tree models,
but by extracting just the **leaf-cutout texture atlas** from a *different*, much smaller Poly
Haven tree model that exposes its maps individually via the Files API:

- Queried `api.polyhaven.com/assets?t=models` for tree-tagged assets, found `tree_small_02`
  ("Tree Small 02", category Nature/Trees/Broadleaf Trees, author Rico Cilliers) exposes
  `leaves_diff` / `leaves_alpha` / `leaves_nor_gl` (+ `leaves_rough`/`leaves_arm`/`leaves_ao`, not
  retrieved) as **separate downloadable files independent of the model's own huge baked
  geometry** — confirmed via `api.polyhaven.com/files/tree_small_02` before downloading anything.
  Retrieved only `leaves_{diff,alpha,nor_gl}` at 1k (1024x1024 confirmed via `file`), ~1.29MB
  total — staged at `assets-src/trees/tree_small_02_leaves/`.
- Visually verified via the asset's own 512x512 CDN thumbnail (a full deciduous tree with a
  round, airy clustered-leaf canopy — matches the "Broadleaf Trees" category) before committing
  to using its leaf atlas; confirmed the atlas itself (viewed directly, both diffuse and alpha
  channel) packs a dense field of individually alpha-cut leaf-on-twig clusters plus a solid
  opaque leaf-mass fill region, exactly the two card types a cross-quad canopy needs.
  **License: CC0 1.0 Universal** (Poly Haven, same as every other asset in this manifest) —
  verified on the asset's own page/API metadata, not assumed.
- The already-staged `trees/bark_brown_01/` (this manifest, section 2) was, at the time of the
  original acquisition pass, staged but **not yet wired into any trunk material** — the
  cone-canopy placeholder used a small 128x128 procedural `CanvasTexture` bark instead. The
  tree-visuals pass now actually uses the real staged `bark_brown_01` PBR set for trunks (UV-tiled
  per trunk class in code, not `Texture.repeat`, since one shared bark material spans very
  different sapling/mid/large trunk radii). No new download for bark — it was already sitting in
  `assets-src/` unused.
- No other new downloads. Total added to the previously-flagged 157MB staged total: ~1.29MB
  (leaf atlas only; bark was already staged).
