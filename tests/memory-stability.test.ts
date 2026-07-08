// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BodyType, World, liveHandleCount, type Native } from "../src/ts/index.js";
import { loadNative } from "./helpers.js";

describe( "memory stability", () => {
	it( "a create/destroy loop does not grow the wasm heap unboundedly after warmup", async () => {
		const native: Native = await loadNative();

		const ITERATIONS = 220;
		const WARMUP_ITERATIONS = 20;
		const BODIES_PER_WORLD = 20;
		const STEPS_PER_WORLD = 10;
		const dt = 1 / 60;

		const heapByteLengthsAfterWarmup: number[] = [];

		for ( let iter = 0; iter < ITERATIONS; iter++ ) {
			const world = new World( native, { gravity: { x: 0, y: -10, z: 0 } } );

			for ( let b = 0; b < BODIES_PER_WORLD; b++ ) {
				const body = world.createBody( {
					type: BodyType.Dynamic,
					position: { x: ( b % 5 ) * 2, y: 5 + Math.floor( b / 5 ), z: 0 },
				} );
				if ( b % 2 === 0 ) {
					body.createBoxShape( { halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } );
				} else {
					body.createSphereShape( { radius: 0.5 } );
				}
			}

			for ( let s = 0; s < STEPS_PER_WORLD; s++ ) {
				world.step( dt, 4 );
			}

			world.destroy();

			if ( iter >= WARMUP_ITERATIONS ) {
				heapByteLengthsAfterWarmup.push( native.HEAPU8.byteLength );
			}
		}

		// Every body/shape created above was destroyed transitively by world.destroy() -- the
		// live-handle registry (tests/../src/ts/registry.ts) should be back to a clean slate.
		expect( liveHandleCount() ).toBe( 0 );

		// The wasm heap (Module.HEAPU8.byteLength, i.e. linear memory size) must stop growing once
		// the shim's per-world event buffers (see src/wasm-shim/binding.c) have converged to a stable
		// capacity -- see docs/loom/P1-binding-design.md's memory-stability test hook.
		const firstAfterWarmup = heapByteLengthsAfterWarmup[0];
		const maxAfterWarmup = Math.max( ...heapByteLengthsAfterWarmup );
		const lastAfterWarmup = heapByteLengthsAfterWarmup[heapByteLengthsAfterWarmup.length - 1];

		expect( maxAfterWarmup ).toBe( firstAfterWarmup );
		expect( lastAfterWarmup ).toBe( firstAfterWarmup );
	} );
} );
