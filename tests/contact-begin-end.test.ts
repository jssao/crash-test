// SPDX-License-Identifier: MIT
//
// Contact begin/end touch events (b3ContactBeginTouchEvent/b3ContactEndTouchEvent, types.h) --
// previously drained nowhere (binding.c only read contactEvents.hitCount). Unlike one-shot hit
// events, these track sustained touch *state*: a begin event when two shapes start overlapping, an
// end event when they stop -- the primitive a scrape/skid/screech system would build on. Only
// reported for shapes created with `enableContactEvents: true` (already-plumbed per the engine
// coverage audit).

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "contact begin/end events", () => {
	it( "reports a begin event (both shapes' entity ids) when a dropped box lands, then an end event when it's launched back off", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const groundEntityId = 10;
			const boxEntityId = 20;

			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 },
				userData: groundEntityId } );
			ground.createBoxShape( {
				halfExtents: { x: 10, y: 0.5, z: 10 },
				enableContactEvents: true,
				userData: groundEntityId,
			} );

			const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 3, z: 0 },
				userData: boxEntityId } );
			box.createBoxShape( {
				halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
				enableContactEvents: true,
				userData: boxEntityId,
			} );

			const dt = 1 / 60;

			// Phase 1: let the box fall and land -- expect exactly the begin event we're looking for.
			let sawBegin = false;
			let beginEntities: [number, number] = [0, 0];
			for ( let i = 0; i < 180 && !sawBegin; i++ ) {
				world.step( dt, 4 );
				const begins = world.contactBeginEvents();
				if ( begins.count > 0 ) {
					sawBegin = true;
					const ev = begins.at( 0 );
					beginEntities = [ev.userDataA, ev.userDataB];
				}
			}

			expect( sawBegin ).toBe( true );
			const beginSet = new Set( beginEntities );
			expect( beginSet.has( groundEntityId ) ).toBe( true );
			expect( beginSet.has( boxEntityId ) ).toBe( true );

			// No end event should have fired yet -- box just landed and is still resting on the ground.
			expect( world.contactEndEvents().count ).toBe( 0 );

			// Phase 2: launch the box off the ground -- expect an end event once it separates.
			box.setLinearVelocity( { x: 0, y: 8, z: 0 } );

			let sawEnd = false;
			let endEntities: [number, number] = [0, 0];
			for ( let i = 0; i < 60 && !sawEnd; i++ ) {
				world.step( dt, 4 );
				const ends = world.contactEndEvents();
				if ( ends.count > 0 ) {
					sawEnd = true;
					const ev = ends.at( 0 );
					endEntities = [ev.userDataA, ev.userDataB];
				}
			}

			expect( sawEnd ).toBe( true );
			const endSet = new Set( endEntities );
			expect( endSet.has( groundEntityId ) ).toBe( true );
			expect( endSet.has( boxEntityId ) ).toBe( true );
		} finally {
			world.destroy();
		}
	} );

	it( "reports nothing for shapes created without enableContactEvents", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
			ground.createBoxShape( { halfExtents: { x: 10, y: 0.5, z: 10 } } ); // enableContactEvents defaults false

			const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 3, z: 0 } } );
			box.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } );

			const dt = 1 / 60;
			let sawAnyBeginOrEnd = false;
			for ( let i = 0; i < 180; i++ ) {
				world.step( dt, 4 );
				if ( world.contactBeginEvents().count > 0 || world.contactEndEvents().count > 0 ) {
					sawAnyBeginOrEnd = true;
				}
			}

			expect( sawAnyBeginOrEnd ).toBe( false );
		} finally {
			world.destroy();
		}
	} );
} );
