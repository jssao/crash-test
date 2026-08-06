// SPDX-License-Identifier: MIT
//
// Crash Lab entry point (second Vite page, game/crash-lab.html): standardized NHTSA/IIHS-style crash
// test protocols run on the REAL game vehicle (game/src/vehicle, game/src/damage, the occupants
// WorldFeature), in the lab's own minimal scene (./labScene.ts) rather than the main game's open
// sandbox. Deliberately reuses every renderer-free/renderer-level module the main game itself uses
// (vehicle, damage, occupants, cameraOrbit, wheels/panel visuals, quality/renderer) rather than
// reimplementing any of it -- this file is the run-flow/instrumentation orchestrator, same role
// game/src/main.ts plays for the driving game.
//
// DETERMINISM: every protocol is either a fixed speed/geometry (PROTOCOLS in ./protocols.ts) or the
// live free-config sliders -- no Math.random anywhere in this file or its lab/** imports. The vehicle
// is VELOCITY-SET at run start (./barriers.ts's launchVehicle(), mirroring damage/scenario.ts's own
// crashSetup() convention) rather than throttle-accelerated, so a given protocol + free-config state
// always produces byte-identical physics input.

import * as THREE from 'three';
import { init, World, liveHandleCount } from '../../../src/ts/index.js';
import { createRenderer } from '../render/createRenderer';
import { QUALITY_PRESETS, detectDefaultQuality, loadQualityPreference, type QualityLevel } from '../render/quality';
import { buildLabScene } from './labScene';
import { createOrbitUpdater, createUserOrbitController, sphericalFromCylindrical, sphericalFromCameraPose } from '../scene/cameraOrbit';
import { detachWheelVisuals, applyWheelVisual, type WheelVisual } from '../scene/wheels';
import { createVehicle, destroyVehicle, stepVehicle, createGroundBody, NEUTRAL_INPUT, getTelemetry, type Vehicle, type WheelKey } from '../vehicle/vehicle';
import { FIXED_DT, FIXED_SUBSTEPS, CHASSIS_ORIGIN_HEIGHT_M, VISUAL_RIDE_LIFT_M } from '../vehicle/tuning';
import { FixedStepAccumulator, InterpolatedTransform } from '../core/loop';
import { installPointerInput, consumeDragDelta, consumeZoomDelta } from '../input/pointer';
import { createDamageSystem, stepDamageSystem, getDamageTelemetry, type DamageSystem, type DamageEvent } from '../damage/system';
import { registerCarDeformables, syncCarDeformablesToThree, checkCarDeformablesSync, type CarDeformableBindings } from '../scene/carDeformables';
import { createStructuralCrushState, updateStructuralCrush, resetStructuralCrush, structuralInputsFromTelemetry, lateralInputsFromRegistry, maxStructuralOffsetM, type StructuralCrushState } from '../scene/structuralCrush';
import { getSegmentTelemetry } from '../vehicle/segments';
import { createPanelVisuals, reparentPanelVisual, repairPanelVisual, applyPanelVisual, type PanelVisual } from '../scene/panelVisuals';
import { createCrashFx, buildShatteredGlassMaterial, type CrashFx } from '../scene/crashFx';
import { resetCrumpleRegistry } from '../damage/crumple';
import { PANEL_KEYS, type PanelKey } from '../damage/panels';
import type { FeatureContext, WorldFeature } from '../world/features/feature';
import createOccupantsFeature from '../world/features/occupants';
import { PROTOCOLS, findProtocol, FREE_CONFIG_DEFAULT, type FreeConfigState } from './protocols';
import {
	spawnBarrierRig,
	teardownBarrierRig,
	guideBarrierRig,
	launchVehicle,
	applyVehicleVelocity,
	vehicleGuideUntilS,
	runDurationS,
	effectiveRunParams,
	type BarrierRig,
} from './barriers';
import { spawnCrashTarget, installCrashTargetPicker, type CrashTargetHandle } from './crashTargets';
import {
	measureAllCrush,
	createChassisDecelTracker,
	resetChassisDecelTracker,
	sampleChassisDecel,
	summarizeOccupants,
	type OccupantStateLike,
} from './instrumentation';
import { createLabHud, type LabHudController, type CameraPreset, type ReadoutData, type RunState } from './hud';

declare global {
	interface Window {
		__LAB__?: {
			ready: boolean;
			protocols: { id: string; label: string }[];
			selectProtocol: (id: string) => void;
			run: (id?: string) => void;
			reset: () => void;
			stepN: (n: number) => void;
			setSlowMotion: (enabled: boolean) => void;
			setCameraPreset: (preset: CameraPreset) => void;
			setOrbitView: (opts: { radius?: number; height?: number; targetHeight?: number }) => void;
			setFixedAngle: (radians: number | null) => void;
			setFreeConfig: (next: Partial<FreeConfigState>) => void;
			/** Select a model crash-target (spawns ahead of the car in place of the barrier), or null for
			 * the normal barrier. See ./crashTargets.ts's CRASH_TARGETS for ids. */
			setCrashTarget: (id: string | null) => void;
			setCrashTargetDistance: (m: number) => void;
			readonly readout: ReadoutData;
			readonly runState: RunState;
			readonly runElapsedS: number;
			readonly runTotalS: number;
			exportReport: () => unknown;
			liveHandleCount: () => number;
			/** Diagnostic (verify-harness eyes-on support): per-registered-deformable damage summary --
			 * which meshes actually took the crumple, how deep, and where they sit. */
			dumpDeformables: () => {
				id: string;
				kind: string;
				attachedTo: string;
				vertexCount: number;
				dentedCount: number;
				maxOffsetM: number;
				centerLocal: { x: number; y: number; z: number };
				boundsRadius: number;
			}[];
			/** Diagnostic: max |rendered THREE geometry - crumple registry positions| per binding (m) --
			 * proves whether syncCarDeformablesToThree() actually reached the rendered meshes. */
			deformableSyncCheck: () => { id: string; maxErrorM: number }[];
			/** Diagnostic: hide/show the barrier rig visual so screenshots can see the crushed nose. */
			setRigVisible: (visible: boolean) => void;
			/** Diagnostic: max structural-crush visual displacement (m) currently applied to the shell
			 * (scene/structuralCrush.ts) -- >0 proves the mechanical crush reached the rendered body. */
			maxStructuralOffsetM: () => number;
			/** Diagnostic: per-panel accumulated weld stress (damage-tuning.ts threshold calibration). */
			panelStress: () => Record<string, number>;
			/** Diagnostic (Phase R crash-pulse): raw chassis speed, m/s. */
			chassisSpeedMs: () => number;
			/** Diagnostic (Phase R crash-pulse): the current run's guided-approach release time (s). */
			vehicleGuideEndS: () => number;
			/** Diagnostic (Stream C slice C1): peak forward speed (m/s) this run ever reached -- the
			 * same signal the door-sprung/break speed gates read. */
			peakForwardSpeedMs: () => number;
			/** Diagnostic (Stream C slice C3): the lateral field's own registry-derived per-side driver
			 * stats (scene/structuralCrush.ts's lateralInputsFromRegistry()). */
			lateralInputs: () => { sidePos: { depthM: number; centerZ: number; spanM: number }; sideNeg: { depthM: number; centerZ: number; spanM: number } };
			/** BUG P006/P008 verification diagnostic: |mesh position - physics body position| (m) for the
			 * current run's barrier rig -- null if no barrier rig is active (e.g. idle, or a crash-target
			 * run replaced the barrier), 0 for a STATIC rig kind (rigid-full/-offset/-pole, whose visual has
			 * no `transform` to drift out of sync in the first place). A moving trolley (mdb-trolley/rear-
			 * trolley) should read near-zero every frame once its InterpolatedTransform is wired up -- a
			 * large/growing value would mean the mesh is NOT tracking its physics body (this bug's symptom). */
			rigSyncCheck: () => number | null;
			/** BUG P006/P008 verification diagnostic: how far (m) the current moving-rig BODY has actually
			 * traveled from its own spawn position -- null with no rig, or a static rig kind (no `transform`,
			 * see barrierSpawnPos's doc comment). Proves the guided-trolley PHYSICS side of the fix (which
			 * already worked before this bugfix -- see this task's root-cause notes) independently of
			 * rigSyncCheck()'s mesh-tracking check. */
			rigDisplacementFromSpawnM: () => number | null;
			/** Diagnostic (verify-harness only -- never called by the interactive lab UI): snaps the
			 * barrier rig's visual to the CURRENT (fully caught-up, alpha=1) sample of its InterpolatedTransform
			 * and renders one frame, bypassing the wall-clock-driven animation loop entirely. Exists because in
			 * a slow/software-rendered headless environment, waiting for (or forcing, via a screenshot) the
			 * NEXT ambient animate() tick can itself inject a large, real-time-proportional BURST of extra
			 * physics steps before the mesh visually updates -- this lets a deterministic stepN()-driven probe
			 * see (and screenshot) exactly where stepN() left the physics, without that extra drift. No-op if
			 * there's no active moving-rig transform. */
			renderNow: () => void;
		};
	}
}

// BUGS R003/R004 (crash VFX): separate global, additive to __LAB__ -- see scene/crashFx.ts's
// CrashFxCounters doc comment. A headless verify probe reads this to confirm particles/decals/
// puddles actually spawned (and stayed within their caps) without any pixel inspection.
declare global {
	interface Window {
		__FX__?: {
			counters: () => { activeParticles: number; decals: number; puddles: number };
			debugParticles: () => { kind: string; pos: [number, number, number]; opacity: number; scale: number }[];
			puddleInfo: () => { active: boolean; x: number; y: number; z: number; radius: number };
			/** BUG R004 deliverable 2: hanging-bumper split state -- lets a headless probe confirm the
			 * front/rear bumper actually detached + how far it has swung, without pixel inspection. */
			bumpers: () => { hasFront: boolean; hasRear: boolean; frontDetached: boolean; rearDetached: boolean; frontSwing: number; rearSwing: number };
		};
	}
}

async function main() {
	const appEl = document.getElementById('app')!;
	const hudEl = document.getElementById('hud')!;

	function createRendererOnFreshCanvas(q: (typeof QUALITY_PRESETS)[QualityLevel]) {
		const c = document.createElement('canvas');
		appEl.appendChild(c);
		return { renderer: createRenderer(c, q).renderer, canvas: c };
	}

	const hud: LabHudController = createLabHud(hudEl, {
		onSelectProtocol: (id) => selectProtocol(id),
		onRun: () => startRun(),
		onReset: () => resetLab(),
		onToggleSlowMo: () => {
			slowMo = !slowMo;
			hud.setSlowMo(slowMo);
		},
		onToggleBarrier: () => setBarrierHidden(!barrierHidden),
		onExport: () => downloadReport(),
		onCameraPreset: (preset) => applyCameraPreset(preset),
		onFreeConfigChange: (next) => {
			freeConfig = { ...freeConfig, ...next };
			hud.setFreeConfigValues(freeConfig);
		},
	});

	hud.setLoadingProgress(0.05, 'starting physics engine…');

	const qualityLevel: QualityLevel = (new URLSearchParams(location.search).get('quality') as QualityLevel) || loadQualityPreference() || detectDefaultQuality();
	const quality = QUALITY_PRESETS[qualityLevel];

	const { renderer } = createRendererOnFreshCanvas(quality);
	const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 500);

	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world); // flat static ground -- the lab's own minimal pad, not the game's terrain

	let vehicle: Vehicle = createVehicle(world);
	const SPAWN_POS = vehicle.spawnPosition;
	const SPAWN_ROT = vehicle.spawnRotation;

	hud.setLoadingProgress(0.25, 'building the pad…');

	const { scene, car, carFocus, updateSunQuality, rebakeEnvironment } = await buildLabScene(renderer, quality);
	const wheelVisuals: Record<WheelKey, WheelVisual> = detachWheelVisuals(car.root, scene);
	const IDENTITY_QUAT = new THREE.Quaternion();
	void updateSunQuality;
	void rebakeEnvironment;

	hud.setLoadingProgress(0.6, 'wiring damage + occupants…');

	let damageSystem: DamageSystem = createDamageSystem(vehicle);
	const carDeformables: CarDeformableBindings = registerCarDeformables(damageSystem, car.root, vehicle.panels);
	// Structural-crush visual pass (scene/structuralCrush.ts): the rendered shell follows the
	// MECHANICAL crush (segment telemetry), on top of the contact-dent crumple.
	const structuralCrush: StructuralCrushState = createStructuralCrushState(damageSystem.registry.meshes);
	const panelVisuals: Record<PanelKey, PanelVisual> = createPanelVisuals(car.root);
	// BUGS R003/R004 (crash VFX): glass shards, impact dust/debris, tire smoke, engine-bay fluid
	// leak, scuff/chip decals -- see scene/crashFx.ts's module doc for the full design.
	const crashFx: CrashFx = createCrashFx(scene, car.root, panelVisuals);

	const originalGlassMaterials = new Map<string, THREE.Material>();
	for (const b of carDeformables.bindings) {
		if (b.handle.kind === 'glass') originalGlassMaterials.set(b.handle.id, b.mesh.material as THREE.Material);
	}
	function findDeformableMesh(meshId: string): THREE.Mesh | null {
		return carDeformables.bindings.find((b) => b.handle.id === meshId)?.mesh ?? null;
	}
	function applyGlassShatterMaterial(meshId: string): void {
		const mesh = findDeformableMesh(meshId);
		if (!mesh) return;
		const src = mesh.material as THREE.MeshPhysicalMaterial;
		if (!src || Array.isArray(mesh.material)) return;
		// ROUND-2 (R004): was an in-line swap that killed transmission on a white-based glass material and
		// produced a glowing WHITE panel at the A-pillar. Delegated to crashFx's crazed-glass builder,
		// which reads as spider-cracked safety glass instead. See buildShatteredGlassMaterial()'s doc.
		mesh.material = buildShatteredGlassMaterial(src);
	}
	function handleDamageEvent(event: DamageEvent): void {
		if (event.type === 'panelLoosened' || event.type === 'panelSprung' || event.type === 'panelBroken') {
			const visual = panelVisuals[event.panel];
			const panelBody = vehicle.panels[event.panel].body;
			if (visual) {
				const t = panelBody.getTransform();
				reparentPanelVisual(visual, scene, new THREE.Vector3(t.position.x, t.position.y, t.position.z), new THREE.Quaternion(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w));
			}
		} else if (event.type === 'glassShattered') {
			applyGlassShatterMaterial(event.mesh);
		}
		// BUGS R003/R004: additive-only, self-contained switch inside crashFx -- never touches any of
		// the branches above (also handles 'impact'/'panelBroken', which this function otherwise ignores).
		crashFx.handleDamageEvent(event, findDeformableMesh);
	}
	damageSystem.emitter.on(handleDamageEvent);

	// foreignMasses: the lab's barriers deliberately opt OUT of mass registration (src/lab/barriers.ts's
	// doc comment -- barriers must read wall-like), so the lab threads the damage system's own map through
	// purely to satisfy the shared FeatureContext contract; the occupants feature never writes to it.
	const featureCtx: FeatureContext = { world, scene, getVehicle: () => vehicle, carRoot: car.root, quality, foreignMasses: damageSystem.foreignMasses };
	// DIAGNOSTIC SWITCH (Phase R crash-pulse isolation, 2026-07-12): `?noocc` runs the lab WITHOUT the
	// occupant feature entirely (no ragdolls, no seat pans, no restraints) -- used by the headless
	// crash-pulse probes to isolate how much of the NHTSA-56 chassis peak decel comes from the
	// occupants' coupled mass vs the car structure itself. Never set by the interactive lab UI.
	const noOccupants = new URLSearchParams(window.location.search).has('noocc');
	const occupantsFeature: WorldFeature = noOccupants ? { name: 'occupants-disabled', bodyCount: () => 0 } : await createOccupantsFeature(featureCtx);
	const occHooks = () => occupantsFeature.hooks as { occupantStates?: () => OccupantStateLike[]; matchVehicleVelocity?: () => void } | undefined;

	const chassisTransform = new InterpolatedTransform();
	for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
		const t = vehicle.wheels[key].body.getTransform();
		wheelVisuals[key].transform.sample(t.position, t.rotation);
	}
	{
		const t = vehicle.chassis.getTransform();
		chassisTransform.sample(t.position, t.rotation);
	}

	installPointerInput(appEl);

	// ---- Camera: orbit-only (no chase mode -- the lab is a standardized-view instrument, not a
	// driving cockpit). Presets mirror verify/crash-realism/shoot-matrix.mjs's TOP/SIDE/THREE-QUARTER
	// setOrbitView()+setFixedAngle() convention exactly, plus a free-orbit mode identical to the main
	// game's click-drag/wheel-zoom camera. ----
	let orbitOpts = { radius: 8, height: 3, angularSpeed: 0.12, targetHeight: 0.6 };
	let updateOrbit = createOrbitUpdater(camera, orbitOpts);
	const userOrbit = createUserOrbitController(sphericalFromCylindrical(orbitOpts.radius, orbitOpts.height));
	let fixedAngle: number | null = Math.PI / 3;
	let cameraPreset: CameraPreset = '3q';

	function applyCameraPreset(preset: CameraPreset): void {
		cameraPreset = preset;
		hud.setCameraPreset(preset);
		// ANGLE SIGN CONVENTION (found while eyes-on reviewing the first pass's screenshots): the car
		// always launches along world +Z (spawnRotation is always identity -- see barriers.ts's
		// launchVehicle()) into a barrier positioned further +Z still, so it comes to rest with its
		// crushed nose pressed right up against the rig. createOrbitUpdater() offsets the camera by
		// (cos(angle)*radius, height, sin(angle)*radius) from that resting point -- ANY positive
		// sin(angle) pushes the camera BEYOND the (thin but opaque) barrier, onto its far side, so it
		// ends up looking straight through the rig at the car's SHADOW rather than the car (confirmed:
		// the first pass's screenshots showed nothing but barrier). Every preset below keeps sin(angle)
		// <= 0 so the camera always stays on the car's own (approach) side of the rig.
		if (preset === 'top') {
			orbitOpts = { ...orbitOpts, radius: 1.2, height: 16, targetHeight: 0.3 };
			fixedAngle = -Math.PI / 4;
		} else if (preset === 'side') {
			// Pure lateral offset (angle=0 -> zero Z component) -- a true profile view, perpendicular to
			// the car's direction of travel, clear of the barrier regardless of its width. Pulled back
			// further than the main game's equivalent preset (7.5m) since the lab's barrier rigs are
			// several meters wide -- 12m keeps both the car AND enough barrier context in shot.
			orbitOpts = { ...orbitOpts, radius: 12, height: 2, targetHeight: 0.6 };
			fixedAngle = 0;
		} else if (preset === '3q') {
			orbitOpts = { ...orbitOpts, radius: 12, height: 4, targetHeight: 0.6 };
			fixedAngle = -Math.PI / 3;
		} else {
			fixedAngle = null; // free orbit: auto-spin until the player drags/zooms (userOrbit takes over)
		}
		updateOrbit = createOrbitUpdater(camera, orbitOpts);
	}

	// ---- Run-flow state ----
	let currentProtocolId: string = PROTOCOLS[0].id;
	let freeConfig: FreeConfigState = { ...FREE_CONFIG_DEFAULT };
	let barrierRig: BarrierRig | null = null;
	// BUG P006/P008 verification diagnostic: the moving-rig body's position at spawn (undefined for
	// static rig kinds/no rig) -- lets a headless probe assert the trolley actually TRAVELED (not just
	// that its mesh tracks wherever it is -- rigSyncCheck() alone can't tell a parked trolley from a
	// moving one glued correctly to a parked body).
	let barrierSpawnPos: { x: number; y: number; z: number } | null = null;
	// Crash-target extension (./crashTargets.ts): when a model target is selected it spawns AHEAD of
	// the car IN PLACE OF the barrier wall, so you can crash into a single game model to troubleshoot
	// its physics. `crashTargetId === null` keeps the normal barrier behaviour.
	let crashTarget: CrashTargetHandle | null = null;
	let crashTargetId: string | null = null;
	let crashTargetDistanceM = 14;
	// "Hide barrier" inspection toggle: the barrier rig is a wide opaque wall the car crushes AGAINST,
	// so post-crash it hides exactly the damaged face -- this lets the player (and the verify harness)
	// actually see the crush. Persists across runs until toggled back.
	let barrierHidden = false;
	function setBarrierHidden(hidden: boolean): void {
		barrierHidden = hidden;
		if (barrierRig) barrierRig.visual.visible = !hidden;
		hud.setBarrierHidden(hidden);
	}
	let runState: RunState = 'idle';
	let runElapsedS = 0;
	let runTotalS = 0;
	let slowMo = false;
	const decelTracker = createChassisDecelTracker();
	// Guided vehicle approach (see barriers.ts's vehicleGuideUntilS() doc comment): re-applied every
	// fixed step until runElapsedS crosses this, then left alone so the actual crash physics governs.
	let vehicleGuideVelocity: { x: number; y: number; z: number } | null = null;
	let vehicleGuideEndS = 0;

	function teardownRig(): void {
		if (barrierRig) {
			teardownBarrierRig(scene, barrierRig);
			barrierRig = null;
			barrierSpawnPos = null;
		}
		if (crashTarget) {
			crashTarget.teardown();
			crashTarget = null;
		}
	}

	/** Full car+damage rebuild at the pristine spawn pose -- mirrors game/src/main.ts's doCarRepair(),
	 * minus the chase-camera/audio/destructible-world bookkeeping this lab has none of. */
	function rebuildCarAndDamage(): void {
		resetCrumpleRegistry(damageSystem.registry);
		resetStructuralCrush(structuralCrush);
		destroyVehicle(vehicle);
		vehicle = createVehicle(world, SPAWN_POS, SPAWN_ROT);
		vehicle.chassis.setLinearVelocity({ x: 0, y: 0, z: 0 });
		vehicle.chassis.setAngularVelocity({ x: 0, y: 0, z: 0 });
		vehicle.chassis.setAwake(true);
		for (const w of Object.values(vehicle.wheels)) {
			w.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
			w.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
			w.body.setAwake(true);
		}
		damageSystem = createDamageSystem(vehicle, damageSystem.registry, damageSystem.foreignMasses);
		damageSystem.emitter.on(handleDamageEvent);
		for (const key of PANEL_KEYS) {
			const visual = panelVisuals[key];
			if (visual) repairPanelVisual(visual);
		}
		for (const [meshId, mat] of originalGlassMaterials) {
			const mesh = findDeformableMesh(meshId);
			if (mesh) mesh.material = mat;
		}
		syncCarDeformablesToThree(carDeformables, vehicle.panels, structuralCrush);

		const t = vehicle.chassis.getTransform();
		chassisTransform.sample(t.position, t.rotation);
		chassisTransform.sample(t.position, t.rotation);
		for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
			const wt = vehicle.wheels[key].body.getTransform();
			wheelVisuals[key].transform.sample(wt.position, wt.rotation);
			wheelVisuals[key].transform.sample(wt.position, wt.rotation);
		}
		for (const key of PANEL_KEYS) {
			const visual = panelVisuals[key];
			if (!visual) continue;
			const pt = vehicle.panels[key].body.getTransform();
			visual.transform.sample(pt.position, pt.rotation);
			visual.transform.sample(pt.position, pt.rotation);
		}
		occupantsFeature.reset?.('car');
		// BUG R003/R004: a freshly rebuilt car (new run/reset) shouldn't still show the old wreck's
		// decals/puddle, nor a hanging bumper -- re-seat both flush.
		crashFx.reset();
		car.bumpers.reset();
	}

	function selectProtocol(id: string): void {
		currentProtocolId = id;
		const protocol = findProtocol(id);
		hud.setProtocols(PROTOCOLS, currentProtocolId);
		hud.setFreeConfigVisible(!!protocol.isFreeConfig);
		if (protocol.isFreeConfig) hud.setFreeConfigValues(freeConfig);
		resetLab();
	}

	function resetLab(): void {
		teardownRig();
		rebuildCarAndDamage();
		resetChassisDecelTracker(decelTracker);
		runElapsedS = 0;
		runTotalS = 0;
		runState = 'idle';
		vehicleGuideVelocity = null;
		hud.setRunState('idle', 0, 0);
		// Preview a selected model target ahead of the car so it's visible before launching.
		if (crashTargetId) crashTarget = spawnCrashTarget(crashTargetId, { world, scene, vehicle, distanceAhead: crashTargetDistanceM, foreignMasses: damageSystem.foreignMasses });
	}

	function setCrashTarget(id: string | null): void {
		crashTargetId = id;
		resetLab();
	}

	function startRun(id: string = currentProtocolId): void {
		currentProtocolId = id;
		const protocol = findProtocol(id);
		hud.setProtocols(PROTOCOLS, currentProtocolId);
		teardownRig();
		rebuildCarAndDamage();
		resetChassisDecelTracker(decelTracker);
		runElapsedS = 0;
		runTotalS = runDurationS(protocol, freeConfig);
		runState = 'running';
		if (crashTargetId) {
			// A model crash-target replaces the barrier: spawn it ahead, keep the protocol's launch.
			crashTarget = spawnCrashTarget(crashTargetId, { world, scene, vehicle, distanceAhead: crashTargetDistanceM, foreignMasses: damageSystem.foreignMasses });
		} else {
			barrierRig = spawnBarrierRig(world, scene, vehicle, protocol, freeConfig);
			barrierRig.visual.visible = !barrierHidden;
			barrierSpawnPos = barrierRig.transform ? { ...barrierRig.bodies[0].getTransform().position } : null;
		}
		const launchVel = launchVehicle(vehicle, protocol, freeConfig);
		// Trolley protocols: the car stays PARKED (launchVehicle already gave it zero velocity) and the
		// TROLLEY carries the closing speed instead -- guiding the car here would mean re-asserting zero
		// velocity every step, actively cancelling the very impulse the trolley's impact is supposed to
		// deliver during the guided window (found via eyes-on review: chassis peak decel read ~2g on a
		// guided-vehicle 80 km/h rear hit, an order of magnitude too low, because this guide was fighting
		// the collision response in real time). Only the frontal/offset/pole protocols need the car's
		// OWN velocity re-asserted (see vehicleGuideUntilS()'s doc comment).
		const isTrolleyProtocol = protocol.barrier === 'mdb-trolley' || protocol.barrier === 'rear-trolley';
		vehicleGuideVelocity = isTrolleyProtocol ? null : launchVel;
		vehicleGuideEndS = vehicleGuideUntilS(protocol, freeConfig);
		occHooks()?.matchVehicleVelocity?.();
		hud.setRunState('running', 0, runTotalS);
	}

	function buildReadoutData(): ReadoutData {
		const dmg = getDamageTelemetry(damageSystem);
		const crush = measureAllCrush(damageSystem);
		const states = occHooks()?.occupantStates?.() ?? [];
		return {
			crush,
			mechCrushFrontM: dmg.segments.frontCrushM,
			mechCrushRearM: dmg.segments.rearCrushM,
			intrusionM: dmg.segments.intrusionM,
			panelStates: dmg.panelStates,
			wheelStates: dmg.wheelStates,
			dentedVertexCount: dmg.dentedVertexCount,
			chassisPeakDecelG: decelTracker.peakG,
			occupants: summarizeOccupants(states),
		};
	}

	function buildReport(): unknown {
		const protocol = findProtocol(currentProtocolId);
		const params = effectiveRunParams(protocol, freeConfig);
		return {
			protocol: { id: protocol.id, label: protocol.label, reference: protocol.reference, barrier: protocol.barrier, ...params },
			runState,
			runElapsedS,
			runTotalS,
			readout: buildReadoutData(),
			// Crush M2: the full mechanical segment telemetry (per-weld plastic crush, per-side core
			// retreat, intrusion) -- verify/crash-lab.mjs asserts the offset struck-vs-intact asymmetry
			// from this.
			segments: getDamageTelemetry(damageSystem).segments,
			timestamp: new Date().toISOString(),
		};
	}

	function downloadReport(): void {
		const report = buildReport();
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `crash-lab-${currentProtocolId}-${Date.now()}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		hud.showToast('report exported');
	}

	function doFixedStep(): void {
		stepVehicle(vehicle, NEUTRAL_INPUT, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		if (barrierRig) guideBarrierRig(barrierRig, runElapsedS);
		// BUG P006/P008 FIX: sample the trolley body's transform every fixed step, exactly parallel to
		// chassis/wheels/panels below -- static rig kinds (rigid-full/-offset/-pole) have no `transform`
		// and are unaffected (their visual was placed once at spawn and never moves).
		if (barrierRig?.transform) {
			const bt = barrierRig.bodies[0].getTransform();
			barrierRig.transform.sample(bt.position, bt.rotation);
		}
		if (vehicleGuideVelocity && runElapsedS < vehicleGuideEndS) applyVehicleVelocity(vehicle, vehicleGuideVelocity);
		stepDamageSystem(damageSystem, world, FIXED_DT);
		updateStructuralCrush(structuralCrush, {
			...structuralInputsFromTelemetry(getSegmentTelemetry(vehicle.chassis, vehicle.segments)),
			...lateralInputsFromRegistry(damageSystem.registry.meshes),
		});
		syncCarDeformablesToThree(carDeformables, vehicle.panels, structuralCrush);
		occupantsFeature.afterFixedStep?.(FIXED_DT);
		crashTarget?.afterFixedStep(FIXED_DT);
		sampleChassisDecel(decelTracker, vehicle.chassis.getLinearVelocity(), FIXED_DT);
		// BUG R003 (fluid leak): re-reads segment telemetry (read-only getter, additive call).
		{
			const chassisT = vehicle.chassis.getTransform();
			crashFx.updateFluidLeak(getSegmentTelemetry(vehicle.chassis, vehicle.segments).frontCrushPlasticM, chassisT.position, chassisT.rotation, FIXED_DT);
		}
		// BUG R004 (deliverable 2 -- hanging bumpers): drive the load-time bumper split's detach/swing off
		// the same plastic-crush telemetry (read-only getter, additive call). Pure visual, no physics.
		{
			const seg = getSegmentTelemetry(vehicle.chassis, vehicle.segments);
			car.bumpers.update(FIXED_DT, seg.frontCrushPlasticM, seg.rearCrushPlasticM);
		}
		// BUG R003 (tire smoke): per-wheel slip/ground-contact check via the existing public getters.
		{
			const fxTelemetry = getTelemetry(vehicle);
			for (const key of Object.keys(vehicle.wheels) as WheelKey[]) {
				crashFx.updateWheel(key, vehicle.wheels[key].body.getPosition(), vehicle.wheelGrounded[key], Math.abs(fxTelemetry.slipHints[key]), FIXED_DT);
			}
		}

		const t = vehicle.chassis.getTransform();
		chassisTransform.sample(t.position, t.rotation);
		for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
			const wt = vehicle.wheels[key].body.getTransform();
			wheelVisuals[key].transform.sample(wt.position, wt.rotation);
		}
		for (const key of PANEL_KEYS) {
			const visual = panelVisuals[key];
			if (!visual || vehicle.panels[key].despawned) continue;
			const pt = vehicle.panels[key].body.getTransform();
			visual.transform.sample(pt.position, pt.rotation);
		}

		if (runState === 'running') {
			runElapsedS += FIXED_DT;
			if (runElapsedS >= runTotalS) runState = 'settled';
		}
	}

	function resize(): void {
		const w = window.innerWidth;
		const h = window.innerHeight;
		renderer.setSize(w, h);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}
	window.addEventListener('resize', resize);

	window.addEventListener('keydown', (e) => {
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'BUTTON')) return;
		if (e.code === 'Space') {
			e.preventDefault();
			startRun();
		} else if (e.key === 'r' || e.key === 'R') {
			resetLab();
		}
	});

	hud.setProtocols(PROTOCOLS, currentProtocolId);
	hud.setFreeConfigVisible(findProtocol(currentProtocolId).isFreeConfig === true);
	hud.setFreeConfigValues(freeConfig);
	hud.setCameraPreset(cameraPreset);
	hud.setSlowMo(slowMo);
	resetLab();

	window.__LAB__ = {
		ready: false,
		protocols: PROTOCOLS.map((p) => ({ id: p.id, label: p.label })),
		selectProtocol,
		run: (id) => startRun(id),
		reset: resetLab,
		stepN: (n) => {
			for (let i = 0; i < n; i++) doFixedStep();
		},
		setSlowMotion: (enabled) => {
			slowMo = enabled;
			hud.setSlowMo(slowMo);
		},
		setCameraPreset: applyCameraPreset,
		setOrbitView: (opts) => {
			orbitOpts = { ...orbitOpts, ...opts };
			updateOrbit = createOrbitUpdater(camera, orbitOpts);
		},
		setFixedAngle: (radians) => {
			fixedAngle = radians;
		},
		setFreeConfig: (next) => {
			freeConfig = { ...freeConfig, ...next };
			hud.setFreeConfigValues(freeConfig);
		},
		setCrashTarget: (id) => setCrashTarget(id),
		setCrashTargetDistance: (m) => {
			crashTargetDistanceM = Math.max(4, Math.min(60, m));
			if (crashTargetId) setCrashTarget(crashTargetId); // respawn preview at the new distance
		},
		get readout() {
			return buildReadoutData();
		},
		get runState() {
			return runState;
		},
		get runElapsedS() {
			return runElapsedS;
		},
		get runTotalS() {
			return runTotalS;
		},
		exportReport: buildReport,
		liveHandleCount: () => liveHandleCount(),
		dumpDeformables: () =>
			damageSystem.registry.meshes.map((m) => {
				let maxOffsetM = 0;
				for (let v = 0; v < m.vertexCount; v++) {
					const ox = m.offsets[v * 3];
					const oy = m.offsets[v * 3 + 1];
					const oz = m.offsets[v * 3 + 2];
					const mag = Math.sqrt(ox * ox + oy * oy + oz * oz);
					if (mag > maxOffsetM) maxOffsetM = mag;
				}
				return {
					id: m.id,
					kind: m.kind,
					attachedTo: m.attachedTo,
					vertexCount: m.vertexCount,
					dentedCount: m.dentedCount,
					maxOffsetM,
					centerLocal: { ...m.centerLocal },
					boundsRadius: m.boundsRadius,
				};
			}),
		deformableSyncCheck: () => checkCarDeformablesSync(carDeformables, vehicle.panels, structuralCrush),
		setRigVisible: (visible) => setBarrierHidden(!visible),
		maxStructuralOffsetM: () => maxStructuralOffsetM(structuralCrush),
		// Stream C slice C3 diagnostic: the lateral field's own registry-derived driver stats (per side)
		// -- lets a headless probe see WHY the field did/didn't engage, independent of the combined
		// maxStructuralOffsetM() readout.
		lateralInputs: () => lateralInputsFromRegistry(damageSystem.registry.meshes),
		panelStress: () => ({ ...getDamageTelemetry(damageSystem).stressLevels }),
		// Phase R crash-pulse diagnostics (2026-07-12): raw chassis speed (m/s) + the guided-approach
		// release time for the CURRENT run -- lets a headless probe verify the vehicle guide releases
		// BEFORE first barrier contact (guided-through-contact force-feeds the crush budget at constant
		// velocity and was one candidate mechanism for the NHTSA-56 91.7g peak-decel spike).
		chassisSpeedMs: () => {
			const v = vehicle.chassis.getLinearVelocity();
			return Math.hypot(v.x, v.y, v.z);
		},
		vehicleGuideEndS: () => vehicleGuideEndS,
		// Stream C slice C1 diagnostic: the same rig-independent "how fast did this crash ever get"
		// signal the door-sprung/break speed gates read (damage-tuning.ts's DOOR_SPRUNG_GATE_MS doc
		// comment) -- lets a headless probe confirm the gate actually saw the expected peak.
		peakForwardSpeedMs: () => Math.abs(vehicle.segments.yieldState.peakForwardSpeedMs),
		// BUG P006/P008 verification diagnostic: see the type declaration's doc comment above -- null with
		// no active barrier rig, 0 for a static rig kind, else |mesh position - live body position| (m).
		rigSyncCheck: () => {
			if (!barrierRig) return null;
			if (!barrierRig.transform) return 0;
			const bp = barrierRig.bodies[0].getTransform().position;
			const mp = barrierRig.visual.position;
			return Math.hypot(mp.x - bp.x, mp.y - bp.y, mp.z - bp.z);
		},
		rigDisplacementFromSpawnM: () => {
			if (!barrierRig || !barrierSpawnPos) return null;
			const bp = barrierRig.bodies[0].getTransform().position;
			return Math.hypot(bp.x - barrierSpawnPos.x, bp.y - barrierSpawnPos.y, bp.z - barrierSpawnPos.z);
		},
		renderNow: () => {
			// Also permanently stops the normal wall-clock-driven animation loop (idempotent -- safe to
			// call repeatedly): a subsequent screenshot's own (in this environment, observed multi-second)
			// compositor settle can otherwise itself pump the still-live rAF loop through several MORE
			// ambient physics steps before the frame is actually captured, undoing this exact staging.
			// Verify-harness-only; the interactive lab never calls this.
			renderer.setAnimationLoop(null);
			// Mirrors animate()'s FULL per-frame visual-apply sequence at alpha=1 (fully caught up to the
			// latest fixed-step sample) -- not just the barrier -- so a screenshot taken any time after
			// this (mid-approach OR post-impact, with more stepN() calls in between) shows the REAL car/
			// damage/occupant state, not a stale pose frozen from the last time animate() happened to run.
			for (const key of Object.keys(wheelVisuals) as WheelKey[]) applyWheelVisual(wheelVisuals[key], IDENTITY_QUAT, 1);
			for (const key of PANEL_KEYS) {
				const visual = panelVisuals[key];
				if (visual) applyPanelVisual(visual, 1);
			}
			occupantsFeature.applyVisuals?.(1);
			crashTarget?.applyVisuals(1);
			chassisTransform.applyTo(car.root, 1);
			if (barrierRig?.transform) barrierRig.transform.applyTo(barrierRig.visual, 1);
			car.root.translateY(-CHASSIS_ORIGIN_HEIGHT_M + VISUAL_RIDE_LIFT_M);
			const currentPos = vehicle.chassis.getPosition();
			carFocus.x = currentPos.x;
			carFocus.z = currentPos.z;
			if (userOrbit.active) {
				userOrbit.update(camera, carFocus, orbitOpts.targetHeight, 0, world);
			} else {
				const elapsed = fixedAngle !== null ? fixedAngle / orbitOpts.angularSpeed : timer.getElapsed();
				updateOrbit(elapsed, carFocus);
			}
			renderer.render(scene, camera);
			// Also refresh the HUD text overlay (crush/panel/occupant readouts, run state) -- like the
			// camera, these are otherwise only refreshed inside animate(), which this permanently stops.
			// Without this a post-renderNow() screenshot would show a REAL, correctly-crushed/repositioned
			// 3D scene next to a STALE HUD sidebar still reading all-zeros from before the crash.
			hud.setRunState(runState, runElapsedS, runTotalS);
			hud.updateReadout(buildReadoutData());
		},
	};

	// BUGS R003/R004 verify hook -- see the `declare global` doc comment above.
	window.__FX__ = { counters: () => crashFx.counters(), debugParticles: () => crashFx.debugParticles(), puddleInfo: () => crashFx.puddleInfo(), bumpers: () => car.bumpers.debug() };

	// Crash-target picker (own injected DOM — leaves ./hud.ts untouched).
	installCrashTargetPicker(document.body, {
		onTarget: (id) => setCrashTarget(id),
		onDistance: (m) => {
			crashTargetDistanceM = m;
			if (crashTargetId) setCrashTarget(crashTargetId);
		},
	});

	resize();
	hud.setLoadingProgress(1, 'ready');
	hud.hideLoadingScreen();
	window.__LAB__.ready = true;

	const accumulator = new FixedStepAccumulator(FIXED_DT);
	const timer = new THREE.Timer();
	timer.connect(document);

	function animate(timestamp: number): void {
		timer.update(timestamp);
		const dt = Math.min(timer.getDelta(), 0.1);
		const scaledDt = slowMo ? dt * 0.25 : dt;

		const dragDelta = consumeDragDelta();
		const zoomDelta = consumeZoomDelta();
		if (dragDelta.azimuth !== 0 || dragDelta.polar !== 0 || zoomDelta !== 0) {
			if (!userOrbit.active) {
				const currentPos = vehicle.chassis.getPosition();
				carFocus.x = currentPos.x;
				carFocus.z = currentPos.z;
				userOrbit.reset(sphericalFromCameraPose(camera.position, carFocus));
			}
			cameraPreset = 'free';
			hud.setCameraPreset('free');
			fixedAngle = null;
			if (dragDelta.azimuth !== 0 || dragDelta.polar !== 0) userOrbit.drag(dragDelta.azimuth, dragDelta.polar);
			if (zoomDelta !== 0) userOrbit.zoom(zoomDelta);
		}

		const alpha = accumulator.advance(scaledDt, doFixedStep);

		for (const key of Object.keys(wheelVisuals) as WheelKey[]) applyWheelVisual(wheelVisuals[key], IDENTITY_QUAT, alpha);
		for (const key of PANEL_KEYS) {
			const visual = panelVisuals[key];
			if (visual) applyPanelVisual(visual, alpha);
		}
		occupantsFeature.applyVisuals?.(alpha);
		crashTarget?.applyVisuals(alpha);
		chassisTransform.applyTo(car.root, alpha);
		// BUG P006/P008 FIX: keep the trolley mesh glued to its (guided, flying-toward-the-car) physics
		// body every render frame -- before this line the mesh stayed frozen at its spawn-time position
		// forever while the body actually moved, so the car looked like it "just magically gets hit".
		if (barrierRig?.transform) barrierRig.transform.applyTo(barrierRig.visual, alpha);
		car.root.translateY(-CHASSIS_ORIGIN_HEIGHT_M + VISUAL_RIDE_LIFT_M);

		const currentPos = vehicle.chassis.getPosition();
		carFocus.x = currentPos.x;
		carFocus.z = currentPos.z;
		if (userOrbit.active) {
			userOrbit.update(camera, carFocus, orbitOpts.targetHeight, dt, world);
		} else {
			const elapsed = fixedAngle !== null ? fixedAngle / orbitOpts.angularSpeed : timer.getElapsed();
			updateOrbit(elapsed, carFocus);
		}

		// BUGS R003/R004: per-frame particle aging/fade (decals/puddle are step-driven above, not here).
		crashFx.update(scaledDt);

		renderer.render(scene, camera);

		hud.setRunState(runState, runElapsedS, runTotalS);
		hud.updateReadout(buildReadoutData());
	}

	renderer.setAnimationLoop(animate);
}

main().catch((err) => {
	console.error('[crash-lab] fatal init error:', err);
	const hudEl = document.getElementById('hud');
	if (hudEl) hudEl.textContent = `FATAL: ${(err as Error).message}`;
});
