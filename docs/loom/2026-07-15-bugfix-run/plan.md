# Loom Run — BUG_FIXES.md execution (2026-07-15)

## GOAL (completion condition)

For each of the 20 open bugs in `BUG_FIXES.md` (P001–P015, R001–R005):

1. A code fix is implemented in `game/src/**`.
2. `npx tsc --noEmit` = 0 errors AND `npx vitest run sim/features-trees sim/features-buildings` all pass (plus any new sim tests added by the fix).
3. The bug's scenario is exercised via scripted crash (`__LAB__` API / stepN or sim test) and fresh screenshots are captured to `screenshots/<ID>_<slug>/sim/`.
4. An independent visual verifier (Opus+) AND the orchestrator's own eyes compare fresh sim screenshots against `reference/` and judge the bug behavior resolved (not merely "code changed").
5. `BUG_FIXES.md` status updated (In Review → Done only after gate).

**Check:** per-bug PASS/FAIL table in `gate.md` in this folder, with evidence paths.
**Constraints:** do NOT kill the user's dev server on :5173; do not break the 10 passing sim tests; keep edits consistent with RUN 4/5 architecture (damage/*, fracture.ts, structuralCrush.ts); no commits without user ask; Tree Pack license still pending — no publishing.
**Bound:** max 3 fix attempts per bug (model escalation Sonnet → Opus → Fable per attempt where applicable); if a bug still fails its gate after 3, mark BLOCKED with evidence and move on. Global stop if user signals budget cap.

## Waves (dependency-ordered)

| Wave | Slice | Bugs | Files owned | Tier (start) | Status |
|---|---|---|---|---|---|
| 0 | Scouts ×7 (read-only) | — | none | Sonnet | dispatched |
| 1 | S1 deformation core | P013 (Critical) | game/src/damage/*, scene/structuralCrush.ts | Opus | pending |
| 1 | S2 car visuals | R005, R001, R002 | car GLB load/materials, main.ts visual setup | Sonnet | pending |
| 1 | S3 dummies | P001 | world/features/occupants/* | Sonnet | pending |
| 1 | S4 sleds | P006, P008 | src/lab/main.ts scenario code | Sonnet | pending |
| 2 | S5 deformation behavior | P004, P007, P012, P014 | game/src/damage/* (after S1) | Opus | pending |
| 2 | S6 trees | P002, P015 | world/features/trees/*, fracture.ts | Sonnet | pending |
| 2 | S7 props/targets | P003, P005, P009, P010, P011 | lab/crashTargets.ts, world props | Sonnet | pending |
| 3 | S8 crash VFX | R003 | new fx module + damage/events.ts hooks | Sonnet | pending |
| 3 | S9 damage visuals | R004 | panels/welds visual states | Sonnet | pending |
| 4 | Regression + visual gate | all | none (verify only) | Opus + orchestrator eyes | pending |

File-conflict rule: one slice owns a file; cross-slice edits are reported back to orchestrator, not made.

## Harness facts (scout-verified, 2026-07-15)

- Sim tests: `cd game && npm run test:sim` (vitest, `sim/**/*.test.mjs`, ~35 suites incl. damage/crumple/wheel-detach/occupants/trees/buildings). New-test pattern: extend `DamageSim` (sim/damage-harness.mjs); `crash(speedKmh)` + `spawnWall(distanceAhead)`; needs `../../build/wasm/box3d.mjs`.
- Screenshots: custom CDP harness in `game/verify/` (headless Brave `--headless=new --use-angle=swiftshader`, raw WebSocket CDP; spawns `vite preview`). Key scripts: `shoot-crash.mjs`, `crash-lab.mjs` (7 protocols via `__LAB__.run(id)` + `stepN(600)`, multi-angle PNGs), `crash-realism/shoot-matrix.mjs` (multi-speed battery). Run with `node verify/<script>.mjs`.
- `window.__LAB__`: setCrashTarget/setCrashTargetDistance/stepN/protocols/run/readout/runState/exportReport/maxStructuralOffsetM/deformableSyncCheck/setCameraPreset/ready (lab/main.ts:532). `window.__GAME__`: spawnTestWall/crash/resetWorld/features (main.ts:602).
- Bug evidence inventory: reference images exist ONLY for P002(9), P003(7), P004(8), P005(15), P014(2+7seq); P001 has 4 loose sim PNGs. ALL OTHER sim/ and reference/ folders are EMPTY — fresh sim captures required for every bug; gates without references judge vs bug description + physical plausibility.
- `verify/` outputs are descriptive PNGs + console-report JSONs; bug screenshots/ were manual macOS captures (no script writes there).

## Ledger (fill per dispatch: agent, tier, tokens, result)

| Slice | Attempt | Model | Tokens | Outcome |
|---|---|---|---|---|
| scout-harness | 1 | sonnet | 86k | OK — CDP verify harness found; bug folders mostly empty |
| scout-occupants | 1 | sonnet | 116k | OK — knee hinge symmetric + unbraced; floorpan transparency deliberate; 55kg |
| scout-crashlab | 1 | sonnet | 111k | OK — P006/P008 = trolley visual never synced (physics sled exists) |
| scout-trees | 1 | sonnet | 140k | OK — large tree static by design; single-point crumple dent = "mush flat"; stump is primitive cylinder |
| scout-props | 1 | sonnet | 167k | OK — pole unrooted 40kg box; fence post fracture threshold above weld-pop; no prop dent/fracture for barrel/crate |
| scout-deform | 1 | sonnet | 174k | OK — elastic telemetry feeds crush visuals; crumple missing up-normal filter; direction=position-vs-origin bug; caps at ~200km/h |
| scout-render | 1 | sonnet | — | FAILED (API error) → re-dispatched |
| scout-render | 2 | sonnet | — | dispatched |
| S3 P001 fix | 1 | sonnet | — | dispatched |
| S4 P006/P008 fix | 1 | sonnet | — | dispatched |
| S6 P002/P015 trees fix | 1 | sonnet | — | dispatched (tree-side only; car-side wrap → S1) |
| S7a P003/P005 fence+brick fix | 1 | sonnet | — | dispatched |
| S7b P009/P010/P011 props fix | 1 | sonnet | — | dispatched |
| S1+S5 P013/P004/P007/P012/P014 deformation fix | 1 | opus | — | dispatched (merged slice, same files) |
| scout-render | 2 | sonnet | 216k | OK — "Car Paint" material never matched by stale Mustang regex (metal-1 black = R005+R001); no FX system except barrel sprites; events API mapped |
| S2 R005/R001/R002 car visuals fix | 1 | sonnet | — | dispatched; source fixes done, screenshots paused on S7b transient tsc break (self-resolves) |
| S3 P001 fix | 1 | sonnet | 411k | DONE — seated pose holds (asym knee limits, hinge spring 10Hz static, 77kg, seats +0.08); tests 287/288 (1 unrelated). RESIDUALS: feet still dip below floor line (footwell shelf blocked on terrain category-bit change, cross-slice); knee pose proven by sim test only — gate MUST capture interior/sunroof angle showing legs. |

| S7a P003/P005 fix | 1 | sonnet | 423k | DONE — fence posts fracture (620N/305N·m < weld-pop); brick wall 16×30=480 bricks 1.71m, local hole + partial far-standing; tests 287/288 (1 = S1 churn). RESIDUALS: far-section standing only ~15-19% (box3d binding lacks setConstraintTuning — engine limit, candidate binding follow-up); fence style is 2-rail ranch vs reference privacy fence (visual, out of scope); legacy 'wall-brick' lab prop untouched — consider aliasing it to the bonded wall post-wave. |

| S4 P006/P008 fix | 1 | sonnet | 371k | DONE — rig visual InterpolatedTransform sync + striped/orange sled faces + rigSyncCheck()/renderNow(); 12/12 verify PASS; 304/304 sim. RESIDUAL: trolleys coast forever post-impact (pre-existing, queued). |
| S8+S9 R003/R004 fx | 1 | sonnet | — | dispatched (after lab/main.ts freed) |
| S1+S5 deformation fix | 1 | opus | 481k | DONE — P013 plastic-only visuals + up-normal filter + ratchet corroboration + adjacency bleed (battery clean); P007 trunk radius 0.7m (normal-based direction tried+reverted, reasons logged); P012 detach needs ≥8m/s impact; P014 catastrophic tier to 94m/s (340km/h=2.03m lab crush, lower tiers byte-identical); P004 lateral visual amplify 1.8× (0.71m cave). Suite: tsc 0, 304/304, crash-lab 21/21. NEEDED-ELSEWHERE: deeper mechanical side crush = mdb trolley mass (lab/barriers.ts); index.html headless hangs at device auto-tune (main.ts hook wanted). |
| S6 P002/P015 fix | 1 | sonnet | 469k | DONE — large tree dynamic 1800kg + stiff weld (mass-registered); mid lean hertz 4→2 (off-axis lean works); sapling snap-in-half + GLB stumps (mid+sapling); +25 tests; 301/304 (3 = S7b in-flight). RESIDUALS: GLB stump reads sparse (source mesh sparse); lab can't stage angled tree hits. |

| S7b P009/P010/P011 fix | 1 | sonnet | 672k | DONE — pole=8.2m/420kg rooted capsule+cross-arm, snaps at 65kN; barrels 200kg full/20kg empty + numeric dents (subtle visually); crates splinter ≥90kg·m/s. 304/304. |

## PRE-GATE INTEGRATION — DONE (orchestrator, 2026-07-15)
- main.ts: foreignMasses now passed into createDestructibleWorld; stepDestructiblePoles/Crates + stepBarrelDents in doFixedStep; resetBarrelDents on world reset. visuals.ts: barrel geometry gets 8 height segments; new createBarrelDentEntries/stepBarrelDents/resetBarrelDents. tsc 0 errors; props/barrels/buildings suites 17/17.
- Known residual: a fractured pole/crate in the DRIVING game aliases its original full mesh to a fragment body (lab has proper stump/flyer visuals) — cosmetic, note for follow-up.

## Follow-up queue (post-gate decisions)
1. Footwell shelf (P001 full fix) — needs terrain heightfield category-bit change (cross-slice vehicle+terrain).
2. Expose b3 joint constraint tuning (setConstraintTuning) in src/ts binding → stiffer brick lattice (P005 far-standing).
3. Privacy-fence visual variant (P003 reference style).
4. Alias lab 'wall-brick' prop target to the bonded building-brick wall (avoid user hitting the unfixed legacy prop).
5. crashTargets spawn should honor freeConfig angleDeg/offsetM so angled target crashes can be staged (S6 flag).
6. Denser/hand-built stump meshes if the sparse GLB stump bothers the user.
7. Rear occupants read "ejected" at ~30g moderate frontal crashes (pole 60km/h, tree 40km/h) — rear lap-belt break threshold (8kN) likely still low for 77kg dummies; belted passengers shouldn't eject at these speeds. (Orchestrator eyes-on observation, 2026-07-15.)
8. Trolleys coast forever post-impact (pre-existing, from S4).
9. Hanging-bumper mechanic needs BodyShell mesh split (S8/S9 infeasibility finding).
10. __GAME__ render/skip-autotune hook for driving-page headless screenshots (S1 flag; S2's ?quality=medium workaround exists).
11. Deeper MECHANICAL side crush via mdb trolley mass in lab/barriers.ts if P004 visual amplify isn't enough (S1 flag).

## Orchestrator eyes-on (Wave 4, 2026-07-15)
Verified personally: P013 pristine + paint fixed; P014 340km/h front destroyed to A-pillar (2.03m, 297g, occupants dead); P004 right-flank intrusion visible top-down (modest vs refs — verifier to weigh); P006 sled visible mid-approach; P001 all 4 dummies upright/seated via sunroof; R005 index page glossy gunmetal car; P009 pole snapped + 0.48m crush + 31g; P002 mid tree rooted w/ slight lean, damage localized. New flag: rear-eject at moderate crashes (follow-up 7).

## Wave-3 hold note
S8+S9 (R003 VFX + R004 damage visuals) MERGED into one slice; dispatch AFTER S4 completes (releases lab/main.ts) — both need handleDamageEvent wiring in main.ts + lab/main.ts. Constraint for that brief: consume EXISTING damage events + telemetry only (no damage/* edits — S1 owns); scratches via decal/overlay meshes, not paint-material edits (S2 owns carMaterials).

## Key scout facts for later briefs
- P006/P008: physics trolley real (barriers.ts L171-203); mesh set once at spawn, never resampled → fix = InterpolatedTransform for rig visual in doFixedStep/animate.
- P001: symmetric ±2.2rad knee/elbow hinges around seated zero + knees not in applySeatedBraceSprings list; floorpan occupant-transparent by design (footwell shelf reverted: terrain beaching); 55kg total mass.
- Protocols: nhtsa-frontal-56, iihs-moderate-64, iihs-small-64, side-mdb-50, side-pole-32, rear-80, free (protocols.ts).
- __LAB__ extras: panelStress(), dumpDeformables(), maxStructuralOffsetM(), setOrbitView/setFixedAngle, exportReport().
