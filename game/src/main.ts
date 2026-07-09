import * as THREE from 'three';
import { init, World, liveHandleCount } from '../../src/ts/index.js';
import { createRenderer } from './render/createRenderer';
import {
  QUALITY_PRESETS,
  detectDefaultQuality,
  detectDefaultQualityViaBenchmark,
  loadQualityPreference,
  nextQualityLevel,
  saveQualityPreference,
  type QualityLevel,
} from './render/quality';
import { buildScene } from './scene/buildScene';
import { createOrbitUpdater } from './scene/cameraOrbit';
import { detachWheelVisuals, applyWheelVisual, type WheelVisual } from './scene/wheels';
import {
  createVehicle,
  createGroundBody,
  destroyVehicle,
  stepVehicle,
  getTelemetry,
  type Vehicle,
  type VehicleInput,
  type WheelKey,
  type Telemetry,
} from './vehicle/vehicle';
import { CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT, FIXED_SUBSTEPS } from './vehicle/tuning';
import { FixedStepAccumulator, InterpolatedTransform } from './core/loop';
import {
  installKeyboardInput,
  readKeyboardInput,
  consumeCarResetRequested,
  consumeWorldResetRequested,
  consumeCameraToggleRequested,
  consumeQualityCycleRequested,
  consumeFpsToggleRequested,
  consumeHelpToggleRequested,
} from './input/keyboard';
import { ChaseCamera } from './camera/chase';
import { createDamageSystem, stepDamageSystem, getDamageTelemetry, type DamageSystem, type DamageTelemetry, type DamageEvent } from './damage/system';
import { registerCarDeformables, syncCarDeformablesToThree, type CarDeformableBindings } from './scene/carDeformables';
import { createPanelVisuals, reparentPanelVisual, repairPanelVisual, applyPanelVisual, type PanelVisual } from './scene/panelVisuals';
import { resetCrumpleRegistry } from './damage/crumple';
import { PANEL_KEYS, type PanelKey } from './damage/panels';
import { spawnTestWall as spawnTestWallBody, crashSetup } from './damage/scenario';
import { createDestructibleWorld, resetDestructibleWorld, type DestructibleWorld } from './world/bodies';
import {
  buildDestructibleVisuals,
  sampleDestructibleVisuals,
  applyDestructibleVisuals,
  resnapDestructibleVisuals,
  type DestructibleVisualBundle,
} from './world/visuals';
import { createHud, type HudController } from './hud/hud';

declare global {
  interface Window {
    __GAME__?: {
      ready: boolean;
      quality: QualityLevel;
      setFixedAngle: (radians: number | null) => void;
      renderer: THREE.WebGLRenderer;
      readonly telemetry: Telemetry & { damage: DamageTelemetry };
      setInput: (state: Partial<VehicleInput> | null) => void;
      resetCar: () => void;
      resetWorld: () => void;
      stepN: (n: number) => void;
      spawnTestWall: (distanceAhead?: number) => void;
      crash: (speedKmh: number) => void;
      liveHandleCount: () => number;
      destructibleBodyCount: number;
    };
  }
}

async function main() {
  const appEl = document.getElementById('app')!;
  const hudEl = document.getElementById('hud')!;
  const hud: HudController = createHud(hudEl);

  /** Creates a WebGLRenderer bound to a BRAND-NEW canvas (appended to #app). WebGL context creation
   * right after forcing an existing context to be lost is asynchronous/unreliable in practice
   * (verified directly: swapping antialias by calling forceContextLoss() then immediately
   * constructing a second WebGLRenderer on the SAME canvas throws "Cannot read properties of null
   * (reading 'precision')" -- the browser hadn't actually finished losing the old context yet) -- a
   * fresh canvas sidesteps that timing hazard entirely, since a brand-new canvas always allows
   * immediate context creation. */
  function createRendererOnFreshCanvas(q: (typeof QUALITY_PRESETS)[QualityLevel]): { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } {
    const c = document.createElement('canvas');
    appEl.appendChild(c);
    return { renderer: createRenderer(c, q).renderer, canvas: c };
  }

  hud.setLoadingProgress(0.05, 'starting physics engine…');

  const storedQuality = loadQualityPreference();
  let qualityLevel: QualityLevel = (new URLSearchParams(location.search).get('quality') as QualityLevel) || storedQuality || detectDefaultQuality();
  let quality = QUALITY_PRESETS[qualityLevel];

  let { renderer, canvas } = createRendererOnFreshCanvas(quality);
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 500);

  // ---- Physics world + vehicle (renderer-free core, see vehicle/vehicle.ts's module doc) ----
  const native = await init();
  const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
  createGroundBody(world);
  let vehicle: Vehicle = createVehicle(world);
  const SPAWN_POS = vehicle.spawnPosition;
  const SPAWN_ROT = vehicle.spawnRotation;

  hud.setLoadingProgress(0.15, 'loading scene…');

  // ---- Visual scene ----
  const { scene, car, carFocus, updateSunQuality, rebakeEnvironment } = await buildScene(renderer, quality);
  const wheelVisuals: Record<WheelKey, WheelVisual> = detachWheelVisuals(car.root, scene);
  const IDENTITY_QUAT = new THREE.Quaternion();

  hud.setLoadingProgress(0.65, 'building the world…');

  // ---- Destructible world (G4): renderer-free physics assembly (world/bodies.ts) + procedural PBR
  // visuals (world/visuals.ts) -- 3 stacked-block walls, a crate tower, a barrel bowling triangle, 5
  // tippable poles (all dynamic, spawned asleep), and 2 static ramps. ----
  const destructibleWorld: DestructibleWorld = createDestructibleWorld(world);
  const destructibleVisuals: DestructibleVisualBundle = buildDestructibleVisuals(destructibleWorld);
  scene.add(destructibleVisuals.group);

  hud.setLoadingProgress(0.85, 'assembling damage system…');

  // ---- Damage system (G3): created right after the vehicle/scene, drains world.hitEvents() once per
  // fixed step centrally (system.ts's stepDamageSystem()) and fans it out to the weld-stress/wheel-
  // detach model + the plastic-crumple pipeline. Deformables (chassis shell + the 5 panels + glass)
  // are real GLB mesh geometry here (game/src/scene/carDeformables.ts) -- the headless sim tests use
  // synthetic grid-plane proxies instead (game/sim/damage-harness.mjs), since there's no GLTFLoader in
  // plain node, but both paths drive the exact same renderer-free crumple.ts/welds.ts/panels.ts code. ----
  let damageSystem: DamageSystem = createDamageSystem(vehicle);
  const carDeformables: CarDeformableBindings = registerCarDeformables(damageSystem, car.root, vehicle.panels);
  const panelVisuals: Record<PanelKey, PanelVisual> = createPanelVisuals(car.root);

  // Original (pristine) glass materials, captured once before any shatter swap -- restored by a full
  // car repair (repairCarFully() below).
  const originalGlassMaterials = new Map<string, THREE.Material>();
  for (const b of carDeformables.bindings) {
    if (b.handle.kind === 'glass') originalGlassMaterials.set(b.handle.id, b.mesh.material as THREE.Material);
  }

  function findDeformableMesh(meshId: string) {
    return carDeformables.bindings.find((b) => b.handle.id === meshId)?.mesh ?? null;
  }

  /** GLASS: accumulated glass displacement > threshold -> swap to a 'shattered' variant, once (see
   * damage-tuning.ts's GLASS_SHATTER_THRESHOLD_M). The vertex-level "slight normal jitter" spec detail
   * is already produced for free by the crumple pipeline itself -- glass is just another registered
   * deformable mesh, so a shatter event's own dent already left its normals irregular/cracked-looking
   * (crumple.ts's recomputeNormals() ran on the same jittered, per-vertex-noisy positions). */
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
        reparentPanelVisual(
          visual,
          scene,
          new THREE.Vector3(t.position.x, t.position.y, t.position.z),
          new THREE.Quaternion(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w),
        );
      }
    } else if (event.type === 'glassShattered') {
      applyGlassShatterMaterial(event.mesh);
    } else if (event.type === 'impact') {
      // Camera polish (G5): impact shake, amplitude proportional to approach speed -- covers BOTH
      // car-vs-car-panel hits AND car-vs-destructible-world hits (the damage system's hitTouchesCar()
      // check only requires ONE side of the contact to be the chassis/an attached panel, which every
      // car-vs-wall/crate/barrel/pole collision satisfies -- see damage/welds.ts's hitTouchesCar()).
      chaseCamera.triggerImpact(event.severity);
    }
  }
  damageSystem.emitter.on(handleDamageEvent);

  const chassisTransform = new InterpolatedTransform();
  for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
    const t = vehicle.wheels[key].body.getTransform();
    wheelVisuals[key].transform.sample(t.position, t.rotation);
  }
  {
    const t = vehicle.chassis.getTransform();
    chassisTransform.sample(t.position, t.rotation);
  }

  // ---- Input ----
  installKeyboardInput();
  let externalInput: Partial<VehicleInput> | null = null;

  function currentInput(): VehicleInput {
    const base = readKeyboardInput();
    if (!externalInput) return base;
    return {
      throttle: externalInput.throttle ?? base.throttle,
      brake: externalInput.brake ?? base.brake,
      steer: externalInput.steer ?? base.steer,
      handbrake: externalInput.handbrake ?? base.handbrake,
    };
  }

  // ---- Camera (G5 polish: impact shake + speed-FOV live in ChaseCamera itself) ----
  let cameraMode: 'chase' | 'orbit' = 'chase';
  let fixedAngle: number | null = null;
  const chaseCamera = new ChaseCamera();
  const updateOrbit = createOrbitUpdater(camera, {
    radius: 9,
    height: 3.2,
    angularSpeed: 0.12,
    targetHeight: 0.6,
  });

  // ---- Quality (G5): pixelRatio + shadow map size are live-updatable; antialias is a WebGL context-
  // creation-time flag, so changing it recreates the renderer (forceContextLoss + a fresh
  // WebGLRenderer on the SAME canvas -- three.js objects/textures aren't tied to a renderer instance,
  // so the existing scene renders on the new one with no re-authoring needed). ----
  let currentAntialias = quality.antialias;

  function frameCallback(timestamp: number): void {
    animate(timestamp);
  }

  function applyQuality(level: QualityLevel, persist: boolean): void {
    quality = QUALITY_PRESETS[level];
    qualityLevel = level;
    if (quality.antialias !== currentAntialias) {
      const oldRenderer = renderer;
      const oldCanvas = canvas;
      oldRenderer.setAnimationLoop(null);
      const created = createRendererOnFreshCanvas(quality);
      renderer = created.renderer;
      canvas = created.canvas;
      currentAntialias = quality.antialias;
      // MUST happen before disposing oldRenderer: the PMREM-baked scene.environment texture is a
      // GPU resource owned by whichever renderer's PMREMGenerator produced it (see
      // render/environment.ts's rebake() doc comment) -- without this, the scene loses its IBL/
      // ambient lighting entirely on a renderer swap (verified directly: everything off-axis from
      // the direct sun light rendered near-black).
      rebakeEnvironment(renderer);
      oldRenderer.dispose();
      appEl.removeChild(oldCanvas);
      renderer.setAnimationLoop(frameCallback);
      resize();
    } else {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
    }
    updateSunQuality(quality);
    hud.setQualityLevel(level);
    if (persist) saveQualityPreference(level);
  }

  function doCarRepair(): void {
    // Restore all deformed mesh geometry to cached base positions BEFORE the old vehicle (and its
    // panels record) goes away -- resetCrumpleRegistry() mutates the SAME DeformableMeshHandle
    // objects carDeformables.bindings already reference, in place (see crumple.ts's doc comment), so
    // no re-registration is needed.
    resetCrumpleRegistry(damageSystem.registry);

    destroyVehicle(vehicle);
    vehicle = createVehicle(world, SPAWN_POS, SPAWN_ROT);
    // Reuse the SAME registry (see createDamageSystem()'s doc comment) -- fresh emitter/telemetry/
    // wheel-debounce-counters, but the crumple mesh handles + their now-repaired geometry persist.
    damageSystem = createDamageSystem(vehicle, damageSystem.registry);
    damageSystem.emitter.on(handleDamageEvent);

    for (const key of PANEL_KEYS) {
      const visual = panelVisuals[key];
      if (visual) repairPanelVisual(visual, car.root);
    }
    for (const [meshId, mat] of originalGlassMaterials) {
      const mesh = findDeformableMesh(meshId);
      if (mesh) mesh.material = mat;
    }
    syncCarDeformablesToThree(carDeformables, vehicle.panels);

    const t = vehicle.chassis.getTransform();
    chassisTransform.sample(t.position, t.rotation);
    chassisTransform.sample(t.position, t.rotation); // fill both prev+curr so it doesn't lerp from the old spot
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
    chaseCamera.reset();
  }

  function doWorldRepair(): void {
    doCarRepair();
    resetDestructibleWorld(destructibleWorld);
    resnapDestructibleVisuals(destructibleWorld, destructibleVisuals);
  }

  let physicsMsAccum = 0;
  let physicsStepsAccum = 0;

  function doFixedStep() {
    stepVehicle(vehicle, currentInput(), FIXED_DT);
    const physT0 = performance.now();
    world.step(FIXED_DT, FIXED_SUBSTEPS);
    physicsMsAccum += performance.now() - physT0;
    physicsStepsAccum++;
    stepDamageSystem(damageSystem, world, FIXED_DT);
    syncCarDeformablesToThree(carDeformables, vehicle.panels);
    sampleDestructibleVisuals(destructibleWorld, destructibleVisuals);
    const t = vehicle.chassis.getTransform();
    chassisTransform.sample(t.position, t.rotation);
    for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
      const wt = vehicle.wheels[key].body.getTransform();
      wheelVisuals[key].transform.sample(wt.position, wt.rotation);
    }
    for (const key of PANEL_KEYS) {
      const visual = panelVisuals[key];
      if (!visual) continue;
      const pt = vehicle.panels[key].body.getTransform();
      visual.transform.sample(pt.position, pt.rotation);
    }
    hud.onInput(currentInput());
    hud.updateDamage(getDamageTelemetry(damageSystem));
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  let showPerf = false;

  window.__GAME__ = {
    ready: false,
    get quality() {
      return qualityLevel;
    },
    setFixedAngle: (radians) => {
      fixedAngle = radians;
      if (radians !== null) cameraMode = 'orbit'; // preserves verify/shoot.mjs's existing fixed-orbit-screenshot behavior
    },
    get renderer() {
      return renderer;
    },
    get telemetry() {
      return { ...getTelemetry(vehicle), damage: getDamageTelemetry(damageSystem) };
    },
    setInput: (state) => {
      externalInput = state;
    },
    resetCar: doCarRepair,
    resetWorld: doWorldRepair,
    stepN: (n) => {
      for (let i = 0; i < n; i++) doFixedStep();
    },
    spawnTestWall: (distanceAhead = 25) => {
      spawnTestWallBody(world, vehicle, distanceAhead);
    },
    crash: (speedKmh) => {
      crashSetup(vehicle, speedKmh);
    },
    liveHandleCount: () => liveHandleCount(),
    destructibleBodyCount: destructibleWorld.bodies.length,
  };

  resize();

  // ---- Quality: default chosen once at boot from devicePixelRatio + a quick render benchmark (only
  // when the player has no saved preference yet -- see render/quality.ts's doc comments). Runs BEFORE
  // the real animation loop starts (a short burst of manual renderer.render() calls), so it can't
  // double up with the real per-frame render loop below. ----
  if (!storedQuality && !new URLSearchParams(location.search).get('quality')) {
    hud.setLoadingProgress(0.95, 'tuning quality for this device…');
    const benchLevel = await detectDefaultQualityViaBenchmark(() => renderer.render(scene, camera), 45);
    if (benchLevel !== qualityLevel) applyQuality(benchLevel, false);
    saveQualityPreference(qualityLevel);
  }
  hud.setQualityLevel(qualityLevel);

  const accumulator = new FixedStepAccumulator(FIXED_DT);
  const timer = new THREE.Timer();
  timer.connect(document);
  let frameCount = 0;
  let fpsAccum = 0;
  let fpsTimer = 0;
  let fps = 0;

  hud.setLoadingProgress(1, 'ready');
  hud.hideLoadingScreen();
  window.__GAME__.ready = true;

  function animate(timestamp: number): void {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.1); // clamp huge stalls (tab backgrounded, devtools pause, etc.)

    if (consumeCarResetRequested()) doCarRepair();
    if (consumeWorldResetRequested()) doWorldRepair();
    if (consumeCameraToggleRequested()) cameraMode = cameraMode === 'chase' ? 'orbit' : 'chase';
    if (consumeQualityCycleRequested()) applyQuality(nextQualityLevel(qualityLevel), true);
    if (consumeFpsToggleRequested()) {
      showPerf = !showPerf;
      hud.setPerfVisible(showPerf);
    }
    if (consumeHelpToggleRequested()) hud.toggleHelpCard();

    const alpha = accumulator.advance(dt, doFixedStep);

    for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
      applyWheelVisual(wheelVisuals[key], IDENTITY_QUAT, alpha);
    }
    for (const key of PANEL_KEYS) {
      const visual = panelVisuals[key];
      if (visual) applyPanelVisual(visual, alpha);
    }
    applyDestructibleVisuals(destructibleVisuals, alpha);
    chassisTransform.applyTo(car.root, alpha);
    // The physics chassis body's origin sits at ~hub height (tuning.ts's CHASSIS_ORIGIN_HEIGHT_M
    // above the ground -- see its doc comment), but the visual car model's own root is authored at
    // ground level (car-map.ts's axisConvention note: "wheel bottoms at world Y ~ 0"). Translate the
    // visual root down by that offset along the chassis's OWN (current) up axis so the body doesn't
    // visually float above the wheels.
    car.root.translateY(-CHASSIS_ORIGIN_HEIGHT_M);

    if (cameraMode === 'orbit') {
      // Track the car's CURRENT x/z (keeping carFocus's authored half-height y offset) so the orbit
      // circles wherever the car actually is, not just its spawn point -- matters once the car has
      // driven/crashed away from the origin (verify/shoot-crash.mjs's post-crash orbit shot).
      const currentPos = vehicle.chassis.getPosition();
      carFocus.x = currentPos.x;
      carFocus.z = currentPos.z;
      const elapsed = fixedAngle !== null ? fixedAngle / 0.12 : timer.getElapsed();
      updateOrbit(elapsed, carFocus);
    } else {
      const carPos = new THREE.Vector3();
      const carQuat = new THREE.Quaternion();
      chassisTransform.lerpPosition(carPos, alpha);
      chassisTransform.lerpQuaternion(carQuat, alpha);
      const vel = vehicle.chassis.getLinearVelocity();
      chaseCamera.update(camera, carPos, carQuat, new THREE.Vector3(vel.x, vel.y, vel.z), dt);
    }

    renderer.render(scene, camera);

    frameCount++;
    fpsAccum += dt;
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      fps = Math.round(fpsAccum > 0 ? 1 / (fpsAccum / frameCount) : 0);
      const t = getTelemetry(vehicle);
      hud.updateTelemetry(t, cameraMode);
      const avgPhysicsMs = physicsStepsAccum > 0 ? physicsMsAccum / physicsStepsAccum : 0;
      hud.updatePerf(fps, avgPhysicsMs);
      physicsMsAccum = 0;
      physicsStepsAccum = 0;
      frameCount = 0;
      fpsAccum = 0;
      fpsTimer = 0;
    }
  }

  renderer.setAnimationLoop(frameCallback);
}

main().catch((err) => {
  console.error('[game] fatal init error:', err);
  const hudEl = document.getElementById('hud');
  if (hudEl) hudEl.textContent = `FATAL: ${(err as Error).message}`;
});
