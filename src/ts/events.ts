// SPDX-License-Identifier: MIT
//
// Zero-allocation event cursor views over the shim's per-world event buffers (see
// src/wasm-shim/binding.c's b3js_DrainEvents / b3jsMoveEvent / b3jsHitEvent / b3jsJointEvent).
//
// Each View wraps one (ptr, count) pair and owns exactly ONE mutable "cursor" object that `.at(i)`
// re-fills and returns on every call -- so draining `count` events allocates a single small object
// per View (not per event). Do not retain a cursor reference across `.at()` calls (or across steps):
// it is a live view into the current buffer, not a snapshot.

import type { Native } from "./native.js";

export interface MoveEventCursor {
	/** The entity id tagged on the moved body (or its shape) at creation time. */
	userData: number;
	readonly position: { x: number; y: number; z: number };
	/** {x,y,z,w} -- see math.ts's module doc for the b3Quat <-> THREE.Quaternion mapping. */
	readonly rotation: { x: number; y: number; z: number; w: number };
	fellAsleep: boolean;
}

export interface HitEventCursor {
	userDataA: number;
	userDataB: number;
	readonly point: { x: number; y: number; z: number };
	readonly normal: { x: number; y: number; z: number };
	approachSpeed: number;
	/** b3ContactHitEvent.userMaterialIdA/B (types.h), truncated to 32 bits -- see b3jsHitEvent's doc
	 * comment in src/wasm-shim/binding.c. 0 if the shape wasn't tagged with a userMaterialId. */
	userMaterialIdA: number;
	userMaterialIdB: number;
}

export interface JointEventCursor {
	userData: number;
}

/** A contact begin/end touch event -- just the two entity ids, no point/normal/speed payload (see
 * World.contactBeginEvents()/contactEndEvents()). */
export interface ContactEventCursor {
	userDataA: number;
	userDataB: number;
}

// Word (4-byte) strides -- must match the b3js*Event structs in binding.c exactly.
const MOVE_EVENT_STRIDE_WORDS = 9; // userData, px,py,pz, qx,qy,qz,qs, flags
const HIT_EVENT_STRIDE_WORDS = 11; // userDataA, userDataB, px,py,pz, nx,ny,nz, approachSpeed, materialIdA, materialIdB
const JOINT_EVENT_STRIDE_WORDS = 1; // userData
const CONTACT_EVENT_STRIDE_WORDS = 2; // userDataA, userDataB

export class MoveEventsView {
	private readonly cursor: MoveEventCursor = {
		userData: 0,
		position: { x: 0, y: 0, z: 0 },
		rotation: { x: 0, y: 0, z: 0, w: 1 },
		fellAsleep: false,
	};

	constructor( private readonly native: Native, private readonly ptr: number, readonly count: number ) {}

	/** Mutates and returns this view's single cursor object -- see the module doc above. */
	at( index: number ): MoveEventCursor {
		if ( index < 0 || index >= this.count ) {
			throw new RangeError( `move event index ${ index } out of range [0, ${ this.count })` );
		}
		const base = ( this.ptr >> 2 ) + index * MOVE_EVENT_STRIDE_WORDS;
		const f = this.native.HEAPF32;
		const u = this.native.HEAPU32;
		const c = this.cursor;
		c.userData = u[base];
		( c.position as { x: number; y: number; z: number } ).x = f[base + 1];
		( c.position as { x: number; y: number; z: number } ).y = f[base + 2];
		( c.position as { x: number; y: number; z: number } ).z = f[base + 3];
		( c.rotation as { x: number; y: number; z: number; w: number } ).x = f[base + 4];
		( c.rotation as { x: number; y: number; z: number; w: number } ).y = f[base + 5];
		( c.rotation as { x: number; y: number; z: number; w: number } ).z = f[base + 6];
		( c.rotation as { x: number; y: number; z: number; w: number } ).w = f[base + 7];
		c.fellAsleep = ( u[base + 8] & 1 ) !== 0;
		return c;
	}

	forEach( fn: ( event: MoveEventCursor, index: number ) => void ): void {
		for ( let i = 0; i < this.count; i++ ) {
			fn( this.at( i ), i );
		}
	}
}

export class HitEventsView {
	private readonly cursor: HitEventCursor = {
		userDataA: 0,
		userDataB: 0,
		point: { x: 0, y: 0, z: 0 },
		normal: { x: 0, y: 0, z: 0 },
		approachSpeed: 0,
		userMaterialIdA: 0,
		userMaterialIdB: 0,
	};

	constructor( private readonly native: Native, private readonly ptr: number, readonly count: number ) {}

	at( index: number ): HitEventCursor {
		if ( index < 0 || index >= this.count ) {
			throw new RangeError( `hit event index ${ index } out of range [0, ${ this.count })` );
		}
		const base = ( this.ptr >> 2 ) + index * HIT_EVENT_STRIDE_WORDS;
		const f = this.native.HEAPF32;
		const u = this.native.HEAPU32;
		const c = this.cursor;
		c.userDataA = u[base];
		c.userDataB = u[base + 1];
		( c.point as { x: number; y: number; z: number } ).x = f[base + 2];
		( c.point as { x: number; y: number; z: number } ).y = f[base + 3];
		( c.point as { x: number; y: number; z: number } ).z = f[base + 4];
		( c.normal as { x: number; y: number; z: number } ).x = f[base + 5];
		( c.normal as { x: number; y: number; z: number } ).y = f[base + 6];
		( c.normal as { x: number; y: number; z: number } ).z = f[base + 7];
		c.approachSpeed = f[base + 8];
		c.userMaterialIdA = u[base + 9];
		c.userMaterialIdB = u[base + 10];
		return c;
	}

	forEach( fn: ( event: HitEventCursor, index: number ) => void ): void {
		for ( let i = 0; i < this.count; i++ ) {
			fn( this.at( i ), i );
		}
	}
}

/** Zero-allocation cursor over a step's contact begin/end touch events (see
 * World.contactBeginEvents()/contactEndEvents()). Same two-entity-id shape for both begin and end. */
export class ContactEventsView {
	private readonly cursor: ContactEventCursor = { userDataA: 0, userDataB: 0 };

	constructor( private readonly native: Native, private readonly ptr: number, readonly count: number ) {}

	at( index: number ): ContactEventCursor {
		if ( index < 0 || index >= this.count ) {
			throw new RangeError( `contact event index ${ index } out of range [0, ${ this.count })` );
		}
		const base = ( this.ptr >> 2 ) + index * CONTACT_EVENT_STRIDE_WORDS;
		const u = this.native.HEAPU32;
		this.cursor.userDataA = u[base];
		this.cursor.userDataB = u[base + 1];
		return this.cursor;
	}

	forEach( fn: ( event: ContactEventCursor, index: number ) => void ): void {
		for ( let i = 0; i < this.count; i++ ) {
			fn( this.at( i ), i );
		}
	}
}

export class JointEventsView {
	private readonly cursor: JointEventCursor = { userData: 0 };

	constructor( private readonly native: Native, private readonly ptr: number, readonly count: number ) {}

	at( index: number ): JointEventCursor {
		if ( index < 0 || index >= this.count ) {
			throw new RangeError( `joint event index ${ index } out of range [0, ${ this.count })` );
		}
		const base = ( this.ptr >> 2 ) + index * JOINT_EVENT_STRIDE_WORDS;
		this.cursor.userData = this.native.HEAPU32[base];
		return this.cursor;
	}

	forEach( fn: ( event: JointEventCursor, index: number ) => void ): void {
		for ( let i = 0; i < this.count; i++ ) {
			fn( this.at( i ), i );
		}
	}
}
