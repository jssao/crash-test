# Destructibles Inventory — FRACTURE Feasibility (P0d)

**Task**: Inventory how every destructible world-object type currently reacts to impact, and what
box3d-js gives us to implement bodies actually *snapping into pieces mid-member* (not just joints
separating pre-built segments).

**Source inspection**: `game/src/world/**` (features/trees, features/buildings, bodies.ts,
materials.ts, tuning.ts), `game/src/damage/**` (panels.ts, system.ts, welds.ts, damage-tuning.ts),
`src/ts/*.ts` (body.ts, shape.ts, joint.ts, world.ts, events.ts).

**Headline finding**: every destructible in this codebase is either (1) a single rigid body that
never splits, or (2) a pre-built assembly of multiple separate rigid bodies wired together with
break-away `WeldJoint`/`SphericalJoint`s. **No code path anywhere splits ONE body into several at
runtime.** "Fracture" would be new work, but the engine primitives it needs (destroy/recreate a
body cheaply, poll `getConstraintForce()`, `Shape.setHull()`) are already proven in production at
this exact call pattern (weld-break + panel-hull-refresh), so the join-break polling pattern is the
right thing to generalize/reuse.

---

## A. Trees (`game/src/world/features/trees/{bodies,tuning,index}.ts`)

Three size classes, all built in `createTreesWorld()` (`bodies.ts:423`). Never any runtime split —
only pre-built joint separation.

| Class | Bodies | Joint | Break mechanism | File:line |
|---|---|---|---|---|
| Sapling | 1 dynamic capsule trunk + 1 static anchor | `SphericalJoint` (cone limit + spring, bends under push) | Per-step poll of `getConstraintForce()`/`getConstraintTorque()` vs `SAPLING_FORCE_THRESHOLD_N=6000`/`SAPLING_TORQUE_THRESHOLD_NM=2500`; `joint.destroy()` frees the trunk to topple | `bodies.ts:103-175`, thresholds `tuning.ts:164-165` |
| Mid ("felled" tree) | 1 dynamic capsule trunk + 1 static anchor | `WeldJoint`, angularly compliant (`MID_WELD_ANGULAR_HERTZ=4`, linear rigid) so it visibly leans before felling | Same per-step poll pattern vs `MID_FORCE_THRESHOLD_N=550_000`/`MID_TORQUE_THRESHOLD_NM=140_000`; weld destroyed → whole trunk is now a free rigid body (never despawned, stays a live hazard) | `bodies.ts:191-255`, thresholds `tuning.ts:196-197` |
| Large ("stops the car") | 1 **static** trunk (never moves, deliberately immovable) + 2-3 dynamic branches | Each branch: `WeldJoint` to trunk, compliant angular (`LARGE_WELD_ANGULAR_HERTZ=40`) so it droops/bends before snapping | Same poll pattern per branch vs `LARGE_BRANCH_FORCE_THRESHOLD_N=30_000`/`_TORQUE_THRESHOLD_NM=12_000` — LOWER than the trunk-level thresholds so branches "snap off dramatically" while the trunk itself is unbreakable (static) | `bodies.ts:261-370`, thresholds `tuning.ts:242-243` |

- **Poll technique** (all 3 classes, `bodies.ts:159-175, 242-255, 355-370`, called every fixed step
  via `stepTreesWorld()` at `bodies.ts:439-445` / `index.ts:35-44`): deliberately **not**
  `world.jointEvents()` — the module doc comment (`bodies.ts:8-11`) states jointEvents only reports
  for *awake* joints, and the trees spawn asleep (`bodies.ts:137,221,324`, "spawn-asleep discipline"
  doc `bodies.ts:16-18`). Same technique as `damage/welds.ts`.
- **No split ever happens.** "Felling" = destroying one joint, letting the pre-existing single
  rigid trunk body swing free under gravity/residual velocity. The large tree "stopping the car" is
  simply a `BodyType.Static` trunk (`bodies.ts:306`) — permanently immovable by construction, not a
  damage state.
- Reset (`resetSapling/resetMid/resetLarge`, `bodies.ts:144-157, 225-237, 331-350`) is the ONE place
  a tree body is destroyed+recreated at runtime — but only to restore a broken tree to pristine, not
  to fracture one. This is nonetheless a working, exercised example of "destroy body, build a fresh
  one with the same shape, re-weld" happening mid-session (triggered by Shift+R), useful as a
  template for a fracture rebuild path.
- Bend/droop is reported for feel (not physics): `trunkTiltDeg()`/`largeBranchDroopCount()`
  (`bodies.ts:379-408`) read live rotation vs spawn rotation — no stored flag, honest instantaneous
  read.

## B. Buildings feature (`game/src/world/features/buildings/{structures,common,tuning}.ts`)

Shed, house-corner (drywall+studs+pipes), free-standing brick wall, 6 fence-line segments. All
built via `buildAllStructures()` (`structures.ts:555-559`). Every "piece" (stud/plank/roof/drywall/
brick/post/rail/pipe/footing) is **one dynamic rigid body for its entire life** — bodies are never
destroyed except by full reset; only the `WeldJoint`s linking them break.

### Shed (`buildShed()`, `structures.ts:297-358`)
- Static footing + 4 wall runs, each a line of stud bodies welded to the footing
  (`WOOD_BREAK_FORCE_N=3500`/`WOOD_BREAK_TORQUE_NM=1800`, `tuning.ts:67-68`) plus plank "bay" panels
  welded to their nearest stud (same thresholds).
- Roof: 2 sloped rows × `SHED_ROOF_PANEL_SPLITS=3` segments, each welded to its nearest wall-top
  stud at `0.6×` the wood thresholds (`structures.ts:349`).
- "Collapse" = enough stud/plank/roof welds break that pieces topple/scatter under gravity — it is
  a cascade of independent 2-body joint separations, not a single member breaking into fragments.
  No piece is ever subdivided.

### House corner (`buildHouseCorner()`, `structures.ts:420-442`)
- Same stud+footing pattern (wood thresholds) plus drywall sheets on both faces, each welded to its
  nearest stud (`DRYWALL_BREAK_FORCE_N=1100`/`_TORQUE_NM=520`, `tuning.ts:78-79` — lowest thresholds
  in the feature, "the car punches through easily" per spec).
- 2-3 free-standing vertical pipe capsules sit **unwelded** in the cavity (`structures.ts:433-438`)
  — they were never attached to anything; they just physically scatter once drywall stops blocking
  them. Not a fracture case (no joint to break at all).

### Brick wall (`buildBrickWall()`, `structures.ts:449-511`)
- ~160 individual brick boxes (`BRICK_WALL_COLUMNS=10 × BRICK_WALL_ROWS=16`, `tuning.ts:257-258`) in
  running-bond, each its own rigid body, linked by a **weld lattice**: horizontal same-row welds +
  vertical nearest-overlap welds to the row below (or footing for row 0) (`structures.ts:476-506`).
  `BRICK_BREAK_FORCE_N=3200`/`_TORQUE_NM=650` inter-brick; much stronger
  `BRICK_FOOTING_BREAK_FORCE_N=11000`/`_TORQUE_NM=2600` at the base (`tuning.ts:91-99`).
- This is the closest thing to "shattering" in the codebase, but it's still discrete pre-built
  bricks separating at mortar joints — **no brick itself ever splits**. `BRICK_PROFILE.breakOnly =
  true` (`tuning.ts:154-164`) — masonry is brittle/break-only, never enters the soft-yield stage
  (see plastic-yield model below).

### Fence lines (`buildFenceLine()`, `structures.ts:517-553`, 6 configs `tuning.ts:275-282`)
- Posts (welded to footing) + 2 rails per span (welded to the near post), lowest thresholds in the
  whole feature (`FENCE_BREAK_FORCE_N=700`/`_TORQUE_NM=350`, `tuning.ts:110-111`) — "fences are
  meant to break away easily." A "2x4 rail" is one rigid box body that pops free of its post weld;
  it is never itself subdivided/splintered.

### The plastic-yield state machine (generalizes weld break, `structures.ts:605-663`)
Per joint, per step (`pollStructureBreaks()`, called after `world.step()`):
1. **BREAK first**: `getConstraintForce()`/`getConstraintTorque()` magnitude vs
   `spec.forceThresholdN * profile.ductileBreakMult` — if exceeded, clamp the freed piece's
   velocity (`clampDebrisVelocity()`, impulse-proportional release, `structures.ts:161-174`),
   `joint.destroy()`, mark broken.
2. Else **YIELD** (skipped entirely if `profile.breakOnly`, e.g. masonry): a still-rigid weld whose
   force/torque crosses a lower fraction softens IN PLACE via
   `joint.setLinearHertz/setAngularHertz/setLinearDampingRatio/setAngularDampingRatio()`
   (`structures.ts:650-660`) — same runtime softening trick as `damage/panels.ts`'s
   `loosenPanelWeld()`. The piece visibly leans/bulges but stays attached (`ductileBreakMult` > 1
   for ductile wood/fence/roof; = 1, `breakOnly` for brittle brick/drywall).

This yield→break state machine (not a single-shot event) is the single most fracture-adjacent
pattern already in the codebase: **it already treats a joint's failure as a graduated material
response**, just never releases a *fragment* — only a whole pre-existing piece.

## C. Legacy world destructibles (`game/src/world/{bodies,tuning}.ts`)

Stacked-block walls, crate tower, barrel bowling triangle, tippable poles, 2 static ramps — built
in `createDestructibleWorld()` (`bodies.ts:309-326`). **None of these have ANY joints at all** —
every piece is an independent dynamic rigid body relying purely on friction/gravity/stacking
contact, spawned asleep (`bodies.ts:317-321`).

| Kind | Body | Notes | File:line |
|---|---|---|---|
| Wall blocks | Box, `WALL_COLS×WALL_ROWS` grid, mass varies by row (30kg bottom → 8kg top) | No joints; a hit just scatters loose boxes | `bodies.ts:187-207`, `tuning.ts:44-54` |
| Crate tower | Box, 8 layers (top 2 taper 3×3→2×2) | No joints; stacked purely by friction | `bodies.ts:209-231`, `tuning.ts:74-82` |
| Barrels | 12-gon convex hull (`createHullShape`), bowling triangle (1+2+3+4=10) | No joints. Tagged with `Body.setUserData(BARREL_ENTITY_ID_BASE+i)` for the exploding-barrels feature | `bodies.ts:233-271`, `tuning.ts:88-99` |
| Poles | Single uniform box (compound base explicitly ruled out — box3d boxes have no off-origin center, `tuning.ts:176-183`) | No joints; tips over freely | `bodies.ts:273-288` |
| Ramps | Static convex-hull wedge | Static, never destroyed | `bodies.ts:290-301` |

**Exploding barrels** (`bodies.ts:363-580`) is the one place a body's *shape* is never split but a
whole-body **impulse cascade** exists: `world.explode()` (`src/ts/world.ts:195-201`, radial
impulse to spheres/capsules/hulls) plus a direct rocket impulse
(`applyLinearImpulseToCenter`, `bodies.ts:500-504`) and neighbor barrels get a short random fuse
(`triggerBarrelExplosion()`, `bodies.ts:475-523`). This never creates/destroys bodies or shapes —
it's pure impulse application to existing rigid bodies. Relevant to fracture only as an existing,
proven "chain reaction across many bodies driven by hit events" pattern, not as body-splitting.

Reset (`resetDestructibleWorld()`, `bodies.ts:334-346`) teleports+resleeps in place (bodies are
"never destroyed/mutated by any other system," doc comment `bodies.ts:330-333`) — confirms these
bodies never split/merge during normal play; `destroyDestructibleWorld()` (`bodies.ts:352-361`,
full teardown) exists but isn't on the normal reset path.

## D. Car damage system (`game/src/damage/{panels,system,welds,damage-tuning}.ts`)

Not one of the world-object types the user named, but it is the **only place in the codebase that
swaps a body's shape at runtime**, and is the direct precedent for a fracture implementation:

- **`breakPanelWeld()`** (`panels.ts:253-271`): destroys the weld, then
  `panel.shape.destroy(false)` + `panel.body.createBoxShape(...)` — same body, brand-new shape,
  same box geometry/density so mass is conserved (`Body.createBoxShape` recomputes mass from ALL
  current shapes, doc `panels.ts:250-252`). The panel body itself is never destroyed — it goes on
  living as a free rigid body (hood/door/trunk flying off), later despawned by a timer/distance
  rule (`system.ts:509-534`, `PANEL_DESPAWN_AFTER_S=25`/`PANEL_DESPAWN_DISTANCE_M=100`,
  `damage-tuning.ts:330-333`). **This is one rigid body detaching from the chassis assembly, not
  one body splitting into two** — same category as the trees/buildings joint-break pattern, just
  applied to the car's own construction.
- **`loosenPanelWeld()`** (`panels.ts:238-245`): the softened-weld-in-place trick that
  `buildings/structures.ts`'s yield stage above copies verbatim.
- **`Shape.setHull()` runtime dent-following** (`system.ts:285-374`, `refreshPanelHulls()`): rate-
  limited (`PANEL_HULL_REFRESH_MIN_STEPS=30` steps apart, ≤1 panel/step, `damage-tuning.ts:421-429`)
  rebuild of a panel's *own* collision hull from its cosmetically-deformed mesh's dented-region mean
  offset — geometry mutation of an EXISTING shape in place, not a split. Confirms `Shape.setHull()`
  is cheap enough for periodic runtime use but the codebase explicitly treats "≤1 rebuild per fixed
  step" as the safe rate (doc `damage-tuning.ts:415-429`), a real perf data point for any fracture
  design that would call `createHullShape`/`destroy` more aggressively.
- **Weld constraint-force noise, documented directly** (`damage-tuning.ts:54-74`,
  `PANEL_LOOSEN_FORCE_MULT`/`PANEL_BREAK_FORCE_MULT` doc comment): *"a panel WELDED AT the impact
  zone... reads single-step spikes in the ~1e5-1e6 N range for ANY real contact from ~30km/h
  upward... because that reading conflates the weld's tension with the panel's OWN contact-
  resolution impulse each substep."* This is the exact noisy-single-substep caveat the task asked
  to cite — the direct force-spike path is real but a *secondary/rare* trigger; the codebase's
  actual load-discrimination signal is **speed-based accumulated event stress** (`welds.ts:199-236`,
  `STRESS_K * approachSpeed * falloff * directionFactor * massFactor`), not raw joint force.

## E. Materials / mass registry

- **`world/materials.ts`**: visual-only (procedural `THREE.CanvasTexture` PBR maps) — concrete,
  brick, wood-crate, barrel-blue, barrel-rust (`buildDestructibleMaterials()`, `materials.ts:263-271`).
  No physical-material coupling; friction/restitution/mass live in `tuning.ts` files, not here.
- **Per-object masses** (kg): sapling 9 (`trees/tuning.ts:153`), mid tree trunk 320
  (`trees/tuning.ts:177`), large-tree branch 15 (`trees/tuning.ts:214`); wood stud 3.5 / plank 5
  (`buildings/tuning.ts:62-63`); drywall panel 12 (`:73`); brick 2.7 (real fired-clay density,
  `:84`); pipe 4 (`:101`); fence post/rail 2.5 (`:107`); wall block 8-30 varying by row
  (`world/tuning.ts:48-49`); crate 15 (`:75`); barrel 25 (`:91`); pole 40 (`:188`); car panels
  hood 13 / doorL,R 16 each / trunk 14 (`damage/damage-tuning.ts:22-26`).
- **`setForeignMass()`** (`damage/system.ts:121-124`): a foreign-body **mass registry** (entity id
  → kg) that lets the damage model attenuate car-damage by `e = m_other/(m_other+m_car)`
  (`welds.ts:116-119`) when something light (a brick/plank/sapling) hits the car — this is a
  *car-damage* weighting knob, not a world-object durability system. Barrels are tagged via
  `Body.setUserData()` (`world/bodies.ts:254`) for the exploding-barrels feature specifically, not
  for `setForeignMass()` — I found **no call site registering trees/fences/bricks/crates/barrels
  into `setForeignMass()`**; grep confirms `setForeignMass(` is only called from car/vehicle-side
  code, not any world feature. (not found: a world-object owner calling `setForeignMass()`.)

---

## F. Engine capability (`src/ts/{body,shape,joint,world}.ts`)

### F1. Runtime body/shape creation & destruction — cheap and exercised in production
- **`Body.destroy()`** (`body.ts:405-413`) / **`World.createBody()`** (`world.ts:266-277`): plain
  native calls, no special cost documented; used routinely at runtime by every reset path
  (trees `bodies.ts:146-149,228-229,336-341`; car panel despawn `damage/system.ts:527-530`).
- **`Shape.destroy(updateBodyMass=true)`** (`shape.ts:383-391`) / **`Body.create*Shape()`**
  (`body.ts:265-403`): the panel-break shape swap (`damage/panels.ts:258-269`) does exactly
  destroy-then-recreate on a LIVE body every time a panel breaks during actual gameplay — proven,
  cheap enough for a per-crash-event (not per-frame) cadence.
- **`Shape.setHull(points)`** (`shape.ts:215-227`): in-place geometry replacement, "cheap enough for
  rate-limited runtime dent-following..., not per-frame" (doc comment) — used by
  `damage/system.ts`'s `refreshPanelHulls()` at ≤1 panel/fixed-step. This is the cheapest fracture-
  adjacent primitive available: shrink/reshape a hull without touching mass, joints, or the body
  handle at all.
- **`Joint.destroy(wakeAttached=true)`** (`joint.ts:96-104`): has a documented **hazard** — calling
  it with `wakeAttached=false` on a sleeping body's joint is "a vendor solver-set/island bookkeeping
  hazard that can corrupt wasm memory (observed as a 'memory access out of bounds' trap that
  permanently poisons the module)" (doc comment `joint.ts:87-95`; also flagged live in
  `buildings/structures.ts:576-586`, which deliberately never uses the risky flag). **Any fracture
  code that destroys joints/bodies on possibly-asleep pieces must wake them first or accept the
  default `true`.**
- **Answer: YES**, bodies/shapes can be created and destroyed mid-simulation, and it's cheap enough
  that it already happens on every reset and every panel break in the shipped game — but there is a
  documented crash hazard around destroying joints on sleeping bodies that any fracture code must
  respect (default `wakeAttached=true`, or explicitly wake first).

### F2. Joint constraint-force reading as a bending-load signal — YES, but noisy; the codebase already worked around it
- `Joint.getConstraintForce()`/`getConstraintTorque()` (`joint.ts:41-55`) are real and used
  everywhere joints break: trees (`trees/bodies.ts:165-168,246-248,359-362`), buildings
  (`buildings/structures.ts:632-633`), car panels/wheels (`damage/welds.ts:193,261`).
- **Documented caveat** (`damage/damage-tuning.ts:54-74`): at a body's own impact zone, single-step
  readings spike ~1e5-1e6 N (1000×+ static weight) because "FIXED_SUBSTEPS=12 (~1.4ms/substep)...
  makes any impulsive contact read as a huge instantaneous force" conflating weld tension with the
  panel's own contact-resolution impulse. Panels *not* directly struck read a cleaner, roughly
  speed-monotonic signal. The shipped game's answer: use raw joint-force spikes only as a rare/
  secondary trigger (very high multiplier thresholds), and drive the *primary* break/yield decision
  from **event-driven, approach-speed-weighted accumulated stress** instead
  (`welds.ts:199-236`, `buildings/tuning.ts`'s yield-profile force/torque fractions read off the
  same `getConstraintForce()`/`Torque()` polling, not a separate stress accumulator, so buildings
  DOES rely on the raw joint force/torque directly — trees and buildings poll constraint force per
  step and it works; only the car-panel weld's *direct*-force-spike path additionally needed the
  workaround because that panel sits right in the impact zone).
- **Answer: YES**, reliable enough to gate break/yield when polled per-step against calibrated
  thresholds (trees + buildings do this in production) — but a threshold picked from a body's own
  impact-adjacent joint will read enormous single-substep spikes; calibrate empirically per contact
  geometry (as `trees/tuning.ts` and `buildings/tuning.ts` both do, with explicit "calibrated
  empirically" doc comments) rather than assuming a physically-derived force number will hold.

### F3. Existing "break a body into pieces" helper — NOT FOUND
- Grepped `fracture|split|shatter|snap` across all of `game/src` and `src/ts`. Zero hits describe
  splitting a rigid body's own geometry into fragments. Every "snap"/"shatter"/"split" hit found is
  either: a joint snapping free (trees/buildings/fences), a car glass-pane "shatter" (material swap
  + destroy one existing shape, `damage/system.ts:236-263`, `vehicle/vehicle.ts` — not a
  fragmentation), or unrelated code-organization "split" (module/ownership boundaries, mass-split
  arithmetic).
- **Not found**: any `fractureBody()`/`splitHull()`/`shatterBody()` helper, any convex-decomposition
  utility, any code path that creates 2+ new bodies from 1 existing body's shape at a break event.
- box3d's own convex-hull machinery (`createHullShape`, `vendor/box3d`) computes ONE hull from a
  point cloud — there is no vendor-level "split this hull along a plane" primitive surfaced through
  `src/ts`. A fracture feature would need to be built from scratch: e.g. pre-author N fragment
  hulls per fracturable object (offline or procedurally) and, on break, `body.destroy()` the intact
  piece + `world.createBody()`×N for the fragments (mirroring the tree/panel destroy-and-rebuild
  pattern above), OR keep the fragments pre-built-but-welded from the start (trees/buildings' actual
  approach) and simply add more/finer weld seams for a "shatters into more chunks" look without new
  engine work.

### F4. Perf context: body-count budget
- **Total world body count target: ≥400, final measured ≈520-524.** Source:
  `docs/build-log/PLAN-2.md:46` ("≥400 physics bodies... world"),
  `PLAN-2.md:114` ("Feature bodies 343 → world total ≈520 (item 10b ≥400 ✓)"),
  `PLAN-2.md:117` (loom:verifier GATE-B: "~524 bodies ≥400"). Per-feature breakdown at that gate:
  cardetail 39, occupants 48 (4×11 ragdolls+seat pans), trees 40, buildings 216
  (`PLAN-2.md:114`), the legacy `world/bodies.ts` destructibles ~120-180
  (`bodies.ts:304-308` doc comment "~110-160 dynamic destructible bodies"), plus the vehicle itself
  (chassis+4 wheels+4 panels+2 glass+9 segments, `damage/system.ts:47-54`).
- **Buildings feature alone is asserted in CI at 200-260 bodies**: `game/verify/feature-buildings.mjs:331-332`
  and `game/verify/materials-truth.mjs:219` both throw if
  `window.__GAME__.features.buildings.totalPieceCount()` falls outside `[200,260]`.
- **Perf gate**: `avg < 8ms` per fixed step is REQUIRED (`game/sim/perf-bench.mjs:12`); measured at
  full 453-dynamic-awake chaos load (all destructibles force-woken, brick crash in progress):
  **0.565ms avg / 1.372ms p95 / 2.564ms max** (`PLAN-2.md:119`, "14× margin"), and later
  **0.580ms avg** at the final gate (`PLAN-2.md:124`). Headed real-GPU: 120fps at spawn AND
  mid-crash vs a ≥55fps gate (`PLAN-2.md:119`, `game/verify/perf-headed.mjs`).
  `FIXED_SUBSTEPS = 12` (`vehicle/tuning.ts:826`).
- **Implication for fracture**: there is real headroom (~14×) under the current worst-case
  measurement, but that measurement was taken at ≈453-520 bodies; a fracture feature that
  multiplies body count per break event (e.g. 1 brick → 4 shards on every one of ~160 bricks) could
  plausibly blow well past the 8ms gate and the buildings feature's hard-coded `[200,260]`
  body-count CI assertions (`feature-buildings.mjs:331-332`, `materials-truth.mjs:219`) would need
  updating or the fracture would need to be capped/pooled (e.g. only the FIRST break per structure
  fragments finely; subsequent debris behaves as today).

---

## What I could not trace / gaps
- No explicit single "body-count budget" constant in code (e.g. no `MAX_BODIES` or similar) — the
  ≈520 figure is a measured/reported outcome in `docs/build-log/PLAN-2.md`, not an enforced runtime
  cap, except for the buildings feature's own CI range-check (`feature-buildings.mjs:331-332`).
- Did not find any world-feature (trees/buildings/legacy destructibles) registering itself with
  `damage/system.ts`'s `setForeignMass()` — only the car/vehicle side appears to call it, so today
  a car hitting a light plank/brick does NOT get the mass-aware damage discount unless something
  else already wires it in that I didn't locate; flagging as "not found" rather than asserting
  absence beyond what grep + the read files show.
- Did not evaluate the `game/src/world/features/cardetail` or `occupants` features in depth (out of
  scope per the task's object list) — mentioned only for body-count context.
- Did not benchmark what an actual fracture prototype would cost; F4's "≥400 body, 0.58ms avg, 8ms
  gate" figures are the best available proxy, not a fracture-specific measurement.
