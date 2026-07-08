# 02 · WASM binding approach

> How to get Box3D's C library running in a browser and callable from JS/TS. This is a design menu,
> not a locked decision — the execution session picks and records the choice. Written 2026-07-08.
>
> **Read `04-upstream-build.md` first — it supersedes this file on build specifics.** Key update from
> the actual clone: upstream **already has Emscripten support** (a "Building for Web" README section,
> an in-tree SSE2→wasm-simd128 mapping, and an Emscripten pthreads branch). So Step 1 below is mostly
> *already done by upstream*; the real work is Steps 2–5 (bindings, boundary, Three.js sync, packaging).

## The pipeline, in one line

`Box3D C17 source` → **Emscripten** (`emcc`/`emcmake cmake`) → `box3d.wasm` + JS loader →
**thin TS binding** → **Three.js sync layer** → game.

## Step 1 — compile the CORE lib to wasm (not the samples)

The single most important build fact (confirm in `04`): **you must build only the core physics
library**, excluding samples/benchmark, because those pull in GLFW / a GL renderer / windowing that
won't compile to wasm. If upstream's CMake separates the `box3d` library target from `samples`, this is
easy: `emcmake cmake -DBOX3D_SAMPLES=OFF ...` (or whatever the option is named — see `04`).

Emscripten + CMake path:
```
emcmake cmake -B build-wasm -DCMAKE_BUILD_TYPE=Release <disable-samples-flag>
cmake --build build-wasm
```

Flags that will matter:
- `-msimd128` + verify Box3D's SSE2/Neon paths fall back or map to **wasm-simd** (Box3D uses SIMD math;
  check whether it has a scalar fallback for platforms without SSE2/Neon — wasm-simd is the target, but
  a scalar path is the safe baseline). [VERIFY in `04`.]
- **Threading:** Box3D multithreads. wasm pthreads require `SharedArrayBuffer`, which requires
  **cross-origin isolation** (COOP/COEP headers) — often a dealbreaker for static hosting like GitHub
  Pages (the Santiago's Wrath deploy target). **Recommended first cut: build single-threaded**
  (`-sUSE_PTHREADS=0`, disable Box3D's worker/task system) to keep the consumer deployable anywhere.
  Add threaded builds later as an opt-in. [VERIFY how upstream lets you disable threading in `04`.]
- `-sMODULARIZE=1 -sEXPORT_ES6=1` for a clean ES-module package.
- `-sALLOW_MEMORY_GROWTH=1`, `-sEXPORTED_RUNTIME_METHODS=[ccall,cwrap,HEAPF32,...]`.

## Step 2 — bindings: flat C API makes this simpler than box2d-wasm

Box3D is a **flat, handle-based C API** (e.g. functions returning/taking opaque IDs), *not* C++ classes.
So you do **not** need box2d-wasm's WebIDL-binder-over-C++-classes approach. Two viable strategies:

- **(A) Direct exports + hand-written TS wrapper (recommended for a flat C API).** Compile with
  `-sEXPORTED_FUNCTIONS=[_b3CreateWorld,_b3CreateBody,...]`, then write a small TS module that
  `cwrap`s them into ergonomic classes/functions and manages the numeric handles. Full control,
  minimal magic, easy to keep in step with alpha API churn. Downside: you maintain the export list.
- **(B) An embind C++ shim.** Write a tiny C++ translation unit that `#include`s the Box3D C headers
  and exposes ergonomic classes via `emscripten::bind`. More automatic TS types, slightly more weight.

Prefer **(A)** unless the API is large enough that (B)'s ergonomics pay off. Record the choice.

## Step 3 — the JS↔wasm boundary (the perf-critical part)

Physics engines write **many small numbers per frame** (each body's position + orientation). Crossing
the JS/wasm boundary per-field is slow. The correct pattern (same as box2d-wasm / Rapier):

- Keep body state in the **wasm linear memory**; on the JS side, read it as a typed-array **view**
  (`HEAPF32`) over the module's memory — no per-call marshalling.
- Each frame: `world.step(dt)` in wasm, then read a contiguous transforms buffer (position xyz +
  quaternion xyzw per body) directly from `HEAPF32` and copy into Three.js `mesh.position` /
  `mesh.quaternion`. Ideally box3d-js exposes a single "get all transforms into this buffer" call.
- **Memory management:** wasm has no GC. Every created world/body/shape/joint must be explicitly
  destroyed via the C API; the TS wrapper should own lifecycles (dispose methods / finalization) so
  consumers don't leak. Document this loudly — it's the #1 footgun.

## Step 4 — Three.js sync layer

A minimal `Box3DWorld` TS class + a helper that, given `{ rigidBody, mesh }` pairs, copies transforms
after each step. Convention to nail down: **coordinate system + units + quaternion order** must match
Three.js (right-handed, Y-up by default; Three uses xyzw quaternions). Record any axis conversion.

## Step 5 — package

Mirror box2d-wasm: an npm package with **ES modules + TypeScript types**, shipping `box3d.wasm` +
loader + the TS binding. Provide an async init (`await Box3D()`) that fetches/instantiates the wasm.

## Deployment note (ties back to the game)

Santiago's Wrath ships on **GitHub Pages** (static, no custom headers). That's exactly why the
**single-threaded, wasm-simd, ES-module** build is the right first target: no `SharedArrayBuffer`, no
COOP/COEP, drops into a static page. Keep the threaded build as a later opt-in for self-hosted targets.

## Open decisions to record during execution

- [ ] (A) direct-exports vs (B) embind — pick and justify.
- [ ] single-threaded first? (recommended yes) — confirm upstream lets you disable its task system.
- [ ] wasm-simd on, with scalar fallback verified?
- [ ] transforms read as a batched HEAPF32 view (yes — don't do per-body boundary calls).
- [ ] coordinate/quaternion conversion to Three.js — documented?
