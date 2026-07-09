# examples/

Three.js integration demos for box3d-js.

- **`falling-boxes/`** -- a static ground box and ~50 dynamic boxes dropped from varied
  heights/rotations, settling into a resting pile. Demonstrates the required render path: mesh
  transforms are synced every physics step from `World.moveEvents()` (a zero-allocation cursor over
  a flat `HEAPF32` buffer), never per-body `getTransform()` calls in the render loop. Headlessly
  verified (`npm run verify`, puppeteer-driven) -- zero console errors, no tunneling, pile comes to
  rest. See `falling-boxes/README.md` to run it.
