// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "joint break (force/torque threshold) events", () => {
	it( "reports no events at the upstream default threshold, then reports them once lowered", async () => {
		const native: Native = await loadNative();
		// enableSleep:false -- joint events are only ever reported for *awake* joints (see
		// vendor/box3d/src/solver.c's joint-events report pass), and this rig's whole point is a
		// steady, unmoving hanging load that would otherwise fall asleep well before phase 2.
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 }, enableSleep: false } );

		try {
			// Same "weld holds a hanging load" rig as weld-force.test.ts -- gravity gives the joint a
			// steady, substantial constraint force to compare against the threshold.
			const anchor = world.createBody( { type: BodyType.Static, position: { x: 0, y: 5, z: 0 } } );
			anchor.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } );

			const hanging = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 4, z: 0 } } );
			hanging.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } );

			const jointEntityId = 777;
			const joint = world.createWeldJoint( anchor, hanging, {
				frameA: { position: { x: 0, y: -1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
				frameB: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
				linearHertz: 0,
				angularHertz: 0,
				linearDampingRatio: 1,
				angularDampingRatio: 1,
				userData: jointEntityId,
			} );

			// Upstream's own default (b3DefaultWeldJointDef() et al., vendor/box3d/src/joint.c) is
			// FLT_MAX for both thresholds -- confirm the shim reports that dead-by-default value rather
			// than some other sentinel.
			expect( joint.getForceThreshold() ).toBeGreaterThan( 1e30 );
			expect( joint.getTorqueThreshold() ).toBeGreaterThan( 1e30 );

			const dt = 1 / 60;

			// Phase 1: default threshold -- let the joint settle under the hanging load. No joint
			// events should ever be reported, confirming this path really was dead before being wired.
			let sawEventBeforeLowering = false;
			for ( let i = 0; i < 30; i++ ) {
				world.step( dt, 4 );
				if ( world.jointEvents().count > 0 ) {
					sawEventBeforeLowering = true;
				}
			}
			expect( sawEventBeforeLowering ).toBe( false );

			// Phase 2: lower the force threshold well below the resting holding force (a ~1000kg box's
			// weight is ~10000N at this world's gravity) -- this should now report a break/threshold
			// event for our joint on (at least) the next steps.
			joint.setForceThreshold( 1.0 );
			expect( joint.getForceThreshold() ).toBeCloseTo( 1.0, 5 );
			// Exercise the torque-threshold round trip too (not otherwise asserted physically here).
			joint.setTorqueThreshold( 5.0 );
			expect( joint.getTorqueThreshold() ).toBeCloseTo( 5.0, 5 );

			let sawEventAfterLowering = false;
			let reportedEntityId = 0;
			for ( let i = 0; i < 30 && !sawEventAfterLowering; i++ ) {
				world.step( dt, 4 );
				const events = world.jointEvents();
				if ( events.count > 0 ) {
					sawEventAfterLowering = true;
					reportedEntityId = events.at( 0 ).userData;
				}
			}

			expect( sawEventAfterLowering ).toBe( true );
			expect( reportedEntityId ).toBe( jointEntityId );

			joint.destroy();
		} finally {
			world.destroy();
		}
	} );
} );
