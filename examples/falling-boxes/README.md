# falling-boxes

A small Three.js + Vite example for `box3d-js`: a static ground box and ~50 dynamic boxes dropped
from varied heights/rotations, settling into a resting pile. Demonstrates the required render path
-- syncing mesh transforms from `World.moveEvents()` (a zero-allocation cursor over a flat HEAPF32
buffer), never per-body `getTransform()` calls in the render loop.

This is a standalone Vite app (its own `package.json`) that imports the binding directly from the
repo's `../../src/ts` sources -- no publish/link step needed, just a built wasm artifact.

## Prerequisites

**Build the wasm core first**, from the repo root:

```sh
scripts/build-wasm.sh
```

This produces `build/wasm/box3d.mjs` + `build/wasm/box3d.wasm`. Everything below assumes that step
already ran.

## Run it

```sh
cd examples/falling-boxes
npm install
npm run dev       # http://localhost:5174
```

`npm run dev` / `npm run build` both run `scripts/copy-wasm.mjs` first (via the `predev`/`prebuild`
hooks), which copies the two compiled wasm artifacts into `public/wasm/` so Vite serves them
side by side, unbundled -- `box3d.mjs` locates `box3d.wasm` at runtime via a fetch relative to its
own served URL, so the two files must live next to each other wherever they're deployed.

## Headless verification

```sh
npm run verify
```

`verify.mjs` builds the app, boots `vite preview`, drives it headlessly with Chrome/Chromium via
puppeteer, waits for ~8s of *simulation* time to pass, and asserts:

- zero browser console errors,
- every box's Y position stays above the ground (no tunneling through the floor),
- a majority of boxes are asleep or moving below a near-zero velocity threshold (the pile settled).

It writes `verify/screenshot.png` (the settled pile) and exits 0 on pass, non-zero on any
assertion failure. See the top of `verify.mjs` for which browser/puppeteer flavor it used on the
machine it last ran on.
