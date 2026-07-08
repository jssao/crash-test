# box3d-js

JavaScript / WebAssembly bindings for **[Box3D](https://github.com/erincatto/box3d)** — Erin Catto's
open-source 3D physics engine (the 3D successor to Box2D) — so it can be used from browser games,
in particular **Three.js** games.

## Status

**Scaffold / not started.** This folder is a kickoff package. The actual port has not begun — it is
meant to be executed in a fresh **Fable-orchestrated loom session** (see `BRIEF.md`).

Upstream Box3D is **alpha** (announced 2026-06-30; v0.1 not yet tagged, API in flux). This project
tracks a pinned upstream commit — see `knowledge/04-upstream-build.md` for the exact SHA.

## What this is / isn't

- **Is:** an Emscripten/WASM compile of the Box3D core physics library + a thin, ergonomic
  TypeScript binding layer + a small Three.js integration example. Physics only — Box3D simulates,
  Three.js renders; the binding syncs body transforms to meshes each frame.
- **Isn't:** a renderer, a game, or a fork of Box3D. Upstream lives read-only in `vendor/box3d`
  (gitignored); we build against it and vendor a pinned copy deliberately.

## Layout

| Path | Purpose |
|---|---|
| `BRIEF.md` | The turnkey handoff: goal condition, plan, dispatch discipline. **Start here to execute.** |
| `knowledge/` | Captured research (Box3D facts, WASM binding approach, prior art, upstream build). Read `knowledge/INDEX.md` first. |
| `vendor/box3d` | Upstream Box3D source, cloned (gitignored — not committed). |
| `src/` | The JS/TS binding layer (the port's output). |
| `examples/` | Three.js integration demo(s). |
| `tests/` | Binding + determinism tests. |

## Quick orientation

Box3D is written in **C17 with a flat C API** and builds with **CMake** — which makes it a *good*
WASM candidate (C compiles cleanly through Emscripten; a flat handle-based C API is far simpler to
bind than a C++ class API). The closest prior-art template is
[box2d-wasm](https://github.com/Birch-san/box2d-wasm). See `knowledge/` for the full picture.
