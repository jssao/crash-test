// SPDX-License-Identifier: MIT
//
// b3World_Explode (box3d.h) -- a radial, area-aware impulse to spheres/capsules/hulls near a point.
// Previously entirely unwired. The impulse is applied synchronously inside b3World_Explode itself
// (see vendor/box3d/src/physics_world.c's ExplosionCallback -- it writes state->linearVelocity
// directly), so it's readable immediately after world.explode(), no world.step() required.
//
// Falloff math (same source): within `radius` the scale factor is a constant 1 (full strength,
// independent of exact distance); from `radius` out to `radius+falloff` it ramps linearly to 0;
// beyond `radius+falloff` a shape feels nothing. This test places two rings of identical spheres
// entirely within the linear falloff band so "farther = less" is a real, monotonic effect rather
// than a coincidence of the constant-strength zone.

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "world.explode (radial explosion)", () => {
	it( "pushes a ring of dynamic spheres outward from the explosion center, with farther shapes gaining less speed", async () => {
		const native: Native = await loadNative();
		// Zero gravity to isolate the explosion impulse from anything else.
		const world = new World( native, { gravity: { x: 0, y: 0, z: 0 } } );

		try {
			const sphereRadius = 0.3;
			const angles = [0, Math.PI / 2, Math.PI, ( 3 * Math.PI ) / 2];
			const nearDistance = 2;
			const farDistance = 5;

			function makeRing( distance: number ) {
				return angles.map( ( angle ) => {
					const x = distance * Math.cos( angle );
					const z = distance * Math.sin( angle );
					const body = world.createBody( { type: BodyType.Dynamic, position: { x, y: 0, z } } );
					body.createSphereShape( { radius: sphereRadius } );
					return body;
				} );
			}

			const nearBodies = makeRing( nearDistance );
			const farBodies = makeRing( farDistance );

			// radius=1 (constant-strength core), falloff=7 -> effect reaches out to radius+falloff=8,
			// so both rings (distance 2 and 5) sit inside the linear falloff band.
			world.explode( { position: { x: 0, y: 0, z: 0 }, radius: 1, falloff: 7, impulsePerArea: 100 } );

			function measure( bodies: typeof nearBodies ) {
				return bodies.map( ( body ) => {
					const pos = body.getPosition();
					const v = body.getLinearVelocity();
					const speed = Math.hypot( v.x, v.y, v.z );
					const radialLen = Math.hypot( pos.x, pos.y, pos.z ) || 1;
					// Component of velocity along the outward radial direction, normalized by speed --
					// ~1 means the push is (as expected) almost purely radial.
					const outwardFraction = speed > 0 ?
						( v.x * pos.x + v.y * pos.y + v.z * pos.z ) / radialLen / speed : 0;
					return { speed, outwardFraction };
				} );
			}

			const near = measure( nearBodies );
			const far = measure( farBodies );

			for ( const { speed, outwardFraction } of [...near, ...far] ) {
				expect( speed ).toBeGreaterThan( 0.01 );
				expect( outwardFraction ).toBeGreaterThan( 0.95 );
			}

			const avgNearSpeed = near.reduce( ( a, b ) => a + b.speed, 0 ) / near.length;
			const avgFarSpeed = far.reduce( ( a, b ) => a + b.speed, 0 ) / far.length;
			console.log( `[explode] avg near(d=${ nearDistance }) speed=${ avgNearSpeed.toFixed( 4 ) } | avg far(d=${ farDistance }) speed=${ avgFarSpeed.toFixed( 4 ) }` );

			expect( avgFarSpeed ).toBeLessThan( avgNearSpeed * 0.75 );
		} finally {
			world.destroy();
		}
	} );

	it( "shapes beyond radius+falloff feel no impulse", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: 0, z: 0 } } );

		try {
			const body = world.createBody( { type: BodyType.Dynamic, position: { x: 20, y: 0, z: 0 } } );
			body.createSphereShape( { radius: 0.3 } );

			world.explode( { position: { x: 0, y: 0, z: 0 }, radius: 1, falloff: 2, impulsePerArea: 100 } );

			const v = body.getLinearVelocity();
			expect( Math.hypot( v.x, v.y, v.z ) ).toBe( 0 );
		} finally {
			world.destroy();
		}
	} );
} );
