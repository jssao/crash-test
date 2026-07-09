// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "capsule shape sanity", () => {
	it( "a capsule dropped lying on its side comes to rest at ~radius height above the ground, no NaN", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
			ground.createBoxShape( { halfExtents: { x: 10, y: 0.5, z: 10 }, friction: 0.8 } );

			const dropHeight = 5;
			const radius = 0.3;
			const capsule = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: dropHeight, z: 0 } } );
			// Long axis along local x, endpoints level with the body origin -- lying on its side, the
			// naturally stable resting orientation for a capsule (as opposed to balanced on end).
			capsule.createCapsuleShape( {
				center1: { x: -0.5, y: 0, z: 0 },
				center2: { x: 0.5, y: 0, z: 0 },
				radius,
				friction: 0.8,
				restitution: 0.05,
			} );

			const dt = 1 / 60;
			const ys: number[] = [];
			for ( let i = 0; i < 200; i++ ) {
				world.step( dt, 4 );
				ys.push( capsule.getPosition().y );
			}

			// No NaN/Infinity at any point in the simulation.
			expect( ys.every( ( y ) => Number.isFinite( y ) ) ).toBe( true );

			// It must actually have fallen.
			const minYDuringFall = Math.min( ...ys.slice( 0, 30 ) );
			expect( ys[0] ).toBeGreaterThan( minYDuringFall - 0.01 ); // sanity: ys[0] is near the drop height
			expect( Math.min( ...ys ) ).toBeLessThan( dropHeight - 1 );

			// It should come to rest with its centerline at ~radius above the ground's top surface
			// (ground top at y=0.5, capsule center1/center2 both at local y=0 relative to the body).
			const expectedRestHeight = 0.5 + radius;
			const lastYs = ys.slice( -20 );
			const avgLastY = lastYs.reduce( ( a, b ) => a + b, 0 ) / lastYs.length;
			expect( avgLastY ).toBeGreaterThan( expectedRestHeight - 0.15 );
			expect( avgLastY ).toBeLessThan( expectedRestHeight + 0.3 );

			// And it must have actually settled (small spread over the final samples).
			const spread = Math.max( ...lastYs ) - Math.min( ...lastYs );
			expect( spread ).toBeLessThan( 0.05 );
		} finally {
			world.destroy();
		}
	} );
} );
