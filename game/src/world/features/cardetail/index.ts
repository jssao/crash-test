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
import { CAR_GROUP_INDEX, OCCUPANT_TRANSPARENT_CATEGORY_BITS } from '../../../vehicle/tuning';
import { segmentSpec, type SegmentKey } from '../../../vehicle/segments';

/**
 * CRUSH M1: cardetail parts that physically LIVE IN THE CRUSH ZONES anchor a SEGMENT body instead of
 * the chassis (crush-architecture.md §A "INTERACTIONS": engine parts ride the cradle; extended to the
 * other crush-zone residents on the same measured grounds). WHY the extension: these parts' collision
 * shapes poke past the chassis's recessed crush-core backstop (frontSubframe front face z=1.95 vs
 * core face 1.795; front bumper capsule 2.285; headlights 2.345; mirrored at the rear -- Mustang
 * measurements; S90 swap (2026-07-11) rescaled every one of these positions, see cardetail/tuning.ts's
 * CAR_DETAIL_SPECS doc comment, but the qualitative relationship is unchanged), so in a wall
 * crash the barrier presses them up to the crushable depth (~0.58m, geometry.ts CRUSH_CORE_*) -- against a hertz-0
 * RIGID chassis weld that is exactly the single-step elastic catapult the segment welds were
 * measured to be (see vehicle/segments.ts's SEGMENT_WELD_HERTZ doc). Anchored to the segment that
 * occupies their space, they ride its compliant weld (and, under M2, its plastic crush) instead:
 * lights/bumpers crumple back with the structure and still break away via their own thresholds.
 * Ids not in this table (and not engineBay) keep the chassis anchor. NOTE the headlight/taillight
 * L/R ids are anchored by their measured x SIGN (car-map: +X = car's left side), not by their name.
 */
const CRUSH_ZONE_ANCHOR: Readonly<Record<string, SegmentKey>> = {
	frontSubframe: 'engineCradle',
	frontBumperBeam: 'bumperBeam',
	headlightL: 'crushRailRF', // x<0 -> the -x front rail cell (sign-based; unaffected by the S90 rescale)
	headlightR: 'crushRailLF', // x>0 -> the +x front rail cell
	rearSubframe: 'trunkFloor',
	rearBumperBeam: 'trunkFloor',
	taillightL: 'rearRailR', // x<0 -> the -x rear rail
	taillightR: 'rearRailL', // x>0 -> the +x rear rail
};
import { InterpolatedTransform } from '../../../core/loop';
import { buildCarDetailMaterials, disposeCarDetailMaterials, type CarDetailMaterials } from './materials';
import { SHAPE_BUILDERS } from './shapes';
import {
	ATTACHED_SENSOR_OVERRIDE_IDS,
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
 * groupIndex (CAR_GROUP_INDEX both while attached AND once broken -- see breakComponent()'s doc
 * comment for why post-break stays on the shared car group rather than flipping neutral like damage/
 * panels.ts's breakPanelWeld() does).
 *
 * `isSensor`: TIER-3 STAGE 3 (docs/build-log/specs/compound-hull-design.md) retires the original
 * "every attached/collapsed part is a sensor" blanket rule -- see this function's OLD doc comment
 * (preserved below) for why that existed. Now only `ATTACHED_SENSOR_OVERRIDE_IDS` (tuning.ts, 3 of 27
 * post-cull parts, MEASURED not assumed) stay sensors while attached/collapsed; every other part is a
 * REAL (non-sensor) shape while attached, colliding with the ground/walls/debris exactly like the
 * chassis's own Stage-1 cabin-tub shapes already do -- filtered against the car's OWN shapes (chassis/
 * wheels/panels/other cardetail) via the SAME shared groupIndex those shapes use (CAR_GROUP_INDEX is a
 * negative group: shapes sharing it never collide with each other, in box3d/box2d's own filter
 * convention -- see tuning.ts's CAR_GROUP_INDEX doc comment in vehicle/tuning.ts), so this holds
 * regardless of whatever the chassis's own collision geometry looks like underneath (solid crush
 * volume today, hollow cavity once the chassis side of Tier-3 stage 3 lands -- this feature's own
 * filtering behavior is identical either way).
 *
 * ORIGINAL FINDING (why sensors existed at all, still true for the 3 override ids above): a RIGIDLY-
 * welded component's world position is 100% determined by the weld constraint, never by its own
 * collision response -- so real (non-sensor) collision while still attached, if the shape is actually
 * penetrating something, fights the weld every step instead of being smoothly absorbed (no suspension
 * of its own). FOUND EMPIRICALLY (game/sim/features-cardetail.test.mjs's drive-up-to-a-wall scenario,
 * pre-model-first-cull): 39 attached parts including several LOW interior components (seats/bench/
 * pedal cluster -- all since CULLED, see tuning.ts's top doc comment) clipping the ground plane during
 * ordinary acceleration squat nearly stalled the whole car's driveline, dropping a 34 km/h/2s baseline
 * to <1 km/h. Stage 3's own ground-clearance probe (game/sim/cardetail-ground-contact.test.mjs) found
 * this is now a MUCH narrower problem post-cull: only 3 rear underbody parts (fuelTank,
 * mufflerTailpipe, rearSubframe) still cross below the ground plane during ordinary driving, all by a
 * few cm -- those 3 keep the sensor treatment (ATTACHED_SENSOR_OVERRIDE_IDS); the other 24 measured
 * clear. Once broken, EVERY component (even the 3 overrides) becomes a real shape so it can scatter/
 * rest/collide normally, matching the "scatters believably on impact" requirement. */
function createShapeFor(body: Body, spec: CarDetailSpec, groupIndex: number, bodyUserData: number, isSensor: boolean): Shape {
	const common = {
		density: 1, // overwritten below once we know the volume
		friction: OTHER_MISC.friction,
		restitution: OTHER_MISC.restitution,
		enableHitEvents: false,
		isSensor,
		groupIndex,
		// Tier-3 STAGE 2 (occupant filter path): occupant capsules left the shared car group to gain
		// real cabin-interior collision, and cardetail parts must stay occupant-transparent -- the
		// brakeBoosterMC (z=1.005) shares firewall space with the seated front knees, and mid-eject
		// bodies cross the engine bay. Masks stay default, so ground/wall/debris contact (and the
		// post-break scatter) is byte-identical. See vehicle/tuning.ts's collision-filter bit registry.
		categoryBits: OCCUPANT_TRANSPARENT_CATEGORY_BITS,
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
			const shape = createShapeFor(body, spec, CAR_GROUP_INDEX, bodyUserData, ATTACHED_SENSOR_OVERRIDE_IDS.has(spec.id));

			// CRUSH M1 (crush-architecture.md §A "INTERACTIONS"): engine-bay parts weld to the ENGINE
			// CRADLE segment body (vehicle/segments.ts) instead of the chassis, so they ride the crush --
			// when the M2 yield mechanic shortens the front chain, the whole bay's contents arrive at the
			// firewall with it (drama for free). The other crush-zone residents anchor their own zone's
			// segment per CRUSH_ZONE_ANCHOR (see its doc comment for the measured catapult this avoids).
			// While the structure is pristine each segment sits exactly at its chassis-local rest offset,
			// so anchoring there with the offset-adjusted frameA is equivalent to the old chassis weld.
			// Everything else keeps the chassis anchor. The destroyAll() forgetHandle() hazard note below
			// covers the segment-anchored case identically: segment bodies die inside destroyVehicle()
			// (before features reset), which natively frees any joint attached to them, exactly like the
			// chassis-attached welds.
			const anchorSegment: SegmentKey | undefined = CRUSH_ZONE_ANCHOR[spec.id] ?? (spec.engineBay ? 'engineCradle' : undefined);
			const anchorBody = anchorSegment ? vehicle.segments.bodies[anchorSegment].body : chassis;
			const anchorFrameA = anchorSegment ? sub(spec.localCenter, segmentSpec(anchorSegment).center) : spec.localCenter;
			const weld = ctx.world.createWeldJoint(anchorBody, body, {
				frameA: { position: anchorFrameA, rotation: IDENTITY_Q },
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
		// EMBEDDED inside the chassis's own collision shapes (interior/engine-bay parts are, by
		// definition, inside the exterior shell while attached) -- giving a freshly-broken one a neutral
		// group was RE-TESTED for this stage (docs/build-log/specs/compound-hull-design.md's Tier-3
		// stage 3: "detached parts interact with the bay walls on their way out") on the CURRENT Stage-1
		// chassis, not just assumed carried over from the pre-Tier-3 single hull: measured directly
		// (game/sim/features-cardetail.test.mjs's 90km/h wall crash, groupIndex temporarily flipped to
		// 0 here), the scatter regressed from 3+ parts clearing 1.5m in 4s to ZERO -- detached parts got
		// caught/arrested against the chassis's still-solid nose/tail crush volumes (Stage 1 opens the
		// CABIN greenhouse's sides, per geometry.ts's buildCabinShapes(), but its own top doc comment is
		// explicit that "the engine bay is opened into a cavity only in stage 3" -- that chassis-side
		// cavity is a SEPARATE, not-yet-landed piece of work outside this feature's own file scope, see
		// game/src/vehicle/geometry.ts). So the "bounce off the bay wall on the way out" drama this
		// stage wants is a real, MEASURED dependency on that chassis-side opening, not deliverable from
		// this feature alone yet -- keeping CAR_GROUP_INDEX post-break (unchanged from pre-Stage-3) means
		// a scattered part still never collides with the chassis/wheels/panels/other cardetail parts,
		// only the ground/walls/world -- it can fly out through the (now-open, per the hood/door panel
		// system) body opening and land in the world, just never bounces off the (still invisible-solid)
		// engine-bay volume it started inside. GAP, not silently worked around: revisit this decision
		// (try neutral group again) once the chassis's own nose/tail shapes are hollowed.
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
				// every cardetail weld attaches to the CHASSIS (or, for engine-bay parts since crush M1,
				// to the engineCradle SEGMENT body, which destroyVehicle() also destroys), and by the time
				// reset() fires, doCarRepair()'s destroyVehicle() has already natively freed every such
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
			/** TIER-3 STAGE 3 diagnostic/test hook: whether THIS component's CURRENT shape is a sensor
			 * (no collision response) rather than solid -- lets cardetail-containment.test.mjs assert the
			 * "solid while attached, except ATTACHED_SENSOR_OVERRIDE_IDS" policy directly (Shape itself
			 * has no isSensor getter -- box3d-js's Shape.getFilter() only exposes category/mask/group, see
			 * src/ts/shape.ts -- so this is tracked from the same createShapeFor() call args index.ts's
			 * own spawnAll()/breakComponent() already use, not a native readback). Once `broken`, every
			 * component (even the 3 overrides) is solid -- see createShapeFor()'s doc comment. */
			isSensor: () => Object.fromEntries(handles.map((h) => [h.spec.id, h.state === 'broken' ? false : ATTACHED_SENSOR_OVERRIDE_IDS.has(h.spec.id)])),
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
