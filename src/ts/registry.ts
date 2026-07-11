// SPDX-License-Identifier: MIT
//
// Module-level live-handle registry. Every World/Body/Shape/Joint registers its native handle here
// on construction and unregisters it on destroy(). This gives us two things cheaply:
//
//  1. Double-destroy guards: destroy() consults the registry and throws instead of calling the
//     native destroy function twice on a handle that may since have been recycled by Box3D for an
//     unrelated object (handles are pool-allocated and reused, so a stale double-free is not just a
//     no-op -- it can corrupt a *different*, currently-live object).
//  2. An introspectable live-object count for leak tests (see tests/memory-stability.test.ts):
//     liveHandleCount() should return to (near) zero after a create/step/destroy loop, independent
//     of what the wasm heap byte length is doing.

export type HandleKind = "world" | "body" | "shape" | "joint";

// Keyed by "kind:handle", NOT by handle alone: b3BodyId/b3ShapeId/b3JointId are independently
// pool-allocated *within the same world* but share an identical {index1, world0, generation}
// packing scheme (see vendor/box3d/include/box3d/id.h + src/wasm-shim/binding.c's pack helpers) --
// so a body's handle and a shape's handle can (and typically do) collide numerically, e.g. the
// first body and first shape created in a world both pack to the same uint64. The `kind` prefix is
// what actually disambiguates them.
const registry = new Map<string, HandleKind>();

function registryKey( handle: bigint, kind: HandleKind ): string {
	return `${ kind }:${ handle }`;
}

export function registerHandle( handle: bigint, kind: HandleKind ): void {
	const key = registryKey( handle, kind );
	if ( registry.has( key ) ) {
		throw new Error( `box3d-js: handle ${ handle } (${ kind }) is already registered -- double create?` );
	}
	registry.set( key, kind );
}

/** Removes `handle` from the registry, asserting it was live and of the expected kind. */
export function unregisterHandle( handle: bigint, kind: HandleKind ): void {
	const key = registryKey( handle, kind );
	if ( !registry.has( key ) ) {
		throw new Error( `box3d-js: ${ kind } handle ${ handle } was already destroyed (double destroy?)` );
	}
	registry.delete( key );
}

/**
 * Removes `handle` from the registry without asserting anything -- used when a parent object
 * (a World) is destroyed and, as a consequence, implicitly invalidates children (its bodies,
 * shapes, joints) that box3d itself frees. The children's own destroy() must never fire in that
 * case (their native handles are already gone), so World.destroy() calls this directly instead of
 * unregisterHandle().
 */
export function forgetHandle( handle: bigint, kind: HandleKind ): void {
	registry.delete( registryKey( handle, kind ) );
}

export function isHandleLive( handle: bigint, kind: HandleKind ): boolean {
	return registry.has( registryKey( handle, kind ) );
}

/** Total number of currently-live (not yet destroyed) handles across all kinds. Used by tests. */
export function liveHandleCount(): number {
	return registry.size;
}

/** @internal test-only escape hatch. */
/** TEST/DIAG HOOK: snapshot of live registry keys ("kind:handle") -- pairs with
 * _clearRegistryForTests() for leak attribution (diff two snapshots to see WHAT leaked). */
export function _registrySnapshotForTests(): string[] {
	return [ ...registry.keys() ];
}

export function _clearRegistryForTests(): void {
	registry.clear();
}
