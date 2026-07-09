import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS } from '../../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../../src/world/bodies.ts';
import { dot, rotateVector, LOCAL_UP } from '../../src/vehicle/mathUtil.ts';
function yawFromQuat(q) { return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)); }
const native = await init();
const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
createGroundBody(world);
const vehicle = createVehicle(world);
createDestructibleWorld(world);
for (let i = 0; i < 30; i++) { stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT); world.step(FIXED_DT, FIXED_SUBSTEPS); }
const rest = Object.fromEntries(Object.entries(vehicle.wheels).map(([k, w]) => [k, w.body.getPosition().y]));
let airborne = false; const log = [];
for (let i = 0; i < 600; i++) {
  const pos = vehicle.chassis.getPosition();
  const vel = vehicle.chassis.getLinearVelocity();
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  const yaw = yawFromQuat(vehicle.chassis.getRotation());
  const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + pos.x * 0.01));
  const throttle = pos.z < 41 && speed < 16.1 ? 1 : 0;
  stepVehicle(vehicle, { throttle, brake: 0, steer, handbrake: false }, FIXED_DT);
  world.step(FIXED_DT, FIXED_SUBSTEPS);
  const allAir = Object.entries(vehicle.wheels).every(([k, w]) => w.body.getPosition().y - rest[k] > 0.3);
  if (allAir) {
    airborne = true;
    const av = vehicle.chassis.getAngularVelocity();
    const right = rotateVector(vehicle.chassis.getRotation(), { x: 1, y: 0, z: 0 });
    log.push({ pitch: dot(av, right), auth: getTelemetry(vehicle).assistAuthority });
  } else if (airborne) break;
}
console.log(`airSamples=${log.length} firstAuth0Idx=${log.findIndex((l) => l.auth === 0)}`);
console.log('pitch first5=', log.slice(0, 5).map((l) => l.pitch.toFixed(3)).join(','), ' last5=', log.slice(-5).map((l) => l.pitch.toFixed(3)).join(','));
