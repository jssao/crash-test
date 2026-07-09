// SPDX-License-Identifier: MIT
//
// Fixed-timestep accumulator (60Hz) with render-transform interpolation. Decouples the physics
// step rate (fixed, deterministic) from the browser's variable render frame rate: accumulate real
// elapsed time, run zero-or-more fixed physics steps to consume it, then hand back an interpolation
// alpha in [0,1) for the leftover fractional step so renderer transforms can be smoothly blended
// between the previous and current physics states rather than snapping.

import * as THREE from 'three';
import type { Quat, Vec3 } from '../../../src/ts/index.js';

/** Snapshot of a body's previous/current transform, for render-time interpolation. */
export class InterpolatedTransform {
	readonly prevPosition = new THREE.Vector3();
	readonly prevQuaternion = new THREE.Quaternion();
	readonly currPosition = new THREE.Vector3();
	readonly currQuaternion = new THREE.Quaternion();
	private initialized = false;

	/** Call once per fixed physics step with the body's new transform. */
	sample(position: Vec3, rotation: Quat): void {
		if (!this.initialized) {
			this.prevPosition.set(position.x, position.y, position.z);
			this.prevQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
			this.initialized = true;
		} else {
			this.prevPosition.copy(this.currPosition);
			this.prevQuaternion.copy(this.currQuaternion);
		}
		this.currPosition.set(position.x, position.y, position.z);
		this.currQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
	}

	/** Writes the interpolated (alpha in [0,1)) transform onto a three.js Object3D. */
	applyTo(object: THREE.Object3D, alpha: number): void {
		object.position.lerpVectors(this.prevPosition, this.currPosition, alpha);
		object.quaternion.slerpQuaternions(this.prevQuaternion, this.currQuaternion, alpha);
	}

	/** Interpolated position only (e.g. for a camera target), without touching an Object3D. */
	lerpPosition(out: THREE.Vector3, alpha: number): THREE.Vector3 {
		return out.lerpVectors(this.prevPosition, this.currPosition, alpha);
	}

	lerpQuaternion(out: THREE.Quaternion, alpha: number): THREE.Quaternion {
		return out.slerpQuaternions(this.prevQuaternion, this.currQuaternion, alpha);
	}
}

/**
 * Accumulates real frame time and calls `step()` zero-or-more times at exactly `fixedDt` each, to
 * catch the simulation up to real time. Returns the leftover-time interpolation alpha (fraction of
 * one more fixed step) for render-time blending. Caps steps-per-frame to avoid a "spiral of death"
 * if the tab was backgrounded/stalled (drops the excess accumulated time instead of trying to catch
 * up all at once).
 */
export class FixedStepAccumulator {
	private accumulator = 0;

	constructor(
		readonly fixedDt: number,
		private readonly maxStepsPerFrame = 8,
	) {}

	advance(frameDt: number, step: () => void): number {
		this.accumulator += frameDt;
		let steps = 0;
		while (this.accumulator >= this.fixedDt && steps < this.maxStepsPerFrame) {
			step();
			this.accumulator -= this.fixedDt;
			steps++;
		}
		if (steps >= this.maxStepsPerFrame) {
			// Dropped a stall's worth of backlog rather than spiral -- resync the accumulator.
			this.accumulator = 0;
		}
		return this.accumulator / this.fixedDt;
	}

	reset(): void {
		this.accumulator = 0;
	}
}
