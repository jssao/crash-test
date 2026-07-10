// SPDX-License-Identifier: MIT
//
// Sensor events (b3World_GetSensorEvents + b3Shape_EnableSensorEvents, box3d.h) -- previously
// entirely unwired. Poll-free occupant-in-seat / checkpoint / trigger-volume detection: a begin event
// when a shape starts overlapping a sensor shape, an end event when it stops.

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "sensor events", () => {
	it( "reports a begin event when a body enters a sensor volume, then an end event when it exits", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const sensorEntityId = 100;
			const visitorEntityId = 200;

			const sensorBody = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 },
				userData: sensorEntityId } );
			const sensorShape = sensorBody.createBoxShape( {
				halfExtents: { x: 2, y: 2, z: 2 },
				isSensor: true,
				userData: sensorEntityId,
			} );
			sensorShape.enableSensorEvents( true );
			expect( sensorShape.isSensorEventsEnabled() ).toBe( true );

			const visitor = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 10, z: 0 },
				userData: visitorEntityId } );
			const visitorShape = visitor.createSphereShape( { radius: 0.3, userData: visitorEntityId } );
			// Per this test's own empirical finding: enabling sensor events on the sensor shape ALONE is
			// not enough -- the visitor shape must also opt in (matching b3ShapeDef.enableSensorEvents's
			// doc comment, types.h: "This applies to sensors and non-sensors").
			visitorShape.enableSensorEvents( true );

			const dt = 1 / 60;

			let sawBegin = false;
			let beginEntities: [number, number] = [0, 0];
			for ( let i = 0; i < 240 && !sawBegin; i++ ) {
				world.step( dt, 4 );
				const begins = world.sensorBeginEvents();
				if ( begins.count > 0 ) {
					sawBegin = true;
					const ev = begins.at( 0 );
					beginEntities = [ev.sensorUserData, ev.visitorUserData];
				}
			}

			expect( sawBegin ).toBe( true );
			expect( beginEntities[0] ).toBe( sensorEntityId );
			expect( beginEntities[1] ).toBe( visitorEntityId );

			// Falling straight through the sensor box (no ground below it in this test) -- keep
			// stepping until it exits the far side and an end event fires.
			let sawEnd = false;
			let endEntities: [number, number] = [0, 0];
			for ( let i = 0; i < 240 && !sawEnd; i++ ) {
				world.step( dt, 4 );
				const ends = world.sensorEndEvents();
				if ( ends.count > 0 ) {
					sawEnd = true;
					const ev = ends.at( 0 );
					endEntities = [ev.sensorUserData, ev.visitorUserData];
				}
			}

			expect( sawEnd ).toBe( true );
			expect( endEntities[0] ).toBe( sensorEntityId );
			expect( endEntities[1] ).toBe( visitorEntityId );
		} finally {
			world.destroy();
		}
	} );

	it( "reports nothing when the sensor shape never has enableSensorEvents(true) called", async () => {
		const native: Native = await loadNative();
		const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

		try {
			const sensorBody = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 } } );
			const sensorShape = sensorBody.createBoxShape( { halfExtents: { x: 2, y: 2, z: 2 }, isSensor: true } );
			expect( sensorShape.isSensorEventsEnabled() ).toBe( false ); // disabled by default, even for sensors

			const visitor = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 10, z: 0 } } );
			visitor.createSphereShape( { radius: 0.3 } );

			const dt = 1 / 60;
			let sawAny = false;
			for ( let i = 0; i < 240; i++ ) {
				world.step( dt, 4 );
				if ( world.sensorBeginEvents().count > 0 || world.sensorEndEvents().count > 0 ) {
					sawAny = true;
				}
			}

			expect( sawAny ).toBe( false );
		} finally {
			world.destroy();
		}
	} );
} );
