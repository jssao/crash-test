#!/usr/bin/env node
// Build smoke test for the single-threaded wasm-simd Box3D core build.
//
// This is NOT the JS/TS binding layer (that comes in a later phase) -- it only proves that:
//   1. build/wasm/box3d.mjs loads as a plain ES module in stock Node (no --experimental flags),
//   2. the exported wasm functions (scripts/exports.json) are callable via cwrap,
//   3. a world can actually be created and stepped, i.e. the compiled core lib works end to end.
//
// Deliberately avoids importing SharedArrayBuffer / worker_threads -- if the module needed those,
// this script would fail under plain `node scripts/smoke-wasm.mjs`.

import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = path.join(here, "..", "build", "wasm", "box3d.mjs");

const Box3D = (await import(moduleUrl)).default;

const Module = await Box3D();

// Fail loudly (rather than silently passing) if the build ever starts requiring
// SharedArrayBuffer/pthreads -- this is the whole point of the single-threaded build.
if (typeof Module.PThread !== "undefined") {
  throw new Error("Module.PThread is present -- this build is not single-threaded!");
}

const b3GetWorldCount = Module.cwrap("b3GetWorldCount", "number", []);
const b3GetMaxWorldCount = Module.cwrap("b3GetMaxWorldCount", "number", []);
const b3DefaultWorldDef = Module.cwrap("b3DefaultWorldDef", null, ["number"]);
const b3CreateWorld = Module.cwrap("b3CreateWorld", null, ["number", "number"]);
const b3World_Step = Module.cwrap("b3World_Step", null, ["number", "number", "number"]);
const b3DestroyWorld = Module.cwrap("b3DestroyWorld", null, ["number"]);

const countBefore = b3GetWorldCount();

// Struct-by-value marshalling on this wasm32-emscripten target, verified empirically (see
// scripts/wasm/CMakeLists.txt / knowledge notes): ANY non-scalar C struct crossing a function
// boundary by value -- whether as a return (b3WorldDef from b3DefaultWorldDef) or as a parameter
// (b3WorldId into b3World_Step/b3DestroyWorld) -- is passed *indirectly*, via a pointer to memory
// holding the struct's bytes. It is NOT flattened into scalar register(s) even when small enough
// to fit in one (e.g. b3WorldId is just 4 bytes: {uint16 index1; uint16 generation;}). So every
// one of these calls below takes a pointer where the C signature shows a struct by value.

// b3WorldDef is a large struct; b3DefaultWorldDef(destPtr) fills *destPtr instead of returning a JS
// value. 256 bytes is a generous over-allocation for the ~104-112 byte struct.
const DEF_SIZE = 256;
const defPtr = Module._malloc(DEF_SIZE);
// b3CreateWorld(worldIdOutPtr, defPtr) writes the created b3WorldId's 4 bytes to worldIdOutPtr
// (an sret-style hidden output pointer) instead of returning it directly.
const worldIdPtr = Module._malloc(4);
try {
  b3DefaultWorldDef(defPtr);

  b3CreateWorld(worldIdPtr, defPtr);

  const countAfterCreate = b3GetWorldCount();
  if (countAfterCreate !== countBefore + 1) {
    throw new Error(
      `expected world count to increase by 1 (was ${countBefore}, now ${countAfterCreate})`
    );
  }

  // Step once: 1/60s, 4 sub-steps (typical Box3D usage). b3World_Step's first parameter is a
  // pointer to the b3WorldId bytes (see note above), so we pass worldIdPtr, not a dereferenced
  // value.
  b3World_Step(worldIdPtr, 1 / 60, 4);

  b3DestroyWorld(worldIdPtr);
} finally {
  Module._free(defPtr);
  Module._free(worldIdPtr);
}

const maxWorldCount = b3GetMaxWorldCount();
if (maxWorldCount < 1) {
  throw new Error(`expected b3GetMaxWorldCount() >= 1, got ${maxWorldCount}`);
}

console.log(
  `OK (worldCount before=${countBefore}, maxWorldCount=${maxWorldCount}, single-threaded, ` +
    `no SharedArrayBuffer required)`
);
process.exit(0);
