import { init, World } from '../../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle, getTelemetry } from '../../src/vehicle/vehicle.ts';
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
const rb = world.createBody({ type: BodyType.Static, position: { x: kicker.centerX, y: 0, z: kicker.backZ } });
rb.createHullShape(wedgeHullPoints(kicker.width, kicker.length, kicker.height), { density: 1, friction: RAMP_FRICTION });
const vehicle = createVehicle(world, { x: LANE_X, y: CHASSIS_ORIGIN_HEIGHT_M - WHEEL_SPAWN_SETTLE_MARGIN_M, z: -60 });
for (let i = 0; i < 30; i++) { stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT); world.step(FIXED_DT, FIXED_SUBSTEPS); }

function systemVy() {
  let p = vehicle.chassis.getMass() * vehicle.chassis.getLinearVelocity().y;
  let M = vehicle.chassis.getMass();
  for (const w of Object.values(vehicle.wheels)) { const m = w.body.getMass(); p += m * w.body.getLinearVelocity().y; M += m; }
  for (const pn of Object.values(vehicle.panels)) { if (!pn.weldJoint || pn.despawned) continue; const m = pn.body.getMass(); p += m * pn.body.getLinearVelocity().y; M += m; }
  return p / M;
}
let prev = systemVy();
let airborne = false;
for (let s = 0; s < 1200; s++) {
  const pos = vehicle.chassis.getPosition();
  const vel = vehicle.chassis.getLinearVelocity();
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  const yaw = yawFromQuat(vehicle.chassis.getRotation());
  const steer = airborne ? 0 : Math.max(-0.3, Math.min(0.3, yaw * 5 + (pos.x - LANE_X) * 0.01));
  stepVehicle(vehicle, { throttle: !airborne && speed < 20 ? 1 : 0, brake: 0, steer, handbrake: false }, FIXED_DT);
  world.step(FIXED_DT, FIXED_SUBSTEPS);
  const now = systemVy();
  const ay = (now - prev) / FIXED_DT;
  prev = now;
  const clear = Object.values(vehicle.wheels).map((w) => w.body.getPosition().y - w.def.radius);
  if (!airborne && clear.every((c) => c > 0.12) && pos.z > kicker.backZ) airborne = true;
  if (airborne && s >= 485 && s <= 510) {
    const t = getTelemetry(vehicle);
    console.log(`s=${s} ay=${ay.toFixed(2)} chassisY=${pos.y.toFixed(2)} grounded=${t.groundedWheelCount} auth=${t.assistAuthority.toFixed(3)} upDot=${t.upDot.toFixed(2)}`);
  }
  if (airborne && clear.some((c) => c < 0.02)) break;
}
world.destroy();
