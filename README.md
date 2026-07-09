# box3d-js

A WASM + TypeScript binding of **[Box3D](https://github.com/erincatto/box3d)** -- Erin Catto's C17
3D rigid-body physics engine (the 3D successor to Box2D) -- for use from browser games, in
particular **Three.js**. Box3D compiles to a single-threaded WebAssembly module; a hand-written
TypeScript layer wraps its flat C API in ergonomic `World`/`Body`/`Shape`/`Joint` classes.

**Is:** a physics engine binding. Box3D simulates rigid bodies; you render them (with Three.js or
anything else) by reading transforms back out each step.
**Isn't:** a renderer, a fork of Box3D, or a soft-body/deformation engine -- this is rigid-body
physics only.

## Status: alpha, upstream alpha

Upstream Box3D is itself **alpha** (announced 2026-06-30, no v0.1 tag yet, API in flux). This
binding pins a specific upstream commit rather than tracking a moving target:

```
repo:   https://github.com/erincatto/box3d
commit: 52f1a254 (full: 52f1a254ad62a74c9f2a80052f436e2263b95214)
date:   2026-07-06
license: MIT, Copyright (c) 2026 Erin Catto
```

Vendored read-only at `vendor/box3d` (gitignored -- not committed). To restore or re-pin:

```sh
git clone https://github.com/erincatto/box3d.git vendor/box3d
cd vendor/box3d && git checkout <commit>
```

See `knowledge/04-upstream-build.md` for the full build-reality notes -- upstream's CMake layout,
its FetchContent-friendly `src/` target, and everything this port's build script depends on. **If
you re-pin to a newer upstream commit, re-read that file and re-verify its assumptions still hold**
-- this is an alpha library and its API/CMake structure may change between commits.

### What works (implemented + covered by the vitest suite, 6/6 passing)

- World / Body / Shape creation, destruction, and lifecycle safety (double-destroy guards, a
  live-handle registry checked by the memory-stability test).
- Shapes: box, sphere, capsule, convex hull.
- Joints: wheel (suspension + spin motor + steering), weld, revolute, distance -- including their
  constraint-force/torque getters and runtime setters.
- Polled events via zero-allocation cursors over flat `HEAPF32`/`HEAPU32` buffers: move events
  (`World.moveEvents()`) and hit/contact events (`World.hitEvents()`).
- Gravity, fixed-substep stepping, sleep (enable/disable, wake/asleep queries).

### Implemented, but not yet exercised by an automated test

- Mesh and heightfield shapes.
- `World.castRayClosest()` (closest-hit raycasting) -- fully wired end to end (C shim + TS wrapper)
  but has no dedicated regression test yet.
- Joint events (`World.jointEvents()`, force/torque threshold crossings).

These are expected to get real exercise once the `game/` crash-sandbox project (see below) starts
using them; treat them as "should work" rather than "verified."

### Deferred

- Compound shapes (multiple shapes composed as one collider via a single call) -- not implemented
  in the C shim. Multiple shapes can still be attached to one body individually today.

## Quickstart

```ts
import { init, World, BodyType } from "box3d-js";

// The only async step in the whole binding -- everything below is synchronous.
const native = await init(); // loads build/wasm/box3d.mjs by default -- see "Build from source"

const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } }); // Y-up, matches Three.js

const ground = world.createBody({ type: BodyType.Static });
ground.createBoxShape({ halfExtents: { x: 10, y: 0.5, z: 10 } });

const box = world.createBody({ position: { x: 0, y: 5, z: 0 } }); // BodyType.Dynamic is the default
box.createBoxShape(); // defaults to a 1m cube

const FIXED_DT = 1 / 60;
setInterval(() => {
  world.step(FIXED_DT);

  // Batched transform read -- the required render-sync path. Never call Body.getTransform() per
  // body per frame; drain this step's move events instead (zero extra allocations per event).
  const moves = world.moveEvents();
  for (let i = 0; i < moves.count; i++) {
    const m = moves.at(i);
    // m.position: {x,y,z}, m.rotation: {x,y,z,w} -- apply directly to a THREE.Object3D /
    // THREE.InstancedMesh instance matrix. m.userData is the entity id you tagged at body creation.
  }
}, 1000 / 60);

world.destroy();
```

See `examples/falling-boxes/` for a full Three.js app built on this pattern.

## Conventions

- **Units:** meters, kilograms, seconds. Single precision (`float32`) throughout -- the wasm build
  has `BOX3D_DOUBLE_PRECISION=OFF`.
- **Up-axis:** Y-up. Box3D itself declares no fixed up-vector, but upstream's own
  `b3DefaultWorldDef()` sets gravity to `(0, -10, 0)`, i.e. Y-up in practice -- matching Three.js
  exactly. This binding's default `World` gravity matches.
- **Quaternions:** `b3Quat` is `{ v: {x,y,z}, s }` (vector + scalar). That maps directly onto
  `THREE.Quaternion(x, y, z, w)` with `w = s` -- no component reordering or sign flips anywhere
  this binding crosses the JS/wasm boundary.
- See `src/ts/math.ts` for the authoritative module doc these conventions are drawn from.

## Single-threaded, no SharedArrayBuffer -- static-hosting friendly

The wasm build is deliberately single-threaded (`scripts/wasm/CMakeLists.txt` bypasses upstream's
`-pthread`/`-sUSE_PTHREADS=1` branch) and built with `-sWASM_BIGINT`. `scripts/build-wasm.sh`
actively verifies the compiled `box3d.mjs` never references `SharedArrayBuffer`. Practically: this
binding needs **no cross-origin-isolation headers** (`Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy`) to run -- it works from plain static hosting (e.g. GitHub Pages)
with zero server configuration.

## Build from source

Prerequisites (macOS via Homebrew; see `scripts/build-wasm.sh` for the emsdk fallback path):

```sh
brew install cmake emscripten
```

Then, from the repo root:

```sh
scripts/build-wasm.sh
```

This configures an out-of-tree CMake project (`scripts/wasm/CMakeLists.txt`) that builds *only*
`vendor/box3d/src` (not upstream's samples/tests/benchmarks, and not upstream's root
`CMakeLists.txt` with its pthread branch), producing `build/wasm/box3d.mjs` + `build/wasm/box3d.wasm`
(gitignored build artifacts). The script is idempotent and self-verifying: it checks the output
exists, greps for `SharedArrayBuffer` (must be absent), and runs `scripts/smoke-wasm.mjs` (loads the
module in plain Node, creates and steps a world, with no `--experimental-*` flags).

## npm packaging

```sh
npm run build          # build-wasm.sh -> tsc emit -> dist/, plus dist/wasm/box3d.{mjs,wasm}
npm run verify:dist     # sanity-checks the built dist/ package end to end
```

`npm run build` produces a self-contained `dist/` (this package stays `"private": true` --
nothing is meant to actually publish yet -- but `dist/` is shaped like a publishable ES module
package: `exports["."]` points at `dist/index.js` + `dist/index.d.ts`, `"files": ["dist"]`).

**Known wrinkle:** `init()`'s zero-argument default resolves `box3d.mjs` relative to *its own
compiled file's location* (`src/ts/native.ts`'s `new URL("../../build/wasm/box3d.mjs", ...)`) --
a convenience default for running straight out of this repo, where `build/wasm/` is
`build-wasm.sh`'s output. It does **not** resolve correctly against a built `dist/` package (whose
co-located wasm lives at `dist/wasm/`, not `../../build/wasm` relative to `dist/`). Dist consumers
should pass an explicit override instead:

```ts
const native = await init({ wasmUrl: new URL("./wasm/box3d.mjs", import.meta.url) });
```

`scripts/verify-dist.mjs` and `examples/falling-boxes` both do the equivalent (an explicit
`wasmUrl`), and are the reference for the exact pattern.

## Tests

```sh
npm test   # vitest run -- 6/6 passing
```

`tests/`: `gravity-drop` (a dropped body falls and settles), `move-events`, `hit-events`,
`weld-force` (constraint force ordering sanity), `wheel-spin`, and `memory-stability` (zero net
heap growth across 220 create/step/destroy cycles). Requires `scripts/build-wasm.sh` to have been
run first.

## Examples

`examples/falling-boxes/` -- a static ground box and ~50 dynamic boxes dropped from varied
heights/rotations, settling into a resting pile; Three.js + Vite, headlessly verified (puppeteer:
zero console errors, no tunneling, pile comes to rest). See its own README for setup.

## The game (`game/`)

`game/` is a separate, in-progress crash-sandbox driving game built on top of this binding (its own
standalone npm package, independent of this repo root) -- see `game/README.md` and
`docs/superpowers/specs/2026-07-08-crash-sandbox-design.md` for scope and status. Not part of this
package's deliverables; tracked separately.

## License

- **This binding's code** (`src/`, `scripts/`, `examples/`): MIT.
- **Box3D itself** (vendored read-only at `vendor/box3d`, not redistributed by this repo): MIT,
  Copyright (c) 2026 Erin Catto. See the pinned commit above and `vendor/box3d/LICENSE` once cloned.
