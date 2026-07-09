#!/usr/bin/env node
// Verifies the packaged dist/ output is actually usable: imports box3d-js from ./dist/index.js
// (exactly as an npm consumer would, via the package's "exports" map) and confirms it can init the
// wasm module, create a world, drop a dynamic box onto static ground, and step the simulation.
//
// Passes an explicit `wasmUrl` (rather than relying on init()'s zero-arg default, which is a
// repo-dev convenience pointing at build/wasm/ -- see scripts/copy-dist-wasm.mjs's doc comment)
// pointing at the co-located dist/wasm/box3d.mjs this script's sibling build step copies there.
//
// Usage: node scripts/verify-dist.mjs   (run after `npm run build`)
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const here = path.dirname( fileURLToPath( import.meta.url ) );
const repoRoot = path.resolve( here, ".." );
const distIndex = path.join( repoRoot, "dist", "index.js" );
const distWasm = path.join( repoRoot, "dist", "wasm", "box3d.mjs" );

for ( const p of [distIndex, distWasm] ) {
	if ( !existsSync( p ) ) {
		console.error( `[verify-dist] ERROR: ${ p } not found. Run "npm run build" first.` );
		process.exit( 1 );
	}
}

async function main() {
	const { init, World, BodyType } = await import( pathToFileURL( distIndex ).href );

	const distDirUrl = pathToFileURL( path.join( repoRoot, "dist" ) + path.sep );
	const native = await init( { wasmUrl: new URL( "wasm/box3d.mjs", distDirUrl ) } );

	const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
	if ( !world.isValid() ) throw new Error( "world.isValid() is false right after creation" );

	const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: -0.5, z: 0 } } );
	ground.createBoxShape( { halfExtents: { x: 10, y: 0.5, z: 10 } } );

	const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 5, z: 0 } } );
	box.createBoxShape();

	const startY = box.getPosition().y;
	for ( let i = 0; i < 120; i++ ) world.step( 1 / 60 );
	const endY = box.getPosition().y;

	if ( !( endY < startY ) ) {
		throw new Error( `expected the dropped box to fall under gravity: startY=${ startY }, endY=${ endY }` );
	}
	if ( !( endY > 0 ) ) {
		throw new Error( `dropped box tunneled through the ground: endY=${ endY }` );
	}

	world.destroy();

	console.log( "[verify-dist] OK -- init() + World/Body/Shape create + step() all work from dist/" );
	console.log( `[verify-dist]    box fell from y=${ startY.toFixed( 3 ) } to y=${ endY.toFixed( 3 ) } and rests above the ground` );
}

main().catch( ( err ) => {
	console.error( "[verify-dist] FAILED:", err );
	process.exit( 1 );
} );
