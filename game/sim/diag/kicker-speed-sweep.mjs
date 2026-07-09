// Sweep symmetric-kicker ENTRY speed -> flight time + landing attitude under honest >=3-wheel gating.
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';
import { dot, LOCAL_UP, rotateVector } from '../../src/vehicle/mathUtil.ts';

function upDot(rot) { return dot(rotateVector(rot, LOCAL_UP), { x: 0, y: 1, z: 0 }); }
function yawFromQuat(q) { return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)); }

async function run(targetMs) {
  const native = await init();
  const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
  createGroundBody(world);
  const vehicle = createVehicle(world);
  createDestructibleWorld(world);
  for (let i = 0; i < 30; i++) { stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT); world.step(FIXED_DT, FIXED_SUBSTEPS); }
  const rest = Object.fromEntries(Object.entries(vehicle.wheels).map(([k, w]) => [k, w.body.getPosition().y]));
  let airSteps = 0, maxAir = 0, everAir = false, speedAtRamp = 0;
  for (let i = 0; i < 600; i++) {
    const pos = vehicle.chassis.getPosition();
    const vel = vehicle.chassis.getLinearVelocity();
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    const yaw = yawFromQuat(vehicle.chassis.getRotation());
    const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + pos.x * 0.01));
    const throttle = pos.z < 41 && speed < targetMs ? 1 : 0;
    stepVehicle(vehicle, { throttle, brake: 0, steer, handbrake: false }, FIXED_DT);
    world.step(FIXED_DT, FIXED_SUBSTEPS);
    if (pos.z >= 41 && speedAtRamp === 0) speedAtRamp = speed;
    const allAir = Object.entries(vehicle.wheels).every(([k, w]) => w.body.getPosition().y - rest[k] > 0.3);
    if (allAir) { airSteps++; maxAir = Math.max(maxAir, airSteps); everAir = true; } else airSteps = 0;
  }
  for (let i = 0; i < 60; i++) { stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT); world.step(FIXED_DT, FIXED_SUBSTEPS); }
  const ud = upDot(vehicle.chassis.getRotation());
  console.log(`entry target=${(targetMs * 3.6).toFixed(0)}km/h actualAtRamp=${(speedAtRamp * 3.6).toFixed(1)}km/h maxAirSteps=${maxAir} everAir=${everAir} settledUpDot=${ud.toFixed(3)}`);
  world.destroy();
}
for (const v of [11, 12, 13, 14, 15, 16, 18, 20.3]) await run(v);
