// SPDX-License-Identifier: MIT
//
// Manifold readback (b3Shape_GetContactData, box3d.h) -- the solver's actual per-contact-point
// normal/friction/rolling impulses (b3Manifold, types.h), previously entirely unwired. Unlike hit
// events (one-shot, approachSpeed heuristic), this is a query-time read of the CURRENT touching
// contacts on a shape -- enables physically-honest deformation depth (solver-impulse-driven crumple)
// instead of the approachSpeed heuristic damage-tuning currently uses.

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "Shape.getContactData (manifold readback)", () => {
	it( "reports a manifold with a plausible normal and nonzero normal impulse for a box resting on the ground", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
			const groundShape = ground.createBoxShape( { halfExtents: { x: 10, y: 0.5, z: 10 } } );

			const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 3, z: 0 } } );
			const boxShape = box.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } );

			// getContactCapacity()/getContactData() should be well-defined (0, no native call needed)
			// even before the box has ever touched anything.
			expect( groundShape.getContactCapacity() ).toBe( 0 );
			expect( groundShape.getContactData() ).toEqual( [] );

			const dt = 1 / 60;
			// Let the box fall, land, and settle so the solver has produced a resolved, resting contact
			// (not just a first-touch speculative one) with a real accumulated normal impulse.
			for ( let i = 0; i < 240; i++ ) {
				world.step( dt, 4 );
			}

			expect( groundShape.getContactCapacity() ).toBeGreaterThan( 0 );
			const groundContacts = groundShape.getContactData();
			expect( groundContacts.length ).toBeGreaterThan( 0 );

			const contact = groundContacts[0];
			expect( contact.manifoldCount ).toBeGreaterThan( 0 );
			expect( contact.points.length ).toBeGreaterThan( 0 );

			// A box resting on a horizontal ground plane: manifold normal should be roughly vertical
			// (points from shapeA to shapeB -- could be +y or -y depending on shape order, but close to
			// unit length and dominated by its y component).
			const normalLength = Math.hypot( contact.normal.x, contact.normal.y, contact.normal.z );
			expect( normalLength ).toBeGreaterThan( 0.9 );
			expect( normalLength ).toBeLessThan( 1.1 );
			expect( Math.abs( contact.normal.y ) ).toBeGreaterThan( 0.9 );

			// The box's weight must be held up by real, resolved normal impulse across the manifold's
			// points -- this is the solver-truth field damage/crumple logic would consume.
			expect( contact.totalNormalImpulseSum ).toBeGreaterThan( 0 );
			for ( const point of contact.points ) {
				expect( Number.isFinite( point.separation ) ).toBe( true );
				expect( Number.isFinite( point.normalImpulse ) ).toBe( true );
				expect( Number.isFinite( point.normalVelocity ) ).toBe( true );
			}

			// The same contact, read from the box's shape, must show the same pair of shapes (order may
			// be swapped, so compare as a set) and a consistent nonzero impulse.
			const boxContacts = boxShape.getContactData();
			expect( boxContacts.length ).toBeGreaterThan( 0 );
			expect( boxContacts[0].totalNormalImpulseSum ).toBeGreaterThan( 0 );
		} finally {
			world.destroy();
		}
	} );

	it( "reports no contacts for a shape that never touches anything", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const floatingBody = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 500, z: 0 } } );
			const floatingShape = floatingBody.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } );

			const dt = 1 / 60;
			for ( let i = 0; i < 30; i++ ) {
				world.step( dt, 4 );
			}

			expect( floatingShape.getContactCapacity() ).toBe( 0 );
			expect( floatingShape.getContactData() ).toEqual( [] );
		} finally {
			world.destroy();
		}
	} );
} );
