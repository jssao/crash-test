// SPDX-License-Identifier: MIT
//
// Spring-damped chase camera: follows ~6m behind and 2m above the car along its velocity direction
// (falling back to the car's own forward axis at low speed, where velocity direction is noisy/
// undefined), looking at the car with a small lead along that same direction. Uses a critically
// damped spring (the standard "SmoothDamp" formulation) with explicit position+velocity state, not
// a naive exponential lerp, so it has real damped-spring dynamics (won't oscillate, settles smoothly
// regardless of frame rate).

import * as THREE from 'three';
import type { World } from '../../../src/ts/index.js';
import { castCameraOcclusion, OcclusionDamper } from './occlusion';

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
	/** Degrees, at ~0 km/h / at SPEED_FOV_MAX_KMH+ -- mild speed sensation without being disorienting. */
	fovMinDeg?: number;
	fovMaxDeg?: number;
	fovMaxSpeedKmh?: number;
	/** Seconds; FOV smoothing time constant. */
	fovSmoothTime?: number;
	/** Never let the camera's final Y drop below this (world space), so an aggressive shake/spring
	 * overshoot can never clip the camera into/below the ground plane. */
	minCameraHeightM?: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class ChaseCamera {
	private readonly opts: Required<ChaseCameraOptions>;
	private readonly currentPos = new THREE.Vector3();
	private readonly posVelocity = new THREE.Vector3();
	private readonly currentLook = new THREE.Vector3();
	private readonly lookVelocity = new THREE.Vector3();
	private initialized = false;

	/** Impact-shake state (G4/G5 camera polish): amplitude (meters) added by triggerImpact(), decays
	 * exponentially every update() call -- see that method's doc comment. */
	private shakeAmplitudeM = 0;
	private fovDeg: number;

	/** Occlusion pullback (Tier-2 camera task, see ./occlusion.ts): optional world reference set via
	 * setWorld(); null (the default) preserves the pre-occlusion behavior exactly, so anything that
	 * never calls setWorld() -- e.g. a headless/unit context -- is unaffected. */
	private world: World | null = null;
	private readonly occlusionDamper = new OcclusionDamper();
	private lastOcclusion = { occluded: false, distanceM: 0 };

	constructor(options: ChaseCameraOptions = {}) {
		this.opts = {
			distanceBack: options.distanceBack ?? 6,
			heightUp: options.heightUp ?? 2,
			lookAheadDistance: options.lookAheadDistance ?? 5,
			lookAheadHeight: options.lookAheadHeight ?? 0.6,
			positionSmoothTime: options.positionSmoothTime ?? 0.25,
			lookSmoothTime: options.lookSmoothTime ?? 0.15,
			minSpeedForVelocityDirection: options.minSpeedForVelocityDirection ?? 1.5,
			fovMinDeg: options.fovMinDeg ?? 62,
			fovMaxDeg: options.fovMaxDeg ?? 70,
			fovMaxSpeedKmh: options.fovMaxSpeedKmh ?? 100,
			fovSmoothTime: options.fovSmoothTime ?? 0.4,
			minCameraHeightM: options.minCameraHeightM ?? 0.4,
		};
		this.fovDeg = this.opts.fovMinDeg;
	}

	/**
	 * Adds impact shake (G4/G5 camera polish), amplitude proportional to `severityMs` (an impact
	 * event's approach speed, m/s -- see game/src/damage/events.ts's ImpactEvent), capped so a huge
	 * crash can't fling the camera absurdly far. Call from main.ts's damage-event subscription; the
	 * shake itself decays exponentially over the next several update() calls, it does not need to be
	 * "held" by the caller.
	 */
	triggerImpact(severityMs: number): void {
		const SHAKE_PER_MS = 0.018; // meters of amplitude per m/s of impact approach speed
		const SHAKE_MAX_M = 0.45;
		this.shakeAmplitudeM = Math.min(SHAKE_MAX_M, this.shakeAmplitudeM + severityMs * SHAKE_PER_MS);
	}

	/** Enables occlusion pullback (see ./occlusion.ts): pass the live physics World so update() can
	 * sphere-cast car->desiredCameraPos each frame. Pass null to disable it again (e.g. a headless
	 * verify context with no world). */
	setWorld(world: World | null): void {
		this.world = world;
		this.occlusionDamper.reset();
	}

	/** Read-only occlusion snapshot from the most recent update() call -- VERIFY HOOK (see
	 * game/verify/camera-occlusion.mjs and main.ts's cameraDebug()). */
	getOcclusionDebug(): { occluded: boolean; distanceM: number } {
		return this.lastOcclusion;
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

		// Occlusion pullback (Tier-2 camera task, ./occlusion.ts): cast eye->desiredPos and, if a real
		// (non-car-owned) surface blocks it, pull desiredPos in along the carPosition->desiredPos ray
		// (preserving the height-up/distance-back direction, just shortening it) before ever handing it
		// to the spring -- so the damped spring settles toward the occlusion-safe point instead of
		// overshooting into the wall on its way there. Damped (fast in / slow out) so briefly clipping a
		// thin occluder doesn't yo-yo the camera.
		//
		// CAST ORIGIN (not literally carPosition): the chassis's own physics origin sits at ~hub height
		// (tuning.ts's CHASSIS_ORIGIN_HEIGHT_M, well under half a meter) -- close enough to the ground
		// that the occlusion probe's own sphere (radius ~0.4m) already touches the terrain/heightfield AT
		// the start of the cast, producing a false "occluded" reading against the ground on perfectly
		// clear, flat terrain (root-caused directly: verify/camera-occlusion.mjs's unoccluded baseline
		// came back occluded=true, hitEntityId=0, distanceM clamped to minDistanceM, with no wall spawned
		// at all -- entityId 0 is untagged terrain, not any car part). Casting from a point raised to
		// roughly eye/cabin height instead keeps the probe clear of the ground under normal ride height,
		// while still producing a geometrically close-enough distance for the carPosition->desiredPos
		// lerp below (the offset is small relative to the ~6m chase distance).
		const eyeOrigin = carPosition.clone().add(new THREE.Vector3(0, this.opts.heightUp * 0.5, 0));
		if (this.world) {
			const raw = castCameraOcclusion(this.world, eyeOrigin, desiredPos);
			const damped = this.occlusionDamper.update(raw.distanceM, dt);
			this.lastOcclusion = { occluded: raw.occluded, distanceM: damped };
			const fullDistance = carPosition.distanceTo(desiredPos);
			if (fullDistance > 1e-6 && damped < fullDistance - 1e-6) {
				// NOTE: lerp toward a target derived from desiredPos itself, so this must compute the
				// interpolated point BEFORE mutating desiredPos (Vector3.lerp(v, t) reads `this` as the
				// start -- copying carPosition into desiredPos first, then lerping toward "desiredPos",
				// would lerp between two now-equal points and silently no-op).
				const t = damped / fullDistance;
				const pulled = carPosition.clone().lerp(desiredPos, t);
				desiredPos.copy(pulled);
			}
		} else {
			this.lastOcclusion = { occluded: false, distanceM: carPosition.distanceTo(desiredPos) };
		}

		if (!this.initialized) {
			this.currentPos.copy(desiredPos);
			this.currentLook.copy(desiredLook);
			this.initialized = true;
		}

		springDamp(this.currentPos, this.posVelocity, desiredPos, this.opts.positionSmoothTime, dt);
		springDamp(this.currentLook, this.lookVelocity, desiredLook, this.opts.lookSmoothTime, dt);

		camera.position.copy(this.currentPos);

		// Impact shake: small per-frame random offset, exponentially decaying (not held/looping --
		// each triggerImpact() just tops the amplitude back up).
		if (this.shakeAmplitudeM > 1e-4) {
			const a = this.shakeAmplitudeM;
			camera.position.x += (Math.random() * 2 - 1) * a;
			camera.position.y += (Math.random() * 2 - 1) * a * 0.6;
			camera.position.z += (Math.random() * 2 - 1) * a;
			const SHAKE_DECAY_PER_SEC = 7;
			this.shakeAmplitudeM *= Math.exp(-SHAKE_DECAY_PER_SEC * dt);
			if (this.shakeAmplitudeM < 1e-4) this.shakeAmplitudeM = 0;
		}

		// Never let the final camera position clip below the ground plane, shake included.
		if (camera.position.y < this.opts.minCameraHeightM) camera.position.y = this.opts.minCameraHeightM;

		camera.lookAt(this.currentLook);

		// Mild speed-FOV: 62deg -> 70deg by fovMaxSpeedKmh, smoothed (not a snap-cut).
		const speedKmh = speed * 3.6;
		const targetFov = this.opts.fovMinDeg + (this.opts.fovMaxDeg - this.opts.fovMinDeg) * clamp01(speedKmh / this.opts.fovMaxSpeedKmh);
		const t = 1 - Math.exp(-dt / this.opts.fovSmoothTime);
		this.fovDeg += (targetFov - this.fovDeg) * t;
		if (Math.abs(camera.fov - this.fovDeg) > 1e-3) {
			camera.fov = this.fovDeg;
			camera.updateProjectionMatrix();
		}
	}

	reset(): void {
		this.initialized = false;
		this.posVelocity.set(0, 0, 0);
		this.lookVelocity.set(0, 0, 0);
		this.shakeAmplitudeM = 0;
		this.occlusionDamper.reset();
		this.lastOcclusion = { occluded: false, distanceM: 0 };
	}
}
