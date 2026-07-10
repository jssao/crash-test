// DIAGNOSTIC ONLY (game/verify/diag/) -- not part of the shipped game. Standalone vite entry that
// assembles the SAME physics vehicle + SAME car visuals modules main.ts uses, but skips the HUD/
// input/camera-polish layer so a CDP script can directly dump physics-body-vs-visual-mesh world
// poses for every panel/wheel at controlled checkpoints (spawn / after full reset / after a mild
// crash). Does not modify any existing source file.
import * as THREE from 'three';
import { init, World } from '../../../src/ts/index.js';
import {
  createVehicle,
  createGroundBody,
  destroyVehicle,
  stepVehicle,
  NEUTRAL_INPUT,
  type Vehicle,
  type WheelKey,
} from '../../src/vehicle/vehicle';
import { CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning';
import { loadCar, type CarBundle } from '../../src/scene/car';
import { detachWheelVisuals, applyWheelVisual, type WheelVisual } from '../../src/scene/wheels';
import { createPanelVisuals, reparentPanelVisual, repairPanelVisual, applyPanelVisual, type PanelVisual } from '../../src/scene/panelVisuals';
import { PANEL_KEYS, type PanelKey } from '../../src/damage/panels';
import { spawnTestWall, crashSetup } from '../../src/damage/scenario';
import { createDamageSystem, stepDamageSystem, getDamageTelemetry, type DamageSystem, type DamageEvent } from '../../src/damage/system';

const CAR_URL = '/assets/car/mustang65.glb';

async function main() {
  const native = await init();
  const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
  createGroundBody(world);
  let vehicle: Vehicle = createVehicle(world);
  const SPAWN_POS = vehicle.spawnPosition;
  const SPAWN_ROT = vehicle.spawnRotation;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(1024, 768);
  renderer.setPixelRatio(1);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202225);
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dl = new THREE.DirectionalLight(0xffffff, 2.5);
  dl.position.set(5, 10, 5);
  scene.add(dl);
  const grid = new THREE.GridHelper(40, 40, 0x555555, 0x333333);
  scene.add(grid);

  const car: CarBundle = await loadCar(CAR_URL);
  car.root.position.set(0, 0, 0);
  scene.add(car.root);

  const wheelVisuals: Record<WheelKey, WheelVisual> = detachWheelVisuals(car.root, scene);
  const panelVisuals: Record<PanelKey, PanelVisual> = createPanelVisuals(car.root);
  const IDENTITY_QUAT = new THREE.Quaternion();

  let damageSystem: DamageSystem = createDamageSystem(vehicle);

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
    }
  }
  damageSystem.emitter.on(handleDamageEvent);

  const camera = new THREE.PerspectiveCamera(50, 1024 / 768, 0.05, 500);

  function setCamera(view: 'front' | 'side' | 'top' | 'rear3q'): void {
    const focus = new THREE.Vector3(vehicle.chassis.getPosition().x, 0.7, vehicle.chassis.getPosition().z);
    const d = 6;
    if (view === 'front') camera.position.set(focus.x, focus.y + 0.4, focus.z + d);
    else if (view === 'side') camera.position.set(focus.x + d, focus.y + 0.4, focus.z);
    else if (view === 'top') camera.position.set(focus.x, focus.y + d + 2, focus.z + 0.001);
    else camera.position.set(focus.x + d * 0.7, focus.y + d * 0.5, focus.z + d * 0.7);
    camera.lookAt(focus);
  }
  setCamera('side');

  function syncVisualsFromPhysics(): void {
    // Chassis-root placement -- mirrors main.ts's animate(): chassisTransform.applyTo(car.root,
    // alpha) then car.root.translateY(-CHASSIS_ORIGIN_HEIGHT_M), collapsed to alpha=1 (no
    // interpolation needed for a diagnostic snapshot).
    const ct = vehicle.chassis.getTransform();
    car.root.position.set(ct.position.x, ct.position.y, ct.position.z);
    car.root.quaternion.set(ct.rotation.x, ct.rotation.y, ct.rotation.z, ct.rotation.w);
    car.root.translateY(-CHASSIS_ORIGIN_HEIGHT_M);
    car.root.updateWorldMatrix(true, false);

    for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
      const t = vehicle.wheels[key].body.getTransform();
      wheelVisuals[key].transform.sample(t.position, t.rotation);
      applyWheelVisual(wheelVisuals[key], IDENTITY_QUAT, 1);
    }
    for (const key of PANEL_KEYS) {
      const visual = panelVisuals[key];
      if (!visual || vehicle.panels[key].despawned) continue;
      const t = vehicle.panels[key].body.getTransform();
      visual.transform.sample(t.position, t.rotation);
      applyPanelVisual(visual, 1);
    }
  }

  function render(): void {
    syncVisualsFromPhysics();
    renderer.render(scene, camera);
  }

  function stepN(n: number): void {
    for (let i = 0; i < n; i++) {
      stepVehicle(vehicle, NEUTRAL_INPUT, FIXED_DT);
      world.step(FIXED_DT, FIXED_SUBSTEPS);
      stepDamageSystem(damageSystem, world, FIXED_DT);
      syncVisualsFromPhysics();
    }
  }

  function quatAngleDeg(a: THREE.Quaternion, b: THREE.Quaternion): number {
    let d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
    d = Math.min(1, d);
    return (2 * Math.acos(d) * 180) / Math.PI;
  }

  function dumpPoses(label: string): Record<string, unknown> {
    syncVisualsFromPhysics();
    const out: Record<string, unknown> = { label };

    const wOut: Record<string, unknown> = {};
    for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
      const body = vehicle.wheels[key].body;
      if (!body) continue;
      const bt = body.getTransform();
      const bodyPos = new THREE.Vector3(bt.position.x, bt.position.y, bt.position.z);
      const bodyQuat = new THREE.Quaternion(bt.rotation.x, bt.rotation.y, bt.rotation.z, bt.rotation.w);
      const visPos = new THREE.Vector3();
      const visQuat = new THREE.Quaternion();
      wheelVisuals[key].object.getWorldPosition(visPos);
      wheelVisuals[key].object.getWorldQuaternion(visQuat);
      wOut[key] = {
        bodyPos: bodyPos.toArray(),
        bodyQuat: bodyQuat.toArray(),
        visualPos: visPos.toArray(),
        visualQuat: visQuat.toArray(),
        posDelta: visPos.clone().sub(bodyPos).toArray(),
        angleDeltaDeg: quatAngleDeg(bodyQuat, visQuat),
      };
    }
    out.wheels = wOut;

    const pOut: Record<string, unknown> = {};
    for (const key of PANEL_KEYS) {
      const panel = vehicle.panels[key];
      const visual = panelVisuals[key];
      if (!panel || !visual || panel.despawned) {
        pOut[key] = { despawnedOrMissing: true };
        continue;
      }
      const bt = panel.body.getTransform();
      const bodyPos = new THREE.Vector3(bt.position.x, bt.position.y, bt.position.z);
      const bodyQuat = new THREE.Quaternion(bt.rotation.x, bt.rotation.y, bt.rotation.z, bt.rotation.w);
      const visPos = new THREE.Vector3();
      const visQuat = new THREE.Quaternion();
      visual.object.getWorldPosition(visPos);
      visual.object.getWorldQuaternion(visQuat);
      pOut[key] = {
        state: panel.state,
        reparented: visual.reparented,
        bodyPos: bodyPos.toArray(),
        bodyQuat: bodyQuat.toArray(),
        visualPos: visPos.toArray(),
        visualQuat: visQuat.toArray(),
        posDelta: visPos.clone().sub(bodyPos).toArray(),
        angleDeltaDeg: quatAngleDeg(bodyQuat, visQuat),
      };
    }
    out.panels = pOut;
    const ct = vehicle.chassis.getTransform();
    out.chassis = { pos: [ct.position.x, ct.position.y, ct.position.z], quat: [ct.rotation.x, ct.rotation.y, ct.rotation.z, ct.rotation.w] };
    return out;
  }

  function doFullReset(): void {
    destroyVehicle(vehicle);
    vehicle = createVehicle(world, SPAWN_POS, SPAWN_ROT);
    damageSystem = createDamageSystem(vehicle, damageSystem.registry);
    damageSystem.emitter.on(handleDamageEvent);
    for (const key of PANEL_KEYS) {
      const visual = panelVisuals[key];
      if (visual) repairPanelVisual(visual, car.root);
    }
    for (const key of Object.keys(wheelVisuals) as WheelKey[]) {
      wheelVisuals[key].transform.sample(vehicle.wheels[key].body.getTransform().position, vehicle.wheels[key].body.getTransform().rotation);
    }
    syncVisualsFromPhysics();
  }

  (window as unknown as { __DIAG__: unknown }).__DIAG__ = {
    ready: true,
    render,
    stepN,
    dumpPoses,
    setCamera,
    doFullReset,
    crash: (speedKmh: number) => crashSetup(vehicle, speedKmh),
    spawnTestWall: (distanceAhead = 25) => spawnTestWall(world, vehicle, distanceAhead),
    telemetry: () => getDamageTelemetry(damageSystem),
  };
}

main();
