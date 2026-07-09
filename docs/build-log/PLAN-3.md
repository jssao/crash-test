# loom run plan + ledger — RUN 3: feel + fidelity (user playtest feedback 2026-07-09)

Orchestrator: Fable 5. Predecessor: PLAN-2.md (RUN 2 complete, then reopened twice by user playtest).
NEW DOCTRINE (user directive): a director-grade model judges every wave — Fable (orchestrator)
personally reviews player-view screenshots of every runtime state before anything is called done;
hardest root-cause work runs on Opus. Cheap gates only check enumerable facts, never visual truth.

## Completion condition

1. **Reset integrity (blocker, user repro)**: crash at speed → Shift+R (and → R) leaves the car
   visually pristine — every panel/part/wheel/occupant back at spawn pose. Check: browser test
   crashes 100km/h, resets, asserts per-panel visual world pose within 5cm/5° of first-spawn
   reference AND screenshot reviewed by orchestrator. ×5 cycles. Exit 0.
2. **Click-drag camera**: mouse drag orbits the camera around the car, wheel zooms; C still toggles
   chase; feels smooth (damped). Check: CDP drag test moves camera azimuth/height; eyes-on.
3. **Suspension feel**: visible dive under braking, squat on launch, roll in corners, spring
   oscillation settling after a jump landing — measured suspension travel ≥40% of available range
   in hard maneuvers (telemetry trace) without regressing stability tests. Eyes-on video-frames.
4. **Destruction feel**: structures bend/yield before breaking (wood studs crease, drywall dents
   via vertex deformation before panel-detach, metal parts stay bent), debris velocity scales with
   impact energy, no uniform "pop". Check: staged-impact sim traces (low/mid/high energy → distinct
   outcomes) + eyes-on crash screenshots.
5. **Engine bay looks like an engine bay**: shaped procedural parts (finned radiator, turbo w/
   housing+piping, bent hoses, valve-cover block, battery w/ terminals...) replacing box proxies;
   hood-off screenshot reads as machinery. Orchestrator eyes-on.
6. **Environment fidelity**: trees, ground, and buildings raised to read believably alongside the
   car (bark/foliage, asphalt/grass blend, wood grain/brick/roofing materials, skyline) — no more
   "cones on cylinders". Orchestrator eyes-on vs before/after shots.
7. **Car model**: evaluate higher-fidelity permissively-licensed replacements (or material/paint
   upgrade of CarConcept); adopt only if separable panels + license hold. Decision documented.
6b. **World scale + terrain** (user directive): playable environment ≥4× current content area; a
    forest region; ground is TERRAIN (box3d heightfield) with dirt surface and variance — potholes,
    bumps, undulation — that visibly exercises the suspension. Check: heightfield binding validated
    by dedicated tests (currently wired-but-never-exercised); drive trace shows per-wheel suspension
    deflection variance on the dirt; eyes-on.
6c. **Sourced assets**: use good free (CC0/CC-BY) models/textures where they beat procedural —
    Poly Haven textures/HDRIs, Quaternius/Kenney kits, etc. License verified + credited per asset
    in a manifest + CREDITS.md. No unlicensed downloads.
8. All existing suites + perf gates stay green (52 files/84+ tests, <8ms, ≥55fps headed) — perf
   re-gated at 4× world scale.

Bound: 3 passes per wave; orchestrator eyes-on review is part of EVERY gate. Re-dispatch ≤2/slice.

## Budget

RUN 1+2 actual ≈ 6.0M subagent tokens (~13-14% usage). RUN 3 revised (terrain + 4× world + sourcing
added): **~7-8M ≈ +16-18% usage** (wave 1 reset+camera 0.7 · wave 2 suspension+destruction 1.5 ·
sourcing+heightfield spike 0.8 · wave 3 terrain/4×world/environment/engine-bay 3.5-4.5 ·
director/gates 0.5). Opus for root-cause + design judgment; sonnet mechanical; Fable directs eyes-on.
MODEL-TIER NOTE (user question answered): RUN 1-2's all-sonnet workers + haiku gates came from
loom's cost-tiering doctrine applied conservatively, not a user-imposed cap; per-dispatch upgrades
were always available and are now standard for judgment-heavy slots.
Cut lines if hot: car-model replacement eval → building facades → destruction polish depth.
NEVER cut: reset integrity, camera, suspension feel, terrain.

## Phase status ledger

| Wave | Work | Tier | Status | Tokens | Notes |
|---|---|---|---|---|---|
| W1a | Reset-integrity root-cause + fix | opus | **done** | (wf 355,623 w/ W1b) | commit 4dc611f: repairPanelVisual restored panels under car.root but authored parents are intermediate GLB groups w/ -90° rotation → saved local pose in wrong frame; wrecked visuals, all hooks green. Restores to captured originalParent; 0.00cm/0.00° ×7 cycles; regression red-checked. |
| W1b | Click-drag orbit camera | sonnet→fable inline | **done** | (merged W1a) | worker's code worked but returned garbage report; orchestrator verified+committed (3fcfe2c). USER BUGS (inverted axes + click-snap) fixed inline by orchestrator (5b69667): signs flipped, takeover seeds sphericalFromCameraPose; 17/17 asserts incl. permanent no-snap guard. |
| W2a | Suspension feel | sonnet xhigh | **done** | (wf 1,008,433 shared) | commit 93bd161: ROOT CAUSE — spring hertz computed vs wheel's 22kg (not corner load) → equilibrium beyond travel → car sat pinned on bump-stop LIMIT with zero compliance ("collapses on wheels"). Hertz 3→6, travel ±0.12→±0.14; dive 1.84°, squat 1.36°@50.8% travel, roll 1.59°@1.05g, landing 7 decaying half-cycles. BONUS vendor gap: WheelJoint motors never wake sleeping bodies → frozen-car-at-rest; input-wake added. 0-100 honestly faster (5.35s) from real launch squat. |
| W2b | Destruction feel | **opus** xhigh | **done** | (shared) | commit b2924e5: baseline measured (30km/h nudge flung 105/120 bricks 14m!) → per-material plastic-yield state machine (lean/bulge/crease before break; ductile studs/posts stay bent), impulse-clamped debris, per-material restitution/friction; staged signatures 30/70/120km/h: broken 1/25/32, debris 6.3/21/43 m/s; mid trees lean 4.7°@40 fell@80. bench 0.430ms avg. |
| W3-pre | Asset sourcing | sonnet | **done** | (shared) | commit 761fc2e: 157MB CC0 — 5 Poly Haven terrain sets (2k, dim-verified), Kenney nature kit (329 GLBs, trunk/canopy separable), 3 hero rocks, 4 building material sets, forest HDRI. Honest gaps: Kenney trees flat-shaded low-poly; NO license-clear car upgrade exists (negative result documented). |
| W3-pre | Heightfield spike | sonnet | **done** | (shared) | commit ffe485f: binding VALIDATED no bugs — row-major, corner-origin (docs in tests); 256×256/400×400m creates 4.06ms, 0 heap surprise; bit-identical determinism; drive test 27-30× suspension variance vs flat. Terrain wave GO. |
| W-ragdoll | Active ragdolls (brace/eject-through-glass/self-preserve) | **opus** (animation specialist) | dispatched | | |
| W3a | Terrain: 400×400m heightfield world (dirt, potholes, forest zone) | **opus** | dispatched | | |

## Pass log
