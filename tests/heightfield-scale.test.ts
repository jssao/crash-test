// SPDX-License-Identifier: MIT
//
// Scale/perf/precision probe for the heightfield binding: a big field (256x256 grid points,
// covering 400x400m), creation time + memory delta, raycast correctness, and a check for
// position-dependent behavior (the RUN-2 ledger flagged a "ground-extent sensitivity" on a large
// flat ground box -- this measures whether the same shows up for heightfield contacts).

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

const COUNT_X = 256;
const COUNT_Z = 256;
const SPAN = 400; // meters, both axes
const SCALE = { x: SPAN / ( COUNT_X - 1 ), y: 1, z: SPAN / ( COUNT_Z - 1 ) };
const HALF_WIDTH = SPAN / 2;
const HALF_DEPTH = SPAN / 2;

function terrainHeight( x: number, z: number ): number {
	return 0.2 * Math.sin( x * 0.05 ) * Math.sin( z * 0.05 );
}

function buildHeights(): Float32Array {
	const heights = new Float32Array( COUNT_X * COUNT_Z );
	for ( let row = 0; row < COUNT_Z; row++ ) {
		for ( let col = 0; col < COUNT_X; col++ ) {
			const worldX = col * SCALE.x - HALF_WIDTH;
			const worldZ = row * SCALE.z - HALF_DEPTH;
			heights[row * COUNT_X + col] = terrainHeight( worldX, worldZ );
		}
	}
	return heights;
}

describe( "heightfield scale (256x256 / 400x400m)", () => {
	it( "creation time, memory delta, raycast correctness, and corner-vs-center consistency", async () => {
		const native: Native = await loadNative();
		const heights = buildHeights();

		const memBefore = native.HEAPU8.length;
		const t0 = performance.now();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		const ground = world.createBody( { type: BodyType.Static, position: { x: -HALF_WIDTH, y: 0, z: -HALF_DEPTH } } );
		ground.createHeightFieldShape( heights, COUNT_X, COUNT_Z, SCALE, { friction: 0.9 } );
		const createMs = performance.now() - t0;
		const memAfter = native.HEAPU8.length;
		const memDeltaBytes = memAfter - memBefore;

		// eslint-disable-next-line no-console
		console.log(
			`[heightfield-scale] create 256x256/400x400m: ${createMs.toFixed( 2 )}ms, ` +
				`wasm heap delta: ${( memDeltaBytes / 1024 / 1024 ).toFixed( 2 )}MiB ` +
				`(raw heights array is ${( ( heights.byteLength ) / 1024 ).toFixed( 0 )}KiB)`
		);
		expect( createMs ).toBeLessThan( 2000 ); // sanity bound, not a hard perf target
		expect( memDeltaBytes ).toBeGreaterThanOrEqual( 0 );

		try {
			// Raycast straight down at 5 sites: center + 4 far corners (inset 1 cell so the ray
			// starts strictly over the field, not exactly on its boundary edge).
			const inset = 2 * Math.max( SCALE.x, SCALE.z );
			const sites = [
				{ name: "center", x: 0, z: 0 },
				{ name: "corner -x-z", x: -HALF_WIDTH + inset, z: -HALF_DEPTH + inset },
				{ name: "corner +x-z", x: HALF_WIDTH - inset, z: -HALF_DEPTH + inset },
				{ name: "corner -x+z", x: -HALF_WIDTH + inset, z: HALF_DEPTH - inset },
				{ name: "corner +x+z", x: HALF_WIDTH - inset, z: HALF_DEPTH - inset },
			];

			const rayResults: Array<{ name: string; errAbs: number; timeUs: number }> = [];
			for ( const site of sites ) {
				const tRay0 = performance.now();
				const result = world.castRayClosest( { x: site.x, y: 50, z: site.z }, { x: 0, y: -100, z: 0 } );
				const timeUs = ( performance.now() - tRay0 ) * 1000;
				expect( result.hit ).toBe( true );
				const expected = terrainHeight( site.x, site.z );
				const errAbs = Math.abs( result.point.y - expected );
				rayResults.push( { name: site.name, errAbs, timeUs } );
			}
			// eslint-disable-next-line no-console
			console.log(
				"[heightfield-scale] raycast results: " +
					rayResults.map( ( r ) => `${r.name}=err${r.errAbs.toExponential( 2 )}/${r.timeUs.toFixed( 0 )}us` ).join( ", " )
			);
			for ( const r of rayResults ) {
				expect( r.errAbs ).toBeLessThan( 0.01 ); // quantization tolerance (65535 levels over a small range)
			}
			// Position-dependence check: corner raycast error should not be grossly larger than
			// center error (would indicate float32 precision degrading away from the origin).
			const centerErr = rayResults[0].errAbs;
			const maxCornerErr = Math.max( ...rayResults.slice( 1 ).map( ( r ) => r.errAbs ) );
			// eslint-disable-next-line no-console
			console.log(
				`[heightfield-scale] center err=${centerErr.toExponential( 2 )} maxCornerErr=${maxCornerErr.toExponential( 2 )}`
			);
			expect( maxCornerErr ).toBeLessThan( Math.max( centerErr * 20, 0.01 ) );

			// Drop identical spheres at center and each far corner; assert they all settle to
			// (approximately) the same rest-height-above-surface, i.e. behavior does not depend on
			// position within the field.
			const dt = 1 / 60;
			const bodies = sites.map( ( site ) => {
				const dropY = terrainHeight( site.x, site.z ) + 3;
				const body = world.createBody( { type: BodyType.Dynamic, position: { x: site.x, y: dropY, z: site.z } } );
				body.createSphereShape( { radius: 0.4, friction: 0.9 } );
				return { site, body };
			} );
			for ( let i = 0; i < 240; i++ ) {
				world.step( dt, 4 );
			}
			const restHeights = bodies.map( ( { site, body } ) => {
				const p = body.getPosition();
				return { name: site.name, restHeight: p.y - terrainHeight( p.x, p.z ) };
			} );
			// eslint-disable-next-line no-console
			console.log(
				"[heightfield-scale] rest heights: " +
					restHeights.map( ( r ) => `${r.name}=${r.restHeight.toFixed( 4 )}` ).join( ", " )
			);
			const centerRest = restHeights[0].restHeight;
			for ( const r of restHeights ) {
				expect( r.restHeight ).toBeGreaterThan( 0.2 );
				expect( r.restHeight ).toBeLessThan( 0.65 );
				expect( Math.abs( r.restHeight - centerRest ) ).toBeLessThan( 0.05 );
			}
		} finally {
			world.destroy();
		}
	} );

	it( "far-from-origin placement does not measurably change resting behavior (float32 sensitivity probe)", async () => {
		const native: Native = await loadNative();

		async function dropAt( offset: { x: number; z: number } ): Promise<number> {
			const heights = buildHeights();
			const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
			try {
				const ground = world.createBody( {
					type: BodyType.Static,
					position: { x: -HALF_WIDTH + offset.x, y: 0, z: -HALF_DEPTH + offset.z },
				} );
				ground.createHeightFieldShape( heights, COUNT_X, COUNT_Z, SCALE, { friction: 0.9 } );
				const dropX = offset.x;
				const dropZ = offset.z;
				const dropY = terrainHeight( 0, 0 ) + 3;
				const body = world.createBody( { type: BodyType.Dynamic, position: { x: dropX, y: dropY, z: dropZ } } );
				body.createSphereShape( { radius: 0.4, friction: 0.9 } );
				const dt = 1 / 60;
				for ( let i = 0; i < 240; i++ ) world.step( dt, 4 );
				const p = body.getPosition();
				return p.y - terrainHeight( 0, 0 );
			} finally {
				world.destroy();
			}
		}

		const nearRest = await dropAt( { x: 0, z: 0 } );
		const farRest = await dropAt( { x: 5000, z: 5000 } );
		// eslint-disable-next-line no-console
		console.log(
			`[heightfield-scale] float32 sensitivity: rest-height-above-surface near-origin=${nearRest.toFixed( 5 )} ` +
				`far-from-origin(5000,5000)=${farRest.toFixed( 5 )} delta=${Math.abs( nearRest - farRest ).toExponential( 3 )}`
		);
		expect( Number.isFinite( farRest ) ).toBe( true );
		// Report-worthy threshold: more than 1cm drift purely from world-space offset would indicate
		// a genuine float32 precision issue in the heightfield contact path.
		expect( Math.abs( nearRest - farRest ) ).toBeLessThan( 0.05 );
	} );
} );
