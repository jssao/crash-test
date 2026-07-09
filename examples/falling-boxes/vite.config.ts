import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The example imports box3d-js straight from the repo's src/ts sources (see src/main.ts) rather
// than from a published package, so Vite's dev-server file-serving allowlist needs to reach the
// repo root (two levels up from this example) in addition to its own project root.
const repoRoot = path.resolve(here, "..", "..");

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    fs: {
      allow: [here, repoRoot],
    },
  },
  preview: {
    port: 4174,
    strictPort: true,
  },
});
