# Crash Sandbox — design spec (2026-07-08)

A realistic-visuals, sim-leaning-simcade **crash sandbox driving game** built on **box3d-js**
(this repo's WASM+TS port of Erin Catto's Box3D), rendered with **Three.js**, deployed to
**GitHub Pages**. The game is the flagship consumer of the binding and the reason the port's
export surface is wider than BRIEF.md's minimum.

Decisions locked with the user: crash sandbox concept · sim-leaning simcade driving · realistic
visuals (PBR/HDRI/real car model) · desktop-first (keyboard + optional gamepad) · one repo,
port-then-game · loomified execution.

## Honesty constraint (what "BeamNG-like" means here)

Box3D is a **rigid-body** engine; BeamNG is soft-body. We do NOT fake a soft-body claim. The
BeamNG-adjacent feel comes from: real spring/damper suspension (wheel joints), a chassis of
**multiple rigid parts joined by monitored weld joints that break** (bumpers/doors/hood tear off),
**visual crumple** (bounded vertex displacement around impact points), and a heavily
**destructible world** (stacked walls, towers, poles). README/about text must state this honestly.

## Part 1 — the port (BRIEF.md governs; this widens it)

Execute `BRIEF.md` phases P0–P4 as written (goal checklist items 1–6). **Delta: the P1 export
surface must additionally cover the game's needs:**

- Joints: wheel (spring/damper params, motor torque/speed, limits), weld, revolute; joint
  destruction at runtime; **joint reaction force/torque queries** (for break thresholds — Box2D
  precedent: monitor and destroy manually; verify what box3d.h exposes).
- **Contact/hit events with impulse magnitudes + world points** (drives crumple, panel breaks, audio).
- Raycasts (camera, wheel checks, debug).
- Shapes: convex hull, box, sphere, capsule, **compound bodies**, **heightfield or trimesh**
  (terrain), static/dynamic/sleep control.
- Batched transform readback via HEAPF32 (BRIEF item 3) sized for ~200+ bodies.
- Determinism-friendly fixed stepping (`b3World_Step` with fixed dt, substeps param).

If box3d.h lacks any of these (alpha upstream), record the gap in the spec's risk log and design
the game around it (e.g. no reaction-force query → break on contact impulse at the panel instead).

## Part 2 — the game (`game/` in this repo)

Vite + TypeScript app in `game/`, importing the binding from `src/` (workspace path, not npm).
Three.js r18x, WebGL2 (WebGPU out of scope v1).

### Modules (one purpose each)

| Module | Purpose | Key interface |
|---|---|---|
| `core/` | Fixed-timestep loop (60 Hz physics, interpolated render), pause/reset | `tick(dt)`, `onFixedStep(cb)` |
| `physics/` | Owns the Box3D world; entity↔body registry; batched transform sync | `PhysicsWorld.step()`, `syncTransforms(scene)` |
| `vehicle/` | Chassis compound body + 4 wheel joints; powertrain: torque curve → auto gearbox → open diff → wheel motor torques; speed-sensitive steering; brakes/handbrake | `Vehicle.applyInput(input, dt)`, `Vehicle.telemetry` |
| `damage/` | Panel bodies attached by weld joints; break on impulse/force threshold; visual crumple = clamped vertex displacement around contact points; detached-panel lifecycle (free body → sleep → fade) | `DamageSystem.onContact(evt)` |
| `world/` | Terrain (heightfield or flat + trimesh props), destructibles (walls, towers, poles, ramps, stacked crates), spawn/reset | `buildWorld(physics, scene)` |
| `render/` | Renderer setup: PBR, HDRI env, ACES/AgX tonemap, cascaded shadows, SMAA/bloom, quality presets | `createRenderer(opts)` |
| `assets/` | GLB car (separable panels: hood, doors, bumpers, trunk, glass), KTX2 textures, Draco/meshopt decode, HDRI; loading manager + progress | `loadAssets(): Promise<GameAssets>` |
| `input/` | Keyboard (WASD/space/R/C) + Gamepad API | `InputState` |
| `hud/` | Speedo, gear, damage ticker, controls help, reset | DOM overlay |
| `camera/` | Chase cam (smoothed) + orbit mode toggle | `updateCamera(dt)` |

Audio (engine loop + impacts) is v1.1 — stub the event hooks, don't build it in v1.

### Driving feel (sim-leaning simcade)

Torque curve (simple 3-point lerp), automatic gearbox (ratios + shift RPM), rear-wheel drive
default, per-wheel longitudinal slip-limited drive torque, speed-sensitive steering clamp, brake
bias, handbrake = rear wheel lock. Tuned constants in one `tuning.ts` file. No clutch/manual/TC
simulation. Suspension is REAL (wheel-joint spring/damper) — tuning lives in the same file.

### Damage model

- Chassis = core hull body; panels = separate bodies (hood, 2 doors, front/rear bumper, trunk)
  weld-jointed to the hull. Contact impulse above per-panel threshold → destroy weld, panel flies.
- Crumple: per-impact, displace car-mesh vertices within radius r of impact point along impact
  normal, magnitude ∝ impulse, clamped per-vertex lifetime max (no inside-out meshes). Recompute
  normals. Purely visual; collision shapes unchanged.
- World destructibles are plain dynamic bodies (start asleep) — knocking them over IS the physics
  showcase; no fracture simulation in v1.

### Realistic visuals

Poly Haven HDRI (CC0) for IBL + a licensed/CC0 car GLB with separable panels (sourcing task —
license must permit redistribution; record attribution in `game/CREDITS.md`). PBR ground +
props, KTX2/Basis textures, Draco or meshopt geometry. If no suitable separable-panel car GLB is
found, fall back to a good whole-body GLB + procedurally split panels in Blender or at import
(risk log item).

### Data flow

`input → vehicle.applyInput → physics.step(1/60) → contact events → damage → transforms (HEAPF32
batch) → interpolate → three meshes → render`. Physics in the main thread (single-threaded wasm,
no COOP/COEP — GitHub Pages constraint).

### Testing & verification

- Vitest: powertrain math, damage thresholds, binding lifecycle (from BRIEF item 2/4).
- Headless integration (node): scripted drive test (car advances >20 m in 3 s under throttle;
  yaw changes under steer), scripted crash test (≥1 weld destroyed above threshold impact).
- Headless WebGL screenshot harness (Santiago's Wrath pattern) for render-without-errors + visual
  review of PBR/HDRI/car.
- Perf gate: physics step avg < 8 ms with full destructible scene active on this machine.

### Deploy

GitHub Actions workflow: build binding + game → publish `game/dist` to Pages. Vite `base` set for
project pages. Everything static, no special headers (single-threaded wasm, no SAB).

## Risk log

1. Upstream alpha API churn — pinned SHA; re-pin consciously.
2. box3d.h may lack joint reaction force or rich contact events — fallback: impulse-at-panel breaks.
3. Separable-panel realistic car GLB sourcing/licensing — fallback: split a whole-body CC0 model.
4. Wheel-joint semantics unknown until P1 reads the header (2D wheel joint ≠ 3D wheel joint
   assumptions) — vehicle module treats joint config behind one adapter file.
5. Perf of realistic rendering + physics on one thread — quality presets + body sleep discipline.

## Execution (loom)

Phases sequential, fan-out within: **P0 toolchain/wasm → P1 binding → P2 tests ∥ P3 example →
P4 packaging → G1 game scaffold+render ∥ asset sourcing → G2 vehicle → G3 damage → G4 world →
G5 HUD/camera/polish → G6 deploy+perf gate.** Dispatch tiers per BRIEF discipline table (sonnet
implements, haiku reads, bash verifies deterministically, loom:verifier gates each phase, Fable
orchestrates/designs P1 + vehicle/damage physics design). Bound: 3 gate passes per phase, then
stop and report.
