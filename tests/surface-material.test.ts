// SPDX-License-Identifier: MIT
//
// Runtime surface-material setters (box3d.h:864/870/876) -- previously only settable at shape
// creation via ShapeDef.baseMaterial; nothing let a caller change friction/restitution/
// rollingResistance/tangentVelocity/userMaterialId on a shape that already exists (e.g. a mid-session
// wet-road/ice grip change, or a "heat up" tire model). Both the direct Shape.setFriction() and the
// full Shape.setSurfaceMaterial()/getSurfaceMaterial() round trip are exercised here.

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

const DT = 1 / 60;
const SUBSTEPS = 4;

describe( "runtime surface-material changes", () => {
	it( "raising a shape's friction mid-slide shortens how far it slides", async () => {
		const native: Native = await loadNative();

		function runSlide( bumpFrictionAtSeconds: number | null ): number {
			const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
			try {
				const floor = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
				floor.createBoxShape( { halfExtents: { x: 100, y: 0.5, z: 5 }, friction: 0.9 } );

				const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 0.6, z: 0 } } );
				const shape = box.createBoxShape( {
					halfExtents: { x: 0.5, y: 0.5, z: 0.5 }, friction: 0.05, restitution: 0,
				} );
				box.setLinearVelocity( { x: 5, y: 0, z: 0 } );

				const startX = box.getPosition().x;
				const totalSeconds = 3;
				const steps = Math.round( totalSeconds / DT );
				let bumped = false;
				for ( let i = 0; i < steps; i++ ) {
					world.step( DT, SUBSTEPS );
					const t = i * DT;
					if ( bumpFrictionAtSeconds !== null && !bumped && t >= bumpFrictionAtSeconds ) {
						shape.setFriction( 0.9 );
						expect( shape.getFriction() ).toBeCloseTo( 0.9, 5 );
						bumped = true;
					}
				}
				return box.getPosition().x - startX;
			} finally {
				world.destroy();
			}
		}

		const distanceLowThroughout = runSlide( null );
		const distanceBumpedMidSlide = runSlide( 0.5 );

		console.log( `[surface-material friction] low-throughout=${ distanceLowThroughout.toFixed( 3 ) }m bumped-mid-slide=${ distanceBumpedMidSlide.toFixed( 3 ) }m` );

		expect( distanceLowThroughout ).toBeGreaterThan( 1 );
		expect( distanceBumpedMidSlide ).toBeGreaterThan( 0 );
		expect( distanceBumpedMidSlide ).toBeLessThan( distanceLowThroughout * 0.7 );
	} );

	it( "raising a capsule's rollingResistance mid-roll (via setSurfaceMaterial) shortens its spin-down time", async () => {
		const native: Native = await loadNative();

		function rollThenMeasureSpin( bumpAtSeconds: number | null ): number {
			const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
			try {
				const floor = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
				floor.createBoxShape( { halfExtents: { x: 100, y: 0.5, z: 5 }, friction: 0.9 } );

				const cap = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 0.75, z: 0 } } );
				const shape = cap.createCapsuleShape( {
					center1: { x: -0.5, y: 0, z: 0 }, center2: { x: 0.5, y: 0, z: 0 }, radius: 0.25,
					friction: 0.9, restitution: 0, rollingResistance: 0,
				} );
				cap.setAngularVelocity( { x: 12, y: 0, z: 0 } );

				const totalSeconds = 4;
				const steps = Math.round( totalSeconds / DT );
				let bumped = false;
				for ( let i = 0; i < steps; i++ ) {
					world.step( DT, SUBSTEPS );
					const t = i * DT;
					if ( bumpAtSeconds !== null && !bumped && t >= bumpAtSeconds ) {
						const material = shape.getSurfaceMaterial();
						expect( material.rollingResistance ).toBeCloseTo( 0, 5 );
						shape.setSurfaceMaterial( { ...material, rollingResistance: 0.6 } );
						expect( shape.getSurfaceMaterial().rollingResistance ).toBeCloseTo( 0.6, 5 );
						bumped = true;
					}
				}
				const w = cap.getAngularVelocity();
				return Math.hypot( w.x, w.y, w.z );
			} finally {
				world.destroy();
			}
		}

		const freeSpin = rollThenMeasureSpin( null );
		const bumpedSpin = rollThenMeasureSpin( 1 );

		console.log( `[surface-material rollingResistance] freeSpin(4s)=${ freeSpin.toFixed( 2 ) } rad/s | bumped-mid-roll=${ bumpedSpin.toFixed( 2 ) } rad/s` );

		expect( freeSpin ).toBeGreaterThan( 2 );
		expect( bumpedSpin ).toBeLessThan( freeSpin * 0.5 );
	} );

	it( "setSurfaceMaterial()/getSurfaceMaterial() round-trips tangentVelocity and userMaterialId without disturbing friction/restitution", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const body = world.createBody( { type: BodyType.Static } );
			const shape = body.createBoxShape( { halfExtents: { x: 1, y: 1, z: 1 }, friction: 0.4, restitution: 0.2 } );

			shape.setSurfaceMaterial( {
				friction: 0.4, restitution: 0.2, rollingResistance: 0,
				tangentVelocity: { x: 3, y: 0, z: -1.5 },
				userMaterialId: 4242n,
			} );

			const m = shape.getSurfaceMaterial();
			expect( m.friction ).toBeCloseTo( 0.4, 5 );
			expect( m.restitution ).toBeCloseTo( 0.2, 5 );
			expect( m.tangentVelocity.x ).toBeCloseTo( 3, 5 );
			expect( m.tangentVelocity.y ).toBeCloseTo( 0, 5 );
			expect( m.tangentVelocity.z ).toBeCloseTo( -1.5, 5 );
			expect( m.userMaterialId ).toBe( 4242n );
		} finally {
			world.destroy();
		}
	} );
} );
