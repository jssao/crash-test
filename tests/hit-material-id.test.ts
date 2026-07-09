// SPDX-License-Identifier: MIT
//
// userMaterialId passthrough: b3ContactHitEvent.userMaterialIdA/B (types.h) were dropped at drain
// time (binding.c only copied entity ids), and b3SurfaceMaterial.userMaterialId (the ShapeDef-side
// field that feeds them) was never settable at all. Both are wired now -- a shape tagged with
// userMaterialId at creation gets it back on its hit events (truncated to 32 bits, same convention as
// entity ids -- see b3jsHitEvent's doc comment, binding.c), and it also round-trips through the new
// runtime Shape.getSurfaceMaterial()/setSurfaceMaterial().

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "hit event userMaterialId passthrough", () => {
	it( "a shape created with a userMaterialId reports it back on its hit events", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 }, hitEventThreshold: 0.1 } );

		try {
			const groundMaterialId = 111n;
			const boxMaterialId = 222n;

			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
			const groundShape = ground.createBoxShape( {
				halfExtents: { x: 10, y: 0.5, z: 10 },
				enableHitEvents: true,
				userMaterialId: groundMaterialId,
			} );

			const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 8, z: 0 } } );
			box.createBoxShape( {
				halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
				enableHitEvents: true,
				userMaterialId: boxMaterialId,
			} );

			// The creation-time value also round-trips through the runtime surface-material getter.
			expect( groundShape.getSurfaceMaterial().userMaterialId ).toBe( groundMaterialId );

			const dt = 1 / 60;
			let sawHit = false;
			let materialIds: [number, number] = [-1, -1];

			for ( let i = 0; i < 180 && !sawHit; i++ ) {
				world.step( dt, 4 );
				const hits = world.hitEvents();
				if ( hits.count > 0 ) {
					sawHit = true;
					const hit = hits.at( 0 );
					materialIds = [hit.userMaterialIdA, hit.userMaterialIdB];
				}
			}

			expect( sawHit ).toBe( true );
			const ids = new Set( materialIds );
			expect( ids.has( Number( groundMaterialId ) ) ).toBe( true );
			expect( ids.has( Number( boxMaterialId ) ) ).toBe( true );
		} finally {
			world.destroy();
		}
	} );

	it( "defaults to userMaterialId 0 when not set", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 }, hitEventThreshold: 0.1 } );

		try {
			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
			ground.createBoxShape( { halfExtents: { x: 10, y: 0.5, z: 10 }, enableHitEvents: true } );

			const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 8, z: 0 } } );
			box.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 }, enableHitEvents: true } );

			const dt = 1 / 60;
			let sawHit = false;
			let materialIds: [number, number] = [-1, -1];
			for ( let i = 0; i < 180 && !sawHit; i++ ) {
				world.step( dt, 4 );
				const hits = world.hitEvents();
				if ( hits.count > 0 ) {
					sawHit = true;
					const hit = hits.at( 0 );
					materialIds = [hit.userMaterialIdA, hit.userMaterialIdB];
				}
			}

			expect( sawHit ).toBe( true );
			expect( materialIds[0] ).toBe( 0 );
			expect( materialIds[1] ).toBe( 0 );
		} finally {
			world.destroy();
		}
	} );
} );
