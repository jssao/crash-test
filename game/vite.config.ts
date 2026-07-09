import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// box3d-js repo root, one level up -- the physics vehicle core (src/vehicle/*) imports the
// binding directly from ../src/ts (outside this Vite project root), and that binding dynamically
// imports the compiled wasm loader from ../build/wasm at runtime. Vite's dev server denies
// requests outside its project root by default; allow the repo root explicitly so `npm run dev`
// can serve both.
const repoRoot = path.resolve(__dirname, '..');

/**
 * The bundled box3d.mjs loader fetches its wasm binary via `new URL("box3d.wasm",
 * import.meta.url)` (Emscripten's default MODULARIZE behavior, see src/ts/native.ts's module doc)
 * -- Vite's static analysis has no way to see that runtime relative fetch, so it never picks
 * ../build/wasm/box3d.wasm up as a build asset on its own. Mirroring it into public/assets/ (Vite
 * copies public/ verbatim to the dist root, and serves it as-is from `vite dev` too) puts it at
 * the same "assets/" directory the bundled loader chunk itself lands in, so the relative fetch
 * resolves correctly in dev, build, AND preview. Synced automatically (mtime-checked) rather than
 * committed/copied by hand, so it can't silently go stale after `scripts/build-wasm.sh` reruns.
 */
function syncWasmBinaryPlugin(): Plugin {
	return {
		name: 'sync-box3d-wasm-binary',
		buildStart() {
			const src = path.join(repoRoot, 'build/wasm/box3d.wasm');
			const dest = path.join(__dirname, 'public/assets/box3d.wasm');
			if (!fs.existsSync(src)) {
				this.warn(`box3d.wasm not found at ${src} -- run scripts/build-wasm.sh at the repo root first.`);
				return;
			}
			const srcStat = fs.statSync(src);
			const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
			if (!destStat || destStat.mtimeMs < srcStat.mtimeMs) {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.copyFileSync(src, dest);
			}
		},
	};
}

// GitHub Pages compatible: relative base so the build works from any subpath
// (project pages served at /<repo>/ as well as a user/org root site).
export default defineConfig({
  base: './',
  plugins: [syncWasmBinaryPlugin()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
