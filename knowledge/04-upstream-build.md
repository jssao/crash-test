# 04 · Upstream Box3D build reality

> Authoritative build facts, read directly from a clone of upstream at the pinned commit below
> (2026-07-08). **This file supersedes any speculation in `02` where they differ.** Re-run the
> inspection and bump the SHA when you re-pin.

## Pinned commit

```
repo:   https://github.com/erincatto/box3d
commit: 52f1a254ad62a74c9f2a80052f436e2263b95214
date:   2026-07-06 17:33:45 -0700
subject: Name cache (#53)
license: MIT — Copyright (c) 2026 Erin Catto (LICENSE at repo root)
```
Cloned to `vendor/box3d` (gitignored). To restore: `git clone https://github.com/erincatto/box3d.git
vendor/box3d && cd vendor/box3d && git checkout 52f1a254`.

## Headline: Emscripten support already exists upstream

This is **not** a bolt-on. The repo already treats web as a target:
- `README.md` has a **"Building for Web"** section: `emcmake cmake -B build -DBOX3D_SAMPLES=OFF` then
  `cmake --build build`.
- Root `CMakeLists.txt` has explicit `if(EMSCRIPTEN)` branches for **both** SIMD and threads.
- `.github/workflows/build.yml` appears to build an Emscripten target in CI. **[VERIFY — not read in
  full.]**

So the port's novelty is **the JS/TS binding layer + Three.js sync + npm packaging**, not getting C to
compile to wasm. Big derisk.

## Directory layout

- `include/box3d/` — **public C API** (8 flat headers).
- `src/` — core engine, **91 files, all C** (+ one `.natvis`). No C++ in the core.
- `samples/` — demo app, **C++**, renders via vendored **sokol** (`extern/sokol/`, not GLFW) + imgui/implot.
- `shared/` — small C helpers for samples/test/benchmark (determinism, dumps, utils).
- `test/`, `benchmark/` — unit tests + perf (C).
- `extern/sokol/` — vendored, **samples-only** rendering/app backend (MIT).
- `docs/`, `data/` — Doxygen (off by default), sample data.

## CMake targets & building ONLY the core lib

Project `box3d` (C + CXX). Targets: **`box3d`** (the physics lib, `src/CMakeLists.txt`, alias
`box3d::box3d`), `samples`, `test`, `benchmark`, plus FetchContent'd `imgui`/`implot` (samples-only).

Key options (defaults): `BOX3D_SAMPLES=ON`, `BOX3D_UNIT_TESTS=ON`, `BOX3D_BENCHMARKS=OFF`,
`BOX3D_DOCS=OFF`, `BOX3D_DISABLE_SIMD=OFF`, `BOX3D_DOUBLE_PRECISION=OFF`, `BOX3D_VALIDATE=ON`,
`BOX3D_PROFILE=OFF` (Tracy), `BOX3D_SANITIZE=OFF`.

**`add_subdirectory(src)` runs unconditionally; samples/test/benchmark are gated behind
`if(PROJECT_IS_TOP_LEVEL)`.** So consuming Box3D via `FetchContent`/`add_subdirectory` builds **only**
`box3d`. Standalone core build:
```
emcmake cmake -B build-wasm -DBOX3D_SAMPLES=OFF -DBOX3D_UNIT_TESTS=OFF \
  -DBOX3D_BENCHMARKS=OFF -DBOX3D_DOCS=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build build-wasm
```
- `box3d` target: **C_STANDARD 17, required** (uses `_Static_assert` + anonymous unions).

## Core-lib dependencies — clean

`src/CMakeLists.txt` links `box3d` to **only `m` (libm)** on Unix (and not on Apple/Emscripten). **No
GLFW, no imgui, no enkiTS/TBB, no external threading lib.** All threading/atomics/SIMD are hand-rolled
in-tree (`src/scheduler.*`, `src/platform.h`, `src/simd.*`, `src/timer.c`). **The core is cleanly
separable from samples** — the single most important signal for a wasm port. ✅

## Public C API headers (`include/box3d/`)

- `box3d.h` — main API: world, body, shape, joint, sensor, recording/replay (~150+ functions).
- `base.h` — alloc/assert/log/version/timing macros, `B3_API` export macro.
- `collision.h` — AABB, shape geometry, raycasts, manifolds.
- `id.h` — **opaque handles**: `b3WorldId`, `b3BodyId`, `b3ShapeId`, `b3JointId`, each a
  `{ index1, generation }` uint16 pair struct.
- `types.h` — `b3WorldDef`, `b3BodyDef`, `b3ShapeDef`, callback fn-ptr typedefs.
- `math_functions.h`, `config.h`, `constants.h`.

**Verdict: flat, handle-based C API** (`extern "C"`-wrapped), no OOP. → binding strategy **(A)** in `02`
(direct exports + hand-written TS wrapper) is the right call; you do NOT need WebIDL/embind-of-classes.
Note handles are small structs, not plain ints — the TS wrapper marshals `{index1,generation}` pairs
(pass/return by value or via memory), so plan the ABI for struct-by-value handles.

## Threading (the deployment-critical bit)

- Core uses a **custom scheduler** (`src/scheduler.c`) over **pthreads directly** (`pthread_*`,
  semaphores) on Linux/Apple/Emscripten. `b3CreateScheduler(workerCount)` spawns `workerCount-1` OS
  threads → **`workerCount=1` spawns zero background threads** (true single-threaded run), though
  `pthread.h`/`semaphore.h` still compile in on POSIX/Emscripten.
- Root CMake's Emscripten branch currently applies `-pthread -sUSE_PTHREADS=1 -sALLOW_MEMORY_GROWTH`
  **before** `add_subdirectory(src)` (wasm-ld requires matching shared-memory/atomics across the lib and
  its consumers). Multi-worker wasm ⇒ pthreads ⇒ **SharedArrayBuffer ⇒ cross-origin isolation
  (COOP/COEP) required** — a problem for plain static hosting (GitHub Pages).
- **Recommendation:** produce a **single-threaded wasm build** (workerCount=1; drop `-pthread`/
  `USE_PTHREADS` for that config) so the consumer deploys to any static host with no special headers.
  Verify how to disable the pthreads compile flags for the wasm config — the current CMake applies them
  unconditionally under `EMSCRIPTEN`, so this likely needs a CMake tweak or a dedicated cache config.
  **[VERIFY / small upstream-CMake adjustment likely needed.]** Keep a threaded build as a later opt-in.

## SIMD

- `src/simd.h` = SSE2 intrinsics (`emmintrin.h`) behind `B3_SIMD_SSE2`, **with a scalar fallback**.
- `src/core.h` maps `B3_CPU_WASM → B3_SIMD_SSE2` (width 4); root CMake Emscripten branch adds
  `-msimd128 -msse2`, i.e. **Emscripten's SSE2→wasm-simd128 shim is already wired**. No NEON path (by
  design). `BOX3D_DISABLE_SIMD=ON` exists as an escape hatch if a scalar wasm build is ever needed.

## Precision

`BOX3D_DOUBLE_PRECISION=OFF` by default → single-precision floats, which matches Three.js (`Float32`)
and keeps the transforms buffer as `HEAPF32`. Keep it off.

## Not fully verified (honesty)

- `.github/workflows/build.yml` not read in full (the "CI builds wasm" claim is inferred).
- Windows thread branch in `src/timer.c` not read (irrelevant to wasm).
- Exact function names in `box3d.h` not enumerated — read the header when writing the export list.
