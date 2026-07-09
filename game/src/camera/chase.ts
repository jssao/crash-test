// SPDX-License-Identifier: MIT
//
// Spring-damped chase camera: follows ~6m behind and 2m above the car along its velocity direction
// (falling back to the car's own forward axis at low speed, where velocity direction is noisy/
// undefined), looking at the car with a small lead along that same direction. Uses a critically
// damped spring (the standard "SmoothDamp" formulation) with explicit position+velocity state, not
// a naive exponential lerp, so it has real damped-spring dynamics (won't oscillate, settles smoothly
// regardless of frame rate).

import * as THREE from 'three';

/** Critically damped spring toward `target`, in place, with persistent velocity state `velocity`. */
function springDamp(current: THREE.Vector3, velocity: THREE.Vector3, target: THREE.Vector3, smoothTime: number, dt: number): void {
	const omega = 2 / Math.max(smoothTime, 1e-4);
	const x = omega * dt;
	const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
	const diffX = current.x - target.x;
	const diffY = current.y - target.y;
	const diffZ = current.z - target.z;
	const tempX = (velocity.x + omega * diffX) * dt;
	const tempY = (velocity.y + omega * diffY) * dt;
	const tempZ = (velocity.z + omega * diffZ) * dt;
	velocity.x = (velocity.x - omega * tempX) * exp;
	velocity.y = (velocity.y - omega * tempY) * exp;
	velocity.z = (velocity.z - omega * tempZ) * exp;
	current.x = target.x + (diffX + tempX) * exp;
	current.y = target.y + (diffY + tempY) * exp;
	current.z = target.z + (diffZ + tempZ) * exp;
}

export interface ChaseCameraOptions {
	distanceBack?: number;
	heightUp?: number;
	lookAheadDistance?: number;
	lookAheadHeight?: number;
	/** Seconds; smaller = snappier, larger = floatier. */
	positionSmoothTime?: number;
	lookSmoothTime?: number;
	/** Below this speed (m/s), fall back to the car's forward axis instead of its velocity direction. */
	minSpeedForVelocityDirection?: number;
}

export class ChaseCamera {
	private readonly opts: Required<ChaseCameraOptions>;
	private readonly currentPos = new THREE.Vector3();
	private readonly posVelocity = new THREE.Vector3();
	private readonly currentLook = new THREE.Vector3();
	private readonly lookVelocity = new THREE.Vector3();
	private initialized = false;

	constructor(options: ChaseCameraOptions = {}) {
		this.opts = {
			distanceBack: options.distanceBack ?? 6,
			heightUp: options.heightUp ?? 2,
			lookAheadDistance: options.lookAheadDistance ?? 5,
			lookAheadHeight: options.lookAheadHeight ?? 0.6,
			positionSmoothTime: options.positionSmoothTime ?? 0.25,
			lookSmoothTime: options.lookSmoothTime ?? 0.15,
			minSpeedForVelocityDirection: options.minSpeedForVelocityDirection ?? 1.5,
		};
	}

	/** Call every render frame (not every fixed step) with the car's INTERPOLATED position/rotation/velocity. */
	update(camera: THREE.PerspectiveCamera, carPosition: THREE.Vector3, carQuaternion: THREE.Quaternion, carVelocity: THREE.Vector3, dt: number): void {
		const speed = carVelocity.length();
		const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuaternion);
		const direction = speed > this.opts.minSpeedForVelocityDirection ? carVelocity.clone().normalize() : forward;

		const desiredPos = carPosition
			.clone()
			.addScaledVector(direction, -this.opts.distanceBack)
			.add(new THREE.Vector3(0, this.opts.heightUp, 0));
		const desiredLook = carPosition
			.clone()
			.addScaledVector(direction, this.opts.lookAheadDistance)
			.add(new THREE.Vector3(0, this.opts.lookAheadHeight, 0));

		if (!this.initialized) {
			this.currentPos.copy(desiredPos);
			this.currentLook.copy(desiredLook);
			this.initialized = true;
		}

		springDamp(this.currentPos, this.posVelocity, desiredPos, this.opts.positionSmoothTime, dt);
		springDamp(this.currentLook, this.lookVelocity, desiredLook, this.opts.lookSmoothTime, dt);

		camera.position.copy(this.currentPos);
		camera.lookAt(this.currentLook);
	}

	reset(): void {
		this.initialized = false;
		this.posVelocity.set(0, 0, 0);
		this.lookVelocity.set(0, 0, 0);
	}
}
