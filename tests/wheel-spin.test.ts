// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "wheel joint spin motor", () => {
	it( "commanding a spin speed makes the wheel body spin about the joint's spin axis", async () => {
		const native: Native = await loadNative();
		// Zero gravity: isolate the joint's spin-motor behavior from free-fall/contact, per
		// docs/loom/P1-binding-design.md's wheel-joint test hook ("motor speed -> body advances").
		const world = new World( native, { gravity: { x: 0, y: 0, z: 0 } } );

		try {
			// Chassis and wheel start coincident with identity local frames -- the wheel spins about
			// frame B's local z-axis (see b3WheelJointDef's doc comment, box3d/types.h).
			const chassis = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 0, z: 0 } } );
			chassis.createBoxShape( { halfExtents: { x: 1, y: 0.3, z: 0.5 } } );

			const wheel = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 0, z: 0 } } );
			wheel.createSphereShape( { radius: 0.4 } );

			const targetSpinSpeed = 10; // rad/s
			const joint = world.createWheelJoint( chassis, wheel, {
				enableSuspensionSpring: false,
				enableSpinMotor: true,
				maxSpinTorque: 500,
				spinSpeed: targetSpinSpeed,
				enableSteering: false,
			} );

			const dt = 1 / 60;
			for ( let i = 0; i < 120; i++ ) {
				world.step( dt, 4 );
			}

			// The motor should have driven the joint's measured relative spin speed close to the
			// commanded target (same sign, substantial magnitude -- not just noise).
			const measuredSpinSpeed = joint.getSpinSpeed();
			expect( measuredSpinSpeed ).toBeGreaterThan( targetSpinSpeed * 0.5 );
			expect( measuredSpinSpeed ).toBeLessThan( targetSpinSpeed * 1.5 );

			// The wheel body itself should be visibly rotating (non-zero angular velocity).
			const wheelAngularVelocity = wheel.getAngularVelocity();
			const wheelAngularSpeed = Math.hypot(
				wheelAngularVelocity.x, wheelAngularVelocity.y, wheelAngularVelocity.z
			);
			expect( wheelAngularSpeed ).toBeGreaterThan( 1 );

			joint.destroy();
			expect( joint.isValid() ).toBe( false );
		} finally {
			world.destroy();
		}
	} );
} );
