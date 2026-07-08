# src/

The JS/TS binding layer — the port's output. Empty until the execution session builds it.

Expected contents (per `../knowledge/02-wasm-binding-approach.md`):
- the Emscripten glue / wasm loader (async `Box3D()` init)
- the TS wrapper over Box3D's exported C functions (handle management, lifecycles/dispose)
- the Three.js sync helper (batched `HEAPF32` transforms → `mesh.position`/`mesh.quaternion`)
