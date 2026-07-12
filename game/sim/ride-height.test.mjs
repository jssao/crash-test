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
//
// S90 SWAP RE-DERIVATION (2026-07-11): occupant z positions updated to match the re-derived
// occupants/tuning.ts SEAT_LOCAL (frontLeft/frontRight z=0.35 -> 350mm, rearLeft/rearRight z=-0.75 ->
// -750mm; x=+-0.40 -> 400mm). Cardetail cluster z positions scaled by the S90/Mustang length ratio
// (1.0895), matching cardetail/tuning.ts's CAR_DETAIL_SPECS rescale.
const mm = (fwd, up, right) => ({ x: right / 1000, y: up / 1000 - CHASSIS_ORIGIN_HEIGHT_M, z: fwd / 1000 });
const LADEN_FEATURE_BALLAST = Object.freeze([
  { massKg: 55, localCenterM: mm(350, 650, -400) }, // driver
  { massKg: 55, localCenterM: mm(350, 650, 400) }, // passenger
  { massKg: 55, localCenterM: mm(-750, 600, -400) }, // rear-left occupant
  { massKg: 55, localCenterM: mm(-750, 600, 400) }, // rear-right occupant
  { massKg: 22, localCenterM: mm(1416, 500, 0) }, // cardetail engine-bay cluster (front)
  { massKg: 10, localCenterM: mm(0, 350, 0) }, // cardetail mid (driveshaft/console)
  { massKg: 8, localCenterM: mm(-1307, 300, 0) }, // cardetail rear (fuel tank/subframe)
]);

// Render constants calibrated ONCE from game/verify/ride-height.mjs's in-browser front-wheel mesh-AABB
// measurement (VISUAL_RIDE_LIFT_M=0.125, laden: rendered fenderMinY 0.79842 = chassisY(0.26100) -
// CHASSIS_ORIGIN_HEIGHT_M + VISUAL_RIDE_LIFT_M + FENDER; rendered tireTop 0.77778 = wheelY(0.39377) +
// TIRE_R). These fold the GLB-authored fender-arch height and the visual tire radius into the gap.
//
// S90 SWAP RE-DERIVATION (2026-07-11): FRONT_TIRE_VISUAL_RADIUS_M is now the directly measured S90
// TireFL radius (car-map.ts wheels.frontLeft.radiusMm/1000 = 0.359m). FRONT_FENDER_LOCAL_Y_M has no
// direct GLB node to measure (no "FenderArch" node) -- estimated by preserving the Mustang's measured
// arch-clearance-above-static-tire-top (Mustang: fender 0.8024 - wheel top (centerY 0.308 + radius
// 0.310 = 0.618) = 0.1844m of arch clearance) applied to the S90's own wheel top (centerY 0.363 +
// radius 0.359 = 0.722): 0.722 + 0.1844 = 0.906. This is a STARTING estimate pending a genuine
// in-browser re-measurement (game/verify/ride-height.mjs, S7 eyes-on) -- the assertions below are
// inequality gates (>2cm / >0), not exact-value pins, so a reasonable estimate is safe here; re-tune
// if the eyes-on screenshot shows the tire visibly through the fender.
const FRONT_FENDER_LOCAL_Y_M = 0.906;
const FRONT_TIRE_VISUAL_RADIUS_M = 0.359;

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

  // PHASE R RE-MASS/SUSPENSION RETUNE (2026-07-12): this test used to document the rear axle sitting
  // pinned within ~1mm of the compression limit under laden load (the "rides near bump-stop" debt
  // this pass was asked to close, see tuning.ts's SUSPENSION_HERTZ_FRONT/REAR doc comment). Fixed by
  // stiffening SUSPENSION_HERTZ_FRONT/REAR (6/6 -> 7.2/7.85) rather than widening the travel band --
  // a wider band (tried first, -0.14/+0.14 -> -0.24/+0.24) measurably destabilized bumpy-terrain
  // driving (terrain-compound's connectivity test rolled the car, minUpDot -0.98) and clipped
  // cardetail parts into the ground, because the active anti-roll/yaw/pitch assists and cardetail
  // clearance were implicitly tuned against the +/-0.14m envelope; stiffening the spring instead
  // keeps that envelope untouched while still buying real headroom. Renamed + re-asserted for the
  // fixed behavior; VISUAL_RIDE_LIFT_M is unaffected (front laden deflection actually DROPPED with
  // the stiffer front spring: 0.1307 -> 0.0906m -- see this file's rest-gap test above, unchanged and
  // still green with an even larger margin).
  it('the laden static suspension has real headroom at the rear (>=30%), not pinned at its bump stop', async () => {
    const sim = await settleLaden();
    try {
      const rl = getSuspensionDeflection(sim.vehicle, 'rl');
      const rr = getSuspensionDeflection(sim.vehicle, 'rr');
      const rearDefl = (rl + rr) / 2;
      const headroomFrac = 1 - rearDefl / SUSPENSION_UPPER_LIMIT_M;
      console.log(`[ride-height] laden rear deflection=${rearDefl.toFixed(4)} / limit ${SUSPENSION_UPPER_LIMIT_M} (headroom ${(headroomFrac * 100).toFixed(1)}%)`);
      // Measured 0.0951m / 0.14m limit = 67.9% used -> 32.1% headroom (comfortably clears the 30% floor).
      expect(headroomFrac).toBeGreaterThanOrEqual(0.3);
      // Sanity: still a real, substantial laden sag (not vacuously near-zero deflection).
      expect(rearDefl).toBeGreaterThan(0.05);
    } finally {
      sim.destroy();
    }
  });

  // PHASE R (2026-07-12): the R2 spec requires >=30% headroom at REST too (not just laden) -- the bare
  // sim harness (no cardetail/occupant ballast) is the REST operating point. Measured (this test's own
  // console.log): front 0.0797m, rear 0.0825m against the 0.14m limit -> 43.0%/41.0% headroom, both
  // comfortably clearing the 30% floor.
  it('the bare (unladen) rest suspension has >=30% headroom on every corner', async () => {
    const sim = await createSim();
    for (let i = 0; i < 240; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
    try {
      const d = {};
      for (const k of ['fl', 'fr', 'rl', 'rr']) d[k] = getSuspensionDeflection(sim.vehicle, k);
      const headroomFrac = (x) => 1 - x / SUSPENSION_UPPER_LIMIT_M;
      console.log(
        `[ride-height] REST bare fl=${d.fl.toFixed(4)} fr=${d.fr.toFixed(4)} rl=${d.rl.toFixed(4)} rr=${d.rr.toFixed(4)} ` +
          `headroom%=${Object.fromEntries(Object.entries(d).map(([k, v]) => [k, (headroomFrac(v) * 100).toFixed(1)]))}`,
      );
      for (const k of ['fl', 'fr', 'rl', 'rr']) expect(headroomFrac(d[k]), `${k} rest headroom`).toBeGreaterThanOrEqual(0.3);
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
