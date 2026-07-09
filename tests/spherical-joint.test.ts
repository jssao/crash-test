// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "spherical joint cone limit + spring", () => {
	it( "constrains swing motion within the cone limit, and the spring pulls it back afterward", async () => {
		const native: Native = await loadNative();
		// Zero gravity: isolate the joint's own behavior (cone limit + spring), same rationale as
		// wheel-spin.test.ts's motor test.
		const world = new World( native, { gravity: { x: 0, y: 0, z: 0 } } );

		try {
			// Static anchor (no shape needed -- joints reference body ids, not shapes) and a dynamic
			// "limb" coincident with it. The joint's local frames are both identity, so the ball-socket
			// point sits at both bodies' shared origin -- only the limb's *rotation* about that point is
			// under test.
			const anchor = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );

			const limb = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 0, z: 0 } } );
			limb.createBoxShape( { halfExtents: { x: 0.3, y: 0.3, z: 0.3 } } );

			const coneLimit = 0.5; // radians, ~28.6 degrees
			// Spring starts disabled -- phase 1 below tests the cone limit on its own, undamped by the
			// spring, so it's driven hard up against the limit. hertz/dampingRatio/targetRotation are
			// still set here since the shim always writes them into the def regardless of enableSpring;
			// phase 2 just flips the joint's spring on afterward.
			const joint = world.createSphericalJoint( anchor, limb, {
				enableConeLimit: true,
				coneAngle: coneLimit,
				enableSpring: false,
				hertz: 3,
				dampingRatio: 1,
				// targetRotation defaults to identity -- the spring (once enabled) pulls the limb's
				// frame back into alignment with the anchor's frame, i.e. cone angle -> 0.
			} );

			// A hard, continuously-applied angular velocity about an axis perpendicular to the cone axis
			// (world z, since both frames start aligned with it) -- this is pure "swing", not "twist", so
			// it directly drives the cone angle up against the limit and keeps pushing on it every step.
			const dt = 1 / 60;

			// Phase 1: cone limit alone, no spring -- swing hard into the limit and confirm it holds.
			const phase1ConeAngles: number[] = [];
			for ( let i = 0; i < 90; i++ ) {
				limb.setAngularVelocity( { x: 10, y: 0, z: 0 } );
				world.step( dt, 4 );
				phase1ConeAngles.push( joint.getConeAngle() );
			}

			expect( phase1ConeAngles.every( ( a ) => Number.isFinite( a ) ) ).toBe( true );
			const maxConeAngle = Math.max( ...phase1ConeAngles );

			// The limit must actually have been engaged (not a vacuous pass because nothing moved).
			expect( maxConeAngle ).toBeGreaterThan( coneLimit * 0.5 );
			// ...but never meaningfully exceeded, modulo solver softness slop.
			expect( maxConeAngle ).toBeLessThan( coneLimit + 0.1 );

			// Phase 2: stop driving it, enable the spring (targeting identity rotation, i.e. cone angle
			// 0), and confirm it pulls the limb back down well below the phase-1 peak.
			joint.enableSpring( true );
			expect( joint.isSpringEnabled() ).toBe( true );

			const phase2ConeAngles: number[] = [];
			for ( let i = 0; i < 150; i++ ) {
				world.step( dt, 4 );
				phase2ConeAngles.push( joint.getConeAngle() );
			}

			expect( phase2ConeAngles.every( ( a ) => Number.isFinite( a ) ) ).toBe( true );
			const lastConeAngles = phase2ConeAngles.slice( -20 );
			const avgLastConeAngle = lastConeAngles.reduce( ( a, b ) => a + b, 0 ) / lastConeAngles.length;
			expect( avgLastConeAngle ).toBeLessThan( maxConeAngle * 0.5 );
			expect( avgLastConeAngle ).toBeLessThan( coneLimit * 0.5 );

			joint.destroy();
			expect( joint.isValid() ).toBe( false );
		} finally {
			world.destroy();
		}
	} );
} );
