// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, DEFAULT_CATEGORY_BITS, DEFAULT_MASK_BITS, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

function distance( a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number } ): number {
	return Math.hypot( a.x - b.x, a.y - b.y, a.z - b.z );
}

describe( "runtime collision filter (Shape.setFilter/getFilter)", () => {
	it( "two same-negative-group bodies stay interpenetrated until the filter is flipped, then separate", async () => {
		const native: Native = await loadNative();
		// Zero gravity: isolate the filter's effect on collision from any other motion. Sleep disabled
		// so the (initially motionless, non-colliding) bodies don't fall asleep before we flip the
		// filter and need them to react on the next steps.
		const world = new World( native, { gravity: { x: 0, y: 0, z: 0 }, enableSleep: false } );

		try {
			const noCollideGroup = -7; // negative group index -- same group members never collide

			const bodyA = world.createBody( { type: BodyType.Dynamic, position: { x: -0.1, y: 0, z: 0 } } );
			const shapeA = bodyA.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 }, groupIndex: noCollideGroup } );

			const bodyB = world.createBody( { type: BodyType.Dynamic, position: { x: 0.1, y: 0, z: 0 } } );
			const shapeB = bodyB.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 }, groupIndex: noCollideGroup } );

			// Round-trip sanity on the getter before touching anything.
			expect( shapeA.getFilter().groupIndex ).toBe( noCollideGroup );
			expect( shapeB.getFilter().groupIndex ).toBe( noCollideGroup );

			const initialSeparation = distance( bodyA.getPosition(), bodyB.getPosition() );
			expect( initialSeparation ).toBeCloseTo( 0.2, 5 );

			const dt = 1 / 60;

			// Phase 1: same negative group -> never collide, even though the two 1m boxes are heavily
			// interpenetrated (centers 0.2m apart). Nothing should push them apart.
			for ( let i = 0; i < 30; i++ ) {
				world.step( dt, 4 );
			}
			const separationBeforeFlip = distance( bodyA.getPosition(), bodyB.getPosition() );
			expect( separationBeforeFlip ).toBeLessThan( 0.25 );

			// Flip body B's shape back to the default (all-bits category/mask, neutral group) filter,
			// forcing its contacts to be recomputed immediately.
			shapeB.setFilter( { categoryBits: DEFAULT_CATEGORY_BITS, maskBits: DEFAULT_MASK_BITS, groupIndex: 0 }, true );
			expect( shapeB.getFilter().groupIndex ).toBe( 0 );

			// Phase 2: now an ordinary category/mask collision -- the overlap should resolve and the
			// bodies should push apart.
			for ( let i = 0; i < 90; i++ ) {
				world.step( dt, 4 );
			}
			const separationAfterFlip = distance( bodyA.getPosition(), bodyB.getPosition() );
			expect( Number.isFinite( separationAfterFlip ) ).toBe( true );
			expect( separationAfterFlip ).toBeGreaterThan( separationBeforeFlip + 0.3 );
		} finally {
			world.destroy();
		}
	} );
} );
