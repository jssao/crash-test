// SPDX-License-Identifier: MIT
//
// Shapecast (b3World_CastShape, box3d.h) -- previously entirely unwired. Core use case: chase-cam
// occlusion (sphere-cast camera->car, pull the camera in when it would clip a wall/building) and
// pre-impact proximity queries. World.castShapeClosest() is a thin "closest hit" convenience over the
// engine's callback-based cast, mirroring World.castRayClosest().

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "World.castShapeClosest", () => {
	it( "a swept sphere hits an expected static box target", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: 0, z: 0 } } );

		try {
			const targetEntityId = 42;
			const target = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 10 },
				userData: targetEntityId } );
			target.createBoxShape( { halfExtents: { x: 1, y: 1, z: 1 }, userData: targetEntityId } );

			// Sphere-cast proxy: a single point with a nonzero radius (see ShapeCastProxy's doc comment).
			const result = world.castShapeClosest(
				{ points: [{ x: 0, y: 0, z: 0 }], radius: 0.25 },
				{ x: 0, y: 0, z: 0 },
				{ x: 0, y: 0, z: 20 }
			);

			expect( result.hit ).toBe( true );
			expect( result.entityId ).toBe( targetEntityId );
			// The sphere's surface should meet the box's near face (z=9) somewhere close to it, well
			// before the box's far side or the full 20m sweep.
			expect( result.point.z ).toBeGreaterThan( 7 );
			expect( result.point.z ).toBeLessThan( 10 );
			expect( result.fraction ).toBeGreaterThan( 0 );
			expect( result.fraction ).toBeLessThan( 1 );
			// Hitting the box's near (-z) face, the surface normal should point back toward the caster.
			expect( result.normal.z ).toBeLessThan( 0 );
		} finally {
			world.destroy();
		}
	} );

	it( "reports no hit when the sweep doesn't reach anything", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: 0, z: 0 } } );

		try {
			const target = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 100 } } );
			target.createBoxShape( { halfExtents: { x: 1, y: 1, z: 1 } } );

			// Same direction, but the sweep distance falls far short of the target 100m away.
			const shortMiss = world.castShapeClosest(
				{ points: [{ x: 0, y: 0, z: 0 }], radius: 0.25 },
				{ x: 0, y: 0, z: 0 },
				{ x: 0, y: 0, z: 20 }
			);
			expect( shortMiss.hit ).toBe( false );
			expect( shortMiss.entityId ).toBe( 0 );

			// Same distance as the "hit" test above, but aimed sideways, away from the target entirely.
			const sidewaysMiss = world.castShapeClosest(
				{ points: [{ x: 0, y: 0, z: 0 }], radius: 0.25 },
				{ x: 0, y: 0, z: 0 },
				{ x: 20, y: 0, z: 0 }
			);
			expect( sidewaysMiss.hit ).toBe( false );
		} finally {
			world.destroy();
		}
	} );

	it( "respects category/mask filtering, same as castRayClosest", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: 0, z: 0 } } );

		try {
			const filteredBits = 1n << 5n;
			const target = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 10 } } );
			target.createBoxShape( { halfExtents: { x: 1, y: 1, z: 1 }, categoryBits: filteredBits } );

			const result = world.castShapeClosest(
				{ points: [{ x: 0, y: 0, z: 0 }], radius: 0.25 },
				{ x: 0, y: 0, z: 0 },
				{ x: 0, y: 0, z: 20 },
				{ maskBits: ~filteredBits }
			);

			expect( result.hit ).toBe( false );
		} finally {
			world.destroy();
		}
	} );
} );
