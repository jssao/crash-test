import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';
import { dot, rotateVector } from '../../src/vehicle/mathUtil.ts';

function yawFromQuat(q) { return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)); }
const native = await init();
const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
createGroundBody(world);
const vehicle = createVehicle(world);
createDestructibleWorld(world);
for (let i = 0; i < 30; i++) { stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT); world.step(FIXED_DT, FIXED_SUBSTEPS); }
for (let i = 0; i < 360; i++) {
  const pos = vehicle.chassis.getPosition();
  const yaw = yawFromQuat(vehicle.chassis.getRotation());
  const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + pos.x * 0.01));
  stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
  world.step(FIXED_DT, FIXED_SUBSTEPS);
  if (pos.z > 38 && pos.z < 55) {
    const t = getTelemetry(vehicle);
    const av = vehicle.chassis.getAngularVelocity();
    const right = rotateVector(vehicle.chassis.getRotation(), { x: 1, y: 0, z: 0 });
    const pitchRate = dot(av, right);
    console.log(`i=${i} z=${pos.z.toFixed(1)} y=${pos.y.toFixed(2)} grounded=${t.groundedWheelCount} auth=${t.assistAuthority.toFixed(2)} pitchRate=${pitchRate.toFixed(2)} speed=${t.speedKmh.toFixed(0)}`);
  }
}
