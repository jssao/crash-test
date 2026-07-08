# Car Concept (Khronos glTF-Sample-Assets)

- **File:** `CarConcept.glb` (11,778,688 bytes / 11.23 MiB)
- **Source URL (canonical, verified on page):** https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept
- **Direct download used:** https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CarConcept/glTF-Binary/CarConcept.glb
- **Author / rights holder:** Eric Chadwick (model and textures), © 2024 Darmstadt Graphics Group GmbH
- **Packaged/optimized by:** Khronos Group (glTF-Sample-Assets repository), using RapidPipeline 3D Processor v7.1.0
- **License:** CC BY 4.0 International (SPDX: `CC-BY-4.0`) — https://creativecommons.org/licenses/by/4.0/legalcode
  - Verified directly from the model's own `LICENSE.md` and `metadata.json` in the source repo (not an aggregator).
  - Attribution required: "Eric Chadwick — Model and textures", owner Darmstadt Graphics Group GmbH, 2024.
  - The Khronos logo and 3D Commerce logo appearing as material variants on the model carry a separate, non-open trademark notice (`LicenseRef-LegalMark-Khronos`) — these are Khronos/3D Commerce logos, not part of the redistributable CC-BY content. The model exposes multiple `KHR_materials_variants` material sets; prefer/select a non-logo variant for this project (avoid the branded livery variant) to sidestep the trademark question entirely.
- **Redistribution:** Explicitly permitted in a public repo under CC-BY-4.0 with attribution (include the credit above in any NOTICE/CREDITS shipped with the project).
- **Provenance note:** Originally derived from a public-domain (CC0) concept car model by "Unity Fan" (YouTube channel @unityfan777), then substantially reworked, optimized, and re-licensed CC-BY-4.0 by Khronos/Darmstadt Graphics Group as a glTF showcase asset (see README.body.md in the source repo for full history).
- **Retrieval date:** 2026-07-08

## Scene graph verdict (see inspect output below)
- 101 nodes / 97 meshes / 213,347 triangles / 29 materials / 14 textures (largest 2048x2048 PNG).
- **Wheels are separate top-level nodes**: `WheelFrontL`, `WheelFrontR`, `WheelRearL`, `WheelRearR`, each with child nodes `*Rim`, `*BrakePad`, `*BrakeDisc`. Non-negotiable requirement satisfied.
- **Body panels are separate nodes**: `BodyHood` (+ `BodyHoodInterior01/02`, `BodyHoodTopgrill`, `BodyHoodUnder`), `BodyDoorLColor1/2` + `BodyDoorRColor1/2` (+ handles, mirrors, windows per side), `InteriorRearHatch`, `BodyRoofPanel`, `BodyRearPanelsColor1`, `BodyPanelsColor2`, `BodyPillars`, `BodyHeadlights`, `BodyTaillights`. Preferred requirement satisfied, not just a fallback.
- Uses `KHR_materials_variants`, `KHR_materials_clearcoat`, `KHR_materials_transmission`, `KHR_materials_iridescence`, `KHR_materials_emissive_strength`, `KHR_texture_transform`.

## Inspection commands used
```
npx --yes @gltf-transform/cli inspect CarConcept.glb
# plus a custom @gltf-transform/core script to dump node names / triangle totals
```
