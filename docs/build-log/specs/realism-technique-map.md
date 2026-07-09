# Realism Technique Map — physics-based car/destruction sims → Box3D + our game

Read-only domain research (RUN-3). Answers the user directive: *"maximize every true-to-life physics
detail across the entire game"* and *"a deep dive into physics-based car or destruction sims to figure
out what bit of code needs to go where."* Every engine-capability claim cites a vendor header at
`file:line`; every external claim cites a URL. No code changed.

Axis reminder (from `docs/build-log/specs/engine-bay-spec.md`): game world is +Z-forward, +Y-up.

---

## 1. The realism spectrum — what the reference sims actually do

| Sim | Model | One-line mechanism |
|---|---|---|
| **BeamNG.drive** | Soft-body node/beam | Every car is a lattice of mass **nodes** joined by spring **beams**; stress/strain solved thousands of Hz; a beam past its `beamStrength` snaps and stays snapped — deformation is emergent, never pre-baked. [beamng.com/physics](https://www.beamng.com/game/about/physics/), [JBeam docs](https://documentation.beamng.com/modding/vehicle/intro_jbeam/) |
| **Wreckfest** (Bugbear) | **Hybrid** | Rigid-body collision for gameplay determinism, then the rigid impulse **drives collision-sphere deformation of a separate visual mesh** — mesh vertices inside a collision sphere's volume are pushed with it. Extreme mode lowers break thresholds. [steam guide](https://steamcommunity.com/sharedfiles/filedetails/?id=2135331141) |
| **FlatOut 1/2** | Rigid + breakable parts | Many detachable panels (doors, hood, trunk, bumpers); wheels removable → degraded handling. Staged small-bump→panel-deform escalation. [flatout wiki](https://flatout.fandom.com/wiki/Vehicle_Damage) |
| **GTA V / Saints Row** | Arcade | Deformation is **hard-coded from velocity×mass** with per-vehicle `deformation multiplier` (GTA 0.7–5.0×) and flagged deform-spheres; angular damping keeps cars "on-rails." Playability over crash fidelity. [gta5-mods](https://www.gta5-mods.com/vehicles/better-deformation-more-durable-cars), [saintsrowmods](https://www.saintsrowmods.com/forum/threads/vehicle-damage-modeling.2675/) |
| **Red Faction / Teardown** | Structural graph | Continuous **structural-integrity / connectivity** re-check: when a support is removed and no path connects the top of a structure to the ground, the disconnected chunk collapses under gravity. Teardown's core optimization was exactly this "is the bottom still touching the top" connectivity test over millions of voxels. [theringer](https://www.theringer.com/2024/02/02/video-games/destruction-video-games-battlefield-bad-company-red-faction-battlebit-teardown-the-finals), [gmtk](https://gmtk.substack.com/p/how-games-do-destruction) |

**Where we already sit:** we are a **FlatOut/Wreckfest-class rigid + breakable-joint + visual-mesh-crumple**
game. `game/src/damage/welds.ts` = staged FlatOut panel detach; `game/src/damage/crumple.ts` = Wreckfest
collision-driven vertex displacement (already point+approachSpeed driven). We are **not** BeamNG (no
per-node soft lattice) and **not** yet Teardown (no structural connectivity re-check on support loss).

---

## 2. Technique → Box3D capability → our code (per-technique cards)

### T1. Structural collapse graph (Teardown/Red Faction) — atop our weld lattice
- **Ref does:** models the build as a graph; on damage, flood-fills connectivity from the ground; any
  chunk with no path to an anchor is cut loose and falls. Recomputed only on topology change, not per-step.
- **Box3D offers:** nothing native — but our welds already *are* the graph. Bodies = nodes; weld joints =
  edges; `game/src/world/features/buildings/structures.ts` builds the lattice; static/immovable trunks &
  ground are the anchors. Weld break is already detected in `welds.ts:110-144` (constraint-force poll +
  hit-stress). We just don't propagate connectivity loss.
- **Lands in:** new `buildings/structure-graph.ts` (BFS/union-find over the weld set) + a break-callback
  hook in `welds.ts` / building damage. On each weld break, flood from anchors; any body now unreachable →
  break its surviving welds so gravity takes it. Only fires on break events (cheap; tens–low-hundreds of
  nodes).
- **Effort:** Medium. **Payoff:** Very high — brick walls and sheds *actually collapse* instead of hanging
  in mid-air after their base is knocked out. Biggest single "wow" per token; directly serves "dramatic crashes."

### T2. Sustained-contact events (skid / scrape / grind / dust)
- **Ref does:** BeamNG/Wreckfest gate sparks, dust, tire-scrub audio, and scrape damage on *ongoing* contact,
  not just the first-frame impact.
- **Box3D offers:** `b3World_GetContactEvents` returns **begin/end touch** arrays *and* hit arrays
  (`box3d.h:69`; structs `b3ContactBeginTouchEvent` `types.h:1098`, `b3ContactEndTouchEvent` `types.h:1115`).
  **GAP:** our shim reads only `.hitEvents` and drops `.beginEvents/.endEvents` at `src/wasm-shim/binding.c:186`.
- **Lands in:** shim (drain begin/end like the existing hit drain) + `game/src/damage/events.ts` /
  `system.ts` consumers; enables wheel-on-surface skid state, sustained-scrape stress in `welds.ts`, and the
  stubbed impact-audio path (PLAN-2 stretch).
- **Effort:** Low (mirror existing hit-event drain). **Payoff:** Medium-high; unlocks several downstream FX
  cheaply. Foundational.

### T3. Ragdoll de-jitter + powered bracing (active-ragdoll practice)
- **Ref does:** modern ragdolls are **powered** — joints act as PID-driven muscles pulling toward a target
  pose, relaxing on hit; jitter is killed by raising **solver iterations/substeps** and adding joint damping.
  [jettelly](https://jettelly.com/blog/self-balancing-active-ragdoll-in-unity-breakdown-of-an-upcoming-tool),
  [unity ragdoll stability](https://docs.unity3d.com/550/Documentation/Manual/RagdollStability.html)
- **Box3D offers:** spherical joints already carry `enableSpring/hertz/dampingRatio` (`types.h:872-880`) and
  `enableMotor/maxMotorTorque/motorVelocity` (`types.h:900-907`) — **both already wired** (shim
  `b3js_SphericalJoint_EnableSpring/SetSpringHertz/SetSpringDampingRatio/EnableMotor/SetMotorVelocity`).
  Substep count is a world-def knob.
- **Lands in:** `game/src/world/features/occupants/physics.ts` (add spring-damp to the cone/twist joints for
  the seated pose; optionally motor-drive a braced pose that releases above the ejection threshold) +
  world substep tuning.
- **Effort:** Low–Medium. **Payoff:** Medium; the occupants' known twitch (RUN-2 residual) stops buzzing;
  "brace then go limp" reads as lifelike ejection.

### T4. Soft-weld crush stage (BeamNG-lite give-before-break)
- **Ref does:** a BeamNG beam deflects elastically, then plastically, before snapping — the car *gives*.
- **Box3D offers:** weld joints have `linearHertz/angularHertz/…DampingRatio` (`types.h:924-934`); the vendor
  comment states welds *"provide springs to mimic soft-body simulation"* (`types.h:915-916`). We already do
  this for panels: `loosenPanelWeld` sets `LOOSEN_HERTZ` before break (`panels.ts:238`, `welds.ts:84-87`).
- **Lands in:** extend the same soft-then-break to **structural** welds in `buildings/structures.ts` and tree
  roots (`trees/bodies.ts`): a stressed member sags softly for a beat, then breaks — pairs with T1.
- **Effort:** Low–Medium (machinery exists). **Payoff:** Medium; crush reads less "snap-instant," more metal.

### T5. Friction-circle / slip-angle tire model (vehicle-sim fundamental)
- **Ref does:** combined-slip friction circle (Pacejka Magic Formula, or elliptical
  `Fy=Fy0·√(1−(Fx/Fx0)²)`): lateral grip falls off progressively with slip angle and trades against
  longitudinal (throttle/brake) — this is what makes drift/power-oversteer feel real.
  [gamedev traction circle](https://gamedev.net/forums/topic/710462-car-physics-traction-circle-and-friction-curve/),
  [racer.nl pacejka](http://www.racer.nl/reference/pacejka.htm)
- **Box3D offers:** **isotropic Coulomb only** — a single scalar `friction` per surface (`b3SurfaceMaterial.friction`
  `types.h:400`, set via `b3Shape_SetFriction` `box3d.h:864`). `b3World_SetFrictionCallback` (`box3d.h:225`,
  `types.h:169`) only *combines two materials' scalars* — it is **not** slip- or direction-aware, so it cannot
  produce a friction circle. Today we hand-roll a progressive lateral-grip governor as an applied torque
  (`vehicle.ts:665-694`, `987`).
- **Lands in:** `game/src/vehicle/vehicle.ts` — replace the governor with an explicit per-wheel slip-based
  lateral+longitudinal force applied at the contact patch (the "tire converts torque→force" pattern), letting
  box3d's own friction cap the total. Keep wheel joints for suspension/steer geometry only.
- **Effort:** High. **Payoff:** High for driving feel; retires the RUN-2 `WHEEL_FRICTION` fudge and the
  "assist smell."

### T6. Per-surface terrain material (mud vs grass vs asphalt)
- **Ref does:** grip/rolling-drag vary by surface; off-track is slower and looser.
- **Box3D offers:** per-triangle **mesh/heightfield materials** — `b3Shape_SetMeshMaterial(shape, mat, index)`
  (`box3d.h:885`), `b3SurfaceMaterial` carries `friction`, `rollingResistance`, `restitution`, `tangentVelocity`
  (`types.h:400-412`). **GAP:** shim wires none of `SetSurfaceMaterial`/`SetMeshMaterial` (0 hits in
  `binding.c`); terrain friction is a single scalar today.
- **Lands in:** shim (+ `src/ts/shape.ts`) then `game/src/world/terrain/*` — our terrain already has
  muddy_tracks / grass / asphalt textures (`game/dist/assets/terrain/*`); give each region its own μ +
  rolling resistance so the visuals finally drive differently.
- **Effort:** Medium. **Payoff:** Medium-high; whole-map handling variety for little math.

### T7. Anti-roll bar as a real joint (vs applied torque)
- **Ref does:** ARB modelled as two arms on revolute joints coupled by a **torsional spring** on the
  centerline, transferring one wheel's compression to the other.
  [vehiclephysics.com dynamics](https://vehiclephysics.com/components/vehicle-dynamics/)
- **Box3D offers:** `b3ParallelJoint_SetSpringHertz` (`box3d.h:1109`), prismatic spring/limit
  (`box3d.h:1319-1357`), or distance-joint spring (`box3d.h:1147-1168`, `EnableSpring`) between opposite wheel
  carriers. **GAP:** none of parallel/prismatic/distance-spring are shim-wired. Today ARB is an applied
  anti-roll torque (`vehicle.ts:694`).
- **Lands in:** shim (parallel or prismatic-spring) + `vehicle.ts` suspension build. **Effort:** Medium.
  **Payoff:** Medium; removes another applied-assist, more honest weight transfer. (The current assist is
  already *representative* — this is polish, not a correctness fix.)

### T8. Impulse/normal-driven crumple depth (Wreckfest fidelity)
- **Ref does:** deformation magnitude & direction come from the actual collision impulse and contact normal.
- **Box3D offers:** hit events already give `point`, `normal`, `approachSpeed` (`types.h:1151-1157`); begin
  events (T2) give the contact for querying manifold/impulse. Today `crumple.ts` uses `approachSpeed` as an
  energy proxy and dents toward the impact point.
- **Lands in:** `game/src/damage/crumple.ts` — deform along `hit.normal` scaled by a truer energy term.
  **Effort:** Low–Medium. **Payoff:** Medium; dents match crash direction/severity.

### T9. Sensor trigger zones (gameplay, not raw physics)
- **Box3D offers:** `b3World_GetSensorEvents` + `b3SensorBeginTouchEvent` (`box3d.h:66`, `types.h:1053`).
  **GAP:** 0 in shim. **Lands in:** shim + a new zone system (checkpoints, hazard/damage volumes) without
  per-step overlap polling. **Effort:** Low. **Payoff:** Low-medium (more gameplay than realism).

### T10. Spatial queries — multi-hit ray / shapecast / overlap
- **Box3D offers:** collision.h query family; shim wires only `b3js_CastRayClosest` (single closest hit). No
  multi-hit ray, shapecast, or overlap. **Lands in:** shim + `src/ts/world.ts`; enables an alternative
  raycast-suspension tire model, line-of-sight, and area queries. **Effort:** Medium. **Payoff:** Situational.

---

## 3. The honest ceiling — what a rigid-body engine fundamentally cannot do

1. **Continuous soft-body crush (the core BeamNG effect).** Our bodies are rigid: a shape's *collision*
   volume never changes, so a dented hood still collides as its original box. `crumple.ts` deformation is
   **cosmetic only** — it does not feed back into physics. This is the *same* compromise Wreckfest openly
   makes (visual mesh deforms; collision stays rigid spheres). We cannot get emergent frame-bending,
   progressive energy absorption by folding metal, or crumple-zones that change the car's real geometry.
2. **A full soft-body car via soft welds is a dead end at scale.** Weld `linearHertz` gives springy give
   (T4), but the vendor warns the approximate solver *"cannot hold many bodies together rigidly"*
   (`types.h:917`) — a car built from dozens of soft-welded nodes would be mushy and unstable. Soft welds
   are good for a handful of joints (panels, one crush stage), not a lattice.
3. **No native anisotropic/slip-dependent tire friction.** Friction is one isotropic Coulomb scalar
   (`types.h:400`); the friction circle must be hand-rolled as applied forces (T5). The engine will never
   give Pacejka for free.
4. **No asymmetric bump/rebound damper.** Wheel suspension has a single `suspensionDampingRatio`
   (`types.h:959`) — real dampers differ in compression vs extension; we can't split them natively.
5. **No plastic (permanent-set) joints.** A box3d joint springs back or breaks; it cannot *take a bent set*
   the way a real chassis rail does. Permanent deformation lives only in the cosmetic mesh (item 1).

**Best approximations we already have / can add:** staged weld yield (loosen→break, `welds.ts`) ≈ BeamNG
beam yield without the continuum; CPU vertex crumple (`crumple.ts`) ≈ Wreckfest mesh deform; soft-weld crush
stage (T4) for a beat of give; structural-graph collapse (T1) for emergent building failure. These four
together get us convincingly close to a FlatOut/Wreckfest "feels destructible" bar — which is the realistic
ceiling for a rigid-body WASM engine and is exactly where the fun lives.

---

## 4. RANKED roadmap — most realism per token

| # | Technique | Card | Effort | Payoff | Why here |
|---|---|---|---|---|---|
| 1 | **Structural collapse graph** on weld lattice | T1 | Med | ★★★★★ | Buildings/trees actually fall when their base is knocked out; the lattice already exists — this is pure algorithm on top. Peak drama per token. |
| 2 | **Wire contact begin/end events** | T2 | Low | ★★★★ | One shim drain unlocks skids, scrape damage, dust/sparks, and the stubbed crash audio. Foundational multiplier. |
| 3 | **Ragdoll de-jitter + bracing** | T3 | Low | ★★★ | Kills a known RUN-2 residual (twitch) with already-wired spherical spring/motor + a substep bump. |
| 4 | **Soft-weld crush stage** on structural welds/tree roots | T4 | Low-Med | ★★★ | Reuses panel loosen machinery; give-before-break reads as metal, pairs with #1. |
| 5 | **Per-surface terrain materials** (μ + rolling) | T6 | Med | ★★★ | Textures already exist; small shim add makes mud/grass/asphalt drive differently everywhere. |
| 6 | **Impulse/normal-driven crumple depth** | T8 | Low-Med | ★★★ | Dents match crash direction & energy; small edit in `crumple.ts`, big fidelity bump. |
| 7 | **Friction-circle tire model** | T5 | High | ★★★★ | The real handling upgrade; retires `WHEEL_FRICTION` fudge + governor smell. High effort keeps it below the cheap wins. |
| 8 | **Anti-roll bar as a joint** | T7 | Med | ★★ | Honesty polish over the working applied-torque assist; not a correctness fix. |
| 9 | **Powered-ragdoll brace pose** | T3+ | Med | ★★ | Extends #3 into active bracing; nice-to-have. |
| 10 | **Sensor trigger zones** | T9 | Low | ★★ | Cheap gameplay scaffolding (checkpoints/hazard volumes); more game than sim. |

**Coverage note (coordinate w/ parallel coverage audit):** shim gaps this map depends on —
contact begin/end drain (`binding.c:186` drops them), `SetSurfaceMaterial`/`SetMeshMaterial` (0),
`SetFrictionCallback` (0, and insufficient for #7 anyway), parallel/prismatic/distance-spring joints (0),
sensor events (0), multi-hit ray/shapecast/overlap (0). All verified by grep of
`src/wasm-shim/binding.c` at HEAD; joint break-force & spherical joints are already wired (RUN-2 SHIMEXT).
