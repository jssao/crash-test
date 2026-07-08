# box3d-js — run brief (staged 2026-07-08)

Port **Box3D** (Erin Catto's C17 3D physics engine) to **WebAssembly + a TypeScript binding** usable
from **Three.js** games. This file is the turnkey handoff: all recon is done and captured in
`knowledge/` so a fresh **Fable-orchestrated loom session** can execute without re-discovering anything.

## How to launch (paste into a NEW Fable-5 session)

> Run on Fable 5 as a loom orchestrator. Execute the staged run in
> `/Users/jesuscalderon/Documents/box3d-js/BRIEF.md` — read it and `knowledge/INDEX.md` (+ the four
> knowledge files) first. Port Box3D to WASM + a TS binding for Three.js, pinning `model:` on EVERY
> Agent dispatch per the discipline table below. Verify adversarially; gate completion behind
> `loom:verifier`. Don't split work that's sequential; don't declare done on a worker's say-so.

## The goal (checkable completion condition)

**A Three.js page loads the compiled Box3D wasm and simulates a real 3D scene in the browser.** Broken
into a checklist the gate can walk:

1. **Core lib compiles to wasm** — a single-threaded, wasm-simd, ES-module `box3d.wasm` + loader builds
   from `vendor/box3d` at the pinned SHA (`knowledge/04`), with samples/tests/benchmark excluded. Build
   is reproducible from a script in `scripts/` (exit 0).
2. **TS binding loads and runs** — `await Box3D()` initializes; you can create a world, add a dynamic
   body + a static ground (plane/box), step the world, and read back the body's position + quaternion.
   A node/vitest test asserts the body falls under gravity and rests on the ground (y decreases then
   stabilizes). Exit 0.
3. **Three.js example runs** — `examples/` has a self-contained page: N boxes drop onto a ground plane
   and come to rest, Box3D transforms driving Three.js meshes each frame, via a batched `HEAPF32`
   transforms read (not per-body boundary calls). Renders without console errors (verify headlessly —
   the Santiago's Wrath render harness pattern, `[[santiago-wrath-headless-render-harness]]`, is a
   working template for headless-WebGL screenshotting on this machine).
4. **No leaks / lifecycles owned** — every world/body/shape/joint is destroyable through the TS wrapper;
   a create→destroy loop doesn't grow wasm memory unboundedly (a test asserts stable memory).
5. **Packaged** — an npm-installable ES-module package (TS types shipped) exposing the async init + the
   binding, mirroring box2d-wasm's packaging (`knowledge/03`).
6. **Honest docs** — README documents the pinned-alpha caveat, the single-threaded/static-hosting
   target, the coordinate/quaternion convention vs Three.js, and how to re-pin upstream.

**Constraints:** don't fork/modify `vendor/box3d` except (if unavoidable) a minimal documented CMake
tweak to disable pthreads for the single-threaded wasm config (`knowledge/04` flags this may be needed)
— prefer an out-of-tree cache/toolchain config over editing upstream. Single-precision (Three.js-
compatible) — keep `BOX3D_DOUBLE_PRECISION=OFF`. Target static hosting: **no** `SharedArrayBuffer` /
COOP-COEP dependency in the default build.

**Bound:** 3 gate passes. If item N still fails after 3, stop and report the blocker (a genuine upstream
alpha limitation is a valid finding, not a failure to hide).

## Why this is more tractable than it sounds (read `knowledge/04`)

Upstream **already supports Emscripten**: a "Building for Web" README section, an in-tree
SSE2→wasm-simd128 mapping, an Emscripten pthreads branch, and a core lib that depends on **only libm**
with samples cleanly separated (gated behind `PROJECT_IS_TOP_LEVEL`). So the wasm **compile is largely
solved** — the novel work is the **binding layer (2), the Three.js sync (3), memory lifecycles (4), and
packaging (5)**. The API is **flat, handle-based C** (`b3WorldId` etc. as `{index1,generation}`
structs), so use binding strategy **(A)**: direct `EXPORTED_FUNCTIONS` + a hand-written TS wrapper — not
WebIDL/embind-of-classes (that was box2d-wasm's problem, because Box2D is C++ classes).

## Suggested decomposition (sequence the dependent phases; fan out within)

The phases are **sequential** (each needs the prior) — this is NOT a wide parallel job, so don't force
fan-out. Parallelism lives *inside* phases (e.g. verify while the next slice drafts) and in the
verify/gate steps.

| Phase | Work | Depends on |
|---|---|---|
| P0 | Toolchain: install/confirm Emscripten; reproduce upstream's web build of the **core lib only**; capture a `scripts/build-wasm.sh`. | — |
| P1 | Binding: read `box3d.h`, choose the exported-function set, write the TS wrapper (handles, world/body/shape/joint, step, batched transforms read) + memory lifecycles. | P0 |
| P2 | Tests: node/vitest — gravity drop, ground rest, create/destroy memory stability. | P1 |
| P3 | Three.js example + headless verify. | P1 |
| P4 | Packaging (npm ES module + types) + honest README. | P1–P3 |

## Dispatch discipline (pin EVERY dispatch — unpinned inherits the session model and silently escalates)

| Work | Tier (`model:`) |
|---|---|
| Orchestration, the P1 binding design, hard synthesis, final gate reasoning | **fable** (this session) |
| Implementation workers (write the build script, the TS wrapper, tests, the example) | **sonnet** |
| Reading headers / upstream code / docs and reporting facts; "what does `box3d.h` export" | **haiku** |
| Deterministic checks (does it build? does the test exit 0? does wasm load?) | **no model** — run in bash |
| Adversarial verify + completion gate | **`loom:verifier`** (haiku); escalate a second gate to sonnet/fable for P-complete |

Emscripten builds and wasm-loading are **deterministic** — verify them by *running the command*, not by
asking a model. Reserve model tokens for the binding design and the gate.

## Paths

- This repo: `/Users/jesuscalderon/Documents/box3d-js` (git-initialized; scaffold may be uncommitted —
  baseline it first).
- Upstream (read-only, gitignored): `vendor/box3d` @ `52f1a254` (re-clone per `knowledge/04` if absent).
- Output: `src/` (binding), `examples/` (Three.js demo), `tests/`, `scripts/` (create it — build/verify).
- Do not modify `vendor/box3d` (see constraint above).

## Reference material (load on demand)

- `knowledge/01` — what Box3D is (features, license, alpha status, the two real risks).
- `knowledge/02` — the WASM binding approach menu + the JS↔wasm boundary + the open decisions to record.
- `knowledge/03` — box2d-wasm as the packaging template (and what NOT to copy).
- `knowledge/04` — **the real upstream build**: pinned SHA, CMake targets, deps, API headers, threading,
  SIMD. Authoritative on build specifics.
- The Santiago's Wrath project (sibling `LIFE AGENTS/santiago-wrath`) is the intended first *consumer* —
  its `docs/reference/modern-threejs-*.md` and its headless render harness are reusable here.
