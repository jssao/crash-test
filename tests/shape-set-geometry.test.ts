// SPDX-License-Identifier: MIT
//
// Coverage for the newly-wired runtime geometry mutators Shape.setHull() / Shape.setMesh()
// (b3Shape_SetHull / b3Shape_SetMesh; see src/wasm-shim/binding.c and
// docs/build-log/specs/upstream-delta.md section (d)). These swap a shape's collision geometry in
// place; the tests prove collision genuinely FOLLOWS the new geometry -- a body resting on the shape
// re-settles to the height the NEW geometry dictates, not just that the call returns without error.
//
// Both tests mutate toward *removing* support (tall->short hull; platform lowered) so the body
// re-settles by falling under gravity -- a well-behaved path that also exercises the re-wake the
// mutators perform (a settled body would otherwise be asleep).

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

// 8 corner points of an axis-aligned box with the given half-extents, as a flat (x,y,z) buffer.
function boxHullPoints( hx: number, hy: number, hz: number ): Float32Array {
	const out: number[] = [];
	for ( const sx of [ -hx, hx ] ) {
		for ( const sy of [ -hy, hy ] ) {
			for ( const sz of [ -hz, hz ] ) out.push( sx, sy, sz );
		}
	}
	return new Float32Array( out );
}

describe( "Shape.setHull() — collision follows a runtime hull swap", () => {
	it( "a body resting tall on the ground settles lower after its hull shrinks", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		try {
			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: -0.5, z: 0 } } );
			ground.createBoxShape( { halfExtents: { x: 20, y: 0.5, z: 20 } } );

			// Start as a tall box (half-height 1.0): it settles with its center at ~1.0.
			const body = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 3, z: 0 } } );
			const shape = body.createHullShape( boxHullPoints( 0.25, 1.0, 0.25 ) );

			const dt = 1 / 60;
			for ( let i = 0; i < 240; i++ ) world.step( dt, 4 );
			const restTall = body.getPosition().y;
			expect( restTall ).toBeGreaterThan( 0.85 );
			expect( restTall ).toBeLessThan( 1.15 );

			// Shrink the hull to a small cube (half-height 0.25). Its previous ground support is gone,
			// so the body must fall and re-settle with its center near y = 0.25 -- only true if
			// collision actually uses the mutated geometry (and only reachable if setHull re-woke it).
			shape.setHull( boxHullPoints( 0.25, 0.25, 0.25 ) );
			for ( let i = 0; i < 240; i++ ) world.step( dt, 4 );
			const restSmall = body.getPosition().y;

			expect( shape.isValid() ).toBe( true );
			expect( restSmall ).toBeLessThan( restTall - 0.5 );
			expect( restSmall ).toBeGreaterThan( 0.15 );
			expect( restSmall ).toBeLessThan( 0.4 );
		} finally {
			world.destroy();
		}
	} );
} );

describe( "Shape.setMesh() — collision follows a runtime mesh swap", () => {
	it( "a sphere resting on a static mesh platform falls after the platform is lowered", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		try {
			// A static platform of two up-facing triangles (winding [0,2,1],[0,3,2] -> +Y normal)
			// spanning x,z in [-5,5]. `yOff` shifts the whole plane vertically.
			const platform = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
			const verts = ( yOff: number ) => new Float32Array( [
				-5, yOff, -5, 5, yOff, -5, 5, yOff, 5, -5, yOff, 5,
			] );
			const indices = new Int32Array( [ 0, 2, 1, 0, 3, 2 ] );
			const meshShape = platform.createMeshShape( verts( 0 ), indices );

			const sphere = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 2, z: 0 } } );
			sphere.createSphereShape( { radius: 0.5 } );

			const dt = 1 / 60;
			for ( let i = 0; i < 240; i++ ) world.step( dt, 4 );
			const restHigh = sphere.getPosition().y;
			expect( restHigh ).toBeGreaterThan( 0.35 );
			expect( restHigh ).toBeLessThan( 0.65 );

			// Lower the platform's triangles by 2m. The sphere loses its support and must fall to the
			// new surface (~ -1.5), following the mutated mesh geometry.
			meshShape.setMesh( verts( -2.0 ), indices );
			for ( let i = 0; i < 300; i++ ) world.step( dt, 4 );
			const restLow = sphere.getPosition().y;

			expect( meshShape.isValid() ).toBe( true );
			expect( restLow ).toBeLessThan( restHigh - 1.0 );
			expect( restLow ).toBeGreaterThan( -2.0 );
		} finally {
			world.destroy();
		}
	} );
} );
