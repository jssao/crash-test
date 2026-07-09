// Probe: per-step groundedWheelCount + deflections during the 20m/s half-on-kicker flight,
// to characterize the mid-flight "grounded" re-latch that leaks assist authority into the air.
import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry, getSuspensionDeflection } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, CHASSIS_ORIGIN_HEIGHT_M, WHEEL_SPAWN_SETTLE_MARGIN_M } from '../../src/vehicle/tuning.ts';
import { RAMP_CONFIGS, RAMP_FRICTION } from '../../src/world/tuning.ts';
import { wedgeHullPoints } from '../../src/world/bodies.ts';
import { BodyType } from '../../../src/ts/index.ts';

const LANE_X = 1.2;
function yawFromQuat(q) { return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)); }

const native = await init();
const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
createGroundBody(world);
const kicker = RAMP_CONFIGS.find((r) => r.id === 'kicker');
const rampBody = world.createBody({ type: BodyType.Static, position: { x: kicker.centerX, y: 0, z: kicker.backZ } });
rampBody.createHullShape(wedgeHullPoints(kicker.width, kicker.length, kicker.height), { density: 1, friction: RAMP_FRICTION });
const vehicle = createVehicle(world, { x: LANE_X, y: CHASSIS_ORIGIN_HEIGHT_M - WHEEL_SPAWN_SETTLE_MARGIN_M, z: -60 });
for (let i = 0; i < 30; i++) { stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT); world.step(FIXED_DT, FIXED_SUBSTEPS); }

let airborne = false;
for (let s = 0; s < 1200; s++) {
  const pos = vehicle.chassis.getPosition();
  const vel = vehicle.chassis.getLinearVelocity();
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  const yaw = yawFromQuat(vehicle.chassis.getRotation());
  const steer = airborne ? 0 : Math.max(-0.3, Math.min(0.3, yaw * 5 + (pos.x - LANE_X) * 0.01));
  stepVehicle(vehicle, { throttle: !airborne && speed < 20 ? 1 : 0, brake: 0, steer, handbrake: false }, FIXED_DT);
  world.step(FIXED_DT, FIXED_SUBSTEPS);
  const clear = Object.values(vehicle.wheels).map((w) => w.body.getPosition().y - w.def.radius);
  const allAir = clear.every((c) => c > 0.12);
  if (!airborne && allAir && pos.z > kicker.backZ) airborne = true;
  if (airborne) {
    const t = getTelemetry(vehicle);
    const defl = ['fl','fr','rl','rr'].map((k) => getSuspensionDeflection(vehicle, k).toFixed(3)).join(',');
    if (t.groundedWheelCount > 0 || t.assistAuthority > 0)
      console.log(`step=${s} grounded=${t.groundedWheelCount} auth=${t.assistAuthority.toFixed(3)} defl=[${defl}] clear=[${clear.map((c)=>c.toFixed(2)).join(',')}]`);
    if (clear.some((c) => c < 0.02)) { console.log(`LANDED step=${s}`); break; }
  }
}
world.destroy();
