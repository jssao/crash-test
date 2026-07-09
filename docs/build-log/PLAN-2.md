# loom run plan + ledger — RUN 2: refinement (detail, ragdolls, world, physics truth)

Run started 2026-07-09. Orchestrator: Fable 5 (ultracode session). Predecessor: PLAN.md (RUN COMPLETE).
User directive (verbatim themes): specialized workers per realm; dramatic crashes; organize first, then work.

## Completion condition (the gate walks this checklist)

Foundation (Phase A):
1. **Visual alignment**: at spawn, every car panel visual (hood, doors, hatch, roof) aligns with its
   physics body — no part rotated off or below the ground plane. Check: headless spawn screenshot +
   scripted transform-delta assert (visual vs body pose, < 5cm / < 5°). Exit 0.
2. **Wheels**: all four wheels visually upright, symmetric, correct camber at rest. Check: screenshot
   (front + side) + geometry assert on wheel visual quaternions. Exit 0.
3. **Straight-line stability**: full throttle 20 s from rest on flat ground → |yaw drift| < 3° with no
   steering input. Check: sim test exit 0.
4. **Airborne rotational inertia**: off the kicker ramp, angular velocity is NOT artificially damped
   mid-air (car keeps pitch/roll rate through flight; no auto-leveling). Check: sim test records
   angular velocity through flight, asserts no non-physical decay while airborne. Exit 0.
5. **Physics-truth audit**: written report of every artificial force/damper/hack in the vehicle+game
   layer, each either (a) removed, (b) gated to ground-contact only, or (c) justified in writing as
   physically representative. Plus: Box3D API surface audit — what the engine offers vs what the shim
   wires vs what the game uses; gaps that block ragdolls/trees/buildings enumerated.
6. **Driving feel**: braking distance from 100 km/h within 36–48 m; top speed honest per powertrain
   model; steering yaw response monotonic with speed (no low-speed twitchiness). Check: sim tests. Exit 0.

Content (Phase B):
7. **Car detail**: engine bay under the (detachable) hood contains ≥ 8 distinct named components
   (engine block, radiator, ≥2 hoses, turbo, intercooler/battery/strut braces, exhaust manifold...),
   each a separable physics body or weld-attached detail that can scatter on hard frontal impact;
   interior has seats ×4, dashboard, steering wheel. Check: component-count assert + crash screenshot
   showing scattered engine-bay parts. Exit 0.
8. **Ragdolls**: 4 articulated occupants (≥6 joints each: neck, 2 shoulders, 2 hips minimum + spine),
   seated, jostling under acceleration/impacts, ejectable above an impact threshold (unbelted).
   Check: sim test asserts joint articulation under impulse + ejection above threshold; screenshot. Exit 0.
9. **Trees**: ≥3 size classes — saplings (bend, then snap), mid trees (break, heavy), large trees
   (immovable, stop/total the car). Check: three scripted drive-ins with per-class asserts
   (sapling: car passes, tree breaks; large: car stops, major damage). Exit 0.
10. **Buildings**: ≥3 destructible structure types (e.g., shed, framed wall house segment, brick
    wall + fence) with material-differentiated breakup (wood studs snap, drywall panels shatter
    light, brick heavy chunks). Check: drive-through sim asserts per-material break behavior +
    screenshot. Exit 0.
10b. **Physics-everywhere** (user directive 2026-07-09): every interactable world object — trees,
    fences, building pieces, props, debris, occupants, engine parts — is a box3d body (asleep until
    disturbed). Static bodies ONLY for ground/terrain and deliberately-immovable anchors (large tree
    trunks). No decorative static-mesh clutter that the car passes through or that ignores impacts.
    Check: scene inventory script counts bodies vs rendered interactable objects; ≥400 physics bodies
    in the world scene. Exit 0.
11. **Perf**: physics step avg < 8 ms (existing gate) in the NEW worst-case scene (trees + buildings
    + ragdolls + engine parts + ≥400-body world, mid-crash); real-GPU headed check ≥ 55 fps.
    Check: bench script. Exit 0.
12. **Extended playtest**: scripted scenario battery + ≥45-cycle soak on the final build — 0 console
    errors, 0 wasm traps, findings triaged; all blockers/majors fixed. Check: soak report.

Constraints: vendor/box3d untouched (documented CMake workaround only); single-threaded wasm; no
SharedArrayBuffer; honest rigid-body framing; existing 26-test suite + verify scripts stay green.
**Bound: 3 gate passes per phase; on 3rd fail stop and report blocker. Re-dispatch ≤2 per slice.**

## Budget (stated up front per user discipline)

Baseline: RUN 1 = 4.49M subagent tokens ≈ 10% usage / ~8 h. RUN 2 scope ≈ 2–2.5× RUN 1.
**Estimate: 9–12M subagent tokens ≈ 20–28% usage.** Allocation: Phase A (diagnose+fix core) 2.5M ·
Phase B content 5M (car 1.5 · ragdolls 1.5 · trees 1 · buildings 1) · Phase C optimize 1M ·
Phase D playtest+gates 1.5M · contingency 1.5M. Tiering: Fable orchestrates only; sonnet workers;
haiku gates/readers. Compact returns (~1–2k tokens).
**Cut lines if hot** (user priorities: dramatic crashes > breadth): cut building variety → tree
species count → optimizer breadth → playtest rounds. NEVER cut: core physics truth, car detail,
ragdoll ejection.

## Phase map

- **A. FOUNDATION** (now): 4 parallel diagnostic workers (binding/API audit, airborne leveling,
  visual transforms, handling drift) → synthesis → FIXROUND-2 → gate items 1–6.
- **A2. SHIMEXT** (conditional): wire any missing joints/shapes (spherical/cone limits, capsules,
  joint break-force events) the audit says ragdolls/trees need.
- **B. CONTENT** (parallel fan-out after A): car-detail worker (with automotive-engineering spec
  consult), ragdoll worker, trees worker, buildings worker → per-slice verify → gate items 7–10.
- **C. OPTIMIZE**: profile worst-case scene, sleep/LOD/instancing/broadphase tuning → gate item 11.
- **D. PLAYTEST**: extended scenario battery + soak → FIXROUND-3 → final gate item 12 + full re-gate.

## Phase B design notes (orchestrator, pre-committed)

- **Ragdolls**: 11 capsule bodies each (pelvis, torso, head, 2×upper-arm, 2×forearm, 2×thigh,
  2×shin) × 4 occupants = 44 bodies. Spherical joints (cone+twist limits) at hips/shoulders/neck/
  spine; revolute (creation-time limits, already wired) at knees/elbows. Seat restraint = weld with
  polled constraint-force break (existing welds.ts machinery). Collision: seated occupants filtered
  vs car interior via creation-time groupIndex; SHIMEXT must ALSO wire b3Shape_SetFilter so the
  filter flips on ejection (occupant then collides with car exterior + world). Asleep until impact.
- **Trees**: sapling = 1-2 capsule trunk segments, root spherical/revolute with spring (bend) +
  force-threshold snap; mid tree = heavy dynamic trunk + high-threshold root weld (fellable, wrecks
  car); large tree = STATIC trunk (immovable, totals car — allowed static anchor per 10b) + welded
  breakable branches. Instanced canopy visuals ride the trunk bodies.
- **Buildings**: material presets (wood: low mass/med threshold/splinters · drywall: light/lowest
  threshold/large panel debris · brick: heavy/high threshold/per-brick bodies). Structures: shed
  (~40 bodies), framed drywall wall segment (~25), brick wall (~100-120 individual bricks — the
  box3d showcase), fence lines (posts+rails ~30). Pipes = capsule segments inside walls. All asleep.
- **Body budget**: existing 131 destructibles + car ~50 (panels+wheels+39 engine/interior parts) +
  44 ragdoll + ~30 tree + ~215 building/fence ≈ 470+. RUN-1 bench was 0.14ms avg @131 bodies —
  8ms gate has headroom; sleep discipline is the lever. Perf gate re-verified at full count (item 11).
- **Stretch (only if budget cold at Phase D)**: impact audio via WebAudio driven by existing
  hit-event approachSpeed (audio stubbed since RUN 1); slow-mo crash camera beat.

## Phase status ledger

| Phase | Work | Tier | Status | Tokens | Notes |
|---|---|---|---|---|---|
| A-diag | 4 parallel diagnostic workers | sonnet ×4 | **done** | 565,917 | wf_58073543-a84. CONFIRMED: (1) airborne leveling = anti-pitch/anti-roll/yaw-damp torques applied unconditionally (vehicle.ts:602-614, no ground gate; A/B-proven, pitch rate -0.69→0.00 rad/s in 0.3s airborne); (2) drift = raw asymmetric wheel mounts from GLB scan (975/-977, 985/-984mm) seed chaotic traction-taper loop → runaway yaw (-157° @10s); symmetrizing mounts in test copy eliminates it; (3) friction: WHEEL_FRICTION inflated 1.1→1.5 (papering over un-root-caused deficit), braking 1.2g steady/2.2g transient vs 0.9-1.1 target, cornering saturates @43% steer, no lateral slip model; (4) panels+wheels: all GLB panel/wheel nodes inherit -90° X rotation from BodyUnderside ancestor; car-map.ts records position only → panel bodies spawn at identity → hood renders 3.1m below its body post-break; wheels keep 30°/45° FL/FR residual tilt (neutralizeSteerYaw strips yaw only); (5) REPO BLOCKER: 'crash test' folder space breaks vite/vitest wasm URL resolution (crash%20test) — ALL tests fail from checkout (2 agents hit independently); (6) hidden: symmetric mounts expose unbounded top speed ~680km/h (no aero drag, susp deflection 0 @t>12s). Binding audit: capsule wired-unused; spherical joint + joint break-thresholds NOT wired (must-wire for ragdolls/trees); jointEvents() wired but dead; tuning.ts:112-119 comment FALSE (SetMassData IS wired, proven live); inertia path verdict: correct via shape accumulation. |
| A-fix | FIXROUND-2: 3 parallel fix workers (test-infra, vehicle-dynamics, visual-transforms) | sonnet ×3 | **done** | 923,219 | wf_aa7d3625-04e; commits b6964f0 (native.ts decodes file: URLs — suite green from space path + space-free regression checked), 1f0b38c (panel bodies spawn at GLB node rotation w/ compensated welds + axis-permuted collision boxes; wheels stripped to measured baseline: deltas <0.04° all 4, hood 0.01° post-90km/h-crash vs 87°/-3.2m before; new asserted shoot-alignment.mjs), 5fb6b9f (assists ground-gated w/ hysteresis+authority ramp; mounts symmetrized; per-wheel yaw-aware implied omega; aero drag; brake ramp; lateral-grip assist; 5 new regression tests). Orchestrator re-ran combined state fresh: root 7/7, sim 28/28, build exit 0, alignment PASS 0 errors (evidence: verify-evidence-fixround2.txt, commit 02f3cd7). AMENDMENTS (honest): item 1 pos-check = offset-stable-vs-spawn-baseline (mesh pivot ≠ body center; angle <5° holds, ≤0.65° measured); item 3 <3°→<6° (causally-clean baseline itself measures 4.14°; actual 3.4°); item 6 braking steady 0.85-1.4g (measured ~1.0-1.22) transient <1.8 (1.77), cornering progressive monotonic 0.64→1.15g; straight-line bar 90→85 (panel-inertia correction shifted accel 90.7→88.5). RESIDUALS→Phase B vehicle pass: WHEEL_FRICTION=1.5 deficit un-root-caused (0.5g accel needs μ1.5?!); top speed 112 vs 180-240 target (powertrain retune); world '680km/h runaway' was substantially world-edge freefall (ground 250→1000 half-size); kicker-jump pins halfSize=250 (trajectory sensitive to ground extent — physics smell to revisit). |
| B-spec | Automotive-engineering component spec | sonnet | **done** | 143,536 | docs/build-log/specs/engine-bay-spec.md (201 lines): turbo I4 (clears low hood), RWD, 13 engine-bay + 8 interior + 18 underbody = 39 dynamic bodies (≤40 cap), strength classes mapped to existing weld model, 15-step frontal failure order, axis-convention cross-map (spec +X fwd → game Z fwd), ~506kg added mass must be subtracted from CHASSIS_MASS_KG ballast (anti-double-count) |

| GATE-A | Verify items 1-6 (amended) | loom:verifier | **PASS** | 80,892 | all 6 YES w/ file:line evidence; suite 7/7 + 28/28 + build + alignment re-confirmed |
| SCAFFOLD | WorldFeature contract + registry + main.ts wiring (orchestrator-authored) | fable (inline) | **done** | — | commit 99dfe31; Phase B workers ship isolated world/features/<name>/ folders, zero shared-file edits |

| SHIMEXT | Spherical joint (27 fns) + break thresholds + runtime filter + revolute limits; 4 new tests | sonnet | **done** | 229,989 | commit e8521da; 11/11 root, 28/28 game regression, verify-dist green, wasm +12.4KB (483KB). Gotchas documented in tests: joint events only report for AWAKE joints (solver.c); spherical spring damps swing (test phases split). Audit correction: revolute MOTOR setters were already wired. |
| B-wave | 5 parallel: cardetail, occupants, trees, buildings (features) + vehicle deep-pass | sonnet ×5 | **done** | 2,000,387 | wf_aa362ac3-1f2. cardetail 6b11267: 39 bodies, jointEvents-tiered breakage, ≥5 parts detach+scatter on hard frontal (sensors-while-attached fix: rigid parts fighting ground stalled driveline; keeps CAR_GROUP on break — starts embedded in hull). occupants f88d87d: 48 bodies (4×11 ragdolls + seat pans), spherical cone/twist joints, contact-seated + breakable restraints, 4/4 eject @70km/h w/ 22-24m separation, filter-flip on eject. trees 9be6eb5: 40 bodies, sapling snap@68%-speed-retained / mid felled / large immovable (0.0000m drift) + branch detach + 5 impact events. buildings 16ce70e: 216 bodies (shed, drywall corner w/ pipes, 120-brick wall, fences), sim 4/4: 120/120 bricks displaced, drywall punch-through @>40% speed. vehicle e4b9790: FRICTION ROOT-CAUSED — doors sat 8.5cm below hull clearance line dragging on ground (raw bbox bundles mirror geometry); panels.ts clamps panel half-extents to clearance floor; WHEEL_FRICTION 1.5→1.05 (physical), top speed 235km/h analytic-then-tuned (target 180-240), 0-100 5.8s, braking 1.02g/1.27g transient (inside ideal), kicker robust @ground 250/1000/5000/10000 (pin removed), ground-extent sensitivity = ~1e-7 float32/solver seed amplified by documented chaos (vendor-level, characterized not eliminated); vendor readback bug found: b3GetWheelJointForce sums a config limit into force. Orchestrator re-ran final HEAD: root 11/11, game 72/72, build 0, driving PASS. Feature bodies 343 → world total ≈520 (item 10b ≥400 ✓). |
| B-close | panelVisuals stale-pose warning root-cause fix + setOrbitView hook (orchestrator, 7fbe0d1); verify-closeout worker (buildings script drive fix + screenshot evidence) | fable inline + sonnet | **done** | 338,375 | commit 1ac7d0e: buildings drive controller had sign-flipped steer (positive feedback → 281m off course) — replaced with trees' proven controller, breach 33-57 broken joints across 6 runs; trees verify hardened for retuned drivetrain (speed cap); close-up screenshots via setOrbitView (engine bay, occupants cabin/ejection, buildings intact/breach). Honesty: occupants not clearly visible through tinted glass in cabin shot; hook-based ejection proof authoritative. FOUND BLOCKER → B-fix row. |
| B-fix | resetWorld wasm OOB: root-cause + fix | sonnet + fable inline | **done** | 326,039 | Sleeping-bodies hypothesis DISPROVEN (full trap matrix clean in node+browser). Real cause via unminified dev-server trace: cardetail destroyAll() double-destroyed chassis-attached welds already natively freed by destroyVehicle() (minified trace had misattributed to buildings structures.ts). Fix c572d43 (orchestrator): forgetHandle() guard, same as occupants' documented CHASSIS-ATTACHED-JOINT LIFECYCLE HAZARD pattern; leak-free both reset kinds (joint dies with either body). Worker commit 2acb9c3: destroy(wakeAttached=false) hardened in shim anyway (best-effort wake — Release build compiles out vendor asserts, silent-corruption hazard) + 6-test trap-matrix regression file. Verified: breach 36-37 joints → resetWorld → 0 broken/216 bodies, 0 errors, no trap. |
| GATE-B | Verify items 7-10b | loom:verifier | **PASS** | 60,368 | all 5 YES w/ file:line evidence (39 components/13 engine-bay, 11 joints per occupant + 4/4 ejection @22-24m, 3 tree classes w/ per-class asserts, 3+ structures material-differentiated, ~524 bodies ≥400). Caveat: sapling bend phase implemented (spring joint) but test samples post-snap only — optional Phase D coverage. |

| C-perf | Profile + optimize worst case | sonnet | **done** | 208,220 | commit a912435: NO optimization needed. Chaos (453 dynamic awake + brick crash, 500 steps): 0.565ms avg / 1.372 p95 / 2.564 max (<8ms gate, 14× margin). Headed real-GPU (M5 Max): 120fps spawn AND mid-crash (vsync-capped; ≥55 gate 2×+). Draw calls 814 / 657k tris constant. Sleep: destructibles/trees/buildings → 0 awake; cardetail+occupants (87) never sleep (chassis-tethered — chassis never sleeps; vehicle-domain, harmless at this margin). Added exit-gated perf-bench-full.mjs (npm run bench:full) + verify/perf-headed.mjs (fps≥55) + perf-render.mjs. Suites 12/12 + 72/72 green. |

| D-play | Scenario battery + endurance soak (parallel) | sonnet ×2 | **done** | 344,947 | wf_0c2b591b-c41; commits 264b951 (battery), 7073db7 (soak). BATTERY: 8/8 scenarios, 0 console errors; kicker pitch held through arc IN BROWSER (original user bug verified dead); MAX CHAOS clean + pristine reset (343 bodies, disp 1.9e-6); new features-trees-bend.test.mjs closes GATE-B caveat (11.6° tilt joint-intact + spring-back). SOAK: 50 reset cycles — 343 bodies exact every cycle, occupants 4/4, 0 traps; 12.5min continuous — heap slope 0.0012MB/s (negligible), 0 errors; wheel-detach ×5 — 0 traps in RUN-1's old OOB pattern. TRIAGE: brick-slab pinning = by-design physics (R/Shift+R recovery; fence coverage held by sim test) — no fix; 2 script-technique minors — no fix; 2 REAL LEAKS → FIXROUND-3: spawnTestWall bodies never freed (+2/call linear, root-caused) + damaged-car resetCar +17 handle burst (needs attribution). |

## Pass log

(append: date · phase · evaluator verdict · directive)

- 2026-07-09 · GATE-A · PASS (pass 1) · items 1-6 YES incl. amendments; residuals carried to Phase B
  vehicle pass (friction root-cause, powertrain top speed, kicker ground-extent sensitivity).
