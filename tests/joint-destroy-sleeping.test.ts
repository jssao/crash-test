// SPDX-License-Identifier: MIT
//
// Regression coverage for Joint.destroy(wakeAttached=false) on SLEEPING attached bodies.
//
// IMPORTANT CORRECTION vs. this investigation's original hypothesis: the bug report that motivated
// this file claimed the browser's "memory access out of bounds" crash on window.__GAME__.resetWorld()
// was root-caused to game/src/world/features/buildings/structures.ts's resetStructure()
// (`record.joint.destroy(false)`) -- the only call site passing wakeAttached=false while its bodies
// were asleep. That attribution was WRONG, made from a MINIFIED production stack trace that could not
// actually distinguish which feature's reset()/Joint.destroy() call was on the stack. An UNMINIFIED
// repro (game dev server, unbundled) pinpoints the real crash site precisely:
//   WeldJoint.destroy (src/ts/joint.ts) <- destroyAll (game/src/world/features/cardetail/index.ts)
//   <- Object.reset (cardetail/index.ts's WorldFeature.reset()) <- registry.ts's reset(kind) dispatch
//   <- doCarRepair (game/src/main.ts) <- resetWorld
// cardetail's 39 components are welded straight to the CHASSIS body (createWeldJoint(chassis, body,
// ...)). doCarRepair() calls destroyVehicle(vehicle) FIRST, which natively destroys the chassis body
// -- and per box3d convention, destroying a body natively destroys every joint still attached to it as
// a side effect, INCLUDING all 39 cardetail welds. cardetail's destroyAll() then calls
// `h.weld.destroy()` on those SAME joints again, touching already-freed native memory -- exactly the
// "CHASSIS-ATTACHED-JOINT LIFECYCLE HAZARD" game/src/world/features/occupants/physics.ts's own doc
// comment describes and already guards against (teardownOccupant()/teardownSeatPan() use
// forgetHandle() -- registry bookkeeping only, no native call -- for their own chassis-attached
// joints). cardetail/index.ts's destroyAll() is missing that same guard. THAT is the actual bug
// (confirmed by re-running game/verify/feature-buildings.mjs after this file's binding-level fix
// below: it still reproduces the identical trap, now pointing at cardetail in an unminified trace).
// Fixing it requires editing game/src/world/features/cardetail/index.ts, which is outside this task's
// owned paths -- see this task's final report for the full writeup and the exact fix needed there.
//
// The wakeAttached=false-on-sleeping-bodies hazard investigated below is real on its own terms (see
// the vendor ROOT CAUSE analysis), but empirically it is NOT what game/verify/feature-buildings.mjs's
// resetWorld() crash was actually caused by -- it could not be reproduced as a standalone trap in
// Node OR in a from-scratch browser repro (dev server, unbundled) at full real-game scale/topology/
// order, with or without prior damage. The binding-level fix is kept anyway as a legitimate, harmless
// defense-in-depth improvement (Release/NDEBUG builds compile out every B3_ASSERT/B3_VALIDATE -- see
// below -- so this class of vendor invariant violation would otherwise corrupt state silently instead
// of failing loudly), NOT as the fix for the cardetail crash.
//
// TRAP MATRIX for wakeAttached=false specifically (Node, this file's tests, +a full-fidelity port of
// the real game's boot sequence tried standalone): destroy(false) with both bodies asleep, one asleep
// one awake, dynamic-asleep-welded-to-static, and a many-joint reset-loop stress case -- none trap,
// with or without the binding fix. This does not mean the vendor hazard analyzed below is fictitious
// (Release builds silently corrupting state rather than trapping is entirely consistent with "no
// observed trap"), only that it isn't a proven cause of any currently-reproducing crash.
//
// ROOT CAUSE of the wakeAttached=false hazard (vendor, read-only -- vendor/box3d/src/joint.c's
// b3DestroyJointInternal, ~line 724): the `wakeBodies` flag ONLY gates a `b3WakeBody(bodyA);
// b3WakeBody(bodyB);` call at the very end (after
// the joint has already been unlinked from its island (b3UnlinkJoint, island.c:310) and removed from
// its owning solver set). That unlink increments island->constraintRemoveCount (island.c:337) -- a
// "pending split" counter that is only ever resolved by b3TrySleepIsland's "must split before sleeping"
// path (body.c:1944-1950, guarded on island->bodies.count > 1) or by the per-step awake-island solver
// path (solver.c:803) -- NEITHER of which ever runs for an island that stays asleep the whole time
// (skipped exactly when wakeBodies=false leaves it asleep). The counter (and whatever solver-set/
// graph-color bookkeeping actually depends on it being resolved promptly) is left to accumulate
// indefinitely across repeated destroy(false) calls on the same sleeping island -- exactly
// resetStructure()'s access pattern (many joints destroyed+recreated per structure, per reset).
//
// FIX (src/wasm-shim/binding.c's b3js_DestroyJoint): wakeAttached=false is now BEST-EFFORT -- if
// either attached body is asleep, the binding forces a wake regardless of what the caller asked,
// closing off the one code path (skip-wake while asleep) unique to this call site. A body that's
// already awake is left exactly as requested (no gratuitous wake). game/src/world/features/buildings/
// structures.ts's resetStructure() was also changed to call destroy() (default wakeAttached=true)
// directly, since there was never a reason to ask for the risky flag there in the first place.

import { describe, expect, it } from "vitest";
import { BodyType, World, type Body, type Native, type WeldJoint } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };

function box( world: World, type: BodyType, pos: { x: number; y: number; z: number } ): Body {
	const body = world.createBody( { type, position: pos } );
	body.createBoxShape( { halfExtents: { x: 0.3, y: 0.3, z: 0.3 }, density: 500 } );
	if ( type === BodyType.Dynamic ) body.applyMassFromShapes();
	return body;
}

function weld( world: World, a: Body, b: Body ): WeldJoint {
	const joint = world.createWeldJoint( a, b, {
		frameA: { position: { x: 0, y: -0.5, z: 0 }, rotation: IDENTITY_Q },
		frameB: { position: { x: 0, y: 0.5, z: 0 }, rotation: IDENTITY_Q },
		linearHertz: 0, angularHertz: 0, linearDampingRatio: 1, angularDampingRatio: 1,
	} );
	joint.setForceThreshold( 1e9 );
	joint.setTorqueThreshold( 1e9 );
	return joint;
}

describe( "Joint.destroy(wakeAttached) on sleeping bodies", () => {
	it( "destroy(false): both bodies asleep -- must not throw, and must leave the world usable afterward", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		try {
			const a = box( world, BodyType.Dynamic, { x: 0, y: 5, z: 0 } );
			const b = box( world, BodyType.Dynamic, { x: 0, y: 4, z: 0 } );
			const joint = weld( world, a, b );
			for ( let i = 0; i < 3; i++ ) world.step( 1 / 60, 4 );
			a.setAwake( false );
			b.setAwake( false );
			expect( a.isAwake() ).toBe( false );
			expect( b.isAwake() ).toBe( false );

			expect( () => joint.destroy( false ) ).not.toThrow();

			// World must still be fully usable (no latent poisoning).
			world.step( 1 / 60, 4 );
			expect( world.isValid() ).toBe( true );
			expect( Number.isFinite( a.getPosition().y ) ).toBe( true );
		} finally {
			world.destroy();
		}
	} );

	it( "destroy(false): bodies from two DIFFERENT islands, one asleep one awake at joint-creation time -- must not throw", async () => {
		// Two jointed bodies always share one island (box3d keeps sleep state island-consistent --
		// b3Body_SetAwake(false) sleeps the WHOLE island, and b3LinkJoint wakes a sleeping island when
		// joining it to an awake one), so "one asleep, one awake" while sharing a live joint isn't a
		// reachable steady state via the public API. The nearest real analogue: put one body to sleep
		// on its OWN (yet unjointed) island, then weld it to a fresh awake body -- box3d wakes the
		// sleeping one as a side effect of creating the joint, per b3LinkJoint. Cover that the destroy
		// path still tolerates whatever sleep state results.
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		try {
			const a = box( world, BodyType.Dynamic, { x: 0, y: 5, z: 0 } );
			const b = box( world, BodyType.Dynamic, { x: 0, y: 4, z: 0 } );
			for ( let i = 0; i < 3; i++ ) world.step( 1 / 60, 4 );
			b.setAwake( false );

			const joint = weld( world, a, b );
			expect( () => joint.destroy( false ) ).not.toThrow();
			world.step( 1 / 60, 4 );
			expect( world.isValid() ).toBe( true );
		} finally {
			world.destroy();
		}
	} );

	it( "destroy(false): dynamic body asleep, weld to a STATIC body -- must not throw (buildings weld to static footings)", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		try {
			const footing = box( world, BodyType.Static, { x: 0, y: 0, z: 0 } );
			const post = box( world, BodyType.Dynamic, { x: 0, y: 1, z: 0 } );
			const joint = weld( world, post, footing );
			post.setAwake( false );
			expect( post.isAwake() ).toBe( false );

			expect( () => joint.destroy( false ) ).not.toThrow();
			world.step( 1 / 60, 4 );
			expect( world.isValid() ).toBe( true );
		} finally {
			world.destroy();
		}
	} );

	it( "destroy(true) on sleeping bodies -- already-correct usage, still fine", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		try {
			const a = box( world, BodyType.Dynamic, { x: 0, y: 5, z: 0 } );
			const b = box( world, BodyType.Dynamic, { x: 0, y: 4, z: 0 } );
			const joint = weld( world, a, b );
			a.setAwake( false );
			b.setAwake( false );

			joint.destroy( true );
			expect( a.isAwake() ).toBe( true );
			expect( b.isAwake() ).toBe( true );
			world.step( 1 / 60, 4 );
			expect( world.isValid() ).toBe( true );
		} finally {
			world.destroy();
		}
	} );

	it( "destroy(false) on AWAKE bodies is left alone (no gratuitous wake)", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		try {
			const a = box( world, BodyType.Dynamic, { x: 0, y: 5, z: 0 } );
			const b = box( world, BodyType.Dynamic, { x: 0, y: 4, z: 0 } );
			const joint = weld( world, a, b );
			expect( a.isAwake() ).toBe( true );
			expect( b.isAwake() ).toBe( true );

			joint.destroy( false );
			// Neither body was asleep, so the binding must not have forced a wake either -- there's
			// nothing externally observable to distinguish "no-op wake" from "already awake" here
			// beyond "didn't throw and the world stays usable", which the destroy(false)-on-awake path
			// already exercises via tests/weld-force.test.ts. This case just guards the "no gratuitous
			// wake" claim doesn't regress into always forcing wakeAttached=true unconditionally.
			world.step( 1 / 60, 4 );
			expect( world.isValid() ).toBe( true );
		} finally {
			world.destroy();
		}
	} );

	it( "reset-loop stress: many sleeping joints on a shared island, repeated destroy(false)+recreate (structures.ts's actual access pattern)", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		try {
			const footing = box( world, BodyType.Static, { x: 0, y: 0, z: 0 } );
			const POST_COUNT = 8;
			const records: { a: Body; b: Body; joint: WeldJoint | null }[] = [];

			for ( let i = 0; i < POST_COUNT; i++ ) {
				const post = box( world, BodyType.Dynamic, { x: i * 2, y: 1, z: 0 } );
				records.push( { a: post, b: footing, joint: weld( world, post, footing ) } );
				for ( const h of [1, 2] ) {
					const rail = box( world, BodyType.Dynamic, { x: i * 2, y: h, z: 0 } );
					records.push( { a: rail, b: post, joint: weld( world, rail, post ) } );
				}
			}

			for ( const r of records ) r.a.setAwake( false );

			for ( let pass = 0; pass < 2; pass++ ) {
				for ( const r of records ) {
					expect( () => r.joint!.destroy( false ) ).not.toThrow();
					r.joint = weld( world, r.a, r.b );
				}
			}

			world.step( 1 / 60, 4 );
			expect( world.isValid() ).toBe( true );
		} finally {
			world.destroy();
		}
	} );
} );
