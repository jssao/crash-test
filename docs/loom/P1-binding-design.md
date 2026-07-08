# P1 — binding architecture (designed by orchestrator, 2026-07-08)

Informed by the P0b API enumeration (see PLAN.md pass log). Governs the P1 implementation worker.

## Shape: C shim + TS wrapper (BRIEF strategy A, refined)

Box3D handles (`b3BodyId` = `{int32 index1, uint16 world0, uint16 generation}`, 8 bytes) and def
structs are passed **by value**; the wasm32 C ABI passes such structs indirectly, which makes raw
`cwrap` painful and slow. So the binding is two layers:

1. **`src/wasm-shim/binding.c`** — OUR code (does not touch vendor/), compiled and linked with the
   box3d lib into `box3d.wasm`. Flattens the API:
   - Handles cross the boundary as **`uint64_t`** (bit-cast of the 8-byte id structs; `b3WorldId`
     is 4 bytes → zero-extended). Build with `-sWASM_BIGINT`; JS sees `bigint`.
   - Def-struct creation functions take scalars: e.g.
     `uint64_t b3js_CreateBody(uint32_t world, int type, float px, py, pz, float qx, qy, qz, qs, float linDamp, angDamp, gravScale, int enableSleep, int isBullet, uint32_t userData)`.
     Internally: `b3DefaultBodyDef()` then override. **Always start from the upstream default def.**
   - Body userData stores a `uint32` entity id (cast to void*) — the JS-side entity key.
2. **`src/ts/`** — the ergonomic TypeScript wrapper (`World`, `Body`, `Joint` classes holding
   bigint handles), typed defs with optional fields, event views, lifecycle tracking.

## Export surface (game-driven; keep total small and purposeful)

- **World:** create (gravity xyz, hitEventThreshold, contactHertz/damping, enableSleep,
  workerCount=1 fixed), destroy, `step(dt, subStepCount)`.
- **Body:** create (above), destroy, getPosition/getRotation (via out-buffer), setTransform,
  get/set linear+angular velocity, applyForce/Torque/LinearImpulse (at point + to center),
  applyAngularImpulse, mass getters, `ApplyMassFromShapes`, setAwake/enableSleep/isAwake.
- **Shapes:** sphere, capsule, **box via hull** (find upstream box-hull helper in
  collision.h/types.h — e.g. a `b3MakeBox`-style constructor for `b3HullData`; if absent, build
  the 8-vertex hull in the shim), generic hull from a float* vertex array, mesh
  (`b3CreateMeshShape` from vertex+index arrays, for static props), heightfield, compound
  (`b3CreateCompoundShape`) if its data struct is tractable — else defer compound and note it.
  ShapeDef scalars: density, friction, restitution, rollingResistance, enableContactEvents,
  enableHitEvents, isSensor, filter (category/mask/group). destroyShape(updateBodyMass).
- **Joints:** wheel (full def: bodies, local frames/anchors + axis per types.h base fields;
  suspension enable/hertz/damping/limits; spin motor enable/maxTorque/speed; steering
  enable/hertz/damping/targetAngle/maxTorque/limits) + runtime setters for spinSpeed,
  maxSpinTorque, targetSteeringAngle (+ any brake-relevant setter) — read types.h for exact
  setter names; weld (linear/angular hertz + damping); revolute (full def); distance.
  `destroyJoint(wakeAttached)`, `b3Joint_GetConstraintForce/Torque` → out-buffer.
- **Events (the hot path):** after `step`, the shim drains into **shim-owned growable buffers**:
  - Move events: per event `[userData:u32][pos x,y,z:f32][quat x,y,z,s:f32][flags:u32]` — JS gets
    `(ptr, count)` and reads one `HEAPF32`/`HEAPU32` view. This replaces per-body transform calls.
  - Hit events: `[userDataA:u32][userDataB:u32][point xyz][normal xyz][approachSpeed]`.
  - Joint events (b3World_GetJointEvents — likely joint-destroyed/broken notifications; worker:
    read types.h and wire what exists).
  Exports: `b3js_Step(world, dt, substeps)` which steps AND drains; then
  `b3js_GetMoveEventsPtr/Count`, `b3js_GetHitEventsPtr/Count`, etc.
- **Queries:** `castRayClosest(origin, translation, filter)` → flat out-buffer
  `{hit, point, normal, fraction, userData}`.
- **Misc:** `b3GetVersion`, `b3SetLengthUnitsPerMeter` (export, don't call — meters default).

## TS wrapper requirements

- `const b3 = await Box3D()` init; `new World(opts)`; `world.step(dt)` fixed-dt.
- Classes hold `bigint` handles + expose `destroy()`; a module-level live-handle registry
  (Map<bigint, type>) enables the leak test (BRIEF item 4) and double-destroy guards.
- Event access: `world.moveEvents()` / `world.hitEvents()` return lightweight iterator/views over
  the heap (no per-event object allocation in the hot loop; provide a reusable cursor object).
- Math conventions documented in code: b3Quat `{v.x,v.y,v.z,s}` ↔ Three `Quaternion(x,y,z,w=s)`;
  single-precision floats; meters; document Box3D's up-axis/handedness (read from
  b3DefaultWorldDef gravity + header comments and STATE IT in the README section).
- No abstractions beyond this — no scene graph, no renderer coupling.

## Testing hooks this enables (P2)

Gravity drop (create world+ground box+dynamic box, step 120, assert y decreases then stabilizes);
wheel joint spin (motor speed → body advances); weld break (constraint force query returns
non-zero under load; destroy joint works); create/destroy 1000× loop with stable
`Module.HEAP8.length` growth bound.
