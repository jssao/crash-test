# Asset Credits

Assets staged under `assets-src/` for the browser crash-sandbox driving game.
Not committed to git yet (staged for review) — see per-asset `SOURCE.md` files
for full provenance detail, checksums, and retrieval dates.

## Car model

### Car Concept — `car/CarConcept-Khronos/CarConcept.glb`
- **Author:** Eric Chadwick (model & textures), © 2024 Darmstadt Graphics Group GmbH
- **Packager:** Khronos Group, glTF-Sample-Assets repository
- **Source:** https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept
- **License:** CC BY 4.0 International — attribution required (credit above). Redistribution in a public repo is explicitly permitted.
- **Note:** originally derived from a CC0 public-domain concept car by "Unity Fan" (Sketchfab/YouTube @unityfan777), reworked and re-licensed CC-BY-4.0 by Khronos.
- **Intended use:** primary player/AI vehicle mesh. Realistic (non-cartoon) concept car, 213k triangles, 101 nodes / 97 meshes, 29 materials, 14 textures. Wheels (`WheelFrontL/R`, `WheelRearL/R` + rim/brake sub-nodes) and body panels (hood, both doors incl. handles/mirrors/windows, rear hatch, roof panel) are all separate scene-graph nodes — suitable for driving physics (wheel colliders) and destructible/openable panels. Model exposes `KHR_materials_variants`; select a non-Khronos-logo livery variant to avoid the separate trademark notice on the branded variant.

No backup car files were staged. The only other realistic candidates found
(Sketchfab: "Sedan (glb, with interior)" by 3DHA, "Mercedes GLB AMG" by
RADMATTER12, "Lotus 7 (CC0)" by britdawgmasterfunk, and the Unity Fan "FREE
Concept Car" series — the CC0 originals behind CarConcept above) all require
a Sketchfab account to download, so per project boundaries they were not
fetched; they're documented as user-fetchable options in the handoff report.
Stylized/low-poly kits (Kenney "Car Kit", also mirrored as "Eclair Assets Car
Kit GLB Pack" and OpenGameArt "Car Kit") were found and confirmed CC0 but
fail the realism requirement, so were treated as last-resort only per brief
and not staged.

## HDRIs (environment lighting)

### Overcast Industrial Courtyard — `hdri/overcast_industrial_courtyard_2k.hdr`
- **Author:** Grzegorz Wronkowski
- **Source:** https://polyhaven.com/a/overcast_industrial_courtyard
- **License:** CC0 1.0 Universal (Poly Haven — https://polyhaven.com/license)
- **Intended use:** neutral, soft overcast IBL lighting for general PBR car-paint/material validation (low-contrast, no harsh directional highlights).

### Derelict Airfield 01 — `hdri/derelict_airfield_01_2k.hdr`
- **Author:** Alexander Scholten
- **Source:** https://polyhaven.com/a/derelict_airfield_01
- **License:** CC0 1.0 Universal (Poly Haven — https://polyhaven.com/license)
- **Intended use:** open runway/asphalt driving-sandbox environment; source explicitly describes it as "high-contrast outdoor lighting for vehicle/aircraft" — good directional sun for specular highlights while driving.

Both HDRIs retrieved at 2k `.hdr` resolution (~5.5-6.2MB each); attribution
is not legally required for CC0 but is recorded here for good practice.

## Terrain textures (2026-07-09 environment-overhaul pass)

All CC0 1.0, Poly Haven, 2k JPG (diffuse + nor_gl + roughness + displacement),
2048x2048 verified: `terrain/muddy_tracks/`, `terrain/forest_floor/`,
`terrain/stony_dirt_path/`, `terrain/sparse_grass/`, `terrain/mud_cracked_dry_03/`.
Sources: https://polyhaven.com/a/muddy_tracks, /a/forest_floor,
/a/stony_dirt_path, /a/sparse_grass, /a/mud_cracked_dry_03.

## Trees, rocks, forest scatter (2026-07-09)

- `trees/kenney-nature-kit/GLTF/` — Kenney Nature Kit, 329 GLB models (trees at
  3 size classes, rocks, stumps, logs, bushes). CC0 1.0. Author: Kenney
  (www.kenney.nl). Source: https://kenney.nl/assets/nature-kit. License text
  bundled at `trees/kenney-nature-kit/LICENSE.txt`. Flat-shaded low-poly style
  (no image textures) — game-ready, not photoreal.
- `trees/bark_brown_01/` — Poly Haven CC0 bark texture (diff+nor_gl+rough, 2k)
  for reskinning trunks. Source: https://polyhaven.com/a/bark_brown_01.
- `rocks/boulder_01/`, `rocks/rock_07/`, `rocks/tree_stump_01/` — Poly Haven CC0
  photoreal hero rocks/stump, 1k glTF+textures. Sources:
  https://polyhaven.com/a/boulder_01, /a/rock_07, /a/tree_stump_01.

Full sourcing detail, size math, rejected candidates (Poly Haven's realistic
tree models, up to 949MB each, rejected on size), and verification method are
in `docs/build-log/specs/asset-manifest.md`.

## Tree canopy visuals pass (2026-07-09, tree-visuals task)

Replaced the flat-cone/canvas-bark canopy placeholder with real-photo card foliage. New asset:

- `trees/tree_small_02_leaves/` — leaf-cluster alpha-cutout atlas (diff + alpha + nor_gl, 1k
  JPG/PNG, 1024x1024 confirmed) extracted from Poly Haven's **Tree Small 02** geometry-nodes
  model. **CC0 1.0 Universal.** Source: https://polyhaven.com/a/tree_small_02 (category
  Nature/Trees/Broadleaf Trees). Author: Rico Cilliers. Only the `leaves_*` texture maps were
  retrieved via Poly Haven's public Files API (`api.polyhaven.com/files/tree_small_02`) — not the
  model's own multi-hundred-MB baked geometry, which this project has no use for (same "reuse the
  real texture, skip the enormous geometry bake" reasoning `bark_brown_01` above already
  documents). The atlas packs two distinct usable regions (verified by eye against the downloaded
  images, not assumed from the filename): a dense field of individually alpha-cut leaf-on-twig
  clusters (left ~40% of the image) used for outer/silhouette-facing canopy cards, and a solid
  fully-opaque leaf-mass fill (right ~10%) used for cheap interior canopy bulk — both sampled via
  fixed UV sub-rects in `game/src/world/features/trees/visuals.ts`, never tiled
  (`ClampToEdgeWrapping`). `bark_brown_01` (already staged above) is now actually wired into the
  trunk material (real tileable 2k PBR bark, UV-tiled per trunk class in code — see that file),
  replacing the earlier 128x128 procedural `CanvasTexture` placeholder.
- Total added: ~1.29MB (diff 340KB + alpha 265KB + nor_gl 682KB, all 1k) — negligible against the
  existing ~157MB staged budget.

## Building material textures (2026-07-09)

CC0 1.0, Poly Haven, 2k JPG (diffuse + nor_gl + roughness; corrugated iron also
has a metalness map): `buildings/brick_red/`, `buildings/plaster_wall/`,
`buildings/wood_planks/`, `buildings/corrugated_iron/`. Sources:
https://polyhaven.com/a/red_brick, /a/plastered_wall, /a/wood_planks,
/a/corrugated_iron.

## Additional HDRI (2026-07-09)

### J&E Gray 02 — `hdri/je_gray_02_2k.hdr`
- **Source:** https://polyhaven.com/a/je_gray_02
- **License:** CC0 1.0 Universal
- **Intended use:** sunny rural/forest daylight alternative to the industrial-
  toned HDRIs above (high-contrast, real directional sun).

## Car re-evaluation (2026-07-09)

No candidate beat the current CarConcept under license/access constraints.
Full comparison table (paid model disqualified, CC0/unknown-license Sketchfab
and BlendSwap candidates account-walled and not fetched) is in
`docs/build-log/specs/asset-manifest.md`.

## Total staged size
~157MB (car ~11MB, HDRIs ~19MB, terrain ~70MB, buildings ~32MB, trees ~12MB,
rocks ~12MB) — ~5% over the ~150MB soft budget, flagged in the manifest.
