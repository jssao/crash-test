# Asset Credits (game/public/assets)

Assets copied (not moved) from `../assets-src/` — see that directory's `CREDITS.md` and per-asset
`SOURCE.md` files for full provenance/checksums. Summary:

- **Car (hero — active):** `assets/car/volvo-s90.glb` — exported Volvo S90 4-door sedan (377,054
  verts / 127 objects, dims 5.00 x 2.01 x 1.43 m). Node-named per car-map.ts conventions (BodyShell,
  Hood, Trunk, DoorL/R + DoorRL/RR, EngineBlock, WheelFL/FR/RL/RR, Windshield, RearWindow, QuarterGlass)
  so `scripts/analyze-car.mjs`'s `volvoS90` CONFIG can re-derive the car-map without hand-editing. No
  third-party trademarked textures found needing load-time sanitization.
- **Car (retired — 2026-07-11 swap, kept for reference/legacy model-viewer entries):**
  `assets/car/mustang65.glb` — "Rigged Car Mustang 1965 with Engine", Godspeed (Sketchfab,
  @godspeedx14). License: CC BY 4.0 International. Attribution: "Rigged Car Mustang 1965 with Engine"
  by Godspeed (@godspeedx14) —
  https://sketchfab.com/3d-models/rigged-car-mustang-1965-with-engine-3d-model-c2d4f0a6170d43f4a5a8303373ebb81a
  - The source ships as ONE skinned mesh (bone-weighted panel/wheel/engine regions).
    `scripts/split-mustang.py` (deterministic Blender headless) splits it by vertex group into separate
    named rigid parts (BodyShell, Hood, Trunk, DoorL/R, EngineBlock + Drivetrain, WheelFL/FR/RL/RR,
    Windshield, RearWindow), rescales to the real 1965 Mustang wheelbase (2743mm), and reorients into
    the game frame. This is a mechanical re-packaging of the CC-BY asset for the physics/damage system;
    no third-party trademarked textures are present in this model (all flat colour factors), so no
    load-time texture sanitization is needed for it.
- **Car (concept — retained, licensed fallback, not currently loaded):** `assets/car/CarConcept.glb` —
  "Car Concept", Eric Chadwick (model & textures), © 2024 Darmstadt Graphics Group GmbH, packaged by
  Khronos Group (glTF-Sample-Assets). License: CC BY 4.0 International. Attribution: "Eric Chadwick —
  Model and textures", Darmstadt Graphics Group GmbH, 2024.
  - The file exposes `KHR_materials_variants` (Carmine Candy / Pearly Swirly / Torched Graphite — none
    of the three variant *names* reference Khronos branding). Separately, and NOT gated by that
    extension, the file's "License" material (license-plate decal) and "Tireside" material (tire
    sidewall decal) embed a Khronos Group / 3D Commerce trademarked logo texture regardless of which
    variant is selected. `src/scene/car.ts` neutralizes those texture slots at load time (see
    `scripts/analyze-car.mjs`'s `carConcept` config) so no trademarked logo is ever rendered when this
    fallback car is wired in.
- **HDRIs:** `assets/hdri/derelict_airfield_01_2k.hdr` (active default — Alexander Scholten, Poly
  Haven, CC0) and `assets/hdri/overcast_industrial_courtyard_2k.hdr` (staged, not currently loaded —
  Grzegorz Wronkowski, Poly Haven, CC0). Attribution not legally required for CC0, recorded anyway.
