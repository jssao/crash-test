// SPDX-License-Identifier: MIT
//
// 'cardetail' WorldFeature: the dramatic-crash detail pass (docs/build-log/specs/engine-bay-spec.md)
// -- weld-attached physics bodies (engine bay, underbody/extremities -- the interior set was culled,
// see tuning.ts's top doc comment) that scatter on impact. See tuning.ts's top doc comment for the
// axis remap, mass policy, attachment simplification,
// and break-mechanism rationale; this file is the factory + per-step logic.
//
// PHYSICS-EVERYWHERE: every component is a real box3d Dynamic body (box or capsule shape), never a
// decorative static mesh the car can clip through -- satisfies this project's physics-everywhere
// directive on top of the spec's own scatter requirement.

import * as THREE from 'three';
import { Body, BodyType, forgetHandle, Shape, WeldJoint } from '../../../../../src/ts/index.js';
import type { FeatureContext, WorldFeature } from '../feature';
import { add, IDENTITY_Q, length, rotateVector, sub, type V3 } from '../../../vehicle/mathUtil';
import { CAR_GROUP_INDEX } from '../../../vehicle/tuning';
import { InterpolatedTransform } from '../../../core/loop';
import { buildCarDetailMaterials, disposeCarDetailMaterials, type CarDetailMaterials } from './materials';
import { SHAPE_BUILDERS } from './shapes';
import {
	BREAKS_EASILY_FORCE_N,
	BREAKS_EASILY_TORQUE_NM,
	CARDETAIL_BODY_ID_BASE,
	CARDETAIL_JOINT_ID_BASE,
	CAR_DETAIL_SPECS,
	COLLAPSE_DAMPING_RATIO,
	COLLAPSE_FORCE_N,
	COLLAPSE_HERTZ,
	COLLAPSE_TORQUE_NM,
	COLUMN_BREAK_FORCE_N,
	COLUMN_BREAK_TORQUE_NM,
	EXTERIOR_PROXY_IDS,
	MODELED_PROXY_IDS,
	FIRM_FORCE_N,
	FIRM_TORQUE_NM,
	OTHER_MISC,
	scaledMassKg,
	type CarDetailSpec,
} from './tuning';

type State = 'attached' | 'collapsed' | 'broken';

interface Handle {
	readonly spec: CarDetailSpec;
	readonly index: number;
	body: Body;
	shape: Shape;
	weld: WeldJoint | null;
	state: State;
	readonly mesh: THREE.Object3D;
	readonly transform: InterpolatedTransform;
	readonly spawnLocalCenter: V3;
}

function boxVolume(hx: number, hy: number, hz: number): number {
	return 8 * hx * hy * hz;
}

function capsuleVolume(length_: number, radius: number): number {
	return Math.PI * radius * radius * length_ + (4 / 3) * Math.PI * radius ** 3;
}

/** Builds (or rebuilds, after a break) this spec's collision shape on `body`, with the given
 * groupIndex (CAR_GROUP_INDEX while attached to the car's own no-self-collide group, 0/neutral once
 * broken -- exactly damage/panels.ts's breakPanelWeld() pattern).
 *
 * `isSensor` (true while attached/collapsed, false once broken): a RIGIDLY-welded component's world
 * position is 100% determined by the weld constraint, never by its own collision response -- so real
 * (non-sensor) collision while still attached serves no purpose and is actively harmful. FOUND
 * EMPIRICALLY (game/sim/features-cardetail.test.mjs's drive-up-to-a-wall scenario): several
 * components (seats/bench/pedal cluster, whose box centers sit low per the spec's H-point-style Y
 * values -- see tuning.ts's ground-clearance comments) clip the ground plane during ordinary
 * acceleration squat; being rigidly welded, that contact fights the weld every step instead of being
 * smoothly absorbed (no suspension of their own), which was measured to nearly stall the WHOLE car's
 * driveline, not just the clipping part -- 39 attached parts dropped a 34 km/h/2s baseline to <1 km/h.
 * Making attached/collapsed shapes sensors (still fully positioned via the weld, but generating no
 * contact response against the ground/wall/anything else) removes this failure mode entirely; once
 * broken, the shape is recreated as a real (non-sensor) shape so it can scatter/rest/collide normally,
 * matching the "scatters believably on impact" requirement. */
function createShapeFor(body: Body, spec: CarDetailSpec, groupIndex: number, bodyUserData: number, isSensor: boolean): Shape {
	const common = {
		density: 1, // overwritten below once we know the volume
		friction: OTHER_MISC.friction,
		restitution: OTHER_MISC.restitution,
		enableHitEvents: false,
		isSensor,
		groupIndex,
		userData: bodyUserData,
	};
	const massKg = scaledMassKg(spec);
	if (spec.phys === 'box') {
		const { hx, hy, hz } = spec.dims as { hx: number; hy: number; hz: number };
		const density = massKg / boxVolume(hx, hy, hz);
		return body.createBoxShape({ ...common, halfExtents: { x: hx, y: hy, z: hz }, density });
	}
	const { length: len, radius } = spec.dims as { length: number; radius: number };
	const half = len / 2;
	const density = massKg / capsuleVolume(len, radius);
	const axisOffset: V3 = spec.phys === 'capsuleX' ? { x: half, y: 0, z: 0 } : { x: 0, y: 0, z: half };
	return body.createCapsuleShape({
		...common,
		center1: { x: -axisOffset.x, y: -axisOffset.y, z: -axisOffset.z },
		center2: axisOffset,
		radius,
		density,
	});
}

/** Fallback proxy mesh (the ORIGINAL flat box/capsule look) -- only used if a spec.id ever falls
 * through shapes.ts's SHAPE_BUILDERS table (should never happen; every remaining id has a
 * dedicated builder, see shapes.ts's dispatch table doc comment), so this stays as a safety net
 * rather than a silently-invisible part. */
function buildFallbackProxy(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Object3D {
	const material = materials[spec.matKey] ?? materials.paintGeneric;
	if (spec.phys === 'box') {
		const { hx, hy, hz } = spec.dims as { hx: number; hy: number; hz: number };
		return new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), material);
	}
	const { length: len, radius } = spec.dims as { length: number; radius: number };
	return new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(len - 2 * radius, 0.001), 4, 8), material);
}

/** Builds this component's SHAPED visual mesh (shapes.ts -- ribbed valve covers, spiral-volute
 * turbos, finned radiator cores, curved hoses with clamps, seat base+backrest+bolsters, torus+
 * spokes steering wheels, etc., per docs/build-log/specs/engine-bay-spec.md's per-component
 * "real-world look"). Every builder in shapes.ts works in a CANONICAL local frame (box specs: the
 * spec's own X=lateral/Y=up/Z=forward frame directly; capsule specs: length along +Y, matching
 * CapsuleGeometry/CylinderGeometry's default axis) -- this function applies the same final wrapper
 * rotation the original generic capsule code used (capsuleZ -> rotateX(PI/2), capsuleX ->
 * rotateZ(PI/2)) so every builder never has to think in Z-/X-aligned terms itself. Visual meshes may
 * exceed their own collision box/capsule slightly (locked in tuning.ts) -- these are welded parts;
 * collision fidelity is secondary to looks, per this task's brief. */
function buildMeshFor(spec: CarDetailSpec, materials: CarDetailMaterials): THREE.Object3D {
	const builder = SHAPE_BUILDERS[spec.id];
	const mesh = builder ? builder(spec, materials) : buildFallbackProxy(spec, materials);
	if (spec.phys === 'capsuleZ') mesh.rotateX(Math.PI / 2);
	else if (spec.phys === 'capsuleX') mesh.rotateZ(Math.PI / 2);
	mesh.traverse((obj) => {
		if (obj instanceof THREE.Mesh) {
			obj.castShadow = true;
			obj.receiveShadow = true;
		}
	});
	return mesh;
}

function tierForStrength(strength: CarDetailSpec['strength']): { force: number; torque: number } | null {
	if (strength === 'breaksEasily') return { force: BREAKS_EASILY_FORCE_N, torque: BREAKS_EASILY_TORQUE_NM };
	if (strength === 'firm') return { force: FIRM_FORCE_N, torque: FIRM_TORQUE_NM };
	if (strength === 'collapsible') return { force: COLLAPSE_FORCE_N, torque: COLLAPSE_TORQUE_NM };
	return null; // 'rigid': never set a threshold -- stays at upstream's FLT_MAX default (never breaks).
}

export default function createCarDetailFeature(ctx: FeatureContext): WorldFeature {
	const materials = buildCarDetailMaterials();
	const handles: Handle[] = [];
	/** joint userData -> handle, for O(1) lookup against World.jointEvents() each fixed step. */
	const jointIndex = new Map<number, Handle>();

	function spawnAll(): void {
		const vehicle = ctx.getVehicle();
		const chassis = vehicle.chassis;
		const spawnPosition = vehicle.spawnPosition;
		const spawnRotation = vehicle.spawnRotation;

		for (let i = 0; i < CAR_DETAIL_SPECS.length; i++) {
			const spec = CAR_DETAIL_SPECS[i];
			const bodyUserData = CARDETAIL_BODY_ID_BASE + i;
			const jointUserData = CARDETAIL_JOINT_ID_BASE + i;

			const worldPos = add(spawnPosition, rotateVector(spawnRotation, spec.localCenter));
			const body = ctx.world.createBody({
				type: BodyType.Dynamic,
				position: worldPos,
				rotation: spawnRotation,
				userData: bodyUserData,
			});
			const shape = createShapeFor(body, spec, CAR_GROUP_INDEX, bodyUserData, true);

			const weld = ctx.world.createWeldJoint(chassis, body, {
				frameA: { position: spec.localCenter, rotation: IDENTITY_Q },
				frameB: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_Q },
				collideConnected: false,
				linearHertz: 0,
				angularHertz: 0,
				linearDampingRatio: 1,
				angularDampingRatio: 1,
				userData: jointUserData,
			});
			// Break thresholds are armed a short grace period later (see armThresholds() below) --
			// deliberately NOT set here at creation time.

			let mesh: THREE.Object3D;
			let transform: InterpolatedTransform;
			const existing = handles[i];
			if (existing) {
				mesh = existing.mesh;
				transform = existing.transform;
			} else {
				mesh = buildMeshFor(spec, materials);
				ctx.scene.add(mesh);
				transform = new InterpolatedTransform();
			}
			// Set the correct attached-state visibility immediately at spawn/respawn -- don't wait for
			// the first applyVisuals() call (THREE.Object3D.visible defaults to true, which would leak an
			// exterior proxy for one frame, and the headless sim test never calls applyVisuals() at all).
			if (MODELED_PROXY_IDS.has(spec.id)) mesh.visible = false; // modeled GLB mesh renders it instead
			else if (spec.engineBay) mesh.visible = vehicle.panels.hood.state !== 'attached';
			else if (EXTERIOR_PROXY_IDS.has(spec.id)) mesh.visible = false;
			else mesh.visible = true;
			transform.sample(worldPos, spawnRotation);
			transform.sample(worldPos, spawnRotation); // fill prev+curr, no lerp-from-old-pose on (re)spawn

			const handle: Handle = { spec, index: i, body, shape, weld, state: 'attached', mesh, transform, spawnLocalCenter: spec.localCenter };
			jointIndex.set(jointUserData, handle);
			handles[i] = handle;
		}
	}

	function breakComponent(handle: Handle): void {
		if (handle.weld) {
			handle.weld.destroy();
			handle.weld = null;
		}
		handle.shape.destroy(false);
		// DELIBERATE DEVIATION from damage/panels.ts's breakPanelWeld(): panels sit at the car's
		// EXTERIOR surface, so flipping to a neutral (0) group so a broken panel can bounce off the
		// car body is exactly the desired crash visual. Every cardetail component instead starts fully
		// EMBEDDED inside the chassis hull's own convex collision shape (interior/engine-bay parts are,
		// by definition, inside the exterior shell while attached) -- giving a freshly-broken one a
		// neutral group was found to make it instantly, violently interpenetration-resolve against the
		// hull it was always sitting inside, which measurably fights the chassis's own motion (see
		// createShapeFor()'s isSensor doc comment for the matching ground-clipping failure mode this
		// shares the same root cause with). Keeping CAR_GROUP_INDEX post-break means a scattered part
		// still never collides with the chassis/wheels/panels/other cardetail parts, only the ground/
		// walls/world -- it can fly out through the (now-open, per the hood/door panel system) body
		// opening and land in the world, just never explosively off the car's own hull.
		handle.shape = createShapeFor(handle.body, handle.spec, CAR_GROUP_INDEX, CARDETAIL_BODY_ID_BASE + handle.index, false);
		handle.state = 'broken';
	}

	function collapseColumn(handle: Handle): void {
		const weld = handle.weld;
		if (!weld) return;
		weld.setLinearHertz(COLLAPSE_HERTZ);
		weld.setAngularHertz(COLLAPSE_HERTZ);
		weld.setLinearDampingRatio(COLLAPSE_DAMPING_RATIO);
		weld.setAngularDampingRatio(COLLAPSE_DAMPING_RATIO);
		weld.setForceThreshold(COLUMN_BREAK_FORCE_N);
		weld.setTorqueThreshold(COLUMN_BREAK_TORQUE_NM);
		handle.state = 'collapsed';
	}

	/**
	 * Fixed steps since spawn/reset before break thresholds are armed (weld.setForceThreshold() called
	 * for the first time on every still-attached joint). FOUND EMPIRICALLY: box3d's own post-spawn
	 * settle transient (WHEEL_SPAWN_SETTLE_MARGIN_M's deliberate small initial ground penetration +
	 * the suspension spring's ~0.15s catch-up, see vehicle.ts's SUSPENSION_SETTLE_GRACE_STEPS doc
	 * comment for the analogous wheel-side transient) produces a single-fixed-step constraint-force
	 * spike on SEVERAL cardetail welds simultaneously (measured: radiatorFan ~101N, intercooler ~90N,
	 * both right at/above BREAKS_EASILY_FORCE_N, at step 9 of a cold spawn with zero input whatsoever)
	 * -- indistinguishable from a real light hit by force magnitude alone. This is the same class of
	 * transient the vehicle's own SUSPENSION_SETTLE_GRACE_STEPS already exists to paper over for the
	 * ground-contact heuristic; 30 steps (0.5s, comfortably past the measured ~9-step/0.15s spike and
	 * its brief decay) is ample margin before any real gameplay input (or the sim test's own drive/
	 * crash sequence) could plausibly begin.
	 */
	const THRESHOLD_ARM_GRACE_STEPS = 30;
	let stepsSinceSpawn = 0;
	let thresholdsArmed = false;

	function armThresholds(): void {
		for (const h of handles) {
			if (h.state !== 'attached' || !h.weld) continue;
			const tier = tierForStrength(h.spec.strength);
			if (!tier) continue; // 'rigid': stays at the upstream FLT_MAX default (never breaks).
			h.weld.setForceThreshold(tier.force);
			h.weld.setTorqueThreshold(tier.torque);
		}
		thresholdsArmed = true;
	}

	spawnAll();

	function destroyAll(): void {
		for (const h of handles) {
			if (h.weld) {
				// CHASSIS-ATTACHED-JOINT LIFECYCLE HAZARD (same as occupants/physics.ts's doc comment):
				// every cardetail weld attaches to the CHASSIS, and by the time reset() fires,
				// doCarRepair()'s destroyVehicle() has already natively freed every chassis-attached
				// joint as a side effect -- calling .destroy() here double-frees native memory (wasm
				// "memory access out of bounds", 100% repro on resetWorld(), permanently poisons the
				// module). forgetHandle() drops JS registry bookkeeping ONLY; the native joint is freed
				// either by that chassis teardown (already happened) or by h.body.destroy() just below
				// (a joint dies with EITHER attached body), so this leaks nothing in both reset kinds.
				forgetHandle(h.weld.handle, 'joint');
				h.weld = null;
			}
			h.shape.destroy(false);
			h.body.destroy();
		}
		jointIndex.clear();
	}

	return {
		name: 'cardetail',

		afterFixedStep(): void {
			if (!thresholdsArmed) {
				stepsSinceSpawn++;
				if (stepsSinceSpawn >= THRESHOLD_ARM_GRACE_STEPS) armThresholds();
			}
			const events = ctx.world.jointEvents();
			for (let i = 0; i < events.count; i++) {
				const ev = events.at(i);
				const handle = jointIndex.get(ev.userData);
				if (!handle) continue;
				if (handle.state === 'attached') {
					if (handle.spec.strength === 'collapsible') collapseColumn(handle);
					else breakComponent(handle);
				} else if (handle.state === 'collapsed') {
					breakComponent(handle);
				}
			}
			for (const h of handles) {
				const t = h.body.getTransform();
				h.transform.sample(t.position, t.rotation);
			}
		},

		applyVisuals(alpha: number): void {
			// Occlusion: engine-bay parts are hidden while the hood is still attached (spec: "just there,
			// hood mesh covers them") -- ctx.getVehicle() called fresh (never cached, see feature.ts's
			// warning #2 -- the vehicle/its panels are replaced wholesale on every car repair).
			const hoodAttached = ctx.getVehicle().panels.hood.state === 'attached';
			for (const h of handles) {
				h.transform.applyTo(h.mesh, alpha);
				if (MODELED_PROXY_IDS.has(h.spec.id)) {
					// The modeled EngineBlock GLB mesh renders the engine; this procedural proxy is invisible
					// while attached and only shows as flying debris once it detaches (like the exterior proxies).
					h.mesh.visible = h.state !== 'attached';
				} else if (h.spec.engineBay) {
					h.mesh.visible = !hoodAttached;
				} else if (EXTERIOR_PROXY_IDS.has(h.spec.id)) {
					// VISIBILITY POLICY (orchestrator directive, see tuning.ts's EXTERIOR_PROXY_IDS doc
					// comment): the GLB body already renders painted headlights/taillights/mirrors/bumper
					// covers at these spots, so the grey collision proxy stays invisible while still
					// `attached` and only appears once it has actually detached (flying debris on impact).
					h.mesh.visible = h.state !== 'attached';
				}
			}
		},

		reset(): void {
			// Full rebuild (destroy every body/shape/joint, spawn fresh at the CURRENT chassis spawn
			// pose) regardless of 'car' vs 'world' -- idempotent either way (feature.ts's contract: a
			// world reset fires reset('car') then reset('world'), both must be safe to call). Meshes/
			// transforms are reused in place (spawnAll() above), not recreated, so this never touches
			// ctx.scene's child list after the very first spawn.
			destroyAll();
			spawnAll();
			// New bodies/welds need the same post-spawn settle grace window as the very first spawn
			// (see THRESHOLD_ARM_GRACE_STEPS's doc comment) before thresholds are (re-)armed.
			stepsSinceSpawn = 0;
			thresholdsArmed = false;
		},

		bodyCount(): number {
			return handles.length;
		},

		hooks: {
			detachedCount: () => handles.filter((h) => h.state !== 'attached').length,
			/** Read-only diagnostic: the live Body handle per component (perf-bench-full.mjs's
			 * awake-count/force-wake instrumentation needs direct handles -- cardetail has no
			 * separate bodies.ts module like trees/buildings/occupants do, so this hook is the
			 * equivalent accessor). Never mutates state itself. */
			bodies: () => handles.map((h) => h.body),
			states: () => Object.fromEntries(handles.map((h) => [h.spec.id, h.state])),
			/** Diagnostic/test hook: current THREE mesh.visible per component -- lets
			 * cardetail-containment.test.mjs assert the "exterior proxies are invisible while attached"
			 * visibility policy (tuning.ts's EXTERIOR_PROXY_IDS) without a scene/renderer. */
			meshVisible: () => Object.fromEntries(handles.map((h) => [h.spec.id, h.mesh.visible])),
			/** Diagnostic: current weld constraint-force magnitude (N) per component, or null once
			 * broken (no weld left to read). Useful for calibrating tuning.ts's break thresholds. */
			constraintForces: () => Object.fromEntries(handles.map((h) => [h.spec.id, h.weld ? length(h.weld.getConstraintForce()) : null])),
			constraintTorques: () => Object.fromEntries(handles.map((h) => [h.spec.id, h.weld ? length(h.weld.getConstraintTorque()) : null])),
			/** Distance (meters) each part has traveled from its current weld-attached rest offset from
			 * the chassis -- 0 while rigidly attached, grows once broken/collapsed and scattering. */
			displacements: () => {
				const vehicle = ctx.getVehicle();
				const t = vehicle.chassis.getTransform();
				return handles.map((h) => {
					const expected = add(t.position, rotateVector(t.rotation, h.spawnLocalCenter));
					return length(sub(h.body.getPosition(), expected));
				});
			},
			debugArmed: () => thresholdsArmed,
			debugThresholds: () => Object.fromEntries(handles.map((h) => [h.spec.id, h.weld ? { f: h.weld.getForceThreshold(), t: h.weld.getTorqueThreshold() } : null])),
		},

		dispose(): void {
			destroyAll();
			for (const h of handles) {
				h.mesh.traverse((obj) => {
					if (obj instanceof THREE.Mesh) {
						obj.geometry.dispose();
					}
				});
				ctx.scene.remove(h.mesh);
			}
			disposeCarDetailMaterials(materials);
		},
	};
}

export type { Handle as CarDetailHandle };
