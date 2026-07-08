# 01 · Box3D — ground truth

> Gathered 2026-07-08. Upstream is **alpha and moving** — treat versions/API as volatile; re-verify
> anything load-bearing against the repo. Sources linked at the bottom.

## What it is

**Box3D** is an open-source **3D physics engine for games**, by **Erin Catto** — the author of Box2D.
Announced **2026-06-30**. It extends Box2D's solver design philosophy into 3D and blends Box2D
algorithms with elements of **Rubikon-Lite**, Valve's physics from *Half-Life: Alyx*. Catto has been
building it at Kintsugiyama for *The Legend of California* after Unreal's Chaos physics fell short for
that game.

Why the pedigree matters: Catto is one of the most respected authors of real-time constraint solvers
in games. The engine quality is not in question. The **browser story** is what this project supplies.

## Hard facts

- **Language:** C17 (not C++). Clean, flat **C API**. [VERIFY exact API shape in `04`.]
- **License:** MIT. [VERIFY in `04` from the repo's LICENSE file.]
- **Build:** CMake. "Install vanilla git and CMake, then clone the Box3D repository."
- **Math/perf:** SSE2 + Neon SIMD. Multithreading. Cross-platform determinism (a headline feature).
- **Collision shapes:** convex hulls, capsules, spheres, **triangle meshes**, **height fields**,
  baked compound collision.
- **Joints:** revolute, prismatic, distance, wheel, weld.
- **Other features:** continuous collision detection (CCD), recording & replay, large-scale worlds.
- **Stability:** **alpha.** v0.1 "to be tagged soon," building toward v1.0. Contributions are
  issues-only. API is explicitly subject to change.
- **Binary size:** release binary ~916KB on macOS — small enough that the community immediately
  flagged it as WASM-feasible.
- **Early adopters cited:** Facepunch's s&box, the Esoterica engine, a 1000-player space MMO.

## Why C (flat API) is good news for a web port

- C compiles to WebAssembly cleanly through **Emscripten** — no C++ template/exception/RTTI weight.
- A **handle-based flat C API** (functions taking opaque IDs, not method calls on C++ objects) is the
  *easiest* thing to bind to JS: you can call exported functions directly via `cwrap`/`ccall`, or wrap
  them in a thin embind/TS layer, without the WebIDL-of-C++-classes machinery box2d-wasm needed.
- Small binary → small `.wasm` payload for a browser game.

## The two real risks (be honest about these)

1. **No official web target exists.** There is (as of 2026-07-08) no `box3d.js`, no Emscripten build,
   no npm package. This project *is* that work — you're building the bridge, not consuming one.
2. **Alpha churn.** The C API will change before v1.0. Pin a commit (`04`), and expect to re-pin and
   patch the binding layer as upstream moves.

## Not to be confused with

- **Box2D** — same author, 2D only. Not a substitute for 3D.
- **"box3d" the old Panda3D/other assets** — unrelated. This is `erincatto/box3d`.
- **Rapier** (dimforge, Rust) — the *mature* alternative with official WASM bindings
  (`@dimforge/rapier3d`). If the goal is physics-in-browser *now*, Rapier wins; Box3D-js is the
  early-adopter / best-solver path that requires building the port first.

## Sources

- Announcement: https://box2d.org/posts/2026/06/announcing-box3d/
- Repo: https://github.com/erincatto/box3d
- Coverage: https://www.phoronix.com/news/Box3D-Open-Source-3D-Physics ·
  https://byteiota.com/box3d-the-open-source-3d-physics-engine-built-for-games/ ·
  https://ziggit.dev/t/box3d-new-3d-physics-engine-with-native-c-api/16452
