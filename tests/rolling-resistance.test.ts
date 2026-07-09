// SPDX-License-Identifier: MIT
//
// "Debris must settle" regression (game playtest issue #1: freed debris kept spinning/rolling "ages
// after it should settle"). Two independent mechanisms are exercised here, because box3d's per-shape
// `rollingResistance` field is documented as applying ONLY to spheres and capsules
// (vendor/box3d/include/box3d/types.h:407 -- "This is only used for spheres and capsules"), so it
// cannot help the box/hull debris that makes up most of a wrecked structure:
//
//   1. rollingResistance on a CAPSULE (already wired end-to-end: shape.ts's ShapeOptions ->
//      body.ts -> binding.c's def->baseMaterial.rollingResistance). A capsule rolling on its side
//      comes to rest quickly WITH it and rolls ~forever WITHOUT it.
//   2. angular DAMPING on a BOX body (the game-side fallback for boxes/hulls, applied at spawn via
//      BodyOptions.angularDamping -- b3DefaultBodyDef()'s field, wired through createBody()). A box
//      spun about its vertical axis on the ground settles quickly WITH it, spins on WITHOUT it.
//
// Together these are what the buildings/legacy-destructible spawners now set per-material so wrecked
// debris thuds to rest instead of pirouetting indefinitely.

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

const DT = 1 / 60;
const SUBSTEPS = 4;

function makeGround( world: World ): void {
	const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
	ground.createBoxShape( { halfExtents: { x: 50, y: 0.5, z: 50 }, friction: 0.9 } );
}

/** Steps `seconds` of sim, returning the body's angular-speed magnitude at the end. */
function angularSpeedAfter( world: World, body: { getAngularVelocity(): { x: number; y: number; z: number } }, seconds: number ): number {
	const steps = Math.round( seconds / DT );
	for ( let i = 0; i < steps; i++ ) world.step( DT, SUBSTEPS );
	const w = body.getAngularVelocity();
	return Math.hypot( w.x, w.y, w.z );
}

describe( "rolling resistance / angular damping settles debris", () => {
	it( "a capsule rolling on its side comes to rest < 4s WITH rollingResistance (and keeps rolling WITHOUT)", async () => {
		const native: Native = await loadNative();

		// --- WITHOUT rolling resistance: rolls essentially forever (pure rolling dissipates ~nothing) ---
		const wNo = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		let freeRollSpeed = 0;
		try {
			makeGround( wNo );
			const cap = wNo.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 0.5 + 0.25, z: -20 } } );
			cap.createCapsuleShape( {
				center1: { x: -0.5, y: 0, z: 0 },
				center2: { x: 0.5, y: 0, z: 0 },
				radius: 0.25,
				friction: 0.9,
				restitution: 0.0,
				rollingResistance: 0,
			} );
			cap.applyMassFromShapes();
			// Spin about the capsule's long (x) axis -> it rolls along z.
			cap.setAngularVelocity( { x: 12, y: 0, z: 0 } );
			freeRollSpeed = angularSpeedAfter( wNo, cap, 4 );
		} finally {
			wNo.destroy();
		}

		// --- WITH rolling resistance: settles fast ---
		const wYes = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		let dampedSpeed = 0;
		try {
			makeGround( wYes );
			const cap = wYes.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 0.5 + 0.25, z: -20 } } );
			cap.createCapsuleShape( {
				center1: { x: -0.5, y: 0, z: 0 },
				center2: { x: 0.5, y: 0, z: 0 },
				radius: 0.25,
				friction: 0.9,
				restitution: 0.0,
				rollingResistance: 0.4,
			} );
			cap.applyMassFromShapes();
			cap.setAngularVelocity( { x: 12, y: 0, z: 0 } );
			dampedSpeed = angularSpeedAfter( wYes, cap, 4 );
		} finally {
			wYes.destroy();
		}

		console.log( `[rolling-resistance capsule] freeRoll after 4s=${freeRollSpeed.toFixed(2)} rad/s | withResistance=${dampedSpeed.toFixed(2)} rad/s` );
		// The undamped capsule is still visibly rolling (~3.9 rad/s, having rolled several metres); the
		// resisted one has essentially stopped.
		expect( freeRollSpeed ).toBeGreaterThan( 2 );
		expect( dampedSpeed ).toBeLessThan( 0.5 );
		expect( dampedSpeed ).toBeLessThan( freeRollSpeed * 0.25 );
	} );

	it( "angularDamping decays a body's spin to rest (the game-side settle mechanism for box/hull debris)", async () => {
		// Boxes/hulls get no rollingResistance (spheres/capsules only), so the game damps their spin via
		// BodyOptions.angularDamping. Isolate that mechanism airborne (gravityScale 0, no contacts) so the
		// ONLY thing acting on the spin is the damping term: undamped -> conserved forever; damped -> ~0.
		const native: Native = await loadNative();

		function spinDecay( angularDamping: number ): number {
			const w = new World( native, { gravity: { x: 0, y: 0, z: 0 } } );
			try {
				const box = w.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 5, z: 0 }, angularDamping, gravityScale: 0 } );
				box.createBoxShape( { halfExtents: { x: 0.1, y: 0.1, z: 0.1 }, density: 2000 } );
				box.applyMassFromShapes();
				box.setAngularVelocity( { x: 0, y: 10, z: 0 } );
				return angularSpeedAfter( w, box, 4 );
			} finally {
				w.destroy();
			}
		}

		const freeSpin = spinDecay( 0 );
		const damped = spinDecay( 1.5 );
		console.log( `[angular-damping box] freeSpin after 4s=${freeSpin.toFixed(2)} rad/s | withDamping=${damped.toFixed(2)} rad/s` );
		expect( freeSpin ).toBeGreaterThan( 5 ); // conserved (started at 10)
		expect( damped ).toBeLessThan( 0.5 );
	} );
} );
