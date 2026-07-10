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
import { createVehicle, destroyVehicle, stepVehicle, createGroundBody, NEUTRAL_INPUT, type Vehicle, type WheelKey } from '../vehicle/vehicle';
import { FIXED_DT, FIXED_SUBSTEPS, CHASSIS_ORIGIN_HEIGHT_M, VISUAL_RIDE_LIFT_M } from '../vehicle/tuning';
import { FixedStepAccumulator, InterpolatedTransform } from '../core/loop';
import { installPointerInput, consumeDragDelta, consumeZoomDelta } from '../input/pointer';
import { createDamageSystem, stepDamageSystem, getDamageTelemetry, type DamageSystem, type DamageEvent } from '../damage/system';
import { registerCarDeformables, syncCarDeformablesToThree, type CarDeformableBindings } from '../scene/carDeformables';
import { createPanelVisuals, reparentPanelVisual, repairPanelVisual, applyPanelVisual, type PanelVisual } from '../scene/panelVisuals';
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
			readonly readout: ReadoutData;
			readonly runState: RunState;
			readonly runElapsedS: number;
			readonly runTotalS: number;
			exportReport: () => unknown;
			liveHandleCount: () => number;
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
	const panelVisuals: Record<PanelKey, PanelVisual> = createPanelVisuals(car.root);

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
		const shattered = src.clone();
		shattered.roughness = 0.9;
		if ('transmission' in shattered) (shattered as unknown as { transmission: number }).transmission = 0;
		shattered.transparent = true;
		shattered.opacity = 0.85;
		shattered.needsUpdate = true;
		mesh.material = shattered;
	}
	function handleDamageEvent(event: DamageEvent): void {
		if (event.type === 'panelLoosened' || event.type === 'panelBroken') {
			const visual = panelVisuals[event.panel];
			const panelBody = vehicle.panels[event.panel].body;
			if (visual) {
				const t = panelBody.getTransform();
				reparentPanelVisual(visual, scene, new THREE.Vector3(t.position.x, t.position.y, t.position.z), new THREE.Quaternion(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w));
			}
		} else if (event.type === 'glassShattered') {
			applyGlassShatterMaterial(event.mesh);
		}
	}
	damageSystem.emitter.on(handleDamageEvent);

	const featureCtx: FeatureContext = { world, scene, getVehicle: () => vehicle, carRoot: car.root, quality };
	const occupantsFeature: WorldFeature = await createOccupantsFeature(featureCtx);
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
		}
	}

	/** Full car+damage rebuild at the pristine spawn pose -- mirrors game/src/main.ts's doCarRepair(),
	 * minus the chase-camera/audio/destructible-world bookkeeping this lab has none of. */
	function rebuildCarAndDamage(): void {
		resetCrumpleRegistry(damageSystem.registry);
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
		damageSystem = createDamageSystem(vehicle, damageSystem.registry);
		damageSystem.emitter.on(handleDamageEvent);
		for (const key of PANEL_KEYS) {
			const visual = panelVisuals[key];
			if (visual) repairPanelVisual(visual);
		}
		for (const [meshId, mat] of originalGlassMaterials) {
			const mesh = findDeformableMesh(meshId);
			if (mesh) mesh.material = mat;
		}
		syncCarDeformablesToThree(carDeformables, vehicle.panels);

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
		barrierRig = spawnBarrierRig(world, scene, vehicle, protocol, freeConfig);
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
		if (vehicleGuideVelocity && runElapsedS < vehicleGuideEndS) applyVehicleVelocity(vehicle, vehicleGuideVelocity);
		stepDamageSystem(damageSystem, world, FIXED_DT);
		syncCarDeformablesToThree(carDeformables, vehicle.panels);
		occupantsFeature.afterFixedStep?.(FIXED_DT);
		sampleChassisDecel(decelTracker, vehicle.chassis.getLinearVelocity(), FIXED_DT);

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
	};

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
		chassisTransform.applyTo(car.root, alpha);
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
