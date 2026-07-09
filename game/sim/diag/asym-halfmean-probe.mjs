import { init, World, BodyType } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, CHASSIS_ORIGIN_HEIGHT_M, WHEEL_SPAWN_SETTLE_MARGIN_M } from '../../src/vehicle/tuning.ts';
import { RAMP_CONFIGS, RAMP_FRICTION } from '../../src/world/tuning.ts';
import { wedgeHullPoints } from '../../src/world/bodies.ts';
import { dot, LOCAL_FORWARD, rotateVector } from '../../src/vehicle/mathUtil.ts';
const LANE_X = 1.2;
function yawFromQuat(q) { return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)); }
async function run(target, spawnZ) {
  const native = await init();
  const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
  createGroundBody(world);
  const kicker = RAMP_CONFIGS.find((r) => r.id === 'kicker');
  const rb = world.createBody({ type: BodyType.Static, position: { x: kicker.centerX, y: 0, z: kicker.backZ } });
  rb.createHullShape(wedgeHullPoints(kicker.width, kicker.length, kicker.height), { density: 1, friction: RAMP_FRICTION });
  const vehicle = createVehicle(world, { x: LANE_X, y: CHASSIS_ORIGIN_HEIGHT_M - WHEEL_SPAWN_SETTLE_MARGIN_M, z: spawnZ });
  for (let i = 0; i < 30; i++) { stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT); world.step(FIXED_DT, FIXED_SUBSTEPS); }
  let phase = 'approach'; const roll = []; const omega = [];
  for (let s = 0; s < 1200 && phase !== 'landed'; s++) {
    const pos = vehicle.chassis.getPosition();
    const vel = vehicle.chassis.getLinearVelocity();
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    const rot = vehicle.chassis.getRotation();
    let input;
    if (phase === 'approach') {
      const yaw = yawFromQuat(rot);
      const steer = Math.max(-0.3, Math.min(0.3, yaw * 5 + (pos.x - LANE_X) * 0.01));
      input = { throttle: speed < target ? 1 : 0, brake: 0, steer, handbrake: false };
    } else input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    stepVehicle(vehicle, input, FIXED_DT);
    world.step(FIXED_DT, FIXED_SUBSTEPS);
    const clear = Object.values(vehicle.wheels).map((w) => w.body.getPosition().y - w.def.radius);
    if (phase === 'approach' && clear.every((c) => c > 0.12) && pos.z > kicker.backZ) phase = 'airborne';
    if (phase === 'airborne') {
      const av = vehicle.chassis.getAngularVelocity();
      roll.push(dot(av, rotateVector(rot, LOCAL_FORWARD)));
      omega.push(Math.hypot(av.x, av.y, av.z));
      if (clear.some((c) => c < 0.03) && roll.length > 3) phase = 'landed';
    }
  }
  world.destroy();
  const n = roll.length; const h = Math.floor(n / 2);
  const mean = (a) => a.reduce((x, y) => x + Math.abs(y), 0) / a.length;
  const m1 = mean(roll.slice(0, h)), m2 = mean(roll.slice(h, n - 1));
  const w1 = mean(omega.slice(0, h)), w2 = mean(omega.slice(h, n - 1));
  const T = n * FIXED_DT;
  console.log(`target=${target} n=${n} T=${T.toFixed(2)}s rollHalfMeans=${m1.toFixed(3)}->${m2.toFixed(3)} (decay ${((1 - m2 / m1) / (T / 2) * 100).toFixed(1)}%/s) omegaHalfMeans=${w1.toFixed(3)}->${w2.toFixed(3)} (decay ${((1 - w2 / w1) / (T / 2) * 100).toFixed(1)}%/s)`);
}
await run(14, -5); await run(17, -25); await run(20, -60);
