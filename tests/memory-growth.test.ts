// SPDX-License-Identifier: MIT
//
// Regression test for the playtest BLOCKER: a permanent wasm "memory access out of bounds" trap that
// recurred in 10/16 soak cycles (game/verify/playtest/soak-results.json). The investigation's
// Hypothesis #1 was that -sALLOW_MEMORY_GROWTH=1 (scripts/wasm/CMakeLists.txt) detaches every
// TypedArray view built over the wasm heap's ArrayBuffer on growth (confirmed empirically: this
// Node runtime's WebAssembly.Memory has no toResizableBuffer(), so Emscripten's growMemory() really
// does replace Module.HEAPU8.buffer with a brand-new ArrayBuffer object -- see build/wasm/box3d.mjs's
// updateMemoryViews()/growMemory()). Auditing src/ts (native.ts/scratch.ts/events.ts/body.ts/world.ts)
// found every heap access already re-derives `native.HEAPF32`/`native.HEAPU32` fresh at call time
// (never destructured/cached into a module- or object-level variable that would go stale), so this
// binding layer was ALREADY safe against that failure mode. This test locks that invariant in: force
// real heap growth (buffer identity change) mid-session via a burst of _malloc calls, then assert
// getTransform() and both event-cursor views (moveEvents/hitEvents) still work correctly afterward.
//
// (The actual root cause of the recurring trap turned out to be Hypothesis #2 -- game/src/main.ts's
// per-frame panel-visual sync loop called Body.getTransform() on a panel body the damage system had
// just despawned/destroyed that same step; fixed there, not in this binding. This test guards the
// growth-safety property regardless.)

import { describe, expect, it } from "vitest";
import { BodyType, World, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "memory growth safety", () => {
	it( "getTransform() and event cursors keep working after the wasm heap grows (buffer identity changes)",
		async () => {
			const native: Native = await loadNative();
			const world = new World( native, { gravity: { x: 0, y: -10, z: 0 }, hitEventThreshold: 0.1 } );

			try {
				const ground = world.createBody( { type: BodyType.Static, position: { x: 0, y: 0, z: 0 },
					userData: 1 } );
				ground.createBoxShape( { halfExtents: { x: 10, y: 0.5, z: 10 }, enableHitEvents: true, userData: 1 } );

				const box = world.createBody( { type: BodyType.Dynamic, position: { x: 0, y: 5, z: 0 },
					userData: 2 } );
				box.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 }, enableHitEvents: true, userData: 2 } );

				const dt = 1 / 60;
				for ( let i = 0; i < 5; i++ ) world.step( dt, 4 );

				const beforeBuffer = native.HEAPU8.buffer;
				const transformBeforeGrowth = box.getTransform();
				expect( Number.isFinite( transformBeforeGrowth.position.y ) ).toBe( true );

				// Force real heap growth (mirrors the QA brief: "allocate via repeated ... _malloc in a
				// loop until buffer identity changes"). 1MiB chunks, held open (not freed) until the
				// underlying ArrayBuffer object is actually replaced.
				const ptrs: number[] = [];
				let grew = false;
				for ( let i = 0; i < 4000 && !grew; i++ ) {
					ptrs.push( native._malloc( 1024 * 1024 ) );
					if ( native.HEAPU8.buffer !== beforeBuffer ) grew = true;
				}

				// This environment (plain Node, no resizable-ArrayBuffer support) MUST hit the classical
				// grow-and-replace path -- if it didn't, the rest of this test wouldn't be exercising
				// anything, so fail loudly rather than silently passing on a no-op.
				expect( grew ).toBe( true );
				expect( native.HEAPU8.buffer ).not.toBe( beforeBuffer );

				// ---- getTransform() must read the NEW buffer correctly, not a detached old view. ----
				world.step( dt, 4 );
				const transformAfterGrowth = box.getTransform();
				expect( Number.isFinite( transformAfterGrowth.position.y ) ).toBe( true );
				expect( transformAfterGrowth.position.y ).toBeLessThan( transformBeforeGrowth.position.y );

				// ---- Event cursors (the zero-allocation views over the shim's event buffers) must also
				// still resolve correctly post-growth. ----
				let sawMoveEvent = false;
				for ( let i = 0; i < 60 && !sawMoveEvent; i++ ) {
					world.step( dt, 4 );
					const moves = world.moveEvents();
					for ( let j = 0; j < moves.count; j++ ) {
						const m = moves.at( j );
						if ( m.userData === 2 ) {
							sawMoveEvent = true;
							expect( Number.isFinite( m.position.y ) ).toBe( true );
							const qLen = Math.sqrt( m.rotation.x ** 2 + m.rotation.y ** 2 + m.rotation.z ** 2 + m.rotation.w ** 2 );
							expect( qLen ).toBeGreaterThan( 0.99 );
							expect( qLen ).toBeLessThan( 1.01 );
						}
					}
				}
				expect( sawMoveEvent ).toBe( true );

				// Drive the box down onto the ground to also exercise hitEvents() post-growth.
				let sawHitEvent = false;
				for ( let i = 0; i < 180 && !sawHitEvent; i++ ) {
					world.step( dt, 4 );
					const hits = world.hitEvents();
					if ( hits.count > 0 ) {
						const hit = hits.at( 0 );
						sawHitEvent = true;
						expect( Number.isFinite( hit.approachSpeed ) ).toBe( true );
						expect( Number.isFinite( hit.point.y ) ).toBe( true );
					}
				}
				expect( sawHitEvent ).toBe( true );

				for ( const p of ptrs ) native._free( p );
			} finally {
				world.destroy();
			}
		} );
} );
