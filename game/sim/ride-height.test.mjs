// SPDX-License-Identifier: MIT
//
// Ride-height regression gate (suspension round 2, user playtest: "slammed on its wheels -- the tires
// intersect the fender arches"). ROOT CAUSE (measured directly, see tuning.ts's
// SUSPENSION_RESTLENGTH_OFFSET_M / VISUAL_RIDE_LIFT_M doc comments + game/verify/ride-height.mjs): the
// wheel-joint spring is calibrated against the DOF's tiny reduced mass, so under the full game's
// ~260kg laden feature load (39 cardetail parts welded to the chassis + 4 occupant ragdolls resting
// through the seats) the car sags to its rear bump stop and the body sits ~10-11cm BELOW the GLB's
// authored ride height -- the front tire renders ~8.5cm THROUGH the fender. Stiffening the spring to
// cut the sag is impossible without killing the suspension-feel targets (box3d's linear spring couples
// static sag and dynamic dive/squat/roll amplitude 1:1), and a physics rest-length lift flips the
// knife-edge crash/occupant sim suite, so the correction is applied in the render layer
// (VISUAL_RIDE_LIFT_M seats the body over the on-ground wheels). This file locks in the resulting
// LADEN fender-to-tire gap so it can't silently regress back to "slammed".
//
// The gap is the RENDERED body-vs-tire clearance, recomputed here from the laden physics rest state
// (chassisY + wheel Y from the sim) plus the render constants -- calibrated ONCE against
// game/verify/ride-height.mjs's in-browser mesh-AABB measurement (rendered front gap +2.06cm at
// VISUAL_RIDE_LIFT_M=0.125, laden). verify/ride-height.mjs (the real game, real features) is the eyes-on
// authority; this is the headless numeric guard.
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';
import { getSuspensionDeflection } from '../src/vehicle/vehicle.ts';
import { CHASSIS_ORIGIN_HEIGHT_M, VISUAL_RIDE_LIFT_M, SUSPENSION_UPPER_LIMIT_M } from '../src/vehicle/tuning.ts';

// Representative laden feature load, ~260kg (the sim harness carries only the bare vehicle; the full
// game adds these as real welded/resting bodies). mm(forward, up, right) -> chassis-local, matching the
// cardetail/occupant feature placement (see world/features/*/tuning.ts): 4 occupants @55kg (2 front
// seats z=+0.7, 2 rear bench z=-0.5) + ~40kg cardetail, engine-bay front-biased. Fore/aft (z)
// distribution matters -- it sets the front/rear deflection split; total sets the sag.
const mm = (fwd, up, right) => ({ x: right / 1000, y: up / 1000 - CHASSIS_ORIGIN_HEIGHT_M, z: fwd / 1000 });
const LADEN_FEATURE_BALLAST = Object.freeze([
  { massKg: 55, localCenterM: mm(700, 650, -380) }, // driver
  { massKg: 55, localCenterM: mm(700, 650, 380) }, // passenger
  { massKg: 55, localCenterM: mm(-500, 600, -350) }, // rear-left occupant
  { massKg: 55, localCenterM: mm(-500, 600, 350) }, // rear-right occupant
  { massKg: 22, localCenterM: mm(1300, 500, 0) }, // cardetail engine-bay cluster (front)
  { massKg: 10, localCenterM: mm(0, 350, 0) }, // cardetail mid (driveshaft/console)
  { massKg: 8, localCenterM: mm(-1200, 300, 0) }, // cardetail rear (fuel tank/subframe)
]);

// Render constants calibrated ONCE from game/verify/ride-height.mjs's in-browser front-wheel mesh-AABB
// measurement (VISUAL_RIDE_LIFT_M=0.125, laden: rendered fenderMinY 0.79842 = chassisY(0.26100) -
// CHASSIS_ORIGIN_HEIGHT_M + VISUAL_RIDE_LIFT_M + FENDER; rendered tireTop 0.77778 = wheelY(0.39377) +
// TIRE_R). These fold the GLB-authored fender-arch height and the visual tire radius into the gap.
const FRONT_FENDER_LOCAL_Y_M = 0.8024;
const FRONT_TIRE_VISUAL_RADIUS_M = 0.384;

/** Rendered vertical clearance (meters) between the front fender-arch lip and the front tire's top, as
 * a function of the laden physics rest state -- the exact quantity verify/ride-height.mjs measures from
 * the live meshes. Positive = tire clears the fender; negative = tire pokes through ("slammed"). */
function frontArchGap(vehicle) {
  const chassisY = vehicle.chassis.getPosition().y;
  const wheelY = vehicle.wheels.fl.body.getPosition().y;
  const fenderY = chassisY - CHASSIS_ORIGIN_HEIGHT_M + VISUAL_RIDE_LIFT_M + FRONT_FENDER_LOCAL_Y_M;
  const tireTopY = wheelY + FRONT_TIRE_VISUAL_RADIUS_M;
  return fenderY - tireTopY;
}

async function settleLaden(steps = 240) {
  const sim = await createSim(undefined, LADEN_FEATURE_BALLAST);
  for (let i = 0; i < steps; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
  return sim;
}

describe('ride-height (laden)', () => {
  it('rest: the laden car is NOT slammed -- front fender clears the tire by > 2cm', async () => {
    const sim = await settleLaden();
    try {
      const gap = frontArchGap(sim.vehicle);
      const chassisY = sim.vehicle.chassis.getPosition().y;
      console.log(`[ride-height] REST laden chassisY=${chassisY.toFixed(4)} frontArchGap=${(gap * 1000).toFixed(1)}mm`);
      // > 2cm clearance at rest (verify/ride-height.mjs measures +2.06cm in the real game). The bare
      // pre-fix car renders the tire ~85mm THROUGH the fender here, so this both proves the un-slam and
      // guards against a regression back to it.
      expect(gap).toBeGreaterThan(0.02);
    } finally {
      sim.destroy();
    }
  });

  it('the laden static suspension genuinely rests near its rear bump stop (documents WHY the lift is a visual seat, not a physics sag reduction)', async () => {
    const sim = await settleLaden();
    try {
      const rl = getSuspensionDeflection(sim.vehicle, 'rl');
      const rr = getSuspensionDeflection(sim.vehicle, 'rr');
      const rearDefl = (rl + rr) / 2;
      console.log(`[ride-height] laden rear deflection=${rearDefl.toFixed(4)} / limit ${SUSPENSION_UPPER_LIMIT_M}`);
      // The rear sits within ~1mm of the +0.14m compression limit under the full feature load -- the
      // physics ride height cannot be raised by softening/geometry here (the spring is already pinned),
      // which is exactly why the ride-height correction is applied visually (VISUAL_RIDE_LIFT_M).
      expect(rearDefl).toBeGreaterThan(SUSPENSION_UPPER_LIMIT_M - 0.01);
      expect(rearDefl).toBeLessThanOrEqual(SUSPENSION_UPPER_LIMIT_M + 1e-3);
    } finally {
      sim.destroy();
    }
  });

  it('under a hard 1g brake dive the front fender-to-tire gap stays positive (tires never enter the arch)', async () => {
    // Accelerate to speed, then brake hard, tracking the WORST-case (smallest) front arch gap through
    // the dive -- the front compresses toward the bump stop as weight transfers forward.
    const sim = await createSim(undefined, LADEN_FEATURE_BALLAST);
    try {
      let reached = false;
      for (let i = 0; i < 600 && !reached; i++) {
        sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
        if (sim.telemetry().speedKmh >= 80) reached = true;
      }
      expect(reached).toBe(true);

      let minGap = Infinity;
      for (let i = 0; i < 90; i++) {
        sim.step({ throttle: 0, brake: 1, steer: 0, handbrake: false });
        if (sim.telemetry().speedKmh > 5) minGap = Math.min(minGap, frontArchGap(sim.vehicle));
      }
      console.log(`[ride-height] mid-brake-dive worst front arch gap=${(minGap * 1000).toFixed(1)}mm`);
      expect(minGap).toBeGreaterThan(0);
    } finally {
      sim.destroy();
    }
  });
});
