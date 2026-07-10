import * as THREE from 'three';
import type { World } from '../../../src/ts/index.js';
import { castCameraOcclusion, OcclusionDamper } from '../camera/occlusion';

export interface OrbitParams {
  radius: number;
  height: number;
  angularSpeed: number; // radians / second
  targetHeight: number;
}

/**
 * Auto-spin orbit updater: a slow, smooth orbit around the car so the render/lighting/shadows can
 * be judged from every angle without any input wiring. Still used verbatim (unchanged math) whenever
 * the player hasn't taken manual control of the camera -- see createUserOrbitController below for
 * that -- AND by the verify/*.mjs scripts via setFixedAngle()/setOrbitView(), which depend on this
 * function's exact position formula (radius/height are a fixed cylindrical offset, not a spherical
 * one) for screenshots ranging from radius 3.5 (cabin close-up) to radius 120 (perf-render's wide
 * establishing shot). Do not change this formula's shape -- add new behavior alongside it instead.
 */
export function createOrbitUpdater(camera: THREE.PerspectiveCamera, params: OrbitParams) {
  return function update(elapsedSeconds: number, focus: THREE.Vector3): void {
    const angle = elapsedSeconds * params.angularSpeed;
    camera.position.set(
      focus.x + Math.cos(angle) * params.radius,
      Math.max(focus.y + params.height, 0.4), // never clip below the ground plane
      focus.z + Math.sin(angle) * params.radius,
    );
    camera.lookAt(focus.x, focus.y + params.targetHeight, focus.z);
  };
}

// ---- Click-drag / wheel user orbit control ----
//
// A separate, opt-in layer on top of createOrbitUpdater(): it only ever activates once the player
// actually drags the mouse (see UserOrbitController.active), so it never interferes with
// setFixedAngle()/setOrbitView()-driven verify screenshots (those never dispatch pointer events).
// True spherical coordinates (azimuth around Y, polar from vertical, radius) so a vertical drag can
// tilt the view up/down, not just spin around a fixed height like the auto-spin path above.

export const USER_ORBIT_MIN_RADIUS = 4;
export const USER_ORBIT_MAX_RADIUS = 25;
const MIN_POLAR = 0.18; // radians from vertical -- guard against flipping over the top
const MAX_POLAR = 1.45; // radians from vertical -- stay just above the horizon, never dip underground
const DAMPING_TIME_CONSTANT = 0.15; // seconds -- ~0.1-0.2s smooth interpolation per the spec

export interface UserOrbitSpherical {
  azimuth: number;
  polar: number;
  radius: number;
}

export interface UserOrbitController {
  /** True once the player has dragged (or scrolled) at least once since the last reset(). */
  readonly active: boolean;
  /** Current (damped) spherical pose -- read-only, for HUD/verify introspection. Note: `radius` is
   * the player's DRAGGED/ZOOMED distance, unaffected by occlusion (see `occluded`/occlusionDistanceM
   * below) -- occlusion only clamps the RENDERED camera position, never this stored target, so
   * zoom/drag continuity survives passing behind an obstacle. */
  readonly azimuth: number;
  readonly polar: number;
  readonly radius: number;
  /** Occlusion clamp (Tier-2 camera task, see ../camera/occlusion.ts): true if the most recent
   * update() call pulled the rendered camera in short of `radius` because a real (non-car-owned)
   * surface -- a wall, tree, terrain -- was in the way. VERIFY HOOK. */
  readonly occluded: boolean;
  /** Feed raw pointer-drag deltas (radians); switches `active` on. */
  drag(deltaAzimuth: number, deltaPolar: number): void;
  /** Feed a raw wheel delta (meters, positive = zoom out); switches `active` on. Clamped to
   * [USER_ORBIT_MIN_RADIUS, USER_ORBIT_MAX_RADIUS]. */
  zoom(deltaRadius: number): void;
  /** Re-seed from `initial` and go back to inactive (auto-spin resumes) -- called when the player
   * cycles the camera mode away from and back into orbit (C, C). */
  reset(initial: UserOrbitSpherical): void;
  /** Damp toward the latest target and position/aim the camera at `focus`. `world`, if given, enables
   * occlusion clamping (see ../camera/occlusion.ts) -- omit it (or pass null/undefined) to get the
   * exact pre-occlusion behavior, e.g. in a headless/unit context with no physics world. */
  update(camera: THREE.PerspectiveCamera, focus: THREE.Vector3, targetHeight: number, dt: number, world?: World | null): void;
}

export function createUserOrbitController(initial: UserOrbitSpherical): UserOrbitController {
  let targetAzimuth = initial.azimuth;
  let targetPolar = THREE.MathUtils.clamp(initial.polar, MIN_POLAR, MAX_POLAR);
  let targetRadius = THREE.MathUtils.clamp(initial.radius, USER_ORBIT_MIN_RADIUS, USER_ORBIT_MAX_RADIUS);
  let curAzimuth = targetAzimuth;
  let curPolar = targetPolar;
  let curRadius = targetRadius;
  let active = false;
  let occluded = false;
  const occlusionDamper = new OcclusionDamper();

  return {
    get active() {
      return active;
    },
    get azimuth() {
      return curAzimuth;
    },
    get polar() {
      return curPolar;
    },
    get radius() {
      return curRadius;
    },
    get occluded() {
      return occluded;
    },
    drag(deltaAzimuth, deltaPolar) {
      active = true;
      targetAzimuth += deltaAzimuth;
      targetPolar = THREE.MathUtils.clamp(targetPolar + deltaPolar, MIN_POLAR, MAX_POLAR);
    },
    zoom(deltaRadius) {
      active = true;
      targetRadius = THREE.MathUtils.clamp(targetRadius + deltaRadius, USER_ORBIT_MIN_RADIUS, USER_ORBIT_MAX_RADIUS);
    },
    reset(next) {
      active = false;
      targetAzimuth = curAzimuth = next.azimuth;
      targetPolar = curPolar = THREE.MathUtils.clamp(next.polar, MIN_POLAR, MAX_POLAR);
      targetRadius = curRadius = THREE.MathUtils.clamp(next.radius, USER_ORBIT_MIN_RADIUS, USER_ORBIT_MAX_RADIUS);
      occluded = false;
      occlusionDamper.reset();
    },
    update(camera, focus, targetHeight, dt, world) {
      // Same critically-damped-ish exponential smoothing shape as ChaseCamera's springDamp (see
      // camera/chase.ts), simplified to scalar damping since there's no need for spring overshoot here
      // -- just a smooth ease toward the latest drag/zoom target.
      const t = 1 - Math.exp(-dt / DAMPING_TIME_CONSTANT);
      curAzimuth += (targetAzimuth - curAzimuth) * t;
      curPolar += (targetPolar - curPolar) * t;
      curRadius += (targetRadius - curRadius) * t;

      const horiz = curRadius * Math.sin(curPolar);
      const y = curRadius * Math.cos(curPolar);
      const desired = new THREE.Vector3(
        focus.x + horiz * Math.cos(curAzimuth),
        Math.max(focus.y + y, 0.4),
        focus.z + horiz * Math.sin(curAzimuth),
      );

      // Occlusion clamp (Tier-2 camera task, ../camera/occlusion.ts): cast focus->desired and pull the
      // RENDERED position in short of `desired` if a real (non-car-owned) surface -- a wall, tree,
      // terrain -- blocks it, so drag-orbit can't clip through e.g. a shed by dragging/zooming to a
      // vantage point behind it. Deliberately clamps only the rendered position, never curRadius/
      // targetRadius themselves, so the player's own zoom level is preserved and the view snaps back
      // out (not to some other radius) the moment the obstruction clears.
      let renderPos = desired;
      if (world) {
        const originHeight = new THREE.Vector3(focus.x, focus.y + targetHeight, focus.z);
        const raw = castCameraOcclusion(world, originHeight, desired);
        const damped = occlusionDamper.update(raw.distanceM, dt);
        const fullDistance = originHeight.distanceTo(desired);
        occluded = raw.occluded;
        if (fullDistance > 1e-6 && damped < fullDistance - 1e-6) {
          renderPos = originHeight.clone().lerp(desired, damped / fullDistance);
        }
      } else {
        occluded = false;
        occlusionDamper.reset();
      }

      camera.position.copy(renderPos);
      camera.lookAt(focus.x, focus.y + targetHeight, focus.z);
    },
  };
}

/** Derive a starting spherical pose (azimuth/polar/radius) from the auto-spin cylindrical
 * radius+height so the user-orbit controller starts wherever the auto-spin view currently is
 * instead of snapping the camera on the first drag. */
export function sphericalFromCylindrical(radius: number, height: number, azimuth = 0): UserOrbitSpherical {
  return {
    azimuth,
    polar: Math.atan2(radius, height),
    radius: Math.hypot(radius, height),
  };
}

/** Derive the spherical pose of an ACTUAL camera position around `focus` — used to seed the
 * user-orbit controller at the exact moment the player takes control (first drag/zoom, possibly
 * from CHASE mode), so taking over never snaps the view (user bug report: clicking "reset the
 * camera angle" — the controller had only ever been seeded at boot/C-cycle, not at takeover).
 * Inverse of UserOrbitController.update()'s position formula. */
export function sphericalFromCameraPose(cameraPos: THREE.Vector3, focus: THREE.Vector3): UserOrbitSpherical {
  const dx = cameraPos.x - focus.x;
  const dy = cameraPos.y - focus.y;
  const dz = cameraPos.z - focus.z;
  const horiz = Math.hypot(dx, dz);
  return {
    azimuth: Math.atan2(dz, dx),
    polar: Math.atan2(horiz, dy),
    radius: Math.hypot(horiz, dy),
  };
}
