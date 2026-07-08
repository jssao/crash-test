// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "hit events", () => {
	it( "a box dropped from height reports a plausible hit event on landing", async () => {
		const native: Native = await loadNative();
		// A low hitEventThreshold so the landing impact (well above a slow settle) reliably crosses
		// it -- see b3WorldDef.hitEventThreshold, box3d/types.h.
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 }, hitEventThreshold: 0.1 } );

		try {
			const groundEntityId = 1;
			const boxEntityId = 2;

			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 },
				userData: groundEntityId } );
			ground.createBoxShape( {
				halfExtents: { x: 10, y: 0.5, z: 10 },
				enableHitEvents: true,
				userData: groundEntityId,
			} );

			const dropHeight = 8;
			const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: dropHeight, z: 0 },
				userData: boxEntityId } );
			box.createBoxShape( {
				halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
				enableHitEvents: true,
				userData: boxEntityId,
			} );

			const dt = 1 / 60;
			let sawHit = false;
			let lastHitPointY = Number.NaN;
			let lastHitApproachSpeed = Number.NaN;
			let lastHitNormal = { x: 0, y: 0, z: 0 };
			let lastHitEntities: [number, number] = [0, 0];

			for ( let i = 0; i < 180 && !sawHit; i++ ) {
				world.step( dt, 4 );
				const hits = world.hitEvents();
				if ( hits.count > 0 ) {
					const hit = hits.at( 0 );
					sawHit = true;
					lastHitPointY = hit.point.y;
					lastHitApproachSpeed = hit.approachSpeed;
					lastHitNormal = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
					lastHitEntities = [hit.userDataA, hit.userDataB];
				}
			}

			expect( sawHit ).toBe( true );

			// Plausible impact point: near the ground's top surface (y=0.5), well below the drop height.
			expect( lastHitPointY ).toBeGreaterThan( -0.5 );
			expect( lastHitPointY ).toBeLessThan( 1.5 );

			// A meaningful, positive approach speed (box fell for a while before impact).
			expect( lastHitApproachSpeed ).toBeGreaterThan( 0.5 );
			expect( Number.isFinite( lastHitApproachSpeed ) ).toBe( true );

			// The contact normal should be a plausible unit-ish vector (finite, non-degenerate),
			// roughly vertical for a box landing flat on a horizontal ground plane.
			const normalLength = Math.hypot( lastHitNormal.x, lastHitNormal.y, lastHitNormal.z );
			expect( normalLength ).toBeGreaterThan( 0.9 );
			expect( normalLength ).toBeLessThan( 1.1 );
			expect( Math.abs( lastHitNormal.y ) ).toBeGreaterThan( 0.9 );

			// The event must resolve to our application entity ids (ground=1, box=2), in either order,
			// never raw handles -- see src/wasm-shim/binding.c's b3js_EntityIdFromShape.
			const entities = new Set( lastHitEntities );
			expect( entities.has( groundEntityId ) ).toBe( true );
			expect( entities.has( boxEntityId ) ).toBe( true );
		} finally {
			world.destroy();
		}
	} );
} );
