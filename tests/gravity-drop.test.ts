// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "gravity drop", () => {
	it( "a dynamic box falls under gravity and stabilizes on a static ground box", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
			ground.createBoxShape( { halfExtents: { x: 10, y: 0.5, z: 10 }, friction: 0.8 } );

			const dropHeight = 5;
			const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: dropHeight, z: 0 } } );
			box.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 }, friction: 0.8, restitution: 0.05 } );

			const dt = 1 / 60;
			const ys: number[] = [];
			for ( let i = 0; i < 180; i++ ) {
				world.step( dt, 4 );
				ys.push( box.getPosition().y );
			}

			// The box must actually have fallen -- y decreases well below the drop height at some point.
			const minY = Math.min( ...ys );
			expect( minY ).toBeLessThan( dropHeight - 1 );

			// ...and it must decrease monotonically-ish early on (sampled a few steps in, before contact).
			expect( ys[30] ).toBeLessThan( ys[0] );

			// It should come to rest on the ground: ground top at y=0.5, box half-extent 0.5, so the
			// resting center height is ~1.0.
			const restHeight = 1.0;
			const lastYs = ys.slice( -20 );
			const avgLast = lastYs.reduce( ( a, b ) => a + b, 0 ) / lastYs.length;
			expect( avgLast ).toBeGreaterThan( restHeight - 0.15 );
			expect( avgLast ).toBeLessThan( restHeight + 0.3 );

			// And it must have actually stabilized (small spread over the final samples), not still
			// bouncing/falling.
			const spread = Math.max( ...lastYs ) - Math.min( ...lastYs );
			expect( spread ).toBeLessThan( 0.05 );
		} finally {
			world.destroy();
		}
	} );
} );
