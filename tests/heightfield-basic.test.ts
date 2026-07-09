// SPDX-License-Identifier: MIT
//
// Validates the box3d heightfield collision path (b3js_CreateHeightFieldShape / body.ts
// createHeightFieldShape) end to end. This binding was wired during the original port but had
// NEVER been exercised by a test (RUN-1 ledger: "Untested: mesh/heightfield") -- this is that
// first exercise.
//
// Grid convention (vendor/box3d/src/height_field.c doc comment, verified by reading the source):
// heights[] is row-major, index = row * countX + col, x-axis = columns, z-axis = rows. The shape's
// LOCAL origin is the grid corner (col=0,row=0) at local (0,0,*) -- NOT centered -- with local
// x in [0, (countX-1)*scale.x] and local z in [0, (countZ-1)*scale.z]. World position = body
// position + local offset, so to center a field on the world origin the ground body must be placed
// at (-halfWidth, y, -halfDepth).

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

const COUNT_X = 64;
const COUNT_Z = 64;
const SCALE = { x: 1, y: 1, z: 1 };
const HALF_WIDTH = ( ( COUNT_X - 1 ) * SCALE.x ) / 2;
const HALF_DEPTH = ( ( COUNT_Z - 1 ) * SCALE.z ) / 2;

// Sine bumps (0.15m amplitude) + 3 pothole dips (0.3m depth), evaluated in WORLD (x,z) -- i.e. after
// the -HALF_WIDTH/-HALF_DEPTH centering offset, so (0,0) is the field center.
const POTHOLES = [
	{ x: -10, z: -8, r: 3 },
	{ x: 6, z: 12, r: 2.5 },
	{ x: 0, z: 20, r: 3 },
];

function terrainHeight( x: number, z: number ): number {
	let h = 0.15 * Math.sin( x * 0.3 ) * Math.sin( z * 0.3 );
	for ( const p of POTHOLES ) {
		const d2 = ( x - p.x ) ** 2 + ( z - p.z ) ** 2;
		h -= 0.3 * Math.exp( -d2 / ( 2 * p.r * p.r ) );
	}
	return h;
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

function buildWorld( native: Native ) {
	const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
	const ground = world.createBody( { type: BodyType.Static, position: { x: -HALF_WIDTH, y: 0, z: -HALF_DEPTH } } );
	const heights = buildHeights();
	ground.createHeightFieldShape( heights, COUNT_X, COUNT_Z, SCALE, { friction: 0.9 } );
	return { world, ground };
}

// Flat-ish spots away from the sine zero-crossings and pothole rims, so bodies settle roughly
// under their drop point instead of rolling off a slope.
const DROP_SITES: Array<{ x: number; z: number }> = [
	{ x: 5, z: -5 }, // near a sine crest/trough, away from potholes
	{ x: -15, z: 15 },
	{ x: 12, z: -18 },
];

describe( "heightfield basic", () => {
	it( "spheres/boxes/capsules dropped onto a bumpy heightfield come to rest ON the surface, no NaN/trap", async () => {
		const native: Native = await loadNative();
		const { world } = buildWorld( native );
		try {
			const dt = 1 / 60;
			const bodies: Array<{ kind: string; site: { x: number; z: number }; body: ReturnType<World["createBody"]> }> = [];
			DROP_SITES.forEach( ( site, i ) => {
				const dropY = terrainHeight( site.x, site.z ) + 3;
				const body = world.createBody( { type: BodyType.Dynamic, position: { x: site.x, y: dropY, z: site.z } } );
				if ( i === 0 ) body.createSphereShape( { radius: 0.4, friction: 0.9 } );
				else if ( i === 1 ) body.createBoxShape( { halfExtents: { x: 0.4, y: 0.4, z: 0.4 }, friction: 0.9 } );
				else {
					body.createCapsuleShape( {
						center1: { x: 0, y: -0.4, z: 0 },
						center2: { x: 0, y: 0.4, z: 0 },
						radius: 0.3,
						friction: 0.9,
					} );
				}
				bodies.push( { kind: ["sphere", "box", "capsule"][i], site, body } );
			} );

			let sawNaN = false;
			for ( let i = 0; i < 240; i++ ) {
				world.step( dt, 4 );
				for ( const { body } of bodies ) {
					const p = body.getPosition();
					if ( !Number.isFinite( p.x ) || !Number.isFinite( p.y ) || !Number.isFinite( p.z ) ) sawNaN = true;
				}
			}
			expect( sawNaN ).toBe( false );
			expect( world.isValid() ).toBe( true );

			// Each body should rest ON the terrain surface at (approximately) its drop x/z, within
			// the "footprint" (shape half-extent above the local ground height) plus tolerance for
			// the local slope under a non-point shape. Capsule range is wide because a freely-dropped
			// capsule may settle standing (center-to-center 0.8m + 0.3m radius = 0.7m) or tipped onto
			// its side (just the 0.3m radius) -- both are physically valid rest states.
			const restRange: Array<[number, number]> = [
				[0.25, 0.65], // sphere: radius 0.4
				[0.25, 0.65], // box: half-extent 0.4
				[0.15, 0.95], // capsule: radius 0.3 (on its side) .. 0.7 (standing)
			];
			bodies.forEach( ( { site, body }, i ) => {
				const p = body.getPosition();
				const expectedSurface = terrainHeight( p.x, p.z );
				const restHeight = p.y - expectedSurface;
				const [lo, hi] = restRange[i];
				expect( restHeight ).toBeGreaterThan( lo );
				expect( restHeight ).toBeLessThan( hi );
				// Didn't roll/slide far from its drop site.
				const drift = Math.hypot( p.x - site.x, p.z - site.z );
				expect( drift ).toBeLessThan( 2.5 );
			} );
		} finally {
			world.destroy();
		}
	} );

	it( "is deterministic across two independent runs (same heights, same drop, same trajectory)", async () => {
		const native: Native = await loadNative();

		async function run(): Promise<{ x: number; y: number; z: number }[]> {
			const { world } = buildWorld( native );
			try {
				const body = world.createBody( { type: BodyType.Dynamic, position: { x: 3, y: 4, z: -3 } } );
				body.createSphereShape( { radius: 0.4, friction: 0.9 } );
				const dt = 1 / 60;
				const positions: { x: number; y: number; z: number }[] = [];
				for ( let i = 0; i < 180; i++ ) {
					world.step( dt, 4 );
					positions.push( body.getPosition() );
				}
				return positions;
			} finally {
				world.destroy();
			}
		}

		const runA = await run();
		const runB = await run();
		expect( runA.length ).toBe( runB.length );
		let maxDelta = 0;
		for ( let i = 0; i < runA.length; i++ ) {
			maxDelta = Math.max(
				maxDelta,
				Math.abs( runA[i].x - runB[i].x ),
				Math.abs( runA[i].y - runB[i].y ),
				Math.abs( runA[i].z - runB[i].z )
			);
		}
		// eslint-disable-next-line no-console
		console.log( `[heightfield-basic] determinism max position delta across runs: ${maxDelta.toExponential( 3 )}` );
		expect( maxDelta ).toBeLessThan( 1e-4 );
	} );
} );
