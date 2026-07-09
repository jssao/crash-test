// SPDX-License-Identifier: MIT
//
// Damage system orchestrator (G3 spec): created in main.ts right after the vehicle, and equally by
// the headless sim tests (game/sim/damage-*.test.mjs) -- renderer-free (no three/DOM import). Owns
// the ONE central per-step world.hitEvents() drain (snapshotted into plain objects immediately, since
// the binding's HitEventsView is a live mutable cursor -- see src/ts/events.ts's module doc), and
// fans that single drain out to both the weld-stress/wheel-detach model (welds.ts) and the plastic-
// crumple pipeline (crumple.ts), so nothing double-consumes it.

import type { World } from '../../../src/ts/index.js';
import { sub, type Q4, type V3 } from '../vehicle/mathUtil';
import type { Vehicle, WheelKey } from '../vehicle/vehicle';
import {
	addDeformable,
	applyCrumpleEvent,
	createCrumpleRegistry,
	getDentedVertexCount,
	registerDeformable as registerDeformableMesh,
	type CrumpleRegistry,
	type DeformableKind,
	type DeformableMeshHandle,
} from './crumple';
import {
	PANEL_DESPAWN_AFTER_S,
	PANEL_DESPAWN_DISTANCE_M,
	PANEL_HIT_EVENTS_DISABLE_AFTER_S,
	STRESS_MIN_APPROACH_SPEED_MS,
} from './damage-tuning';
import { createDamageEventEmitter, DamageEventEmitter, type DamageEvent } from './events';
import { PANEL_KEYS, totalPanelMassKg, type PanelHandle, type PanelKey } from './panels';
import { hitTouchesCar, stepWeldsAndWheels, type HitEventLike } from './welds';

export interface DamageTelemetry {
	panelStates: Record<PanelKey, 'attached' | 'loosened' | 'broken'>;
	stressLevels: Record<PanelKey, number>;
	wheelStates: Record<WheelKey, 'attached' | 'detached'>;
	dentedVertexCount: number;
	glassShattered: string[];
}

export interface DamageSystem {
	readonly vehicle: Vehicle;
	readonly panels: Record<PanelKey, PanelHandle>;
	readonly registry: CrumpleRegistry;
	readonly emitter: DamageEventEmitter;
	carMassKg: number;
	timeSec: number;
	/** @internal welds.ts's per-wheel detach debounce counters -- see its doc comment. */
	readonly wheelOverThresholdSteps: Record<WheelKey, number>;
}

/**
 * Body-local frame lookup for a registered mesh's `attachedTo` tag ('chassis' or a PanelKey). Returns
 * null for a panel whose body has been despawned (destroyed -- see system.ts's despawn-timer logic)
 * so the caller can skip it entirely rather than touching a dead native handle (Body.getTransform()
 * on a destroyed body is a wasm-memory error, not a JS exception it could catch).
 */
function transformFor(system: DamageSystem, attachedTo: string): { position: V3; rotation: Q4 } | null {
	if (attachedTo === 'chassis') return system.vehicle.chassis.getTransform();
	const panel = system.panels[attachedTo as PanelKey];
	if (!panel || panel.despawned) return null;
	return panel.body.getTransform();
}

/** Sentinel point far outside any plausible crumple/stress radius, used to make a despawned panel's
 * mesh(es) fail the distance quick-reject cleanly instead of dereferencing a destroyed body. */
const FAR_AWAY_POINT: V3 = { x: 1e9, y: 1e9, z: 1e9 };
const UP_NORMAL: V3 = { x: 0, y: 1, z: 0 };

function conjugate(q: Q4): Q4 {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

// Local copy of mathUtil.ts's rotateVector (kept private here rather than importing it just for this
// one use, since inverse-rotation is this file's own concern, not a shared vehicle-core primitive).
function rotate(q: Q4, v: V3): V3 {
	const t = {
		x: 2 * (q.y * v.z - q.z * v.y),
		y: 2 * (q.z * v.x - q.x * v.z),
		z: 2 * (q.x * v.y - q.y * v.x),
	};
	return {
		x: v.x + q.w * t.x + (q.y * t.z - q.z * t.y),
		y: v.y + q.w * t.y + (q.z * t.x - q.x * t.z),
		z: v.z + q.w * t.z + (q.x * t.y - q.y * t.x),
	};
}

function worldToLocal(transform: { position: V3; rotation: Q4 }, worldPoint: V3, worldNormal: V3): { point: V3; normal: V3 } {
	const inv = conjugate(transform.rotation);
	return {
		point: rotate(inv, sub(worldPoint, transform.position)),
		normal: rotate(inv, worldNormal),
	};
}

/**
 * @param registry Pass an EXISTING registry (rather than the default fresh one) when rebuilding the
 * damage system for a full car repair (main.ts's R handler) -- reusing the same registry object
 * preserves every already-registered DeformableMeshHandle (and, critically, the exact object
 * identities game/src/scene/carDeformables.ts's bindings hold references to), so the caller only
 * needs to reset its contents (crumple.ts's resetCrumpleRegistry()) rather than re-registering every
 * mesh (which would otherwise re-capture whatever DEFORMED positions the THREE geometry currently
 * holds as the new "pristine" base -- permanently baking in damage instead of repairing it).
 */
export function createDamageSystem(vehicle: Vehicle, registry: CrumpleRegistry = createCrumpleRegistry()): DamageSystem {
	const carMassKg = vehicle.chassis.getMass() + totalPanelMassKg(vehicle.panels) + Object.values(vehicle.wheels).reduce((sum, w) => sum + w.body.getMass(), 0);
	const wheelOverThresholdSteps = {} as Record<WheelKey, number>;
	for (const key of Object.keys(vehicle.wheels) as WheelKey[]) wheelOverThresholdSteps[key] = 0;
	return {
		vehicle,
		panels: vehicle.panels,
		registry,
		emitter: createDamageEventEmitter(),
		carMassKg,
		timeSec: 0,
		wheelOverThresholdSteps,
	};
}

/** Registers one deformable mesh with the damage system's crumple registry. `attachedTo` is
 * 'chassis' (chassis-shell + most glass) or a PanelKey (that panel's own mesh(es) -- follows the
 * PANEL BODY's transform always, per the spec's "panel meshes follow their own body transform once
 * loosened/broken" -- see main.ts/game/src/scene/panelVisuals.ts for the visual-side reparenting this
 * implies while STILL attached, panel meshes stay parented under the car group in the renderer, but
 * their crumple LOCAL SPACE is always the panel body's frame regardless). */
export function registerDeformable(
	system: DamageSystem,
	id: string,
	kind: DeformableKind,
	attachedTo: 'chassis' | PanelKey,
	basePositions: Float32Array,
	indices: Uint32Array | Int32Array | null,
): DeformableMeshHandle {
	const mesh = registerDeformableMesh(id, kind, attachedTo, basePositions, indices);
	addDeformable(system.registry, mesh);
	return mesh;
}

/** Advances the damage system by one fixed step. Call AFTER stepVehicle()+world.step(). */
export function stepDamageSystem(system: DamageSystem, world: World, dt: number): void {
	system.timeSec += dt;

	// ---- ONE central hitEvents() drain for this step, snapshotted to plain objects immediately
	// (src/ts/events.ts's HitEventsView.at() mutates+returns a single cursor object -- see its module
	// doc -- so anything we want to iterate more than once, or after calling other code that might
	// itself touch the world, must be copied out first). ----
	const hitsView = world.hitEvents();
	const hits: HitEventLike[] = [];
	for (let i = 0; i < hitsView.count; i++) {
		const c = hitsView.at(i);
		hits.push({
			userDataA: c.userDataA,
			userDataB: c.userDataB,
			point: { x: c.point.x, y: c.point.y, z: c.point.z },
			normal: { x: c.normal.x, y: c.normal.y, z: c.normal.z },
			approachSpeed: c.approachSpeed,
		});
	}

	stepWeldsAndWheels({
		vehicle: system.vehicle,
		panels: system.panels,
		hits,
		carMassKg: system.carMassKg,
		timeSec: system.timeSec,
		wheelOverThresholdSteps: system.wheelOverThresholdSteps,
		emit: (e) => system.emitter.emit(e),
	});

	// ---- Plastic crumple: every qualifying hit (chassis or a still-attached/loosened panel) deforms
	// nearby registered meshes. ----
	for (const hit of hits) {
		if (hit.approachSpeed <= STRESS_MIN_APPROACH_SPEED_MS) continue;
		if (!hitTouchesCar(hit, system.panels)) continue;
		system.emitter.emit({ type: 'impact', severity: hit.approachSpeed, point: hit.point });
		const result = applyCrumpleEvent(system.registry, hit.approachSpeed, (mesh) => {
			const transform = transformFor(system, mesh.attachedTo);
			if (!transform) return { point: FAR_AWAY_POINT, normal: UP_NORMAL };
			return worldToLocal(transform, hit.point, hit.normal);
		});
		for (const meshId of result.shatteredNowMeshIds) system.emitter.emit({ type: 'glassShattered', mesh: meshId });
	}

	// ---- Broken-panel lifecycle: disable hit events after N seconds, despawn after M seconds or
	// beyond D meters from the chassis. ----
	for (const key of PANEL_KEYS) {
		const panel = system.panels[key];
		if (panel.state !== 'broken' || panel.despawned || panel.breakTimeSec === null) continue;
		const age = system.timeSec - panel.breakTimeSec;
		if (!panel.hitEventsDisabled && age > PANEL_HIT_EVENTS_DISABLE_AFTER_S) {
			panel.shape.enableHitEvents(false);
			panel.hitEventsDisabled = true;
		}
		const distFromCar = Math.hypot(
			panel.body.getPosition().x - system.vehicle.chassis.getPosition().x,
			panel.body.getPosition().y - system.vehicle.chassis.getPosition().y,
			panel.body.getPosition().z - system.vehicle.chassis.getPosition().z,
		);
		if (age > PANEL_DESPAWN_AFTER_S || distFromCar > PANEL_DESPAWN_DISTANCE_M) {
			// Explicitly destroy the shape BEFORE the body: destroying the body alone frees the shape
			// natively too, but leaves its JS-side Shape wrapper's box3d-js registry entry stuck "live"
			// forever (see ../../../src/ts/registry.ts's liveHandleCount(), and vehicle.ts's
			// destroyVehicle() doc comment for the same gotcha on the car's own bodies).
			panel.shape.destroy(false);
			panel.body.destroy();
			panel.despawned = true;
			system.emitter.emit({ type: 'panelDespawned', panel: key });
		}
	}
}

export function getDamageTelemetry(system: DamageSystem): DamageTelemetry {
	const panelStates = {} as Record<PanelKey, 'attached' | 'loosened' | 'broken'>;
	const stressLevels = {} as Record<PanelKey, number>;
	for (const key of PANEL_KEYS) {
		panelStates[key] = system.panels[key].state;
		stressLevels[key] = system.panels[key].stress;
	}
	const wheelStates = {} as Record<WheelKey, 'attached' | 'detached'>;
	for (const key of Object.keys(system.vehicle.wheels) as WheelKey[]) {
		wheelStates[key] = system.vehicle.wheels[key].joint ? 'attached' : 'detached';
	}
	const glassShattered = system.registry.meshes.filter((m) => m.kind === 'glass' && m.shattered).map((m) => m.id);
	return {
		panelStates,
		stressLevels,
		wheelStates,
		dentedVertexCount: getDentedVertexCount(system.registry),
		glassShattered,
	};
}

export type { DamageEvent };
