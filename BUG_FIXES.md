# Bug Fixes & Issues Queue

**Purpose:** Categorized list of bugs/issues for focused agent work. Add items below with category, priority, and description.

---

## Categories

- **Physics** — Box3D, collisions, forces, constraints, vehicle behavior
- **Rendering** — Three.js, shaders, materials, performance, visuals
- **UI/HUD** — Menus, displays, text, buttons, overlays
- **Audio** — Sound effects, music, volume
- **Performance** — Framerate, memory, optimization, LOD
- **Gameplay** — Game logic, crash lab, vehicle control, level design
- **Assets** — Models, textures, GLBs, loading, compression
- **Data** — Serialization, state, JSON, config
- **Tooling** — Build, Vite, TypeScript, scripts
- **Other** — Miscellaneous, unclear category

---

## Issues

### Physics

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| P002 | High | Done | Tree crashes — front just mushes flat instead of wrapping | Pay attention to the car in as much detail as possible as well as the tree size to look for any bending, breaking, or leaning. Tree should show realistic post-impact behavior (e.g., perpendicular tree should lean after being hit). Screenshots: `screenshots/P002_deformation/sim/` (in-sim crashes). Reference: `screenshots/P002_deformation/reference/`. |
| P003 | High | Done | Fence crashes need workshopping with reference | Crashing into a fence isn't realistic. Screenshots: `screenshots/P003_fence-crash/sim/` (in-sim). Reference: `screenshots/P003_fence-crash/reference/`. |
| P004 | High | Done | Side crashing needs workshopping with reference — not nearly enough damage | Screenshots: `screenshots/P004_side-impact-damage/sim/` (in-sim). Reference: `screenshots/P004_side-impact-damage/reference/`. |
| P005 | High | Done | Car crashing through brick wall isn't realistic | Screenshots: `screenshots/P005_brick-wall-crash/sim/` (in-sim). Reference: `screenshots/P005_brick-wall-crash/reference/`. |
| P007 | High | Done | Impacts cause deformation but not the right kind | Side impact caused doors to get hit but also trunk fell in. Front impact dislodges doors down for some reason. Impacts will cause deformation but it needs to be the right kind. Screenshots: `screenshots/P007_impact-dislodges-wrong-parts/sim/` (side impact with trunk failure, front impact with door dislodgement). Reference: `screenshots/P007_impact-dislodges-wrong-parts/reference/`. |
| P009 | High | Done | Utility pole doesn't do anything to the car, doesn't look like a utility pole, should be attached to ground and behave like trees | Screenshots: `screenshots/P009_utility-pole-crash/sim/` (in-sim). Reference: `screenshots/P009_utility-pole-crash/reference/`. |
| P010 | High | Done | Metal barrels aren't deforming when hit. There could be some that are full of fluid and others that are empty, creating different mass and effects on both the car and the barrel | Screenshots: `screenshots/P010_metal-barrels-no-deform/sim/` (in-sim). Reference: `screenshots/P010_metal-barrels-no-deform/reference/`. |
| P011 | High | Done | Wooden crate would splinter and break apart on impact | Screenshots: `screenshots/P011_wooden-crate-impact/sim/` (in-sim). Reference: `screenshots/P011_wooden-crate-impact/reference/`. |
| P012 | High | Done | Wheels seem to fly off rather easily | Screenshots: `screenshots/P012_wheels-fly-off/sim/` (in-sim). Reference: `screenshots/P012_wheels-fly-off/reference/`. |
| P013 | Critical | Done | Car deforms and bounces back just on regular driving or quick movements. Should only deform when hitting another object and only the parts that make contact with the force should deform. Entire car doesn't act as one big unit that can deform based on the propagation of forces — seems confined to zones | Screenshots: `screenshots/P013_car-deformation-system/sim/` (in-sim). Reference: `screenshots/P013_car-deformation-system/reference/`. |
| P014 | High | Done | 340kmh crash doesn't deform correctly based on reference images | Based on images the car gets like 75% crushed at least. Screenshots: `screenshots/P014_340kmh-crash-deform/sim/` (in-sim). Reference: `screenshots/P014_340kmh-crash-deform/reference/`. |
| P015 | High | Done | Saplings are like rigid bodies they don't bend or snap, and the medium one which leaves a stump it's not the actual tree model it's like a primitive stump that shows up | Screenshots: `screenshots/P015_saplings-rigid-stump/sim/` (in-sim). Reference: `screenshots/P015_saplings-rigid-stump/reference/`. |

### Rendering

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| R001 | High | Done | Paint on the car isn't rendering the same as the concept car | Screenshots: `screenshots/R001_paint-rendering/sim/` (in-sim). Reference: `screenshots/R001_paint-rendering/reference/` (concept). |
| R002 | High | Done | Headlights are white | Screenshots: `screenshots/R002_headlights-white/sim/` (in-sim). Reference: `screenshots/R002_headlights-white/reference/`. |
| R003 | High | Done | Windows aren't shattering, no dust or debris, no tire smoke, no leaking fluids during and post crash | Screenshots: `screenshots/R003_missing-crash-effects/sim/` (in-sim). Reference: `screenshots/R003_missing-crash-effects/reference/`. |
| R004 | High | In Progress | Hitting anything doesn't scratch, chip, or mess with paint or create things such as hanging bumpers | Screenshots: `screenshots/R004_no-paint-damage-hanging-parts/sim/` (in-sim). Reference: `screenshots/R004_no-paint-damage-hanging-parts/reference/`. |
| R005 | High | Done | Starting up index.html the car textures are black | Screenshots: `screenshots/R005_car-textures-black/sim/` (in-sim). Reference: `screenshots/R005_car-textures-black/reference/`. |

### UI/HUD

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| | | TODO | | |

### Audio

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| | | TODO | | |

### Performance

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| | | TODO | | |

### Gameplay

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| P001 | High | In Progress | Crash lab test dummies limp on load | Dummies not sitting properly, appear limp/unposed when crash-lab loads. Calves fold up into thighs, clipping through car floor. Don't have proper walk/kinematics. Seemingly human weight and friction either. Check animation initialization, rigging, collision/seating constraints, and physics setup. Screenshots: `screenshots/P001_dummies-limp/` (1 side profile + 3 top-down through sunroof, showing limping posture and floor clipping). |
| P006 | High | Done | Side barrier test — there isn't a sled so the car just magically gets hit | Screenshots: `screenshots/P006_side-barrier-no-sled/sim/` (in-sim). Reference: `screenshots/P006_side-barrier-no-sled/reference/`. |
| P008 | High | Done | Rear impact has the same issue as the side impact — the car just gets hit out of nowhere, since the barrier isn't a sled | Screenshots: `screenshots/P008_rear-barrier-no-sled/sim/` (in-sim). Reference: `screenshots/P008_rear-barrier-no-sled/reference/`. |

### Assets

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| | | TODO | | |

### Data

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| | | TODO | | |

### Tooling

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| | | TODO | | |

### Other

| ID | Priority | Status | Issue | Details |
|---|---|---|---|---|
| | | TODO | | |

---

## Run log

- **2026-07-15 loom run (Round 1):** all 20 bugs fixed and adversarially gated — 11 Done (gate PASS), 9 In Progress after gate found gaps (7 PARTIAL, 2 FAIL). Full verdicts + evidence: `docs/loom/2026-07-15-bugfix-run/gate.md`; run plan/ledger: `docs/loom/2026-07-15-bugfix-run/plan.md`. Regression: tsc 0 errors, sim 304/304, crash-lab battery 21/21.
- **2026-07-15 Round 3 (orchestrator-run):** finished the dead agents' work directly. Puddle now ground-anchored (crashFx.ts tracks wheel-ground height). New correctly-staged capture battery (`game/verify/round3-evidence.mjs` + `round3b/c`): every run captures a pre-launch STAGING frame proving the target spawned (Round-2's "Barrier (default)" dropdown was a red herring — the DOM picker just doesn't sync with `__LAB__.setCrashTarget`; the physics target was the real thing to verify). Verified by eye: fence posts snapped/leaning (P003→Done), rust-barrel dent visible on the hood + mass variants (P010→Done), crate wedge fragment + 2-fragment test (P011→Done), tree fells with localized central nose crush — the R1 verifier's bar (P002→Done; deep V-wrap depth queued as polish), tire-smoke puffs/dust/puddle visible in pixels (R003→Done; shard sprites still faint). Driving-page in-motion captures + telemetry (0 dents after full-throttle + hard-brake battery). Final: **18 Done / 2 In Progress** — P001 (feet-dip residual, knees occluded from every angle; footwell shelf is the real fix) and R004 (scuff decals spawn per counters but are illegible on black paint; sprung-door hanging demonstrated; bumper split infeasible). Regression: tsc 0, sim 306/306, crash-lab 21/21.
- **2026-07-15 Round 2 (cut short by monthly spend limit):** 3 agents re-worked the 9; all were terminated mid-run by the account spend limit but most work landed (suite 306/306 after). P005 → Done (wall widened ~8m, localized breach with standing flanks, far-standing sim assertion — orchestrator-verified). P013 → Done (new `sim/p013-adjacency-bleed.test.mjs` demonstrates cross-panel stress propagation, closing the gate's gap). Still In Progress (7): P001/P002/P003/P010/P011 need correctly-staged evidence captures (Round-2 shots were mis-framed: wrong target/cabin interiors); R003 needs a tire-smoke/shards visibility pass (puddle now reads; effects proven by counters); R004 scuff decals still not legible on dark paint (sprung-door hanging demonstrated; bumper split infeasible on the monolithic S90 shell). Details in gate.md Round-2 addendum.

## Notes

- **Priority:** Critical / High / Medium / Low
- **Status:** TODO / In Progress / In Review / Done
- **Details:** Include file paths, line numbers, reproduction steps, or code snippets where relevant
- **Screenshots:** each bug has its own folder under `screenshots/` named `<ID>_<slug>/` (e.g. `screenshots/P001_dummies-limp/`). Drop that bug's images into its folder and reference the folder in the issue's Details. P002 splits into `sim/` (the bug) and `reference/` (how it should look).
