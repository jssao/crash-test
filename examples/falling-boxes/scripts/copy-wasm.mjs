#!/usr/bin/env node
// Copies the compiled box3d.mjs + box3d.wasm (produced by the repo root's scripts/build-wasm.sh)
// into this example's public/wasm/ directory, so Vite serves them byte-for-byte (unbundled, side
// by side) both in dev and in the production build -- box3d.mjs locates box3d.wasm at runtime via
// a fetch relative to its OWN served URL (see the Emscripten-generated `scriptDirectory` logic), so
// the two files must live next to each other wherever they end up.
//
// Run automatically via the "predev"/"prebuild" npm script hooks. Safe to re-run.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleRoot = path.resolve(here, "..");
const repoRoot = path.resolve(exampleRoot, "..", "..");

const srcDir = path.join(repoRoot, "build", "wasm");
const destDir = path.join(exampleRoot, "public", "wasm");

const files = ["box3d.mjs", "box3d.wasm"];

for (const f of files) {
  const src = path.join(srcDir, f);
  if (!existsSync(src)) {
    console.error(`[sync-wasm] ERROR: ${src} not found.`);
    console.error(`[sync-wasm] Run scripts/build-wasm.sh from the repo root first:`);
    console.error(`[sync-wasm]   (cd ${repoRoot} && scripts/build-wasm.sh)`);
    process.exit(1);
  }
}

mkdirSync(destDir, { recursive: true });
for (const f of files) {
  copyFileSync(path.join(srcDir, f), path.join(destDir, f));
  console.log(`[sync-wasm] copied ${f} -> public/wasm/${f}`);
}
