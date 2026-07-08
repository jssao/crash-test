# 03 · Prior art — box2d-wasm (the template)

> The closest existing pipeline to mirror. https://github.com/Birch-san/box2d-wasm · gathered 2026-07-08.

**box2d-wasm** compiles Box2D (Erin Catto's 2D engine) to WebAssembly with first-class TypeScript + ES
modules. It is the modern successor to the older asm.js `box2d.js` (kripken). This is the template for
box3d-js — the *same shape of project*, one dimension up.

## What to copy

- **Upstream as a git submodule.** box2d-wasm keeps the `box2d` source as a submodule and builds against
  it. box3d-js does the analogous thing with `vendor/box3d` (we gitignore it for the scaffold; the
  execution session may promote it to a pinned submodule).
- **Emscripten toolchain** to produce the `.wasm` + JS glue.
- **Monorepo packaging** shipping an npm package with **ES modules + TS types** out of the box.
- **A renderer demo** (box2d-wasm ships a WebGL demo) — box3d-js's analog is a Three.js example.

## What is DIFFERENT for box3d-js (do not blindly copy)

- box2d-wasm uses a **`webidl-to-ts`** workspace and the **WebIDL binder** to generate TS bindings —
  because **Box2D's public surface is C++ classes**. Box3D is a **flat C API**, so WebIDL/embind-of-
  classes is *not* required; a direct-export + hand-written TS wrapper is simpler and more churn-proof
  (see `02`, strategy A). Borrow box2d-wasm's *packaging and memory-view patterns*, not its binding
  generator.
- 3D adds a **quaternion** (4 floats) per body vs 2D's single angle — the per-frame transforms buffer is
  wider; get the batched-typed-array-view pattern right (`02`, step 3).

## Other reference points

- **kripken/box2d.js** — the original Emscripten port; historical, shows the raw Emscripten C++→JS path.
- **@dimforge/rapier3d** — not a port to copy, but the *gold-standard* example of a 3D physics engine
  with ergonomic web bindings (Rust→wasm). Study its API ergonomics and its Three.js usage patterns as
  a design target for what "good" looks like from the consumer side.
