// SPDX-License-Identifier: MIT
//
// Shared test helper: loads the compiled wasm module once and caches it (loading is the only async
// step in the whole binding -- see src/ts/native.ts -- and there's no reason to redo it per test).
//
// Requires `scripts/build-wasm.sh` to have been run first (build/wasm/box3d.mjs must exist).

import { init, type Native } from "../src/ts/index.js";

let cached: Promise<Native> | null = null;

export function loadNative(): Promise<Native> {
	if ( cached === null ) {
		cached = init();
	}
	return cached;
}
