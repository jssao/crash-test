import * as THREE from 'three';
import { init, World, liveHandleCount, type Body } from '../../src/ts/index.js';
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
import {
  createOrbitUpdater,
  createUserOrbitController,
  sphericalFromCylindrical,
  sphericalFromCameraPose,
} from './scene/cameraOrbit';
import { detachWheelVisuals, applyWheelVisual, type WheelVisual } from './scene/wheels';
import {
  createVehicle,
  destroyVehicle,
  stepVehicle,
  getTelemetry,
  getSuspensionDeflection,
  type Vehicle,
  type VehicleInput,
  type WheelKey,
  type Telemetry,
} from './vehicle/vehicle';
import { createTerrainGroundBody } from './world/terrain/terrainBody';
import { CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT, FIXED_SUBSTEPS, VISUAL_RIDE_LIFT_M } from './vehicle/tuning';
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
import { installPointerInput, consumeDragDelta, consumeZoomDelta } from './input/pointer';
import { ChaseCamera } from './camera/chase';
import { createDamageSystem, stepDamageSystem, getDamageTelemetry, type DamageSystem, type DamageTelemetry, type DamageEvent } from './damage/system';
import { registerCarDeformables, syncCarDeformablesToThree, type CarDeformableBindings } from './scene/carDeformables';
import { createPanelVisuals, reparentPanelVisual, repairPanelVisual, applyPanelVisual, type PanelVisual } from './scene/panelVisuals';
import { resetCrumpleRegistry } from './damage/crumple';
import { PANEL_KEYS, type PanelKey } from './damage/panels';
import { spawnTestWall as spawnTestWallBody, destroyTestWall, crashSetup } from './damage/scenario';
import { createDestructibleWorld, resetDestructibleWorld, type DestructibleWorld } from './world/bodies';
import {
  buildDestructibleVisuals,
  sampleDestructibleVisuals,
  applyDestructibleVisuals,
  resnapDestructibleVisuals,
  type DestructibleVisualBundle,
} from './world/visuals';
import { createHud, type HudController } from './hud/hud';
import { createWorldFeatures, type WorldFeatureSet } from './world/features/registry';
import { createAudioSystem, collectCarShapes, type AudioSystem, type AudioDebugSnapshot } from './audio';

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
      /** PLAYTEST HOOK (read-only): world-Y position of each wheel body -- lets a scripted playtest
       * measure ramp airtime (a wheel well above its resting height indicates the car left the
       * ground) without needing a three.js/DOM inspection. */
      wheelHeights: () => Record<WheelKey, number>;
      /** VERIFY HOOK (read-only): per-wheel suspension deflection (meters), the SAME signal
       * game/sim/heightfield-drive.test.mjs measures -- lets verify/terrain.mjs quantify how much more
       * the dirt road exercises the suspension than the flat apron without a lossy body-motion proxy. */
      suspensionDeflections: () => Record<WheelKey, number>;
      /** PLAYTEST HOOK (read-only): distance (meters) each destructible-world body has moved from its
       * spawn pose right now -- lets a scripted playtest count "blocks displaced > 0.5m" after a wall/
       * tower/barrel hit without re-deriving DestructibleWorld internals itself. */
      destructibleDisplacements: () => number[];
      /** PLAYTEST HOOK (read-only): total live physics bodies owned by world features (trees,
       * buildings, occupants, car-detail parts, ...) — physics-everywhere inventory accounting. */
      featureBodyCount: () => number;
      /** PLAYTEST HOOK (read-only): per-feature hooks published by each WorldFeature (see
       * world/features/feature.ts). */
      features: Record<string, Record<string, unknown>>;
      /** VERIFY HOOK: reconfigure the orbit camera (close-ups for screenshots -- verify scripts
       * pair this with setFixedAngle()). Omitted fields keep the current value. */
      setOrbitView: (opts: { radius?: number; height?: number; targetHeight?: number }) => void;
      /** VERIFY HOOK (read-only): live camera-orbit state for camera-drag.mjs -- exposes the current
       * mode, whether the click-drag user-orbit controller has taken over from the auto-spin (see
       * scene/cameraOrbit.ts), its damped azimuth/polar/radius, and the camera's world position, so a
       * synthetic-drag test can assert those values actually changed without reaching into three.js
       * internals itself. */
      cameraDebug: () => {
        mode: 'chase' | 'orbit';
        userOrbitActive: boolean;
        azimuth: number;
        polar: number;
        radius: number;
        position: [number, number, number];
      };
      /** VERIFY/DIAGNOSTIC HOOK (read-only): per-panel visual-vs-body pose snapshot. Exposes the
       * VISUAL layer the reset-integrity checks assert on (existing hooks only ever measured physics
       * bodies/counts, never the rendered panel meshes). Returns, per PanelKey: the mesh's live
       * world transform (pos/quat/scale, after updateWorldMatrix), its local transform + parent node
       * name (to catch reparent-restore mistakes), the reparented flag, and the panel body's world
       * pose (null once despawned). Forces a fresh world-matrix update so callers get frame-accurate
       * values even between renders (scripted stepN batches). */
      dumpPanelVisuals: () => {
        /** Chassis body world pose, sampled in the SAME synchronous call as the panels below so a
         * caller can express each panel's visual pose in the chassis frame atomically (immune to the
         * real-time animation loop stepping physics between two separate CDP evals). */
        chassis: { pos: [number, number, number]; quat: [number, number, number, number] };
        panels: Record<
          string,
          {
            parent: string | null;
            reparented: boolean;
            worldPos: [number, number, number];
            worldQuat: [number, number, number, number];
            worldScale: [number, number, number];
            localPos: [number, number, number];
            localQuat: [number, number, number, number];
            localScale: [number, number, number];
            bodyPos: [number, number, number] | null;
            bodyQuat: [number, number, number, number] | null;
            state: string;
            despawned: boolean;
          }
        >;
      };
      /** DIAGNOSTIC HOOK (read-only): whether the chassis body is currently awake (box3d sleeps a car
       * held at rest). */
      chassisAwake: () => boolean;
      /** DIAGNOSTIC HOOK (read-only): the reverse-engage decision variables stepVehicle() computes
       * internally -- signed forward-axis road speed (+ forward / - backward), awake state, and the two
       * driven-wheel spin speeds -- so a headless reverse check can see WHY reverse did or didn't
       * engage without re-deriving them from pose deltas. */
      debugReverse: () => {
        awake: boolean;
        forwardSpeed: number;
        rearOmegaRL: number | null;
        rearOmegaRR: number | null;
        driveDebug: Vehicle['driveDebug'];
        grounded: Record<WheelKey, boolean>;
        deflection: Record<WheelKey, number>;
      };
      /** VERIFY HOOK (read-only): crash-audio node-graph snapshot -- see game/verify/audio-check.mjs
       * and game/src/audio/engine.ts's debugSnapshot(). */
      audioDebug: () => AudioDebugSnapshot;
      /** VERIFY HOOK: mirrors the M key (mute toggle) without needing a synthetic keydown -- returns
       * the new muted state. */
      toggleMute: () => boolean;
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
  // GAME ground: the real terrain height-field (world/terrain). The headless vehicle harness keeps its
  // flat createGroundBody default, so the 95 sim tests are untouched. The apron under spawn + the
  // legacy destructibles is hard-flat (h=0), so chassis/destructible/feature spawn heights are unchanged.
  createTerrainGroundBody(world);
  let vehicle: Vehicle = createVehicle(world);
  const SPAWN_POS = vehicle.spawnPosition;
  const SPAWN_ROT = vehicle.spawnRotation;
  // LEAK FIX: the playtest-only test wall (window.__GAME__.spawnTestWall) has exactly one owner (this
  // module) -- tracked here so a repeat spawnTestWall() call or a world reset can destroy the PREVIOUS
  // wall's native handles (shape+body) before replacing/clearing it. See damage/scenario.ts's
  // destroyTestWall() doc comment for the root-cause history (soak isolation: spawnTestWall+resetWorld
  // x10 leaked a perfectly linear +2 handles/call, never reclaimed, since neither this hook nor
  // doWorldRepair() ever destroyed a previously-spawned wall).
  let testWallBody: Body | null = null;

  hud.setLoadingProgress(0.15, 'loading scene…');

  // ---- Visual scene ----
  const { scene, car, carFocus, updateSunQuality, updateSunFollow, rebakeEnvironment } = await buildScene(renderer, quality);
  const wheelVisuals: Record<WheelKey, WheelVisual> = detachWheelVisuals(car.root, scene);
  const IDENTITY_QUAT = new THREE.Quaternion();

  hud.setLoadingProgress(0.65, 'building the world…');

  // ---- Destructible world (G4): renderer-free physics assembly (world/bodies.ts) + procedural PBR
  // visuals (world/visuals.ts) -- 3 stacked-block walls, a crate tower, a barrel bowling triangle, 5
  // tippable poles (all dynamic, spawned asleep), and 2 static ramps. ----
  const destructibleWorld: DestructibleWorld = createDestructibleWorld(world);
  const destructibleVisuals: DestructibleVisualBundle = buildDestructibleVisuals(destructibleWorld);
  scene.add(destructibleVisuals.group);

  // ---- World features (RUN 2): self-contained content modules (trees, buildings, occupants,
  // car-detail parts, ...) discovered from world/features/*/index.ts — see feature.ts's contract. ----
  const features: WorldFeatureSet = await createWorldFeatures({
    world,
    scene,
    getVehicle: () => vehicle,
    carRoot: car.root,
    quality,
  });

  hud.setLoadingProgress(0.85, 'assembling damage system…');

  // ---- Damage system (G3): created right after the vehicle/scene, drains world.hitEvents() once per
  // fixed step centrally (system.ts's stepDamageSystem()) and fans it out to the weld-stress/wheel-
  // detach model + the plastic-crumple pipeline. Deformables (chassis shell + the 5 panels + glass)
  // are real GLB mesh geometry here (game/src/scene/carDeformables.ts) -- the headless sim tests use
  // synthetic grid-plane proxies instead (game/sim/damage-harness.mjs), since there's no GLTFLoader in
  // plain node, but both paths drive the exact same renderer-free crumple.ts/welds.ts/panels.ts code. ----
  let damageSystem: DamageSystem = createDamageSystem(vehicle);
  const carDeformables: CarDeformableBindings = registerCarDeformables(damageSystem, car.root, vehicle.panels);

  // ---- Crash audio (procedurally synthesized, no asset files -- see game/src/audio/engine.ts's
  // module doc): drains the newly-wired hit/contactBegin/contactEnd events + telemetry every fixed
  // step. armShapes() is idempotent/cheap, so re-arming every step (below) survives doCarRepair()'s
  // vehicle/damageSystem recreation and breakPanelWeld()'s shape recreation with zero extra wiring. ----
  const audioSystem: AudioSystem = createAudioSystem();
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

  // OCCUPANTS glass-shatter hook (additive): the occupants feature (world/features/occupants) detects
  // an ejecting passenger's head/torso trajectory crossing a cabin-glass plane and calls this sink with
  // the car-map glass NODE name; translate that to the matching registered glass deformable's mesh id
  // and fire the SAME glassShattered event the crumple pipeline uses, so the existing material-swap
  // (applyGlassShatterMaterial via handleDamageEvent) runs identically. `damageSystem` is captured by
  // reference so it stays correct across car repairs (it's reassigned in doCarRepair). Kept here (not a
  // FeatureContext field) so the only shared-file touch is this one additive block.
  {
    const occHooks = features.hooks['occupants'] as { setGlassShatterSink?: (fn: (node: string) => void) => void } | undefined;
    occHooks?.setGlassShatterSink?.((node) => {
      for (const b of carDeformables.bindings) {
        if (b.handle.kind === 'glass' && (b.mesh.name === node || b.mesh.parent?.name === node)) {
          damageSystem.emitter.emit({ type: 'glassShattered', mesh: b.handle.id });
        }
      }
    });
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
  // Left-mouse-drag anywhere over #app orbits the camera, wheel zooms it (see input/pointer.ts's doc
  // comment on why #app -- the stable container -- is the hit-target rather than the canvas, which
  // gets replaced on antialias-driven quality changes).
  installPointerInput(appEl);
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
  let orbitOpts = {
    radius: 9,
    height: 3.2,
    angularSpeed: 0.12,
    targetHeight: 0.6,
  };
  let updateOrbit = createOrbitUpdater(camera, orbitOpts);
  // User-driven orbit (click-drag azimuth/polar + wheel-zoom radius): a separate opt-in layer on top
  // of updateOrbit's auto-spin (see scene/cameraOrbit.ts's doc comment) -- inactive (auto-spin plays)
  // until the player's first drag/scroll, and reset back to inactive whenever the camera cycles away
  // from and back into orbit mode (C, C), per spec.
  const userOrbit = createUserOrbitController(sphericalFromCylindrical(orbitOpts.radius, orbitOpts.height));

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
      if (visual) repairPanelVisual(visual);
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
    features.reset('car');
  }

  function doWorldRepair(): void {
    doCarRepair();
    // LEAK FIX: a full world reset clears any playtest-spawned test wall too (see testWallBody's doc
    // comment above) -- destroys shape+body and drops the reference so a stale wall can never be
    // double-destroyed by a later call.
    if (testWallBody) {
      destroyTestWall(testWallBody);
      testWallBody = null;
    }
    resetDestructibleWorld(destructibleWorld);
    resnapDestructibleVisuals(destructibleWorld, destructibleVisuals);
    features.reset('world');
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
    audioSystem.armShapes(collectCarShapes(vehicle, damageSystem));
    audioSystem.processStep(world, vehicle, FIXED_DT);
    syncCarDeformablesToThree(carDeformables, vehicle.panels);
    sampleDestructibleVisuals(destructibleWorld, destructibleVisuals);
    features.afterFixedStep(FIXED_DT);
    const t = vehicle.chassis.getTransform();
    chassisTransform.sample(t.position, t.rotation);
    for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
      const wt = vehicle.wheels[key].body.getTransform();
      wheelVisuals[key].transform.sample(wt.position, wt.rotation);
    }
    for (const key of PANEL_KEYS) {
      const visual = panelVisuals[key];
      // BLOCKER FIX: stepDamageSystem() above can despawn (destroy) a broken panel's body THIS SAME
      // step (system.ts's despawn-timer logic, ~PANEL_DESPAWN_AFTER_S after it broke). Body.getTransform()
      // on an already-destroyed body is a wasm "memory access out of bounds" trap, not a catchable JS
      // error -- it poisons the whole module permanently (every subsequent call fails identically, see
      // repro-oob.mjs). Must skip despawned panels here exactly like damage/system.ts's own
      // transformFor() already does.
      if (!visual || vehicle.panels[key].despawned) continue;
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
      // LEAK FIX (replace semantics): destroy the PREVIOUS wall (if any) before spawning a new one --
      // see testWallBody's doc comment above.
      if (testWallBody) destroyTestWall(testWallBody);
      testWallBody = spawnTestWallBody(world, vehicle, distanceAhead);
    },
    crash: (speedKmh) => {
      crashSetup(vehicle, speedKmh);
    },
    liveHandleCount: () => liveHandleCount(),
    destructibleBodyCount: destructibleWorld.bodies.length,
    wheelHeights: () => {
      const out = {} as Record<WheelKey, number>;
      for (const key of Object.keys(vehicle.wheels) as WheelKey[]) {
        out[key] = vehicle.wheels[key].body.getPosition().y;
      }
      return out;
    },
    suspensionDeflections: () => {
      const out = {} as Record<WheelKey, number>;
      for (const key of Object.keys(vehicle.wheels) as WheelKey[]) out[key] = getSuspensionDeflection(vehicle, key);
      return out;
    },
    destructibleDisplacements: () =>
      destructibleWorld.bodies.map((b) => {
        const p = b.body.getPosition();
        return Math.hypot(p.x - b.spawnPos.x, p.y - b.spawnPos.y, p.z - b.spawnPos.z);
      }),
    featureBodyCount: () => features.totalBodyCount(),
    features: features.hooks,
    setOrbitView: (opts) => {
      orbitOpts = { ...orbitOpts, ...opts };
      updateOrbit = createOrbitUpdater(camera, orbitOpts);
    },
    cameraDebug: () => ({
      mode: cameraMode,
      userOrbitActive: userOrbit.active,
      azimuth: userOrbit.azimuth,
      polar: userOrbit.polar,
      radius: userOrbit.radius,
      position: [camera.position.x, camera.position.y, camera.position.z],
    }),
    dumpPanelVisuals: () => {
      const panelsOut: Record<string, unknown> = {};
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      const ws = new THREE.Vector3();
      const ct = vehicle.chassis.getTransform();
      for (const key of PANEL_KEYS) {
        const visual = panelVisuals[key];
        const panel = vehicle.panels[key];
        if (!visual) {
          panelsOut[key] = null;
          continue;
        }
        visual.object.updateWorldMatrix(true, false);
        visual.object.matrixWorld.decompose(wp, wq, ws);
        const bodyPose = panel.despawned ? null : panel.body.getTransform();
        panelsOut[key] = {
          parent: visual.object.parent ? visual.object.parent.name || '(unnamed)' : null,
          reparented: visual.reparented,
          worldPos: [wp.x, wp.y, wp.z],
          worldQuat: [wq.x, wq.y, wq.z, wq.w],
          worldScale: [ws.x, ws.y, ws.z],
          localPos: [visual.object.position.x, visual.object.position.y, visual.object.position.z],
          localQuat: [visual.object.quaternion.x, visual.object.quaternion.y, visual.object.quaternion.z, visual.object.quaternion.w],
          localScale: [visual.object.scale.x, visual.object.scale.y, visual.object.scale.z],
          bodyPos: bodyPose ? [bodyPose.position.x, bodyPose.position.y, bodyPose.position.z] : null,
          bodyQuat: bodyPose ? [bodyPose.rotation.x, bodyPose.rotation.y, bodyPose.rotation.z, bodyPose.rotation.w] : null,
          state: panel.state,
          despawned: panel.despawned,
        };
      }
      return {
        chassis: { pos: [ct.position.x, ct.position.y, ct.position.z], quat: [ct.rotation.x, ct.rotation.y, ct.rotation.z, ct.rotation.w] },
        panels: panelsOut,
      } as ReturnType<NonNullable<Window['__GAME__']>['dumpPanelVisuals']>;
    },
    chassisAwake: () => vehicle.chassis.isAwake(),
    debugReverse: () => {
      const vel = vehicle.chassis.getLinearVelocity();
      const q = vehicle.chassis.getRotation();
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      const grounded = {} as Record<WheelKey, boolean>;
      const deflection = {} as Record<WheelKey, number>;
      for (const key of Object.keys(vehicle.wheels) as WheelKey[]) {
        grounded[key] = vehicle.wheelGrounded[key];
        deflection[key] = getSuspensionDeflection(vehicle, key);
      }
      return {
        awake: vehicle.chassis.isAwake(),
        forwardSpeed: vel.x * fwd.x + vel.y * fwd.y + vel.z * fwd.z,
        rearOmegaRL: vehicle.wheels.rl.joint ? vehicle.wheels.rl.joint.getSpinSpeed() : null,
        rearOmegaRR: vehicle.wheels.rr.joint ? vehicle.wheels.rr.joint.getSpinSpeed() : null,
        driveDebug: vehicle.driveDebug,
        grounded,
        deflection,
      };
    },
    audioDebug: () => audioSystem.debugSnapshot(),
    toggleMute: () => audioSystem.toggleMute(),
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
    if (consumeCameraToggleRequested()) {
      cameraMode = cameraMode === 'chase' ? 'orbit' : 'chase';
      if (cameraMode === 'orbit') {
        // C-cycling back into orbit resumes auto-spin (per spec) -- seed the user-orbit controller
        // from wherever the auto-spin view currently sits so a drag right after doesn't snap.
        const elapsed = fixedAngle !== null ? fixedAngle / 0.12 : timer.getElapsed();
        userOrbit.reset(sphericalFromCylindrical(orbitOpts.radius, orbitOpts.height, elapsed * orbitOpts.angularSpeed));
      }
    }
    // Click-drag orbits the camera, wheel zooms it -- both switch into (or stay in) orbit mode,
    // taking over from either chase or the auto-spin (see scene/cameraOrbit.ts's UserOrbitController).
    // Only ever fed by real pointer input (input/pointer.ts), so setFixedAngle()/setOrbitView()-driven
    // verify screenshots -- which never dispatch pointer events -- are completely unaffected.
    const dragDelta = consumeDragDelta();
    const zoomDelta = consumeZoomDelta();
    if (dragDelta.azimuth !== 0 || dragDelta.polar !== 0 || zoomDelta !== 0) {
      if (cameraMode !== 'orbit' || !userOrbit.active) {
        // TAKEOVER SEED (user bug: click "resets the camera angle"): the controller's pose was last
        // seeded at boot/C-cycle, so activating it mid-chase damped the camera toward that stale
        // pose. Seed from where the camera ACTUALLY is right now, around the car's current focus,
        // so taking control is seamless from any prior camera state.
        const currentPos = vehicle.chassis.getPosition();
        carFocus.x = currentPos.x;
        carFocus.z = currentPos.z;
        userOrbit.reset(sphericalFromCameraPose(camera.position, carFocus));
      }
      cameraMode = 'orbit';
      if (dragDelta.azimuth !== 0 || dragDelta.polar !== 0) userOrbit.drag(dragDelta.azimuth, dragDelta.polar);
      if (zoomDelta !== 0) userOrbit.zoom(zoomDelta);
    }
    // Counter, not a boolean (see keyboard.ts's doc comment): apply one cycle per Q press recorded
    // since the last frame, so rapid presses aren't silently coalesced into a single cycle.
    const qualityCyclePresses = consumeQualityCycleRequested();
    for (let i = 0; i < qualityCyclePresses; i++) applyQuality(nextQualityLevel(qualityLevel), true);
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
    features.applyVisuals(alpha);
    chassisTransform.applyTo(car.root, alpha);
    // The physics chassis body's origin sits at ~hub height (tuning.ts's CHASSIS_ORIGIN_HEIGHT_M
    // above the ground -- see its doc comment), but the visual car model's own root is authored at
    // ground level (car-map.ts's axisConvention note: "wheel bottoms at world Y ~ 0"). Translate the
    // visual root down by that offset along the chassis's OWN (current) up axis so the body doesn't
    // visually float above the wheels.
    // VISUAL_RIDE_LIFT_M (suspension round 2): also seat the body its authored ride-height ABOVE where
    // the soft/heavily-laden suspension physically rests -- the render-layer half of the "un-slam" fix.
    // Attached panels are car.root children so they follow; wheels are scene-parented (physics-driven,
    // on the ground) so they don't. See VISUAL_RIDE_LIFT_M's doc comment for why this is visual, not
    // a physics rest-length change, and its crash-time residual.
    car.root.translateY(-CHASSIS_ORIGIN_HEIGHT_M + VISUAL_RIDE_LIFT_M);

    if (cameraMode === 'orbit') {
      // Track the car's CURRENT x/z (keeping carFocus's authored half-height y offset) so the orbit
      // circles wherever the car actually is, not just its spawn point -- matters once the car has
      // driven/crashed away from the origin (verify/shoot-crash.mjs's post-crash orbit shot).
      const currentPos = vehicle.chassis.getPosition();
      carFocus.x = currentPos.x;
      carFocus.z = currentPos.z;
      if (userOrbit.active) {
        userOrbit.update(camera, carFocus, orbitOpts.targetHeight, dt);
      } else {
        const elapsed = fixedAngle !== null ? fixedAngle / 0.12 : timer.getElapsed();
        updateOrbit(elapsed, carFocus);
      }
    } else {
      const carPos = new THREE.Vector3();
      const carQuat = new THREE.Quaternion();
      chassisTransform.lerpPosition(carPos, alpha);
      chassisTransform.lerpQuaternion(carQuat, alpha);
      const vel = vehicle.chassis.getLinearVelocity();
      chaseCamera.update(camera, carPos, carQuat, new THREE.Vector3(vel.x, vel.y, vel.z), dt);
    }

    // Keep the sun's tight shadow frustum centred on the car wherever it drives in the 400m world.
    {
      const cp = vehicle.chassis.getPosition();
      updateSunFollow(cp.x, cp.z);
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
