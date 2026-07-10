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

| W3a | Terrain 400×400m heightfield world | opus | **done** | 400,816 | commit 475cd1a: 5 zones, apron slope 0.46°, PBR splat + forest HDRI + fog + sun-follow; 119.9fps/0.43ms held; 105/105. Residual: cone-trees clash (→ visual wave). |
| W-ragdoll | Active ragdolls v1 | opus | **done** | 399,397 | commit 6ea8a7f: torque-limited muscles, 65g life/death, glass-shatter ejection, staged collision re-enable, FSM w/ disclosed kinematic assist. USER FOUND 4 DEFECTS → ragdoll-2 at FABLE per ladder. |
| W3b | Visual wave: trees/enginebay/paint | sonnet ×3 | in flight | | |
| USER-PT2 | User playtest round 2 (5 screenshots) | — | triaged | | Findings: slammed ride height + wheel-fender intersect (laden weight vs bare-sim tuning); ragdolls twitchy/instant-eject/floaty-stand/Shift+R phase; 80km/h crumple unrealistic + doors detach on frontals; wood no splinter, barrels no dent, brick blob, eternal spin (rolling resistance unwired), mass/dims truth; compound feel + bigger terrain. |
| W4 wave | ragdoll-2 (FABLE) · crash-realism refs (opus) · materials-truth (opus) · ride-height (opus) · compound+800m (opus) | fable+opus×4 | dispatched | | wf_4f683d6c-eb2; crash worker mandated to source public IIHS/NHTSA reference imagery + build top/side/quarter comparison harness (user method). |

| W5-research | Engine-max deep dive: exhaustive coverage audit + car/destruction-sim technique map | opus ×2 | dispatched | | wf_7293cb6a-fcb; user directive: "maximize every true-to-life physics detail" — outputs ranked wiring roadmap specs |
| W4b-queued | Airborne truth round 3 (FABLE xhigh→max): half-on-ramp launch self-levels — anti-roll assist kills ramp-imparted roll rate w/ 2 wheels grounded + authority bleed into flight; kicker test only covered symmetric pitch. Judgment call: attempt full assist RETIREMENT (their original justifications — broken suspension, panel drag — are fixed). BLOCKED on ride-height worker releasing vehicle/** | fable | queued | | |

| W3b | Visual wave: trees/enginebay/paint | sonnet ×3 | **done** | 941,143 | trees 03ab524 (real bark PBR + photo leaf-cards, 0 draw-call delta, +0.11% tris); enginebay 062f4b3 (39 shaped builders — ribbed block, spiral turbo, finned cores, tube hoses; +16.7% calls, containment preserved); paint 783951c (MeshPhysical black w/ clearcoat outdoors, occupants visible thru glass, transmission dropped after root-causing SwiftShader nondeterminism → -38% draw calls at high). Orchestrator eyes-on: forest reads as forest; bay reads as machinery. Residual: feature-trees.mjs targets stale post-relocation; resetWorld lighting perturbation (pre-existing, noted). |
| W5-research | Engine-max deep dive | opus ×2 | **done** | 262,068 | eb6524a coverage (~70/330 fns wired; zero-wired: sensor/contact-begin-end events, casts, CastMover, Explode, GetContactData, compound, wind, 4 joint types; ranked top-12) + ea2c798 domain map (at FlatOut/Wreckfest tier; #1 structural-collapse graph on existing weld lattice; tire-model + soft-body ceilings documented w/ sources). Correction: rollingResistance wired-at-creation, never SET. |
| USER-PT3 | User: plank hits devastate car (mass not in damage eq — approachSpeed heuristic confirmed root cause); Tier-3 compound hull APPROVED; soft-body question answered (rigid engine; crush-segment architecture = honest ceiling path) | — | triaged | | impulse-based damage promoted into Tier-1 wave |
| SHIMEXT-2 | Wire contact begin/end + userMaterialId + Explode + surface/mesh materials + runtime setters | sonnet | **done** | 345,275 | commit ae702b4: all 5 areas wired incl. per-triangle mesh/heightfield materials (terrain zones can differ in friction/rolling-resistance per triangle) + ExplosionDef full surface; 5 new test files/14 tests, root 20 files/37 green, verify-dist green, wasm +8.2KB (491.6KB). Deviation documented: hit-event userMaterialId truncated to 32-bit (shim convention); 64-bit at creation. Still unwired (next SHIMEXT if Tier-2 demands): sensor events, CastShape/Overlap, prismatic/motor joints, wind, compound. |

| W4 wave | Realism wave results | fable+opus×4 | **done** (4/5) | 1,273,577 | ragdoll-2 (FABLE) 2ab4cec: jitter=PD divergence (kd 7× stability bound; idle RMS 24→0.0001 rad/s via solver springs), ejection gated (30km/h=0), ground-raycast stands, 7-state reset test. crash 5261753: crumple was displacing along INVERTED normal (nose bulged toward wall!); direction-aware door welds (lateral-only per FMVSS-206), speed-scaled inward crush, IIHS/NHTSA reference spec + top/side/3q matrix. materials f5c17f6..a9dc316: brick was styrofoam-density (162→2654 kg/m³); rollingResistance is spheres/capsules-only upstream → angular damping for boxes; masonry cracks crisp; shed reset fixed. ride-height fcd5490: laden car properly seated. COMPOUND SLICE FAILED CLEAN: worker received corrupted prompt (code-review template cross-wire), refused correctly, zero changes — re-dispatched. Cross-worker breakage found at combined HEAD: crush monotonicity (80km/h 0.31m < 64km/h 0.44m — calibrated pre-ride-height). Deferred by materials worker: wood mid-span splinter geometry, barrel vertex-dent (spec'd §8). |
| W6 wave | crush-recal (sonnet) + compound-world-2 (opus) + airborne-truth-3 (FABLE: assist retirement + asymmetric-launch flip test) | mixed | dispatched | | wf_b6c004c9-1c0 |

| W6 wave | Closeout results | mixed | **done** | 839,810 | crush 050f41b: NOT probe/tuning — intra-step ordering (weld broke hood before crumple consumed same hit → most energetic hit dropped); crumple now runs first; monotonic 0.236/0.442/0.535/0.580m. compound 03992cc: 800m/512² grid, forest RING encloses fenced yard (158 trees), gate+driveway (north — documented call), buildings ring yard, poles = drive lights; perf green. airborne e037bff (FABLE rnd 3): assist retirement MEASURED — original justifications gone (battery passes all-off) but crash suites genuinely need: yaw FULL, anti-pitch FULL, anti-roll measured-minimum HALF (attribution numbers in tuning.ts); authority: ≥3 wheels + upDot plausibility, INSTANT cut on contact loss, landing-only ramp; asymmetric-launch test: 0 in-flight authority, monotonic 63/110/197° roll, browser: 59.7km/h half-on → lands ON ROOF w/ occupant ejecting. Laden flip threshold ~60 vs unladen ~40km/h (honest mass effect). |
| W7 wave | Mustang swap (opus, CC-BY verified, engine included) + destruction-feel speed recal (sonnet: 120km/h scenario under-runs speed post-relocation) | opus+sonnet | dispatched | | wf_b50f1ec3-c26; Impala staged as fallback |

| W7 results | Mustang swap complete + destruction recal | opus+sonnet | **done** | 824,879 | recal 0a06518: root cause = SETTLE TIME not speed (fresh-spawn transient weakens next collision); 36m run-up for 120km/h; monotonic 5.7/16.8/26.3 m/s. Swap: asset ee2bfe2 (split proven PERFECT — 0.0% blended verts; 13 parts, wheelbase 2743mm exact) + integration ccdd936..1f9f5eb (6 commits): 4-panel system (trunk, no roof), per-car analyze-car registry, EngineBlock sub-split (1036mm) as heavy detachable + modeled bay engine, per-pane glass (windshield/rear; door glass shatters with doors — documented), wheel-pivot double-offset bug caught in browser + fixed, brake ramp 0.60 → transient 1.04g, occupant thresholds re-measured (3616N bump vs 5481N crash), credits → Godspeed CC-BY. Full suite 67/67 files/145 green; all browser verifies PASS; orchestrator eyes-on: spawn stance + 80km/h crash both excellent (doors intact, occupants ejected, debris). RESIDUAL → dispatched: reverse doesn't engage in full laden game (sim reverses fine; suspects: brake-ramp latch, laden breakaway torque, wake path) — opus on it. |

| W8 Tier-1 | collapse-graph (opus) + impulse-damage (opus) + skids-audio (sonnet) + barrels (sonnet) | mixed | **done 4/4** | 936,054 | ad3003a collapse: support-graph BFS wakes weld-orphaned chunks (worker died at report stage AFTER committing — work verified by orchestrator: suite green + eyes-on shed-falling screenshot). ff451b0 impulse-damage: e=m/(m+car) weighting; fence@60km/h = 0 dents/0 panels vs wall 49 dents+hood; e=1 path byte-identical; residual: debris owners adopt setForeignMass one-liners. c70d908 audio: synthesized impact/scrape/skid/hum off contact events + telemetry, zero foreign-file edits (runtime shape arming), M mute, 120fps held. acd9490 barrels: threshold+chain detonations via world.explode(), browser: 10-barrel chain, 0 errors. Combined fresh: root 37, game 72 files/172 tests, build clean. |
| reverse-fix | Laden reverse (opus, 2nd dispatch after harness-corrupted 1st) | opus | **done** | 355,729 | d552410: false-airborne latch — nose-heavy laden rear (~0.05m deflection) dipped below contact proxy under reverse torque reaction → capped to 60Nm forever. Fix: airborne cap gated on real free-spin + REVERSE_MAX_DRIVE_TORQUE 600Nm. +0.11m stuck → -14.5m/4s; braking 1.04g held. |

| USER-PT4 | User directive: the Mustang's OWN modeled engine-bay/interior geometry is the source of truth — remove/hide the procedural cardetail duplicates (grey cubes; period-wrong turbo/intercooler on a '65) and any leftover primitive proxies. Procedural parts survive only as invisible physics proxies where scatter mass is needed, else culled. Detachable chunks come from sub-splitting the MODEL's Engine/drivetrain geometry where identifiable. | — | queued → Wave B | | cardetail-cleanup worker; folds into Tier-3 stage-3 open-bay rework. Waits for Wave A soak (dist-rebuild conflict). |

| W9 gate-wave | Soak/battery-r3 (ede158e) + adversarial gate + SHIMEXT-3 (c2a9640) | sonnet×2 + verifier | **done** | 812,747 | GATE: PASS on all RUN-3 condition items (1-8 incl 6b/6c, some AMENDED-YES) + RUN-2 regression spot-checks. DIRECTOR HOLD: soak found 3 BLOCKERS + 2 majors → run stays open. Blockers: (1) world-edge freefall (668km/h @ y=-3969 past ±400m extent; aero cap inert off-heightfield); (2) permanent wedge points (kicker ridge beaches 1/3 straight-north drives; second snag @ z≈155; reverse can't free; frozen 210s in soak); (3) rear wheels DETACH from forward→stop→reverse on flat ground 3/3 (drivetrain spike vs wheel-detach threshold). Majors: resetCar ~50% no-op when wedged; fps 71→12 over 12.5min w/ FLAT heap/handles/audio (renderer-side accumulator). Minor: audio duplicate-onended console.errors. 50-cycle soak otherwise pristine (759 bodies exact, 0 traps). SHIMEXT-3: manifold impulses + shapecast + sensor events wired, 44 root tests, wasm 508KB. |
| W10 FIXROUND-4B | wheel-detach-reverse (opus) · containment+wedges+reset (sonnet) · fps-decay profiler (opus) · audio dup-onended (sonnet) | mixed | dispatched | | wf_fb0f3945-aaf; then re-soak → Wave B (Tier-3 st1-2 + cardetail model-first cleanup + terrain friction + camera occlusion) → Wave C (st3 + impulse crumple + final re-gate) |

| W10 results | FIXROUND-4B: all 4 closed | mixed | **done 4/4** | 1,087,223 | 6993558 reverse-detach: NOT a spike — SUSTAINED 14.5kN stall plateau (~4.0× share, 80 steps) from the reverse servo; fix = impact-gated detach (breach counts only w/ coincident real impact) + 6× contactless gross bypass; 0/3 repro, red-green proven; honest note: 150-200km/h wall never detached wheels even pre-fix. fa6178f containment: terrain-rim berm + y<-10 kill-plane→resetCar+toast (668km/h repro stops); kicker beaching = knife-edge + 0-torque-below-3-wheels deadlock → 30°→25° (3/10→0/10); 2nd snag = corridor tree (cleared); resetCar was already absolute (soak read = tree snag re-hit) + hardened anyway + wedged/freefall/inverted recovery tests. b2f1595 fps: NO ACCUMULATOR — renderer metrics byte-identical start/end; 'decay' = frustum-load × soak schedule under SwiftShader + HUD dt-clamp floor; fps recovered 116 mid-session; exit-gated 8-min endurance guard added (ratio 1.103). 34ec847 audio: real Chromium quirk (double 'ended' when stop()s share a render quantum); mitigated, 6 clean runs. Worker died at report AFTER committing (2nd occurrence — StructuredOutput cap; work intact). Combined: root 23/44, game 73/180, build clean. |
| W11 Wave B | Tier-3 st1-2 concave hull + glass-contact ejection (opus) · cardetail model-first (USER-PT4) · terrain per-triangle grip · camera occlusion | opus+sonnet×3 | dispatched | | wf_4d45891c-07e; Wave C after: Tier-3 st3 open bay + solver-impulse crumple + FULL final soak/re-gate |

| W11 results | Wave B: 4/4 landed | opus+sonnet×3 | **done** | 1,226,453 | 1f8005b Tier-3 STAGE 1: 12-shape concave cabin tub, mass BYTE-parity (1291.000kg, inertia exact), probe-rests-on-floorpan cavity test, crash contact byte-identical; Stage 2 deferred w/ surgical S2.1-S2.6 handoff (honest fallback). 1f5f08d cardetail model-first cull (USER-PT4): 39→27 parts, duplicates/period-wrong removed, model internals audited via Blender renders. 5cd41d1 per-triangle terrain grip: dirt braking 1.24× asphalt (band 1.15-1.35), cornering 0.608 vs 0.548g; found sqrt-combine constraint + terrain rollingResistance inert in vendor (documented). 316874d camera occlusion: sphere-cast pullback chase+orbit, eye-height cast fix, 10/10 unit + 15/15 browser asserts. Cross-wave fallout at combined HEAD: 2 red (reverse impact-context, occupant ejection 1.27m<2m — likely occupants genuinely clipping new roof shapes) → folded into Wave C stage-2 worker. |
| W12 Wave C | Stage 2 glass-contact ejection + calibration + solver-impulse crumple (opus) · Stage 3 open bay solid parts (sonnet) | opus+sonnet | dispatched | | wf_bb6d98e3-f25; then FINAL full soak + re-gate + run close |

| W12 results | Wave C: Task-0 fixed (3626dd5: reverse test self-polluted panel stress via origin-point synthetic hit; ejection 'failure' = late belt break on near-stopped car — honest recal) · Stage 3 landed (fe85679: 24/27 parts solid-while-attached, 3 sensor-kept w/ measured 19%-loss justification + permanent ground-contact probe) · Stage 2 attempt 2: geometry-hollowing PROVEN INFEASIBLE (3-way conflict: open belly→beaching / belly rails→wall bounce / variants→chaos churn; best config 206/207) BUT measured the correct path — occupants already clear ALL interior shells ≥2cm; only nose/tail volumes penetrate → FILTER PATH (NOSE_TAIL category exclusion), crash suite byte-identical by construction. Corrected round-1 handoff (rear occupants sit IN the tail, 0.28m). | opus×2+sonnet | **done/proven** | 538,730 + 578,744 | 77 files/207 green at fe85679, tree clean |
| W13 Stage-2 | FILTER-PATH Stage 2 (FABLE, 3rd-round ladder escalation) + optional solver crumple | fable | dispatched | | after 1 harness prompt-corruption retry (3rd occurrence of that glitch) |

## Pass log
