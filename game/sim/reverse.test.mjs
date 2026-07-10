// SPDX-License-Identifier: MIT
//
// Reverse-gear regression (the "S-key reverse produces zero backward motion in the full laden game"
// fix). Guards the reverse FEATURE end-to-end in the headless sim: the brake pedal doubles as reverse
// at/below REVERSE_ENGAGE_SPEED_MS, the reverse drive-torque is CAPPED (REVERSE_MAX_DRIVE_TORQUE_NM,
// not the full forward-launch torque -- the cap is what keeps the spin-motor pitch reaction from
// lifting a nose-heavy car's light rear into a pitch-runaway), reverse produces real bounded backward
// motion, and the forward->stop->reverse transition works.
//
// SCOPE NOTE (honest): the flat-ground sim reverses fine with OR without the fix -- the actual browser
// failure needs the real nose-heavy laden attitude (rear suspension deflection ~0.05m) that baked-mass
// ballast can't reproduce (it bottoms the soft springs symmetrically). The bug-specific regression that
// reproduces and guards the exact browser failure is game/verify/reverse-check.mjs (CDP, full game).
// This sim test guards the reverse-feature invariants that ARE reproducible headlessly (engage speed,
// torque cap, real bounded motion, transition) so a future edit that guts reverse still trips a fast test.
import { describe, expect, it } from 'vitest';
import { createSim } from './harness.mjs';
import { REVERSE_MAX_DRIVE_TORQUE_NM, REVERSE_MAX_SPEED_MS } from '../src/vehicle/tuning.ts';

const mm = (x, y, z) => ({ x: x / 1000, y: y / 1000, z: z / 1000 });
// Approximates the full game's cardetail + occupant sprung load (same set as ride-height.test.mjs).
const LADEN_FEATURE_BALLAST = Object.freeze([
  { massKg: 55, localCenterM: mm(700, 650, -380) },
  { massKg: 55, localCenterM: mm(700, 650, 380) },
  { massKg: 55, localCenterM: mm(-500, 600, -350) },
  { massKg: 55, localCenterM: mm(-500, 600, 350) },
  { massKg: 22, localCenterM: mm(1300, 500, 0) },
  { massKg: 10, localCenterM: mm(0, 350, 0) },
  { massKg: 8, localCenterM: mm(-1200, 300, 0) },
]);

async function reverseFromRest(ballast) {
  const sim = await createSim(undefined, ballast);
  try {
    for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
    const z0 = sim.telemetry().chassisPos.z;
    let minUpDot = 1;
    let maxReverseTorque = 0;
    let reverseBranchSteps = 0;
    for (let i = 0; i < 240; i++) {
      sim.step({ throttle: 0, brake: 1, steer: 0, handbrake: false });
      minUpDot = Math.min(minUpDot, sim.telemetry().upDot);
      const dd = sim.vehicle.driveDebug;
      if (dd.branch === 'reverse') {
        reverseBranchSteps++;
        maxReverseTorque = Math.max(maxReverseTorque, dd.rl.maxTorque, dd.rr.maxTorque);
      }
    }
    const tel = sim.telemetry();
    return { displacement: tel.chassisPos.z - z0, endSpeedKmh: tel.speedKmh, minUpDot, maxReverseTorque, reverseBranchSteps };
  } finally {
    sim.destroy();
  }
}

describe('reverse', () => {
  for (const [label, ballast] of [
    ['unladen', []],
    ['laden (cardetail + occupant feature load)', LADEN_FEATURE_BALLAST],
  ]) {
    it(`reverses backward from a standstill under held brake -- ${label}`, async () => {
      const r = await reverseFromRest(ballast);
      console.log(
        `[reverse ${label}] 4s displacement=${r.displacement.toFixed(2)}m endSpeed=${r.endSpeedKmh.toFixed(1)}km/h ` +
          `minUpDot=${r.minUpDot.toFixed(3)} maxReverseTorque=${r.maxReverseTorque.toFixed(0)}Nm reverseSteps=${r.reverseBranchSteps}`,
      );
      // Reverse engaged (brake pedal drove the reverse branch, not just foot-braking).
      expect(r.reverseBranchSteps).toBeGreaterThan(200);
      // Reverses at least 8m backward in 4s (the acceptance target; -Z is backward here).
      expect(r.displacement).toBeLessThanOrEqual(-8);
      // Reverse drive torque is capped to the reverse cap (not the ~1660Nm forward-launch torque) --
      // the load-bearing part of the fix. Allow tiny FP slop.
      expect(r.maxReverseTorque).toBeLessThanOrEqual(REVERSE_MAX_DRIVE_TORQUE_NM + 1);
      // Reverse stays gentle/bounded: never rolls over, and honors the reverse speed cap (~25km/h).
      expect(r.minUpDot).toBeGreaterThan(0.9);
      expect(r.endSpeedKmh).toBeLessThanOrEqual(REVERSE_MAX_SPEED_MS * 3.6 + 3);
    });
  }

  it('drive-forward -> brake-to-stop -> reverse transition works', async () => {
    const sim = await createSim(undefined, LADEN_FEATURE_BALLAST);
    try {
      // Accelerate forward for ~2.5s.
      for (let i = 0; i < 150; i++) sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
      const forwardSpeed = sim.telemetry().speedKmh;
      expect(forwardSpeed).toBeGreaterThan(20); // actually got moving forward first

      // Now hold the brake: foot-brakes to a stop, then engages reverse.
      let sawFootBrake = false;
      let sawReverse = false;
      const zAtBrake = sim.telemetry().chassisPos.z;
      for (let i = 0; i < 300; i++) {
        sim.step({ throttle: 0, brake: 1, steer: 0, handbrake: false });
        if (sim.vehicle.driveDebug.branch === 'footBrake') sawFootBrake = true;
        if (sim.vehicle.driveDebug.branch === 'reverse') sawReverse = true;
      }
      const finalReverseSpeed = sim.telemetry().speedKmh;
      const wentBackward = sim.telemetry().chassisPos.z - zAtBrake; // should end backward of the brake point
      console.log(
        `[reverse transition] forwardSpeed=${forwardSpeed.toFixed(1)} sawFootBrake=${sawFootBrake} sawReverse=${sawReverse} ` +
          `finalReverseSpeed=${finalReverseSpeed.toFixed(1)} netFromBrakePoint=${wentBackward.toFixed(2)}m`,
      );
      expect(sawFootBrake).toBe(true); // braked while still rolling forward
      expect(sawReverse).toBe(true); // then engaged reverse once stopped
      expect(finalReverseSpeed).toBeGreaterThan(3); // actually reversing at the end
    } finally {
      sim.destroy();
    }
  });
});
