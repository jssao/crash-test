#!/usr/bin/env node
// Copies the compiled box3d.mjs + box3d.wasm (produced by scripts/build-wasm.sh) into dist/wasm/,
// so the packaged "dist" directory ("files": ["dist"] in package.json) is self-contained.
//
// NOTE on default wasm-path resolution: src/ts/native.ts's zero-arg init() default resolves
// box3d.mjs relative to *its own compiled file's* location via
// `new URL("../../build/wasm/box3d.mjs", import.meta.url)` -- a convenience default for running
// straight out of this repo (where build/wasm/ is the build-wasm.sh output), not for a published
// dist/ package. A dist consumer (or this repo's own scripts/verify-dist.mjs) should pass an
// explicit `wasmUrl` pointing at the co-located dist/wasm/box3d.mjs instead of relying on that
// default -- see scripts/verify-dist.mjs and the README quickstart for the pattern. This script
// does not (and, per this port's constraints, must not) modify that default.
//
// Run via the root "build" npm script, after `tsc -p tsconfig.build.json`. Safe to re-run.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const repoRoot = path.resolve( here, ".." );

const srcDir = path.join( repoRoot, "build", "wasm" );
const destDir = path.join( repoRoot, "dist", "wasm" );

const files = ["box3d.mjs", "box3d.wasm"];

for ( const f of files ) {
	const src = path.join( srcDir, f );
	if ( !existsSync( src ) ) {
		console.error( `[copy-dist-wasm] ERROR: ${ src } not found.` );
		console.error( `[copy-dist-wasm] Run scripts/build-wasm.sh first (the root "build" script does this for you).` );
		process.exit( 1 );
	}
}

mkdirSync( destDir, { recursive: true } );
for ( const f of files ) {
	copyFileSync( path.join( srcDir, f ), path.join( destDir, f ) );
	console.log( `[copy-dist-wasm] copied ${ f } -> dist/wasm/${ f }` );
}
