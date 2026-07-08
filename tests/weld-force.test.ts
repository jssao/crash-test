// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

function magnitude( v: { x: number; y: number; z: number } ): number {
	return Math.hypot( v.x, v.y, v.z );
}

describe( "weld joint under load", () => {
	it( "reports a non-zero constraint force holding the load, and a larger force under impulse", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			// A static anchor box, and a dynamic box welded 1m below it -- the weld must hold B's full
			// weight against gravity, which is what gives the joint a steady, non-zero constraint force.
			const anchor = world.createBody( { type: BodyType.Static, position: { x: 0, y: 5, z: 0 } } );
			anchor.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } );

			const hanging = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 4, z: 0 } } );
			// A lighter-than-default density so a modest impulse clearly dominates the resting
			// (gravity-holding) constraint force in the "hard impulse" comparison below.
			hanging.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 }, density: 100 } );

			const joint = world.createWeldJoint( anchor, hanging, {
				frameA: { position: { x: 0, y: -1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
				frameB: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
				linearHertz: 0,
				angularHertz: 0,
				linearDampingRatio: 1,
				angularDampingRatio: 1,
			} );

			const dt = 1 / 60;
			for ( let i = 0; i < 90; i++ ) {
				world.step( dt, 4 );
			}

			const restForce = magnitude( joint.getConstraintForce() );
			expect( Number.isFinite( restForce ) ).toBe( true );
			expect( restForce ).toBeGreaterThan( 0 );

			// The weld must actually be holding it up: the hanging box shouldn't have fallen away.
			const settledY = hanging.getPosition().y;
			expect( settledY ).toBeGreaterThan( 3 );

			// A hard impulse should momentarily spike the constraint force well above the resting value.
			hanging.applyLinearImpulseToCenter( { x: 0, y: -2000, z: 0 } );
			world.step( dt, 4 );
			const impulseForce = magnitude( joint.getConstraintForce() );
			expect( Number.isFinite( impulseForce ) ).toBe( true );
			expect( impulseForce ).toBeGreaterThan( restForce );

			// destroyJoint works, and the handle is reported invalid afterward.
			joint.destroy();
			expect( joint.isValid() ).toBe( false );
		} finally {
			world.destroy();
		}
	} );
} );
