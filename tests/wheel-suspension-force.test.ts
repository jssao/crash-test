// SPDX-License-Identifier: MIT
//
// Regression test for the vendor patch to b3GetWheelJointForce() (vendor/PATCHES.md,
// docs/build-log/specs/upstream-issue-wheel-force.md). The upstream getter assembled the
// suspension-axis component of the reported constraint force from a *configured length*
// (joint->lowerSuspensionLimit) plus a sign-flipped upper term, instead of the accumulated
// suspension impulses. Symptom (measured in-repo before the fix): a loaded vehicle at static rest
// read ~0 N of suspension constraint force even though the wheels genuinely carry the full weight.
//
// This test stands up a symmetric 4-wheel rig carrying a known static load and asserts the SUM of
// the per-wheel constraint-force magnitudes tracks the real vehicle weight (M*g) -- which is only
// true with the corrected formula (suspensionSpringImpulse + lowerSuspensionImpulse -
// upperSuspensionImpulse). The buggy formula reads near-zero here and fails the lower bound.

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

// The suspension axis for a car points "up" in world space. These frame rotations mirror the
// game's wheel-joint setup (game/src/vehicle/mathUtil.ts WHEEL_FRAME_A/B_ROTATION): frame A's
// rotation maps the joint's suspension axis to world +Y, frame B's puts the spin axis lateral.
const FRAME_A_ROT = { x: 0.5, y: 0.5, z: 0.5, w: 0.5 };
const FRAME_B_ROT = { x: 0, y: Math.sin( Math.PI / 4 ), z: 0, w: Math.cos( Math.PI / 4 ) };

function magnitude( v: { x: number; y: number; z: number } ): number {
	return Math.hypot( v.x, v.y, v.z );
}

describe( "wheel joint suspension force at static rest", () => {
	it( "sums to the real vehicle weight (not ~0), so getConstraintForce tracks corner load", async () => {
		const native: Native = await loadNative();
		const gravity = 10;
		const world = new World( native, { gravity: { x: 0, y: -gravity, z: 0 } } );

		try {
			// Static ground, top surface at y = 0.
			const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: -0.5, z: 0 } } );
			ground.createBoxShape( { halfExtents: { x: 50, y: 0.5, z: 50 } } );

			// A symmetric chassis on four suspended wheels.
			const chassisY = 0.9;
			const chassis = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: chassisY, z: 0 } } );
			chassis.createBoxShape( { halfExtents: { x: 0.8, y: 0.25, z: 1.6 }, density: 300 } );
			const chassisMass = chassis.getMass();

			const wheelRadius = 0.35;
			const mounts = [
				{ x: 0.8, y: -0.25, z: 1.4 }, { x: -0.8, y: -0.25, z: 1.4 },
				{ x: 0.8, y: -0.25, z: -1.4 }, { x: -0.8, y: -0.25, z: -1.4 },
			];
			const joints = mounts.map( ( m ) => {
				const wheel = world.createBody( {
					type: BodyType.Dynamic, position: { x: m.x, y: chassisY + m.y, z: m.z },
				} );
				wheel.createSphereShape( { radius: wheelRadius, density: 200 } );
				return world.createWheelJoint( chassis, wheel, {
					frameA: { position: m, rotation: FRAME_A_ROT },
					frameB: { position: { x: 0, y: 0, z: 0 }, rotation: FRAME_B_ROT },
					enableSuspensionSpring: true, suspensionHertz: 6, suspensionDampingRatio: 0.7,
					enableSuspensionLimit: true, lowerSuspensionLimit: -0.14, upperSuspensionLimit: 0.14,
				} );
			} );

			const dt = 1 / 60;
			for ( let i = 0; i < 400; i++ ) world.step( dt, 4 );

			// The rig must actually be resting on its wheels (suspension bearing the load), not
			// collapsed through the ground -- otherwise the force reading would be meaningless.
			expect( chassis.getPosition().y ).toBeGreaterThan( wheelRadius );

			const perCorner = joints.map( ( j ) => magnitude( j.getConstraintForce() ) );
			const sum = perCorner.reduce( ( a, b ) => a + b, 0 );
			const weight = chassisMass * gravity;

			// Every corner reports a substantial, finite share of the load -- the buggy formula read
			// ~0 here (a fraction well below weight/8 per corner).
			for ( const f of perCorner ) {
				expect( Number.isFinite( f ) ).toBe( true );
				expect( f ).toBeGreaterThan( weight / 8 );
			}

			// The summed reaction load tracks the real vehicle weight within physical noise. The
			// buggy formula summed a configured length constant instead and could not satisfy this.
			expect( sum ).toBeGreaterThan( 0.75 * weight );
			expect( sum ).toBeLessThan( 1.25 * weight );
		} finally {
			world.destroy();
		}
	} );
} );
