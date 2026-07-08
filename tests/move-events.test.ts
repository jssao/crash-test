// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "move events", () => {
	it( "carry the falling body's userData and transform, with a normalized quaternion", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const fallingEntityId = 42;

			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
			ground.createBoxShape( { halfExtents: { x: 10, y: 0.5, z: 10 } } );

			const box = world.createBody( {
				type: BodyType.Dynamic,
				position: { x: 0, y: 5, z: 0 },
				userData: fallingEntityId,
			} );
			box.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } );

			const dt = 1 / 60;
			let sawFallingBodyMoveEvent = false;
			let lastY = Number.POSITIVE_INFINITY;
			let anyDecrease = false;

			for ( let i = 0; i < 30; i++ ) {
				world.step( dt, 4 );
				const moves = world.moveEvents();
				expect( moves.count ).toBeGreaterThan( 0 );

				for ( let j = 0; j < moves.count; j++ ) {
					const move = moves.at( j );
					if ( move.userData !== fallingEntityId ) {
						continue;
					}
					sawFallingBodyMoveEvent = true;

					if ( move.position.y < lastY ) {
						anyDecrease = true;
					}
					lastY = move.position.y;

					// The quaternion must be normalized (unit length), within floating point tolerance.
					const q = move.rotation;
					const qLen = Math.sqrt( q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w );
					expect( qLen ).toBeGreaterThan( 0.99 );
					expect( qLen ).toBeLessThan( 1.01 );
				}
			}

			expect( sawFallingBodyMoveEvent ).toBe( true );
			expect( anyDecrease ).toBe( true );
		} finally {
			world.destroy();
		}
	} );
} );
