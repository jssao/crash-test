import * as THREE from 'three';
import { init, World } from '../../src/ts/index.js';
import { createRenderer } from './render/createRenderer';
import { QUALITY_PRESETS, detectDefaultQuality, type QualityLevel } from './render/quality';
import { buildScene } from './scene/buildScene';
import { createOrbitUpdater } from './scene/cameraOrbit';
import { detachWheelVisuals, applyWheelVisual, type WheelVisual } from './scene/wheels';
import { createVehicle, createGroundBody, stepVehicle, getTelemetry, resetVehicle, type Vehicle, type VehicleInput, type WheelKey, type Telemetry } from './vehicle/vehicle';
import { CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT, FIXED_SUBSTEPS } from './vehicle/tuning';
import { FixedStepAccumulator, InterpolatedTransform } from './core/loop';
import { installKeyboardInput, readKeyboardInput, consumeResetRequested, consumeCameraToggleRequested } from './input/keyboard';
import { ChaseCamera } from './camera/chase';
import { createDamageSystem, stepDamageSystem, getDamageTelemetry, type DamageSystem, type DamageTelemetry } from './damage/system';
import { registerCarDeformables, syncCarDeformablesToThree, type CarDeformableBindings } from './scene/carDeformables';
import { createPanelVisuals, reparentPanelVisual, applyPanelVisual, type PanelVisual } from './scene/panelVisuals';
import { PANEL_KEYS, type PanelKey } from './damage/panels';
import { spawnTestWall as spawnTestWallBody, crashSetup } from './damage/scenario';

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
      stepN: (n: number) => void;
      spawnTestWall: (distanceAhead?: number) => void;
      crash: (speedKmh: number) => void;
    };
  }
}

async function main() {
  const appEl = document.getElementById('app')!;
  const hudEl = document.getElementById('hud')!;
  const canvas = document.createElement('canvas');
  appEl.appendChild(canvas);

  const qualityLevel: QualityLevel = (new URLSearchParams(location.search).get('quality') as QualityLevel) || detectDefaultQuality();
  const quality = QUALITY_PRESETS[qualityLevel];

  const { renderer } = createRenderer(canvas, quality);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);

  // ---- Physics world + vehicle (renderer-free core, see vehicle/vehicle.ts's module doc) ----
  const native = await init();
  const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
  createGroundBody(world);
  const vehicle: Vehicle = createVehicle(world);

  // ---- Visual scene ----
  const { scene, car, carFocus } = await buildScene(renderer, quality);
  const wheelVisuals: Record<WheelKey, WheelVisual> = detachWheelVisuals(car.root, scene);
  const IDENTITY_QUAT = new THREE.Quaternion();

  // ---- Damage system (G3): created right after the vehicle/scene, drains world.hitEvents() once per
  // fixed step centrally (system.ts's stepDamageSystem()) and fans it out to the weld-stress/wheel-
  // detach model + the plastic-crumple pipeline. Deformables (chassis shell + the 5 panels + glass)
  // are real GLB mesh geometry here (game/src/scene/carDeformables.ts) -- the headless sim tests use
  // synthetic grid-plane proxies instead (game/sim/damage-harness.mjs), since there's no GLTFLoader in
  // plain node, but both paths drive the exact same renderer-free crumple.ts/welds.ts/panels.ts code. ----
  const damageSystem: DamageSystem = createDamageSystem(vehicle);
  const carDeformables: CarDeformableBindings = registerCarDeformables(damageSystem, car.root, vehicle.panels);
  const panelVisuals: Record<PanelKey, PanelVisual> = createPanelVisuals(car.root);

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

  damageSystem.emitter.on((event) => {
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
    }
  });

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

  // ---- Camera ----
  let cameraMode: 'chase' | 'orbit' = 'chase';
  let fixedAngle: number | null = null;
  const chaseCamera = new ChaseCamera();
  const updateOrbit = createOrbitUpdater(camera, {
    radius: 7.2,
    height: 2.2,
    angularSpeed: 0.12,
    targetHeight: 0.55,
  });

  function doReset() {
    resetVehicle(vehicle);
    const t = vehicle.chassis.getTransform();
    chassisTransform.sample(t.position, t.rotation);
    chassisTransform.sample(t.position, t.rotation); // fill both prev+curr so it doesn't lerp from the old spot
    for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
      const wt = vehicle.wheels[key].body.getTransform();
      wheelVisuals[key].transform.sample(wt.position, wt.rotation);
      wheelVisuals[key].transform.sample(wt.position, wt.rotation);
    }
    chaseCamera.reset();
  }

  function doFixedStep() {
    stepVehicle(vehicle, currentInput(), FIXED_DT);
    world.step(FIXED_DT, FIXED_SUBSTEPS);
    stepDamageSystem(damageSystem, world, FIXED_DT);
    syncCarDeformablesToThree(carDeformables, vehicle.panels);
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
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  window.__GAME__ = {
    ready: false,
    quality: qualityLevel,
    renderer,
    setFixedAngle: (radians) => {
      fixedAngle = radians;
      if (radians !== null) cameraMode = 'orbit'; // preserves verify/shoot.mjs's existing fixed-orbit-screenshot behavior
    },
    get telemetry() {
      return { ...getTelemetry(vehicle), damage: getDamageTelemetry(damageSystem) };
    },
    setInput: (state) => {
      externalInput = state;
    },
    resetCar: doReset,
    stepN: (n) => {
      for (let i = 0; i < n; i++) doFixedStep();
    },
    spawnTestWall: (distanceAhead = 25) => {
      spawnTestWallBody(world, vehicle, distanceAhead);
    },
    crash: (speedKmh) => {
      crashSetup(vehicle, speedKmh);
    },
  };

  resize();

  const accumulator = new FixedStepAccumulator(FIXED_DT);
  const timer = new THREE.Timer();
  timer.connect(document);
  let frameCount = 0;
  let fpsAccum = 0;
  let fpsTimer = 0;
  let fps = 0;

  window.__GAME__.ready = true;

  renderer.setAnimationLoop((timestamp: number) => {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.1); // clamp huge stalls (tab backgrounded, devtools pause, etc.)

    if (consumeResetRequested()) doReset();
    if (consumeCameraToggleRequested()) cameraMode = cameraMode === 'chase' ? 'orbit' : 'chase';

    const alpha = accumulator.advance(dt, doFixedStep);

    for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
      applyWheelVisual(wheelVisuals[key], IDENTITY_QUAT, alpha);
    }
    for (const key of PANEL_KEYS) {
      const visual = panelVisuals[key];
      if (visual) applyPanelVisual(visual, alpha);
    }
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
      const rpmBarWidth = 20;
      const rpmFrac = Math.min(1, t.rpm / 6800);
      const rpmBar = '#'.repeat(Math.round(rpmFrac * rpmBarWidth)).padEnd(rpmBarWidth, '-');
      hudEl.textContent =
        `speed:  ${t.speedKmh.toFixed(0).padStart(3)} km/h\n` +
        `gear:   ${t.gear}\n` +
        `rpm:    [${rpmBar}] ${t.rpm.toFixed(0)}\n` +
        `fps:    ${fps}\n` +
        `cam:    ${cameraMode} (C to toggle, R to reset)`;
      frameCount = 0;
      fpsAccum = 0;
      fpsTimer = 0;
    }
  });
}

main().catch((err) => {
  console.error('[game] fatal init error:', err);
  const hudEl = document.getElementById('hud');
  if (hudEl) hudEl.textContent = `FATAL: ${(err as Error).message}`;
});
