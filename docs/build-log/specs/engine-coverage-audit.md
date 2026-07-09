# Box3D Engine Coverage Audit — symbol-level "what's on the table"

**Task:** RUN-N read-only research. Every public capability the engine exposes vs. what the
WASM shim (`src/wasm-shim/binding.c`) wires, what `src/ts/*` exposes, what `game/src/*` uses,
and — for each unused capability — a concrete application in THIS crash sandbox or an honest
"no application".

**Method:** walked `vendor/box3d/include/box3d/{box3d,types,collision}.h` completely (every
public `b3*` function + every def-struct field). "Wired" = the real `b3*` symbol is *called* in
`binding.c` (comment-only mentions like the deferred `b3CreateCompoundShape` at binding.c:705 do
NOT count). Citations are `header:line` for engine claims; game/shim claims cite `path:line`.

**Legend:** ✅ wired/exposed/used · ⚠️ partial · ❌ absent · (c) = settable at creation only, no
runtime setter.

---

## 0. Headline counts

- Public `b3*` API functions in headers: ~330. Real functions *called* by the shim: ~70
  (bodies, 5 joint types, sphere/capsule/box/hull/mesh/heightfield shapes, closest-ray, hit +
  move + joint event drain, gravity get/set).
- **Whole subsystems with ZERO wiring:** sensor events, contact begin/end events, pre-solve &
  custom-filter callbacks, multi-hit ray / shapecast / overlap queries, CastMover/CollideMover,
  `b3World_Explode`, per-shape contact-data (manifold impulses), compound shapes (explicitly
  deferred, binding.c:705), wind, motor/prismatic/parallel/filter joints, `b3Shape_ApplyWind`,
  runtime material/damping/gravity-scale setters.

---

## A. Full capability table

### A.1 WorldDef fields (`types.h:140–215`) & world-level knobs (`box3d.h`)

| Capability | Engine ref | Shim | TS | Game | Application / verdict |
|---|---|---|---|---|---|
| gravity | types.h:143 | ✅ | ✅ | ✅ | world gravity; runtime get/set both wired (box3d.h:168) |
| restitutionThreshold | types.h:147 | ❌(default) | ❌ | ❌ | minor — global bounce cutoff; leave default |
| hitEventThreshold | types.h:151 | ✅(c) | ✅ | ✅ | damage system's impact gate (world.ts:63) |
| **contactHertz / contactDampingRatio** | types.h:154/158 | ✅(c) | ✅ | ✅ | global contact softness (world.ts:64) |
| **contactSpeed** (push-out cap) | types.h:163 | ❌ | ❌ | ❌ | tune overlap-recovery pop on stacked debris; low value |
| maximumLinearSpeed | types.h:166 | ❌(default) | ❌ | ❌ | raise to let high-speed crashes not clamp; niche |
| frictionCallback / restitutionCallback | types.h:169/172 | ❌ | ❌ | ❌ | per-material-pair mixing (tire↔ice vs tire↔asphalt). Game uses isotropic sqrt-mix; real payoff but M effort |
| enableSleep | types.h:175 | ✅(c) | ✅ | ✅ | perf; used |
| enableContinuous | types.h:178 | ✅(c) | ✅ | ✅ | CCD on; used (native.ts:28) |
| workerCount / task callbacks | types.h:186 | ❌ | ❌ | ❌ | WASM single-thread; **no application** |
| `b3World_SetContactTuning` | box3d.h:184 | ❌ | ❌ | ❌ | runtime version of contactHertz; see contactSpeed |
| **`b3World_Explode` / ExplosionDef** | box3d.h:176, types.h:1011 | ❌ | ❌ | ❌ | **fuel-tank / barrel / grenade blasts** — the crash-sandbox money feature. impulsePerArea + falloff already area-aware |
| `b3World_GetProfile` / `GetCounters` | box3d.h:210/213 | ❌ | ❌ | ❌ | perf HUD / soak diagnostics; dev-only |
| `b3World_GetSensorEvents` | box3d.h:66 | ❌ | ❌ | ❌ | see A.4 sensor events |
| pre-solve / custom-filter callbacks | box3d.h:160/163 | ❌ | ❌ | ❌ | one-way platforms, conditional collision; game uses groupIndex instead |

### A.2 BodyDef fields (`types.h:267–349`) & body API (`box3d.h:487–772`)

| Capability | Engine ref | Shim | TS | Game | Application / verdict |
|---|---|---|---|---|---|
| type/position/rotation | types.h:270/275/278 | ✅ | ✅ | ✅ | core |
| linear/angularVelocity (init) | types.h:281/284 | ❌(c-via-setter) | ⚠️ | ✅ | set post-create via `SetLinearVelocity` |
| linearDamping / angularDamping | types.h:291/297 | ✅(c) | ✅ | ✅ | (world.ts:140); no runtime setter (box3d.h:653/659) |
| gravityScale | types.h:300 | ✅(c) | ✅ | ⚠️ | floaty debris / smoke props; runtime setter (box3d.h:666) ❌ |
| **sleepThreshold** | types.h:303 | ❌ | ❌ | ❌ | keep lightweight debris settling instead of jittering; S |
| **motionLocks** (6-DOF) | types.h:312, box3d.h:701 | ❌ | ❌ | ❌ | lock hanging-sign to swing on 1 axis; garage-door slide; niche vs prismatic |
| isBullet (CCD) | types.h:334 | ✅(c) | ✅ | ✅ | chassis CCD (vehicle.ts:303); runtime `SetBullet` (box3d.h:708) ❌ — can't bulletize spawned projectiles |
| allowFastRotation | types.h:341 | ✅(c) | ✅ | ✅ | wheels spin past clamp (vehicle.ts:340) |
| enableContactRecycling | types.h:345 | ❌ | ❌ | ❌ | ghost-collision fix for characters; minor |
| Apply Force/Torque/Impulse (×6) | box3d.h:573–617 | ✅ | ✅ | ✅ | powertrain, damage push |
| **`GetWorldPointVelocity`** | box3d.h:564 | ❌ | ❌ | ❌ | true contact-point closing speed for damage + skid audio (better than body-COM approachSpeed); S |
| SetMassData / GetMassData / ApplyMassFromShapes | box3d.h:640–650 | ✅ | ✅ | ✅ | ballast-sensor CoM trick (tuning.ts:116) |
| **`Body_GetContactData`** | box3d.h:748 | ❌ | ❌ | ❌ | resting-contact wheel-ground test (cheaper/robuster than ray); wreck-pile settling checks; M |
| `SetTargetTransform` (kinematic) | box3d.h:558 | ❌ | ❌ | ❌ | scripted moving platform / crusher piston driven by pose; pairs with motor joint |
| `Body_CastRay/CastShape/OverlapShape/CollideMover` | box3d.h:758–772 | ❌ | ❌ | ❌ | per-body precise queries; subset of world queries |
| `ComputeAABB` / `GetClosestPoint` | box3d.h:752/755 | ❌ | ❌ | ❌ | culling / proximity; dev-only |

### A.3 SurfaceMaterial (`types.h:398–422`) & shape API

| Capability | Engine ref | Shim | TS | Game | Application / verdict |
|---|---|---|---|---|---|
| friction | types.h:401 | ✅(c) | ✅ | ✅ | asphalt/tire/wall (vehicle.ts:315, shape.ts:42) |
| restitution | types.h:405 | ✅(c) | ✅ | ✅ | (shape.ts:43) |
| **rollingResistance** | types.h:408 | ✅(c) | ✅ | ✅ | wheels (vehicle.ts:349) — wired THIS run |
| **tangentVelocity** (conveyor) | types.h:412 | ❌ | ❌ | ❌ | conveyor belt / moving-walkway sandbox prop; treadmill dyno; S-M |
| userMaterialId | types.h:416 | ❌ | ❌ | ❌ | surface-typed impact SFX (metal vs concrete vs glass) — arrives free in hit events (types.h:1160); pairs w/ A.4 |
| customColor / debugMaterial | types.h:421, types.h:2907 | ❌ | ❌ | ❌ | debug-draw only; renderer is custom three.js — **no application** |
| per-triangle `materials[]` on mesh/hf | types.h:465, box3d.h:885 | ❌ | ❌ | ❌ | mud-patch vs asphalt on the one terrain mesh; M |
| runtime `Shape_SetFriction/Restitution/SetSurfaceMaterial` | box3d.h:864/870/876 | ❌ | ❌ | ❌ | wet-road / ice event mid-session; heat-up grip; M |
| `Shape_SetDensity` (runtime) | box3d.h:858 | ❌ | ❌ | ❌ | fuel-burn mass loss; niche |
| **`Shape_GetContactData`** (manifold) | box3d.h:975, types.h:2602 | ❌ | ❌ | ❌ | real solved normal/friction/**rollingImpulse** (types.h:2617) per point → physically-honest crumple depth & scrape-spark rate instead of approachSpeed heuristic (damage-tuning.ts:73); M |
| **`Shape_ApplyWind`** (drag+lift, area-aware) | box3d.h:1010 | ❌ | ❌ | ❌ | wind gusts on light debris/signs/trees; tarp/flag flutter; S wrapper |
| `Shape_RayCast` / `GetClosestPoint` | box3d.h:931/999 | ❌ | ❌ | ❌ | single-shape probe; subset of world ray |

### A.4 Events (`types.h:1052–1272`) & queries

| Capability | Engine ref | Shim | TS | Game | Application / verdict |
|---|---|---|---|---|---|
| move events | types.h:1201 | ✅ | ✅ | ✅ | transform sync (main.ts) |
| **hit events** (approachSpeed, materialIds) | types.h:1135 | ✅ | ✅ | ✅ | damage (binding.c:182); **materialIds dropped** in drain (binding.c:187) |
| joint events (force/torque threshold) | types.h:1230 | ✅ | ✅ | ✅ | weld-break yield staging |
| **contact begin/end events** | types.h:1098/1115 | ❌ | ⚠️enable-only | ❌ | `enableContactEvents` is settable (shape.ts:45) but begin/end arrays are NEVER drained (binding.c only reads hitCount). **Scrape/skid detection** (sustained sliding contact → continuous spark/screech, tire-mark decals) needs these — hit events are one-shot; M |
| **sensor events** (begin/end touch) | types.h:1052, box3d.h:66 | ❌ | ❌ | ❌ | occupant-in-seat / trigger-volume / checkpoint / "car entered garage" WITHOUT polling. Game already builds sensor shapes (ballast, attached-detail) so plumbing half-exists; M |
| `Shape_GetSensorData/Capacity` | box3d.h:981/990 | ❌ | ❌ | ❌ | poll-style sensor overlap; alt to sensor events |
| **CastRayClosest** | box3d.h:98 | ✅ | ✅ | ⚠️ | wired (binding.c:304); game usage light |
| multi-hit `CastRay` (callback) | box3d.h:93 | ❌ | ❌ | ❌ | penetrating shots / LOS through glass; niche |
| **`World_CastShape`** (shapecast) | box3d.h:104 | ❌ | ❌ | ❌ | **chase-cam collision** (sphere-cast cam→car, pull in on wall clip — chase.ts has none); pre-impact proximity warning/telemetry; M |
| `World_OverlapAABB/OverlapShape` | box3d.h:75/80 | ❌ | ❌ | ❌ | blast-radius shape gather (feeds Explode), spawn-overlap check; S-M |
| **`CastMover`/`CollideMover`+`SolvePlanes`** | box3d.h:118/123, collision.h:636 | ❌ | ❌ | ❌ | walking-survivor / pedestrian kinematic controller (occupants stand up & flee post-crash); L |

### A.5 Joints (`box3d.h:1098–1719`, defs `types.h:608–1006`)

| Joint / feature | Engine ref | Shim | TS | Game | Application / verdict |
|---|---|---|---|---|---|
| weld (+lin/ang hertz+damping springs) | box3d.h:1571 | ✅ | ✅ | ✅ | destructible welds w/ yield (damage/welds.ts) |
| wheel (suspension+spin+steer+limits) | box3d.h:1611 | ✅ | ✅ | ✅ | vehicle |
| revolute (limit+motor) | box3d.h:1398 | ✅ | ✅ | ✅ | hinges |
| distance (spring/limit/motor) | box3d.h:1136 | ⚠️4 fns | ⚠️ | ⚠️ | only Length/Motor wired; spring-force-range (box3d.h:1153), hertz/damping ❌ → tow-rope/winch w/ real sag unavailable |
| spherical (cone+twist+motor+spring) | box3d.h:1476 | ✅ | ✅ | ✅ | ragdoll occupant joints |
| **prismatic** (slider+spring+limit+motor) | box3d.h:1316, types.h:779 | ❌ | ❌ | ❌ | hydraulic ram / car crusher / lift platform / piston barrier — best sandbox-prop joint; M |
| **motor joint** (6-DOF velocity+spring) | box3d.h:1226, types.h:700 | ❌ | ❌ | ❌ | wrecking ball, powered turntable, conveyor drive; M |
| parallel joint (keep-upright spring) | box3d.h:1105, types.h:755 | ❌ | ❌ | ❌ | self-righting bollard / weeble barrier; niche |
| filter joint | box3d.h:1301 | ❌ | ❌ | ❌ | disable pair collision + keep in island; game uses groupIndex; minor |
| runtime `Joint_SetConstraintTuning` | box3d.h:1081 | ❌ | ❌ | ❌ | progressive weld softening under load; minor (thresholds already wired) |

### A.6 Geometry / shapes

| Capability | Engine ref | Shim | TS | Game | Application / verdict |
|---|---|---|---|---|---|
| sphere/capsule/box/hull/mesh/heightfield create | box3d.h:786–817 | ✅ | ✅ | ✅ | all core shapes |
| **compound shape** (`b3CreateCompoundShape`) | box3d.h:820, collision.h:424 | ❌deferred | ❌ | ❌ | **concave car cabin with real window/door openings** — directly fixes the single-convex-hull constraint that forces the occupant-eject sensor workaround (cardetail/index.ts:66). Baked, single broad-phase proxy, dynamic-body OK. Marquee realism item; L (per-child arrays, binding.c:705) |
| `b3CreateHollowBoxMesh` | collision.h:322 | ❌ | ❌ | ❌ | hollow container/room — but mesh collides on STATIC only (box3d.h:807); good for static building interiors, not the car |
| `b3CreateCylinder/Cone/Rock` hull helpers | collision.h:189–195 | ❌ | ❌ | ❌ | barrels/cones/boulders w/o hand-rolled points (bodies.ts:191 builds hull points manually); S convenience |
| transformed/scaled hull, ScaleBox | box3d.h:802, collision.h:230 | ❌ | ❌ | ❌ | editor-scaled props; minor |
| TOI / ShapeDistance / low-level collide* | collision.h:566–623 | ❌ | ❌ | ❌ | manual narrow-phase; **no application** (engine does it) |
| DynamicTree standalone | collision.h:19–124 | ❌ | ❌ | ❌ | spatial index for non-physics game data; **no application** |
| Recording / replay | box3d.h:254–468 | ❌ | ❌ | ❌ | deterministic crash replay / bug capture; dev-tooling, not gameplay |

---

## B. Ranked "wire this next" — realism payoff per effort (THIS game)

Ranked by realism-payoff ÷ effort for a maximal true-to-life crash sandbox.

1. **`b3World_Explode` + `b3ExplosionDef`** — symbols: `b3World_Explode` (box3d.h:176),
   `b3DefaultExplosionDef` (types.h:1033). **Effort S.** Payoff HUGE. One shim fn + one TS
   method. Plugs into damage/scenario.ts (barrels, fuel tanks) and hit events (rupture on hard
   hit → explode → area impulse). Area-aware impulse already models shape exposure. The single
   highest payoff-per-effort item in the engine.

2. **Contact begin/end event drain** — symbols: `b3World_GetContactEvents` begin/end arrays
   (types.h:1098/1115, already fetched at binding.c:180 but only hitCount read).
   **Effort M.** Enables *sustained* scrape/skid detection (screech loops, spark streams, tire
   marks) that one-shot hit events fundamentally cannot express. `enableContactEvents` is already
   plumbed through TS (shape.ts:45) — only the drain + a TS view are missing. Plugs into damage/
   + a new audio/vfx layer.

3. **Carry `userMaterialId` through hit events** — symbols: `b3ContactHitEvent.userMaterialIdA/B`
   (types.h:1160), `b3SurfaceMaterial.userMaterialId` (types.h:416). **Effort S.** The material
   ids are dropped in the drain (binding.c:187 only copies entity ids). Surface-typed impact
   audio (glass shatter vs metal crunch vs concrete) for near-zero cost. Plugs into damage/system.

4. **`b3Shape_GetContactData` (manifold impulses)** — symbols: box3d.h:975, `b3Manifold`
   (types.h:2602), `rollingImpulse`/`frictionImpulse` (types.h:2614/2617). **Effort M.** Replaces
   the approachSpeed crumple heuristic (damage-tuning.ts:73) with the solver's *actual* normal +
   friction impulse per contact point → physically honest deformation depth and scrape severity.

5. **Shapecast `b3World_CastShape` → chase-cam collision** — symbols: box3d.h:104,
   `b3ShapeProxy` (types.h:1361). **Effort M.** Sphere-cast camera→car each frame, pull the cam
   in when it would clip a wall/building (chase.ts currently has no occlusion handling). Also
   gives pre-impact proximity for telemetry/warning. Core "feel" upgrade.

6. **Sensor events** — symbols: `b3World_GetSensorEvents` (box3d.h:66),
   `b3Shape_EnableSensorEvents` (box3d.h:902), `b3SensorEvents` (types.h:1082). **Effort M.**
   Poll-free occupant-in-seat, checkpoint/trigger volumes, "entered structure" gating. Sensor
   shapes already exist in-game (ballast, attached car-detail) so shape plumbing is half-done.

7. **Prismatic joint** — symbols: `b3CreatePrismaticJoint` + 15 accessors (box3d.h:1316),
   `b3PrismaticJointDef` (types.h:779). **Effort M.** The best sandbox-prop joint: hydraulic
   ram, car crusher, lift/elevator platform, sliding gate, piston barrier. Reuses the existing
   joint TS pattern (joint.ts).

8. **`b3Shape_ApplyWind`** — symbols: box3d.h:1010. **Effort S.** Area+velocity-aware drag/lift
   already implemented in-engine; a thin per-shape wrapper gives wind gusts on light debris,
   signs, tree canopies, and flutter. Plugs into the existing trees/cardetail light bodies.

9. **`b3World_OverlapShape/OverlapAABB`** — symbols: box3d.h:75/80. **Effort S–M.** Gather
   shapes in a radius to feed Explode (#1), spawn-overlap validation, blast/trigger queries.
   Natural companion to #1.

10. **Runtime material setters + `SetBullet`** — symbols: `b3Shape_SetFriction/SetRestitution/
    SetSurfaceMaterial` (box3d.h:864/870/876), `b3Body_SetBullet` (box3d.h:708). **Effort S each.**
    Mid-session wet-road/ice grip loss; bulletize fast projectiles spawned at runtime (creation-
    time isBullet can't cover them). Small, high-realism knobs.

11. **Motor joint** — symbols: `b3CreateMotorJoint` (box3d.h:1226), `b3MotorJointDef`
    (types.h:700). **Effort M.** Powered wrecking ball, turntable, conveyor drive, actuated
    hazards. Complements prismatic (#7) for animated destruction rigs.

12. **Compound shape (concave car cabin)** — symbols: `b3CreateCompoundShape` (box3d.h:820),
    `b3CompoundDef` + child defs (types.h:2378). **Effort L** (deferred at binding.c:705 for
    exactly this reason: 4 per-child-type arrays to marshal). Payoff is the deepest realism win —
    a real cabin with window/door openings occupants can be thrown through, retiring the
    single-convex-hull occupant-eject workaround (cardetail/index.ts:66). Ranked last only on
    effort; it is the highest-ceiling item.

**Deliberately excluded (no application):** worker/task threading (WASM single-thread),
debug customColor/debugMaterial (custom three.js renderer), standalone DynamicTree, low-level
TOI/ShapeDistance/Collide* (engine runs these internally), recording/replay (dev tooling),
gravityScale runtime (marginal), filter joint (groupIndex already covers it).
