// SPDX-License-Identifier: MIT
//
// Helpers for calling shim functions that write results through an out-pointer, or that read an
// input array from the wasm heap.
//
// These allocate a small scratch buffer *per call* (malloc immediately before the native call, free
// immediately after). That is deliberately not the zero-allocation path -- see
// src/wasm-shim/binding.c's module doc and world.ts's moveEvents()/hitEvents(): the design's
// zero-allocation requirement targets the *event* hot path (draining potentially many events per
// step), not one-off getters like Body.getTransform(). A malloc/free pair per getter call is simple,
// always correct (no shared mutable state to reason about across reentrant calls), and cheap enough
// for anything that isn't the per-step event drain -- which is exactly why box3d-js recommends
// world.moveEvents() over per-body polling for the hot loop.

import type { Native } from "./native.js";

/** Calls `fn(ptr)` with a freshly malloc'd `floatCount`-float buffer, reads the result, then frees it. */
export function withFloatOutBuffer<T>( native: Native, floatCount: number, fn: ( ptr: number ) => void,
	read: ( heap: Float32Array, index0: number ) => T ): T {
	const ptr = native._malloc( floatCount * 4 );
	try {
		fn( ptr );
		return read( native.HEAPF32, ptr >> 2 );
	} finally {
		native._free( ptr );
	}
}

/** Copies `data` into a freshly malloc'd float buffer, calls `fn(ptr)`, then frees it. */
export function withInputFloatBuffer<T>( native: Native, data: ArrayLike<number>, fn: ( ptr: number ) => T ): T {
	const byteLength = data.length * 4;
	const ptr = native._malloc( byteLength );
	try {
		native.HEAPF32.set( data, ptr >> 2 );
		return fn( ptr );
	} finally {
		native._free( ptr );
	}
}

/** Copies `data` into a freshly malloc'd int32 buffer, calls `fn(ptr)`, then frees it. */
export function withInputInt32Buffer<T>( native: Native, data: ArrayLike<number>, fn: ( ptr: number ) => T ): T {
	const byteLength = data.length * 4;
	const ptr = native._malloc( byteLength );
	try {
		native.HEAP32.set( data, ptr >> 2 );
		return fn( ptr );
	} finally {
		native._free( ptr );
	}
}

/** Copies `data` into a freshly malloc'd uint8 buffer, calls `fn(ptr)`, then frees it. Used for the
 * per-triangle/per-cell material index arrays (see Body.createMeshShape/createHeightFieldShape). */
export function withInputUint8Buffer<T>( native: Native, data: ArrayLike<number>, fn: ( ptr: number ) => T ): T {
	const byteLength = data.length;
	const ptr = native._malloc( byteLength );
	try {
		native.HEAPU8.set( data, ptr );
		return fn( ptr );
	} finally {
		native._free( ptr );
	}
}
