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
	GLASS_PANE_SHATTER_MIN_APPROACH_MS,
	PANEL_HULL_GROW_CAP_M,
	PANEL_HULL_MIN_HALF_M,
	PANEL_HULL_REFRESH_DELTA_M,
	PANEL_HULL_REFRESH_FOLLOWUP_DELTA_M,
	PANEL_HULL_REFRESH_MIN_STEPS,
	PANEL_DESPAWN_AFTER_S,
	PANEL_DESPAWN_DISTANCE_M,
	PANEL_HIT_EVENTS_DISABLE_AFTER_S,
	STRESS_MIN_APPROACH_SPEED_MS,
	WINDSHIELD_SHATTER_FRONT_CRUSH_M,
} from './damage-tuning';
import { createDamageEventEmitter, DamageEventEmitter, type DamageEvent } from './events';
import { PANEL_ENTITY_ID, PANEL_KEYS, totalPanelMassKg, type PanelHandle, type PanelKey } from './panels';
import { hitTouchesCar, massAwareDamageFactor, stepWeldsAndWheels, type HitEventLike } from './welds';
import { CAR_ENTITY_ID, GLASS_ENTITY_ID, GLASS_MESH_NODE } from '../vehicle/vehicle';
import { CORE_ENTITY_ID, FRONT_CHAIN_HIT_IDS, getSegmentTelemetry, REAR_CHAIN_HIT_IDS, SEGMENT_ENTITY_ID, stepSegmentYield, type SegmentTelemetry } from '../vehicle/segments';
import { OCCUPANT_ENTITY_ID_BASE, OCCUPANT_ENTITY_ID_END } from '../vehicle/tuning';
import type { GlassPaneKey } from '../vehicle/geometry';

/** Every entity id the car itself tags onto a body/shape (chassis 1, wheels 2-5, panels 6-11, glass
 * panes 12-13, crush segments 14-22, crush cores 23-25) -- the complement is "a foreign obstacle",
 * whose mass (if a registered dynamic body) attenuates car damage. Built once from the authoritative
 * id tables so it can never drift from them. */
const CAR_ENTITY_IDS: ReadonlySet<number> = new Set<number>([
	CAR_ENTITY_ID.chassis,
	...Object.values(CAR_ENTITY_ID.wheel),
	...Object.values(PANEL_ENTITY_ID),
	...Object.values(GLASS_ENTITY_ID),
	...Object.values(SEGMENT_ENTITY_ID),
	...Object.values(CORE_ENTITY_ID),
]);

/** Reverse lookup: glass entity id -> pane key ('windshield' | 'rearWindow'). */
const GLASS_PANE_BY_ID: ReadonlyMap<number, GlassPaneKey> = new Map(
	(Object.entries(GLASS_ENTITY_ID) as [GlassPaneKey, number][]).map(([key, id]) => [id, key]),
);

/** True when a hit-event entity id is an occupant ragdoll capsule's (see the central drain below). */
function isOccupantEntityId(id: number): boolean {
	return id >= OCCUPANT_ENTITY_ID_BASE && id < OCCUPANT_ENTITY_ID_END;
}

/** The registered mass (kg) of the NON-car body in `hit`, or undefined when the other side is static/
 * unknown, both sides are the car (self-contact), or neither side is the car (not our hit). Undefined
 * -> massAwareDamageFactor() returns 1 -> unchanged behavior. */
function foreignMassForHit(system: DamageSystem, userDataA: number, userDataB: number): number | undefined {
	const aCar = CAR_ENTITY_IDS.has(userDataA);
	const bCar = CAR_ENTITY_IDS.has(userDataB);
	let otherId: number;
	if (aCar && !bCar) otherId = userDataB;
	else if (bCar && !aCar) otherId = userDataA;
	else return undefined;
	return system.foreignMasses.get(otherId);
}

export interface DamageTelemetry {
	panelStates: Record<PanelKey, 'attached' | 'loosened' | 'sprung' | 'broken'>;
	stressLevels: Record<PanelKey, number>;
	wheelStates: Record<WheelKey, 'attached' | 'detached'>;
	dentedVertexCount: number;
	glassShattered: string[];
	/** Crush M2: the mechanical crush / intrusion readout (segment displacement + core face retreat --
	 * see vehicle/segments.ts's SegmentTelemetry). */
	segments: SegmentTelemetry;
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
	/**
	 * entity id (foreign body userData) -> its effective mass (kg), for the mass-aware damage weighting
	 * (a light plank/brick/sapling transmits only e = m/(m+carMass) of the crush/stress a wall would).
	 * Populated by obstacle owners at spawn via setForeignMass() -- a body must carry a matching non-car
	 * userData tag AND be registered here to be treated as light; anything unregistered stays "wall-like"
	 * (factor 1), so this is opt-in and cannot regress static walls/trees/ground. See system.ts's
	 * foreignMassForHit() + welds.ts's massAwareDamageFactor().
	 */
	readonly foreignMasses: Map<number, number>;
	/** @internal crush M3 (crush-architecture.md §B) panel hull-refresh bookkeeping -- see
	 * refreshPanelHulls(). `refreshes` doubles as the observable "collision followed the dents"
	 * counter the sim test asserts. */
	readonly panelHull: {
		fixedStep: number;
		perPanel: Record<PanelKey, { lastRefreshStep: number; meshAabb0: { min: V3; max: V3 } | null; aabbAtRefresh: { min: V3; max: V3 } | null }>;
		refreshes: Record<PanelKey, number>;
	};
}

/** Registers (or updates) a foreign body's effective mass so contacts against it attenuate car damage.
 * `entityId` must be the same value the body/shape was tagged with (Body/Shape userData) and must be
 * outside the car's reserved 1-10 range (a car id is ignored -- self-contacts never attenuate). */
export function setForeignMass(system: DamageSystem, entityId: number, massKg: number): void {
	if (CAR_ENTITY_IDS.has(entityId)) return;
	system.foreignMasses.set(entityId, massKg);
}

/** Forgets one foreign body's mass (e.g. it was destroyed) -- subsequent contacts against `entityId`
 * revert to wall-like full damage. No-op if it wasn't registered. */
export function clearForeignMass(system: DamageSystem, entityId: number): void {
	system.foreignMasses.delete(entityId);
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
export function createDamageSystem(
	vehicle: Vehicle,
	registry: CrumpleRegistry = createCrumpleRegistry(),
	// Pass an EXISTING map (same rationale as `registry` above) when rebuilding the damage system on a
	// car repair -- foreign masses describe WORLD obstacles, not the car, so they should survive the
	// car being rebuilt; a fresh default is correct only for a from-scratch construction.
	foreignMasses: Map<number, number> = new Map<number, number>(),
): DamageSystem {
	const carMassKg = vehicle.chassis.getMass() + totalPanelMassKg(vehicle.panels) + Object.values(vehicle.wheels).reduce((sum, w) => sum + w.body.getMass(), 0);
	const wheelOverThresholdSteps = {} as Record<WheelKey, number>;
	for (const key of Object.keys(vehicle.wheels) as WheelKey[]) wheelOverThresholdSteps[key] = 0;
	const perPanel = {} as DamageSystem['panelHull']['perPanel'];
	const refreshes = {} as Record<PanelKey, number>;
	for (const key of PANEL_KEYS) {
		perPanel[key] = { lastRefreshStep: -Infinity, meshAabb0: null, aabbAtRefresh: null };
		refreshes[key] = 0;
	}
	return {
		vehicle,
		panels: vehicle.panels,
		registry,
		emitter: createDamageEventEmitter(),
		carMassKg,
		timeSec: 0,
		wheelOverThresholdSteps,
		foreignMasses,
		panelHull: { fixedStep: 0, perPanel, refreshes },
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

/**
 * Shatters one glass pane (Tier-3 Stage 2): destroys the SOLID pane shape (updateBodyMass=false so
 * the chassis's setMassData() parity stamp survives) and nulls the handle -- the cabin aperture is
 * genuinely open from this step on -- then marks the matching registered glass DEFORMABLE mesh(es)
 * shattered so getDamageTelemetry()/the browser reset path stay consistent, and emits the SAME
 * glassShattered event the crumple pipeline uses (main.ts's material swap runs identically). Emits
 * per registered mesh id when one exists (browser), else once with the car-map node name (headless
 * sims register no meshes but tests still observe the event). Idempotent per pane. */
function shatterGlassPane(system: DamageSystem, paneKey: GlassPaneKey, viaCrumpleVisual = false): void {
	const pane = system.vehicle.glass[paneKey];
	if (!pane.shape) return;
	pane.shape.destroy(false);
	pane.shape = null;
	// When the CRUMPLE model shattered the visual first, it already marked the mesh + emitted its own
	// glassShattered -- this call only needed to open the physical aperture, so stop here (no
	// double-emit).
	if (viaCrumpleVisual) return;
	const node = GLASS_MESH_NODE[paneKey];
	// Registered glass deformable ids embed the mesh node name: `glass-<meshName>-<n>`
	// (game/src/scene/carDeformables.ts).
	let emitted = false;
	for (const mesh of system.registry.meshes) {
		if (mesh.kind !== 'glass' || !mesh.id.includes(node) || mesh.shattered) continue;
		mesh.shattered = true;
		system.emitter.emit({ type: 'glassShattered', mesh: mesh.id });
		emitted = true;
	}
	if (!emitted) system.emitter.emit({ type: 'glassShattered', mesh: node });
}

/** Advances the damage system by one fixed step. Call AFTER stepVehicle()+world.step(). */
// ---------------------------------------------------------------------------------------------
// CRUSH M3 -- collision follows the dents (crush-architecture.md §B): once a panel's accumulated
// cosmetic crumple has moved its deformed-mesh AABB far enough (the TRIGGER -- the collision-visible
// part of the spec's max-vertex delta; purely in-plane vertex slide leaves any convex proxy
// unchanged and is correctly ignored), rebuild that panel's collision hull in place via Shape.setHull
// (M0b machinery). REBUILD RULE (measured evolution from the spec's AABB sketch): the slab follows
// the mean deflection of the DENTED vertices per axis -- the pristine box's faces each shift by the
// mean offset component over vertices that have genuinely moved (>1cm). A convex hull cannot hold a
// bowl: rebuilding from the raw deformed AABB only THICKENS the slab toward the dent (the rim pins
// the far face -- measured: a 0.12m hood dent left the top face byte-identical and a probe rested
// at the pristine height), and an ALL-vertex mean is diluted to nothing by the undented rim
// (measured -0.011m for a 12/36-vertex dent). The dented-region mean (measured -0.033m for the
// same dent) is what the contact patch on the crushed region actually feels, so debris/bodies
// genuinely rest INTO dented panels (sim/panel-hull-refresh.test.mjs) at the cost of the undented
// rim's collision sinking by the same bounded amount -- the right trade for a 5cm cosmetic slab.
// Rate limits per spec §B: a panel rebuilds >=PANEL_HULL_REFRESH_MIN_STEPS apart and at most ONE
// panel rebuilds per fixed step. Outward growth capped, per-axis extent floored (tuning constants).
// setHull never recomputes body mass, so panel mass/inertia stay stable.
// ---------------------------------------------------------------------------------------------
function refreshPanelHulls(system: DamageSystem): void {
	const step = system.panelHull.fixedStep;
	for (const key of PANEL_KEYS) {
		const panel = system.panels[key];
		if (panel.despawned || !panel.shape.isValid()) continue;
		const st = system.panelHull.perPanel[key];
		if (step - st.lastRefreshStep < PANEL_HULL_REFRESH_MIN_STEPS) continue;
		// Deformed-mesh AABB (trigger) + mean offset per axis (rebuild), panel-local -- panel meshes
		// register in their own body's space.
		let count = 0;
		let dentedCount = 0;
		const min = { x: Infinity, y: Infinity, z: Infinity };
		const max = { x: -Infinity, y: -Infinity, z: -Infinity };
		const meanOff = { x: 0, y: 0, z: 0 };
		for (const mesh of system.registry.meshes) {
			if (mesh.kind !== 'panel' || mesh.attachedTo !== key) continue;
			for (let v = 0; v < mesh.vertexCount; v++) {
				const ox = mesh.offsets[v * 3];
				const oy = mesh.offsets[v * 3 + 1];
				const oz = mesh.offsets[v * 3 + 2];
				const x = mesh.basePositions[v * 3] + ox;
				const y = mesh.basePositions[v * 3 + 1] + oy;
				const z = mesh.basePositions[v * 3 + 2] + oz;
				if (x < min.x) min.x = x;
				if (y < min.y) min.y = y;
				if (z < min.z) min.z = z;
				if (x > max.x) max.x = x;
				if (y > max.y) max.y = y;
				if (z > max.z) max.z = z;
				if (ox * ox + oy * oy + oz * oz > 0.0001) {
					meanOff.x += ox;
					meanOff.y += oy;
					meanOff.z += oz;
					dentedCount++;
				}
				count++;
			}
		}
		if (count === 0) continue;
		if (dentedCount > 0) {
			meanOff.x /= dentedCount;
			meanOff.y /= dentedCount;
			meanOff.z /= dentedCount;
		}
		if (!st.meshAabb0) {
			// First sighting = the pristine mesh AABB (deltas are measured against this) -- captured
			// lazily so the browser's real GLB meshes and the sim harness's grid proxies both work.
			st.meshAabb0 = { min: { ...min }, max: { ...max } };
			st.aabbAtRefresh = { min: { ...min }, max: { ...max } };
			continue;
		}
		const ref = st.aabbAtRefresh!;
		const deltaSinceRefresh = Math.max(
			Math.abs(min.x - ref.min.x), Math.abs(min.y - ref.min.y), Math.abs(min.z - ref.min.z),
			Math.abs(max.x - ref.max.x), Math.abs(max.y - ref.max.y), Math.abs(max.z - ref.max.z),
		);
		const triggerM = system.panelHull.refreshes[key] > 0 ? PANEL_HULL_REFRESH_FOLLOWUP_DELTA_M : PANEL_HULL_REFRESH_DELTA_M;
		if (deltaSinceRefresh < triggerM) continue;
		// Rebuild: pristine collision box, each axis' faces shifted by the mesh's MEAN offset along
		// that axis (see the section doc), shift capped at the outward-growth bound.
		const he = panel.halfExtents;
		const clampShift = (v: number): number => Math.max(-PANEL_HULL_GROW_CAP_M - 2 * he.y, Math.min(PANEL_HULL_GROW_CAP_M + 2 * he.y, v));
		const lo = {
			x: -he.x + clampShift(meanOff.x),
			y: -he.y + clampShift(meanOff.y),
			z: -he.z + clampShift(meanOff.z),
		};
		const hi = {
			x: he.x + clampShift(meanOff.x),
			y: he.y + clampShift(meanOff.y),
			z: he.z + clampShift(meanOff.z),
		};
		for (const axis of ['x', 'y', 'z'] as const) {
			if (hi[axis] - lo[axis] < 2 * PANEL_HULL_MIN_HALF_M) {
				const mid = (hi[axis] + lo[axis]) / 2;
				lo[axis] = mid - PANEL_HULL_MIN_HALF_M;
				hi[axis] = mid + PANEL_HULL_MIN_HALF_M;
			}
		}
		const pts = new Float32Array(24);
		let i = 0;
		for (const x of [lo.x, hi.x]) for (const y of [lo.y, hi.y]) for (const z of [lo.z, hi.z]) {
			pts[i++] = x; pts[i++] = y; pts[i++] = z;
		}
		panel.shape.setHull(pts);
		st.lastRefreshStep = step;
		st.aabbAtRefresh = { min: { ...min }, max: { ...max } };
		system.panelHull.refreshes[key]++;
		return; // <=1 panel per fixed step
	}
}

export function stepDamageSystem(system: DamageSystem, world: World, dt: number): void {
	system.timeSec += dt;

	// ---- ONE central hitEvents() drain for this step, snapshotted to plain objects immediately
	// (src/ts/events.ts's HitEventsView.at() mutates+returns a single cursor object -- see its module
	// doc -- so anything we want to iterate more than once, or after calling other code that might
	// itself touch the world, must be copied out first). ----
	const hitsView = world.hitEvents();
	const hits: HitEventLike[] = [];
	// Crush M2: which crush-core/segment shapes were struck this step (vehicle/segments.ts
	// CORE_ENTITY_ID / SEGMENT_ENTITY_ID) -- the engagement + contact evidence stepSegmentYield()
	// needs (its CoreHitFlags doc).
	const coreHits = { pos: false, neg: false, rear: false, frontChain: false, rearChain: false };
	const FRONT_CHAIN_IDS = FRONT_CHAIN_HIT_IDS;
	const REAR_CHAIN_IDS = REAR_CHAIN_HIT_IDS;
	for (let i = 0; i < hitsView.count; i++) {
		const c = hitsView.at(i);
		// ---- GLASS PANE hits (Tier-3 Stage 2) are consumed HERE, by the glass model alone: an
		// occupant/debris strike on a pane shatters it (above threshold), and the hit NEVER reaches the
		// crumple/weld models below -- panes are interior safety glass, not body metal, and keeping
		// them out of `hits` keeps the crumple/weld pipelines byte-identical to the pane-less chassis
		// (the panes sit fully inside the nose/tail crush volumes, so world contacts can't ordinarily
		// reach them anyway -- see geometry.ts's Stage-2 section doc).
		const paneKey = GLASS_PANE_BY_ID.get(c.userDataA) ?? GLASS_PANE_BY_ID.get(c.userDataB);
		if (paneKey !== undefined) {
			if (c.approachSpeed > GLASS_PANE_SHATTER_MIN_APPROACH_MS) shatterGlassPane(system, paneKey);
			continue;
		}
		// ---- OCCUPANT-sourced hits (Tier-3 Stage 2) never reach the crumple/weld models either: a
		// seated/tumbling ragdoll capsule really collides with the cabin interior shells now, those
		// shells carry enableHitEvents, and occupant bodies are not registered foreign masses -- an
		// un-excluded 1.6kg forearm brushing the sill would crumple the car at full unattenuated
		// obstacle weight. Occupants interact with the damage model exclusively through the GLASS
		// pane path above. (Band registered in vehicle/tuning.ts next to the filter-bit registry.)
		if (isOccupantEntityId(c.userDataA) || isOccupantEntityId(c.userDataB)) continue;
		// Crush evidence must be a STRUCTURAL press (mostly-horizontal contact normal): a nose-dive /
		// tail-drag grinding the crush zone against the GROUND is a vertical-normal contact and says
		// nothing about a barrier at the faces -- MEASURED: the lab's NHTSA run nose-dives hard enough
		// to kiss both half-core bottoms on the tarmac, which latched BOTH cores every step and
		// symmetrized (and destabilized) the collapse.
		if (Math.abs(c.normal.y) < 0.5) {
			for (const id of [c.userDataA, c.userDataB]) {
				if (id === CORE_ENTITY_ID.frontPos) coreHits.pos = true;
				else if (id === CORE_ENTITY_ID.frontNeg) coreHits.neg = true;
				else if (id === CORE_ENTITY_ID.rear) coreHits.rear = true;
				if (FRONT_CHAIN_IDS.has(id)) coreHits.frontChain = true;
				else if (REAR_CHAIN_IDS.has(id)) coreHits.rearChain = true;
			}
		}
		// CRUSH M3 MEASURED CORRECTION: box3d reports the manifold normal shape-A -> shape-B. The
		// crumple model's displacement convention is "+normal caves the car INWARD", which holds when
		// the CAR is shape B (the calibrated wall path: a frontal wall reports (0,0,-1) into the
		// nose). When the car is shape A the raw normal points OUT of the car -- a box dropped ON the
		// hood reported a=hood b=box n=(0,+1,0) and the unconditional +normal BULGED the panel upward
		// 0.12m toward its striker (measured, crush-panel-refresh diag). Orient once here, at the
		// single drain, so every downstream consumer sees a car-inward normal. (welds.ts only ever
		// reads |normal.y|, so this flip cannot shift the direction-aware panel logic.)
		const carIsA = CAR_ENTITY_IDS.has(c.userDataA) && !CAR_ENTITY_IDS.has(c.userDataB);
		const nSign = carIsA ? -1 : 1;
		hits.push({
			userDataA: c.userDataA,
			userDataB: c.userDataB,
			point: { x: c.point.x, y: c.point.y, z: c.point.z },
			normal: { x: c.normal.x * nSign, y: c.normal.y * nSign, z: c.normal.z * nSign },
			approachSpeed: c.approachSpeed,
			// Resolved ONCE here (the single hit drain) so crumple (below) and weld stress
			// (stepWeldsAndWheels) weight this contact by the identical mass ratio. Undefined for a
			// static/unknown other body -> factor 1 -> unchanged behavior.
			otherMassKg: foreignMassForHit(system, c.userDataA, c.userDataB),
		});
	}

	// ---- Plastic crumple FIRST, against this step's PRE-weld panel states -- see hitTouchesCar()'s
	// doc comment. ORDER BUG (root-caused via crash-realism monotonicity failure): stepWeldsAndWheels()
	// below can BREAK a panel weld from the very same high-energy hit that's about to be evaluated here;
	// hitTouchesCar() deliberately excludes hits against an already-broken panel (so debris flying away
	// doesn't keep crumpling), but if welds ran first, a hit violent enough to break a panel in ONE step
	// would have its OWN crumple contribution silently discarded -- exactly backwards, since the most
	// energetic hits are the ones a crush-vs-speed model most needs to keep. Measured (headless probe,
	// game/sim/crash-realism-harness.mjs): a 64 km/h frontal hit only LOOSENS the hood in its landing
	// step (hitTouchesCar still true -> crumple applied, crush 0.44m), while an 80 km/h hit is energetic
	// enough to BREAK the hood in that same step -- with welds running first, that hit was dropped
	// entirely and crush fell to 0.31m (LESS than the 64 km/h case, sim/crash-realism.test.mjs's
	// 'monotonic 40<64<80' failure). Running crumple first (against the pre-break state every hit this
	// step actually struck) fixes the non-monotonicity without changing any crush-band constant --
	// confirmed 40/64/80/120 -> 0.236/0.442/0.535/0.580m, and the full sim suite (65 files) stays green.
	for (const hit of hits) {
		if (hit.approachSpeed <= STRESS_MIN_APPROACH_SPEED_MS) continue;
		if (!hitTouchesCar(hit, system.panels)) continue;
		system.emitter.emit({ type: 'impact', severity: hit.approachSpeed, point: hit.point });
		// Mass-aware crush depth: a light other body (registered dynamic mass) deposits only e =
		// m/(m+carMass) of a wall's crush; static/unknown -> 1 -> byte-identical (see crumple.ts's
		// applyImpactToMesh massFactor doc).
		const massFactor = massAwareDamageFactor(hit.otherMassKg, system.carMassKg);
		const result = applyCrumpleEvent(system.registry, hit.approachSpeed, (mesh) => {
			const transform = transformFor(system, mesh.attachedTo);
			if (!transform) return { point: FAR_AWAY_POINT, normal: UP_NORMAL };
			return worldToLocal(transform, hit.point, hit.normal);
		}, massFactor);
		for (const meshId of result.shatteredNowMeshIds) {
			system.emitter.emit({ type: 'glassShattered', mesh: meshId });
			// Keep the PHYSICAL pane in sync when the CRUMPLE model shatters a glass visual (a violent
			// enough exterior crash): destroy the matching solid pane so the aperture opens there too.
			// Safe for byte-stability: at that moment the pane (buried inside the nose/tail volumes) has
			// no live contacts, so removing the shape does not perturb the solver.
			for (const [paneKey, node] of Object.entries(GLASS_MESH_NODE) as [GlassPaneKey, string][]) {
				if (meshId.includes(node)) shatterGlassPane(system, paneKey, true);
			}
		}
	}

	stepWeldsAndWheels({
		world,
		vehicle: system.vehicle,
		panels: system.panels,
		hits,
		carMassKg: system.carMassKg,
		timeSec: system.timeSec,
		wheelOverThresholdSteps: system.wheelOverThresholdSteps,
		emit: (e) => system.emitter.emit(e),
	});

	// ---- Crush M2: the segment yield mechanic (plastic core flow + weld rest-frame ratchet + tears,
	// vehicle/segments.ts's stepSegmentYield doc) -- after world.step() like everything above, so the
	// constraint forces/poses it reads reflect this step's solve. ----
	for (const ev of stepSegmentYield(world, system.vehicle.chassis, system.vehicle.segments, coreHits)) {
		system.emitter.emit({ type: 'segmentTorn', weld: ev.weld });
	}

	// ---- EXTREME TIER (Stream C C2): windshield shatters once MECHANICAL front crush (rig-
	// independent physics truth, not a contact-dent-pipeline hit on the glass mesh specifically)
	// crosses WINDSHIELD_SHATTER_FRONT_CRUSH_M -- reference: 100mph+ crush reaches the A-pillar/
	// windshield frame, by which point the glass is gone regardless of whether the impact point
	// happened to land on the glass deformable mesh directly. Reuses the existing glass-pane shatter
	// path (shatterGlassPane, idempotent + already a no-op once the pane's shape is gone). ----
	if (getSegmentTelemetry(system.vehicle.chassis, system.vehicle.segments).frontCrushM >= WINDSHIELD_SHATTER_FRONT_CRUSH_M) {
		shatterGlassPane(system, 'windshield');
	}

	// ---- Crush M3: panel collision follows the dents (refreshPanelHulls' doc above). ----
	system.panelHull.fixedStep++;
	refreshPanelHulls(system);

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
	const panelStates = {} as Record<PanelKey, 'attached' | 'loosened' | 'sprung' | 'broken'>;
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
		segments: getSegmentTelemetry(system.vehicle.chassis, system.vehicle.segments),
	};
}

export type { DamageEvent };
