// SPDX-License-Identifier: MIT
//
// Smoke tests for the runtime setters the engine coverage audit flagged as absent-at-runtime (only
// creation-time equivalents existed): Body_SetBullet (box3d.h:708), Body_SetGravityScale
// (box3d.h:666), and the mesh/height-field per-triangle material accessors
// (Shape_GetMeshMaterialCount/SetMeshMaterial/GetMeshSurfaceMaterial, box3d.h:885 family). Shape
// friction/restitution/surface-material runtime setters get their own dedicated physical-effect
// coverage in tests/surface-material.test.ts; this file just checks each setter/getter round-trips
// and (where cheap) has the expected physical effect.

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "runtime setters smoke test", () => {
	it( "Body.setBullet()/isBullet() round-trips", async () => {
		const native: Native = await loadNative();
		const world = new World( native );
		try {
			const body = world.createBody( { type: BodyType.Dynamic } );
			body.createBoxShape();

			expect( body.isBullet() ).toBe( false ); // BodyOptions.isBullet defaults false
			body.setBullet( true );
			expect( body.isBullet() ).toBe( true );
			body.setBullet( false );
			expect( body.isBullet() ).toBe( false );
		} finally {
			world.destroy();
		}
	} );

	it( "Body.setGravityScale()/getGravityScale() round-trips and changes fall behavior", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );
		try {
			// enableSleep:false -- this test wants gravityScale's effect isolated from sleep state (a
			// body sitting motionless under gravityScale=0 would otherwise fall asleep and not resume
			// falling until woken, which is a separate mechanism from the setter under test here).
			const body = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 10, z: 0 },
				enableSleep: false } );
			body.createBoxShape();

			expect( body.getGravityScale() ).toBeCloseTo( 1, 5 ); // BodyOptions.gravityScale defaults 1
			body.setGravityScale( 0 );
			expect( body.getGravityScale() ).toBeCloseTo( 0, 5 );

			const startY = body.getPosition().y;
			for ( let i = 0; i < 60; i++ ) world.step( 1 / 60, 4 );
			const afterZeroGravityY = body.getPosition().y;
			expect( afterZeroGravityY ).toBeCloseTo( startY, 3 ); // no fall with gravityScale 0

			body.setGravityScale( 3 );
			expect( body.getGravityScale() ).toBeCloseTo( 3, 5 );
			for ( let i = 0; i < 30; i++ ) world.step( 1 / 60, 4 );
			expect( body.getPosition().y ).toBeLessThan( afterZeroGravityY ); // now falls again
		} finally {
			world.destroy();
		}
	} );

	it( "Shape.setFriction()/getFriction() and setRestitution()/getRestitution() round-trip", async () => {
		const native: Native = await loadNative();
		const world = new World( native );
		try {
			const body = world.createBody( { type: BodyType.Static } );
			const shape = body.createBoxShape( { friction: 0.6, restitution: 0 } );

			shape.setFriction( 0.25 );
			expect( shape.getFriction() ).toBeCloseTo( 0.25, 5 );

			shape.setRestitution( 0.75 );
			expect( shape.getRestitution() ).toBeCloseTo( 0.75, 5 );
		} finally {
			world.destroy();
		}
	} );

	it( "Shape.getMeshMaterialCount()/setMeshMaterial()/getMeshSurfaceMaterial() work on an ordinary (single-material) shape", async () => {
		const native: Native = await loadNative();
		const world = new World( native );
		try {
			const body = world.createBody( { type: BodyType.Static } );
			const shape = body.createBoxShape( { friction: 0.6 } );

			// Every shape has materialCount === 1 by default (index 0 aliases the base material) --
			// see b3js_Shape_GetMeshMaterialCount's doc comment, src/wasm-shim/binding.c.
			expect( shape.getMeshMaterialCount() ).toBe( 1 );

			shape.setMeshMaterial( 0, {
				friction: 0.33, restitution: 0.11, rollingResistance: 0.02,
				tangentVelocity: { x: 0, y: 0, z: 2 }, userMaterialId: 99n,
			} );
			const m = shape.getMeshSurfaceMaterial( 0 );
			expect( m.friction ).toBeCloseTo( 0.33, 5 );
			expect( m.restitution ).toBeCloseTo( 0.11, 5 );
			expect( m.rollingResistance ).toBeCloseTo( 0.02, 5 );
			expect( m.tangentVelocity.z ).toBeCloseTo( 2, 5 );
			expect( m.userMaterialId ).toBe( 99n );

			// setMeshMaterial writes the same underlying slot as the base material -- confirm the
			// two views agree.
			expect( shape.getSurfaceMaterial().friction ).toBeCloseTo( 0.33, 5 );
		} finally {
			world.destroy();
		}
	} );

	it( "createMeshShape with a per-triangle materials array creates a shape with materialCount === materials.length", async () => {
		const native: Native = await loadNative();
		const world = new World( native );
		try {
			const body = world.createBody( { type: BodyType.Static } );
			// A flat two-triangle quad (4 verts), one material per triangle.
			const vertices = new Float32Array( [
				-1, 0, -1,
				1, 0, -1,
				1, 0, 1,
				-1, 0, 1,
			] );
			const indices = new Int32Array( [0, 1, 2, 0, 2, 3] );
			const materialIndices = new Uint8Array( [0, 1] );

			const shape = body.createMeshShape( vertices, indices, { x: 1, y: 1, z: 1 }, {
				materials: [
					{ friction: 0.2, restitution: 0, rollingResistance: 0 },
					{ friction: 0.9, restitution: 0, rollingResistance: 0 },
				],
				materialIndices,
			} );

			expect( shape.getMeshMaterialCount() ).toBe( 2 );
			expect( shape.getMeshSurfaceMaterial( 0 ).friction ).toBeCloseTo( 0.2, 5 );
			expect( shape.getMeshSurfaceMaterial( 1 ).friction ).toBeCloseTo( 0.9, 5 );
		} finally {
			world.destroy();
		}
	} );
} );
