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

## Total staged size
~24MB (car ~11.2MB, HDRIs ~11.9MB combined) — well within the ~150MB budget.
