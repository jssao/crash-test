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
| A-fix | FIXROUND-2: 3 parallel fix workers (test-infra, vehicle-dynamics, visual-transforms) | sonnet ×3 | dispatched | | |
| B-spec | Automotive-engineering component spec | sonnet | **done** | 143,536 | docs/build-log/specs/engine-bay-spec.md (201 lines): turbo I4 (clears low hood), RWD, 13 engine-bay + 8 interior + 18 underbody = 39 dynamic bodies (≤40 cap), strength classes mapped to existing weld model, 15-step frontal failure order, axis-convention cross-map (spec +X fwd → game Z fwd), ~506kg added mass must be subtracted from CHASSIS_MASS_KG ballast (anti-double-count) |

## Pass log

(append: date · phase · evaluator verdict · directive)
