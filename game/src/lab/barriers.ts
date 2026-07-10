// SPDX-License-Identifier: MIT
//
// Crash Lab barrier/trolley rigs: renderer-adjacent (creates both the box3d physics body/shape AND a
// matching THREE visual) spawner for each protocols.ts BarrierKind. Deliberately NOT touching
// game/src/damage/** or game/src/vehicle/** -- only READS their already-public types/utilities
// (mathUtil's rotate/scale helpers, the Vehicle type) exactly the way game/src/damage/scenario.ts and
// game/sim/crash-realism-harness.mjs already do for the main game's own wall/offset/side rigs. No
// setForeignMass() registration for any rig here (see protocols.ts's doc comment): every rig reads as
// a full-effect ("wall-like") obstacle, matching the reference spec's "rigid-approximated" allowance
// for the deformable-barrier protocols, and avoiding an uncalibrated mass-attenuation guess for the
// guided trolleys.

import * as THREE from 'three';
import { Body, BodyType, Shape, World } from '../../../src/ts/index.js';
import { rotateVector, scale, type V3 } from '../vehicle/mathUtil';
import type { Vehicle } from '../vehicle/vehicle';
import { seedSegmentVelocities } from '../vehicle/segments';
import type { BarrierKind, CrashProtocol, FreeConfigState } from './protocols';

const LOCAL_FORWARD: V3 = { x: 0, y: 0, z: 1 };
const LOCAL_RIGHT: V3 = { x: 1, y: 0, z: 0 };

function sideSign(side: 'left' | 'right'): number {
	return side === 'right' ? 1 : -1;
}

/** One spawned rig: the physics body/shape(s) it owns, its THREE visual, and (for the two trolley
 * kinds) the guide velocity main.ts's guideBarrierRig() re-asserts every fixed step. */
export interface BarrierRig {
	kind: BarrierKind;
	bodies: Body[];
	shapes: Shape[];
	visual: THREE.Object3D;
	/** `armedUntilS`: main.ts's guideBarrierRig() only re-pins the trolley's velocity while the RUN's
	 * elapsed time is still under this -- see that function's doc comment for why an indefinitely-
	 * guided trolley is wrong (a real MDB/rear rig is towed/guided up TO impact, then it's the crash's
	 * own momentum transfer that governs what happens next, not a rail continuing to shove through the
	 * car for the whole settle window). */
	guide?: { body: Body; velocity: V3; armedUntilS: number };
}

/** Extra guided time (seconds) PAST the nominal geometric arrival time (distance/closing-speed) before
 * a trolley's guide releases -- long enough to guarantee real contact has begun (the nominal arrival
 * time only accounts for the gap to the CAR'S SPAWN POINT, not the trolley's own half-depth + the
 * car's own half-width/length), short enough that the guide doesn't keep bulldozing the car through
 * the whole crash. Tuned by eyes-on review of the first pass (see this task's dispatch notes): an
 * indefinitely-guided trolley detached all 4 wheels and both doors on a 50 km/h side hit -- far more
 * damage than a single real MDB punch, because the guide never let the trolley decelerate/separate. */
const TROLLEY_GUIDE_IMPACT_BUFFER_S = 0.05;

// ---------------------------------------------------------------------------------------------
// Hazard-stripe texture (cached, built once) -- gives every rig a "this is test equipment" look
// distinct from the car/ground without needing an external asset.
// ---------------------------------------------------------------------------------------------
let hazardTextureCache: THREE.CanvasTexture | null = null;
function hazardTexture(): THREE.CanvasTexture {
	if (hazardTextureCache) return hazardTextureCache;
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#2a2e33';
	ctx.fillRect(0, 0, size, size);
	ctx.fillStyle = '#f4c430';
	const stripeW = size / 8;
	ctx.save();
	ctx.translate(size / 2, size / 2);
	ctx.rotate(Math.PI / 4);
	ctx.translate(-size, -size);
	for (let x = 0; x < size * 4; x += stripeW * 2) ctx.fillRect(x, -size, stripeW, size * 4);
	ctx.restore();
	const tex = new THREE.CanvasTexture(canvas);
	tex.wrapS = THREE.RepeatWrapping;
	tex.wrapT = THREE.RepeatWrapping;
	hazardTextureCache = tex;
	return tex;
}

function hazardMaterial(repeatX = 2, repeatY = 1): THREE.MeshStandardMaterial {
	const tex = hazardTexture().clone();
	tex.needsUpdate = true;
	tex.repeat.set(repeatX, repeatY);
	return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0.05 });
}

function poleMaterial(): THREE.MeshStandardMaterial {
	return new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.4, metalness: 0.6 });
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

/** Resolves this protocol's effective speed/offset/angle -- for every protocol except 'free' these
 * are just the static PROTOCOLS entry; for 'free' the live slider state (freeConfig) wins. */
export function effectiveRunParams(protocol: CrashProtocol, freeConfig: FreeConfigState): { speedKmh: number; lateralOffsetM: number; angleDeg: number } {
	if (protocol.isFreeConfig) {
		return { speedKmh: freeConfig.speedKmh, lateralOffsetM: freeConfig.offsetM, angleDeg: freeConfig.angleDeg };
	}
	return { speedKmh: protocol.speedKmh, lateralOffsetM: protocol.lateralOffsetM ?? 0, angleDeg: 0 };
}

function boxVisual(halfExtents: V3, material: THREE.Material): THREE.Mesh {
	const geom = new THREE.BoxGeometry(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2);
	const mesh = new THREE.Mesh(geom, material);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	return mesh;
}

/** Spawns the rig for `protocol` (using `freeConfig` for the 'free' protocol's live sliders),
 * `distanceAhead`/side geometry all relative to `vehicle`'s CURRENT spawn pose. Adds the visual to
 * `scene` and returns everything needed to guide/step/tear it down. */
export function spawnBarrierRig(world: World, scene: THREE.Scene, vehicle: Vehicle, protocol: CrashProtocol, freeConfig: FreeConfigState): BarrierRig {
	const { lateralOffsetM } = effectiveRunParams(protocol, freeConfig);
	const forward = rotateVector(vehicle.spawnRotation, LOCAL_FORWARD);
	const right = rotateVector(vehicle.spawnRotation, LOCAL_RIGHT);
	const sign = sideSign(protocol.side);
	const spawn = vehicle.spawnPosition;

	switch (protocol.barrier) {
		case 'rigid-full':
		case 'rigid-offset': {
			// Default (full-width, no explicit barrierHalfWidthM): ~3x the car's own half-width -- wide
			// enough to be unambiguously "full width" against a ~1m-half-width car, without the barrier
			// visually dwarfing the whole frame the way the main game's much-larger free-driving test wall
			// (damage/scenario.ts's spawnTestWall, sized to block a car from driving around it) would.
			const halfWidth = protocol.barrierHalfWidthM ?? 3;
			const lateral = lateralOffsetM * sign;
			const position: V3 = {
				x: spawn.x + forward.x * protocol.approachDistanceM + right.x * lateral,
				y: 1.5,
				z: spawn.z + forward.z * protocol.approachDistanceM + right.z * lateral,
			};
			const body = world.createBody({ type: BodyType.Static, position });
			const halfExtents: V3 = { x: halfWidth, y: 2, z: 0.5 };
			const shape = body.createBoxShape({ halfExtents, friction: 0.9, density: 1 });
			const mesh = boxVisual(halfExtents, hazardMaterial(Math.max(1, halfWidth), 2));
			mesh.position.set(position.x, position.y, position.z);
			scene.add(mesh);
			return { kind: protocol.barrier, bodies: [body], shapes: [shape], visual: mesh };
		}
		case 'rigid-pole': {
			const distanceRight = protocol.approachDistanceM;
			const position: V3 = {
				x: spawn.x + right.x * distanceRight * sign,
				y: 0,
				z: spawn.z,
			};
			const body = world.createBody({ type: BodyType.Static, position });
			const radius = 0.15;
			const shape = body.createCapsuleShape({ center1: { x: 0, y: -1.0, z: 0 }, center2: { x: 0, y: 1.6, z: 0 }, radius, friction: 0.6, density: 1 });
			const mat = poleMaterial();
			const geom = new THREE.CylinderGeometry(radius, radius, 2.6 + radius * 2, 16);
			const mesh = new THREE.Mesh(geom, mat);
			mesh.castShadow = true;
			mesh.position.set(position.x, 0.3, position.z);
			scene.add(mesh);
			return { kind: 'rigid-pole', bodies: [body], shapes: [shape], visual: mesh };
		}
		case 'mdb-trolley': {
			const distanceRight = protocol.approachDistanceM;
			const massKg = protocol.trolleyMassKg ?? 1500;
			const halfExtents: V3 = { x: 0.75, y: 0.55, z: 1.4 };
			const position: V3 = {
				x: spawn.x + right.x * distanceRight * sign,
				y: 0.6,
				z: spawn.z,
			};
			const body = world.createBody({ type: BodyType.Dynamic, position, gravityScale: 0, angularDamping: 1, linearDamping: 0 });
			const density = massKg / (8 * halfExtents.x * halfExtents.y * halfExtents.z);
			const shape = body.createBoxShape({ halfExtents, density, friction: 0.3 });
			body.applyMassFromShapes();
			const speedMs = effectiveRunParams(protocol, freeConfig).speedKmh / 3.6;
			const velocity = scale(right, -speedMs * sign); // toward the car, opposite the rig's own offset direction
			body.setLinearVelocity(velocity);
			const mesh = boxVisual(halfExtents, hazardMaterial(3, 2));
			mesh.position.set(position.x, position.y, position.z);
			scene.add(mesh);
			const armedUntilS = distanceRight / Math.max(speedMs, 0.1) + TROLLEY_GUIDE_IMPACT_BUFFER_S;
			return { kind: 'mdb-trolley', bodies: [body], shapes: [shape], visual: mesh, guide: { body, velocity, armedUntilS } };
		}
		case 'rear-trolley': {
			const distanceBehind = protocol.approachDistanceM;
			const massKg = protocol.trolleyMassKg ?? 1500;
			const halfExtents: V3 = { x: 0.9, y: 0.5, z: 0.4 };
			const position: V3 = {
				x: spawn.x - forward.x * distanceBehind,
				y: 0.55,
				z: spawn.z - forward.z * distanceBehind,
			};
			const body = world.createBody({ type: BodyType.Dynamic, position, gravityScale: 0, angularDamping: 1, linearDamping: 0 });
			const density = massKg / (8 * halfExtents.x * halfExtents.y * halfExtents.z);
			const shape = body.createBoxShape({ halfExtents, density, friction: 0.3 });
			body.applyMassFromShapes();
			const speedMs = effectiveRunParams(protocol, freeConfig).speedKmh / 3.6;
			const velocity = scale(forward, speedMs);
			body.setLinearVelocity(velocity);
			const mesh = boxVisual(halfExtents, hazardMaterial(3, 2));
			mesh.position.set(position.x, position.y, position.z);
			scene.add(mesh);
			const armedUntilS = distanceBehind / Math.max(speedMs, 0.1) + TROLLEY_GUIDE_IMPACT_BUFFER_S;
			return { kind: 'rear-trolley', bodies: [body], shapes: [shape], visual: mesh, guide: { body, velocity, armedUntilS } };
		}
	}
}

/** Call once per fixed step for the lifetime of the run (main.ts's doFixedStep), passing the run's
 * current elapsed time: re-pins a guided trolley's linear velocity and zeroes its angular velocity
 * (so the crash reaction force can't knock it off its rail-guided line) ONLY until `guide.armedUntilS`
 * -- past that, this is a no-op and the trolley becomes an ordinary free dynamic body, carrying
 * whatever momentum it had at release into the rest of the collision (see BarrierRig.guide's doc
 * comment for why an indefinitely-guided trolley is physically wrong). No-op entirely for non-trolley
 * rigs (static barriers/pole have no `guide`). */
export function guideBarrierRig(rig: BarrierRig, runElapsedS: number): void {
	if (!rig.guide || runElapsedS >= rig.guide.armedUntilS) return;
	rig.guide.body.setLinearVelocity(rig.guide.velocity);
	rig.guide.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
}

/** Full teardown (shapes before bodies -- same box3d-js live-handle-registry ordering as every other
 * destroy site in this codebase, e.g. damage/scenario.ts's destroyTestWall()). Removes the visual from
 * `scene` and disposes its geometry/material (a rig is spawned fresh every run, so leaking one net-new
 * mesh/geometry per run would be a slow, real leak over a long lab session). */
export function teardownBarrierRig(scene: THREE.Scene, rig: BarrierRig): void {
	for (const s of rig.shapes) s.destroy(false);
	for (const b of rig.bodies) b.destroy();
	scene.remove(rig.visual);
	if (rig.visual instanceof THREE.Mesh) {
		rig.visual.geometry.dispose();
		const mat = rig.visual.material as THREE.MeshStandardMaterial;
		mat.map?.dispose();
		mat.dispose();
	}
}

/** Sets chassis + every wheel + every panel to the SAME velocity -- mirrors damage/scenario.ts's
 * crashSetup() exactly (avoids an artificial weld-stress spike from a 0->speed instant jump on just
 * the chassis, see that function's doc comment). Exported so main.ts's doFixedStep can call this
 * again each step during the guided approach (see vehicleGuideUntilS()'s doc comment) without
 * recomputing the launch direction. */
export function applyVehicleVelocity(vehicle: Vehicle, velocity: V3): void {
	vehicle.chassis.setLinearVelocity(velocity);
	for (const wheel of Object.values(vehicle.wheels)) wheel.body.setLinearVelocity(velocity);
	for (const panel of Object.values(vehicle.panels)) panel.body.setLinearVelocity(velocity);
	// Crush M1: the welded segment chain is seeded too, mirroring crashSetup() (see
	// vehicle/segments.ts's seedSegmentVelocities() doc comment).
	seedSegmentVelocities(vehicle.segments, velocity, vehicle.chassis);
}

/** Computes (and applies) the vehicle's launch velocity for this run: straight along spawn-forward
 * for the frontal/offset protocols (rotated by `angleDeg` about world-up for free-config's oblique-
 * angle slider), sideways (toward the protocol's struck side) for the pole rig, zero for the two
 * trolley protocols (the car stays parked; the trolley carries the closing speed). Returns the
 * velocity so main.ts can re-apply it every step during the guided approach (see
 * vehicleGuideUntilS()) -- see that function's doc comment for why a ONE-TIME velocity set isn't
 * enough for every protocol. */
export function launchVehicle(vehicle: Vehicle, protocol: CrashProtocol, freeConfig: FreeConfigState): V3 {
	const { speedKmh, angleDeg } = effectiveRunParams(protocol, freeConfig);
	const speedMs = speedKmh / 3.6;
	let direction: V3;
	if (protocol.barrier === 'rigid-pole') {
		direction = rotateVector(vehicle.spawnRotation, scale(LOCAL_RIGHT, sideSign(protocol.side)));
	} else if (protocol.barrier === 'mdb-trolley' || protocol.barrier === 'rear-trolley') {
		direction = { x: 0, y: 0, z: 0 }; // car stays parked; the trolley carries the closing speed
	} else {
		// Free-config angle: the car's VELOCITY vector is rotated about world-up, its chassis ORIENTATION
		// is not -- i.e. it approaches the barrier crabbed at an angle rather than the barrier itself
		// being re-angled. Cheap and deterministic, and it still produces a genuinely oblique impact
		// (an off-axis contact normal), which is what an "approach angle" slider is for.
		const angleRad = (angleDeg * Math.PI) / 180;
		const rotatedLocal: V3 = { x: Math.sin(angleRad), y: 0, z: Math.cos(angleRad) };
		direction = rotateVector(vehicle.spawnRotation, rotatedLocal);
	}
	const velocity = scale(direction, speedMs);
	applyVehicleVelocity(vehicle, velocity);
	return velocity;
}

/** Extra guided time (seconds) past the nominal geometric arrival time, mirroring
 * TROLLEY_GUIDE_IMPACT_BUFFER_S's rationale for the vehicle side of a run. NEEDED (not just belt-and-
 * suspenders): found via eyes-on review that a ONE-TIME velocity set on the pole protocol (pure lateral
 * launch, no throttle) bled off almost all of its speed within about a second -- the vehicle's own
 * lateral-grip driving assist (tuning.ts's LATERAL_GRIP_ASSIST_*, meant to give responsive cornering
 * feel during normal play) reads a purely-sideways chassis velocity as uncontrolled slip and actively
 * fights it, so the car stopped well short of the pole (measured: chassis peak decel ~3g, zero crush --
 * no contact ever happened at 6m/32km/h). Forward-launch protocols are far less affected (rolling
 * resistance along the wheels' own rolling direction is much weaker than the lateral-slip assist), but
 * re-guiding ALL protocols uniformly here is simpler than special-casing just the lateral one, and
 * matches this task's own brief ("car spawns on a guide ... deterministically") literally. */
export function vehicleGuideUntilS(protocol: CrashProtocol, freeConfig: FreeConfigState): number {
	const { speedKmh } = effectiveRunParams(protocol, freeConfig);
	const speedMs = Math.max(speedKmh / 3.6, 0.1);
	// CRUSH M2 RECALIBRATION (was `+ 0.15s` PAST the nominal center-to-center arrival time): the
	// guide must release the car BEFORE first contact. approachDistanceM is spawn-to-barrier-center,
	// so the NOSE (front overhang ~2.35m + barrier half-depth) arrives ~3m early -- the old
	// overshoot kept re-asserting launch velocity 10-20 fixed steps INTO the crash. The solid nose
	// shrugged that off (each re-fed step just re-stopped inelastically); the M2 energy-accounting
	// yield honestly converts every re-fed step into fresh structural collapse, so the guide
	// force-fed the crush through its whole budget and then slammed the exhausted (rigid) face at
	// full speed -- MEASURED at NHTSA-56: 97.7g chassis peak, both doors + trunk broken, 3 occupants
	// dead (vs the sim harness's clean staged ~35-45g stop for the same crash). Releasing 3m ahead
	// leaves the final ~0.2s ballistic -- the assists bleed <2% of the speed over that window (the
	// pole protocol's lateral-assist problem the guide exists for needs the guide only during the
	// long approach, not the last car-length).
	return Math.max(0.2, (protocol.approachDistanceM - 3.0) / speedMs);
}

/** Wall-clock (sim-time) budget for one run: guided run-up (distance/closing-speed) + a fixed settle
 * window, so main.ts knows when to flip from 'running' to 'settled'. */
export function runDurationS(protocol: CrashProtocol, freeConfig: FreeConfigState, settleS = 5): number {
	const { speedKmh } = effectiveRunParams(protocol, freeConfig);
	const speedMs = Math.max(speedKmh / 3.6, 0.1);
	return protocol.approachDistanceM / speedMs + settleS;
}
